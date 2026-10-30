import { supportsConvexFootprint, type GameplayBundle, type Vec2, type VehicleDefinition } from '@helsinki/world-schema';
import { rotate, type Quat, type V3 } from './math.ts';

export type VehicleCoverageDefinition = Pick<VehicleDefinition, 'collider' | 'wheels' | 'wheelRadius' | 'wheelWidth' | 'suspension'>;
type Coverage = Pick<GameplayBundle, 'playArea' | 'supportedArea'>;
export interface VehicleCoveragePose {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly steerAngle?: number;
}
export const VEHICLE_COVERAGE_CLEARANCE = 0.10;
interface Geometry { body: V3[]; wheels: { centre: V3; corners: V3[]; steer: boolean }[]; radius: number }
const cached = new WeakMap<VehicleCoverageDefinition, Geometry>();
const corners = (centre: readonly number[], half: readonly number[]): V3[] => [-1,1].flatMap(x => [-1,1].flatMap(y => [-1,1].map(z =>
  [centre[0]! + x * half[0]!, centre[1]! + y * half[1]!, centre[2]! + z * half[2]!] as V3)));
function geometry(def: VehicleCoverageDefinition): Geometry {
  let result = cached.get(def); if (result) return result;
  const body = [def.collider, ...(def.collider.skid ? [def.collider.skid] : [])].flatMap(box => corners(box.centre, box.halfExtents));
  // Vehicle.wheelLocal: socket + restLength - staticCompression - suspensionLength.
  // Include the full legal suspension interval, not just its currently sampled hub. Pitch/roll
  // therefore cannot move a later suspension update beyond the admitted footprint.
  const compression = 9.81 / (def.wheels.length * def.suspension.stiffness);
  const wheels = def.wheels.map(w => ({ centre: [w.position[0], w.position[1] - compression, w.position[2]] as V3,
    corners: corners([0,0,0], [def.wheelWidth / 2, def.wheelRadius + def.suspension.maxTravel, def.wheelRadius]), steer: w.steer }));
  const radius = Math.max(...body.map(p => Math.hypot(...p)), ...wheels.map(w => Math.hypot(...w.centre) + Math.max(...w.corners.map(p => Math.hypot(...p)))));
  result = { body, wheels, radius }; cached.set(def, result); return result;
}
/** Broad-phase/search bound only. Never use this orientation-independent circle to reject a pose. */
export function vehicleCoverageRadius(def: VehicleCoverageDefinition): number { return geometry(def).radius + VEHICLE_COVERAGE_CLEARANCE; }
function unit(q: VehicleCoveragePose['rotation']): Quat | null {
  const length = Math.hypot(...q); return q.every(Number.isFinite) && length > 1e-12 ? q.map(v => v / length) as Quat : null;
}
function valid(pose: VehicleCoveragePose): boolean { return pose.position.every(Number.isFinite) && !!unit(pose.rotation) && Number.isFinite(pose.steerAngle ?? 0); }
/** Monotone-chain hull of the projected physical boxes. Tyre boxes enclose the complete cylinders. */
function hull(input: readonly Vec2[]): Vec2[] {
  const p = [...input].sort((a,b) => a[0]-b[0] || a[1]-b[1]).filter((p,i,a) => !i || p[0] !== a[i-1]![0] || p[1] !== a[i-1]![1]);
  const turn = (a:Vec2,b:Vec2,c:Vec2) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const half = (list: readonly Vec2[]) => { const out:Vec2[]=[]; for(const point of list){while(out.length>=2 && turn(out[out.length-2]!,out[out.length-1]!,point)<=0)out.pop();out.push(point);}return out; };
  return [...half(p).slice(0,-1),...half(p.slice().reverse()).slice(0,-1)];
}
export function vehicleCoverageFootprint(def: VehicleCoverageDefinition, pose: VehicleCoveragePose): Vec2[] {
  if (!valid(pose)) return [];
  const q = unit(pose.rotation)!, shape = geometry(def), points: V3[] = [...shape.body], steer = pose.steerAngle ?? 0;
  for (const wheel of shape.wheels) for (const angle of wheel.steer && steer !== 0 ? [0,steer] : [0]) {
    // Zero-angle bound also contains the unsteered physical sidewall colliders.
    const c=Math.cos(angle),s=Math.sin(angle);
    for(const p of wheel.corners) points.push([wheel.centre[0]+p[0]*c+p[2]*s,wheel.centre[1]+p[1],wheel.centre[2]+p[2]*c-p[0]*s]);
  }
  return hull(points.map(p => {const r=rotate(q,p);return [pose.position[0]+r[0],pose.position[2]+r[2]] as Vec2;}));
}
export function supportsVehiclePose(gameplay: Coverage, def: VehicleCoverageDefinition, position: VehicleCoveragePose['position'], rotation: VehicleCoveragePose['rotation'], steerAngle = 0): boolean {
  return supportsConvexFootprint(gameplay, vehicleCoverageFootprint(def,{position,rotation,steerAngle}), VEHICLE_COVERAGE_CLEARANCE);
}
function angleBetween(a: VehicleCoveragePose, b: VehicleCoveragePose): number {
  const x=unit(a.rotation)!,y=unit(b.rotation)!;return 2*Math.acos(Math.min(1,Math.abs(x.reduce((s,v,i)=>s+v*y[i]!,0))));
}
/** Linear translation/steering and the shortest quaternion rotation used by the discrete physics step. */
export function interpolateVehicleCoveragePose(a: VehicleCoveragePose, b: VehicleCoveragePose, t: number): VehicleCoveragePose {
  const x=unit(a.rotation)!,raw=unit(b.rotation)!,dot=x.reduce((s,v,i)=>s+v*raw[i]!,0),y=dot<0?raw.map(v=>-v) as Quat:raw;
  const theta=Math.acos(Math.min(1,Math.abs(dot))),s=Math.sin(theta),u=s>1e-8?Math.sin((1-t)*theta)/s:1-t,v=s>1e-8?Math.sin(t*theta)/s:t;
  return {position:a.position.map((n,i)=>n+(b.position[i]!-n)*t) as V3,rotation:unit(x.map((n,i)=>n*u+y[i]!*v) as Quat)!,steerAngle:(a.steerAngle??0)+((b.steerAngle??0)-(a.steerAngle??0))*t};
}
/** Certifies a continuous conservative swept volume, rather than testing a finite list of poses.
 * A rotating point has |p''| <= R*(bodyAngle+steerAngle)^2, so its distance from
 * the endpoint chord is at most |p''|/8. The convex endpoint hull plus that radius
 * contains the entire interval. Subdivision reduces false rejection; it never admits an uncertified interval. */
export function supportsVehicleTransition(gameplay: Coverage, def: VehicleCoverageDefinition, from: VehicleCoveragePose, to: VehicleCoveragePose): boolean {
  if (!valid(from) || !valid(to)) return false;
  const first=vehicleCoverageFootprint(def,from),last=vehicleCoverageFootprint(def,to),clearance=VEHICLE_COVERAGE_CLEARANCE;
  if (!supportsConvexFootprint(gameplay,first,clearance) || !supportsConvexFootprint(gameplay,last,clearance)) return false;
  const radius=geometry(def).radius;
  function interval(a:VehicleCoveragePose,b:VehicleCoveragePose,pa:Vec2[],pb:Vec2[],depth:number):boolean {
    const angle=angleBetween(a,b)+Math.abs((b.steerAngle??0)-(a.steerAngle??0)),deviation=radius*angle*angle/8;
    if(supportsConvexFootprint(gameplay,hull([...pa,...pb]),clearance+deviation))return true;
    if(depth===12 || angle<1e-7)return false;
    const middle=interpolateVehicleCoveragePose(a,b,.5),pm=vehicleCoverageFootprint(def,middle);
    if(!supportsConvexFootprint(gameplay,pm,clearance))return false;
    return interval(a,middle,pa,pm,depth+1)&&interval(middle,b,pm,pb,depth+1);
  }
  return interval(from,to,first,last,0);
}
export function supportedVehicleMotionFraction(gameplay: Coverage, def: VehicleCoverageDefinition, from: VehicleCoveragePose, to: VehicleCoveragePose): number {
  if (!gameplay.supportedArea || supportsVehicleTransition(gameplay,def,from,to)) return 1;
  if (!valid(from) || !valid(to) || !supportsVehiclePose(gameplay,def,from.position,from.rotation,from.steerAngle)) return 0;
  let low=0,high=1;
  for(let i=0;i<24;i++){const middle=(low+high)/2;if(supportsVehicleTransition(gameplay,def,from,interpolateVehicleCoveragePose(from,to,middle)))low=middle;else high=middle;}
  // Reduce ordinary Float32 drift before applying the candidate. Tangential motion
  // can still have less inward slack than this travel backoff; Vehicle certifies
  // the actual Rapier readback and retreats further when necessary.
  const radius=geometry(def).radius,travel=Math.hypot(to.position[0]-from.position[0],to.position[2]-from.position[2])
    +radius*(angleBetween(from,to)+Math.abs((to.steerAngle??0)-(from.steerAngle??0)));
  const rounding=Math.max(1e-4,Math.max(...from.position.map(Math.abs),...to.position.map(Math.abs),radius)*2**-22);
  return Math.max(0,low-rounding/Math.max(travel,rounding));
}
