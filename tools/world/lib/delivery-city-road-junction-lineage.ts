import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {partitionJunctionSourceMesh,type JunctionSourceSelection}from './delivery-bridge-junction-partition.ts';
import {junctionFaceSha}from './delivery-bridge-junction-mouths.ts';
import {deliveryRoadPhysicalFaceHash}from './delivery-city-road-lineage.ts';
import {deliveryRoadSourceCutCoverage}from './delivery-city-road-projection.ts';
import type{FileRef,WorldManifest}from'../../../packages/world-schema/src/index.ts';
import{readDeliveryFile}from'./delivery-city.ts';
import{decodeDeliverySimulation,deliverySha}from'./delivery-city-payloads.ts';
import{compileJunctionFloorSurfaces}from'./delivery-bridge-junction-surfaces.ts';
import{splitBridgeFaces}from'./bridge-reconstruction.ts';
import type{DeliveryBridgeRoadAuthority}from'./delivery-city-road-registration.ts';

type Triangle=readonly(readonly number[])[];
/** A declared change to one original ROAD face grants authority only inside its
 * explicit source mask. Recompute the complementary source-plane fragments;
 * listing a removed face or a replacement footprint alone is insufficient. */
interface JunctionSupersessionOptions {parent:string;expectedParent:string;sourcePoints:Triangle;selection:JunctionSourceSelection;declaredComplement:readonly Triangle[];finalFaces:readonly Triangle[];newRoadFaces:readonly Triangle[]}
export function qualifyDeliveryJunctionRoadSupersession(o:JunctionSupersessionOptions){
 assert.equal(o.selection.tag,'road:asphalt:bridge-reconstruction');assert.equal(o.selection.role,'authored-approach-floor');
 return qualifySourceFloorSupersession(o);
}
/** Native and walking cuts keep their original semantic tag outside the exact
 * mask. This path grants no canonical driving-floor removal authority. */
export function qualifyDeliveryJunctionNonRoadSupersession(o:JunctionSupersessionOptions){
 const tag=o.selection.tag,role:string=o.selection.role;
 assert.ok(tag==='road:asphalt'?role==='native-upper-carriageway':
  ['raised:asphalt','raised:slabs'].includes(tag)?role==='native-upper-walking':
  ['raised:asphalt:bridge-reconstruction','raised:slabs:bridge-junction'].includes(tag)&&['authored-upper-walking-floor','authored-approach-floor'].includes(role),'Unqualified native/walking source cut');
 return qualifySourceFloorSupersession(o);
}
function qualifySourceFloorSupersession(o:JunctionSupersessionOptions){
 assert.equal(o.parent,o.expectedParent,'Wrong junction parent cannot supersede this bridge');
 assert.equal(o.selection.group,'ground');
 assert.equal(junctionFaceSha(o.sourcePoints),o.selection.orderedFloat32Sha256,'Supersession is not this literal oriented upper ROAD source');
 const positions=Float32Array.from(o.sourcePoints.flat()),mesh={attributes:{POSITION:positions},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.of(0,1,2)};
 const partition=partitionJunctionSourceMesh(mesh,'ground',[o.selection.tag],[{...o.selection,triangle:0}]);
 const expected=Array.from({length:partition.mesh.indices.length/3},(_,t)=>[0,1,2].map(k=>Array.from(partition.mesh.attributes.POSITION!.subarray(partition.mesh.indices[t*3+k]!*3,partition.mesh.indices[t*3+k]!*3+3))));
 const hash=deliveryRoadPhysicalFaceHash,keys=(faces:readonly Triangle[])=>faces.map(hash).sort();
 assert.deepEqual(keys(o.declaredComplement),keys(expected),'Publication omits or invents an outside source-plane fragment');
 const final=new Set(keys(o.finalFaces));for(const p of expected)assert.ok(final.has(hash(p)),'Final world lost an exact oriented outside fragment');
 const polygon=o.sourcePoints.map(p=>[p[0]!,p[2]!]as[number,number]);
 // Masks are a union, not an intersection. Each explicit source-mask portion
 // must be covered by the actual newly authored ROAD on this same parent.
 const portions=o.selection.masks.flatMap((m,i)=>polygonClipping.intersection([[polygon]],[[m.map(p=>[p[0],p[1]]as[number,number])]]).map((p,j)=>({id:`junction-source-cut-${i}-${j}`,polygon:p[0]!})));
 assert.ok(portions.length,'An unrelated mask cannot authorize removal');
 // Coverage of one source face only needs replacement triangles whose boxes
 // meet that face plus the existing construction bound. Unioning an entire
 // distant junction for every tiny source cut creates needless near-tangent
 // Boolean intersections and does not add authority to this local query.
 const bound=.00008,x=o.sourcePoints.map(p=>p[0]!),z=o.sourcePoints.map(p=>p[2]!),box=[Math.min(...x)-bound,Math.min(...z)-bound,Math.max(...x)+bound,Math.max(...z)+bound];
 const local=o.newRoadFaces.filter(p=>Math.max(...p.map(v=>v[0]!))>=box[0]!&&Math.min(...p.map(v=>v[0]!))<=box[2]!&&Math.max(...p.map(v=>v[2]!))>=box[1]!&&Math.min(...p.map(v=>v[2]!))<=box[3]!);
 const coverage=deliveryRoadSourceCutCoverage(portions,local.map(points=>({points})));assert.equal(coverage.unexplainedComponents.length,0,'New parent ROAD does not cover the exact removed source-mask region');
 return{sourceFaceSha256:hash(o.sourcePoints),outsideFragments:expected.length,complementaryFragments:expected,coverage};
}

export interface DeliveryJunctionRoadDerivative{
 ref:FileRef;profileRef:FileRef;sourceManifestSha256:string;profile:any;publication:any;
 newRoadFaces:{cell:string;points:number[][];sha256:string;parentBridge:string;recipeId:string}[];
 newFootFaces:{cell:string;points:number[][];sha256:string;parentBridge:string;recipeId:string;surfaceTag:string}[];
 cuts:{cell:string;collider:string;source:FileRef;selection:JunctionSourceSelection;parentBridge:string;recipeId:string;sourcePoints:Triangle;complement:Triangle[]}[];
 nonRoadCuts:DeliveryJunctionRoadDerivative['cuts'];
}
const basic=(r:FileRef)=>({path:r.path,bytes:r.bytes,sha256:r.sha256});
/** Parse the separate derivative without replacing any original bridge contract.
 * Every new mask is reconstructed from its named recipe, never assigned by a
 * bounding box, footprint overlap or a caller-supplied parent label alone. */
export function readDeliveryJunctionRoadDerivatives(world:string,manifest:WorldManifest,parents:readonly DeliveryBridgeRoadAuthority[],originalPublications:readonly FileRef[]):DeliveryJunctionRoadDerivative[]{
 const refs=(manifest as WorldManifest&{publicationFiles?:FileRef[]}).publicationFiles??[],found=refs.filter(r=>/^publication\/junction-mouths\/(?:[a-z0-9-]+\/)?reconstruction\.json\.gz$/.test(r.path));assert.equal(new Set(found.map(r=>r.path)).size,found.length,'Ambiguous junction derivative');assert.ok(found.length<=12);const result:DeliveryJunctionRoadDerivative[]=[];
 for(const ref of found){const publication=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decodeDeliverySimulation(readDeliveryFile(world,ref),ref))),stage=ref.path.match(/^publication\/junction-mouths\/([a-z0-9-]+)\/reconstruction\.json\.gz$/),profilePath=stage?`publication/junction-mouths/${stage[1]}/profile.json`:'publication/junction-mouths/profile.json',profileRefs=refs.filter(r=>r.path===profilePath||r.path===profilePath+'.gz');assert.equal(profileRefs.length,1,'Need exactly one raw or typed gzip junction profile');const profileRef=profileRefs[0]!;
 if(profileRef.path.endsWith('.gz'))assert.equal((profileRef as any).compression,'gzip','Compressed profile requires bounded decoded metadata');
 const profileRaw=decodeDeliverySimulation(readDeliveryFile(world,profileRef),profileRef);assert.equal(deliverySha(profileRaw),publication.profileSha256,'Decoded source profile hash differs');const profile=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(profileRaw));
 if(stage){assert.equal(publication.stageId,stage[1]);assert.equal(profile.stageId,stage[1]);assert.deepEqual(publication.profileRef,profileRef,'Stored and decoded profile metadata must match its publication');assert.deepEqual(publication.parentDerivatives.map(basic),result.map(r=>basic(r.ref)),'A junction chain cannot omit, replace or reorder its predecessor');}
 else assert.equal(found.length,1,'Legacy diagnostic cannot be mixed with staged derivatives');
 assert.equal(publication.schemaVersion,1);assert.equal(publication.kind,'source-bound-bridge-junction-mouths');assert.equal(profile.schemaVersion,1);assert.equal(profile.kind,'source-bound-upper-bridge-junction-mouths');assert.equal(profile.sourceManifestSha256,publication.sourceManifestSha256);assert.match(profile.sourceManifestSha256,/^[a-f0-9]{64}$/);assert.deepEqual(profile.parentPublications,publication.parentPublications);
 for(const pin of profile.parentPublications){const parent=originalPublications.find(r=>r.path===pin.path);assert.ok(parent,'A junction cannot replace an original bridge publication');assert.deepEqual(basic(parent),basic(pin));}
 assert.ok(Array.isArray(profile.recipes)&&profile.recipes.length>0&&profile.recipes.length<=12);const recipes=new Map<string,any>(),floorSources=new Map<string,any>(),expectedRoad=new Map<string,any>(),expectedFoot=new Map<string,any>();
 const sourceKey=(s:any)=>`${s.cell}/${s.collider}/${s.triangle}/${s.orderedFloat32Sha256}`;
 for(const recipe of profile.recipes){assert.ok(typeof recipe.id==='string'&&!recipes.has(recipe.id));assert.ok(['hameentie-junatie','hakaniemensilta'].includes(recipe.parentBridge));const parent=parents.find(p=>p.id===recipe.parentBridge);assert.ok(parent,'Unknown junction parent');assert.deepEqual(recipe.sourceWayIds,recipe.travel.sourceWayIds);assert.ok(recipe.sourceWayIds.length&&recipe.sourceWayIds.every((id:number)=>Number.isSafeInteger(id)&&id>0));assert.ok(recipe.sourcePartIds.length&&recipe.sourcePartIds.every((id:number)=>Number.isSafeInteger(id)&&id>0));recipes.set(recipe.id,recipe);
  const declared=publication.recipes.find((r:any)=>r.id===recipe.id);assert.ok(declared);for(const key of['parentBridge','sourceWayIds','sourcePartIds','surfaceKind','surfaceTag'])assert.deepEqual(declared[key],recipe[key]);
  const kind=recipe.surfaceKind??'road';assert.ok(kind==='road'||kind==='footway','Unknown physical junction surface kind');
  if(kind==='footway'){assert.ok(['raised:asphalt:bridge-reconstruction','raised:slabs:bridge-junction'].includes(recipe.surfaceTag),'Foot floor requires its explicit physical tag');assert.equal(recipe.carriagewayDomain,undefined,'Walking floor cannot inherit a driving domain');assert.equal(recipe.surfaceDomain?.kind,'walking');assert.deepEqual(recipe.surfaceDomain.sourcePartIds,recipe.sourcePartIds);assert.match(recipe.surfaceDomain.streetPartsSha256,/^[a-f0-9]{64}$/);assert.ok(recipe.surfaceDomain.polygons?.length,'Walking floor needs its exact named source domain');}
  else{assert.equal(recipe.surfaceDomain,undefined,'Driving authority cannot come from walking polygons');if(recipe.surfaceKind!==undefined)assert.equal(recipe.surfaceTag,'road:asphalt:bridge-reconstruction');else assert.equal(recipe.surfaceTag,undefined);}
  for(const source of recipe.floorSources){const key=sourceKey(source.source);assert.ok(!floorSources.has(key),'Ambiguous source-floor removal parent');assert.equal(junctionFaceSha(source.points),source.source.orderedFloat32Sha256);floorSources.set(key,{...source,parentBridge:recipe.parentBridge,recipeId:recipe.id,surfaceKind:kind});}
  const domain=kind==='footway'?recipe.surfaceDomain.polygons:recipe.carriagewayDomain?.polygons,options=recipe.surfaceKind===undefined?undefined:{surfaceKind:kind,surfaceTag:recipe.surfaceTag};
  const compiled=compileJunctionFloorSurfaces(recipe.travel,recipe.floorSources,domain,options as any);assert.deepEqual(declared.floorProof,JSON.parse(JSON.stringify(compiled.proof)),'Published floor differs from its exact source-qualified recipe');
  for(const[cell,faces]of splitBridgeFaces(compiled.faces))for(const face of faces){const sha256=junctionFaceSha(face.points),key=cell+'/'+sha256;assert.ok(!expectedRoad.has(key)&&!expectedFoot.has(key),'Overlapping junction recipe floors need an explicit single owner');const row={cell,points:face.points,sha256,parentBridge:recipe.parentBridge,recipeId:recipe.id};if(kind==='footway')expectedFoot.set(key,{...row,surfaceTag:recipe.surfaceTag});else expectedRoad.set(key,row);}
 }
 assert.equal(publication.recipes.length,recipes.size);assert.ok(Array.isArray(publication.newRoadFaces));const newRoadFaces:DeliveryJunctionRoadDerivative['newRoadFaces']=[];const seenRoad=new Set<string>();for(const row of publication.newRoadFaces){const key=row.cell+'/'+row.sha256,expected=expectedRoad.get(key);assert.ok(expected&&!seenRoad.has(key),'New ROAD face is missing, repeated or outside every exact recipe');assert.equal(junctionFaceSha(row.points),row.sha256);assert.deepEqual(row,expected,'New ROAD parent/recipe/XYZ attribution changed');seenRoad.add(key);newRoadFaces.push(row);}assert.equal(seenRoad.size,expectedRoad.size,'Publication omits a positive encoded recipe floor');
 const newFootFaces:DeliveryJunctionRoadDerivative['newFootFaces']=[],seenFoot=new Set<string>();for(const row of publication.newFootFaces??[]){const key=row.cell+'/'+row.sha256,expected=expectedFoot.get(key);assert.ok(expected&&!seenFoot.has(key),'New FOOT face is missing, repeated or outside its exact recipe');assert.equal(junctionFaceSha(row.points),row.sha256);assert.deepEqual(row,expected,'New FOOT tag/parent/recipe/XYZ attribution changed');seenFoot.add(key);newFootFaces.push(row);}assert.equal(seenFoot.size,expectedFoot.size,'Publication omits a positive encoded walking floor');
 const cuts:DeliveryJunctionRoadDerivative['cuts']=[],nonRoadCuts:DeliveryJunctionRoadDerivative['cuts']=[],seenSources=new Set<string>();for(const update of publication.updates){const before=profile.sourceCells.find((c:any)=>c.id===update.cell);assert.ok(before);assert.deepEqual(basic(update.before.collision),basic(before.collision));for(const group of update.selections){assert.deepEqual(basic(group.source),basic(before.collision));for(const selection of group.selectedSourceFaces){if(!['native-upper-carriageway','authored-approach-floor','native-upper-walking','authored-upper-walking-floor'].includes(selection.role))continue;assert.equal(selection.group,'ground');assert.equal(group.group,'ground');const key=sourceKey({cell:update.cell,collider:group.collider,...selection}),source=floorSources.get(key);assert.ok(source&&!seenSources.has(key),'Unrelated source face cannot gain a canonical removal exception');assert.equal(selection.tag,source.tag);assert.deepEqual(selection.masks,source.masks);seenSources.add(key);if(source.surfaceKind==='footway'&&selection.tag!=='road:asphalt:bridge-reconstruction')assert.ok(['native-upper-walking','authored-upper-walking-floor'].includes(selection.role),'Walking source needs a distinct explicit source-cut role');const cut={cell:update.cell,collider:group.collider,source:group.source,selection,parentBridge:source.parentBridge,recipeId:source.recipeId,sourcePoints:source.points,complement:group.complementaryFragments.filter((r:any)=>r.sourceTriangle===selection.triangle).map((r:any)=>r.points)};if(selection.tag==='road:asphalt:bridge-reconstruction'){assert.equal(selection.role,'authored-approach-floor');cuts.push(cut);}else nonRoadCuts.push(cut);}}}
 assert.equal(seenSources.size,floorSources.size,'Publication omits a recipe source-floor cut binding');
 result.push({ref,profileRef,sourceManifestSha256:profile.sourceManifestSha256,profile,publication,newRoadFaces,newFootFaces,cuts,nonRoadCuts});
 }
 return result;
}
