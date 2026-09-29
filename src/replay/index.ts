import { DatabaseSync } from 'node:sqlite';

export type ReplayHorizon = 30 | 120 | 300;
export interface ReplayOptions { feeBps: number; slippageBps: number }
export interface ReplaySnapshot { id: number; ts: number; symbol: string; data: Record<string, unknown> }
export interface ReplayDecision { id: number; ts: number; symbol: string; verdict: string; data: Record<string, unknown> }
type Quote = { ts: number; bid: number; ask: number };

const HORIZONS: ReplayHorizon[] = [30, 120, 300];

/** Opens a recorded Store database read-only and evaluates decisions against later quotes. */
export function replayDatabase(path: string, options: ReplayOptions) {
  if (options.feeBps < 0 || options.slippageBps < 0 || !Number.isFinite(options.feeBps + options.slippageBps)) {
    throw new Error('feeBps and slippageBps must be finite non-negative numbers');
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const snapshots = (db.prepare('SELECT id, ts, symbol, data FROM snapshots ORDER BY ts, id').all() as Array<{id:number;ts:number;symbol:string;data:string}>).map(row => ({...row,data:parseObject(row.data)}));
    const decisions = (db.prepare('SELECT id, ts, symbol, verdict, data FROM decisions ORDER BY ts, id').all() as Array<{id:number;ts:number;symbol:string;verdict:string;data:string}>).map(row => ({...row,data:parseObject(row.data)}));
    return evaluateReplay(snapshots, decisions, options);
  } finally { db.close(); }
}

export function evaluateReplay(snapshots: ReplaySnapshot[], decisions: ReplayDecision[], options: ReplayOptions) {
  const bySymbol = new Map<string, Quote[]>();
  for (const row of [...snapshots].sort((a,b)=>a.ts-b.ts||a.id-b.id)) {
    const quote = quoteFrom(row.data, row.ts);
    if (!quote) continue;
    const rows = bySymbol.get(row.symbol) ?? [];
    rows.push(quote); bySymbol.set(row.symbol, rows);
  }
  const groups = new Map<string, { decisions:number; actions:number; outcomes:Record<number,{covered:number;netBps:number[]}> }>();
  const sorted = [...decisions].sort((a,b)=>a.ts-b.ts||a.id-b.id);
  let totalOutcomes = 0, coveredOutcomes = 0;
  for (const decision of sorted) {
    const features = objectAt(decision.data, 'features');
    // Decisions are timestamped after the assessment completes. Start the replay
    // at that timestamp so neither the input feature quote nor assessment latency
    // can leak into the simulated result.
    const startTs = decision.ts;
    const symbolQuotes = bySymbol.get(decision.symbol) ?? [];
    const entryQuote = firstQuoteAtOrAfter(symbolQuotes, startTs);
    if (!entryQuote) continue;
    const regime = regimeOf(features);
    const momentum = finite(features.return15s) && finite(features.return1m) && features.return15s > 0 && features.return1m > 0;
    const jevSelected = decision.verdict === 'approved';
    const exploratorySelected = decision.verdict === 'exploratory_approved';
    const groupsForDecision = [
      [`signal:jev_policy`, decision.symbol, regime],
      [`signal:jev_exploratory`, decision.symbol, regime],
      [`signal:momentum_baseline`, decision.symbol, regime],
      [`signal:no_trade`, decision.symbol, regime],
    ];
    const futureQuotes = new Map<number, Quote | undefined>();
    for (const horizon of HORIZONS) {
      totalOutcomes++;
      const quote = firstQuoteAtOrAfter(symbolQuotes, startTs + horizon * 1000);
      futureQuotes.set(horizon, quote && quote.ts > startTs ? quote : undefined);
      if (futureQuotes.get(horizon)) coveredOutcomes++;
    }
    const keySet = new Set<string>();
    for (const [signal, symbol, bucket] of groupsForDecision) {
      const key = `${signal}|${bucket}|${symbol}`;
      if (keySet.has(key)) continue;
      keySet.add(key);
      const group = groups.get(key) ?? {decisions:0,actions:0,outcomes:Object.fromEntries(HORIZONS.map(h=>[h,{covered:0,netBps:[]}]))};
      group.decisions++;
      const selected = signal === 'signal:momentum_baseline' ? momentum
        : signal === 'signal:no_trade' ? false : signal === 'signal:jev_exploratory' ? exploratorySelected : jevSelected;
      if (selected) group.actions++;
      groups.set(key, group);
      for (const horizon of HORIZONS) {
        const quote = futureQuotes.get(horizon);
        if (!quote) continue;
        group.outcomes[horizon]!.covered++;
        const friction = (options.feeBps + options.slippageBps) * 2;
        const netBps = (quote.bid / entryQuote.ask - 1) * 10_000 - friction;
        group.outcomes[horizon]!.netBps.push(selected ? netBps : 0);
      }
    }
  }
  const summary = [...groups.entries()].map(([key, group]) => {
    const [signal, regime, symbol] = key.split('|');
    return { signal, regime, symbol, decisions: group.decisions, selectedDecisions:group.actions, actionRate:group.decisions?group.actions/group.decisions:0, horizons: Object.fromEntries(HORIZONS.map(h => {
      const values = group.outcomes[h]!.netBps;
      return [h, {covered:group.outcomes[h]!.covered,coverage:group.decisions ? group.outcomes[h]!.covered/group.decisions : 0,meanNetBps:mean(values)}];
    })) };
  });
  return { options, counts:{snapshots:snapshots.length,decisions:decisions.length}, coverage:{requested:totalOutcomes,covered:coveredOutcomes,ratio:totalOutcomes?coveredOutcomes/totalOutcomes:0}, summary };
}

function quoteFrom(data: Record<string, unknown>, ts: number): Quote | undefined {
  const bid = data.bid, ask = data.ask;
  if (!finite(bid) || !finite(ask) || bid <= 0 || ask <= 0 || ask < bid) return;
  const snapshotTs = finite(data.ts) ? data.ts : ts;
  if (finite(data.bookTs) && snapshotTs - data.bookTs > 3_000) return;
  return {ts:snapshotTs,bid,ask};
}
function firstQuoteAtOrAfter(rows: Quote[], ts: number) { let lo=0,hi=rows.length; while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid]!.ts<ts)lo=mid+1;else hi=mid;} return rows[lo]; }
function objectAt(o: Record<string,unknown>, k:string): Record<string,unknown> { const v=o[k]; return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:o; }
function finite(v:unknown): v is number { return typeof v==='number'&&Number.isFinite(v); }
function mean(v:number[]) { return v.length?v.reduce((a,b)=>a+b,0)/v.length:null; }
function regimeOf(f:Record<string,unknown>) {
  const a=finite(f.return15s)?f.return15s:0,b=finite(f.return1m)?f.return1m:0;
  const momentum=a>0&&b>0?'up':a<0&&b<0?'down':'mixed';
  const volatility=(finite(f.volatility1m)?f.volatility1m:0)>=0.003?'high':'low';
  const spread=(finite(f.spreadBps)?f.spreadBps:0)>=10?'wide':'tight';
  return `${momentum}:${volatility}:${spread}`;
}
function parseObject(value:string): Record<string,unknown> { const parsed=JSON.parse(value) as unknown; return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{}; }

export { HORIZONS };
