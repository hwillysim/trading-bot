import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/core/store.ts';

test('review evidence returns bounded aggregates without raw snapshots', () => {
  const dir=mkdtempSync(join(tmpdir(),'review-evidence-'));
  const store=new Store(join(dir,'fixture.sqlite'));
  try {
    const since=1_000_000, until=since+300_000;
    store.snapshot(since+2,'BTCUSDT',{secret:'must not appear'});
    store.decision(since+10,'BTCUSDT','jev_threshold',{features:{return15s:0.01,return1m:0.02,volatility1m:0.004,spreadBps:12},assessment:{setupConfidence:0.8,setupScore:4}});
    store.decision(since+20,'ETHUSDT','approved',{features:{return15s:-0.01,return1m:-0.02,volatility1m:0.001,spreadBps:2},assessment:{setupConfidence:0.9,setupScore:5}});
    store.label(since+30,'BTCUSDT','up:high:wide:60',8);
    store.label(since+31,'BTCUSDT','up:high:wide:60',-2);
    store.usage(since+40,'jev',100,20,0.02);
    store.event('control',{action:'stop'},since+50);
    const evidence=store.reviewEvidence(since,until);
    assert.equal(evidence.trading.closedTrades,0);
    assert.equal(evidence.decisions.total,2);
    assert.equal(evidence.decisions.skipped,1);
    assert.equal(evidence.decisions.byVerdict.jev_threshold,1);
    assert.equal(evidence.decisions.regimes['up:high:wide'],1);
    assert.equal(evidence.decisions.regimes['down:low:tight'],1);
    assert.ok(Math.abs(evidence.decisions.jev.meanConfidence-0.85)<1e-12);
    assert.equal(evidence.decisions.jev.meanScore,4.5);
    assert.deepEqual(evidence.decisions.jev.outcomes.byBucket['up:high:wide:60'],{count:2,meanNetBps:3});
    assert.deepEqual(evidence.decisions.jev.outcomes.bySymbolRegime['BTCUSDT|up:high:wide:60'],{count:2,meanNetBps:3});
    assert.equal(evidence.api.jev.costUsd,0.02);
    assert.equal(evidence.riskEvents.control,1);
    assert.equal(JSON.stringify(evidence).includes('must not appear'),false);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('review evidence caps its window at fifteen minutes and nets paired paper trades', () => {
  const dir=mkdtempSync(join(tmpdir(),'review-evidence-'));
  const store=new Store(join(dir,'fixture.sqlite'));
  try {
    const since=2_000_000, until=since+20*60_000;
    store.trade({id:'buy',ts:until-10_000,symbol:'BTCUSDT',side:'BUY',quantity:1,price:100,notionalUsdt:100,feeUsdt:0.1,reason:'entry',mode:'paper'});
    store.trade({id:'sell',ts:until-1_000,symbol:'BTCUSDT',side:'SELL',quantity:1,price:102,notionalUsdt:102,feeUsdt:0.1,reason:'exit',mode:'paper'});
    const evidence=store.reviewEvidence(since,until);
    assert.equal(evidence.window.since,until-15*60_000);
    assert.equal(evidence.trading.closedTrades,1);
    assert.equal(evidence.trading.wins,1);
    assert.ok(Math.abs(evidence.trading.netPnlUsdt-1.9)<1e-12);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('review evidence combines partial BUY fills before calculating SELL P&L', () => {
  const dir=mkdtempSync(join(tmpdir(),'review-evidence-'));
  const store=new Store(join(dir,'fixture.sqlite'));
  try {
    const since=3_000_000, until=since+300_000;
    store.trade({id:'buy-1',ts:since+1,symbol:'BTCUSDT',side:'BUY',quantity:0.4,price:100,notionalUsdt:40,feeUsdt:0.04,reason:'entry',mode:'paper'});
    store.trade({id:'buy-2',ts:since+2,symbol:'BTCUSDT',side:'BUY',quantity:0.6,price:100,notionalUsdt:60,feeUsdt:0.06,reason:'entry',mode:'paper'});
    store.trade({id:'sell',ts:since+3,symbol:'BTCUSDT',side:'SELL',quantity:1,price:102,notionalUsdt:102,feeUsdt:0.1,reason:'exit',mode:'paper'});
    const evidence=store.reviewEvidence(since,until);
    assert.equal(evidence.trading.closedTrades,1);
    assert.ok(Math.abs(evidence.trading.netPnlUsdt-1.9)<1e-12);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
