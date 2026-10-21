import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseCollisionBundle,type FileRef,type WorldManifest}from'../../../packages/world-schema/src/index.ts';
import {readDeliveryFile}from'./delivery-city.ts';
import {decodeDeliverySimulation,deliverySha}from'./delivery-city-payloads.ts';
import type {DeliveryBridgeRoadAuthority}from'./delivery-city-road-registration.ts';
import {deliveryRoadProjectionCoverage}from'./delivery-city-road-projection.ts';
import{qualifyDeliveryJunctionRoadSupersession,qualifyDeliveryJunctionNonRoadSupersession,type DeliveryJunctionRoadDerivative}from'./delivery-city-road-junction-lineage.ts';
import{junctionPlaneHeight}from'./delivery-bridge-junction-mouths.ts';
type Triangle=readonly (readonly number[])[];
export interface DeliveryRoadAuthoritySource {world:string;manifestSha256:string}
export interface DeliveryRoadPhysicalContract {id:string;floorTag:string;masks:{id:string;polygon:readonly (readonly number[])[];cell?:string;sha256?:string}[];collisionFiles:(FileRef&{cell:string})[];junctionDerivatives?:readonly DeliveryJunctionRoadDerivative[]}
const basic=(r:FileRef)=>({path:r.path,bytes:r.bytes,sha256:r.sha256});
const cycle=(points:Triangle,dimension:'xz'|'xyz')=>[0,1,2].map(start=>{const b=Buffer.alloc(dimension==='xyz'?36:24);let i=0;for(let j=0;j<3;j++)for(const k of dimension==='xyz'?[0,1,2]:[0,2]){b.writeFloatLE(Math.fround(points[(start+j)%3]![k]!),i);i+=4;}return b;});
export const deliveryRoadPhysicalFaceHash=(points:Triangle)=>deliverySha(Buffer.from(cycle(points,'xyz').map(b=>b.toString('hex')).sort()[0]!,'hex'));
// A footprint polygon has no physical winding contract. Match its three exact
// XZ vertices, then retain the canonical HCOL's full oriented XYZ identity.
export const deliveryRoadProjectedFaceKey=(points:Triangle)=>points.map(p=>{const b=Buffer.alloc(8);b.writeFloatLE(Math.fround(p[0]!),0);b.writeFloatLE(Math.fround(p[2]!),4);return b.toString('hex');}).sort().join(':');
function floorInventory(world:string,ref:FileRef,tag:string){
 const bundle=parseCollisionBundle(decodeDeliverySimulation(readDeliveryFile(world,ref),ref)),rows:{collider:string;triangle:number;points:number[][];projected:string;sha256:string;orderedSha256:string[]}[]=[];
 for(const c of bundle.colliders)if(c.group==='ground')for(let t=0;t<c.indices.length;t+=3)if(bundle.header.surfaceTags[c.triangleTags[t/3]!]===tag){const points=[0,1,2].map(k=>Array.from(c.positions.subarray(c.indices[t+k]!*3,c.indices[t+k]!*3+3)));rows.push({collider:c.id,triangle:t/3,points,projected:deliveryRoadProjectedFaceKey(points),sha256:deliveryRoadPhysicalFaceHash(points),orderedSha256:cycle(points,'xyz').map(deliverySha)});}return rows;
}
/** Bind the declared canonical source floor to every final upper ROAD mask.
 * Whole-file ref changes at a native frontier are allowed only when every
 * actual oriented XYZ floor triangle remains exact, including its level. */
export function verifyDeliveryRoadPhysicalLineage(world:string,manifest:WorldManifest,contracts:readonly DeliveryRoadPhysicalContract[],sources:readonly DeliveryRoadAuthoritySource[],onProgress?:(stage:string,completed:number,total:number)=>void){
 const roots=sources.map(s=>{const bytes=fs.readFileSync(path.join(s.world,'manifest.json'));assert.equal(deliverySha(bytes),s.manifestSha256,'Canonical road source manifest changed');return{...s,manifest:JSON.parse(bytes.toString())as WorldManifest};}),cache=new Map<string,ReturnType<typeof floorInventory>>(),read=(root:string,ref:FileRef,tag:string)=>{const key=path.resolve(root)+'/'+ref.sha256+'/'+tag;let rows=cache.get(key);if(!rows){rows=floorInventory(root,ref,tag);cache.set(key,rows);}return rows;},proof:any[]=[];
 for(const derivative of contracts[0]?.junctionDerivatives??[]){const sourceRoot=roots.find(s=>s.manifestSha256===derivative.sourceManifestSha256);assert.ok(sourceRoot,'Ordered junction before-world must be pinned explicitly');
  const witness=(s:any,tag:string,points:Triangle)=>{const pin=derivative.profile.sourceCells.find((c:any)=>c.id===s.cell),cell=sourceRoot.manifest.cells.find(c=>c.id===s.cell);assert.ok(pin&&cell);assert.deepEqual(basic(pin.collision),basic(cell.collision));const row=read(sourceRoot.world,cell.collision,tag).find(f=>f.collider===s.collider&&f.triangle===s.triangle&&f.orderedSha256.includes(s.orderedFloat32Sha256));assert.ok(row,'Junction witness is not the literal source level/face');assert.deepEqual(row.points,points,'Junction source witness plane differs from actual before-HCOL');return row;};
  for(const recipe of derivative.profile.recipes){for(const floor of[...recipe.floorSources,...recipe.bankSources])witness(floor.source,floor.tag,floor.points);const parent=contracts.find(c=>c.id===recipe.parentBridge);assert.ok(parent);for(const[side,knots]of[['inner',recipe.travel.inner],['outer',recipe.travel.outer]]as const)for(const knot of knots){const tag=knot.surfaceTag??(knot.role==='parent-foot-in-source-carriageway'?'raised:asphalt:bridge-reconstruction':side==='inner'?'road:asphalt:bridge-reconstruction':'road:asphalt');assert.ok(['road:asphalt','road:asphalt:bridge-reconstruction','raised:asphalt','raised:slabs','raised:asphalt:bridge-reconstruction','raised:slabs:bridge-junction'].includes(tag),'Unqualified bank surface tag');const row=witness(knot.source,tag,knot.plane);assert.ok(Math.abs(junctionPlaneHeight(row.points as any,knot.point[0],knot.point[2])-knot.point[1])<=.001,'Junction bank knot no longer matches its actual source plane');if(side==='inner')assert.ok(parent.collisionFiles.some(c=>c.cell===knot.source.cell),'Junction inner bank belongs to another bridge owner');}}
 }
 // Independently preserve all declared FOOT floors and every complementary
 // native/walking source fragment through subsequent ordered stages. FOOT
 // coverage never substitutes for canonical ROAD coverage below.
 const taggedExpected=new Map<string,{cell:string;tag:string;points:Triangle;sha256:string}>(),walkingLineage:any[]=[];
 const taggedKey=(cell:string,tag:string,points:Triangle)=>cell+'/'+tag+'/'+deliveryRoadPhysicalFaceHash(points);
 for(const derivative of contracts[0]?.junctionDerivatives??[]){
  const sourceRoot=roots.find(s=>s.manifestSha256===derivative.sourceManifestSha256);assert.ok(sourceRoot);
  let completed=0;onProgress?.(derivative.publication?.stageId??'junction',0,derivative.nonRoadCuts?.length??0);for(const cut of derivative.nonRoadCuts??[]){if(completed++%100===0)onProgress?.(derivative.publication?.stageId??'junction',completed,derivative.nonRoadCuts.length);
   const before:WorldManifest['cells'][number]|undefined=sourceRoot.manifest.cells.find(c=>c.id===cut.cell);assert.ok(before);assert.deepEqual(basic(before.collision),basic(cut.source));
   const tag=cut.selection.tag,input:ReturnType<typeof floorInventory>[number]|undefined=read(sourceRoot.world,cut.source,tag).find(f=>f.collider===cut.collider&&f.triangle===cut.selection.triangle&&f.orderedSha256.includes(cut.selection.orderedFloat32Sha256));assert.ok(input,'Native/walking cut is not its literal tagged before-HCOL face');assert.equal(deliveryRoadPhysicalFaceHash(cut.sourcePoints),input.sha256);
   const replacement=[...derivative.newRoadFaces,...derivative.newFootFaces].filter(f=>f.parentBridge===cut.parentBridge&&f.recipeId===cut.recipeId).map(f=>f.points);
   const qualified=qualifyDeliveryJunctionNonRoadSupersession({parent:cut.parentBridge,expectedParent:cut.parentBridge,sourcePoints:cut.sourcePoints,selection:cut.selection,declaredComplement:cut.complement,finalFaces:cut.complement,newRoadFaces:replacement});
   taggedExpected.delete(taggedKey(cut.cell,tag,cut.sourcePoints));
   for(const points of qualified.complementaryFragments)taggedExpected.set(taggedKey(cut.cell,tag,points),{cell:cut.cell,tag,points,sha256:deliveryRoadPhysicalFaceHash(points)});
   walkingLineage.push({publicationSha256:derivative.ref.sha256,cell:cut.cell,sourceTag:tag,sourceFaceSha256:input.sha256,recipeId:cut.recipeId,outsideFragments:qualified.outsideFragments,coverage:qualified.coverage});
  }
  for(const f of derivative.newFootFaces??[])taggedExpected.set(taggedKey(f.cell,f.surfaceTag,f.points),{cell:f.cell,tag:f.surfaceTag,points:f.points,sha256:deliveryRoadPhysicalFaceHash(f.points)});
 }
 const taggedFinal=new Map<string,Set<string>>();
 for(const f of taggedExpected.values()){
  const key=f.cell+'/'+f.tag;let hashes=taggedFinal.get(key);if(!hashes){const cell=manifest.cells.find(c=>c.id===f.cell);assert.ok(cell);hashes=new Set(read(world,cell.collision,f.tag).map(r=>r.sha256));taggedFinal.set(key,hashes);}
  assert.ok(hashes.has(f.sha256),'Final world lost an exact oriented tagged FOOT floor or native/walking outside fragment');
 }
 for(const contract of contracts){onProgress?.(contract.id,0,contract.collisionFiles.length);assert.equal(contract.floorTag,'road:asphalt:bridge-reconstruction');assert.ok(contract.collisionFiles.length);const canonical:any[]=[],final:any[]=[],lineage:any[]=[];
  for(const sourceRef of contract.collisionFiles){const current=manifest.cells.find(c=>c.id===sourceRef.cell);assert.ok(current,'Canonical bridge road cell is absent');let root=world,sourceManifestSha256:string|null=null;
   if(JSON.stringify(basic(current.collision))!==JSON.stringify(basic(sourceRef))){const matched=roots.find(s=>s.manifest.cells.some(c=>c.id===sourceRef.cell&&JSON.stringify(basic(c.collision))===JSON.stringify(basic(sourceRef))));assert.ok(matched,`Missing exact canonical ROAD HCOL source for ${contract.id}/${sourceRef.cell}`);root=matched.world;sourceManifestSha256=matched.manifestSha256;}
   canonical.push(...read(root,sourceRef,contract.floorTag).map(r=>({...r,cell:sourceRef.cell})));final.push(...read(world,current.collision,contract.floorTag).map(r=>({...r,cell:sourceRef.cell})));lineage.push({cell:sourceRef.cell,canonical:sourceRef,current:current.collision,canonicalSourceManifestSha256:sourceManifestSha256,wholeStoredFileLiteral:sourceRef.sha256===current.collision.sha256});
  }
  let expected=canonical.slice();const supersessions:any[]=[];
  for(const derivative of contract.junctionDerivatives??[]){const sourceRoot=roots.find(s=>s.manifestSha256===derivative.sourceManifestSha256);assert.ok(sourceRoot,'Missing exact before-world for ordered junction lineage');
   for(const cut of derivative.cuts){const before:WorldManifest['cells'][number]|undefined=sourceRoot.manifest.cells.find(c=>c.id===cut.cell);assert.ok(before);assert.deepEqual(basic(before.collision),basic(cut.source),'Junction source HCOL is not its pinned before-world');const input:ReturnType<typeof floorInventory>[number]|undefined=read(sourceRoot.world,cut.source,contract.floorTag).find(f=>f.collider===cut.collider&&f.triangle===cut.selection.triangle&&f.orderedSha256.includes(cut.selection.orderedFloat32Sha256));assert.ok(input,'Junction source face/level/winding is absent from actual before-world');assert.equal(deliveryRoadPhysicalFaceHash(cut.sourcePoints),input.sha256);
    const matching=expected.filter(f=>f.cell===cut.cell&&f.sha256===input.sha256);if(!matching.length)continue;assert.equal(cut.parentBridge,contract.id,'Another bridge cannot supersede canonical source geometry');const newFloors=derivative.newRoadFaces.filter(f=>f.parentBridge===contract.id).map(f=>f.points),qualified=qualifyDeliveryJunctionRoadSupersession({parent:cut.parentBridge,expectedParent:contract.id,sourcePoints:cut.sourcePoints,selection:cut.selection,declaredComplement:cut.complement,finalFaces:cut.complement,newRoadFaces:newFloors});expected=expected.filter(f=>!(f.cell===cut.cell&&f.sha256===input.sha256));for(const points of qualified.complementaryFragments)expected.push({...input,cell:cut.cell,points,sha256:deliveryRoadPhysicalFaceHash(points),projected:deliveryRoadProjectedFaceKey(points),orderedSha256:cycle(points,'xyz').map(deliverySha)});supersessions.push({publicationSha256:derivative.ref.sha256,cell:cut.cell,sourceFaceSha256:input.sha256,recipeId:cut.recipeId,outsideFragments:qualified.outsideFragments,coverage:qualified.coverage});
   }
   for(const f of derivative.newRoadFaces.filter(f=>f.parentBridge===contract.id))expected.push({cell:f.cell,points:f.points,sha256:deliveryRoadPhysicalFaceHash(f.points),projected:deliveryRoadProjectedFaceKey(f.points),orderedSha256:cycle(f.points,'xyz').map(deliverySha),collider:'source-qualified-junction',triangle:-1});
  }
  const finalCells=new Set(final.map(f=>f.cell));for(const cellId of new Set(expected.map(f=>f.cell))){if(finalCells.has(cellId))continue;const cell=manifest.cells.find(c=>c.id===cellId);assert.ok(cell);final.push(...read(world,cell.collision,contract.floorTag).map(f=>({...f,cell:cellId})));finalCells.add(cellId);}
  const currentHashes=new Set(final.map(f=>f.cell+'/'+f.sha256)),missing=expected.filter(f=>!currentHashes.has(f.cell+'/'+f.sha256));assert.equal(missing.length,0,`Final canonical oriented XYZ ROAD faces or exact outside fragments changed/missing ${contract.id}`);const projection=deliveryRoadProjectionCoverage(contract.masks,expected);assert.equal(projection.unexplainedComponents.length,0,`Canonical encoded ROAD floor does not cover ${contract.id} published footprint within existing80micrometre source construction bound`);
  // New publications expose full physical/visual face hashes. Older ones expose
  // pre-owner-clipping footprints; their actual clipped encoded inventory is
  // bound above as a whole, never confused with one footprint triangle.
  for(const mask of contract.masks)if(mask.sha256){const face=canonical.find(f=>(!mask.cell||f.cell===mask.cell)&&f.orderedSha256.includes(mask.sha256));assert.ok(face,`Published full source ROAD face missing ${contract.id}/${mask.id}`);}
  const nonAreaCanonical=canonical.filter(f=>{const[a,b,c]=f.points;return(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0])===0;});proof.push({id:contract.id,status:supersessions.length?'CANONICAL_OUTSIDE_FRAGMENTS_AND_ORDERED_SOURCE_JUNCTIONS_EXACT':'ALL_CANONICAL_ORIENTED_FLOAT32_ROAD_FACES_EXACT',masks:contract.masks.length,canonicalFloorFaces:canonical.length,canonicalPositiveAreaFaces:canonical.length-nonAreaCanonical.length,canonicalNonAreaFaces:nonAreaCanonical.length,missingCanonicalFaces:0,lineage,projection,supersessions,faces:canonical.map(f=>({cell:f.cell,canonicalFaceSha256:f.sha256,canonicalCollider:f.collider,canonicalTriangle:f.triangle,finalIdentical:currentHashes.has(f.cell+'/'+f.sha256)}))});
 }
 // Source manifests may not drift while large floor inventories are decoded.
 for(const s of roots)assert.equal(deliverySha(fs.readFileSync(path.join(s.world,'manifest.json'))),s.manifestSha256);return{status:'PASS_ALL_CANDIDATE_ROAD_MASKS_HAVE_LITERAL_SOURCE_XYZ_FLOORS',bridges:proof,walking:{status:'ALL_DECLARED_FOOT_AND_NATIVE_OUTSIDE_FRAGMENTS_EXACT',finalTaggedFaces:taggedExpected.size,lineage:walkingLineage}};
}
export function physicalRoadContract(raw:any,authority:DeliveryBridgeRoadAuthority):DeliveryRoadPhysicalContract{assert.ok(Array.isArray(raw.collisionFiles)&&raw.collisionFiles.length,'Road contract lacks encoded canonical floor lineage');return{id:authority.id,floorTag:authority.floorTag,masks:authority.masks.map((m,i)=>({...m,...(raw.masks[i].cell?{cell:raw.masks[i].cell}:{}),...(raw.masks[i].sha256?{sha256:raw.masks[i].sha256}:{})})),collisionFiles:raw.collisionFiles};}
