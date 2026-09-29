import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { JevAssessment, MarketFeatures, SymbolRules } from '../src/shared/types.ts';
import { DEFAULT_CAPS, DEFAULT_STRATEGY } from '../src/core/defaults.ts';
import { BotEngine, edgeStats } from '../src/core/engine.ts';
import { PaperBroker } from '../src/core/paper.ts';
import { judgeEntry, validateReviewPatch } from '../src/core/policy.ts';
import { Store } from '../src/core/store.ts';

const now=Date.now();
const features:MarketFeatures={symbol:'BTCUSDT',ts:now,last:100,bid:99.99,ask:100,bidQty:100,askQty:100,bookTs:now,quoteVolume24h:2_000_000,priceChangePercent24h:1,return15s:0.01,return1m:0.02,return5m:0.03,volatility1m:0.001,relativeVolume1m:2,buyFlow1m:1000,sellFlow1m:500,spreadBps:1,bookImbalance:0,depthUsdt:20_000,estimatedSlippageBps:0.5};
const rules:SymbolRules={symbol:'BTCUSDT',status:'TRADING',baseAsset:'BTC',quoteAsset:'USDT',minNotional:5,minQty:0.00001,stepSize:0.00001,tickSize:0.01};
const assessment:JevAssessment={symbol:'BTCUSDT',ts:now,horizonSeconds:120,model:'jev-1.13.0',continuationProbability:0.9,reversalProbability:0.1,waitProbability:0.1,setupScore:3.5,setupConfidence:0.92,latencyMs:100,inputTokens:500,outputTokens:50,costUsd:0.000021,raw:{}};

test('live entry obeys exchange minimum while paper accepts small orders',()=>{
  const input={features,assessment,rules,strategy:{...DEFAULT_STRATEGY},caps:{...DEFAULT_CAPS},availableUsdt:10,openPositions:0,dailyRealisedLossUsdt:0,apiSpendUsd:0,edge:{count:50,meanNetBps:50,lowerNetBps:30},now,paused:false};
  assert.equal(judgeEntry({...input,live:true}).reason,'below_exchange_minimum');
  assert.equal(judgeEntry({...input,live:false}).allowed,true);
});

test('entry refuses stale data, unproven edge and loss stop',()=>{
  const input={features,assessment,rules,strategy:{...DEFAULT_STRATEGY},caps:{...DEFAULT_CAPS},availableUsdt:10,openPositions:0,dailyRealisedLossUsdt:0,apiSpendUsd:0,edge:{count:0,meanNetBps:0,lowerNetBps:-Infinity},now,paused:false,live:false};
  assert.equal(judgeEntry(input).reason,'unproven_net_edge');
  assert.equal(judgeEntry({...input,features:{...features,ts:now-4_000}}).reason,'stale_data');
  assert.equal(judgeEntry({...input,dailyRealisedLossUsdt:1}).reason,'daily_loss_stop');
});

test('exploratory entry uses its separate JEV gate while retaining safety checks',()=>{
  const input={features,assessment:{...assessment,setupScore:2,setupConfidence:.5,continuationProbability:.5,waitProbability:.5},rules,strategy:{...DEFAULT_STRATEGY},caps:{...DEFAULT_CAPS,maxOrderUsdt:5,floatUsdt:100},availableUsdt:100,openPositions:0,dailyRealisedLossUsdt:0,apiSpendUsd:0,edge:{count:0,meanNetBps:0,lowerNetBps:-Infinity},now,paused:false,live:false};
  const result=judgeEntry({...input,exploratory:true});
  assert.equal(result.reason,'exploratory_approved');
  assert.equal(result.orderUsdt,2);
  assert.deepEqual(judgeEntry({...input,assessment:{...input.assessment,setupConfidence:.49},exploratory:true}).gateFailures,['setupConfidence']);
  assert.equal(judgeEntry({...input,exploratory:true,dailyRealisedLossUsdt:1}).reason,'daily_loss_stop');
});

test('review patch cannot change hard limits or jump thresholds',()=>{
  assert.equal(validateReviewPatch(DEFAULT_STRATEGY,{entryConfidence:0.99},['BTCUSDT']),null);
  assert.equal(validateReviewPatch(DEFAULT_STRATEGY,{maxHoldSeconds:999} as never,['BTCUSDT']),null);
  assert.equal(validateReviewPatch(DEFAULT_STRATEGY,{selectedSymbols:['UNKNOWN']},['BTCUSDT']),null);
  assert.equal(validateReviewPatch(DEFAULT_STRATEGY,{selectedSymbols:['BTCUSDT']},['BTCUSDT'])?.version,2);
});

test('paper ledger charges both fees and reports loss',()=>{
  const store=new Store(':memory:');
  try {
    const paper=new PaperBroker(store,{...DEFAULT_CAPS});
    assert.ok(paper.buy(features,0.2,'test'));
    assert.ok(paper.sell({...features,ts:now+1_000,bid:99},'test'));
    assert.ok(paper.state.usdt<10);
    assert.ok(paper.state.feesUsdt>0);
    assert.ok(paper.state.dailyRealisedLossUsdt>0);
    assert.equal(store.trades().length,2);
  } finally {store.close();}
});

test('paper limit orders rest, partially fill against visible ask quantity and release unfilled reserve on expiry',()=>{
  const store=new Store(':memory:');
  try {
    const paper=new PaperBroker(store,{...DEFAULT_CAPS});
    const order=paper.submitBuy(features,0.2,'limit-test');
    assert.ok(order);
    assert.equal(paper.openOrders.length,1);
    assert.equal(paper.portfolio(new Map()).portfolioUsdt,10);
    assert.equal(paper.portfolio(new Map()).reservedUsdt,0.2);
    assert.deepEqual(paper.processTick({...features,ts:now+1_000,ask:100.1}),[]);
    assert.equal(paper.state.position,null);
    const first=paper.processTick({...features,ts:now+2_000,ask:order.limitPrice,askQty:order.quantity/2});
    assert.equal(first.length,1);
    assert.equal(paper.openOrders[0].status,'PARTIALLY_FILLED');
    const partialPosition=paper.state.position as {quantity:number}|null;
    assert.ok(partialPosition && partialPosition.quantity>0);
    paper.processTick({...features,ts:now+33_000,ask:order.limitPrice});
    assert.equal(paper.openOrders.length,0);
    assert.ok(paper.state.usdt>9.8);
    assert.ok(paper.state.feesUsdt>0);
  } finally {store.close();}
});

test('paper broker honours the configured maximum above the former hidden 0.20 USDT cap',()=>{
  const store=new Store(':memory:');
  try {
    const paper=new PaperBroker(store,{...DEFAULT_CAPS,floatUsdt:100,maxOrderUsdt:5});
    assert.equal(paper.submitBuy(features,5,'exploratory_paper')?.reservedUsdt,5);
    assert.equal(paper.submitBuy({...features,symbol:'ETHUSDT'},5.01,'exploratory_paper'),null);
  } finally {store.close();}
});

test('stale books cannot fill and an exit cancels the remaining entry quantity',()=>{
  const store=new Store(':memory:');
  try {
    const paper=new PaperBroker(store,{...DEFAULT_CAPS});
    const order=paper.submitBuy(features,0.2,'limit-test');
    assert.ok(order);
    assert.deepEqual(paper.processTick({...features,ts:now+4_000,bookTs:now,ask:order.limitPrice}),[]);
    paper.processTick({...features,ts:now+5_000,bookTs:now+5_000,ask:order.limitPrice,askQty:order.quantity/2});
    assert.equal(paper.openOrders.length,1);
    assert.ok(paper.sell({...features,ts:now+6_000,bid:order.limitPrice},'emergency'));
    assert.equal(paper.openOrders.length,0);
    assert.equal(paper.state.position,null);
    assert.ok(paper.state.usdt>9.99);
  } finally {store.close();}
});

test('edge estimate uses a lower confidence bound',()=>{
  const edge=edgeStats([20,30,40,50]);
  assert.equal(edge.count,4);
  assert.equal(edge.meanNetBps,35);
  assert.ok(edge.lowerNetBps<35);
});

test('emergency stop prevents resumption and sells on a fresh tick',()=>{
  const store=new Store(':memory:');
  try {
    const engine=new BotEngine(store,null,null);
    engine.paper.buy(features,0.2,'test');
    engine.onTick(features);
    engine.control('stop');
    assert.equal(engine.stopped,true);
    assert.equal(engine.paper.state.position,null);
    assert.throws(()=>engine.control('resume'));
  } finally {store.close();}
});

test('portfolio history keeps the latest point in each chart interval',()=>{
  const store=new Store(':memory:');
  try {
    store.portfolioPoint(1_000,10);
    store.portfolioPoint(1_500,10.1);
    store.portfolioPoint(2_200,10.2);
    assert.deepEqual(store.portfolioHistory(0,1_000),[{ts:1_500,valueUsdt:10.1},{ts:2_200,valueUsdt:10.2}]);
    assert.deepEqual(store.portfolioHistory(2_000,1_000),[{ts:2_200,valueUsdt:10.2}]);
  } finally {store.close();}
});

test('portfolio history keeps separate paper run balances',()=>{
  const store=new Store(':memory:');
  try {
    store.portfolioPoint(1_000,10);
    const runId=store.startPortfolioRun(2_000);
    store.portfolioPoint(2_001,1_000,runId);
    store.portfolioPoint(3_000,1_001,runId);
    assert.equal(store.currentPortfolioRunId(),runId);
    assert.deepEqual(store.portfolioHistory(0,1,500,runId),[{ts:2_001,valueUsdt:1_000},{ts:3_000,valueUsdt:1_001}]);
    assert.equal(store.oldestPortfolioTs(runId),2_001);
  } finally {store.close();}
});

test('pending hypothetical outcomes survive restart and never create paper fills',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pending-outcome-')),path=join(dir,'bot.sqlite');
  let store=new Store(path);
  try {
    store.addPendingOutcome({id:'outcome-1',decisionTs:now,dueTs:now+120_000,symbol:'BTCUSDT',bucket:'up:low:tight:120',entryAsk:100,horizonSeconds:120});
    store.close();
    store=new Store(path);
    const engine=new BotEngine(store,null,null);
    engine.onTick({...features,ts:now+120_000,bid:101,ask:101,bookTs:now+120_000});
    assert.equal(store.pendingOutcomes().length,0);
    assert.equal(store.labelValues('up:low:tight:120','BTCUSDT').length,1);
    assert.equal(store.trades().length,0);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a rejected exploratory JEV assessment still queues its hypothetical outcome',async()=>{
  const store=new Store(':memory:');
  try {
    const lowAssessment={...assessment,setupScore:2,setupConfidence:.4,continuationProbability:.4,waitProbability:.3};
    const engine=new BotEngine(store,{assess:async()=>lowAssessment},null);
    engine.setRules([rules]);
    engine.setFeedConnected(true);
    engine.onTick(features);
    engine.onFeatures(features);
    engine.scan(now);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(store.pendingOutcomes().length,1);
    const decision=store.db.prepare('SELECT verdict,data FROM decisions ORDER BY id DESC LIMIT 1').get() as {verdict:string;data:string};
    assert.equal(decision.verdict,'exploratory_jev_threshold');
    assert.deepEqual(JSON.parse(decision.data).exploratoryGateFailures,['setupConfidence','continuationProbability']);
    assert.equal(store.trades().length,0);
  } finally {store.close();}
});

test('pausing cancels a pending paper order and restores reserved cash',()=>{
  const store=new Store(':memory:');
  try {
    const engine=new BotEngine(store,null,null);
    const order=engine.paper.submitBuy(features,0.2,'test');
    assert.ok(order);
    assert.equal(engine.paper.openOrders.length,1);
    engine.control('pause');
    assert.equal(engine.paper.openOrders.length,0);
    assert.equal(engine.paper.state.usdt,10);
  } finally {store.close();}
});

test('reviewer patch is ignored without a measured performance problem',async()=>{
  const store=new Store(':memory:');
  try {
    const reviewer={review:async()=>({action:'patch' as const,reason:'Recent performance is negative by 20 basis points.',summary:'Reduce exposure until results improve.',patch:{positionFraction:0.019},inputTokens:10,outputTokens:10,costUsd:0.00001,model:'gpt-6-luna'})};
    const engine=new BotEngine(store,null,reviewer);
    engine.setRules([rules]);
    await engine.reviewIfDue(Date.now());
    assert.equal(engine.strategy.version,1);
    assert.equal(store.reviews(1).length,1);
  } finally {store.close();}
});

test('liquidate sells a paper holding at a fresh bid and pauses entries',()=>{
  const store=new Store(':memory:');
  try {
    const engine=new BotEngine(store,null,null);
    engine.paper.buy(features,0.2,'test');
    engine.onTick(features);
    engine.control('liquidate');
    assert.equal(engine.paper.state.position,null);
    assert.equal(engine.paused,true);
    assert.equal(engine.liquidationPending,false);
    assert.equal(store.trades(1)[0]?.reason,'manual_liquidation');
  } finally {store.close();}
});

test('liquidate waits for a fresh bid and blocks resume until sold',()=>{
  const store=new Store(':memory:');
  try {
    const engine=new BotEngine(store,null,null);
    engine.paper.buy(features,0.2,'test');
    engine.onTick({...features,bookTs:now-10_000});
    engine.control('liquidate');
    assert.equal(engine.liquidationPending,true);
    assert.ok(engine.paper.state.position);
    assert.throws(()=>engine.control('resume'));
    engine.onTick({...features,ts:Date.now(),bookTs:Date.now()});
    assert.equal(engine.paper.state.position,null);
    assert.equal(engine.liquidationPending,false);
    assert.equal(engine.paused,true);
  } finally {store.close();}
});
