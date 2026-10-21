// Separate individually pinned inland features from the sea-level coast cut.
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {bbox,cleanRing,ensureCcw,pointInPolygon,ringDistance,signedArea,type LocalPolygon,type Pt} from './geometry.ts';
import {clipCoastalGround,type CoastalMask,type CoastalClipGeometry} from './coastal-mask.ts';
import {prepareNativeFrontier} from './frontier-ground.ts';
import type {GroundPiece} from './ground.ts';
import {parseCollisionBundle,encodeCollisionBundle,geodeticToGk25,type TerrainGrid} from '../../../packages/world-schema/src/index.ts';

export interface InlandWaterBody {type:'way'|'relation';id:number;tags:Record<string,string>;rings:Pt[][];reason:string}
export interface InlandWaterProfile {
  schemaVersion:1;kind:'source-bound-new-inland-water-separation';
  newRegionXZ:[number,number,number,number];seaWaterY:number;
  sourceOsmSha256:string;nativeMetadataSha256:string;
  bodies:InlandWaterBody[];
}
const geometry=(polys:readonly LocalPolygon[])=>polys.map(p=>p.rings) as CoastalClipGeometry;
export function inlandPolygons(g:CoastalClipGeometry):LocalPolygon[]{return g.filter(p=>p.length).map((p,i)=>{const rings=p.map((r,k)=>k?cleanRing(r):ensureCcw(cleanRing(r)));return{id:`inland-separation-${i}`,rings,bbox:bbox(rings),properties:{}};});}

/** Downstream tree/shore classification must use the repaired water union, not
 * the original sea cut. Deck geometry remains a separate, unchanged authority. */
export function retainedInlandCoastalReport(original:{mask:CoastalMask;decks:{polygons:readonly LocalPolygon[]};waterY:number},retainedWater:readonly LocalPolygon[]){
  return{coastal:{mask:{area:structuredClone(original.mask.area),water:structuredClone(retainedWater)},decks:{polygons:original.decks.polygons.map(p=>({id:p.id,rings:structuredClone(p.rings),bbox:structuredClone(p.bbox),properties:{}}))},waterY:original.waterY}};
}

export function sourceInlandBody(osm:{elements:any[]},type:'way'|'relation',id:number,origin:readonly number[]){
  const source=osm.elements.find(e=>e.type===type&&e.id===id);assert.ok(source,'Missing named inland source');assert.equal(source.tags?.natural,'water');
  const nodes=new Map<number,Pt>();for(const e of osm.elements)if(e.type==='node'&&Number.isFinite(e.lat)&&Number.isFinite(e.lon)){const [x,n]=geodeticToGk25(e.lat,e.lon);nodes.set(e.id,[x-origin[0]!,n-origin[1]!]);}
  const ring=(way:any)=>{assert.ok(way?.nodes?.length>=4&&way.nodes[0]===way.nodes.at(-1),'Reviewed inland members must be closed source rings');return cleanRing(way.nodes.map((n:number)=>{const p=nodes.get(n);assert.ok(p,'Missing inland source node');return p;}));};
  let selected:CoastalClipGeometry;
  if(type==='way')selected=[[ensureCcw(ring(source))]];
  else{const outer:Pt[][]=[],inner:Pt[][]=[];assert.equal(source.tags.type,'multipolygon');for(const m of source.members??[]){assert.equal(m.type,'way');assert.ok(m.role==='outer'||m.role==='inner');(m.role==='outer'?outer:inner).push(ring(osm.elements.find(e=>e.type==='way'&&e.id===m.ref)));}assert.ok(outer.length);selected=polygonClipping.union(...outer.map(r=>[[r]]) as [CoastalClipGeometry,...CoastalClipGeometry[]]) as CoastalClipGeometry;if(inner.length)selected=polygonClipping.difference(selected,...inner.map(r=>[[r]])) as CoastalClipGeometry;}
  const polys=inlandPolygons(selected);assert.equal(polys.length,1,'This bounded profile requires one polygon per source body');return{type,id,tags:structuredClone(source.tags) as Record<string,string>,rings:polys[0]!.rings};
}

export function qualifyInlandDomain(profile:InlandWaterProfile,osm:{elements:any[]},original:CoastalMask,decks:readonly LocalPolygon[],origin:readonly number[],independentWater:readonly LocalPolygon[]){
  assert.equal(profile.schemaVersion,1);assert.equal(profile.kind,'source-bound-new-inland-water-separation');
  assert.ok(profile.bodies.length>0&&profile.bodies.length<=32);assert.ok(Number.isFinite(profile.seaWaterY));
  const r=profile.newRegionXZ;assert.ok(r.length===4&&r.every(Number.isFinite)&&r[0]<r[2]&&r[1]<r[3]);
  assert.ok(r[3]<=-1152,'This repair is restricted to the newly acquired north strip');
  const seen=new Set<string>();
  for(const body of profile.bodies){const key=`${body.type}/${body.id}`;assert.ok(!seen.has(key),'Duplicate inland identity');seen.add(key);assert.ok(body.reason.length>20);const source=sourceInlandBody(osm,body.type,body.id,origin);assert.deepEqual(body.tags,source.tags,'All original source tags must be retained');assert.deepEqual(body.rings,source.rings,'Inland rings must be the exact projected source geometry');assert.notEqual(source.tags.salt,'yes');}
  const source=polygonClipping.union(...profile.bodies.map(b=>[b.rings]) as [CoastalClipGeometry,...CoastalClipGeometry[]]) as CoastalClipGeometry;
  const rectangle:CoastalClipGeometry=[[[[r[0],-r[3]],[r[2],-r[3]],[r[2],-r[1]],[r[0],-r[1]]]]];
  const reviewed=polygonClipping.intersection(source,rectangle,geometry(original.water)) as CoastalClipGeometry;
  // Other source ways/relations and the sea can independently cover this area.
  // Subtracting a selected way from their union would wrongly invent land.
  const protectedWater=independentWater.length?polygonClipping.intersection(reviewed,geometry(independentWater)) as CoastalClipGeometry:[];
  const inland=independentWater.length?polygonClipping.difference(reviewed,geometry(independentWater)) as CoastalClipGeometry:reviewed;
  assert.ok(inland.length,'Selected inland domain must have a real native sea-cut');
  const restored=decks.length?polygonClipping.difference(inland,geometry(decks)) as CoastalClipGeometry:inland;
  const retainedWater=polygonClipping.difference(geometry(original.water),inland) as CoastalClipGeometry;
  return{inland:inlandPolygons(inland),restored:inlandPolygons(restored),retainedWater:inlandPolygons(retainedWater),protectedIndependentWater:inlandPolygons(protectedWater)};
}

/** The original clipping operation preserves vertical walls. Restore only actual
 * nonvertical faces it removed, interpolating source height and UVs identically. */
export function restoreInlandGround(pieces:readonly GroundPiece[],domain:readonly LocalPolygon[],area:CoastalMask['area']){
  const rectangle:CoastalClipGeometry=[[[[area.minX,-area.maxZ],[area.maxX,-area.maxZ],[area.maxX,-area.minZ],[area.minX,-area.minZ]]]];
  const outside=inlandPolygons(polygonClipping.difference(rectangle,geometry(domain)) as CoastalClipGeometry);
  const selected:GroundPiece[]=[];
  for(const piece of pieces){const indices:number[]=[];for(let t=0;t<piece.indices.length;t+=3){const ids=piece.indices.slice(t,t+3),P=ids.map(i=>piece.positions.slice(i*3,i*3+3));const a=P[0]!,b=P[1]!,c=P[2]!;if(Math.abs((b[0]!-a[0]!)*(c[2]!-a[2]!)-(b[2]!-a[2]!)*(c[0]!-a[0]!))<=1e-7)continue;const box=[Math.min(...P.map(p=>p[0]!)),-Math.max(...P.map(p=>p[2]!)),Math.max(...P.map(p=>p[0]!)),-Math.min(...P.map(p=>p[2]!))];if(domain.some(d=>box[0]!<=d.bbox[2]&&box[2]!>=d.bbox[0]&&box[1]!<=d.bbox[3]&&box[3]!>=d.bbox[1]))indices.push(...ids);}if(indices.length)selected.push({...piece,indices});}
  const clipped=clipCoastalGround(selected,{area,water:outside,sources:{coastlineWays:[],waterWays:[],waterRelations:[]},stats:{coastlineChains:0,openChains:0,landRings:0,waterArea:0}});
  return{...prepareNativeFrontier(clipped.pieces),precisionRetries:clipped.precisionRetryWitnesses};
}

/** Existing colliders and typed-array prefixes remain literal. No invisible
 * plane, raised surface or guessed bed is generated. */
export function appendInlandCollision(bytes:Uint8Array,pieces:readonly GroundPiece[],preserveOrientation=false){
  const old=parseCollisionBundle(bytes),tags=[...old.header.surfaceTags];let added=0,duplicates=0;
  const key=(p:readonly number[][])=>{const q=p.map(v=>v.map(Math.fround).join(','));return preserveOrientation?q.map((_,i)=>[...q.slice(i),...q.slice(0,i)].join('|')).sort()[0]!:q.sort().join('|');};
  const keys=new Map<string,string>();for(const c of old.colliders)for(let t=0;t<c.indices.length;t+=3){const P=[0,1,2].map(k=>Array.from(c.positions.subarray(c.indices[t+k]!*3,c.indices[t+k]!*3+3)));keys.set(key(P),old.header.surfaceTags[c.triangleTags[t/3]!]!);}
  let emitted=false;const colliders=old.colliders.map(c=>{if(emitted||c.group!=='ground')return c;emitted=true;const pos=Array.from(c.positions),idx=Array.from(c.indices),triangleTags=Array.from(c.triangleTags);for(const p of pieces){if(p.use==='visual')continue;let tag=tags.indexOf(p.tag);if(tag<0){tag=tags.length;tags.push(p.tag);}for(let t=0;t<p.indices.length;t+=3){const P=[0,1,2].map(k=>p.positions.slice(p.indices[t+k]!*3,p.indices[t+k]!*3+3)),K=key(P),previous=keys.get(K);if(previous!==undefined){assert.equal(previous,p.tag,'An existing surface conflicts with restored source semantics');duplicates++;continue;}keys.set(K,p.tag);for(const v of P){idx.push(pos.length/3);pos.push(...v);}triangleTags.push(tag);added++;}}return{...c,positions:Float32Array.from(pos),indices:Uint32Array.from(idx),triangleTags:Uint16Array.from(triangleTags)};});
  assert.ok(emitted||!pieces.some(p=>p.use!=='visual'),'A ground owner is required');
  const result=encodeCollisionBundle({...old.header,surfaceTags:tags},colliders),decoded=parseCollisionBundle(result);
  for(let i=0;i<old.colliders.length;i++){const a=old.colliders[i]!,b=decoded.colliders[i]!;assert.deepEqual(b.positions.subarray(0,a.positions.length),a.positions);assert.deepEqual(b.indices.subarray(0,a.indices.length),a.indices);assert.deepEqual(b.triangleTags.subarray(0,a.triangleTags.length),a.triangleTags);if(a.group!=='ground')assert.deepEqual(b,a);}
  return{bytes:result,added,duplicates};
}

export function restoreInlandTerrain(current:TerrainGrid,originalNative:TerrainGrid,repairedNative:TerrainGrid){
  for(const field of[originalNative,repairedNative])for(const k of['x0','z0','nx','nz','resolution']as const)assert.equal(field[k],current[k]);
  const next={...current,heights:current.heights.slice()},changes:{index:number;before:number;after:number}[]=[];
  for(let i=0;i<current.heights.length;i++){if(Object.is(originalNative.heights[i],repairedNative.heights[i]))continue;assert.equal(current.heights[i],originalNative.heights[i],`Later geometry changed inland safety sample ${i}`);assert.ok(repairedNative.heights[i]!>originalNative.heights[i]!, 'Only removal of the erroneous inland sea cut can restore safety');next.heights[i]=repairedNative.heights[i]!;changes.push({index:i,before:current.heights[i]!,after:next.heights[i]!});}
  return{terrain:next,changes};
}

/** A native water component is already triangulated on its exact source ring.
 * Only representational Float32 boundary rounding may lie outside that ring;
 * partial wet/dry faces require a separate reconstruction and are rejected. */
export function selectInlandWaterFace(points:readonly (readonly number[])[],domain:readonly LocalPolygon[]){
  assert.equal(points.length,3);const tri=points.map(p=>[p[0]!,-p[2]!]as Pt);
  const near=domain.filter(d=>Math.min(...tri.map(p=>p[0]))<=d.bbox[2]&&Math.max(...tri.map(p=>p[0]))>=d.bbox[0]&&Math.min(...tri.map(p=>p[1]))<=d.bbox[3]&&Math.max(...tri.map(p=>p[1]))>=d.bbox[1]);if(!near.length)return false;
  const common=polygonClipping.intersection([[tri]],geometry(near)) as CoastalClipGeometry;
  const area=(g:CoastalClipGeometry)=>g.reduce((n,p)=>n+Math.abs(signedArea(p[0]!))-p.slice(1).reduce((n,r)=>n+Math.abs(signedArea(r)),0),0);if(area(common)<1e-8)return false;
  const halfUlp=(v:number)=>v===0?2**-150:2**(Math.floor(Math.log2(Math.abs(v)))-24);
  const allowance=Math.max(...tri.map(p=>Math.hypot(halfUlp(p[0]),halfUlp(p[1]))))+1e-7;
  const rest=polygonClipping.difference([[tri]],geometry(near)) as CoastalClipGeometry;
  for(const p of rest)for(const ring of p){const samples=[...ring,...ring.map((p,i)=>[(p[0]+ring[(i+1)%ring.length]![0])/2,(p[1]+ring[(i+1)%ring.length]![1])/2]as Pt),[ring.reduce((n,p)=>n+p[0],0)/ring.length,ring.reduce((n,p)=>n+p[1],0)/ring.length]as Pt];for(const point of samples)assert.ok(near.some(d=>pointInPolygon(point,d.rings))||Math.min(...near.flatMap(d=>d.rings.map(r=>ringDistance(point,r))))<=allowance,'Native water face crosses outside the exact inland source domain');}
  return true;
}
