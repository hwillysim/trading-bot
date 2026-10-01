import type { StrategyConfig } from '../shared/types.ts';
import { strategyProfile, type Calibration } from './adaptive.ts';
import { Store } from './store.ts';

// The model can choose a small experiment. Only code can authorise paper use.
export const STRATEGY_BOUNDS = Object.freeze({
  minRelativeVolume: [1,3,.3], buyFlowRatio: [1.15,3,.3], maxSpreadBps: [3,15,2],
  volatilityMultiple: [1.5,4,.5], continuationProbability: [.55,.85,.05],
  reversalExitProbability: [.6,.85,.05], costBufferBps: [3,15,2], targetHoldSeconds: [30,120,60],
} satisfies Record<string,[number,number,number]>);
export const REVIEW_INTERVAL_MS=15*60_000;
export const TRIAL_TIMEOUT_MS=30*60_000;
export interface ProfileEvidence extends Calibration {total:number;eligible:number}
export interface StrategyTrial {candidate:StrategyConfig;startedTs:number;profile:string;reason:string}
export interface TrialHistory {profile:string;candidate:StrategyConfig;startedTs:number;endedTs:number;outcome:'promoted'|'rolled_back'|'cancelled';evidence:ProfileEvidence|null}
export interface ControllerState {history:TrialHistory[];enabled:boolean;trial:StrategyTrial|null;lastAction:string;lastReason:string;lastChangeTs:number;lastReviewTs:number;lastReviewedOutcomes:number}

export function validateStrategyPatch(current:StrategyConfig,patch:Partial<StrategyConfig>):StrategyConfig|null {
  const keys=Object.keys(patch);
  if(!keys.length||keys.length>2)return null;
  const next={...current,version:current.version+1};
  for(const key of keys) {
    if(!Object.hasOwn(STRATEGY_BOUNDS,key))return null;
    const [min,max,step]=STRATEGY_BOUNDS[key as keyof typeof STRATEGY_BOUNDS];
    const value=patch[key as keyof StrategyConfig],previous=current[key as keyof StrategyConfig];
    if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||typeof previous!=='number'||Math.abs(value-previous)>step+1e-10)return null;
    if(key==='targetHoldSeconds'&&![30,60,120].includes(value))return null;
    Object.assign(next,{[key]:value});
  }
  return strategyProfile(next)===strategyProfile(current)?null:next;
}
export class StrategyController {
  state:ControllerState;
  private store:Store;
  constructor(store:Store) {
    this.store=store;
    this.state=store.get('strategyControllerV3',{history:[],enabled:true,trial:null,lastAction:'waiting',lastReason:'Waiting for 20 new shadow outcomes before the first review.',lastChangeTs:0,lastReviewTs:0,lastReviewedOutcomes:0});
    this.state.history??=[];
  }
  ready(now:number,outcomes:number) {return this.state.enabled&&!this.state.trial&&now-this.state.lastReviewTs>=REVIEW_INTERVAL_MS&&outcomes-this.state.lastReviewedOutcomes>=20;}
  reviewed(now:number,outcomes:number) {this.state.lastReviewTs=now;this.state.lastReviewedOutcomes=outcomes;this.save();}
  propose(current:StrategyConfig,patch:Partial<StrategyConfig>,reason:string,now:number):boolean {
    if(!this.state.enabled||this.state.trial)return false;
    const candidate=validateStrategyPatch(current,patch);
    if(!candidate){this.note('rejected','The proposed settings exceeded the allowed changes.',now);return false;}
    const profile=strategyProfile(candidate);
    if(this.state.history.some(t=>t.profile===profile&&t.outcome==='rolled_back'&&now-t.endedTs<60*60_000)){this.note('rejected','This profile failed a recent trial. Choose a different experiment.',now);return false;}
    this.state.trial={candidate,profile,startedTs:now,reason:reason.slice(0,240)};
    this.note('trial_started',reason,now);return true;
  }
  check(evidence:ProfileEvidence,now:number):StrategyConfig|null {
    const trial=this.state.trial;if(!trial)return null;
    if(now-trial.startedTs<TRIAL_TIMEOUT_MS&&evidence.count>=30&&evidence.blocks>=5&&evidence.lowerNetBps>3) {
      this.remember(trial,'promoted',evidence,now);this.state.trial=null;this.note('promoted','The trial cleared the fixed evidence gate after costs. Paper entries still need their own calibrated edge.',now);
      return trial.candidate;
    }
    if((evidence.count>=20&&evidence.blocks>=5&&evidence.lowerNetBps<=0)||now-trial.startedTs>=TRIAL_TIMEOUT_MS) {
      this.remember(trial,'rolled_back',evidence,now);this.state.trial=null;this.note('rolled_back','The shadow trial was negative or did not establish an edge within 30 minutes. Previous paper settings retained.',now);
    }
    return null;
  }
  recordDecision(action:'no_change'|'rejected',reason:string,now=Date.now()){this.note(action,reason,now);}
  setEnabled(enabled:boolean,now=Date.now()) {
    this.state.enabled=enabled;
    if(!enabled&&this.state.trial){this.remember(this.state.trial,'cancelled',null,now);this.state.trial=null;}
    this.note(enabled?'enabled':'disabled',enabled?'Bounded strategy reviews enabled.':'Automatic adjustments disabled; any shadow trial was cancelled.',now);
  }
  private remember(trial:StrategyTrial,outcome:TrialHistory['outcome'],evidence:ProfileEvidence|null,now:number){this.state.history=[...this.state.history,{profile:trial.profile,candidate:trial.candidate,startedTs:trial.startedTs,endedTs:now,outcome,evidence}].slice(-5);}
  private note(action:string,reason:string,now:number) {this.state.lastAction=action;this.state.lastReason=reason.slice(0,240);this.state.lastChangeTs=now;this.store.event('strategy_'+action,{reason:this.state.lastReason,trial:this.state.trial},now);this.save();}
  private save(){this.store.set('strategyControllerV3',this.state);}
}
