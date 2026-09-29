export interface MarketTick {
  symbol: string;
  ts: number;
  last: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  bookTs?: number;
  quoteVolume24h: number;
  priceChangePercent24h: number;
  tradeQty?: number;
  tradeBuyerIsMaker?: boolean;
}

export interface SymbolRules {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  minNotional: number;
  minQty: number;
  stepSize: number;
  tickSize: number;
}

export interface MarketFeatures extends MarketTick {
  return15s: number;
  return1m: number;
  return5m: number;
  volatility1m: number;
  relativeVolume1m: number;
  buyFlow1m: number;
  sellFlow1m: number;
  spreadBps: number;
  bookImbalance: number;
  depthUsdt: number;
  estimatedSlippageBps: number;
}

export interface StrategyConfig {
  version: number;
  entryConfidence: number;
  continuationProbability: number;
  reversalExitProbability: number;
  costBufferBps: number;
  targetHoldSeconds: number;
  positionFraction: number;
  selectedSymbols: string[];
}

export interface RiskCaps {
  floatUsdt: number;
  maxOrderUsdt: number;
  dailyLossStopUsdt: number;
  dailyApiSpendUsd: number;
  maxHoldSeconds: number;
  maxPositions: number;
}

export interface JevAssessment {
  symbol: string;
  ts: number;
  horizonSeconds: number;
  model: string;
  continuationProbability: number;
  reversalProbability: number;
  waitProbability: number;
  setupScore: number;
  setupConfidence: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  raw: unknown;
}

export interface ReviewProposal {
  action: 'no_change' | 'patch';
  reason: string;
  summary: string;
  patch?: Partial<Pick<StrategyConfig, 'entryConfidence' | 'continuationProbability' | 'reversalExitProbability' | 'costBufferBps' | 'targetHoldSeconds' | 'positionFraction' | 'selectedSymbols'>>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}
