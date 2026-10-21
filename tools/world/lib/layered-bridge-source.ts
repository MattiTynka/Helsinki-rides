import assert from 'node:assert/strict';
import {pointInPolygon,ringDistance,type Ring} from './geometry.ts';
import {layeredLocal,layeredTriangleHash,type LayeredLowerFieldSpec} from './layered-bridge-field.ts';
import type {SupportTriangle} from './tram-support-repair.ts';
import {supportNormal} from './tram-support-repair.ts';
import polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
export interface LayeredSourcePart {id:number;name:string;tag:string;rings:Ring[]}
export interface LayeredRetainingWay {id:number;points:[number,number][];upperEndpointIdentity?:boolean}
/** Native retaining-wall skins are offset by 10mm from their exact OSM axis.
 * The 25mm envelope includes both skins and Float32 projection error only. */
export function retainingWaysForTriangle(points:SupportTriangle,ways:readonly LayeredRetainingWay[]):number[]{
  const samples=points.map(p=>[p[0],p[2]] as [number,number]);for(let i=0;i<3;i++)samples.push([(points[i]![0]+points[(i+1)%3]![0])/2,(points[i]![2]+points[(i+1)%3]![2])/2]);
  return ways.filter(w=>samples.every(p=>w.points.slice(1).some((b,i)=>{const a=w.points[i]!,dx=b[0]-a[0],dz=b[1]-a[1],length2=dx*dx+dz*dz;if(!length2)return false;const u=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/length2));return Math.hypot(p[0]-a[0]-u*dx,p[1]-a[1]-u*dz)<=.025;}))).map(w=>w.id);
}
/** Mirror only the native street-part finish rules used by this bounded source
 * qualification. Unsupported types fail instead of gaining a guessed level. */
function partTag(p:Record<string,unknown>):string {
  const main=String(p.paatyyppi),sub=String(p.alatyyppi),mat=String(p.materiaali).toLowerCase();
  assert.ok(main==='Ajorata'||main==='Kevyt liikenne'||main==='Muu rakenneosa'||main==='Varusteet'||main==='Erityiskohteet','Unsupported layered bridge source-part kind');
  const level=main==='Ajorata'&&sub!=='Koroke'?'road':'raised';
  const finish=mat.includes('nurmi')?'grass':mat.includes('nupukivi')?'setts':mat.includes('noppakivi')||mat.includes('kenttäkivi')||mat.includes('mukulakivi')?'cobble':mat.includes('laatta')||mat.includes('betonikivi')||mat.includes('graniitti')?'slabs':mat.includes('sora')||mat.includes('kivituhka')||mat.includes('hiekka')?'gravel':mat.includes('asfaltti')?'asphalt':level==='road'?'asphalt':'slabs';return`${level}:${finish}`;
}
export function readLayeredSourceParts(geojson:any,ids:readonly number[],name:string):LayeredSourcePart[]{
  const result:LayeredSourcePart[]=[];for(const id of ids){const feature=geojson.features.find((f:any)=>f.properties?.osan_id===id);assert.ok(feature,`Missing named municipal source part${id}`);assert.equal(feature.properties.alueen_nimi,name,'Named municipal source part changed street');
    const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:undefined;assert.ok(polygons,'Source part must be polygonal');
    for(const polygon of polygons)result.push({id,name,tag:partTag(feature.properties),rings:polygon.map((ring:number[][])=>ring.map(([E,N])=>[E!-25497350,6672960-N!]))});
  }return result;
}
function inside(point:[number,number],part:LayeredSourcePart):boolean {return pointInPolygon(point,part.rings)||ringDistance(point,part.rings[0]!)<=.00025;}
export function sourcePartsForTriangle(points:SupportTriangle,parts:readonly LayeredSourcePart[],tag?:string):number[]{
  const test=points.map(p=>[p[0],p[2]] as [number,number]);for(let i=0;i<3;i++)test.push([(points[i]![0]+points[(i+1)%3]![0])/2,(points[i]![2]+points[(i+1)%3]![2])/2]);test.push([points.reduce((n,p)=>n+p[0],0)/3,points.reduce((n,p)=>n+p[2],0)/3]);
  const candidates=parts.filter(p=>!tag||tag===p.tag),single=candidates.filter(p=>test.every(q=>inside(q,p)));if(single.length)return[...new Set(single.map(p=>p.id))];
  // A native grid triangle may cross an administrative split between two
  // adjacent same-level municipal road pieces. Qualify their actual union;
  // testing one part at a time leaves an original terrain hump at that seam.
  if(!candidates.length||!test.every(q=>candidates.some(p=>inside(q,p))))return[];
  const ring=points.map(p=>[p[0],p[2]] as [number,number]),area=Math.abs(ring.reduce((n,a,i)=>{const b=ring[(i+1)%3]!;return n+a[0]*b[1]-a[1]*b[0];},0))/2;
  if(area<=1e-10)return[];const rest=polygonClipping.difference([[ring]],...candidates.map(p=>[p.rings]));
  for(const polygon of rest)for(const r of polygon)for(const q of r)if(!candidates.some(p=>p.rings.some(ring=>ringDistance(q,ring)<=.00025)))return[];
  return[...new Set(candidates.filter(p=>test.some(q=>inside(q,p))).map(p=>p.id))];
}
export function sourceBoundaryPartsForTriangle(points:SupportTriangle,parts:readonly LayeredSourcePart[],tolerance=.00025):number[]{
  const p=points.map(p=>[p[0],p[2]] as [number,number]),samples=[...p,...p.map((v,i)=>[(v[0]+p[(i+1)%3]![0])/2,(v[1]+p[(i+1)%3]![1])/2] as [number,number])];
  return[...new Set(parts.filter(part=>samples.every(q=>part.rings.some(r=>ringDistance(q,r)<=tolerance))).map(p=>p.id))];
}
export function sourceSkinPartsForTriangle(points:SupportTriangle,parts:readonly LayeredSourcePart[]):number[]{const samples=points.map(p=>[p[0],p[2]] as [number,number]);for(let i=0;i<3;i++)samples.push([(points[i]![0]+points[(i+1)%3]![0])/2,(points[i]![2]+points[(i+1)%3]![2])/2]);return[...new Set(parts.filter(p=>samples.every(q=>inside(q,p)||p.rings.some(r=>ringDistance(q,r)<=.025))).map(p=>p.id))];}
/** Exact lower source intersections for native fallback triangles crossing a
 * municipal boundary. Only the returned triangles own lowering; their outside
 * counterparts keep original source interpolation and height. */
export function lowerSourceTriangleMasks(points:SupportTriangle,parts:readonly LayeredSourcePart[],subtractParts:readonly LayeredSourcePart[]=[]):{partIds:number[];triangles:Ring[]}{
  const ring=points.map(p=>[p[0],p[2]] as [number,number]),area=(r:Ring)=>Math.abs(r.reduce((n,a,i)=>{const b=r[(i+1)%r.length]!;return n+a[0]*b[1]-a[1]*b[0];},0))/2;
  if(area(ring)<1e-9)return{partIds:[],triangles:[]};
  const selected=parts.filter(p=>polygonClipping.intersection([[ring]],[p.rings]).some(poly=>area(poly[0]!)>1e-8));if(!selected.length)return{partIds:[],triangles:[]};
  let intersection=polygonClipping.intersection([[ring]],polygonClipping.union([selected[0]!.rings],...selected.slice(1).map(p=>[p.rings])));if(subtractParts.length)intersection=polygonClipping.difference(intersection,...subtractParts.map(p=>[p.rings]));const triangles:Ring[]=[];
  for(const polygon of intersection){const flat:number[]=[],holes:number[]=[];for(const[i,r]of polygon.entries()){if(i)holes.push(flat.length/2);for(const p of r.slice(0,-1))flat.push(...p);}const indices=earcut(flat,holes,2);for(let i=0;i<indices.length;i+=3){const tri=indices.slice(i,i+3).map(k=>[flat[k*2]!,flat[k*2+1]!] as [number,number]);if(area(tri)>1e-9)triangles.push(tri);}}
  return{partIds:[...new Set(selected.map(p=>p.id))],triangles};
}
export function triangleMeetsLayeredDomain(points:SupportTriangle,spec:LayeredLowerFieldSpec):boolean {
  const local=points.map(p=>layeredLocal(spec,p)),[s0,t0,s1,t1]=spec.boundsST;return Math.min(...local.map(p=>p[0]))<=s1&&Math.max(...local.map(p=>p[0]))>=s0&&Math.min(...local.map(p=>p[1]))<=t1&&Math.max(...local.map(p=>p[1]))>=t0;
}
export function qualifyLayeredPhysicalTriangle(points:SupportTriangle,identity:{collider:string;triangle:number;group:string;tag:string},spec:LayeredLowerFieldSpec,parts:readonly LayeredSourcePart[],projectedUpperParts:readonly LayeredSourcePart[]){
  const hash=layeredTriangleHash(points),sourcePartIds=sourcePartsForTriangle(points,parts,identity.tag),upperPartIds=sourcePartsForTriangle(points,projectedUpperParts,identity.tag);
  let upwardFloor=false;try{upwardFloor=supportNormal(points)[1]>.3;}catch{/* A degenerate source face never gains mutation authority. */}
  const selected=(identity.group==='ground'||identity.group==='kerbs')&&upwardFloor&&triangleMeetsLayeredDomain(points,spec)&&sourcePartIds.length>0;
  return{...identity,sha256:hash,selected,sourcePartIds,projectedUpperPartIds:upperPartIds,protectedReason:!upwardFloor?'NOT_A_QUALIFIED_LOWER_UPWARD_FLOOR':null,ambiguity:selected&&upperPartIds.length>0?'EXACT_LOWER_AND_PROJECTED_UPPER_SOURCE_OVERLAP':null};
}
