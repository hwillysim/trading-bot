import assert from 'node:assert/strict';
import test from 'node:test';
import type { JevAssessment, MarketFeatures, SymbolRules } from '../src/shared/types.ts';
import { BotEngine } from '../src/core/engine.ts';
import { Store } from '../src/core/store.ts';
import { MANAGEMENT, advanceStop, calibrationBucket, exitReason, makePlan, signalVerdict } from '../src/core/adaptive.ts';
import { ResearchTracker } from '../src/core/research.ts';
import { PaperBroker } from '../src/core/paper.ts';
import { DEFAULT_CAPS } from '../src/core/defaults.ts';

const feature=(ts=Date.now()):MarketFeatures=>({symbol:'BTCUSDT',ts,bookTs:ts,last:100,bid:99.99,ask:100,bidQty:100,askQty:100,quoteVolume24h:10_000_000,priceChangePercent24h:1,return15s:.001,return1m:.002,return5m:.003,historySeconds:60,volatility1m:.0001,volatility5sBps:8,relativeVolume1m:2,buyFlow1m:1000,sellFlow1m:200,buyFlow5s:100,sellFlow5s:20,spreadBps:1,bookImbalance:.3,depthUsdt:20_000,estimatedSlippageBps:0});
const assessment=(ts=Date.now()):JevAssessment=>({symbol:'BTCUSDT',ts,horizonSeconds:120,model:'test',setupScore:3,setupConfidence:.6,continuationProbability:.8,reversalProbability:.1,waitProbability:.1,clearsCostsProbability:.8,exhaustionProbability:.1,forecasts:[{horizonSeconds:120,expectedGrossBps:60,clearsCostsProbability:.8,probabilities:{up_medium:1}},{horizonSeconds:30,expectedGrossBps:10,clearsCostsProbability:.5,probabilities:{up_small:1}}],latencyMs:1,inputTokens:10,outputTokens:10,costUsd:.00001,raw:{}});
const rules:SymbolRules={symbol:'BTCUSDT',status:'TRADING',baseAsset:'BTC',quoteAsset:'USDT',minNotional:5,minQty:.0001,stepSize:.0001,tickSize:.01};
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

test('entries need both a cost-clearing forecast and prior measured net edge',()=>{
 const f=feature(),a=assessment(),edge={count:40,blocks:6,meanNetBps:8,lowerNetBps:4};
 assert.equal(signalVerdict(a,f,edge),'approved');
 assert.equal(signalVerdict(a,f,{...edge,count:0}),'calibration_pending');
 assert.equal(signalVerdict(a,f,{...edge,lowerNetBps:-1}),'negative_calibrated_edge');
 assert.equal(signalVerdict({...a,forecasts:[{horizonSeconds:120,expectedGrossBps:20,probabilities:{flat:1}}]},f,edge),'forecast_below_costs');
});

test('a normal dip is tolerated, the stop never widens and renewed optimism cannot extend the absolute deadline',()=>{
 const ts=Date.now(),f=feature(ts),a=assessment(ts),plan=makePlan(f,a,'early_acceleration',100,ts,900);
 assert.equal(plan.dipBps,20);assert.equal(plan.deadlineTs,ts+300_000);
 advanceStop(plan,101,20);const stop=plan.stopBid;
 assert.equal(exitReason(plan,{bid:100.9,ts:ts+20_000},100,assessment(ts+20_000),ts+20_000),null);
 advanceStop(plan,100.9,21);assert.equal(plan.stopBid,stop);
 assert.equal(exitReason(plan,{bid:100.7,ts:ts+21_000},100),'volatility_exit');
 assert.equal(exitReason(plan,{bid:101,ts:ts+120_000},100,assessment(ts+120_000),ts+120_000),null);
 assert.equal(plan.plannedExitTs,ts+150_000);
 assert.equal(exitReason(plan,{bid:101,ts:ts+300_000},100,assessment(ts+300_000),ts+300_000),'max_hold_exit');
});

test('stale JEV optimism cannot extend a position and pause uses the local deadline',()=>{
 const ts=Date.now(),f=feature(ts),a=assessment(ts);
 assert.equal(exitReason(makePlan(f,a,'early_acceleration',100,ts,300),{bid:100.5,ts:ts+120_000},100,a,ts),'target_hold_exit');
 assert.equal(exitReason(makePlan(f,a,'early_acceleration',100,ts,300),{bid:100.5,ts:ts+120_000},100,assessment(ts+120_000),ts+120_000,false),'target_hold_exit');
});

test('pause aborts JEV and reviewer requests, ignores late answers and prevents new calls until resume',async()=>{
 const store=new Store(':memory:');let jevCalls=0,reviewCalls=0,jevSignal:AbortSignal|undefined,reviewSignal:AbortSignal|undefined;
 let finishJev!:(a:JevAssessment)=>void,finishReview!:(a:any)=>void;
 const engine=new BotEngine(store,{assess:async(_f,_h,_c,signal)=>{jevCalls++;jevSignal=signal;return new Promise(resolve=>finishJev=resolve);}}, {review:async(_input,signal)=>{reviewCalls++;reviewSignal=signal;return new Promise(resolve=>finishReview=resolve);}});
 try {
  engine.setRules([rules]);const f=feature();engine.onTick(f);engine.onFeatures(f);engine.scan();const reviewing=engine.reviewIfDue();
  assert.equal(jevCalls,1);assert.equal(reviewCalls,1);
  engine.control('pause');assert.equal(jevSignal?.aborted,true);assert.equal(reviewSignal?.aborted,true);
  engine.scan(Date.now()+4_000);await engine.reviewIfDue(Date.now()+400_000);assert.equal(jevCalls,1);assert.equal(reviewCalls,1);
  finishJev(assessment());finishReview({action:'no_change',reason:'Late',summary:'Late',inputTokens:1,outputTokens:1,costUsd:0,model:'test'});await reviewing;await flush();
  assert.equal(engine.paper.state.positions.length,0);assert.equal(engine.research.activeCount,0);assert.equal(store.reviews().length,0);
  engine.control('resume');assert.equal(engine.paused,false);
 }finally{store.close();}
});

test('kill cancels buys, aborts providers, waits for stale holdings and restart resumes the same ledger',async()=>{
 const store=new Store(':memory:');let signal:AbortSignal|undefined,finish!:(a:JevAssessment)=>void;
 const engine=new BotEngine(store,{assess:async(_f,_h,_c,s)=>{signal=s;return new Promise(resolve=>finish=resolve);}},null);
 try {
  engine.control('set-caps',{floatUsdt:100,maxOrderUsdt:5,maxPositions:12});engine.setRules([rules]);
  const f=feature();engine.onTick(f);engine.onFeatures(f);engine.scan();assert.ok(signal);
  assert.ok(engine.paper.buy(f,.2,'test'));assert.ok(engine.paper.buy({...f,symbol:'ETHUSDT'},.2,'test'));
  assert.ok(engine.paper.submitBuy({...f,symbol:'SOLUSDT'},.2,'test'));
  engine.latest.set('ETHUSDT',{...f,symbol:'ETHUSDT',bookTs:Date.now()-10_000});
  const before=engine.paper.state.usdt;engine.control('stop');
  assert.equal(signal!.aborted,true);assert.equal(engine.paper.openOrders.length,0);assert.equal(engine.paper.state.positions.length,1);
  assert.equal(engine.paused,true);assert.throws(()=>engine.control('restart'),/remaining/);assert.throws(()=>engine.control('resume'));
  finish(assessment());await flush();assert.equal(engine.research.activeCount,0);
  engine.onTick({...feature(),symbol:'ETHUSDT'});assert.equal(engine.paper.state.positions.length,0);
  const balance=engine.paper.state.usdt;assert.ok(balance>before);
  engine.control('restart');assert.equal(engine.paused,false);assert.equal(engine.stopped,false);assert.equal(engine.paper.state.usdt,balance);
 }finally{store.close();}
});

test('more than five distinct holdings are allowed while cash and the configured limit still bind',()=>{
 const store=new Store(':memory:');try{
  const engine=new BotEngine(store,null,null);engine.control('set-caps',{maxPositions:12});
  for(let i=0;i<12;i++)assert.ok(engine.paper.buy({...feature(),symbol:`T${i}USDT`},.2,'test'));
  assert.equal(engine.paper.state.positions.length,12);assert.equal(engine.paper.buy({...feature(),symbol:'EXTRAUSDT'},.2,'test'),null);
  assert.throws(()=>engine.control('set-caps',{maxPositions:51}));
 }finally{store.close();}
});

test('shadow comparisons are paired and do not affect the actual paper balance',()=>{
 const store=new Store(':memory:');try{
  const research=new ResearchTracker(store),paper=new PaperBroker(store,{...DEFAULT_CAPS}),ts=Date.now(),f=feature(ts),a=assessment(ts);
  research.open(f,a,'early_acceleration',f,ts);research.open(f,a,'early_acceleration',f,ts+1);
  assert.equal(research.activeCount,1);
  for(let elapsed=1000;elapsed<=120_000;elapsed+=1000)research.tick({...f,ts:ts+elapsed,bookTs:ts+elapsed,bid:100+elapsed/120_000,ask:100.01+elapsed/120_000});
  const rows=research.summary() as Array<{variant:string;covered:number;meanNetBps:number}>;
  assert.equal(rows.find(r=>r.variant==='calibration')?.covered,1);assert.ok(rows.find(r=>r.variant==='fixed_time')!.meanNetBps>0);
  assert.equal(paper.state.usdt,10);assert.equal(store.trades().length,0);
  const bucket=calibrationBucket('early_acceleration',a,f,120);assert.equal(research.calibration(bucket,ts+120_001).count,1);
 }finally{store.close();}
});

test('an overdue local deadline exits on a fresh quote even when no new quote event arrives',()=>{
 const store=new Store(':memory:');try{
  const engine=new BotEngine(store,null,null),ts=Date.now(),f=feature(ts);
  engine.paper.buy(f,.2,'test');engine.latest.set(f.symbol,f);
  // Maintenance has a fresh quote after the original entry deadline.
  engine.paper.state.positions[0]!.entryTs=ts-301_000;engine.scan(ts);
  assert.equal(engine.paper.state.positions.length,0);assert.equal(store.trades(1)[0]!.reason,'max_hold_exit');
 }finally{store.close();}
});

test('book execution charges actual size and supports partial exits without reusing the same liquidity',()=>{
 const store=new Store(':memory:');try{
  const paper=new PaperBroker(store,{...DEFAULT_CAPS,floatUsdt:100,maxOrderUsdt:20}),f=feature(),ts=f.ts;
  const buy=paper.buy({...f,depthTs:ts,asks:[[100,.05],[101,10]]},20,'test',0,rules);assert.ok(buy&&buy.price>100.02);
  const position=paper.position(f.symbol)!;const q=position.quantity;
  const sellTick={...f,ts:ts+1,bookTs:ts+1,depthTs:ts+1,bookUpdateId:2,bids:[[100,q/2]] as [number,number][]};
  assert.ok(paper.sell(sellTick,'test'));assert.ok(paper.position(f.symbol));assert.equal(paper.sell(sellTick,'test'),null);
  assert.ok(paper.sell({...sellTick,bookUpdateId:3},'test'));assert.equal(paper.position(f.symbol),undefined);
  const ledger=store.reviewEvidence(ts-1,ts+2);assert.ok(Math.abs(ledger.trading.netPnlUsdt-paper.state.realisedPnlUsdt)<1e-10);
 }finally{store.close();}
});

test('an entry executes only after earlier calibration blocks support its net return',async()=>{
 const store=new Store(':memory:');try{
  const ts=Date.now(),f=feature(ts),a=assessment(ts),engine=new BotEngine(store,{assess:async()=>a},null);
  engine.control('set-caps',{floatUsdt:1000,maxOrderUsdt:20});engine.setRules([rules]);engine.onTick(f);engine.onFeatures(f);
  const bucket=calibrationBucket('early_acceleration',a,f,120);
  for(let i=0;i<40;i++)store.db.prepare('INSERT INTO research_outcomes VALUES(?,?,?,?,?,?,?,?)').run(`seed-${i}`,ts-(1+Math.floor(i/5))*300_000,f.symbol,bucket,'jev_volatility',10,'horizon',`seed-${i}`);
  engine.scan(ts);await flush();assert.equal(engine.paper.state.positions.length,1);assert.equal(engine.approved,1);
  assert.ok(engine.state().positionPlans[f.symbol]);assert.equal(store.trades(1)[0]!.reason,'early_acceleration');
 }finally{store.close();}
});

test('missing market intervals do not become profitable shadow evidence',()=>{
 const store=new Store(':memory:');try{
  const tracker=new ResearchTracker(store),ts=Date.now(),f=feature(ts);
  tracker.open(f,assessment(ts),'early_acceleration',f,ts);
  tracker.tick({...f,ts:ts+120_000,bookTs:ts+120_000,bid:110,ask:110.01});
  const rows=tracker.summary() as Array<{covered:number;meanNetBps:number|null}>;
  assert.ok(rows.length>0);assert.ok(rows.every(r=>r.covered===0&&r.meanNetBps===null));
  assert.equal(tracker.activeCount,0);
 }finally{store.close();}
});
