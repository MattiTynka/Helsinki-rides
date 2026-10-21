import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {sourcePartsForTriangle,type LayeredSourcePart} from './layered-bridge-source.ts';
import {extraBridgeWorld,type ExtraBridgeFrame,type ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
import {deliverySha} from './delivery-city-payloads.ts';
import {supportHeight,supportNormal,type SupportTriangle,type SupportVertex} from './tram-support-repair.ts';
import {geodeticToGk25} from '../../../packages/world-schema/src/index.ts';

export interface ExtraBridgePier {
  id:string;kind:'concrete-inverted-v'|'painted-steel-column';
  /** Authored architectural dimensions; native named lower soil is the bearing authority. */
  sourcePartId:number;upperPartId:number;
  feetST:[number,number][];topST:[number,number];
  widthS:number;widthT:number;topWidthS:number;topWidthT:number;
  bearing:{minimumY:number;maximumY:number;triangles:{cell:string;collider:string;triangle:number;sha256:string}[]}[];
}
const area=(polygons:polygonClipping.MultiPolygon)=>polygons.reduce((sum,poly)=>sum+poly.reduce((v,ring,i)=>v+(i?-1:1)*Math.abs(ring.reduce((a,p,j)=>{const q=ring[(j+1)%ring.length]!;return a+p[0]*q[1]-q[0]*p[1];},0)/2),0),0);
export function extraBridgePierRectangle(frame:ExtraBridgeFrame,st:readonly[number,number],widthS:number,widthT:number){
  assert.ok(widthS>=.2&&widthS<=1&&widthT>=.2&&widthT<=1.2);
  return[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]].map(([s,t])=>extraBridgeWorld(frame,st[0]+s!*widthS/2,st[1]+t!*widthT/2));
}
/** Complete source and native triangle coverage, rather than a closest vertex,
 * binds every footing. Lower floors remain literal beneath a buried 10cm base. */
export function qualifyExtraBridgePierBearing(frame:ExtraBridgeFrame,st:readonly[number,number],widthS:number,widthT:number,part:LayeredSourcePart,faces:readonly ExtraBridgeNativeFace[]){
  const ring=extraBridgePierRectangle(frame,st,widthS,widthT),footprint:polygonClipping.MultiPolygon=[[ring]],expected=widthS*widthT;
  assert.ok(area(polygonClipping.difference(footprint,[part.rings]))<1e-8,'A complete footing must lie inside its named lower source part');
  const covers:polygonClipping.MultiPolygon=[],triangles=[],heights:number[]=[];
  for(const face of faces){if(face.group!=='ground'||!sourcePartsForTriangle(face.points,[part],face.tag).includes(part.id))continue;try{if(supportNormal(face.points)[1]<.7)continue;}catch{continue;}
    const intersection=polygonClipping.intersection(footprint,[[face.points.map(p=>[p[0],p[2]])]]);if(!intersection.length)continue;
    covers.push(...intersection);triangles.push({cell:face.cell,collider:face.collider,triangle:face.triangle,sha256:deliverySha(JSON.stringify(face.points))});
    for(const polygon of intersection)for(const r of polygon)for(const p of r)heights.push(supportHeight(face.points,p));
  }
  assert.ok(covers.length&&Math.abs(area(polygonClipping.union(covers[0]!,...covers.slice(1)))-expected)<1e-7,'A complete footing needs actual native lower floor, with no gap or invented terrain fallback');
  const minimumY=Math.min(...heights),maximumY=Math.max(...heights);assert.ok(maximumY-minimumY<.25,'A footing cannot span stacked floors or an unsupported steep bank');
  return{minimumY,maximumY,triangles};
}
export function extraBridgePierFaces(frame:ExtraBridgeFrame,pier:ExtraBridgePier,topHeight:(s:number,t:number)=>number){
  assert.match(pier.id,/^[a-z][a-z0-9-]+$/);assert.equal(pier.feetST.length,pier.kind==='concrete-inverted-v'?2:1);assert.equal(pier.bearing.length,pier.feetST.length);
  const faces:{points:SupportTriangle;normal:SupportVertex}[]=[],f32=(p:readonly number[])=>p.map(Math.fround)as SupportVertex;
  for(const[i,foot]of pier.feetST.entries()){
    const bottom=extraBridgePierRectangle(frame,foot,pier.widthS,pier.widthT).slice(0,4).map(([x,z])=>f32([x,pier.bearing[i]!.minimumY-.1,z])),topRing=extraBridgePierRectangle(frame,pier.topST,pier.topWidthS,pier.topWidthT).slice(0,4),top=topRing.map(([x,z])=>{
      const[dx,dz]=frame.direction,xx=x-frame.origin[0],zz=z-frame.origin[1],s=xx*dx+zz*dz,t=-xx*dz+zz*dx;return f32([x,topHeight(s,t),z]);
    });assert.ok(Math.min(...top.map(p=>p[1]))>pier.bearing[i]!.maximumY+2.5,'A structural leg needs actual vertical clearance');
    const centre=bottom.concat(top).reduce<number[]>((p,q)=>p.map((v,j)=>v+q[j]!/8),[0,0,0]);
    for(const quad of[[bottom[3]!,bottom[2]!,bottom[1]!,bottom[0]!],top,...[0,1,2,3].map(j=>[bottom[j]!,bottom[(j+1)%4]!,top[(j+1)%4]!,top[j]!])])for(let k=1;k<3;k++){
      let tri=[quad[0]!,quad[k]!,quad[k+1]!]as SupportTriangle,n=supportNormal(tri),mid=tri[0].map((v,j)=>(v+tri[1][j]!+tri[2][j]!)/3-centre[j]!);if(n.reduce((v,q,j)=>v+q*mid[j]!,0)<0){tri=[tri[0],tri[2],tri[1]];n=supportNormal(tri);}faces.push({points:tri,normal:n});
    }
  }return faces;
}
/** Strong level-independent keep-out: the entire support's projected hull
 * avoids every other named lower carriageway/walk/cycle polygon. */
export function qualifyExtraBridgePierKeepOut(frame:ExtraBridgeFrame,pier:ExtraBridgePier,lowerParts:readonly LayeredSourcePart[]){
  const hull=(points:[number,number][])=>{const sorted=points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]),cross=(o:number[],a:number[],b:number[])=>(a[0]!-o[0]!)*(b[1]!-o[1]!)-(a[1]!-o[1]!)*(b[0]!-o[0]!),half=(p:[number,number][])=>{const r:[number,number][]=[];for(const q of p){while(r.length>1&&cross(r.at(-2)!,r.at(-1)!,q)<=0)r.pop();r.push(q);}return r.slice(0,-1);};return half(sorted).concat(half([...sorted].reverse()));};
  const all=pier.feetST.flatMap(p=>extraBridgePierRectangle(frame,p,pier.widthS,pier.widthT).slice(0,4)).concat(extraBridgePierRectangle(frame,pier.topST,pier.topWidthS,pier.topWidthT).slice(0,4)),ring=hull(all),footprint:polygonClipping.MultiPolygon=[[ring]],checked=[];
  for(const part of lowerParts){if(part.id===pier.sourcePartId)continue;const overlap=area(polygonClipping.intersection(footprint,[part.rings]));assert.ok(overlap<1e-8,`Structural support overlaps retained lower public part ${part.id}`);checked.push(part.id);}return{sourcePartId:pier.sourcePartId,excludedLowerPartIds:checked,projectedSupportHull:ring};
}
export function qualifyExtraBridgePierAxes(osm:any,frame:ExtraBridgeFrame,pier:ExtraBridgePier,upperRoadIds:readonly number[]){
  const hull=qualifyExtraBridgePierKeepOut(frame,pier,[]).projectedSupportHull,project=(node:any)=>{const[E,N]=geodeticToGk25(node.lat,node.lon);return[E-25497350,6672960-N]as[number,number];},nodes=new Map<number,[number,number]>(osm.elements.filter((e:any)=>e.type==='node').map((e:any)=>[e.id,project(e)])),distance=(p:readonly number[],a:readonly number[],b:readonly number[])=>{const dx=b[0]!-a[0]!,dz=b[1]!-a[1]!,v=Math.max(0,Math.min(1,((p[0]!-a[0]!)*dx+(p[1]!-a[1]!)*dz)/(dx*dx+dz*dz)));return Math.hypot(p[0]!-a[0]!-v*dx,p[1]!-a[1]!-v*dz);},near=[];
  for(const way of osm.elements.filter((e:any)=>e.type==='way'&&(e.tags?.highway||e.tags?.railway==='tram'))){if(upperRoadIds.includes(way.id)||way.tags.bridge&&way.tags.bridge!=='no'||way.tags.tunnel&&way.tags.tunnel!=='no')continue;const axis=way.nodes.map((id:number)=>nodes.get(id));assert.ok(axis.every(Boolean));let minimum=Infinity;
    const side=(a:readonly number[],b:readonly number[],p:readonly number[])=>(b[0]!-a[0]!)*(p[1]!-a[1]!)-(b[1]!-a[1]!)*(p[0]!-a[0]!);
    for(let i=1;i<axis.length;i++)for(let j=0;j<hull.length;j++){const a=axis[i-1]!,b=axis[i]!,u=hull[j]!,v=hull[(j+1)%hull.length]!,crossing=side(a,b,u)*side(a,b,v)<0&&side(u,v,a)*side(u,v,b)<0;minimum=Math.min(minimum,crossing?0:Infinity,distance(u,a,b),distance(v,a,b),distance(a,u,v),distance(b,u,v));}
    const required=['footway','cycleway','path','steps','pedestrian'].includes(way.tags.highway)?1.05:way.tags.railway==='tram'?2:2.6;
    assert.ok(minimum>=required,`Support blocks mapped lower public axis ${way.id}: ${minimum}m < ${required}m`);if(minimum<10)near.push({wayId:way.id,tags:way.tags,minimumMetres:minimum,requiredMetres:required});
  }return{upperRoadIds,nearLowerAxes:near,policy:'Entire projected structural hull remains clear of lower mapped road, tram and foot/cycle axes with bounded vehicle/capsule half-widths.'};
}
