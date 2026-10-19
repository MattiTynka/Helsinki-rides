import type { RoadIndex, Vec3 } from '../../../packages/world-schema/src/index.ts';
import { keyboardDriveLookahead, KEYBOARD_DRIVE_WHEELBASE } from './keyboard-driving.ts';

// The preview covers braking before a tight bend at the existing10m/s cap.
// Explicit reversing maneuvers retain the proven steering policy throughout
// this same horizon; sub-metre graph seams are not ordinary lane bends.
export const DRIVING_PREVIEW_DISTANCE = 45;
export const DRIVING_BEND_LOOKAHEAD = 2.5;
const PREVIEW_DECELERATION = 2;
const MIN_BEND_ANGLE = .55;
interface Bend { index: number; arc: number; angle: number; speed: number }
interface Maneuver { centre: Vec3; radius: number; kind: 'reversal' | 'microconnector' }
export interface DrivingRouteHints {
  readonly points: readonly Vec3[];
  readonly arc: Float64Array;
  readonly bends: readonly Bend[];
  readonly maneuvers: readonly Maneuver[];
}
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);
export function buildDrivingRouteHints(index: RoadIndex, route: readonly string[], points: readonly Vec3[], maxSpeed: number): DrivingRouteHints {
  const arc=new Float64Array(points.length),bends:Bend[]=[],maneuvers:Maneuver[]=[];
  for(let i=1;i<points.length;i++)arc[i]=arc[i-1]!+distance(points[i-1]!,points[i]!);
  const bendIndices=new Set<number>();
  // Inspect source lane interiors before densification. Connector curves and
  // their tiny joins retain the original steering/maneuver behavior.
  for(const id of route){const lane=index.laneById.get(id);if(!lane)continue;
    for(let j=1;j<lane.points.length-1;j++){
      const a=lane.points[j-1]!,b=lane.points[j]!,c=lane.points[j+1]!;
      const ux=b[0]-a[0],uz=b[2]-a[2],vx=c[0]-b[0],vz=c[2]-b[2],lu=Math.hypot(ux,uz),lv=Math.hypot(vx,vz);
      if(lu<.75||lv<.75)continue;const angle=Math.acos(Math.max(-1,Math.min(1,(ux*vx+uz*vz)/(lu*lv))));
      if(angle<MIN_BEND_ANGLE||angle>2.5)continue;
      for(let i=1;i<points.length-1;i++)if(!bendIndices.has(i)&&distance(points[i]!,b)<.025){
        bendIndices.add(i);bends.push({index:i,arc:arc[i]!,angle,speed:Math.max(2.4,Math.min(7,Math.sqrt(2.5*3/Math.max(.1,2*Math.sin(angle/2)))))});
      }
    }
  }
  bends.sort((a,b)=>a.arc-b.arc);
  for(const id of route){const c=index.connectorById.get(id);if(!c||c.length>=2||!c.points.length)continue;
    const reversal=c.turn==='u-turn',oscillation=distance(c.points[0]!,c.points.at(-1)!)<c.length*.5;
    if(!reversal&&!oscillation)continue;
    maneuvers.push({centre:c.points[0]!,kind:reversal?'reversal':'microconnector',radius:reversal?DRIVING_PREVIEW_DISTANCE:keyboardDriveLookahead(maxSpeed)+KEYBOARD_DRIVE_WHEELBASE});
  }
  return{points,arc,bends,maneuvers};
}
export function previewDrivingRoute(hints: DrivingRouteHints | null, aimCursor: number, position: Vec3, speed: number, maxSpeed: number) {
  const baseline={maxSpeed,lookahead:keyboardDriveLookahead(speed),maneuver:false};
  if(!hints||!hints.points.length)return baseline;
  if(hints.maneuvers.some(m=>distance(position,m.centre)<=m.radius))return{...baseline,maneuver:true};
  let closest=Math.max(0,aimCursor-15),best=Infinity;
  for(let i=closest;i<Math.min(hints.points.length,aimCursor+10);i++){const d=distance(position,hints.points[i]!);if(d<best){best=d;closest=i;}}
  let limit=maxSpeed,near=false;
  for(const bend of hints.bends){const ahead=bend.arc-hints.arc[closest]!;if(ahead<0)continue;if(ahead>DRIVING_PREVIEW_DISTANCE)break;
    limit=Math.min(limit,Math.sqrt(bend.speed**2+2*PREVIEW_DECELERATION*Math.max(0,ahead-3)));
    if(ahead<Math.max(12,(speed**2-bend.speed**2)/(2*PREVIEW_DECELERATION)+3))near=true;
  }
  return{maxSpeed:limit,lookahead:near?DRIVING_BEND_LOOKAHEAD:baseline.lookahead,maneuver:false};
}
