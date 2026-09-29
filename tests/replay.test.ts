import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { evaluateReplay, replayDatabase } from '../src/replay/index.ts';

const features=(ts:number,overrides:Record<string,unknown>={})=>({ts,bid:100,ask:100.1,return15s:0.01,return1m:0.02,volatility1m:0.001,spreadBps:2,...overrides});
const snapshot=(id:number,ts:number,bid:number,ask=bid+0.1)=>({id,ts,symbol:'BTCUSDT',data:{ts,bid,ask}});
const decision=(id:number,ts:number,verdict:string,data:Record<string,unknown>={})=>({id,ts,symbol:'BTCUSDT',verdict,data:{features:features(ts-5_000),...data}});

test('replay enters after the decision and measures later executable bid quotes net of costs',()=>{
  const result=evaluateReplay([
    snapshot(1,100_000,101), // before the decision, must not become the entry
    snapshot(2,106_000,100),
    snapshot(3,130_000,101), snapshot(4,220_000,102), snapshot(5,410_000,103),
  ],[decision(1,105_000,'approved')],{feeBps:10,slippageBps:5});
  const selected=result.summary.find(x=>x.signal==='signal:jev_policy');
  assert.ok(selected);
  assert.equal(selected.selectedDecisions,1);
  assert.equal(selected.actionRate,1);
  assert.equal(selected.horizons[30].covered,1);
  assert.ok(Math.abs(selected.horizons[30].meanNetBps! - ((102/100.1-1)*10_000-30)) < 1e-8);
  assert.equal(result.coverage.requested,3);
  assert.equal(result.coverage.covered,3);
  const noTrade=result.summary.find(x=>x.signal==='signal:no_trade');
  assert.equal(noTrade?.horizons[30].meanNetBps,0);
});

test('momentum baseline selects positive short returns, and missing future quotes count as uncovered',()=>{
  const rows=[snapshot(1,10_000,100),snapshot(2,40_000,101)];
  const decisions=[decision(1,10_000,'jev_threshold')];
  const result=evaluateReplay(rows,decisions,{feeBps:0,slippageBps:0});
  const momentum=result.summary.find(x=>x.signal==='signal:momentum_baseline');
  const jev=result.summary.find(x=>x.signal==='signal:jev_policy');
  assert.equal(momentum?.horizons[30].meanNetBps, (101/100.1-1)*10_000);
  assert.equal(jev?.horizons[30].meanNetBps,0);
  assert.equal(result.coverage.covered,1);
  assert.equal(result.coverage.requested,3);
  assert.equal(result.summary.some(x=>x.horizons[120].meanNetBps!==null),false);
});

test('exploratory paper approvals get a separate replay series',()=>{
  const result=evaluateReplay([snapshot(1,10_000,100),snapshot(2,40_000,101)], [decision(1,10_000,'exploratory_approved')], {feeBps:0,slippageBps:0});
  assert.equal(result.summary.find(x=>x.signal==='signal:jev_exploratory')?.selectedDecisions,1);
  assert.equal(result.summary.find(x=>x.signal==='signal:jev_policy')?.selectedDecisions,0);
});

test('stale recorded books do not provide entry or outcome quotes',()=>{
  const rows=[
    {id:1,ts:10_000,symbol:'BTCUSDT',data:{ts:10_000,bookTs:6_000,bid:100,ask:100.1}},
    {id:2,ts:11_000,symbol:'BTCUSDT',data:{ts:11_000,bookTs:11_000,bid:100,ask:100.1}},
    {id:3,ts:40_000,symbol:'BTCUSDT',data:{ts:40_000,bookTs:36_000,bid:105,ask:105.1}},
  ];
  const result=evaluateReplay(rows,[decision(1,10_000,'approved')],{feeBps:0,slippageBps:0});
  const jev=result.summary.find(x=>x.signal==='signal:jev_policy');
  assert.equal(jev?.horizons[30].covered,0);
  assert.equal(result.coverage.covered,0);
});

test('database replay opens the Store schema in read-only mode',()=>{
  const dir=mkdtempSync(join(tmpdir(),'replay-'));
  const path=join(dir,'fixture.sqlite');
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE snapshots(id INTEGER PRIMARY KEY, ts INTEGER, symbol TEXT, data TEXT); CREATE TABLE decisions(id INTEGER PRIMARY KEY, ts INTEGER, symbol TEXT, verdict TEXT, data TEXT);');
  db.prepare('INSERT INTO snapshots VALUES(1,2000,?,?)').run('BTCUSDT',JSON.stringify({ts:2000,bid:100,ask:100.1}));
  db.prepare('INSERT INTO snapshots VALUES(2,32000,?,?)').run('BTCUSDT',JSON.stringify({ts:32000,bid:101,ask:101.1}));
  db.prepare('INSERT INTO decisions VALUES(1,2000,?,?,?)').run('BTCUSDT','approved',JSON.stringify({features:features(1000)}));
  db.close();
  try {
    const before=requireFileSize(path);
    const result=replayDatabase(path,{feeBps:0,slippageBps:0});
    assert.equal(result.counts.snapshots,2);
    assert.equal(requireFileSize(path),before);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

function requireFileSize(path:string) { return statSync(path).size; }
