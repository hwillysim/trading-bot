import type { RiskCaps, StrategyConfig } from '../shared/types.ts';

export const DEFAULT_CAPS: RiskCaps = Object.freeze({
  floatUsdt: 10,
  maxOrderUsdt: 0.2,
  dailyLossStopUsdt: 1,
  dailyApiSpendUsd: 1,
  maxHoldSeconds: 900,
  maxPositions: 1,
});

export const DEFAULT_STRATEGY: StrategyConfig = Object.freeze({
  version: 2,
  entryConfidence: 0.5,
  continuationProbability: 0.55,
  reversalExitProbability: 0.7,
  costBufferBps: 3,
  targetHoldSeconds: 120,
  positionFraction: 0.02,
  selectedSymbols: [],
});

export const TAKER_FEE_BPS = 10;
export const PAPER_SLIPPAGE_BPS = 2;

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
