import type { JevAssessment, MarketFeatures } from '../shared/types.ts';
import { PAPER_SLIPPAGE_BPS, TAKER_FEE_BPS } from './defaults.ts';

export const EXPERIMENT_VERSION = 2;
export const MAX_POSITIONS = 50;
export const MANAGEMENT = Object.freeze({ reassessMs:3_000, assessmentExpiryMs:10_000, plannedSeconds:120, maxSeconds:300, minDipBps:10, maxDipBps:40, volatilityMultiple:2.5, hardLossBps:80, minCalibration:30, minTimeBlocks:5, netBufferBps:3 });
export type Setup = 'early_acceleration' | 'pullback_recovery';
export interface Calibration {count:number;blocks:number;meanNetBps:number;lowerNetBps:number}
export interface PositionPlan { setup:Setup; horizonSeconds:number; deadlineTs:number; plannedExitTs:number; dipBps:number; stopBid:number; expectedGrossBps:number; entryAssessmentTs:number }
export const RETURN_BANDS:Record<string,{description:string;bps:number}>={
  down_large:{description:'Executable mid-price falls by more than 50 basis points',bps:-150},
  down_small:{description:'Executable mid-price falls by 10 to 50 basis points',bps:-50},
  flat:{description:'Executable mid-price changes by between minus 10 and plus 10 basis points',bps:-10},
  up_small:{description:'Executable mid-price rises by 10 to 40 basis points',bps:10},
  up_medium:{description:'Executable mid-price rises by 40 to 100 basis points',bps:40},
  up_large:{description:'Executable mid-price rises by more than 100 basis points',bps:100},
};
export function tradingCostsBps(f:MarketFeatures):number {
  return 2*TAKER_FEE_BPS+f.spreadBps+2*(PAPER_SLIPPAGE_BPS+Math.max(0,f.estimatedSlippageBps));
}
export function detectSetup(f:MarketFeatures):Setup|null {
  const buy=f.buyFlow5s??f.buyFlow1m,sell=f.sellFlow5s??f.sellFlow1m;
  if((f.historySeconds??0)<60||f.relativeVolume1m<1||buy<=sell*1.15) return null;
  if(f.return15s>=0.0003&&f.return1m>0&&f.return15s<0.006) return 'early_acceleration';
  if(f.return15s>0&&f.return1m<0&&f.return5m>0&&f.bookImbalance>0) return 'pullback_recovery';
  return null;
}
export function selectForecast(a:JevAssessment,f:MarketFeatures) {
  return a.forecasts?.filter(x=>[30,60,120].includes(x.horizonSeconds)&&Number.isFinite(x.expectedGrossBps))
    .sort((x,y)=>(y.expectedGrossBps-tradingCostsBps(f))/y.horizonSeconds-(x.expectedGrossBps-tradingCostsBps(f))/x.horizonSeconds)[0];
}
export function calibrationBucket(setup:Setup,a:JevAssessment,f:MarketFeatures,horizonSeconds:number):string {
  const regime=f.volatility5sBps!==undefined&&f.volatility5sBps>=10?'volatile':'quiet';
  const probability=Math.min(3,Math.floor((a.forecasts?.find(x=>x.horizonSeconds===horizonSeconds)?.clearsCostsProbability??a.clearsCostsProbability??0)*4));
  return `v${EXPERIMENT_VERSION}:${setup}:${regime}:${horizonSeconds}:p${probability}`;
}
export function signalVerdict(a:JevAssessment,f:MarketFeatures,edge:Calibration,bufferBps:number=MANAGEMENT.netBufferBps):string {
  if(!a.forecasts?.length||a.clearsCostsProbability===undefined||a.exhaustionProbability===undefined) return 'missing_forecast';
  if(a.setupScore<2||a.continuationProbability<0.55||a.waitProbability>0.5||a.exhaustionProbability>0.5) return 'jev_signal_weak';
  const forecast=selectForecast(a,f);
  if(!forecast||(forecast.clearsCostsProbability??a.clearsCostsProbability)<0.55||forecast.expectedGrossBps<=tradingCostsBps(f)+bufferBps) return 'forecast_below_costs';
  if(edge.count<MANAGEMENT.minCalibration||edge.blocks<MANAGEMENT.minTimeBlocks) return 'calibration_pending';
  if(edge.lowerNetBps<=bufferBps) return 'negative_calibrated_edge';
  return 'approved';
}
export function makePlan(f:MarketFeatures,a:JevAssessment,setup:Setup,entryPrice:number,now:number,maxHoldSeconds:number):PositionPlan {
  const forecast=selectForecast(a,f);
  const horizonSeconds=forecast?.horizonSeconds??MANAGEMENT.plannedSeconds;
  const dipBps=Math.max(MANAGEMENT.minDipBps,Math.min(MANAGEMENT.maxDipBps,(f.volatility5sBps??0)*MANAGEMENT.volatilityMultiple));
  return {setup,horizonSeconds,deadlineTs:now+Math.min(maxHoldSeconds,MANAGEMENT.maxSeconds)*1000,plannedExitTs:now+horizonSeconds*1000,dipBps,stopBid:entryPrice*(1-MANAGEMENT.hardLossBps/10_000),expectedGrossBps:forecast?.expectedGrossBps??0,entryAssessmentTs:a.ts};
}
export function advanceStop(plan:PositionPlan,peakBid:number,ageSeconds:number):void {
  if(ageSeconds>=10) plan.stopBid=Math.max(plan.stopBid,peakBid*(1-plan.dipBps/10_000));
}
export function exitReason(plan:PositionPlan,tick:{bid:number;ts:number},entryPrice:number,assessment?:JevAssessment,assessmentReceivedTs=0,withJev=true):string|null {
  if(tick.bid<=entryPrice*(1-MANAGEMENT.hardLossBps/10_000)) return 'protective_stop';
  if(tick.bid<=plan.stopBid) return 'volatility_exit';
  if(tick.ts>=plan.deadlineTs) return 'max_hold_exit';
  const fresh=assessment&&tick.ts-assessment.ts>=0&&tick.ts-assessment.ts<=MANAGEMENT.assessmentExpiryMs&&tick.ts-assessmentReceivedTs<=MANAGEMENT.assessmentExpiryMs;
  if(withJev&&fresh&&(assessment.exhaustionProbability??0)>0.7) return 'jev_exhaustion';
  if(withJev&&fresh&&assessment.reversalProbability>0.7) return 'jev_reversal';
  if(tick.ts>=plan.plannedExitTs) {
    // Extensions stop at the original deadline. The loss allowance never widens.
    if(withJev&&fresh&&plan.deadlineTs-tick.ts>=30_000&&assessment.forecasts?.some(f=>f.horizonSeconds===30&&f.expectedGrossBps>MANAGEMENT.netBufferBps)&&assessment.continuationProbability>=0.6&&(assessment.exhaustionProbability??1)<0.4&&assessment.waitProbability<0.4) {
      plan.plannedExitTs=Math.min(plan.deadlineTs,tick.ts+30_000);
      return null;
    }
    return 'target_hold_exit';
  }
  return null;
}
