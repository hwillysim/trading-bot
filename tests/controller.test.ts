import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/core/store.ts';
import { BotEngine } from '../src/core/engine.ts';
import { DEFAULT_STRATEGY } from '../src/core/defaults.ts';
import { StrategyController, validateStrategyPatch, TRIAL_TIMEOUT_MS } from '../src/core/controller.ts';
import { strategyProfile, detectSetup, makePlan, signalVerdict } from '../src/core/adaptive.ts';
import type { JevAssessment, MarketFeatures, SymbolRules } from '../src/shared/types.ts';

const f=(ts=Date.now()):MarketFeatures=>({symbol:'BTCUSDT',ts,bookTs:ts,last:100,bid:99.99,ask:100,bidQty:100,askQty:100,quoteVolume24h:10_000_000,priceChangePercent24h:1,return15s:.001,return1m:.002,return5m:.003,historySeconds:60,volatility1m:.0001,volatility5sBps:8,relativeVolume1m:2,buyFlow1m:1000,sellFlow1m:200,buyFlow5s:100,sellFlow5s:20,spreadBps:1,bookImbalance:.3,depthUsdt:20_000,estimatedSlippageBps:0});
const a=(ts=Date.now()):JevAssessment=>({symbol:'BTCUSDT',ts,horizonSeconds:120,model:'test',setupScore:3,setupConfidence:.6,continuationProbability:.8,reversalProbability:.1,waitProbability:.1,clearsCostsProbability:.8,exhaustionProbability:.1,forecasts:[{horizonSeconds:120,expectedGrossBps:60,clearsCostsProbability:.8,probabilities:{up_medium:1}}],latencyMs:1,inputTokens:10,outputTokens:10,costUsd:.00001,raw:{}});
const rules:SymbolRules={symbol:'BTCUSDT',status:'TRADING',baseAsset:'BTC',quoteAsset:'USDT',minNotional:5,minQty:.0001,stepSize:.0001,tickSize:.01};
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const evidence={count:30,blocks:6,meanNetBps:10,lowerNetBps:5,total:30,eligible:30};
function seed(store:Store,profile:string,n:number,start:number,net=10,eligible=true) {
 for(let i=0;i<n;i++)store.db.prepare('INSERT INTO research_outcomes(id,ts,symbol,bucket,variant,net_bps,reason,episode_id,data) VALUES(?,?,?,?,?,?,?,?,?)').run(`${profile}-${i}`,start+(Math.floor(i/6)+1)*300_000,'BTCUSDT',`v3:early_acceleration:quiet:120:p3:${profile}`,'jev_volatility',net,'test',`${profile}-${i}`,JSON.stringify({profile,entryTs:start+i,eligible}));
}

test('controller allows two small settings changes and rejects risk fields, large moves and evidence-floor reductions',()=>{
 const s={...DEFAULT_STRATEGY};
 assert.equal(validateStrategyPatch(s,{buyFlowRatio:1.5,maxSpreadBps:8})?.version,s.version+1);
 for(const patch of [{positionFraction:.03},{costBufferBps:2},{continuationProbability:.5},{buyFlowRatio:3},{maxSpreadBps:16},{minRelativeVolume:1.4,buyFlowRatio:1.5,maxSpreadBps:8},{buyFlowRatio:NaN},{targetHoldSeconds:90}])assert.equal(validateStrategyPatch(s,patch),null);
 assert.equal(validateStrategyPatch(s,{buyFlowRatio:s.buyFlowRatio}),null);
});

test('trials retain paper settings until positive covered evidence passes and roll back on negative or inconclusive results',()=>{
 const store=new Store(':memory:'),controller=new StrategyController(store),ts=Date.now();
 try {
  assert.ok(controller.propose(DEFAULT_STRATEGY,{buyFlowRatio:1.5},'Test stronger flow',ts));
  assert.equal(controller.check({...evidence,count:29},ts+1000),null);assert.ok(controller.state.trial);
  const promoted=controller.check(evidence,ts+2000);assert.equal(promoted?.buyFlowRatio,1.5);assert.equal(controller.state.trial,null);
  assert.ok(controller.propose(DEFAULT_STRATEGY,{maxSpreadBps:8},'Test narrower spread',ts));
  assert.equal(controller.check({...evidence,count:20,lowerNetBps:-1},ts+1000),null);assert.equal(controller.state.lastAction,'rolled_back');
  controller.propose(DEFAULT_STRATEGY,{minRelativeVolume:1.4},'Sparse trial',ts);
  controller.check({...evidence,count:0,blocks:0,lowerNetBps:-Infinity},ts+TRIAL_TIMEOUT_MS);
  assert.equal(controller.state.trial,null);assert.equal(controller.state.lastAction,'rolled_back');
 }finally{store.close();}
});

test('research evidence separates profiles, eligibility, entry time and missing quotes',()=>{
 const store=new Store(':memory:'),engine=new BotEngine(store,null,null),ts=Date.now()-10_000_000,profile=strategyProfile(engine.strategy);
 try {
  seed(store,profile,30,ts);seed(store,'other',30,ts,1000);
  seed(store,'ineligible',30,ts,1000,false);
  assert.equal(engine.research.profileEvidence(profile,ts).count,30);
  assert.equal(engine.research.profileEvidence(profile,ts+1000).count,0);
  assert.equal(engine.research.profileEvidence('ineligible',ts).count,0);
  const row=store.db.prepare('UPDATE research_outcomes SET net_bps=NULL WHERE id=?');row.run(`${profile}-0`);
  assert.equal(engine.research.profileEvidence(profile,ts).count,29);
 }finally{store.close();}
});

test('Luna starts a shadow trial, cannot place an order and waits for new outcomes before another review',async()=>{
 const store=new Store(':memory:'),ts=Date.now(),calls:any[]=[],engine=new BotEngine(store,null,{review:async input=>{calls.push(input);return {action:'patch',patch:{buyFlowRatio:1.5},reason:'Stronger flow merits a shadow test.',summary:'Test stronger flow.',inputTokens:10,outputTokens:10,costUsd:.00001,model:'gpt-6-luna'};}});
 try {
  engine.setRules([rules]);const s={...engine.strategy};seed(store,strategyProfile(s),20,ts-10_000_000,-30,false);
  await engine.reviewIfDue(ts);assert.equal(calls.length,1);assert.equal(engine.controller.state.trial?.candidate.buyFlowRatio,1.5);
  assert.deepEqual(engine.strategy,s);assert.equal(store.trades().length,0);assert.ok(JSON.stringify(calls[0]).length<6000);
  await engine.reviewIfDue(ts+1000000);assert.equal(calls.length,1);
  engine.control('disable-strategy-adjustments');assert.equal(engine.controller.state.trial,null);assert.equal(engine.controller.state.enabled,false);
 }finally{store.close();}
});

test('closed JEV shadow legs stop receiving calls even while other comparison legs remain open',async()=>{
 const store=new Store(':memory:'),ts=Date.now();let calls=0;
 const engine=new BotEngine(store,{assess:async()=>{calls++;return a(ts);}},null);
 try {
  engine.setRules([rules]);engine.onTick(f(ts));engine.onFeatures(f(ts));engine.research.open(f(ts),a(ts),'early_acceleration',f(ts),ts,20,engine.strategy);
  engine.scan(ts);await flush();assert.equal(calls,1);
  engine.research.tick(f(ts+1000),{...a(ts+1000),exhaustionProbability:.9},ts+1000);
  assert.equal(engine.research.managedSymbols.length,0);assert.equal(engine.research.activeCount,1);
  engine.onFeatures(f(ts+2000));engine.scan(ts+2000);await flush();assert.equal(calls,1);
 }finally{store.close();}
});

test('quiet shadow positions avoid polling every three seconds while real holdings retain fast reassessment',async()=>{
 const store=new Store(':memory:'),ts=Date.now();let calls=0;
 const engine=new BotEngine(store,{assess:async features=>{calls++;return a(features.ts);}},null);
 try {
  engine.setRules([rules]);engine.onTick(f(ts));engine.onFeatures(f(ts));engine.research.open(f(ts),a(ts),'early_acceleration',f(ts),ts,20,engine.strategy);
  engine.scan(ts);await flush();assert.equal(calls,1);
  engine.onFeatures(f(ts+4000));engine.scan(ts+4000);await flush();assert.equal(calls,1);
  engine.onFeatures({...f(ts+11000),bid:100.05,ask:100.06});engine.scan(ts+11000);await flush();assert.equal(calls,2);
  engine.control('set-caps',{floatUsdt:1000,maxOrderUsdt:20});engine.paper.startWithBalance(1000);assert.ok(engine.paper.buy(f(ts+12000),20,'test'));
  engine.onFeatures(f(ts+15000));engine.scan(ts+15000);await flush();assert.equal(calls,3);
 }finally{store.close();}
});

test('strategy settings drive setup, forecast horizon, continuation and future volatility plans',()=>{
 const feature=f(),assessment=a(),strategy={...DEFAULT_STRATEGY,buyFlowRatio:2,volatilityMultiple:4,continuationProbability:.85};
 assert.equal(detectSetup({...feature,buyFlow5s:30,sellFlow5s:20},strategy),null);
 assert.equal(signalVerdict(assessment,feature,evidence,3,strategy),'jev_signal_weak');
 assert.equal(makePlan(feature,assessment,'early_acceleration',100,feature.ts,300,strategy).dipBps,32);
 assert.notEqual(strategyProfile(strategy),strategyProfile(DEFAULT_STRATEGY));
});

test('trial promotion waits while paused, persists its strategy and leaves all risk caps and balances intact',()=>{
 const store=new Store(':memory:'),engine=new BotEngine(store,null,null),now=Date.now(),start=now-25*60_000;
 try {
  const caps={...engine.caps},balance=engine.paper.state.usdt;
  engine.controller.propose(engine.strategy,{buyFlowRatio:1.5},'Test flow',start);
  const profile=engine.controller.state.trial!.profile;
  seed(store,profile,30,start);
  engine.control('pause');engine.scan(now);assert.ok(engine.controller.state.trial);assert.equal(engine.strategy.buyFlowRatio,1.3);
  engine.control('resume');engine.scan(now);assert.equal(engine.controller.state.trial,null);assert.equal(engine.strategy.buyFlowRatio,1.5);
  assert.deepEqual(engine.caps,caps);assert.equal(engine.paper.state.usdt,balance);assert.equal(store.trades().length,0);
  assert.equal(new BotEngine(store,null,null).strategy.buyFlowRatio,1.5);
 }finally{store.close();}
});

test('Luna cannot change volatility settings without supported paired stop evidence',async()=>{
 const store=new Store(':memory:'),engine=new BotEngine(store,null,{review:async()=>({action:'patch',patch:{volatilityMultiple:3},reason:'Wider stops',summary:'Test wider stops.',inputTokens:1,outputTokens:1,costUsd:0,model:'test'})}),ts=Date.now();
 try {
  engine.setRules([rules]);seed(store,strategyProfile(engine.strategy),20,ts-10_000_000,-30,false);
  await engine.reviewIfDue(ts);assert.equal(engine.controller.state.trial,null);assert.equal(engine.strategy.volatilityMultiple,2.5);
 }finally{store.close();}
});

test('the controller remembers failed profiles and prevents repeated trials for an hour',()=>{
 const store=new Store(':memory:'),controller=new StrategyController(store),ts=Date.now();
 try {
  controller.propose(DEFAULT_STRATEGY,{buyFlowRatio:1.5},'Test',ts);
  controller.check({...evidence,count:20,lowerNetBps:-2},ts+1000);
  assert.equal(controller.state.history.length,1);
  assert.equal(controller.propose(DEFAULT_STRATEGY,{buyFlowRatio:1.5},'Repeat',ts+2000),false);
  assert.equal(new StrategyController(store).state.history[0]!.outcome,'rolled_back');
  assert.equal(controller.propose(DEFAULT_STRATEGY,{buyFlowRatio:1.5},'Later',ts+3602000),true);
 }finally{store.close();}
});
