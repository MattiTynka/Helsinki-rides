import {tierParameters, type QualityTier, type StreamRange} from './quality-tiers.ts';
import type {CellStreamOptions} from '../world/cell-streaming.ts';

export type FallbackSelection = Pick<CellStreamOptions, 'sector' | 'lookaheadSeconds' | 'maxLookahead'>;
export interface FlightStreamingProfile {
  readonly detail: StreamRange;
  readonly fallback: StreamRange;
  readonly selection: FallbackSelection;
  readonly fog: {readonly near:number;readonly far:number};
  readonly cameraFar:number;
}

/** A mode policy, independent of the session-fixed LOD/backend and texture tier. */
export function flightStreamingProfile(tier:QualityTier,mobile:boolean,inAircraft:boolean):FlightStreamingProfile {
  const base=tierParameters(tier,mobile);
  if(!inAircraft)return {detail:base.detail,fallback:base.fallback,fog:base.fog,cameraFar:base.cameraFar,
    selection:{sector:null,lookaheadSeconds:3,maxLookahead:180}};
  const [near,radius,maxCells,maxLookahead]=mobile&&tier==='low'?[200,560,48,400]
    :tier==='standard'?[300,900,96,600]:tier==='low'?[240,700,64,500]:[180,520,42,350];
  // Keep each stream's existing allowance: cancelled GPU preparation may still
  // own its reservation, so transferring capacity between streams is unsafe.
  return {detail:base.detail,fallback:{...base.fallback,radius:radius!,maxCells:maxCells!},
    selection:{sector:{nearRadius:near!,halfAngle:Math.PI/3},lookaheadSeconds:8,maxLookahead:maxLookahead!},
    fog:{near:near!,far:radius!},cameraFar:radius!*1.05};
}

/** Include the horizontal frustum plus a margin when the viewport is unusually wide. */
export function flightSectorHalfAngle(verticalFovDegrees:number,aspect:number):number {
  const horizontalHalf=Math.atan(Math.tan(verticalFovDegrees*Math.PI/360)*aspect);
  return Math.min(Math.PI,Math.max(Math.PI/3,horizontalHalf+Math.PI/18));
}
