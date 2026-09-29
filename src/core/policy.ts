import type { JevAssessment, MarketFeatures, RiskCaps, StrategyConfig, SymbolRules } from '../shared/types.ts';
import { PAPER_SLIPPAGE_BPS, TAKER_FEE_BPS } from './defaults.ts';

export interface EdgeStats { count: number; lowerNetBps: number; meanNetBps: number }
export interface EntryVerdict { allowed: boolean; reason: string; requiredBps: number; orderUsdt: number }

export function regimeBucket(f: MarketFeatures): string {
  const momentum = f.return15s > 0 && f.return1m > 0 ? 'up' : f.return15s < 0 && f.return1m < 0 ? 'down' : 'mixed';
  const volatility = f.volatility1m >= 0.003 ? 'high' : 'low';
  const spread = f.spreadBps >= 10 ? 'wide' : 'tight';
  return `${momentum}:${volatility}:${spread}`;
}

export function requiredGrossMoveBps(f: MarketFeatures, bufferBps: number, takerFeeBps = TAKER_FEE_BPS): number {
  return 2 * takerFeeBps + f.spreadBps + 2 * (PAPER_SLIPPAGE_BPS + f.estimatedSlippageBps) + bufferBps;
}

export function judgeEntry(input: {
  features: MarketFeatures; assessment: JevAssessment; rules?: SymbolRules;
  strategy: StrategyConfig; caps: RiskCaps; availableUsdt: number;
  openPositions: number; dailyRealisedLossUsdt: number; apiSpendUsd: number;
  edge: EdgeStats; now: number; live: boolean; paused: boolean;
}): EntryVerdict {
  const { features: f, assessment: a, rules, strategy: s, caps, edge, now } = input;
  const orderUsdt = Math.min(caps.maxOrderUsdt, caps.floatUsdt * s.positionFraction, input.availableUsdt);
  const requiredBps = requiredGrossMoveBps(f, s.costBufferBps);
  const deny = (reason: string): EntryVerdict => ({ allowed: false, reason, requiredBps, orderUsdt });
  if (input.paused) return deny('paused');
  if (input.openPositions >= caps.maxPositions) return deny('position_limit');
  if (input.dailyRealisedLossUsdt >= caps.dailyLossStopUsdt) return deny('daily_loss_stop');
  if (input.apiSpendUsd >= caps.dailyApiSpendUsd) return deny('api_spend_stop');
  if (now - f.ts > 3_000 || now - a.ts > 5_000) return deny('stale_data');
  if (!f.bookTs || now-f.bookTs>3_000) return deny('stale_book');
  if (!rules || rules.status !== 'TRADING' || rules.quoteAsset !== 'USDT') return deny('symbol_unavailable');
  if (s.selectedSymbols.length && !s.selectedSymbols.includes(f.symbol)) return deny('not_selected');
  if (!Number.isFinite(f.ask) || f.ask <= 0 || !Number.isFinite(f.bid) || f.bid <= 0 || f.ask <= f.bid) return deny('invalid_book');
  if (f.quoteVolume24h < 1_000_000 || f.depthUsdt < 2_000 || f.spreadBps > 25) return deny('liquidity');
  if (orderUsdt <= 0 || orderUsdt > input.availableUsdt) return deny('insufficient_usdt');
  if (input.live && orderUsdt < rules.minNotional * 1.02) return deny('below_exchange_minimum');
  if (a.setupScore < 3 || a.setupConfidence < s.entryConfidence || a.continuationProbability < s.continuationProbability || a.waitProbability > 0.3) return deny('jev_threshold');
  if (edge.count < 30 || edge.lowerNetBps <= s.costBufferBps) return deny('unproven_net_edge');
  return { allowed: true, reason: 'approved', requiredBps, orderUsdt };
}

export function validateReviewPatch(current: StrategyConfig, patch: Partial<StrategyConfig>, candidates: string[]): StrategyConfig | null {
  const keys = Object.keys(patch);
  const allowed = new Set(['entryConfidence', 'continuationProbability', 'reversalExitProbability', 'costBufferBps', 'targetHoldSeconds', 'positionFraction', 'selectedSymbols']);
  if (!keys.length || keys.some(k => !allowed.has(k))) return null;
  const next = { ...current, ...patch, version: current.version + 1 };
  const bounds: Record<string, [number, number]> = {
    entryConfidence: [0.7, 0.99], continuationProbability: [0.65, 0.99],
    reversalExitProbability: [0.55, 0.95], costBufferBps: [10, 100],
    targetHoldSeconds: [1, 900], positionFraction: [0.005, 1],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const oldValue = current[key as keyof StrategyConfig] as number;
    const newValue = next[key as keyof StrategyConfig] as number;
    if (!Number.isFinite(newValue) || newValue < min || newValue > max) return null;
    if (newValue !== oldValue && Math.abs(newValue - oldValue) > Math.max(Math.abs(oldValue) * 0.1, key === 'targetHoldSeconds' ? 1 : 0.001)) return null;
  }
  if (!Array.isArray(next.selectedSymbols) || next.selectedSymbols.length > 20 || next.selectedSymbols.some(symbol => typeof symbol !== 'string' || !candidates.includes(symbol))) return null;
  return next;
}
