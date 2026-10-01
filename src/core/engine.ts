import type { JevAssessment, MarketFeatures, MarketTick, ReviewProposal, RiskCaps, StrategyConfig, SymbolRules, JevContext } from '../shared/types.ts';
import { DEFAULT_CAPS, DEFAULT_STRATEGY, PAPER_SLIPPAGE_BPS, TAKER_FEE_BPS, utcDay } from './defaults.ts';
import { type EdgeStats } from './policy.ts';
import { PaperBroker } from './paper.ts';
import { Store } from './store.ts';
import { ResearchTracker } from './research.ts';
import { MANAGEMENT, MAX_POSITIONS, advanceStop, calibrationBucket, detectSetup, exitReason, makePlan, selectForecast, signalVerdict, tradingCostsBps, type PositionPlan, type Setup } from './adaptive.ts';

export interface AssessmentClient { assess(features:MarketFeatures,horizonSeconds?:number,context?:JevContext,signal?:AbortSignal):Promise<JevAssessment> }
export interface ReviewClient { review(input:{strategy:StrategyConfig;caps:RiskCaps;metrics:unknown;candidates:string[]},signal?:AbortSignal):Promise<ReviewProposal> }
const emptyUsage=()=>({inputTokens:0,outputTokens:0,costUsd:0,requests:0});

export class BotEngine {
  readonly store:Store;
  readonly research:ResearchTracker;
  private requests=new Set<AbortController>();
  private receivedAt=new Map<string,number>();
  private busySymbols=new Set<string>();
  private retryAt=0;
  private plans:Record<string,PositionPlan>;
  private jev:AssessmentClient|null;
  private reviewer:ReviewClient|null;
  caps:RiskCaps;
  strategy:StrategyConfig;
  paused:boolean;
  stopped:boolean;
  liquidationPending:boolean;
  readonly paper:PaperBroker;
  readonly latest=new Map<string,MarketTick>();
  readonly rules=new Map<string,SymbolRules>();
  readonly features=new Map<string,MarketFeatures>();
  readonly assessments=new Map<string,JevAssessment>();
  readonly skippedReasons:Record<string,number>={};
  readonly jevGateFailures:Record<string,number>={};
  monitoredMarketCount=0;
  readonly health={feedConnected:false,lastTickTs:0,jevReady:false,reviewerReady:false};
  latestReview='The strategy has not been reviewed yet.';
  decisions=0;
  approved=0;
  private latencyTotal=0;
  private lastAssessed=new Map<string,number>();
  private assessing=0;
  private lastReviewTs=0;
  private reviewing=false;
  private lastSnapshot=new Map<string,number>();
  portfolioRunId:number;
  constructor(store:Store,jev:AssessmentClient|null,reviewer:ReviewClient|null) {
    this.store=store;this.jev=jev;this.reviewer=reviewer;this.research=new ResearchTracker(store);this.plans=store.get('positionPlansV2',{});
    this.caps=store.get('caps',{...DEFAULT_CAPS});
    this.portfolioRunId=store.currentPortfolioRunId();
    const savedStrategy=store.get<StrategyConfig|null>('strategy',null);this.strategy=savedStrategy??{...DEFAULT_STRATEGY};
    if(store.get('experimentVersion',0)<2) {
      this.strategy={...DEFAULT_STRATEGY,version:savedStrategy?this.strategy.version+1:DEFAULT_STRATEGY.version,positionFraction:this.strategy.positionFraction,selectedSymbols:this.strategy.selectedSymbols};
      if(this.caps.maxPositions===5)this.caps={...this.caps,maxPositions:10};
      store.set('strategy',this.strategy);store.set('caps',this.caps);store.set('experimentVersion',2);
      store.event('experiment_started',{version:2,summary:'Cost-aware entries and bounded JEV position management; existing ledger retained'});
    }
    this.paused=store.get('paused',false);
    this.stopped=store.get('stopped',false);
    this.liquidationPending=store.get('liquidationPending',false);
    this.paper=new PaperBroker(store,this.caps);
    if(!this.paper.state.positions.length&&this.liquidationPending) {this.liquidationPending=false;store.set('liquidationPending',false);}
    this.health.jevReady=!!jev;
    this.health.reviewerReady=!!reviewer;
    this.latestReview=store.get('latestReview',this.latestReview);
    this.lastReviewTs=store.get('lastReviewTs',0);
  }
  setClients(jev:AssessmentClient|null,reviewer:ReviewClient|null) {
    this.jev=jev;this.reviewer=reviewer;
    this.health.jevReady=!!jev;this.health.reviewerReady=!!reviewer;
  }
  setRules(rules:SymbolRules[]) { this.rules.clear(); for(const r of rules) this.rules.set(r.symbol,r); this.store.event('rules_loaded',{count:this.rules.size}); }
  setMonitoredMarketCount(count:number) { this.monitoredMarketCount=Math.max(0,Math.floor(count)); }
  setFeedConnected(value:boolean) { const changed=this.health.feedConnected!==value; this.health.feedConnected=value; if(changed&&!value) this.store.event('feed_disconnected',{}); }
  onTick(tick:MarketTick) {
    if(!Number.isFinite(tick.last)||tick.last<=0) return;
    this.latest.set(tick.symbol,tick);
    this.paper.rollDay(tick.ts);
    this.health.lastTickTs=Math.max(this.health.lastTickTs,tick.ts);
    this.health.feedConnected=true;
    const previous=this.lastSnapshot.get(tick.symbol)??0;
    if(tick.bookTs&&tick.ts-tick.bookTs<=3_000&&tick.ts-previous>=5_000) { this.store.snapshot(tick.ts,tick.symbol,tick); this.lastSnapshot.set(tick.symbol,tick.ts); }
    if(this.paper.openOrders.some(order=>order.symbol===tick.symbol)) {
      const fills=this.paper.processTick(tick,this.slippageBps(tick.symbol));
      for(const fill of fills) this.store.event('paper_fill',{symbol:fill.symbol,quantity:fill.quantity,price:fill.price});
    }
    this.paper.mark(tick);
    this.processOutcomes(tick);
    const p=this.paper.position(tick.symbol);
    const freshBook=!!tick.bookTs&&Date.now()-tick.bookTs<=3_000;
    if(p?.symbol===tick.symbol && (this.stopped||this.liquidationPending) && freshBook) {
      const reason=this.liquidationPending?'manual_liquidation':'emergency_stop';
      const trade=this.paper.sell(tick,reason,this.slippageBps(tick.symbol));
      if(trade) {if(this.liquidationPending){this.liquidationPending=this.paper.state.positions.length>0;this.store.set('liquidationPending',this.liquidationPending);}this.store.event('paper_exit',{symbol:tick.symbol,reason,notionalUsdt:trade.notionalUsdt});}
    } else if(p?.symbol===tick.symbol && freshBook) {
      const f=this.features.get(tick.symbol);
      let plan=this.plans[tick.symbol];
      if(!plan) {
        const a=this.assessments.get(tick.symbol);
        if(f&&a)plan=makePlan(f,a,detectSetup(f)??'early_acceleration',p.entryPrice,p.entryTs,this.caps.maxHoldSeconds);
        else plan={setup:'early_acceleration',horizonSeconds:120,deadlineTs:p.entryTs+Math.min(this.caps.maxHoldSeconds,300)*1000,plannedExitTs:p.entryTs+120_000,dipBps:20,stopBid:p.entryPrice*.992,expectedGrossBps:0,entryAssessmentTs:p.entryTs};
        this.plans[tick.symbol]=plan;
      }
      const oldStop=plan.stopBid;
      advanceStop(plan,p.peakBid,(tick.ts-p.entryTs)/1000);
      // Pausing stops providers. Local stops and the planned deadline still run.
      const reason=exitReason(plan,tick,p.entryPrice,this.assessments.get(tick.symbol),this.receivedAt.get(tick.symbol)??0,!this.paused);
      if(reason) {
        const trade=this.paper.sell(tick,reason,this.slippageBps(tick.symbol));
        if(trade) {if(!this.paper.position(tick.symbol))delete this.plans[tick.symbol];this.store.event('paper_exit',{symbol:tick.symbol,reason:trade.reason,notionalUsdt:trade.notionalUsdt});}
      }
      if(reason||plan.stopBid!==oldStop)this.store.set('positionPlansV2',this.plans);
    }
    if(!this.paper.position(tick.symbol)&&this.plans[tick.symbol]){delete this.plans[tick.symbol];this.store.set('positionPlansV2',this.plans);}
    this.research.tick(tick,this.paused?undefined:this.assessments.get(tick.symbol),this.receivedAt.get(tick.symbol)??0);
  }

  onFeatures(f:MarketFeatures) {
    this.features.set(f.symbol,f);
  }
  scan(now=Date.now()) {
    this.research.flush(now);
    this.paper.expireOrders(now);
    this.checkDeadlines(now);
    if(this.stopped||this.paused||!this.jev||!this.health.feedConnected||now<this.retryAt) return;
    // Reserve a conservative request cost so concurrent requests cannot bypass the budget.
    if(this.apiSpendToday()+this.requests.size*0.002>=this.caps.dailyApiSpendUsd) return;
    const fresh=(f:MarketFeatures)=>now-f.ts>=0&&now-f.ts<=3_000&&!!f.bookTs&&now-f.bookTs>=0&&now-f.bookTs<=3_000;
    const managed=[...new Set([...this.paper.state.positions.map(p=>p.symbol),...this.research.symbols])]
      .filter(symbol=>!this.busySymbols.has(symbol)&&now-(this.lastAssessed.get(symbol)??0)>=MANAGEMENT.reassessMs)
      .sort((a,b)=>(this.lastAssessed.get(a)??0)-(this.lastAssessed.get(b)??0));
    const capacity=Math.max(0,8-this.assessing);
    let started=0;
    for(const symbol of managed) {
      if(started>=Math.min(6,capacity))break;
      const f=this.features.get(symbol);if(!f||!fresh(f))continue;
      this.startAssessment(f,now,true);started++;
    }
    const ranked=[...this.features.values()].filter(f=>fresh(f)&&!this.busySymbols.has(f.symbol)
      &&(!this.strategy.selectedSymbols.length||this.strategy.selectedSymbols.includes(f.symbol))
      &&this.rules.has(f.symbol)&&f.quoteVolume24h>=1_000_000&&f.depthUsdt>=2_000&&f.spreadBps<=15&&f.estimatedSlippageBps<=10
      &&detectSetup(f)&&now-(this.lastAssessed.get(f.symbol)??0)>=5_000)
      .sort((a,b)=>opportunityRank(b)-opportunityRank(a));
    for(const f of ranked.slice(0,Math.min(2,capacity-started))) this.startAssessment(f,now,false);
  }
  private startAssessment(f:MarketFeatures,now:number,holding:boolean) {
    if(this.paused||this.stopped||this.apiSpendToday()+this.requests.size*0.002>=this.caps.dailyApiSpendUsd)return;
    this.lastAssessed.set(f.symbol,now);this.assessing++;this.busySymbols.add(f.symbol);
    void this.assess(f,holding).finally(()=>{this.assessing--;this.busySymbols.delete(f.symbol);});
  }
  private checkDeadlines(now:number) {
    for(const p of [...this.paper.state.positions]) {
      const plan=this.plans[p.symbol];
      const deadline=plan?Math.min(plan.deadlineTs,plan.plannedExitTs):p.entryTs+Math.min(this.caps.maxHoldSeconds,120)*1000;
      if(now<deadline)continue;
      const tick=this.latest.get(p.symbol);
      if(tick?.bookTs&&now-tick.bookTs>=0&&now-tick.bookTs<=3_000)this.onTick({...tick,ts:now});
    }
  }
  private async assess(f:MarketFeatures,holding=false) {
    const request=new AbortController();this.requests.add(request);
    try {
      const setup=detectSetup(f)??this.plans[f.symbol]?.setup??'early_acceleration';
      const p=this.paper.position(f.symbol),plan=this.plans[f.symbol];
      const context:JevContext={purpose:holding?'hold':'entry',setup,roundTripCostBps:tradingCostsBps(f),position:p?{ageSeconds:(Date.now()-p.entryTs)/1000,netPnlBps:(p.quantity*f.bid*(1-TAKER_FEE_BPS/10_000)/p.costUsdt-1)*10_000,drawdownBps:(1-f.bid/p.peakBid)*10_000,remainingSeconds:Math.max(0,((plan?.deadlineTs??p.entryTs+300_000)-Date.now())/1000)}:holding?this.research.positionContext(f.symbol,f,Date.now()):undefined};
      const a=await this.jev!.assess(f,120,context,request.signal);
      this.store.usage(Date.now(),'jev',a.inputTokens,a.outputTokens,a.costUsd);
      if(request.signal.aborted||this.paused||this.stopped) return;
      const now=Date.now();this.assessments.set(f.symbol,a);this.receivedAt.set(f.symbol,now);
      this.decisions++;this.latencyTotal+=a.latencyMs;
      if(holding){this.store.decision(now,f.symbol,'hold_reassessment',{assessment:a,features:f,purpose:'hold'});return;}
      const current=this.features.get(f.symbol)??f,tick=this.latest.get(f.symbol);
      if(!tick?.bookTs||now-tick.bookTs<0||now-tick.bookTs>3_000||now-current.ts>3_000||now-f.ts>5_000||Math.abs(tick.ask/f.ask-1)>0.001||detectSetup(current)!==setup) {
        this.skippedReasons.stale_signal=(this.skippedReasons.stale_signal??0)+1;return;
      }
      const forecast=selectForecast(a,current);
      const bucket=calibrationBucket(setup,a,current,forecast?.horizonSeconds??120);
      const calibration=this.research.calibration(bucket,now);
      // All comparable candidates become shadow observations, including rejected entries.
      const orderUsdt=Math.min(this.caps.maxOrderUsdt,this.caps.floatUsdt*this.strategy.positionFraction,this.paper.state.usdt);
      this.research.open(current,a,setup,tick,now,orderUsdt);
      let verdict=signalVerdict(a,current,calibration,this.strategy.costBufferBps);
      const occupied=!!this.paper.position(f.symbol)||this.paper.openOrders.some(o=>o.symbol===f.symbol);
      const rules=this.rules.get(f.symbol);
      if(occupied||this.paper.occupiedSlots>=this.caps.maxPositions)verdict='position_limit';
      else if(this.paper.state.dailyRealisedLossUsdt>=this.caps.dailyLossStopUsdt)verdict='daily_loss_stop';
      else if(this.apiSpendToday()>=this.caps.dailyApiSpendUsd)verdict='api_spend_stop';
      else if(!rules||orderUsdt<rules.minNotional*1.02)verdict='below_exchange_minimum';
      else if(orderUsdt<=0)verdict='insufficient_usdt';
      else if(current.spreadBps>15||current.estimatedSlippageBps>10)verdict='liquidity';
      if(verdict==='approved') {
        const trade=this.paper.buy(tick,orderUsdt,setup,this.slippageBps(f.symbol),rules);
        if(trade){this.approved++;const position=this.paper.position(f.symbol)!;this.plans[f.symbol]=makePlan(current,a,setup,trade.price,position.entryTs,this.caps.maxHoldSeconds);this.store.set('positionPlansV2',this.plans);this.store.event('paper_entry',{symbol:f.symbol,setup,expectedGrossBps:forecast?.expectedGrossBps,calibration});}
        else verdict='execution_rejected';
      }
      if(verdict!=='approved')this.skippedReasons[verdict]=(this.skippedReasons[verdict]??0)+1;
      this.store.decision(now,f.symbol,verdict,{assessment:a,features:current,calibration,requiredBps:tradingCostsBps(current)+this.strategy.costBufferBps,setup,bucket,experimentVersion:2,purpose:'entry'});
    } catch(error) {
      if(!request.signal.aborted){this.skippedReasons.jev_error=(this.skippedReasons.jev_error??0)+1;this.retryAt=Date.now()+Math.max(3_000,Number((error as {retryAfterMs?:number}).retryAfterMs)||0);this.store.event('jev_error',{message:error instanceof Error?error.message:String(error)});}
    } finally {this.requests.delete(request);}
  }
  private processOutcomes(tick:MarketTick) {
    for(const outcome of this.store.pendingOutcomes(tick.symbol)) {
      if(tick.ts<outcome.dueTs) continue;
      if(tick.ts-outcome.dueTs>5_000) {
        this.store.completePendingOutcome(outcome.id);
        this.store.event('outcome_discarded',{symbol:tick.symbol,horizonSeconds:outcome.horizonSeconds,reason:'no_quote_near_due_time'},tick.ts);
        continue;
      }
      if(!tick.bookTs||tick.bookTs>tick.ts||tick.ts-tick.bookTs>3_000||!Number.isFinite(tick.bid)||tick.bid<=0) continue;
      const slip=PAPER_SLIPPAGE_BPS+this.slippageBps(tick.symbol);
      const buy=outcome.entryAsk*(1+slip/10_000);
      const sell=tick.bid*(1-slip/10_000);
      const netBps=(sell/buy-1)*10_000-2*TAKER_FEE_BPS;
      this.store.label(tick.ts,tick.symbol,outcome.bucket,netBps);
      this.store.completePendingOutcome(outcome.id);
      this.store.event('hypothetical_outcome_recorded',{symbol:tick.symbol,horizonSeconds:outcome.horizonSeconds,netBps},tick.ts);
    }
  }
  async reviewIfDue(now=Date.now()) {
    if(this.reviewing||!this.reviewer||this.stopped||this.paused||now-this.lastReviewTs<300_000||this.apiSpendToday()>=this.caps.dailyApiSpendUsd) return;
    if(this.rules.size===0) return;
    const request=new AbortController();this.requests.add(request);
    this.reviewing=true; this.lastReviewTs=now; this.store.set('lastReviewTs',now);
    try {
      const evidence=this.store.reviewEvidence(now-15*60_000,now);
      const candidates=[...this.rules.values()].filter(r=>r.status==='TRADING'&&r.quoteAsset==='USDT')
        .sort((a,b)=>(this.latest.get(b.symbol)?.quoteVolume24h??0)-(this.latest.get(a.symbol)?.quoteVolume24h??0))
        .slice(0,100).map(r=>r.symbol);
      const proposal=await this.reviewer.review({strategy:this.strategy,caps:this.caps,metrics:{portfolio:this.paper.portfolio(this.latest),evidence,candidateCount:this.rules.size,monitoredMarketCount:this.monitoredMarketCount,experimentVersion:2,research:this.research.summary(),automaticChanges:false},candidates},request.signal);
      this.store.usage(Date.now(),'openai',proposal.inputTokens,proposal.outputTokens,proposal.costUsd);
      if(request.signal.aborted||this.paused||this.stopped)return;
      this.latestReview=proposal.summary.slice(0,240);this.store.set('latestReview',this.latestReview);
      const applied=false;
      this.store.review(now,proposal.action,{...proposal,applied,strategyVersion:this.strategy.version});
      this.store.event('review',{action:proposal.action,applied,summary:this.latestReview});
    } catch(error) {if(!request.signal.aborted)this.store.event('review_error',{message:error instanceof Error?error.message:String(error)});}
    finally {this.reviewing=false;this.requests.delete(request);}
  }
  apiSpendToday() { const since=new Date(`${utcDay(Date.now())}T00:00:00.000Z`).getTime(); return Object.values(this.store.usageSince(since)).reduce((sum,u)=>sum+u.costUsd,0); }
  recordPortfolio(now=Date.now()) { this.store.portfolioPoint(now,this.paper.portfolio(this.latest).portfolioUsdt,this.portfolioRunId); }
  private abortProviders() {for(const request of this.requests)request.abort();}
  control(action:string,caps?:Partial<RiskCaps>,startingUsdt?:number) {
    if(action==='restart'&&this.stopped) {
      if(this.paper.state.positions.length) throw new Error('Wait for remaining paper holdings to close before restarting');
      this.stopped=false;this.paused=false;this.liquidationPending=false;this.store.set('stopped',false);this.store.set('paused',false);this.store.set('liquidationPending',false);
    }
    else if(action==='pause') {this.abortProviders();for(const order of this.paper.openOrders)this.paper.cancelOrder(order.id);this.paused=true;this.store.set('paused',true);}
    else if(action==='resume'&&!this.stopped&&!this.liquidationPending) {this.paused=false;this.store.set('paused',false);}
    else if(action==='liquidate') {
      this.abortProviders();
      for(const order of this.paper.openOrders)this.paper.cancelOrder(order.id);
      this.paused=true;this.store.set('paused',true);
      for(const position of [...this.paper.state.positions]) {
        const tick=this.latest.get(position.symbol);
        if(tick?.bookTs&&Date.now()-tick.bookTs<=3_000&&tick.bid>0) {
          const trade=this.paper.sell(tick,'manual_liquidation',this.slippageBps(position.symbol));
          if(trade) this.store.event('paper_exit',{symbol:position.symbol,reason:trade.reason,notionalUsdt:trade.notionalUsdt});
        }
      }
      this.liquidationPending=this.paper.state.positions.length>0;this.store.set('liquidationPending',this.liquidationPending);
    }
    else if(action==='stop') {
      this.abortProviders();
      for(const order of this.paper.openOrders)this.paper.cancelOrder(order.id);
      for(const position of [...this.paper.state.positions]) {
        const tick=this.latest.get(position.symbol);
        if(tick?.bookTs&&Date.now()-tick.bookTs<=3_000) this.paper.sell(tick,'emergency_stop',this.slippageBps(position.symbol));
      }
      this.stopped=true;this.paused=true;this.store.set('stopped',true);this.store.set('paused',true);
    }
    else if(action==='start-paper') {
      if(this.stopped) throw new Error('A stopped bot must be restarted before starting a new run');
      if(!this.paused) throw new Error('Pause trading before starting a new paper run');
      if(typeof startingUsdt!=='number') throw new Error('Starting USDT is required');
      this.paper.startWithBalance(startingUsdt);
      this.caps={...this.caps,floatUsdt:startingUsdt};this.paper.setCaps(this.caps);this.store.set('caps',this.caps);
      this.portfolioRunId=this.store.startPortfolioRun(Date.now());
      this.recordPortfolio();
      this.paused=false;this.store.set('paused',false);
    }
    else if(action==='set-caps'&&caps) {
      const allowed=['floatUsdt','maxOrderUsdt','dailyLossStopUsdt','dailyApiSpendUsd','maxPositions'];
      if(Object.keys(caps).some(k=>!allowed.includes(k))) throw new Error('Unsupported cap');
      for(const value of Object.values(caps)) if(typeof value!=='number'||!Number.isFinite(value)||value<=0) throw new Error('Caps must be positive finite numbers');
      if(caps.maxPositions!==undefined&&(!Number.isInteger(caps.maxPositions)||caps.maxPositions>MAX_POSITIONS)) throw new Error('Maximum open positions must be an integer from 1 to 50');
      for(const order of this.paper.openOrders)this.paper.cancelOrder(order.id);
      this.caps={...this.caps,...caps};this.paper.setCaps(this.caps);this.store.set('caps',this.caps);
    } else throw new Error('Unknown or unavailable action');
    this.store.event('control',{action,caps});return this.state();
  }
  state() {
    const since=new Date(`${utcDay(Date.now())}T00:00:00.000Z`).getTime();
    const usage=this.store.usageSince(since);const jev=usage.jev??emptyUsage();const openai=usage.openai??emptyUsage();
    const balances=this.paper.portfolio(this.latest);
    const candidates=[...this.rules.values()].filter(r=>r.status==='TRADING'&&r.quoteAsset==='USDT').length;
    return {experiment:{version:2,automaticChanges:false,reassessmentSeconds:3,maxHoldSeconds:Math.min(300,this.caps.maxHoldSeconds),shadowPositions:this.research.activeCount,comparisons:this.research.summary()},positionPlans:this.plans,providerRequestsInFlight:this.requests.size,mode:'paper' as const,paused:this.paused,stopped:this.stopped,liquidationPending:this.liquidationPending,health:this.health,balances,usage:{jev,openai,totalCostUsd:jev.costUsd+openai.costUsd},caps:this.caps,strategy:this.strategy,latestReview:this.latestReview,openOrders:this.paper.openOrders.map(o=>({id:o.id,symbol:o.symbol,side:o.side,price:o.limitPrice,quantity:o.remainingQuantity,ts:o.createdTs,status:o.status,filledQuantity:o.filledQuantity})),recentTrades:this.store.trades(20),recentEvents:this.store.recentEvents(20),skippedReasons:this.skippedReasons,jevGateFailures:this.jevGateFailures,metrics:{decisions:this.decisions,approved:this.approved,avgDecisionLatencyMs:this.decisions?this.latencyTotal/this.decisions:0},candidateCount:candidates,monitoredMarketCount:this.monitoredMarketCount,portfolioRunId:this.portfolioRunId,updatedAt:Date.now()};
  }
  private slippageBps(symbol:string) { return Math.max(0,Math.min(10,this.features.get(symbol)?.estimatedSlippageBps??10)); }
}

export function edgeStats(values:number[]):EdgeStats {
  if(!values.length) return {count:0,meanNetBps:0,lowerNetBps:-Infinity};
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  const variance=values.length>1?values.reduce((a,b)=>a+(b-mean)**2,0)/(values.length-1):0;
  return {count:values.length,meanNetBps:mean,lowerNetBps:mean-1.645*Math.sqrt(variance/values.length)};
}

function opportunityRank(f:MarketFeatures):number {
  return Math.min(200,f.return15s*10_000)+0.4*Math.min(200,f.return1m*10_000)
    +5*Math.min(5,f.relativeVolume1m)-f.spreadBps-2*f.estimatedSlippageBps;
}
import { randomUUID } from 'node:crypto';
