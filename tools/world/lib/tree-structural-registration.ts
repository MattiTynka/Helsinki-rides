/** One reviewed source placement whose real bark branches cross a building above
 * the ordinary two-metre root-obstacle window. No source projection is extruded. */
import assert from 'node:assert/strict';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {parseCollisionBundle,type CellDescriptor,type FileRef} from '../../../packages/world-schema/src/index.ts';
import {transformedTreeBark,barkTriangleIntersections,type BarkTriangle,type TreeBarkModel,type TreeBarkProfile} from './tree-bark-registration.ts';
import {registrationSha256,type RegistrationTree,type TreeSoilContext} from './tree-ground-registration.ts';

const reviewed={tree:'TREE_SUMMER_3ea76f65-e162-4487-a74c-2ef309951fa6',building:'104251989C',buildingRef:'BID_beda8ed1-eac1-42fb-bc09-5c57991bc871'};
export interface FullBarkStructureBinding {
  kind:'reviewed-full-height-bark-structure';model:string;barkModelSha256:string;buildingId:string;buildingRef:string;
  visual:{cell:string;file:FileRef;node:string;primitive:number;triangle:number;verticesSha256:string};
  collision:{cell:string;file:FileRef;collider:string;triangle:number;verticesSha256:string};
}
const sha=registrationSha256;
const verticesSha=(t:BarkTriangle)=>sha(JSON.stringify(t));
/** Read exact active visual and HCOL faces from independently hash-checked payloads.
 * Delivery payloadReader supplies its pinned embedded/decompressed inspection view. */
export async function readFullBarkStructureFaces(binding:FullBarkStructureBinding,cells:readonly CellDescriptor[],payload:(cell:CellDescriptor,kind:'visual'|'collision')=>Uint8Array){
  assert.equal(binding.kind,'reviewed-full-height-bark-structure');assert.equal(binding.buildingId,reviewed.building);assert.equal(binding.buildingRef,reviewed.buildingRef);
  const visualCell=cells.find(c=>c.id===binding.visual.cell),collisionCell=cells.find(c=>c.id===binding.collision.cell);assert.ok(visualCell&&collisionCell);
  const checkRef=(actual:FileRef,expected:FileRef)=>assert.deepEqual({path:actual.path,bytes:actual.bytes,sha256:actual.sha256},expected,'Structural tree source payload changed');
  checkRef(visualCell.visual.lod0,binding.visual.file);checkRef(collisionCell.collision,binding.collision.file);
  for(const cell of[visualCell,collisionCell])assert.ok(cell.buildings.some(b=>b.id===reviewed.buildingRef&&(b.vtj===reviewed.building||b.registerId===reviewed.building)),'Native building does not match the independently mapped source structure');
  await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}),doc=await io.readBinary(payload(visualCell,'visual'));
  const nodes=doc.getRoot().listNodes().filter(n=>n.getName()===binding.visual.node);assert.equal(nodes.length,1,'Structural visual node must be unambiguous');
  const node=nodes[0]!,primitive=node.getMesh()?.listPrimitives()[binding.visual.primitive];assert.ok(primitive&&primitive.getMode()===4);const P=primitive.getAttribute('POSITION'),I=primitive.getIndices();assert.ok(P&&I);assert.ok(Number.isInteger(binding.visual.triangle)&&binding.visual.triangle>=0&&binding.visual.triangle*3+2<I.getCount());
  const M=node.getWorldMatrix(),visual=[0,1,2].map(k=>{const p=P.getElement(I.getScalar(binding.visual.triangle*3+k),[]);return[0,1,2].map(a=>M[a]!*p[0]!+M[4+a]!*p[1]!+M[8+a]!*p[2]!+M[12+a]!)as[number,number,number];})as BarkTriangle;
  const bundle=parseCollisionBundle(payload(collisionCell,'collision')),body=bundle.colliders.find(c=>c.id===binding.collision.collider);assert.ok(body&&body.group==='buildings'&&body.ref===binding.buildingRef,'HCOL structural source changed');assert.ok(Number.isInteger(binding.collision.triangle)&&binding.collision.triangle>=0&&binding.collision.triangle*3+2<body.indices.length);
  const collision=[0,1,2].map(k=>Array.from(body.positions.subarray(body.indices[binding.collision.triangle*3+k]!*3,body.indices[binding.collision.triangle*3+k]!*3+3)))as BarkTriangle;
  assert.equal(verticesSha(visual),binding.visual.verticesSha256,'Native visual structural face changed');assert.equal(verticesSha(collision),binding.collision.verticesSha256,'Native HCOL structural face changed');return{visual,collision};
}
function vertical(t:BarkTriangle){assert.ok(t.flat().every(Number.isFinite));const a=t[1].map((v,k)=>v-t[0][k]!),b=t[2].map((v,k)=>v-t[0][k]!),n=[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!],length=Math.hypot(...n);assert.ok(length>1e-12&&Math.abs(n[1]!)/length<=.3,'Only actual vertical structural faces qualify; soil and horizontal stacked floors cannot authorize omission');}
export function qualifyFullBarkStructureOmission(tree:RegistrationTree,model:TreeBarkModel,profile:TreeBarkProfile,context:TreeSoilContext,binding:FullBarkStructureBinding,faces:{visual:BarkTriangle;collision:BarkTriangle}){
  assert.equal(tree.id,reviewed.tree,'Full-height structural review is restricted to the individually qualified source tree');assert.equal(binding.kind,'reviewed-full-height-bark-structure');assert.equal(binding.model,tree.model);assert.equal(binding.barkModelSha256,sha(JSON.stringify(model)),'Actual bark model changed');assert.equal(binding.buildingId,reviewed.building);assert.equal(binding.buildingRef,reviewed.buildingRef);assert.ok(context.buildingIds.includes(reviewed.building),'The actual source building must intersect the root domain');
  assert.ok(profile.range&&profile.missing===0,'Structural omission cannot mask missing soil');assert.equal(verticesSha(faces.visual),binding.visual.verticesSha256);assert.equal(verticesSha(faces.collision),binding.collision.verticesSha256);vertical(faces.visual);vertical(faces.collision);
  const target=Math.abs(profile.range[0]-.3-tree.position[1])>.15?profile.range[0]-.3:tree.position[1],minimumVisibleY=profile.range[1]+.01;
  const rows=[tree.position[1],target].map(y=>{const bark=transformedTreeBark(model,tree,y),intersections=(t:BarkTriangle)=>bark.flatMap(b=>barkTriangleIntersections(b,t)).filter(p=>p[1]>minimumVisibleY),visual=intersections(faces.visual),collision=intersections(faces.collision);assert.ok(visual.length&&collision.length,'Actual above-soil bark must intersect independently pinned native visual and HCOL building faces at both source and intended Y');return{y,visualIntersections:visual,collisionIntersections:collision};});
  return{kind:binding.kind,tree:tree.id,model:tree.model,barkModelSha256:binding.barkModelSha256,buildingId:binding.buildingId,buildingRef:binding.buildingRef,minimumVisibleY,profileSha256:profile.sha256,nativeVisual:binding.visual,nativeCollision:binding.collision,rows,interpretation:'The supplied tree model has woody branches inside an actual mapped building at both source and intended soil height. This is model/source incompatibility; no inference that the real tree is absent.'};
}
