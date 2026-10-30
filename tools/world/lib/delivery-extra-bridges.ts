import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import {geodeticToGk25,parseCollisionBundle,type WorldManifest,type FileRef} from '../../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons,pointInPolygon} from './geometry.ts';
import {readDeliveryFile} from './delivery-city.ts';
import {decodeDeliverySimulation,deliverySha} from './delivery-city-payloads.ts';
import {extraBridgeUpperParts,extraBridgeBankSegments,extraBridgeBankCoverage,extraBridgeBankHeight,extraBridgeLocal,extraBridgeWorld,extraBridgeSourceAxes,type ExtraBridgeNativeFace,type ExtraBridgeUpperPart} from './delivery-extra-bridges-source.ts';
import {buildExtraBridgeDeck,extraBridgePartSide,type ExtraBridgeDeckProfile} from './delivery-extra-bridges-mesh.ts';
import {layeredFloorSampler} from './layered-bridge-field.ts';
import {sourcePartsForTriangle,readLayeredSourceParts,type LayeredSourcePart} from './layered-bridge-source.ts';
import type {SupportTriangle} from './tram-support-repair.ts';
import {supportHeight} from './tram-support-repair.ts';
import {readExtraBridgeSourceBank} from './delivery-extra-bridges-bank.ts';
import {extraBridgePierRectangle,qualifyExtraBridgePierBearing,qualifyExtraBridgePierKeepOut,qualifyExtraBridgePierAxes} from './delivery-extra-bridges-piers.ts';
import {qualifySourceBoundPassages,type SourceQualifiedLowerPassages} from './delivery-bridge-scoped-passages.ts';
export interface ExtraBridgeProfile {
  schemaVersion:1;id:string;name:string;sourceManifestSha256:string;
  sources:{osm:{path:string;sha256:string};streetParts:{path:string;sha256:string}};
  frameAxis:{wayId:number;fromNodeId:number;toNodeId:number};
  deck:ExtraBridgeDeckProfile;bankPartIds:number[];lowerSource:{name:string;partIds:number[]};
  /** Individually named public source records and an optional pinned outside-raster bank replay. */
  sourcePartNames?:Record<string,string>;sourceBank?:{path:string;sha256:string};
  sourceQualifiedLowerPassages?:SourceQualifiedLowerPassages;
  minimumLowerClearanceMetres:number;lowerUse?:'pedestrian';nonTrafficLowerPartIds?:number[];sourceRoadWayIds:number[];
  references:{url:string;date:string;observation:string}[];
  status:'SOURCE_BOUND_AUTHORED_APPROXIMATION_PENDING_NATIVE_ACCEPTANCE';
}
const bounds=(points:readonly(readonly number[])[])=>[Math.min(...points.map(p=>p[0]!)),Math.min(...points.map(p=>p[1]!)),Math.max(...points.map(p=>p[0]!)),Math.max(...points.map(p=>p[1]!))];
export function readExtraBridgeSources(profile:ExtraBridgeProfile,root:string){
  const read=(ref:{path:string;sha256:string})=>{assert.ok(!path.isAbsolute(ref.path)&&!ref.path.split(/[\\/]/).includes('..'));const bytes=fs.readFileSync(path.resolve(root,ref.path));assert.equal(deliverySha(bytes),ref.sha256);return bytes;};
  const osm=JSON.parse(read(profile.sources.osm).toString()),streets=read(profile.sources.streetParts);return{osm,streets};
}
export function extraBridgePhysicalFaces(world:string,manifest:WorldManifest,box:readonly number[]){
  const faces:ExtraBridgeNativeFace[]=[],files:{cell:string;ref:FileRef}[]=[];
  for(const cell of manifest.cells){const b=cell.collision.boundsXZ??cell.boundsXZ;if(b[0]>box[2]!||b[2]<box[0]!||b[1]>box[3]!||b[3]<box[1]!)continue;
    const bundle=parseCollisionBundle(decodeDeliverySimulation(readDeliveryFile(world,cell.collision),cell.collision));files.push({cell:cell.id,ref:cell.collision});
    for(const c of bundle.colliders)if(c.group==='ground'||c.group==='kerbs')for(let triangle=0;triangle<c.indices.length/3;triangle++){
      const points=[0,1,2].map(k=>Array.from(c.positions.subarray(c.indices[triangle*3+k]!*3,c.indices[triangle*3+k]!*3+3))) as SupportTriangle;
      const b=bounds(points.map(p=>[p[0],p[2]]));if(b[0]!>box[2]!||b[2]!<box[0]!||b[1]!>box[3]!||b[3]!<box[1]!)continue;
      faces.push({points,cell:cell.id,collider:c.id,triangle,tag:bundle.header.surfaceTags[c.triangleTags[triangle]!]!,group:c.group});
    }
  }return{faces,files};
}
export function extraBridgeNamedParts(parts:ReturnType<typeof loadGeoJsonPolygons>,ids:readonly number[],profile:Pick<ExtraBridgeProfile,'name'|'sourcePartNames'>){return ids.flatMap(id=>extraBridgeUpperParts(parts,[id],profile.sourcePartNames?.[id]??profile.name));}
export function extraBridgeLowerParts(streetBytes:Uint8Array,profile:ExtraBridgeProfile){const source=JSON.parse(Buffer.from(streetBytes).toString());return profile.lowerSource.partIds.flatMap(id=>readLayeredSourceParts(source,[id],profile.sourcePartNames?.[id]??profile.lowerSource.name));}
export async function qualifyDeliveryExtraBridge(options:{world:string;profile:ExtraBridgeProfile;sourceRoot:string;expectedManifestSha256:string}){
  const{profile}=options,bytes=fs.readFileSync(path.join(options.world,'manifest.json'));assert.equal(deliverySha(bytes),options.expectedManifestSha256);const manifest=JSON.parse(bytes.toString()) as WorldManifest;
  assert.equal(profile.schemaVersion,1);assert.match(profile.id,/^[a-z][a-z0-9-]+$/);assert.equal(profile.status,'SOURCE_BOUND_AUTHORED_APPROXIMATION_PENDING_NATIVE_ACCEPTANCE');assert.ok(profile.references.length);
  const{osm,streets}=readExtraBridgeSources(profile,options.sourceRoot),parts=loadGeoJsonPolygons(path.resolve(options.sourceRoot,profile.sources.streetParts.path),manifest.origin.originProjected[0],manifest.origin.originProjected[1],p=>String(p.osan_id));
  const sourceUpper=extraBridgeNamedParts(parts,profile.deck.upperParts.map(p=>p.id),profile);
  for(const declared of profile.deck.upperParts){const source=sourceUpper.find(p=>p.id===declared.id)!;assert.deepEqual({...declared,boundsS:undefined},{...source,boundsS:undefined},'Upper source footprint changed');if(declared.boundsS)assert.ok(declared.boundsS[0]>=profile.deck.banks[0].s&&declared.boundsS[1]<=profile.deck.banks[1].s);}
  const way=osm.elements.find((e:any)=>e.type==='way'&&e.id===profile.frameAxis.wayId);assert.ok(way?.nodes?.includes(profile.frameAxis.fromNodeId)&&way.nodes.includes(profile.frameAxis.toNodeId));
  const nodes=new Map<number,any>(osm.elements.filter((e:any)=>e.type==='node').map((e:any)=>[e.id,e]));const project=(id:number)=>{const node=nodes.get(id);assert.ok(node);const[E,N]=geodeticToGk25(node.lat,node.lon);return[E-manifest.origin.originProjected[0],manifest.origin.originProjected[1]-N] as[number,number];};
  const A=project(profile.frameAxis.fromNodeId),B=project(profile.frameAxis.toNodeId),L=Math.hypot(B[0]-A[0],B[1]-A[1]);assert.deepEqual(profile.deck.frame,{origin:A,direction:[(B[0]-A[0])/L,(B[1]-A[1])/L]},'Working frame is not the declared exact source axis');
  const result=buildExtraBridgeDeck(profile.deck),box=bounds(result.faces.flatMap(f=>f.points.map(p=>[p[0],p[2]]))),physical=extraBridgePhysicalFaces(options.world,manifest,profile.sourceQualifiedLowerPassages?box.map((v,i)=>v+(i<2?-40:40)):box),bankParts=extraBridgeNamedParts(parts,profile.bankPartIds,profile),sourceBank=profile.sourceBank?readExtraBridgeSourceBank(profile.sourceBank,options.sourceRoot):undefined;
  if(sourceBank){assert.equal(sourceBank.source.streetParts.sha256,profile.sources.streetParts.sha256);assert.deepEqual(sourceBank.source.originProjected,manifest.origin.originProjected);assert.ok(sourceBank.source.partIds.every(id=>profile.bankPartIds.includes(id)));}
  const bankProofs=profile.deck.banks.map(bank=>{
    const external=bank.segments.some(s=>s.source.cell.startsWith('source-buffer:'));assert.ok(!external||sourceBank,'Outside bank requires a hash-bound source replay');
    const segments=extraBridgeBankSegments(profile.deck.frame,bank.s,external?sourceBank!.faces:physical.faces,bankParts);assert.deepEqual(segments,bank.segments,'Actual full-width bank authority changed');
    if(external){const grid=terrainRuntimeBounds(manifest);for(const segment of segments)for(const t of[segment.t0,segment.t1]){const[x,z]=extraBridgeWorld(profile.deck.frame,bank.s,t);assert.ok(x<grid[0]!||x>grid[2]!||z<grid[1]!||z>grid[3]!,'Raw-buffer bank cannot replace an existing runtime bank witness');}}
    return{bankS:bank.s,...extraBridgeBankCoverage(segments,[...new Set(segments.map(s=>s.role))].flatMap(role=>{
      const groups=role==='road'?[0]:[-1,1];return groups.flatMap(sign=>{const a=segments.filter(s=>s.role===role&&(sign===0||s.sourcePartIds.some(id=>extraBridgePartSide(profile.deck,role,(s.t0+s.t1)/2,id)===sign)));return a.length?[{role,t0:Math.min(...a.map(s=>s.t0)),t1:Math.max(...a.map(s=>s.t1))}]:[];});}))};
  });
  const upperFaces=result.faces.filter(f=>f.role==='road'||f.role==='footway'),upperFloors=upperFaces.map(f=>f.points),negativeFloor=layeredFloorSampler(upperFloors.map(p=>p.map(v=>[v[0],-v[1],v[2]]) as SupportTriangle)),lowerParts=extraBridgeLowerParts(streets,profile);
  assert.ok(profile.minimumLowerClearanceMetres>=(profile.lowerUse==='pedestrian'?2.2:4.2)&&profile.minimumLowerClearanceMetres<=5.5);let clearanceSamples=0,minimumClearance=Infinity;const lowerProofs=[],structureProofs=[];
  const structures=new Set(profile.nonTrafficLowerPartIds??[]);for(const id of structures){assert.ok(profile.lowerSource.partIds.includes(id));const part=parts.find(p=>p.id===String(id));assert.ok(part);assert.equal(part.properties.paatyyppi,'Erityiskohteet');assert.equal(part.properties.alatyyppi,'Muu rakenne');const axis=extraBridgeSourceAxes(osm,part.rings.map(r=>r.map(([x,n])=>[x,-n])));assert.ok(axis.every(a=>profile.sourceRoadWayIds.includes(a.wayId)&&!['footway','pedestrian','path','cycleway','steps'].includes(a.tags.highway!)),'A mapped lower public axis forbids nontraffic-structure classification');structureProofs.push({partId:id,sourcePolygonSha256:deliverySha(JSON.stringify(part)),sourceProperties:part.properties,overlappingAxes:axis,minimumSlabSeparationMetres:.1,intersections:0,minimumActualSeparationMetres:Infinity});}
  const scoped=profile.sourceQualifiedLowerPassages?await qualifySourceBoundPassages({world:options.world,manifest,root:options.sourceRoot,contract:profile.sourceQualifiedLowerPassages,profile:profile.deck,upperFloors,physical,osm,streets:JSON.parse(Buffer.from(streets).toString()),sourceHashes:{osm:profile.sources.osm.sha256,streetParts:profile.sources.streetParts.sha256},lowerPartIds:profile.lowerSource.partIds}):undefined;
  if(scoped){assert.equal(structures.size,0,'Scoped lower passages cannot use a nontraffic exception');clearanceSamples=scoped.proof.open.reduce((n,p)=>n+p.proof.witnesses.length,0);minimumClearance=Math.min(...scoped.proof.open.map(p=>p.proof.minimumClearanceMetres));}
  for(const face of scoped?[]:physical.faces){const sourcePartIds=sourcePartsForTriangle(face.points,lowerParts,face.tag);if(!sourcePartIds.length)continue;let sampled=0;
    if(sourcePartIds.every(id=>structures.has(id))){const native=face.points,bb=bounds(native.map(p=>[p[0],p[2]]));for(const upper of upperFloors){const ub=bounds(upper.map(p=>[p[0],p[2]]));if(bb[0]!>ub[2]!||bb[2]!<ub[0]!||bb[1]!>ub[3]!||bb[3]!<ub[1]!)continue;const intersection=polygonClipping.intersection([[native.map(p=>[p[0],p[2]])]],[[upper.map(p=>[p[0],p[2]])]]);for(const polygon of intersection)for(const ring of polygon)for(const p of ring){const distance=supportHeight(upper,p)-profile.deck.deckThicknessMetres-supportHeight(native,p);assert.ok(distance>=.1,'Authored slab intersects an actual retained special structure');for(const id of sourcePartIds){const proof=structureProofs.find(p=>p.partId===id)!;proof.intersections++;proof.minimumActualSeparationMetres=Math.min(proof.minimumActualSeparationMetres,distance);}}}continue;}
    const p=face.points,box=bounds(p.map(p=>[p[0],p[2]])),native=layeredFloorSampler([p]);
    for(let z=Math.ceil(box[1]!);z<=box[3]!;z++)for(let x=Math.ceil(box[0]!);x<=box[2]!;x++){
      const old=native(x,z),top=-negativeFloor(x,z);if(!Number.isFinite(old)||!Number.isFinite(top))continue;
      const clearance=top-profile.deck.deckThicknessMetres-old;assert.ok(clearance>=profile.minimumLowerClearanceMetres,`Actual lower floor blocked at${x},${z}:${clearance}`);minimumClearance=Math.min(minimumClearance,clearance);clearanceSamples++;sampled++;
    }if(sampled)lowerProofs.push({cell:face.cell,collider:face.collider,triangle:face.triangle,sha256:deliverySha(JSON.stringify(face.points)),sourcePartIds,samples:sampled});
  }assert.ok(clearanceSamples>0,'A crossing needs actual lower-floor witnesses');
  // Compare the actual authored Float32 boundary vertices with the pinned
  const pierProofs=[];for(const pier of profile.deck.piers??[]){const source=parts.find(p=>p.id===String(pier.sourcePartId)),lower=lowerParts.find(p=>p.id===pier.sourcePartId),upper=profile.deck.upperParts.find(p=>p.id===pier.upperPartId);assert.ok(source&&lower&&upper,'A support needs explicit upper and lower municipal identities');assert.ok(source.properties.paatyyppi==='Muu rakenneosa'&&/Erotus|Koroke|saareke/.test(String(source.properties.alatyyppi))||source.properties.paatyyppi==='Ajorata'&&source.properties.alatyyppi==='Pysäköintialue','Support footings require a source separator or parking area, never a public carriageway/path');
    const bearing=pier.feetST.map(st=>qualifyExtraBridgePierBearing(profile.deck.frame,st,pier.widthS,pier.widthT,lower,physical.faces));assert.deepEqual(bearing,pier.bearing,'Native support bearing authority changed');
    for(const st of [...pier.feetST,pier.topST])for(const point of extraBridgePierRectangle(profile.deck.frame,st,Math.max(pier.widthS,pier.topWidthS),Math.max(pier.widthT,pier.topWidthT)))assert.ok(profile.deck.upperParts.some(part=>pointInPolygon(point,part.rings)),'Structural support escaped the actual upper source footprint union');
    for(const point of extraBridgePierRectangle(profile.deck.frame,pier.topST,pier.topWidthS,pier.topWidthT))assert.ok(pointInPolygon(point,upper.rings),'Structural support top crosses an undeclared deck level');
    const keepOut=qualifyExtraBridgePierKeepOut(profile.deck.frame,pier,lowerParts),axes=qualifyExtraBridgePierAxes(osm,profile.deck.frame,pier,profile.sourceRoadWayIds);pierProofs.push({id:pier.id,kind:pier.kind,bearing,keepOut,axes,authoredDimensions:true,sourceFloorsUnchanged:true});
  }
  // native piecewise-linear bank. A highest-floor query at a kerb is unsuitable:
  // its native edge tolerance can intentionally also see the raised neighbour.
  const bankJoins=[];for(const bank of profile.deck.banks){let count=0;const seen=new Set<string>();for(const face of upperFaces){const part=profile.deck.upperParts.find(p=>p.id===face.sourcePartIds[0])!,role=part.role;for(const vertex of face.points){const[s,t]=extraBridgeLocal(profile.deck.frame,[vertex[0],vertex[2]]);if(Math.abs(s-bank.s)>.00008)continue;const key=vertex.join(',')+'/'+role;if(seen.has(key))continue;seen.add(key);const sign=extraBridgePartSide(profile.deck,role,t,part.id),roleSegments=bank.segments.filter(p=>p.role===role&&(sign===0||p.sourcePartIds.some(id=>extraBridgePartSide(profile.deck,role,(p.t0+p.t1)/2,id)===sign))),lo=Math.min(...roleSegments.map(p=>p.t0)),hi=Math.max(...roleSegments.map(p=>p.t1)),nativeT=Math.max(lo,Math.min(hi,t));assert.ok(Math.abs(nativeT-t)<=.00008,'Bank endpoint escaped its Float32 construction bound');const native=extraBridgeBankHeight(roleSegments,nativeT,role);assert.ok(Math.abs(vertex[1]-native)<.0001,`Actual Float32 bank vertex failed:${bank.s}/${t}/${role}`);bankJoins.push({s:bank.s,t,nativeT,position:vertex,longitudinalRoundoff:s-bank.s,transverseRoundoff:t-nativeT,delta:vertex[1]-native});count++;}}assert.ok(count>10,'Full-width authored bank vertex inventory missing');}
  assert.ok(structureProofs.every(p=>p.intersections>0));const closureFaces=scoped?.closureFaces??[];return{manifest,faces:[...result.faces,...closureFaces],closureFaces,physical,proof:{schemaVersion:1,status:'GEOMETRY_QUALIFIED_RUNTIME_NOT_ACCEPTED',profileId:profile.id,sourceManifestSha256:options.expectedManifestSha256,originalAuthorityManifestSha256:profile.sourceManifestSha256,sourceFootprintsExact:true,bankProofs,bankJoins,pierProofs,clearance:{use:profile.lowerUse??'motor',samples:clearanceSamples,minimumMetres:minimumClearance,requiredMetres:profile.minimumLowerClearanceMetres,lowerFaces:lowerProofs,nonTrafficStructures:structureProofs,...(scoped?{scopedPassages:scoped.proof}:{})},deck:result.proof,triangles:result.faces.length+closureFaces.length,lowerGeometryMutationPolicy:'Every genuine lower collider/triangle remains literal; only source-owned upper joining bank fragments may be replaced.'}};
}
function terrainRuntimeBounds(manifest:WorldManifest){const t=manifest.terrain;return[t.x0,t.z0,t.x0+(t.nx-1)*t.resolution,t.z0+(t.nz-1)*t.resolution];}
