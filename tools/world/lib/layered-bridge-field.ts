import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {SupportTriangle,SupportVertex} from './tram-support-repair.ts';
import {supportHeight,supportNormal} from './tram-support-repair.ts';
import type {TramPoint} from './tram-visuals.ts';

export interface LayeredBridgeAxis {
  sourceWayIds:number[];
  sourcePartIds?:number[];
  /** Source-mapped [along-upper-bridge, across-upper-bridge] metres. */
  pointsST:readonly TramPoint[];
}
export interface LayeredLowerFieldSpec {
  originXZ:TramPoint;
  directionXZ:TramPoint;
  /** [minimum s, minimum t, maximum s, maximum t]. */
  boundsST:[number,number,number,number];
  endFadeMetres:number;
  crossSectionFadeMetres?:number;
  gridMetres:number;
  /** Parallel lower roads/paths, in increasing s order. Each spans both bank cuts. */
  axes:LayeredBridgeAxis[];
}
export const layeredTriangleKey=(points:SupportTriangle)=>points.map(p=>p.map(Math.fround).join(',')).sort().join('|');
export function layeredTriangleHash(points:SupportTriangle):string {
  const b=Buffer.alloc(36);points.flat().forEach((v,i)=>b.writeFloatLE(Math.fround(v),i*4));return createHash('sha256').update(b).digest('hex');
}
export function layeredLocal(spec:LayeredLowerFieldSpec,p:readonly number[]):TramPoint {
  const [dx,dz]=spec.directionXZ,x=p[0]!-spec.originXZ[0],z=p[2]!-spec.originXZ[1];return[x*dx+z*dz,x*dz-z*dx];
}
export function layeredWorld(spec:LayeredLowerFieldSpec,s:number,t:number):TramPoint {
  const [dx,dz]=spec.directionXZ;return[spec.originXZ[0]+dx*s+dz*t,spec.originXZ[1]+dz*s-dx*t];
}
export function layeredRectangle(spec:LayeredLowerFieldSpec):TramPoint[]{const [a,b,c,d]=spec.boundsST;return[layeredWorld(spec,a,b),layeredWorld(spec,c,b),layeredWorld(spec,c,d),layeredWorld(spec,a,d)];}

/** The sampler is built exclusively from explicitly qualified physical ground,
 * never architectural or upper-deck triangles. */
export function layeredFloorSampler(floors:readonly SupportTriangle[],minimumNormalY=.3):(x:number,z:number)=>number {
  const bins=new Map<string,SupportTriangle[]>();
  for(const tri of floors){let n:SupportVertex;try{n=supportNormal(tri);}catch{continue;}if(n[1]<=minimumNormalY)continue;
    for(let x=Math.floor(Math.min(...tri.map(p=>p[0]))/4);x<=Math.floor(Math.max(...tri.map(p=>p[0]))/4);x++)for(let z=Math.floor(Math.min(...tri.map(p=>p[2]))/4);z<=Math.floor(Math.max(...tri.map(p=>p[2]))/4);z++){const k=`${x},${z}`,v=bins.get(k)??[];v.push(tri);bins.set(k,v);}
  }
  return(x,z)=>{let y=-Infinity;const nearby=new Set<SupportTriangle>();for(const dx of [-.00025,0,.00025])for(const dz of [-.00025,0,.00025])for(const t of bins.get(`${Math.floor((x+dx)/4)},${Math.floor((z+dz)/4)}`)??[])nearby.add(t);
    for(const tri of nearby){const [a,b,c]=tri,den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(den)<1e-14)continue;const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/den,v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/den,weights=[u,v,1-u-v];
      // Projected source rings are float64 while native ground is Float32.
      // Allow at most 0.25 mm perpendicular to an actual source edge, never
      // enough to bridge a gameplay gap or infer a missing road floor.
      const accepted=weights.every((w,i)=>{const b=tri[(i+1)%3]!,c=tri[(i+2)%3]!,altitude=Math.abs(den)/Math.hypot(c[0]-b[0],c[2]-b[2]);return w>=0||-w*altitude<=.00025;});
      if(accepted)y=Math.max(y,supportHeight(tri,[x,z]));}return y;};
}
export function layeredAxisAt(axis:LayeredBridgeAxis,t:number):number {
  const points=[...axis.pointsST].sort((a,b)=>a[1]-b[1]);assert.ok(points.length>=2);
  assert.ok(t>=points[0]![1]-1e-7&&t<=points.at(-1)![1]+1e-7,'A lower source axis does not reach its joining bank');
  let i=0;while(i<points.length-2&&points[i+1]![1]<t)i++;
  const a=points[i]!,b=points[i+1]!;assert.ok(b[1]-a[1]>1e-7,'Duplicate lower-axis across coordinate');return a[0]+(b[0]-a[0])*(t-a[1])/(b[1]-a[1]);
}
/** Follow corresponding same-carriageway cross sections, including the lower
 * cycle path's source bend. A single straight line through the whole road and
 * cycle corridor would sample the wrong surface on the west bank. */
export function correspondingBankS(spec:LayeredLowerFieldSpec,s:number,t:number,bankT:number):number {
  const now=spec.axes.map(a=>layeredAxisAt(a,t)),bank=spec.axes.map(a=>layeredAxisAt(a,bankT));assert.ok(now.length>=2);
  assert.ok(now.every((v,i)=>!i||v-now[i-1]!>.00001),'Lower source axes cross or change their ordering');
  let i=0;while(i<now.length-2&&now[i+1]!<s)i++;const u=(s-now[i]!)/(now[i+1]!-now[i]!);return bank[i]!+(bank[i+1]!-bank[i]!)*u;
}
export function buildLayeredLowerField(spec:LayeredLowerFieldSpec,sourceFloor:(x:number,z:number)=>number){
  assert.ok(Math.abs(Math.hypot(...spec.directionXZ)-1)<1e-8);const [s0,t0,s1,t1]=spec.boundsST;
  assert.ok(s1>s0&&t1>t0&&spec.endFadeMetres>0&&spec.endFadeMetres<(s1-s0)/2);assert.ok(spec.gridMetres>0&&spec.gridMetres<=.5);
  const source=(s:number,t:number)=>{const p=layeredWorld(spec,s,t),y=sourceFloor(p[0],p[1]);assert.ok(Number.isFinite(y),`Missing qualified lower support at s=${s},t=${t}`);return y;};
  const target=(s:number,t:number)=>{const a=source(correspondingBankS(spec,s,t,t0),t0),b=source(correspondingBankS(spec,s,t,t1),t1);return a+(b-a)*(t-t0)/(t1-t0);};
  const delta=(p:readonly number[])=>{const [s,t]=layeredLocal(spec,p);if(s<=s0+1e-8||s>=s1-1e-8||t<=t0+1e-8||t>=t1-1e-8)return 0;
    const atReference=correspondingBankS(spec,s,t,0),low=layeredAxisAt(spec.axes[0]!,0),high=layeredAxisAt(spec.axes.at(-1)!,0);if(atReference<=low+1e-8||atReference>=high-1e-8)return 0;
    const crossFade=spec.crossSectionFadeMetres??.5;assert.ok(crossFade>0&&crossFade<=2);
    const desired=target(s,t);if(p[1]!<=desired)return 0;const top=source(s,t),fade=Math.min(1,(s-s0)/spec.endFadeMetres,(s1-s)/spec.endFadeMetres,(atReference-low)/crossFade,(high-atReference)/crossFade);return Math.min(0,desired-top)*fade;};
  return{spec,target,source,delta,map:(p:SupportVertex):SupportVertex=>{const dy=delta(p);return dy===0?p:[p[0],Math.fround(p[1]+dy),p[2]];}};
}
