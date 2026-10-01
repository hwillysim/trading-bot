export type DashboardState = {
  mode: 'paper' | 'live'; paused: boolean; stopped: boolean; liquidationPending:boolean;
  health: { feedConnected: boolean; lastTickTs: number; jevReady: boolean; reviewerReady: boolean };
  balances: { availableUsdt: number; holdings: Array<{symbol:string;quantity:number;valueUsdt:number;entryPrice:number;ageSeconds:number}>; portfolioUsdt:number; realisedPnlUsdt:number; unrealisedPnlUsdt:number; feesUsdt:number; drawdownPercent:number; openPositions:number };
  usage: { jev: Usage; openai: Usage; totalCostUsd:number };
  caps: { floatUsdt:number; maxOrderUsdt:number; dailyLossStopUsdt:number; dailyApiSpendUsd:number; maxHoldSeconds:number; maxPositions:number };
  strategy: { version:number; entryConfidence:number; continuationProbability:number; reversalExitProbability:number; costBufferBps:number; targetHoldSeconds:number; positionFraction:number; selectedSymbols:string[] };
  experiment?:{version:number;reassessmentSeconds:number;maxHoldSeconds:number;shadowPositions:number;comparisons:Array<{variant:string;completed:number;covered:number;meanNetBps:number|null;wins:number}>};
  positionPlans?:Record<string,{stopBid:number;dipBps:number;deadlineTs:number;setup:string}>;
  providerRequestsInFlight?:number;
  latestReview:string;
  openOrders:Array<{id:string;symbol:string;side:string;price:number;quantity:number;status:string;ts:number}>;
  recentTrades:Array<{id:string;ts:number;symbol:string;side:'BUY'|'SELL';quantity:number;price:number;notionalUsdt:number;feeUsdt:number;netPnlUsdt?:number;reason:string;mode:'paper'|'live'}>;
  recentEvents:unknown[]; skippedReasons:Record<string,number>; jevGateFailures?:Record<string,number>;
  metrics:{decisions:number;approved:number;avgDecisionLatencyMs:number}; candidateCount:number; monitoredMarketCount?:number; portfolioRunId?:number; updatedAt:number;
};
type Usage={inputTokens:number;outputTokens:number;costUsd:number;requests:number};
export type ControlAction='pause'|'resume'|'liquidate'|'stop'|'restart'|'set-caps'|'start-paper';
