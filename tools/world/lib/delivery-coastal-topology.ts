// Canonical boundary intervals, including weakly-simple source holes that touch
// the outer ring. Shared dry/dry edges are not shore and must not gain a wall.
import assert from 'node:assert/strict';
import {pointInPolygon,type LocalPolygon} from './geometry.ts';
import type {ShoreAuthoritySegment} from './coastal-shore-seals.ts';
type Point=[number,number];
type Edge={id:string;polygon:string;ring:number;a:Point;b:Point;length:number};
const cross=(a:Point,b:Point)=>a[0]*b[1]-a[1]*b[0];
const sub=(a:Point,b:Point):Point=>[a[0]-b[0],a[1]-b[1]];
function distance(p:Point,a:Point,b:Point){const d=sub(b,a),t=Math.max(0,Math.min(1,((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/(d[0]*d[0]+d[1]*d[1])));return Math.hypot(p[0]-a[0]-t*d[0],p[1]-a[1]-t*d[1]);}
export function canonicalDeliveryShore(water:readonly LocalPolygon[],area:{minX:number;maxX:number;minZ:number;maxZ:number}){
  const edges:Edge[]=[],bins=new Map<string,Edge[]>(),roundoff=64*Number.EPSILON*Math.max(1,...[area.minX,area.maxX,area.minZ,area.maxZ].map(Math.abs));
  const keys=(a:Point,b:Point)=>{const result:string[]=[];for(let x=Math.floor((Math.min(a[0],b[0])-roundoff)/64);x<=Math.floor((Math.max(a[0],b[0])+roundoff)/64);x++)for(let z=Math.floor((Math.min(a[1],b[1])-roundoff)/64);z<=Math.floor((Math.max(a[1],b[1])+roundoff)/64);z++)result.push(x+','+z);return result;};
  for(const p of water)for(const[ri,ring]of p.rings.entries())for(let i=0;i<ring.length;i++){const aa=ring[i]!,bb=ring[(i+1)%ring.length]!,a:Point=[aa[0],-aa[1]],b:Point=[bb[0],-bb[1]],length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!length)continue;const edge={id:`${p.id}:${ri}:${i}`,polygon:p.id,ring:ri,a,b,length};edges.push(edge);for(const key of keys(a,b)){const list=bins.get(key)??[];list.push(edge);bins.set(key,list);}}
  const contains=(p:Point)=>water.some(w=>p[0]>=w.bbox[0]&&p[0]<=w.bbox[2]&&-p[1]>=w.bbox[1]&&-p[1]<=w.bbox[3]&&pointInPolygon([p[0],-p[1]],w.rings));
  const segments:ShoreAuthoritySegment[]=[],omittedSharedIntervals:{source:string;interval:[number,number];sharedWith:string[];bothSides:'dry'|'wet'}[]=[],splitIntervals:{source:string;cuts:number[]}[]=[];
  for(const edge of edges){
    if(edge.length<.001)continue;const{a,b}=edge;
    if([area.minX,area.maxX].some(x=>Math.abs(a[0]-x)<.001&&Math.abs(b[0]-x)<.001)||[area.minZ,area.maxZ].some(z=>Math.abs(a[1]-z)<.001&&Math.abs(b[1]-z)<.001))continue;
    const candidates=[...new Set(keys(a,b).flatMap(k=>bins.get(k)??[]))].filter(q=>q!==edge),d=sub(b,a),station=(p:Point)=>((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/(edge.length*edge.length),lineDistance=(p:Point)=>Math.abs(cross(d,sub(p,a)))/edge.length,cuts=new Set([0,1]),collinear:Edge[]=[];
    for(const q of candidates){if(lineDistance(q.a)<=roundoff&&lineDistance(q.b)<=roundoff){collinear.push(q);for(const p of[q.a,q.b]){const t=station(p);if(t>0&&t<1)cuts.add(t);}continue;}const e=sub(q.b,q.a),den=cross(d,e);if(den===0)continue;const c=sub(q.a,a),t=cross(c,e)/den,u=cross(c,d)/den;if(t>0&&t<1&&u>=0&&u<=1)cuts.add(t);}
    const ordered=[...cuts].sort((x,y)=>x-y);if(ordered.length>2)splitIntervals.push({source:edge.id,cuts:ordered});
    for(let i=0;i<ordered.length-1;i++){
      const lo=ordered[i]!,hi=ordered[i+1]!;if((hi-lo)*edge.length<.001)continue;const at=(t:number):Point=>t===0?a:t===1?b:[a[0]+d[0]*t,a[1]+d[1]*t],A=at(lo),B=at(hi),mid=at((lo+hi)/2),nx=-d[1]/edge.length,nz=d[0]/edge.length;
      let clearance=Infinity;for(const q of candidates)if(!collinear.includes(q))clearance=Math.min(clearance,distance(mid,q.a,q.b));const epsilon=Math.min(.0001,(hi-lo)*edge.length/8,clearance/8);assert.ok(epsilon>roundoff*2,`Unrepresentable source boundary interval:${edge.id}/${i}`);
      const left=contains([mid[0]+nx*epsilon,mid[1]+nz*epsilon]),right=contains([mid[0]-nx*epsilon,mid[1]-nz*epsilon]);
      if(left===right){const shared=collinear.filter(q=>{const u=station(q.a),v=station(q.b);return Math.min(u,v)<=lo+roundoff/edge.length&&Math.max(u,v)>=hi-roundoff/edge.length;});assert.ok(shared.length,`Ambiguous non-shared canonical water edge:${edge.id}/${i}`);omittedSharedIntervals.push({source:edge.id,interval:[lo,hi],sharedWith:shared.map(q=>q.id),bothSides:left?'wet':'dry'});continue;}
      segments.push({id:ordered.length===2?edge.id:`${edge.id}:interval${i}`,a:A,b:B,drySide:left?-1:1});
    }
  }
  return{segments,topology:{sourceEdges:edges.length,classifiedSegments:segments.length,roundoffBoundMetres:roundoff,splitIntervals,omittedSharedIntervals,method:'Exact source edge arrangement; every interval classified on both actual union sides below nearest noncollinear boundary clearance. Only source-collinear FP64 shared edges with identical side classification omitted. No source polygon, floor, physical precision or coast coordinate is buffered.'}};
}
