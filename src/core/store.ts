import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface RecordedTrade {
  id: string; ts: number; symbol: string; side: 'BUY' | 'SELL'; quantity: number;
  price: number; notionalUsdt: number; feeUsdt: number; reason: string; mode: 'paper' | 'live';
  netPnlUsdt?: number;
}

export interface ReviewEvidence {
  window: { since: number; until: number };
  trading: { closedTrades: number; wins: number; losses: number; netPnlUsdt: number };
  decisions: { total: number; skipped: number; byVerdict: Record<string, number>; regimes: Record<string, number>; jev: { count: number; meanConfidence: number; meanScore: number; outcomes: { count: number; wins: number; losses: number; meanNetBps: number; byBucket: Record<string,{count:number;meanNetBps:number}>; bySymbolRegime:Record<string,{count:number;meanNetBps:number}> } } };
  api: Record<string, { requests: number; costUsd: number; inputTokens: number; outputTokens: number }>;
  riskEvents: Record<string, number>;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path = 'data/trading-bot.sqlite') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_symbol_ts ON snapshots(symbol, ts);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL, verdict TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS decisions_ts ON decisions(ts);
      CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts);
      CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL, bucket TEXT NOT NULL, net_bps REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS labels_bucket ON labels(bucket);
      CREATE TABLE IF NOT EXISTS pending_outcomes (id TEXT PRIMARY KEY, decision_ts INTEGER NOT NULL, due_ts INTEGER NOT NULL, symbol TEXT NOT NULL, bucket TEXT NOT NULL, entry_ask REAL NOT NULL, horizon_seconds INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_outcomes_symbol_due ON pending_outcomes(symbol,due_ts);
      CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolio_points (ts INTEGER PRIMARY KEY, value_usdt REAL NOT NULL, run_id INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);`);
    this.migratePortfolioRuns();
  }
  close() { this.db.close(); }
  set<T>(key: string, value: T) { this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  get<T>(key: string, fallback: T): T { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as {value:string}|undefined; return row ? JSON.parse(row.value) as T : fallback; }
  snapshot(ts: number, symbol: string, data: unknown) { this.db.prepare('INSERT INTO snapshots(ts,symbol,data) VALUES(?,?,?)').run(ts,symbol,JSON.stringify(data)); }
  decision(ts: number, symbol: string, verdict: string, data: unknown) { this.db.prepare('INSERT INTO decisions(ts,symbol,verdict,data) VALUES(?,?,?,?)').run(ts,symbol,verdict,JSON.stringify(data)); }
  trade(trade: RecordedTrade) { this.db.prepare('INSERT INTO trades(id,ts,symbol,side,data) VALUES(?,?,?,?,?)').run(trade.id,trade.ts,trade.symbol,trade.side,JSON.stringify(trade)); }
  trades(limit=50): RecordedTrade[] {
    const recent=(this.db.prepare('SELECT data FROM trades ORDER BY ts DESC, rowid DESC LIMIT ?').all(limit) as {data:string}[]).map(r=>JSON.parse(r.data) as RecordedTrade);
    const missing=new Map(recent.filter(t=>t.side==='SELL'&&t.netPnlUsdt===undefined).map(t=>[t.id,t]));
    if(!missing.size)return recent;
    // Older journals did not record realised P/L. Match the complete journal so an
    // entry outside the recent-trades window still contributes its fee and cost.
    const entries=new Map<string,{quantity:number;cost:number}>();
    for(const row of this.db.prepare('SELECT data FROM trades ORDER BY ts, rowid').all() as {data:string}[]) {
      const trade=JSON.parse(row.data) as RecordedTrade,key=`${trade.mode}:${trade.symbol}`;
      const entry=entries.get(key);
      if(trade.side==='BUY') {
        entries.set(key,{quantity:(entry?.quantity??0)+trade.quantity,cost:(entry?.cost??0)+trade.notionalUsdt+trade.feeUsdt});
      } else if(entry&&entry.quantity>0) {
        const allocatedCost=entry.cost*Math.min(1,trade.quantity/entry.quantity);
        if(trade.quantity<=entry.quantity+1e-10&&missing.has(trade.id))missing.get(trade.id)!.netPnlUsdt=trade.notionalUsdt-trade.feeUsdt-allocatedCost;
        entry.quantity-=trade.quantity;entry.cost-=allocatedCost;
        if(entry.quantity<=1e-10)entries.delete(key);
      }
    }
    return recent;
  }
  label(ts:number,symbol:string,bucket:string,netBps:number) { this.db.prepare('INSERT INTO labels(ts,symbol,bucket,net_bps) VALUES(?,?,?,?)').run(ts,symbol,bucket,netBps); }
  labelValues(bucket:string,symbol:string,limit=500):number[] { return (this.db.prepare('SELECT net_bps FROM labels WHERE bucket=? AND symbol=? ORDER BY ts DESC LIMIT ?').all(bucket,symbol,limit) as {net_bps:number}[]).map(r=>r.net_bps); }
  addPendingOutcome(outcome:{id:string;decisionTs:number;dueTs:number;symbol:string;bucket:string;entryAsk:number;horizonSeconds:number}) {
    this.db.prepare('INSERT OR IGNORE INTO pending_outcomes(id,decision_ts,due_ts,symbol,bucket,entry_ask,horizon_seconds) VALUES(?,?,?,?,?,?,?)')
      .run(outcome.id,outcome.decisionTs,outcome.dueTs,outcome.symbol,outcome.bucket,outcome.entryAsk,outcome.horizonSeconds);
  }
  pendingOutcomes(symbol?:string):Array<{id:string;decisionTs:number;dueTs:number;symbol:string;bucket:string;entryAsk:number;horizonSeconds:number}> {
    const rows=(symbol
      ? this.db.prepare('SELECT id,decision_ts decisionTs,due_ts dueTs,symbol,bucket,entry_ask entryAsk,horizon_seconds horizonSeconds FROM pending_outcomes WHERE symbol=? ORDER BY due_ts').all(symbol)
      : this.db.prepare('SELECT id,decision_ts decisionTs,due_ts dueTs,symbol,bucket,entry_ask entryAsk,horizon_seconds horizonSeconds FROM pending_outcomes ORDER BY due_ts').all()) as Array<{id:string;decisionTs:number;dueTs:number;symbol:string;bucket:string;entryAsk:number;horizonSeconds:number}>;
    return rows;
  }
  completePendingOutcome(id:string) { this.db.prepare('DELETE FROM pending_outcomes WHERE id=?').run(id); }
  review(ts:number,action:string,data:unknown) { this.db.prepare('INSERT INTO reviews(ts,action,data) VALUES(?,?,?)').run(ts,action,JSON.stringify(data)); }
  portfolioPoint(ts:number,valueUsdt:number,runId=this.currentPortfolioRunId()) {
    if(Number.isFinite(valueUsdt)&&valueUsdt>=0) this.db.prepare('INSERT OR REPLACE INTO portfolio_points(ts,value_usdt,run_id) VALUES(?,?,?)').run(ts,valueUsdt,runId);
  }
  portfolioHistory(since:number,bucketMs:number,limit=500,runId=this.currentPortfolioRunId()):{ts:number;valueUsdt:number}[] {
    const rows=this.db.prepare(`SELECT p.ts,p.value_usdt valueUsdt FROM portfolio_points p
      JOIN (SELECT MAX(ts) ts FROM portfolio_points WHERE run_id=? AND ts>=? GROUP BY CAST(ts / ? AS INTEGER)) sampled ON sampled.ts=p.ts
      ORDER BY p.ts DESC LIMIT ?`).all(runId,since,bucketMs,limit) as {ts:number;valueUsdt:number}[];
    return rows.reverse().map(({ts,valueUsdt})=>({ts,valueUsdt}));
  }
  currentPortfolioRunId():number { return this.get('portfolioRunId',0); }
  startPortfolioRun(ts:number):number {
    const runId=this.currentPortfolioRunId()+1;
    this.set('portfolioRunId',runId);
    this.event('portfolio_run_started',{runId},ts);
    return runId;
  }
  oldestPortfolioTs(runId=this.currentPortfolioRunId()):number|null {
    const row=this.db.prepare('SELECT MIN(ts) firstTs FROM portfolio_points WHERE run_id=?').get(runId) as {firstTs:number|null};
    return row.firstTs;
  }
  reviews(limit=20):unknown[] { return (this.db.prepare('SELECT data FROM reviews ORDER BY ts DESC LIMIT ?').all(limit) as {data:string}[]).map(r=>JSON.parse(r.data)); }
  usage(ts:number,provider:string,inputTokens:number,outputTokens:number,costUsd:number) { this.db.prepare('INSERT INTO usage(ts,provider,input_tokens,output_tokens,cost_usd) VALUES(?,?,?,?,?)').run(ts,provider,inputTokens,outputTokens,costUsd); }
  usageSince(ts:number):Record<string,{inputTokens:number;outputTokens:number;costUsd:number;requests:number}> {
    const rows=this.db.prepare('SELECT provider, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens, SUM(cost_usd) costUsd, COUNT(*) requests FROM usage WHERE ts>=? GROUP BY provider').all(ts) as {provider:string;inputTokens:number;outputTokens:number;costUsd:number;requests:number}[];
    return Object.fromEntries(rows.map(({provider,...rest})=>[provider,rest]));
  }
  reviewEvidence(sinceTs:number, untilTs=Date.now()):ReviewEvidence {
    const windowMs=15*60_000;
    const since=Math.max(sinceTs,untilTs-windowMs);
    const decisions=(this.db.prepare('SELECT ts,symbol,verdict,data FROM decisions WHERE ts>=? AND ts<=? ORDER BY ts DESC LIMIT 500').all(since,untilTs) as {ts:number;symbol:string;verdict:string;data:string}[]).map(row=>({...row,data:parseObject(row.data)}));
    const byVerdict:Record<string,number>={},regimes:Record<string,number>={};
    let confidenceSum=0,scoreSum=0,jevCount=0;
    for(const row of decisions) {
      byVerdict[row.verdict]=(byVerdict[row.verdict]??0)+1;
      const f=row.data.features;
      if(isRecord(f)) {
        const momentum=Number(f.return15s)>0&&Number(f.return1m)>0?'up':Number(f.return15s)<0&&Number(f.return1m)<0?'down':'mixed';
        const regime=`${momentum}:${Number(f.volatility1m)>=0.003?'high':'low'}:${Number(f.spreadBps)>=10?'wide':'tight'}`;
        regimes[regime]=(regimes[regime]??0)+1;
      }
      const a=row.data.assessment;
      if(isRecord(a)&&Number.isFinite(a.setupConfidence)&&Number.isFinite(a.setupScore)) {confidenceSum+=Number(a.setupConfidence);scoreSum+=Number(a.setupScore);jevCount++;}
    }
    const labels=(this.db.prepare('SELECT bucket,symbol,net_bps netBps FROM labels WHERE ts>=? AND ts<=? ORDER BY ts DESC LIMIT 1000').all(since,untilTs) as {bucket:string;symbol:string;netBps:number}[]);
    const labelGroups=new Map<string,number[]>();
    const symbolRegimeGroups=new Map<string,number[]>();
    for(const label of labels) {const values=labelGroups.get(label.bucket)??[];values.push(label.netBps);labelGroups.set(label.bucket,values);const key=`${label.symbol}|${label.bucket}`;const symbolValues=symbolRegimeGroups.get(key)??[];symbolValues.push(label.netBps);symbolRegimeGroups.set(key,symbolValues);}
    const labelValues=labels.map(label=>label.netBps),labelWins=labelValues.filter(value=>value>0).length;
    const allTrades=(this.db.prepare('SELECT ts,side,data FROM trades WHERE ts<=? ORDER BY ts').all(untilTs) as {ts:number;side:string;data:string}[]).map(row=>({...row,data:parseObject(row.data)}));
    const entries=new Map<string,{cost:number;quantity:number}>(),closed:number[]=[];
    for(const row of allTrades) {
      const symbol=String(row.data.symbol);
      if(row.side==='BUY') {const entry=entries.get(symbol)??{cost:0,quantity:0};entry.cost+=Number(row.data.notionalUsdt)+Number(row.data.feeUsdt);entry.quantity+=Number(row.data.quantity);entries.set(symbol,entry);}
      else if(row.side==='SELL') {const entry=entries.get(symbol);if(!entry)continue;const fraction=Math.min(1,Number(row.data.quantity)/entry.quantity),entryCost=entry.cost*fraction;if(fraction>=1-1e-9)entries.delete(symbol);else {entry.cost-=entryCost;entry.quantity-=Number(row.data.quantity);}if(row.ts>=since&&row.ts<=untilTs)closed.push(Number(row.data.notionalUsdt)-Number(row.data.feeUsdt)-entryCost);}
    }
    const usageRows=this.db.prepare('SELECT provider,COUNT(*) requests,SUM(cost_usd) costUsd,SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens FROM usage WHERE ts>=? AND ts<=? GROUP BY provider').all(since,untilTs) as {provider:string;requests:number;costUsd:number;inputTokens:number;outputTokens:number}[];
    const riskRows=this.db.prepare(`SELECT kind,COUNT(*) count FROM events WHERE ts>=? AND ts<=? AND kind IN ('feed_disconnected','jev_error','review_error','strategy_rollback','control') GROUP BY kind`).all(since,untilTs) as {kind:string;count:number}[];
    const riskEvents=Object.fromEntries(riskRows.map(row=>[row.kind,row.count]));
    for(const row of decisions) if(['daily_loss_stop','api_spend_stop','position_limit','insufficient_usdt'].includes(row.verdict)) riskEvents[row.verdict]=(riskEvents[row.verdict]??0)+1;
    const api=Object.fromEntries(usageRows.map(({provider,...values})=>[provider,values]));
    const byBucket=Object.fromEntries([...labelGroups.entries()].slice(0,50).map(([bucket,values])=>[bucket,{count:values.length,meanNetBps:values.reduce((a,b)=>a+b,0)/values.length}]));
    const bySymbolRegime=Object.fromEntries([...symbolRegimeGroups.entries()].slice(0,100).map(([key,values])=>[key,{count:values.length,meanNetBps:values.reduce((a,b)=>a+b,0)/values.length}]));
    return {window:{since,until:untilTs},trading:{closedTrades:closed.length,wins:closed.filter(value=>value>0).length,losses:closed.filter(value=>value<0).length,netPnlUsdt:closed.reduce((sum,value)=>sum+value,0)},decisions:{total:decisions.length,skipped:decisions.filter(row=>row.verdict!=='approved'&&row.verdict!=='exploratory_approved').length,byVerdict,regimes,jev:{count:jevCount,meanConfidence:jevCount?confidenceSum/jevCount:0,meanScore:jevCount?scoreSum/jevCount:0,outcomes:{count:labelValues.length,wins:labelWins,losses:labelValues.length-labelWins,meanNetBps:labelValues.length?labelValues.reduce((a,b)=>a+b,0)/labelValues.length:0,byBucket,bySymbolRegime}}},api,riskEvents};
  }
  event(kind:string,data:unknown,ts=Date.now()) { this.db.prepare('INSERT INTO events(ts,kind,data) VALUES(?,?,?)').run(ts,kind,JSON.stringify(data)); }
  recentEvents(limit=20):unknown[] { return (this.db.prepare('SELECT ts,kind,data FROM events ORDER BY ts DESC LIMIT ?').all(limit) as {ts:number;kind:string;data:string}[]).map(r=>({ts:r.ts,kind:r.kind,...JSON.parse(r.data)})); }
  prune(beforeTs:number) { this.db.prepare('DELETE FROM snapshots WHERE ts<?').run(beforeTs); this.db.prepare('DELETE FROM decisions WHERE ts<?').run(beforeTs); }
  private migratePortfolioRuns() {
    const columns=this.db.prepare('PRAGMA table_info(portfolio_points)').all() as Array<{name:string}>;
    if(!columns.some(column=>column.name==='run_id')) this.db.exec('ALTER TABLE portfolio_points ADD COLUMN run_id INTEGER NOT NULL DEFAULT 0');
    const boundaries=(this.db.prepare("SELECT ts,data FROM events WHERE kind='control' ORDER BY ts").all() as Array<{ts:number;data:string}>)
      .filter(event=>{try{return JSON.parse(event.data).action==='start-paper';}catch{return false;}});
    if(boundaries.length) {
      const nearest=this.db.prepare('SELECT MAX(ts) ts FROM portfolio_points WHERE ts<=? AND ts>=?');
      const update=this.db.prepare('UPDATE portfolio_points SET run_id=? WHERE ts>=? AND ts<?');
      let runId=1;
      for(let i=0;i<boundaries.length;i++) {
        const event=boundaries[i]!;
        const start=(nearest.get(event.ts,event.ts-15_000) as {ts:number|null}).ts;
        if(start===null) continue;
        const nextEvent=boundaries.slice(i+1).find(candidate=>candidate.ts>event.ts);
        const nextStart=nextEvent?(nearest.get(nextEvent.ts,nextEvent.ts-15_000) as {ts:number|null}).ts:null;
        update.run(runId,start,nextStart??Number.MAX_SAFE_INTEGER);
        runId++;
      }
      const latestRunId=runId-1;
      if(latestRunId>this.currentPortfolioRunId()) this.set('portfolioRunId',latestRunId);
    }
  }
}

function isRecord(value:unknown):value is Record<string,any> { return !!value&&typeof value==='object'&&!Array.isArray(value); }
function parseObject(value:string):Record<string,any> { try {const parsed=JSON.parse(value);return isRecord(parsed)?parsed:{}} catch {return {};} }
