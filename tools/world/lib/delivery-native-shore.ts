// Restore licensed source soil only inside individually qualified land domains.
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
import type {Document} from '@gltf-transform/core';
import {bbox,signedArea,type LocalPolygon,type Pt} from './geometry.ts';
import {inlandPolygons} from './delivery-inland-water.ts';
import type {CoastalClipGeometry} from './coastal-mask.ts';
import type {GroundPiece,Finish} from './ground.ts';
import {deliveryFrontierMesh} from './delivery-city-frontier.ts';
import {addNativeFrontier,type FrontierMesh} from './frontier-ground.ts';
import {appendGroundGlb,type GroundGlbAppend} from './append-ground-glb.ts';
import {reuseGroundGlb,type GroundIndexEdit} from './reuse-ground-glb.ts';
import {deliveryGeometryStats} from './delivery-city-payloads.ts';
import {deliveryFloorCoverage,type DeliveryFloorTriangle} from './delivery-city-floor-coverage.ts';
import {groundTexture} from './textures.ts';
import type {GroundAttributeArray} from './replace-ground-glb.ts';
import type {TerrainGrid} from '../../../packages/world-schema/src/index.ts';

export interface NativeShoreProfile {
  schemaVersion:1;kind:'source-bound-native-shore-restoration';
  newRegionXZ:[number,number,number,number];seaWaterY:number;
  nativeMetadataSha256:string;retainedWaterSha256:string;streetPartsSha256:string;municipalWaterSha256:string;
  municipalParts:{id:string;properties:Record<string,unknown>;rings:Pt[][]}[];
  protectedMunicipalWater:{id:string;properties:Record<string,unknown>;rings:Pt[][]}[];
  domainMethod:'municipal-land'|'precise-water-native-bank';
  reviewScope?:'southwest-20261029-west-shore';
  bankCells?:{id:string;boundsXZ:[number,number,number,number]}[];
  reason:string;
}
const geometry=(p:readonly LocalPolygon[])=>p.map(p=>p.rings)as CoastalClipGeometry;
export function restoreNativeShoreTerrain(current:TerrainGrid,oldNative:TerrainGrid,repairedNative:TerrainGrid,newRegionXZ:readonly number[]){
  for(const field of[oldNative,repairedNative])for(const k of['x0','z0','nx','nz','resolution']as const)assert.equal(field[k],current[k]);
  const terrain={...current,heights:current.heights.slice()},changes:{index:number;before:number;after:number}[]=[],alreadyNative:number[]=[];
  for(let i=0;i<current.heights.length;i++){
    if(Object.is(oldNative.heights[i],repairedNative.heights[i]))continue;
    assert.ok(repairedNative.heights[i]!>oldNative.heights[i]!,'Only removal of an erroneous water cut can restore shore safety');
    if(Object.is(current.heights[i],repairedNative.heights[i])){alreadyNative.push(i);continue;}
    const x=current.x0+i%current.nx*current.resolution,z=current.z0+Math.floor(i/current.nx)*current.resolution;
    assert.ok(x>=newRegionXZ[0]!&&x<=newRegionXZ[2]!&&z>=newRegionXZ[1]!&&z<newRegionXZ[3]!,'Protected old-region safety field must remain literal');
    assert.equal(current.heights[i],oldNative.heights[i],`Later geometry changed shore safety sample ${i}`);
    terrain.heights[i]=repairedNative.heights[i]!;changes.push({index:i,before:current.heights[i]!,after:terrain.heights[i]!});
  }
  return{terrain,changes,alreadyNative};
}
export function shoreDomain(profile:NativeShoreProfile,parts:readonly LocalPolygon[],coastal:{mask:{water:LocalPolygon[]};decks:{polygons:LocalPolygon[]};waterY:number},municipalWater:readonly LocalPolygon[],nativeCells:readonly {id:string;boundsXZ:readonly number[]}[]=[]){
  assert.equal(profile.schemaVersion,1);assert.equal(profile.kind,'source-bound-native-shore-restoration');assert.equal(profile.seaWaterY,coastal.waterY);assert.ok(profile.reason.length>30);
  const r=profile.newRegionXZ;assert.ok(r.length===4&&r.every(Number.isFinite)&&r[0]<r[2]&&r[1]<r[3]);
  if(profile.reviewScope){
    assert.equal(profile.reviewScope,'southwest-20261029-west-shore');assert.deepEqual(r,[-2816,-384,-1792,1152]);
    assert.equal(profile.domainMethod,'precise-water-native-bank');
    assert.deepEqual(profile.bankCells,[{id:'c_m19_p01',boundsXZ:[-2432,128,-2304,256]},{id:'c_m18_p01',boundsXZ:[-2304,128,-2176,256]},{id:'c_m17_m01',boundsXZ:[-2176,-128,-2048,0]}]);
    assert.equal(profile.municipalWaterSha256,'df81bd93bb6493c8c4df8d6827b04a24a548e44e1fd8859b6b8bb13e6221f823','West review requires the literal complete official sea source');
    assert.deepEqual(profile.protectedMunicipalWater.map(p=>p.id),['Maavesi_merialue.1']);
  }else assert.ok(r[3]<=-1152,'Ordinary shore restoration remains limited to the accepted northern profile');
  assert.ok(profile.municipalParts.length>0&&profile.municipalParts.length<=64);const seen=new Set<string>();
  for(const selected of profile.municipalParts){assert.ok(!seen.has(selected.id));seen.add(selected.id);const actual=parts.find(p=>p.id===selected.id);assert.ok(actual,'Missing actual municipal source part');assert.deepEqual(selected.rings,actual.rings,'Source rings must remain literal');assert.deepEqual(selected.properties,actual.properties,'Source land classification must remain literal');assert.ok(/Nurmikot|Mets\u00e4t|Metsat|Mets\u00e4|Ruovikot/.test(String(actual.properties.paatyyppi)+String(actual.properties.alatyyppi)),'This bounded profile requires an explicit municipal lawn, meadow, forest or reed land role');}
  assert.ok(profile.protectedMunicipalWater.length>0&&profile.protectedMunicipalWater.length<=256);const wetIds=new Set<string>();for(const selected of profile.protectedMunicipalWater){assert.ok(!wetIds.has(selected.id));wetIds.add(selected.id);const actual=municipalWater.find(p=>p.id===selected.id);assert.ok(actual,'Missing precise municipal water source');assert.deepEqual(selected.rings,actual.rings,'Protected lake boundary must remain literal');assert.deepEqual(selected.properties,actual.properties,'Protected water classification must remain literal');}
  assert.deepEqual([...wetIds].sort(),municipalWater.map(p=>p.id).sort(),'Every supplied precise water body must remain protected');
  let domains:CoastalClipGeometry[];
  if(profile.domainMethod==='municipal-land')domains=profile.municipalParts.map(p=>[p.rings]);
  else{
    assert.equal(profile.domainMethod,'precise-water-native-bank');assert.ok(profile.bankCells?.length&&profile.bankCells.length<=64);const selectedCells=new Set<string>();domains=[];
    for(const cell of profile.bankCells){assert.ok(!selectedCells.has(cell.id));selectedCells.add(cell.id);assert.deepEqual(cell.boundsXZ,nativeCells.find(c=>c.id===cell.id)?.boundsXZ,'Bank context requires literal native owner bounds');const[x0,z0,x1,z1]=cell.boundsXZ,rectangle:CoastalClipGeometry=[[[[x0,-z1],[x1,-z1],[x1,-z0],[x0,-z0]]]];assert.ok(polygonClipping.intersection(rectangle,profile.protectedMunicipalWater.map(p=>p.rings)).length&&polygonClipping.difference(rectangle,profile.protectedMunicipalWater.map(p=>p.rings)).length,'Only actual municipal shoreline cells qualify as bank context');domains.push(rectangle);}
  }
  const source=polygonClipping.union(...domains as[CoastalClipGeometry,...CoastalClipGeometry[]])as CoastalClipGeometry;
  const rectangle:CoastalClipGeometry=[[[[r[0],-r[3]],[r[2],-r[3]],[r[2],-r[1]],[r[0],-r[1]]]]];
  const common=polygonClipping.intersection(source,geometry(coastal.mask.water),rectangle)as CoastalClipGeometry;
  const domain=polygonClipping.difference(common,geometry(coastal.decks.polygons),profile.protectedMunicipalWater.map(p=>p.rings))as CoastalClipGeometry;
  assert.ok(domain.length,'No real source land/water conflict');
  const retainedWater=polygonClipping.difference(geometry(coastal.mask.water),domain)as CoastalClipGeometry;
  return{domain:inlandPolygons(domain),retainedWater:inlandPolygons(retainedWater)};
}
const area=(g:CoastalClipGeometry)=>g.reduce((n,p)=>n+Math.abs(signedArea(p[0]!))-p.slice(1).reduce((n,r)=>n+Math.abs(signedArea(r)),0),0);
const points=(m:FrontierMesh,t:number)=>[0,1,2].map(k=>Array.from(m.attributes.POSITION!.subarray(m.indices[t*3+k]!*3,m.indices[t*3+k]!*3+3))as[number,number,number]);

/** Partial water faces are reconstructed on their original plane, never selected
 * wholesale. No dry polygon can erase an unrelated wet part of a large face. */
export function clipNativeWaterFace(P:readonly (readonly number[])[],domain:readonly LocalPolygon[]){
  assert.equal(P.length,3);assert.ok(P.every(p=>p[1]===P[0]![1]),'Only the exact horizontal source water plane is eligible');
  const tri=P.map(p=>[p[0]!,-p[2]!]as Pt),box=bbox([tri]),near=domain.filter(d=>box[0]<=d.bbox[2]&&box[2]>=d.bbox[0]&&box[1]<=d.bbox[3]&&box[3]>=d.bbox[1]);
  if(!near.length)return{changed:false,wet:[]as number[][][],dryArea:0,originalArea:Math.abs(signedArea(tri))};
  const dry=polygonClipping.intersection([[tri]],geometry(near))as CoastalClipGeometry,dryArea=area(dry),originalArea=Math.abs(signedArea(tri));
  if(dryArea===0)return{changed:false,wet:[]as number[][][],dryArea,originalArea};
  const rest=polygonClipping.difference([[tri]],geometry(near))as CoastalClipGeometry;
  assert.ok(Math.abs(area(rest)+dryArea-originalArea)<=Math.max(1e-8,originalArea*1e-9),'Wet/dry area conservation failed');
  const wet:number[][][]=[];
  for(const poly of rest){const flat:number[]=[],holes:number[]=[];for(const[i,ring]of poly.entries()){if(i)holes.push(flat.length/2);for(const q of ring)flat.push(...q);}const ids=earcut(flat,holes,2);for(let i=0;i<ids.length;i+=3){const q=[0,1,2].map(k=>[flat[ids[i+k]!*2]!,P[0]![1]!, -flat[ids[i+k]!*2+1]!]);const n=(q[1]![2]!-q[0]![2]!)*(q[2]![0]!-q[0]![0]!)-(q[1]![0]!-q[0]![0]!)*(q[2]![2]!-q[0]![2]!);const source=(P[1]![2]!-P[0]![2]!)*(P[2]![0]!-P[0]![0]!)-(P[1]![0]!-P[0]![0]!)*(P[2]![2]!-P[0]![2]!);if(n*source<0)[q[1],q[2]]=[q[2]!,q[1]!];wet.push(q);}}
  return{changed:true,wet,dryArea,originalArea};
}

const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export function nativeShoreWaterAuthority(doc:Document,seaY:number){const triangles:DeliveryFloorTriangle[]=[];for(const node of doc.getRoot().listNodes())if(node.getMesh()&&/_water$/.test(node.getName())){assert.deepEqual(node.getWorldMatrix(),identity);for(const p of node.getMesh()!.listPrimitives()){assert.equal(p.getMaterial()?.getName(),'coastal_water');assert.deepEqual(p.listSemantics().sort(),['NORMAL','POSITION']);const m=deliveryFrontierMesh(p);for(let t=0;t<m.indices.length/3;t++){const P=points(m,t);assert.ok(P.every(q=>q[1]===seaY));triangles.push(P);}}}return triangles;}
const textures=new Map<Finish,ReturnType<typeof groundTexture>>();
function coarseColour(finish:Finish,u:number,v:number){let image=textures.get(finish);if(!image){image=groundTexture(finish,512);textures.set(finish,image);}const x=Math.min(image.width-1,Math.floor((u-Math.floor(u))*image.width)),y=Math.min(image.height-1,Math.floor((v-Math.floor(v))*image.height));return[0,1,2].map(k=>{const c=image!.data[(y*image!.width+x)*4+k]!/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});}
type Work={nodeName:string;primitiveIndex:number;mesh:FrontierMesh;sourceIndices:GroundGlbAppend['indices']['original'];extra:Record<string,number[]>;indices:number[];retained:number[];removed:number;wet:number;ground:number};
function appendInterpolated(w:Work,t:number,Q:number[][]){
  const P=points(w.mesh,t),D=(P[1]![0]-P[0]![0])*(P[2]![2]-P[0]![2])-(P[1]![2]-P[0]![2])*(P[2]![0]-P[0]![0]);assert.notEqual(D,0);
  for(const q of Q){const x=Math.fround(q[0]!),z=Math.fround(q[2]!),a=((P[1]![0]-x)*(P[2]![2]-z)-(P[1]![2]-z)*(P[2]![0]-x))/D,b=((P[2]![0]-x)*(P[0]![2]-z)-(P[2]![2]-z)*(P[0]![0]-x))/D,c=1-a-b;
    w.indices.push(w.mesh.attributes.POSITION!.length/3+w.extra.POSITION!.length/3);
    for(const[s,source]of Object.entries(w.mesh.attributes)){const size=w.mesh.components[s]!;if(s==='POSITION'){w.extra[s]!.push(x,q[1]!,z);continue;}for(let k=0;k<size;k++){const value=[a,b,c].reduce((n,v,j)=>n+v*source[w.mesh.indices[t*3+j]!*size+k]!,0);w.extra[s]!.push(source instanceof Float32Array?Math.fround(value):Math.round(value));}}
  }
}
export async function restoreNativeShoreVisual(o:{bytes:Uint8Array;doc:Document;pieces:readonly GroundPiece[];domain:readonly LocalPolygon[];seaY:number;coarse:boolean;nearWater:readonly DeliveryFloorTriangle[]}){
  const work:Work[]=[],remaining=new Map<Finish,GroundPiece[]>();for(const p of o.pieces)if(p.use!=='collision'){const list=remaining.get(p.finish)??[];list.push(p);remaining.set(p.finish,list);}let coarseAdded=false;
  for(const node of o.doc.getRoot().listNodes())if(node.getMesh())for(const[primitiveIndex,p]of node.getMesh()!.listPrimitives().entries()){
    const water=/_water$/.test(node.getName()),finish=/_ground_(?:frontier_)?(asphalt|setts|cobble|slabs|gravel|grass|yard)$/.exec(node.getName())?.[1]as Finish|undefined;
    if(!o.domain.length&&water)continue; // Pure ground additions never inspect or rewrite water.
    if(!o.coarse&&!water&&!finish)continue;assert.deepEqual(node.getWorldMatrix(),identity);const mesh=deliveryFrontierMesh(p),w:Work={nodeName:node.getName(),primitiveIndex,mesh,sourceIndices:p.getIndices()!.getArray()!as GroundGlbAppend['indices']['original'],extra:Object.fromEntries(Object.keys(mesh.attributes).map(k=>[k,[]])),indices:[],retained:[],removed:0,wet:0,ground:0};
    for(let t=0;t<mesh.indices.length/3;t++){const P=points(mesh,t);if(!o.domain.length||!(water||o.coarse&&P.every(q=>q[1]===o.seaY))){w.retained.push(t);continue;}if(water){assert.equal(p.getMaterial()?.getName(),'coastal_water');assert.ok(P.every(q=>q[1]===o.seaY));}const split=clipNativeWaterFace(P,o.domain);if(!split.changed){w.retained.push(t);continue;}if(o.coarse)assert.ok(deliveryFloorCoverage(P,o.nearWater),'Coarse water clipping requires complete original near-water provenance');w.removed++;for(const tri of split.wet){appendInterpolated(w,t,tri);w.wet++;}}
    if(o.coarse&&!coarseAdded){assert.deepEqual(Object.keys(mesh.attributes).sort(),['COLOR_0','POSITION']);const C=mesh.attributes.COLOR_0!,scale=mesh.normalized.COLOR_0?(C instanceof Uint8Array?255:C instanceof Uint16Array?65535:0):1;assert.ok(scale&&mesh.components.COLOR_0===3);for(const piece of o.pieces)if(piece.use!=='collision')for(const id of piece.indices){w.indices.push(mesh.attributes.POSITION!.length/3+w.extra.POSITION!.length/3);w.extra.POSITION!.push(...piece.positions.slice(id*3,id*3+3));w.extra.COLOR_0!.push(...coarseColour(piece.finish,piece.uvs[id*2]!,piece.uvs[id*2+1]!).map(v=>scale===1?v:Math.round(v*scale)));w.ground+=1/3;}coarseAdded=true;remaining.clear();}
    else if(!o.coarse&&finish&&remaining.has(finish)){const native=addNativeFrontier(mesh,remaining.get(finish)!);for(const[s,a]of Object.entries(native.attributes))w.extra[s]!.push(...a.subarray(mesh.attributes[s]!.length));w.indices.push(...Array.from(native.indices.subarray(mesh.indices.length)));w.ground=remaining.get(finish)!.reduce((n,p)=>n+p.indices.length/3,0);remaining.delete(finish);}
    if(w.removed||w.ground)work.push(w);
  }
  assert.equal(remaining.size,0,`Native shore finish has no existing native material:${[...remaining.keys()]}`);
  const additions:GroundGlbAppend[]=[],empty:GroundIndexEdit[]=[];
  for(const w of work){if(!w.retained.length&&!w.indices.length){empty.push({nodeName:w.nodeName,primitiveIndex:w.primitiveIndex,indices:new Uint32Array()});continue;}additions.push({nodeName:w.nodeName,primitiveIndex:w.primitiveIndex,attributes:Object.fromEntries(Object.entries(w.mesh.attributes).map(([s,a])=>[s,{original:a,appended:w.extra[s]!}])),indices:{original:w.sourceIndices,appended:w.indices,retainedTriangles:w.retained}});}
  let bytes=await appendGroundGlb(o.bytes,additions);bytes=await reuseGroundGlb(bytes,empty,[]);const stats=deliveryGeometryStats(bytes),oldStats=deliveryGeometryStats(o.bytes);assert.ok(stats.drawCalls<=oldStats.drawCalls&&stats.drawCalls<=(o.coarse?3:60),'Shore reconstruction must not add a draw');
  return{bytes,stats,proofs:work.map(w=>({node:w.nodeName,primitive:w.primitiveIndex,removedWater:w.removed,remainingClippedWater:w.wet,addedNativeGround:Math.round(w.ground)}))};
}
