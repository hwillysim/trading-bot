import { randomUUID } from 'node:crypto';
import type { JevAssessment, MarketFeatures, MarketTick, StrategyConfig } from '../shared/types.ts';
import { Store } from './store.ts';
import { MANAGEMENT, advanceStop, calibrationBucket, makePlan, detectSetup, exitReason, selectForecast, signalVerdict, tradingCostsBps, strategyProfile, type Calibration, type PositionPlan, type Setup } from './adaptive.ts';
import { PAPER_SLIPPAGE_BPS, TAKER_FEE_BPS } from './defaults.ts';

type Variant='fixed_time'|'volatility'|'jev_volatility'|'passive_fixed'|'jev_tight'|'jev_wide';
type Leg={variant:Variant;entryPrice:number;entryTs:number;peakBid:number;plan:PositionPlan;closed:boolean;queueAhead?:number;filled?:boolean};
type Episode={id:string;symbol:string;ts:number;bucket:string;horizonSeconds:number;slipBps:number;legs:Leg[];calibrated:boolean;calibrationDueTs:number;lastTickTs:number; metadata?:{entryTs:number;profile:string;eligible:boolean;expectedGrossBps:number;clearsCostsProbability:number;relativeVolume:number;flowRatio:number;spreadBps:number;entryMid:number;costBps:number}};
export class ResearchTracker {
  private episodes:Episode[];
  private lastSample:Record<string,number>;
  private lastSaved=0;
  private dirty=false;
  private store:Store;
  constructor(store:Store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS research_outcomes(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,symbol TEXT NOT NULL,bucket TEXT NOT NULL,variant TEXT NOT NULL,net_bps REAL,reason TEXT NOT NULL,episode_id TEXT NOT NULL); CREATE INDEX IF NOT EXISTS research_bucket_ts ON research_outcomes(bucket,ts);`);
    if(!(store.db.prepare('PRAGMA table_info(research_outcomes)').all() as {name:string}[]).some(c=>c.name==='data'))store.db.exec("ALTER TABLE research_outcomes ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
    store.db.exec("CREATE INDEX IF NOT EXISTS research_profile_ts ON research_outcomes(json_extract(data,'$.profile'),variant,ts); CREATE INDEX IF NOT EXISTS research_variant_ts ON research_outcomes(variant,ts);");
    this.episodes=store.get('researchEpisodesV2',[]);this.lastSample=store.get('researchLastSampleV2',{});
  }
  get symbols() {return this.episodes.map(e=>e.symbol);}
  get managedSymbols() {return this.episodes.filter(e=>e.legs.some(l=>['jev_volatility','jev_tight','jev_wide'].includes(l.variant)&&!l.closed)).map(e=>e.symbol);}
  get activeCount() {return this.episodes.length;}
  open(f:MarketFeatures,a:JevAssessment,setup:Setup,tick:MarketTick,now:number,orderUsdt=20,strategy?:StrategyConfig) {
    if(this.episodes.some(e=>e.symbol===f.symbol)||now-(this.lastSample[f.symbol]??0)<300_000) return;
    const forecast=selectForecast(a,f,strategy);if(!forecast)return;
    const slipBps=PAPER_SLIPPAGE_BPS+Math.max(0,f.estimatedSlippageBps);
    const entryPrice=tick.ask*(1+slipBps/10_000),id=randomUUID();
    const legs:Leg[]=['fixed_time','volatility','jev_volatility','passive_fixed','jev_tight','jev_wide'].map(variant=>({variant:variant as Variant,entryPrice:variant==='passive_fixed'?tick.bid:entryPrice,entryTs:now,peakBid:tick.bid,plan:makePlan(f,a,setup,entryPrice,now,300,variant==='jev_tight'?{...strategy!,volatilityMultiple:1.5}:variant==='jev_wide'?{...strategy!,volatilityMultiple:4}:strategy),closed:false,filled:variant!=='passive_fixed',queueAhead:variant==='passive_fixed'?tick.bidQty+orderUsdt/tick.bid:undefined}));
    this.episodes.push({id,symbol:f.symbol,ts:now,bucket:calibrationBucket(setup,a,f,forecast.horizonSeconds,strategy),horizonSeconds:forecast.horizonSeconds,slipBps,legs,calibrated:false,calibrationDueTs:now+forecast.horizonSeconds*1000,lastTickTs:now,metadata:{entryTs:now,profile:strategyProfile(strategy),eligible:detectSetup(f,strategy)===setup&&f.spreadBps<=(strategy?.maxSpreadBps??10)&&signalVerdict(a,f,{count:30,blocks:5,meanNetBps:100,lowerNetBps:100},strategy?.costBufferBps??3,strategy)==='approved',expectedGrossBps:forecast.expectedGrossBps,clearsCostsProbability:forecast.clearsCostsProbability??a.clearsCostsProbability??0,relativeVolume:f.relativeVolume1m,flowRatio:(f.buyFlow5s??f.buyFlow1m)/Math.max(1,f.sellFlow5s??f.sellFlow1m),spreadBps:f.spreadBps,entryMid:(tick.bid+tick.ask)/2,costBps:tradingCostsBps(f)}});
    this.lastSample[f.symbol]=now;this.save(true);
  }
  calibration(bucket:string,now:number):Calibration {
    const rows=this.store.db.prepare(`SELECT ts,net_bps net FROM research_outcomes WHERE bucket=? AND variant='jev_volatility' AND json_extract(data,'$.eligible')=1 AND net_bps IS NOT NULL AND ts<? AND ts>=? ORDER BY ts DESC LIMIT 500`).all(bucket,now,now-24*60*60_000) as {ts:number;net:number}[];
    const blockValues=new Map<number,number[]>();
    for(const r of rows){const key=Math.floor(r.ts/300_000);const values=blockValues.get(key)??[];values.push(r.net);blockValues.set(key,values);}
    const means=[...blockValues.values()].map(v=>v.reduce((a,b)=>a+b,0)/v.length);
    const mean=means.length?means.reduce((a,b)=>a+b,0)/means.length:0;
    const variance=means.length>1?means.reduce((sum,v)=>sum+(v-mean)**2,0)/(means.length-1):0;
    return {count:rows.length,blocks:means.length,meanNetBps:mean,lowerNetBps:means.length>1?mean-1.96*Math.sqrt(variance/means.length):-Infinity};
  }
  tick(tick:MarketTick,a?:JevAssessment,receivedTs=0) {
    if(!tick.bookTs||tick.ts-tick.bookTs>3000||tick.ts<tick.bookTs||tick.bid<=0) return;
    let changed=false;
    for(const e of this.episodes.filter(e=>e.symbol===tick.symbol)) {
      if(tick.ts-(e.lastTickTs??e.ts)>5_000) {
        if(!e.calibrated){this.record(e,'calibration',null,'missing_quote',tick.ts);e.calibrated=true;}
        for(const leg of e.legs)if(!leg.closed){this.record(e,leg.variant,null,'missing_quote',tick.ts);leg.closed=true;}
        changed=true;continue;
      }
      e.lastTickTs=Math.max(e.lastTickTs??e.ts,tick.ts);
      if(!e.calibrated&&tick.ts>=e.calibrationDueTs) {
        const near=tick.ts-e.calibrationDueTs<=5_000;
        this.record(e,'calibration',near?this.net(e.legs[0]!.entryPrice,tick.bid,e.slipBps):null,near?'horizon':'missing_quote',tick.ts,near&&e.metadata?{observedGrossBps:((tick.bid+tick.ask)/2/e.metadata.entryMid-1)*10_000}:undefined);
        e.calibrated=true;changed=true;
      }
      for(const leg of e.legs) {
        if(leg.closed)continue;
        if(!leg.filled) {
          if(tick.ts-e.ts>=30_000){this.record(e,leg.variant,null,'unfilled',tick.ts);leg.closed=true;changed=true;continue;}
          // A passive fill requires actual selling through the bid and consumes the queue ahead.
          if(tick.tradeBuyerIsMaker&&tick.tradeQty&&tick.last<=leg.entryPrice) {
            leg.queueAhead=(leg.queueAhead??0)-tick.tradeQty;
            if(leg.queueAhead<0){leg.filled=true;leg.entryTs=tick.ts;leg.plan.plannedExitTs=tick.ts+e.horizonSeconds*1000;}
            changed=true;
          }
          if(!leg.filled)continue;
        }
        const previous=leg.peakBid,previousStop=leg.plan.stopBid,previousExit=leg.plan.plannedExitTs;leg.peakBid=Math.max(leg.peakBid,tick.bid);
        advanceStop(leg.plan,leg.peakBid,(tick.ts-leg.entryTs)/1000);
        const reason=leg.variant==='fixed_time'||leg.variant==='passive_fixed'?(tick.bid<=leg.entryPrice*(1-MANAGEMENT.hardLossBps/10_000)?'protective_stop':tick.ts-leg.entryTs>=e.horizonSeconds*1000?'fixed_time_exit':null):exitReason(leg.plan,tick,leg.entryPrice,a,receivedTs,['jev_volatility','jev_tight','jev_wide'].includes(leg.variant));
        if(reason) {
          // Gaps are missing evidence, rather than assumed fills at an old deadline.
          const late=tick.ts-leg.entryTs>MANAGEMENT.maxSeconds*1000+5_000;
          this.record(e,leg.variant,late?null:this.net(leg.entryPrice,tick.bid,e.slipBps),late?'missing_quote':reason,tick.ts);leg.closed=true;changed=true;
        } else if(previous!==leg.peakBid||previousStop!==leg.plan.stopBid||previousExit!==leg.plan.plannedExitTs)changed=true;
      }
    }
    this.episodes=this.episodes.filter(e=>!e.calibrated||e.legs.some(l=>!l.closed));
    if(changed||this.episodes.some(e=>e.symbol===tick.symbol))this.save();
  }
  positionContext(symbol:string,tick:MarketTick,now:number) {
    const e=this.episodes.find(e=>e.symbol===symbol),leg=e?.legs.find(l=>['jev_volatility','jev_tight','jev_wide'].includes(l.variant)&&!l.closed);
    return leg?{ageSeconds:(now-leg.entryTs)/1000,netPnlBps:this.net(leg.entryPrice,tick.bid,e!.slipBps),drawdownBps:(1-tick.bid/leg.peakBid)*10_000,remainingSeconds:Math.max(0,(leg.plan.deadlineTs-now)/1000)}:undefined;
  }
  summary() {
    return this.store.db.prepare(`SELECT variant,COUNT(*) completed,SUM(net_bps IS NOT NULL) covered,AVG(net_bps) meanNetBps,SUM(net_bps>0) wins FROM research_outcomes WHERE bucket LIKE 'v3:%' GROUP BY variant`).all();
  }
  profileEvidence(profile:string,since=0,now=Date.now()) {
    const rows=this.store.db.prepare("SELECT ts,net_bps net,data FROM research_outcomes WHERE variant='jev_volatility' AND json_extract(data,'$.profile')=? AND json_extract(data,'$.entryTs')>=? AND ts<=? ORDER BY ts DESC LIMIT 500").all(profile,since,now) as {ts:number;net:number|null;data:string}[];
    const eligible=rows.filter(r=>JSON.parse(r.data).eligible&&r.net!==null);
    return {...blockStats(eligible as {ts:number;net:number}[]),total:rows.length,eligible:eligible.length};
  }
  outcomeCount() {return (this.store.db.prepare("SELECT COUNT(*) n FROM research_outcomes WHERE variant='jev_volatility' AND bucket LIKE 'v3:%'").get() as {n:number}).n;}
  scorecard(profile:string) {
    const rows=this.store.db.prepare("SELECT ts,net_bps net,data FROM research_outcomes WHERE variant='jev_volatility' AND json_extract(data,'$.profile')=? AND net_bps IS NOT NULL ORDER BY ts DESC LIMIT 200").all(profile) as {ts:number;net:number;data:string}[];
    const candidates=rows.map(r=>({...r,metadata:JSON.parse(r.data)}));
    const filters=[['all',()=>true],['volume_at_least_1_5',(r:any)=>r.metadata.relativeVolume>=1.5],['flow_at_least_1_6',(r:any)=>r.metadata.flowRatio>=1.6],['spread_at_most_8',(r:any)=>r.metadata.spreadBps<=8]] as const;
    const forecastRows=this.store.db.prepare("SELECT data FROM research_outcomes WHERE variant='calibration' AND json_extract(data,'$.profile')=? AND net_bps IS NOT NULL ORDER BY ts DESC LIMIT 200").all(profile) as {data:string}[];
    const forecasts=forecastRows.map(r=>JSON.parse(r.data)).filter(r=>Number.isFinite(r.observedGrossBps));
    const predictionBins=[0,1,2,3].map(bin=>{const selected=forecasts.filter(r=>Math.min(3,Math.floor(r.clearsCostsProbability*4))===bin);return {bin,count:selected.length,predicted:selected.length?selected.reduce((s,r)=>s+r.clearsCostsProbability,0)/selected.length:null,observedClearingFraction:selected.length?selected.filter(r=>r.observedGrossBps>r.costBps).length/selected.length:null,forecastMeanBps:selected.length?selected.reduce((s,r)=>s+r.expectedGrossBps,0)/selected.length:null,observedMeanBps:selected.length?selected.reduce((s,r)=>s+r.observedGrossBps,0)/selected.length:null};});
    const paired=this.store.db.prepare("SELECT a.ts,a.net_bps base,b.net_bps alternative,b.variant FROM research_outcomes a JOIN research_outcomes b ON a.episode_id=b.episode_id WHERE a.variant='jev_volatility' AND b.variant IN ('jev_tight','jev_wide') AND json_extract(a.data,'$.profile')=? AND a.net_bps IS NOT NULL AND b.net_bps IS NOT NULL ORDER BY a.ts DESC LIMIT 400").all(profile) as {ts:number;base:number;alternative:number;variant:string}[];
    return {profile,filters:filters.map(([name,accept])=>({name,...blockStats(candidates.filter(accept))})),eligible:this.profileEvidence(profile),predictionBins,stopComparisons:['jev_tight','jev_wide'].map(variant=>({variant,...blockStats(paired.filter(r=>r.variant===variant).map(r=>({ts:r.ts,net:r.alternative-r.base})))}))};
  }
  private net(entry:number,bid:number,slip:number){return ((bid*(1-slip/10_000)*(1-TAKER_FEE_BPS/10_000))/(entry*(1+TAKER_FEE_BPS/10_000))-1)*10_000;}
  private record(e:Episode,variant:string,net:number|null,reason:string,ts:number,extra?:Record<string,number>){this.store.db.prepare('INSERT OR IGNORE INTO research_outcomes(id,ts,symbol,bucket,variant,net_bps,reason,episode_id,data) VALUES(?,?,?,?,?,?,?,?,?)').run(`${e.id}:${variant}`,ts,e.symbol,e.bucket,variant,net,reason,e.id,JSON.stringify({...e.metadata,...extra}));}
  flush(now=Date.now()){if(this.dirty&&now-this.lastSaved>=1000)this.save(true);}
  private save(force=false){this.dirty=true;if(!force&&Date.now()-this.lastSaved<1000)return;this.store.set('researchEpisodesV2',this.episodes);this.store.set('researchLastSampleV2',this.lastSample);this.lastSaved=Date.now();this.dirty=false;}
}

function blockStats(rows:{ts:number;net:number}[]):Calibration {
 const blocks=new Map<number,number[]>();for(const r of rows){const key=Math.floor(r.ts/300_000);const values=blocks.get(key)??[];values.push(r.net);blocks.set(key,values);}
 const means=[...blocks.values()].map(v=>v.reduce((s,n)=>s+n,0)/v.length),mean=means.length?means.reduce((s,n)=>s+n,0)/means.length:0;
 const variance=means.length>1?means.reduce((s,n)=>s+(n-mean)**2,0)/(means.length-1):0;
 return {count:rows.length,blocks:means.length,meanNetBps:mean,lowerNetBps:means.length>1?mean-1.96*Math.sqrt(variance/means.length):-Infinity};
}
