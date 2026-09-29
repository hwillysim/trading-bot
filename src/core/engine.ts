import type { JevAssessment, MarketFeatures, MarketTick, ReviewProposal, RiskCaps, StrategyConfig, SymbolRules } from '../shared/types.ts';
import { DEFAULT_CAPS, DEFAULT_STRATEGY, PAPER_SLIPPAGE_BPS, TAKER_FEE_BPS, utcDay } from './defaults.ts';
import { judgeEntry, regimeBucket, validateReviewPatch, type EdgeStats } from './policy.ts';
import { PaperBroker } from './paper.ts';
import { Store } from './store.ts';

export interface AssessmentClient { assess(features:MarketFeatures):Promise<JevAssessment> }
export interface ReviewClient { review(input:{strategy:StrategyConfig;caps:RiskCaps;metrics:unknown;candidates:string[]}):Promise<ReviewProposal> }
interface PendingLabel { symbol:string; due:number; entryAsk:number; bucket:string; ts:number }

const emptyUsage=()=>({inputTokens:0,outputTokens:0,costUsd:0,requests:0});

export class BotEngine {
  readonly store:Store;
  private readonly jev:AssessmentClient|null;
  private readonly reviewer:ReviewClient|null;
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
  readonly pendingLabels:PendingLabel[]=[];
  readonly health={feedConnected:false,lastTickTs:0,jevReady:false,reviewerReady:false};
  latestReview='The strategy has not been reviewed yet.';
  decisions=0;
  approved=0;
  private latencyTotal=0;
  private lastAssessmentStarted=0;
  private lastAssessed=new Map<string,number>();
  private assessing=0;
  private lastReviewTs=0;
  private reviewing=false;
  private lastSnapshot=new Map<string,number>();
  private previousStrategy:StrategyConfig|null=null;
  private patchTradeCount=0;
  private patchPnl=0;
  constructor(store:Store,jev:AssessmentClient|null,reviewer:ReviewClient|null) {
    this.store=store;this.jev=jev;this.reviewer=reviewer;
    this.caps=store.get('caps',{...DEFAULT_CAPS});
    this.strategy=store.get('strategy',{...DEFAULT_STRATEGY});
    this.paused=store.get('paused',false);
    this.stopped=store.get('stopped',false);
    this.liquidationPending=store.get('liquidationPending',false);
    this.paper=new PaperBroker(store,this.caps);
    if(!this.paper.state.position&&this.liquidationPending) {this.liquidationPending=false;store.set('liquidationPending',false);}
    this.health.jevReady=!!jev;
    this.health.reviewerReady=!!reviewer;
    this.latestReview=store.get('latestReview',this.latestReview);
    this.lastReviewTs=store.get('lastReviewTs',0);
  }
  setRules(rules:SymbolRules[]) { this.rules.clear(); for(const r of rules) this.rules.set(r.symbol,r); this.store.event('rules_loaded',{count:this.rules.size}); }
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
    this.processLabels(tick);
    const p=this.paper.state.position;
    const freshBook=!!tick.bookTs&&Date.now()-tick.bookTs<=3_000;
    if(p?.symbol===tick.symbol && (this.stopped||this.liquidationPending) && freshBook) {
      const reason=this.liquidationPending?'manual_liquidation':'emergency_stop';
      const trade=this.paper.sell(tick,reason,this.slippageBps(tick.symbol));
      if(trade) {this.liquidationPending=false;this.store.set('liquidationPending',false);this.store.event('paper_exit',{symbol:tick.symbol,reason,notionalUsdt:trade.notionalUsdt});}
    } else if(p?.symbol===tick.symbol && freshBook) {
      const age=(tick.ts-p.entryTs)/1000;
      const stop=tick.bid <= p.entryPrice*0.992;
      const trail=age>=15 && tick.bid <= p.peakBid*0.996;
      const reversal=(this.assessments.get(tick.symbol)?.reversalProbability??0)>this.strategy.reversalExitProbability;
      const target=age>=this.strategy.targetHoldSeconds && tick.bid>p.entryPrice && tick.bid<p.peakBid*0.998;
      const max=age>=this.caps.maxHoldSeconds;
      if(stop||trail||reversal||target||max) {
        const trade=this.paper.sell(tick,stop?'protective_stop':trail?'trailing_reversal':reversal?'jev_reversal':target?'target_hold_exit':'max_hold_exit',this.slippageBps(tick.symbol));
        if(trade) {this.liquidationPending=false;this.store.set('liquidationPending',false);this.store.event('paper_exit',{symbol:tick.symbol,reason:trade.reason,notionalUsdt:trade.notionalUsdt});}
      }
    }
  }
  onFeatures(f:MarketFeatures) {
    this.features.set(f.symbol,f);
  }
  scan(now=Date.now()) {
    const expired=this.paper.expireOrders(now);
    if(expired)this.store.event('paper_orders_expired',{count:expired});
    if(this.stopped||this.paused||!this.jev||!this.health.feedConnected) return;
    if(now-this.lastAssessmentStarted<5_000 || this.assessing>=2) return;
    if(this.apiSpendToday()>=this.caps.dailyApiSpendUsd) return;
    const ranked=[...this.features.values()].filter(f=>{
      if(this.strategy.selectedSymbols.length&&!this.strategy.selectedSymbols.includes(f.symbol)) return false;
      if(!this.rules.has(f.symbol)||now-f.ts>3_000||!f.bookTs||now-f.bookTs>3_000) return false;
      if(f.quoteVolume24h<1_000_000||f.depthUsdt<2_000||f.spreadBps>25||f.estimatedSlippageBps>10) return false;
      if(f.return15s<0.0005||f.return1m<0.0005||f.relativeVolume1m<0.8) return false;
      return now-(this.lastAssessed.get(f.symbol)??0)>30_000;
    }).sort((a,b)=>opportunityRank(b)-opportunityRank(a));
    const slots=Math.min(2-this.assessing,2,ranked.length);
    for(let i=0;i<slots;i++) {
      const f=ranked[i];
      this.lastAssessed.set(f.symbol,now);
      this.assessing++;
      void this.assess(f).finally(()=>{this.assessing--;});
    }
    if(slots) this.lastAssessmentStarted=now;
  }
  private async assess(f:MarketFeatures) {
    try {
      const a=await this.jev!.assess(f);
      this.assessments.set(f.symbol,a);
      this.store.usage(Date.now(),'jev',a.inputTokens,a.outputTokens,a.costUsd);
      const bucket=`${regimeBucket(f)}:${this.strategy.targetHoldSeconds}`;
      if(a.setupScore>=3&&a.setupConfidence>=this.strategy.entryConfidence&&a.continuationProbability>=this.strategy.continuationProbability&&a.waitProbability<=0.3)
        this.pendingLabels.push({symbol:f.symbol,due:f.ts+this.strategy.targetHoldSeconds*1_000,entryAsk:f.ask,bucket,ts:f.ts});
      const values=this.store.labelValues(bucket,f.symbol);
      const edge=edgeStats(values);
      const verdict=judgeEntry({features:f,assessment:a,rules:this.rules.get(f.symbol),strategy:this.strategy,caps:this.caps,availableUsdt:this.paper.state.usdt,openPositions:this.paper.state.position||this.paper.openOrders.length?1:0,dailyRealisedLossUsdt:this.paper.state.dailyRealisedLossUsdt,apiSpendUsd:this.apiSpendToday(),edge,now:Date.now(),live:false,paused:this.paused||this.stopped});
      this.decisions++;
      this.latencyTotal+=a.latencyMs;
      if(verdict.allowed) {
        const tick=this.latest.get(f.symbol);
        if(tick?.bookTs&&Date.now()-tick.bookTs<=3_000) {
          const order=this.paper.submitBuy(tick,verdict.orderUsdt,'jev_net_edge',this.slippageBps(f.symbol));
          if(order) {this.approved++;this.store.event('paper_order',{symbol:f.symbol,limitPrice:order.limitPrice,quantity:order.quantity});}
        }
      } else this.skippedReasons[verdict.reason]=(this.skippedReasons[verdict.reason]??0)+1;
      this.store.decision(Date.now(),f.symbol,verdict.reason,{assessment:a,features:f,edge,requiredBps:verdict.requiredBps});
    } catch(error) {
      this.skippedReasons.jev_error=(this.skippedReasons.jev_error??0)+1;
      this.store.event('jev_error',{message:error instanceof Error?error.message:String(error)});
    }
  }
  private processLabels(tick:MarketTick) {
    if(!tick.bookTs||Date.now()-tick.bookTs>3_000) return;
    for(let i=this.pendingLabels.length-1;i>=0;i--) {
      const label=this.pendingLabels[i];
      if(label.symbol!==tick.symbol||tick.ts<label.due) continue;
      const slip=PAPER_SLIPPAGE_BPS+this.slippageBps(tick.symbol);
      const buy=label.entryAsk*(1+slip/10_000);
      const sell=tick.bid*(1-slip/10_000);
      const netBps=(sell/buy-1)*10_000-2*TAKER_FEE_BPS;
      this.store.label(tick.ts,tick.symbol,label.bucket,netBps);
      this.pendingLabels.splice(i,1);
    }
  }
  async reviewIfDue(now=Date.now()) {
    if(this.reviewing||!this.reviewer||this.stopped||now-this.lastReviewTs<300_000||this.apiSpendToday()>=this.caps.dailyApiSpendUsd) return;
    if(this.rules.size===0) return;
    this.reviewing=true; this.lastReviewTs=now; this.store.set('lastReviewTs',now);
    try {
      const before=this.paper.state.realisedPnlUsdt;
      const evidence=this.store.reviewEvidence(now-15*60_000,now);
      const candidates=[...this.rules.values()].filter(r=>r.status==='TRADING'&&r.quoteAsset==='USDT')
        .sort((a,b)=>(this.latest.get(b.symbol)?.quoteVolume24h??0)-(this.latest.get(a.symbol)?.quoteVolume24h??0))
        .slice(0,100).map(r=>r.symbol);
      const proposal=await this.reviewer.review({strategy:this.strategy,caps:this.caps,metrics:{portfolio:this.paper.portfolio(this.latest),evidence,candidateCount:this.rules.size},candidates});
      this.store.usage(Date.now(),'openai',proposal.inputTokens,proposal.outputTokens,proposal.costUsd);
      this.latestReview=proposal.summary.slice(0,240);this.store.set('latestReview',this.latestReview);
      let applied=false;
      const measuredProblem=(evidence.trading.closedTrades>=10&&evidence.trading.netPnlUsdt<0)
        ||(evidence.decisions.jev.outcomes.count>=30&&evidence.decisions.jev.outcomes.meanNetBps<0);
      if(proposal.action==='patch'&&proposal.patch&&proposal.reason.length>=20&&/\d/.test(proposal.reason)&&measuredProblem) {
        const next=validateReviewPatch(this.strategy,proposal.patch,candidates);
        if(next) {
          this.previousStrategy=this.strategy;this.patchTradeCount=this.store.trades(1_000).filter(t=>t.side==='SELL').length;this.patchPnl=before;
          this.strategy=next;this.store.set('strategy',next);applied=true;
        }
      }
      this.store.review(now,proposal.action,{...proposal,applied,strategyVersion:this.strategy.version});
      this.store.event('review',{action:proposal.action,applied,summary:this.latestReview});
    } catch(error) {this.store.event('review_error',{message:error instanceof Error?error.message:String(error)});}
    finally {this.reviewing=false;}
  }
  checkRollback() {
    if(!this.previousStrategy) return;
    const completed=this.store.trades(1_000).filter(t=>t.side==='SELL').length-this.patchTradeCount;
    if(completed>=10) {
      if(this.paper.state.realisedPnlUsdt-this.patchPnl<-0.02) {
        this.strategy={...this.previousStrategy,version:this.strategy.version+1};
        this.store.set('strategy',this.strategy);this.store.event('strategy_rollback',{reason:'negative_paper_result'});
      }
      this.previousStrategy=null;
    }
  }
  apiSpendToday() { const since=new Date(`${utcDay(Date.now())}T00:00:00.000Z`).getTime(); return Object.values(this.store.usageSince(since)).reduce((sum,u)=>sum+u.costUsd,0); }
  recordPortfolio(now=Date.now()) { this.store.portfolioPoint(now,this.paper.portfolio(this.latest).portfolioUsdt); }
  control(action:string,caps?:Partial<RiskCaps>) {
    if(action==='pause') {for(const order of this.paper.openOrders)this.paper.cancelOrder(order.id);this.paused=true;this.store.set('paused',true);}
    else if(action==='resume'&&!this.stopped&&!this.liquidationPending) {this.paused=false;this.store.set('paused',false);}
    else if(action==='liquidate') {
      for(const order of this.paper.openOrders)this.paper.cancelOrder(order.id);
      this.paused=true;this.store.set('paused',true);
      const symbol=this.paper.state.position?.symbol;
      this.liquidationPending=!!symbol;this.store.set('liquidationPending',this.liquidationPending);
      if(symbol) {
        const tick=this.latest.get(symbol);
        if(tick?.bookTs&&Date.now()-tick.bookTs<=3_000&&tick.bid>0) {
          const trade=this.paper.sell(tick,'manual_liquidation',this.slippageBps(symbol));
          if(trade) {this.liquidationPending=false;this.store.set('liquidationPending',false);this.store.event('paper_exit',{symbol,reason:trade.reason,notionalUsdt:trade.notionalUsdt});}
        }
      }
    }
    else if(action==='stop') {
      for(const order of this.paper.openOrders)this.paper.cancelOrder(order.id);
      const symbol=this.paper.state.position?.symbol;
      if(symbol) {const tick=this.latest.get(symbol);if(tick?.bookTs&&Date.now()-tick.bookTs<=3_000) this.paper.sell(tick,'emergency_stop',this.slippageBps(symbol));}
      this.stopped=true;this.paused=true;this.store.set('stopped',true);this.store.set('paused',true);
    }
    else if(action==='set-caps'&&caps) {
      const allowed=['floatUsdt','maxOrderUsdt','dailyLossStopUsdt','dailyApiSpendUsd'];
      if(Object.keys(caps).some(k=>!allowed.includes(k))) throw new Error('Unsupported cap');
      for(const value of Object.values(caps)) if(typeof value!=='number'||!Number.isFinite(value)||value<=0) throw new Error('Caps must be positive finite numbers');
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
    return {mode:'paper' as const,paused:this.paused,stopped:this.stopped,liquidationPending:this.liquidationPending,health:this.health,balances,usage:{jev,openai,totalCostUsd:jev.costUsd+openai.costUsd},caps:this.caps,strategy:this.strategy,latestReview:this.latestReview,openOrders:this.paper.openOrders.map(o=>({id:o.id,symbol:o.symbol,side:o.side,price:o.limitPrice,quantity:o.remainingQuantity,ts:o.createdTs,status:o.status,filledQuantity:o.filledQuantity})),recentTrades:this.store.trades(20),recentEvents:this.store.recentEvents(20),skippedReasons:this.skippedReasons,metrics:{decisions:this.decisions,approved:this.approved,avgDecisionLatencyMs:this.decisions?this.latencyTotal/this.decisions:0},candidateCount:candidates,updatedAt:Date.now()};
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
