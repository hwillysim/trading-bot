import { randomUUID } from 'node:crypto';
import type { JevAssessment, MarketFeatures, MarketTick } from '../shared/types.ts';
import { Store } from './store.ts';
import { MANAGEMENT, advanceStop, calibrationBucket, makePlan, exitReason, selectForecast, type Calibration, type PositionPlan, type Setup } from './adaptive.ts';
import { PAPER_SLIPPAGE_BPS, TAKER_FEE_BPS } from './defaults.ts';

type Variant='fixed_time'|'volatility'|'jev_volatility'|'passive_fixed';
type Leg={variant:Variant;entryPrice:number;entryTs:number;peakBid:number;plan:PositionPlan;closed:boolean;queueAhead?:number;filled?:boolean};
type Episode={id:string;symbol:string;ts:number;bucket:string;horizonSeconds:number;slipBps:number;legs:Leg[];calibrated:boolean;calibrationDueTs:number;lastTickTs:number};
export class ResearchTracker {
  private episodes:Episode[];
  private lastSample:Record<string,number>;
  private lastSaved=0;
  private dirty=false;
  private store:Store;
  constructor(store:Store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS research_outcomes(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,symbol TEXT NOT NULL,bucket TEXT NOT NULL,variant TEXT NOT NULL,net_bps REAL,reason TEXT NOT NULL,episode_id TEXT NOT NULL); CREATE INDEX IF NOT EXISTS research_bucket_ts ON research_outcomes(bucket,ts);`);
    this.episodes=store.get('researchEpisodesV2',[]);this.lastSample=store.get('researchLastSampleV2',{});
  }
  get symbols() {return this.episodes.map(e=>e.symbol);}
  get activeCount() {return this.episodes.length;}
  open(f:MarketFeatures,a:JevAssessment,setup:Setup,tick:MarketTick,now:number,orderUsdt=20) {
    if(this.episodes.some(e=>e.symbol===f.symbol)||now-(this.lastSample[f.symbol]??0)<300_000) return;
    const forecast=selectForecast(a,f);if(!forecast)return;
    const slipBps=PAPER_SLIPPAGE_BPS+Math.max(0,f.estimatedSlippageBps);
    const entryPrice=tick.ask*(1+slipBps/10_000),id=randomUUID();
    const legs:Leg[]=['fixed_time','volatility','jev_volatility','passive_fixed'].map(variant=>({variant:variant as Variant,entryPrice:variant==='passive_fixed'?tick.bid:entryPrice,entryTs:now,peakBid:tick.bid,plan:makePlan(f,a,setup,entryPrice,now,300),closed:false,filled:variant!=='passive_fixed',queueAhead:variant==='passive_fixed'?tick.bidQty+orderUsdt/tick.bid:undefined}));
    this.episodes.push({id,symbol:f.symbol,ts:now,bucket:calibrationBucket(setup,a,f,forecast.horizonSeconds),horizonSeconds:forecast.horizonSeconds,slipBps,legs,calibrated:false,calibrationDueTs:now+forecast.horizonSeconds*1000,lastTickTs:now});
    this.lastSample[f.symbol]=now;this.save(true);
  }
  calibration(bucket:string,now:number):Calibration {
    const rows=this.store.db.prepare(`SELECT ts,net_bps net FROM research_outcomes WHERE bucket=? AND variant='jev_volatility' AND net_bps IS NOT NULL AND ts<? AND ts>=? ORDER BY ts DESC LIMIT 500`).all(bucket,now,now-24*60*60_000) as {ts:number;net:number}[];
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
        this.record(e,'calibration',near?this.net(e.legs[0]!.entryPrice,tick.bid,e.slipBps):null,near?'horizon':'missing_quote',tick.ts);
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
        const reason=leg.variant==='fixed_time'||leg.variant==='passive_fixed'?(tick.bid<=leg.entryPrice*(1-MANAGEMENT.hardLossBps/10_000)?'protective_stop':tick.ts-leg.entryTs>=e.horizonSeconds*1000?'fixed_time_exit':null):exitReason(leg.plan,tick,leg.entryPrice,a,receivedTs,leg.variant==='jev_volatility');
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
    const e=this.episodes.find(e=>e.symbol===symbol),leg=e?.legs.find(l=>l.variant==='jev_volatility'&&!l.closed);
    return leg?{ageSeconds:(now-leg.entryTs)/1000,netPnlBps:this.net(leg.entryPrice,tick.bid,e!.slipBps),drawdownBps:(1-tick.bid/leg.peakBid)*10_000,remainingSeconds:Math.max(0,(leg.plan.deadlineTs-now)/1000)}:undefined;
  }
  summary() {
    return this.store.db.prepare(`SELECT variant,COUNT(*) completed,SUM(net_bps IS NOT NULL) covered,AVG(net_bps) meanNetBps,SUM(net_bps>0) wins FROM research_outcomes WHERE bucket LIKE 'v2:%' GROUP BY variant`).all();
  }
  private net(entry:number,bid:number,slip:number){return ((bid*(1-slip/10_000)*(1-TAKER_FEE_BPS/10_000))/(entry*(1+TAKER_FEE_BPS/10_000))-1)*10_000;}
  private record(e:Episode,variant:string,net:number|null,reason:string,ts:number){this.store.db.prepare('INSERT OR IGNORE INTO research_outcomes VALUES(?,?,?,?,?,?,?,?)').run(`${e.id}:${variant}`,ts,e.symbol,e.bucket,variant,net,reason,e.id);}
  flush(now=Date.now()){if(this.dirty&&now-this.lastSaved>=1000)this.save(true);}
  private save(force=false){this.dirty=true;if(!force&&Date.now()-this.lastSaved<1000)return;this.store.set('researchEpisodesV2',this.episodes);this.store.set('researchLastSampleV2',this.lastSample);this.lastSaved=Date.now();this.dirty=false;}
}
