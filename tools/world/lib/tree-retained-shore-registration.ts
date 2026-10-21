/** One individually reviewed partly supported birch on the precise Töölönlahti
 * bank. This keeps a plausible bank-side placement; it cannot omit a tree. */
import assert from 'node:assert/strict';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {parseCollisionBundle,type CellDescriptor,type FileRef} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon,type LocalPolygon} from './geometry.ts';
import {barkTriangleIntersections,measureTreeBarkProfile,transformedTreeBark,type BarkTriangle,type TreeBarkModel,type TreeBarkProfile} from './tree-bark-registration.ts';
import {registrationSha256 as sha,treeRegistrationPoints,type RegistrationTree,type GroundRegistrationSupport,type TreeSoilContext} from './tree-ground-registration.ts';
import {qualifyPreciseLakeAuthority,qualifyPreciseLakeWaterMask,type PreciseLakeTreeBinding,type PreciseLakeWaterClassification} from './tree-precise-water-registration.ts';

const reviewedId='TREE_SUMMER_0f319ac7-6ecb-4525-9c85-a38a3454c999';
const identitySha='d977314a59f8048cafe0617fa7f58fbbbbc86e7c3e2a050d3d25c00902149e6f';
type Support=GroundRegistrationSupport|null;
export interface ShoreNativeFace {kind:'visual'|'collision';cell:string;name:string;primitive:number;triangle:number;points:BarkTriangle}
export interface ShoreNativePin {cell:string;visual:FileRef;collision:FileRef}
export interface RetainedShoreTreeBinding {kind:'reviewed-retained-precise-lake-bank';preciseMunicipalWater:PreciseLakeTreeBinding;native:{cells:ShoreNativePin[];candidateInventorySha256:string}}
type Box=[number,number,number,number,number,number];
const box=(points:readonly (readonly number[])[]):Box=>[Math.min(...points.map(p=>p[0]!)),Math.min(...points.map(p=>p[1]!)),Math.min(...points.map(p=>p[2]!)),Math.max(...points.map(p=>p[0]!)),Math.max(...points.map(p=>p[1]!)),Math.max(...points.map(p=>p[2]!))];
const overlaps=(a:Box,b:Box)=>a[0]<=b[3]&&a[3]>=b[0]&&a[1]<=b[4]&&a[4]>=b[1]&&a[2]<=b[5]&&a[5]>=b[2];

/** Read every active native visual/HCOL face in the entire actual bark bounds,
 * including high branches. No two-metre vertical window or vertical-face filter. */
export async function readRetainedShoreBarkNative(tree:RegistrationTree,model:TreeBarkModel,target:number,cells:readonly CellDescriptor[],payload:(cell:CellDescriptor,kind:'visual'|'collision')=>Uint8Array){
 const bounds=box([tree.position[1],target].flatMap(y=>transformedTreeBark(model,tree,y).flat())),selected=cells.filter(c=>{const b=c.collision.boundsXZ??c.boundsXZ;return b[0]<=bounds[3]&&b[2]>=bounds[0]&&b[1]<=bounds[5]&&b[3]>=bounds[2]||c.buildings.some(v=>v.boundsRuntime.min[0]<=bounds[3]&&v.boundsRuntime.max[0]>=bounds[0]&&v.boundsRuntime.min[2]<=bounds[5]&&v.boundsRuntime.max[2]>=bounds[2]);});
 const faces:ShoreNativeFace[]=[],pins:ShoreNativePin[]=[];await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
 for(const cell of selected){
  pins.push({cell:cell.id,visual:cell.visual.lod0,collision:cell.collision});const doc=await io.readBinary(payload(cell,'visual')),root=doc.getRoot(),scenes=root.listScenes(),scene=root.getDefaultScene()??(scenes.length===1?scenes[0]:undefined);assert.ok(scene,'Retained shore proof requires an unambiguous active scene');
  const nodes=new Set<ReturnType<typeof scene.listChildren>[number]>(),visit=(n:ReturnType<typeof scene.listChildren>[number])=>{if(nodes.has(n))return;nodes.add(n);n.listChildren().forEach(visit);};scene.listChildren().forEach(visit);
  for(const node of nodes){const M=node.getWorldMatrix();for(const[primitive,p]of(node.getMesh()?.listPrimitives()??[]).entries()){const P=p.getAttribute('POSITION'),I=p.getIndices();assert.ok(P&&I&&p.getMode()===4,'Native bark proof requires indexed triangles');for(let i=0;i<I.getCount();i+=3){const points=[0,1,2].map(j=>{const v=P.getElement(I.getScalar(i+j),[]);return[0,1,2].map(a=>M[a]!*v[0]!+M[4+a]!*v[1]!+M[8+a]!*v[2]!+M[12+a]!)as[number,number,number];})as BarkTriangle;if(overlaps(bounds,box(points)))faces.push({kind:'visual',cell:cell.id,name:node.getName(),primitive,triangle:i/3,points});}}}
  const collision=parseCollisionBundle(payload(cell,'collision'));for(const c of collision.colliders){if(c.ref===tree.id||c.id==='t:'+tree.id)continue;for(let i=0;i<c.indices.length;i+=3){const points=[0,1,2].map(j=>Array.from(c.positions.subarray(c.indices[i+j]!*3,c.indices[i+j]!*3+3)))as BarkTriangle;if(overlaps(bounds,box(points)))faces.push({kind:'collision',cell:cell.id,name:c.id,primitive:0,triangle:i/3,points});}}
 }
 return{cells:pins,candidateInventorySha256:sha(JSON.stringify(faces)),faces};
}

export function qualifyRetainedPreciseLakeBank(tree:RegistrationTree,model:TreeBarkModel,binding:RetainedShoreTreeBinding,evidence:{
 source:{sha256:string;polygons:readonly LocalPolygon[];classification:PreciseLakeWaterClassification};water:readonly LocalPolygon[];waterY:number;context:TreeSoilContext;
 points:readonly[number,number][];collision:readonly Support[];visual:readonly Support[];profile:TreeBarkProfile;denseVisual:readonly Support[];
 native:Awaited<ReturnType<typeof readRetainedShoreBarkNative>>;
}){
 assert.equal(binding.kind,'reviewed-retained-precise-lake-bank');assert.equal(tree.id,reviewedId,'Retained shore review is restricted to one individually measured source tree');
 assert.equal(sha(JSON.stringify({id:tree.id,position:tree.position,model:tree.model,scale:tree.scale,yaw:tree.yaw})),identitySha,'Reviewed retained shore placement changed');
 const lake=qualifyPreciseLakeAuthority(model,binding.preciseMunicipalWater,evidence.source);qualifyPreciseLakeWaterMask(binding.preciseMunicipalWater,evidence.source.classification,evidence.water);
 const {profile}=evidence;let rootCall=true;const measured=measureTreeBarkProfile(model,tree,points=>{const expected=rootCall?profile.rootPoints:profile.gridPoints,samples=rootCall?profile.rootSamples:profile.gridSamples;rootCall=false;assert.deepEqual(points,expected,'Retained shore root/dense domain changed');return samples;});assert.deepEqual(measured,profile,'Retained shore dense profile was not measured from the actual bark domain');
 const root=profile.rootPoints.slice(1);assert.deepEqual(evidence.points,[...treeRegistrationPoints(tree),...root]);
 assert.equal(evidence.collision.length,18);assert.equal(evidence.visual.length,18);assert.equal(profile.rootPoints.length,10);assert.equal(profile.gridPoints.length,505);assert.equal(evidence.denseVisual.length,505);
 assert.ok(profile.range&&profile.plane&&profile.missing>0);assert.equal(profile.rootSamples.filter(Boolean).length,3,'Measured bank-side root support changed');assert.equal(profile.gridSamples.filter(Boolean).length,150,'Measured bank-side dense support changed');assert.equal(evidence.collision.filter(Boolean).length,6);
 assert.ok(!evidence.context.buildingIds.length&&!evidence.context.retainingWallIds.length,'Retained shore review cannot hide a mapped structure');
 const pairs=(points:readonly[number,number][],collision:readonly Support[],visual:readonly Support[])=>{assert.equal(points.length,collision.length);assert.equal(points.length,visual.length);for(let i=0;i<points.length;i++){const p=points[i]!,a=collision[i],b=visual[i];assert.equal(!!a,!!b,'Retained shore visible/collision support mismatch');const en:[number,number]=[p[0],-p[1]],wet=pointInPolygon(en,lake.rings)&&evidence.water.some(w=>pointInPolygon(en,w.rings));if(a){assert.ok(Math.abs(a.height-b!.height)<=.02,'Retained shore visible/collision height mismatch');assert.ok(!pointInPolygon(en,lake.rings)&&!evidence.water.some(w=>pointInPolygon(en,w.rings)),'A dry bank sample conflicts with independently protected water');}else assert.ok(wet,'Retained shore review cannot hide an unsupported dry point');}};
 pairs(evidence.points,evidence.collision,evidence.visual);pairs(profile.rootPoints,profile.rootSamples,[evidence.visual[0]!,...evidence.visual.slice(9)]);pairs(profile.gridPoints,profile.gridSamples,evidence.denseVisual);
 assert.ok(profile.range[1]-profile.range[0]<.10&&profile.maximumAdjacentStep<=.02&&profile.plane.maximumResidual<=.04,'Retained native bank is discontinuous');assert.ok(Number.isFinite(evidence.waterY)&&profile.range[0]>evidence.waterY&&profile.range[0]-evidence.waterY<1,'Retained shore water/soil elevation inconsistent');
 const target=Math.min(profile.range[0]-.3,evidence.waterY-.02);assert.ok(target+tree.colliderHeight-profile.range[1]>=1,'Retained shore correction would bury the clear trunk');
 assert.deepEqual(evidence.native.cells,binding.native.cells,'Retained shore native payload authority changed');assert.equal(evidence.native.candidateInventorySha256,binding.native.candidateInventorySha256,'Retained shore full-height native inventory changed');assert.equal(sha(JSON.stringify(evidence.native.faces)),evidence.native.candidateInventorySha256);
 assert.ok(evidence.native.faces.some(f=>f.kind==='visual')&&evidence.native.faces.some(f=>f.kind==='collision'),'Retained shore proof requires both native representations');
 const gate=profile.range[1]+.01,rows=[tree.position[1],target].map(y=>{const bark=transformedTreeBark(model,tree,y),boxes=bark.map(t=>box(t)),hits=evidence.native.faces.flatMap(f=>{const B=box(f.points),intersections=bark.flatMap((t,i)=>overlaps(B,boxes[i]!)?barkTriangleIntersections(t,f.points):[]);if(!intersections.length)return[];assert.ok(intersections.every(p=>p[1]<=gate),'Actual above-soil bark intersects a native face');return[{kind:f.kind,cell:f.cell,name:f.name,primitive:f.primitive,triangle:f.triangle,faceSha256:sha(JSON.stringify(f.points)),maximumIntersectionY:Math.max(...intersections.map(p=>p[1]))}];});assert.ok(hits.some(h=>h.kind==='visual')&&hits.some(h=>h.kind==='collision'),'Retained shore proof needs real source/bank bark contacts');return{y,hits};});
 return{kind:binding.kind,id:tree.id,anchor:profile.range[0],target,waterY:evidence.waterY,profileSha256:profile.sha256,rootDry:3,rootCount:10,denseDry:150,denseCount:505,aboveSoilGate:gate,native:{cells:evidence.native.cells,candidateInventorySha256:evidence.native.candidateInventorySha256,candidateFaces:evidence.native.faces.length},rows,interpretation:'The actual native bark has coherent dry bank contacts and no above-soil native obstruction at source or intended Y. The partly wet original XZ placement is retained; no soil or real-tree absence is invented.'};
}
