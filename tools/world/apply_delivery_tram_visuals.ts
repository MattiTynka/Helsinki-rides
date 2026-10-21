// Source-bound append-only tram patches for optimized delivery manifests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {validateBytes} from 'gltf-validator';
import {parseCollisionBundle,validateWorldManifest,geodeticToGk25,type FileRef,type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {deliveryFacadeImages} from './apply_delivery_facade_charts.ts';
import {tramFootprints,drapeTramFootprints,DEFAULT_TRAM_PROFILE,type TramTrack,type TramMesh,type TramGroundTriangle} from './lib/tram-visuals.ts';
import {proveTramGroundInTier} from './lib/tram-cell-ground.ts';
import {appendTramVisualGlb} from './lib/append-tram-glb.ts';
import {tramStripeResidentBytes} from './lib/tram-texture.ts';
import {decodeDeliveryTramGlb,existingDeliveryRailMask,proveDeliveryTramPreservation,EXISTING_RAIL_CLEARANCE} from './lib/tram-delivery.ts';
import {readMatchingDeliveryTramGround,proveDeliveryTramTierSupport} from './lib/tram-support.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const producerPaths=['tools/world/apply_delivery_tram_visuals.ts','tools/world/apply_delivery_facade_charts.ts','tools/world/lib/tram-visuals.ts','tools/world/lib/tram-cell-ground.ts','tools/world/lib/tram-coverage.ts','tools/world/lib/tram-delivery.ts','tools/world/lib/tram-support.ts','tools/world/lib/append-tram-glb.ts','tools/world/lib/append-ground-glb.ts','tools/world/lib/tram-texture.ts','tools/world/lib/facade-glb.ts','tools/world/lib/geometry.ts','packages/world-schema/src/coordinates.ts','packages/world-schema/src/collision.ts','pnpm-lock.yaml'];
function producerPins(){const root=fileURLToPath(new URL('../../',import.meta.url));return producerPaths.map(file=>({path:file,sha256:sha(fs.readFileSync(path.join(root,file)))}));}
function child(root:string,name:string){assert.ok(name&&!path.isAbsolute(name)&&!/[\\?#:]/.test(name),'Relative local tram payload required');const file=path.resolve(root,name),rel=path.relative(root,file);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'Tram payload escapes root');return file;}
function pinned(root:string,ref:FileRef){const file=child(root,ref.path),stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());const bytes=fs.readFileSync(file);assert.equal(bytes.length,ref.bytes);assert.equal(sha(bytes),ref.sha256);return bytes;}
export function validateDeliveryTramTracks(profile:any,extract:any,manifest:WorldManifest){
 assert.equal(profile.schemaVersion,1);assert.equal(profile.origin.id,manifest.origin.id);assert.deepEqual(profile.origin.originProjected,manifest.origin.originProjected);
 assert.equal(profile.gaugeMetres,1);assert.equal(profile.existingRailClearanceMetres,EXISTING_RAIL_CLEARANCE);
 assert.ok(Array.isArray(profile.tracks)&&profile.tracks.length>0&&profile.tracks.length<=500);
 const ways=new Map<number,any>(extract.elements.filter((e:any)=>e.type==='way').map((e:any)=>[e.id,e])),nodes=new Map<number,any>(extract.elements.filter((e:any)=>e.type==='node').map((e:any)=>[e.id,e]));
 const existing=new Set<number>(profile.existingProfiles.flatMap((p:any)=>p.wayIds)),seen=new Set<number>();
 for(const track of [...profile.tracks,...profile.contextTracks]){
  assert.ok(!seen.has(track.wayId),'Duplicate tram source way');seen.add(track.wayId);const original=ways.get(track.wayId);assert.ok(original,'Unmapped tram axis');assert.deepEqual(track.tags,original.tags,'Tram source tags changed');
  assert.equal(track.tags.railway,'tram');assert.ok(!track.tags.tunnel||track.tags.tunnel==='no');assert.ok(!track.tags.tracks||track.tags.tracks==='1');assert.ok(!track.tags.gauge||track.tags.gauge==='1000');
  assert.deepEqual(track.points.map((p:any)=>p.nodeId),original.nodes,'Tram source node order changed');
  for(const p of track.points){const n=nodes.get(p.nodeId);assert.ok(n);const[e,north]=geodeticToGk25(n.lat,n.lon);assert.ok(Math.abs(p.x-(e-manifest.origin.originProjected[0]))<1e-8&&Math.abs(p.z+(north-manifest.origin.originProjected[1]))<1e-8,'Tram axis differs from original mapped nodes');}
  if(profile.tracks.includes(track)){assert.ok(!existing.has(track.wayId)||(track.role==='uncovered-existing-ribbon'&&profile.existingTailWayIds?.includes(track.wayId)&&profile.existingRibbonPolicy==='Subtract actual decoded delivered rail footprints before supporting or emitting any existing-way repair ribbon.'),'Existing Mannerheim way cannot be added again without an explicit masked uncovered-ribbon target');
   if(track.tags.bridge==='yes'||track.tags.layer==='1'){assert.equal(track.deckAuthority?.method,'matching-rendered-and-collision-ground','Bridge lacks explicit deck qualification');assert.ok(track.deckAuthority.maximumJoinDiscontinuityMetres>0&&track.deckAuthority.maximumJoinDiscontinuityMetres<=.02);}
   else assert.ok(!track.tags.layer||track.tags.layer==='0','Unqualified track layer');
  }else assert.ok(existing.has(track.wayId),'Context track is not an accepted existing way');
 }
 const b=profile.scope.renderBoundsRuntimeXZ;assert.ok(Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<b[2]&&b[1]<b[3]);
 for(const value of Object.values(profile.budgets))assert.ok(Number.isSafeInteger(value)&&Number(value)>0,'Positive integer tram budgets required');
 return {ways,nodes};
}
function groundHeights(ground:readonly TramGroundTriangle[],x:number,z:number){
 const result:{y:number;ground:TramGroundTriangle}[]=[];
 for(const t of ground){if(!t.tag.split('|').some(tag=>tag.startsWith('road:')))continue;const[a,b,c]=t.vertices,den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(den)<1e-10)continue;
  const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/den,v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/den;
  if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)result.push({y:u*a[1]+v*b[1]+(1-u-v)*c[1],ground:t});
 }return result.sort((a,b)=>b.y-a.y);
}
export function qualifyDeliveryTramBridge(track:any,ground:readonly TramGroundTriangle[],allTracks:readonly TramTrack[]){
 const p=track.points,bank=(endpoint:any)=>{
  const choices=allTracks.filter(t=>t.wayId!==track.wayId&&(!t.tags.bridge||t.tags.bridge==='no')&&(!t.tags.layer||t.tags.layer==='0')).flatMap(t=>t.points.flatMap((q,i)=>q.nodeId===endpoint.nodeId?[t.points[i-1],t.points[i+1]].filter(Boolean):[]));
  assert.ok(choices.length,`Bridge${track.wayId} lacks mapped bank continuation`);
  return choices.map(q=>{const dx=q!.x-endpoint.x,dz=q!.z-endpoint.z,l=Math.hypot(dx,dz),x=endpoint.x+dx/l*.001,z=endpoint.z+dz/l*.001;return{x,z,hits:groundHeights(ground,x,z),oneMetreContinuation:{x:endpoint.x+dx/l,z:endpoint.z+dz/l,hits:groundHeights(ground,endpoint.x+dx/l,endpoint.z+dz/l)}};}).filter(q=>q.hits.length).sort((a,b)=>b.hits[0]!.y-a.hits[0]!.y)[0]??null;
 };
 const first=bank(p[0]),last=bank(p.at(-1)),samples:any[]=[],interiorJoins:any[]=[];let length=0;for(let i=1;i<p.length;i++)length+=Math.hypot(p[i].x-p[i-1].x,p[i].z-p[i-1].z);
 let distance=0;
 for(let i=1;i<p.length;i++){const a=p[i-1],b=p[i],span=Math.hypot(b.x-a.x,b.z-a.z),steps=Math.max(1,Math.ceil(span/.25));
  const fractions=new Set<number>(Array.from({length:steps+1},(_,k)=>k/steps)),cuts=new Set<number>(),dx=b.x-a.x,dz=b.z-a.z;
  for(const floor of ground)for(let edge=0;edge<3;edge++){
   const u=floor.vertices[edge]!,v=floor.vertices[(edge+1)%3]!,ex=v[0]-u[0],ez=v[2]-u[2],den=dx*ez-dz*ex;if(Math.abs(den)<1e-12)continue;
   const t=((u[0]-a.x)*ez-(u[2]-a.z)*ex)/den,s=((u[0]-a.x)*dz-(u[2]-a.z)*dx)/den;
   if(t>0&&t<1&&s>=0&&s<=1)cuts.add(Math.round(t*1e10)/1e10);
  }
  for(const t of cuts){const epsilon=Math.min(.0001/span,t/2,(1-t)/2),left=groundHeights(ground,a.x+dx*(t-epsilon),a.z+dz*(t-epsilon))[0],right=groundHeights(ground,a.x+dx*(t+epsilon),a.z+dz*(t+epsilon))[0];
   fractions.add(t-epsilon);fractions.add(t);fractions.add(t+epsilon);if(left&&right)interiorJoins.push({x:a.x+dx*t,z:a.z+dz*t,signedHeightChange:right.y-left.y,probeSpacingMetres:epsilon*span*2,left:left.ground.visual,right:right.ground.visual});
  }
  for(const t of [...fractions].sort((a,b)=>a-b)){if(i>1&&t===0)continue;const x=a.x+dx*t,z=a.z+dz*t,hits=groundHeights(ground,x,z),expected=first&&last?first.hits[0]!.y+(last.hits[0]!.y-first.hits[0]!.y)*(distance+span*t)/length:null;
   const floor=hits[0]?.ground.vertices,normal=floor?(()=>{const[a,b,c]=floor,u=b.map((v,k)=>v-a[k]!),v=c.map((n,k)=>n-a[k]!);const n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],l=Math.hypot(...n);return n.map(x=>x/l);})():null;
   samples.push({x,z,distance:distance+span*t,expectedBankY:expected,topY:hits[0]?.y??null,normal,support:hits[0]?{visual:hits[0].ground.visual,collision:hits[0].ground.collision,tag:hits[0].ground.tag}:null,lowerY:hits.find(h=>h.y<(hits[0]?.y??0)-1)?.y??null});
  }distance+=span;
 }
 // Probe inside the deck as well as outside each mapped bank. An endpoint can
 // lie on the high bank's inclusive triangle edge while all interior samples
 // incorrectly hit a lower road (for example Baana below a missing bridge).
 const inside=(endpoint:any,next:any)=>{const dx=next.x-endpoint.x,dz=next.z-endpoint.z,l=Math.hypot(dx,dz),x=endpoint.x+dx/l*.001,z=endpoint.z+dz/l*.001;return{x,z,hits:groundHeights(ground,x,z)};},entry=inside(p[0],p[1]),exit=inside(p.at(-1),p.at(-2));
 const missing=samples.filter(s=>s.topY===null).length,maxDeviation=first&&last&&missing===0?Math.max(...samples.map(s=>Math.abs(s.topY-s.expectedBankY))):null;
 const bankSteps=first&&last&&entry.hits.length&&exit.hits.length&&missing===0?[Math.abs(entry.hits[0]!.y-first.hits[0]!.y),Math.abs(exit.hits[0]!.y-last.hits[0]!.y)]:null;
 const maximumInteriorJoinDiscontinuity=Math.max(0,...interiorJoins.map(j=>Math.abs(j.signedHeightChange)));
 return{wayId:track.wayId,tags:track.tags,qualified:!!first&&!!last&&!missing&&!!bankSteps&&bankSteps.every(s=>s<=track.deckAuthority.maximumJoinDiscontinuityMetres)&&maximumInteriorJoinDiscontinuity<=track.deckAuthority.maximumJoinDiscontinuityMetres,length,bankStart:first?{x:first.x,z:first.z,y:first.hits[0]!.y,oneMetreY:first.oneMetreContinuation.hits[0]?.y??null}:null,bankEnd:last?{x:last.x,z:last.z,y:last.hits[0]!.y,oneMetreY:last.oneMetreContinuation.hits[0]?.y??null}:null,deckEntry:{x:entry.x,z:entry.z,y:entry.hits[0]?.y??null},deckExit:{x:exit.x,z:exit.z,y:exit.hits[0]?.y??null},missingSamples:missing,maximumBankDeviationDiagnosticOnly:maxDeviation,bankJoinDiscontinuities:bankSteps,maximumInteriorJoinDiscontinuity,interiorJoins,samples};
}
export async function applyDeliveryTramVisuals(options:{world:string;profile:string;out:string;planOnly?:boolean}){
 const producer=producerPins();
 const world=path.resolve(options.world),out=path.resolve(options.out),profileFile=path.resolve(options.profile);assert.ok(!fs.existsSync(out),'Fresh tram patch directory required');assert.ok(!out.startsWith(world+path.sep)&&!world.startsWith(out+path.sep)&&world!==out);
 const manifestBytes=fs.readFileSync(path.join(world,'manifest.json')),manifest=JSON.parse(manifestBytes.toString()) as WorldManifest;assert.deepEqual(validateWorldManifest(manifest),[]);
 const profileBytes=fs.readFileSync(profileFile),profile=JSON.parse(profileBytes.toString());assert.equal(sha(manifestBytes),profile.baselineManifestSha256,'Wrong deployed tram baseline');
 const extractBytes=fs.readFileSync(child(path.dirname(profileFile),profile.osm.path));assert.equal(sha(extractBytes),profile.osm.sha256);const extract=JSON.parse(extractBytes.toString());validateDeliveryTramTracks(profile,extract,manifest);
 const tracks=profile.tracks as TramTrack[],allTracks=[...tracks,...profile.contextTracks] as TramTrack[],selectedIds=new Set(tracks.map(t=>t.wayId));
 const footprints=tramFootprints(allTracks).filter(f=>selectedIds.has(f.wayId)),[minX,minZ,maxX,maxZ]=profile.scope.renderBoundsRuntimeXZ,problems:string[]=[],rows:any[]=[],bridgeGround:TramGroundTriangle[]=[];
 const bridgeTracks=profile.tracks.filter((t:any)=>t.deckAuthority),recipes=new Map<string,{detail:TramMesh;coarse:TramMesh;maskNodes:string[];maskTriangles:number}>();
 let detailedTriangles=0,coarseTriangles=0;fs.mkdirSync(out,{recursive:true});
 for(const cell of manifest.cells){
  const[x0,z0,x1,z1]=cell.boundsXZ,bounds={minX:Math.max(x0,minX),minZ:Math.max(z0,minZ),maxX:Math.min(x1,maxX),maxZ:Math.min(z1,maxZ)};
  if(bounds.minX>=bounds.maxX||bounds.minZ>=bounds.maxZ)continue;
  const relevant=footprints.filter(f=>Math.max(...f.polygon.map(p=>p[0]))>=bounds.minX&&Math.min(...f.polygon.map(p=>p[0]))<=bounds.maxX&&Math.max(...f.polygon.map(p=>p[1]))>=bounds.minZ&&Math.min(...f.polygon.map(p=>p[1]))<=bounds.maxZ);if(!relevant.length)continue;
  const visual=pinned(world,cell.visual.lod0),images=deliveryFacadeImages(world,cell.visual.lod0,visual,manifest.sharedTextures??[]),doc=await decodeDeliveryTramGlb(visual,images),collision=pinned(world,cell.collision),decoded=cell.collision.compression==='gzip'?gunzipSync(collision):collision;
  if(cell.collision.decodedSha256)assert.equal(sha(decoded),cell.collision.decodedSha256);const matching=readMatchingDeliveryTramGround(doc,parseCollisionBundle(decoded)),ground=matching.ground,mask=existingDeliveryRailMask(doc);
  for(const t of ground)if(bridgeTracks.some((track:any)=>track.points.some((p:any)=>t.vertices.some(v=>Math.hypot(v[0]-p.x,v[2]-p.z)<40))))bridgeGround.push(t);
  // Include every band for selected source segment/sides; full-ribbon UV ownership
  // requires head, groove and guard together even on a clipped cell edge.
  const groups=new Set(relevant.map(f=>`${f.wayId}:${f.segment}:${f.side}`)),complete=footprints.filter(f=>groups.has(`${f.wayId}:${f.segment}:${f.side}`));
  const detail=drapeTramFootprints(complete,ground,bounds,false,DEFAULT_TRAM_PROFILE,mask.polygons),coarse=drapeTramFootprints(complete,ground,bounds,true,DEFAULT_TRAM_PROFILE,mask.polygons);
  if(detail.stats.expectedArea<=1e-10)continue;
  for(const [tier,mesh]of [['detail',detail],['coarse',coarse]] as const)if(mesh.coverage!.unresolvedArea>1e-12)problems.push(`${cell.id}:${tier}:unsupported${mesh.coverage!.unresolvedArea}m2`);
  const usedGround=[...new Map([...detail.bindings,...coarse.bindings].map(b=>[b.ground.id,b.ground])).values()],tiers:any={};
  for(const level of ['lod1','lod2'] as const){
   const ref=cell.visual[level];if(!ref)continue;const bytes=pinned(world,ref);
   // Delivery LOD1 normally aliases the exact rendered source payload. The
   // already paired visual/HCOL floor cannot differ from its own identical
   // bytes; synthetic intersection-facet keys are not separate GLB triangles.
   if(level==='lod1'&&ref.sha256===cell.visual.lod0.sha256){assert.deepEqual(bytes,visual);tiers[level]={qualified:true,sourcePayloadIdentical:true,authority:'paired-LOD0-rendered-source-payload-identity',sourceSha256:ref.sha256,matchedSourceFacets:usedGround.length};continue;}
   const image=deliveryFacadeImages(world,ref,bytes,manifest.sharedTextures??[]),tierDoc=await decodeDeliveryTramGlb(bytes,image),proof=proveTramGroundInTier(tierDoc,usedGround),surface=proof.missing.length?proveDeliveryTramTierSupport(tierDoc,level==='lod2'?coarse:detail):null;tiers[level]={required:proof.required,found:proof.found,missing:proof.missing,surfaceCoverage:surface};if(proof.missing.length&&!surface?.qualified)problems.push(`${cell.id}:${level}:rendered support not equivalent`);
  }
  detailedTriangles+=detail.stats.triangles;coarseTriangles+=coarse.stats.triangles;
  if(detail.stats.triangles>profile.budgets.perCellDetailedTriangles||coarse.stats.triangles>profile.budgets.perCellCoarseTriangles)problems.push(`${cell.id}:per-cell triangle budget`);
  recipes.set(cell.id,{detail,coarse,maskNodes:mask.nodes,maskTriangles:mask.triangles});
  const receipt={cell:cell.id,bounds,inputs:{visual:cell.visual,collision:cell.collision},detail,coarse,tiers,supportMatching:matching.proof,existingMask:{nodes:mask.nodes,triangles:mask.triangles,clearanceMetres:EXISTING_RAIL_CLEARANCE}};
  const file=`${cell.id}.recipe.json`,bytes=Buffer.from(JSON.stringify(receipt)+'\n');fs.writeFileSync(path.join(out,file),bytes,{flag:'wx'});rows.push({cell:cell.id,recipe:file,sha256:sha(bytes),detail:detail.stats,coarse:coarse.stats,unresolvedDetailArea:detail.coverage!.unresolvedArea,unresolvedCoarseArea:coarse.coverage!.unresolvedArea,ways:[...new Set(complete.map(f=>f.wayId))]});
  console.log(JSON.stringify({cell:cell.id,detail:detail.stats.triangles,coarse:coarse.stats.triangles,unsupported:detail.coverage!.unresolvedArea}));
 }
 const bridges=bridgeTracks.map((track:any)=>qualifyDeliveryTramBridge(track,bridgeGround,allTracks));for(const bridge of bridges)if(!bridge.qualified)problems.push(`bridge${bridge.wayId}:no qualified matching deck/banks`);
 if(detailedTriangles>profile.budgets.detailedTriangles||coarseTriangles>profile.budgets.coarseTriangles)problems.push('Global tram triangle budget');
 assert.deepEqual(producerPins(),producer,'Tram producer changed during planning');
 const plan={schemaVersion:1,status:problems.length?'BLOCKED_SOURCE_OR_SUPPORT':'READY_FOR_ASSET_APPLICATION',producer,baselineManifestSha256:sha(manifestBytes),profileSha256:sha(profileBytes),sourceOsmSha256:sha(extractBytes),budgets:profile.budgets,totals:{selectedWays:tracks.length,selectedNewWays:tracks.filter((t:any)=>t.role!=='uncovered-existing-ribbon').length,existingRibbonRepairWays:tracks.filter((t:any)=>t.role==='uncovered-existing-ribbon').length,cells:rows.length,detailedTriangles,coarseTriangles,unsupportedArea:rows.reduce((n,r)=>n+r.unresolvedDetailArea,0)},bridges,rows,problems};
 fs.writeFileSync(path.join(out,'plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
 if(options.planOnly||problems.length)return plan;
 const updates:any[]=[],files:FileRef[]=[];
 for(const cell of manifest.cells){const recipe=recipes.get(cell.id);if(!recipe)continue;const next={...cell,visual:{...cell.visual}},cache=new Map<string,{ref:any;proof:any}>(),proofs:any[]=[];
  for(const level of ['lod0','lod1','lod2'] as const){const ref=cell.visual[level];if(!ref)continue;const cached=cache.get(ref.path);if(cached){next.visual[level]=cached.ref;proofs.push({level,alias:true,...cached.proof});continue;}
   const coarse=level==='lod2',mesh=coarse?recipe.coarse:recipe.detail,bytes=pinned(world,ref),images=deliveryFacadeImages(world,ref,bytes,manifest.sharedTextures??[]),old=await decodeDeliveryTramGlb(bytes,images);
   const result=await appendTramVisualGlb(bytes,mesh,{cell:cell.id,coarse,externalImages:images,coarseLimits:{meshes:16,primitivesPerMesh:16}}),doc=await decodeDeliveryTramGlb(result,images),preserved=proveDeliveryTramPreservation(bytes,result,old,doc,coarse);
   const validationOptions={maxIssues:100,externalResourceFunction:async(uri:string)=>{const data=images.get(uri);assert.ok(data);return data;}};
   const validation=await validateBytes(result,validationOptions);assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues.messages.filter(i=>i.severity===0)));
   const digest=sha(result),name=`cells/${cell.id}.${level}.${digest.slice(0,16)}.glb`,drawCalls=ref.drawCalls+(coarse?0:1),addedTexture=coarse?0:tramStripeResidentBytes();
   assert.ok(drawCalls<=(coarse?profile.budgets.perCellCoarseDrawCalls:profile.budgets.perCellDetailedDrawCalls),'Tram draw budget exceeded');assert.ok(addedTexture<=profile.budgets.perCellAddedTextureBytes);
   const newRef={...ref,path:name,sha256:digest,bytes:result.length,triangles:ref.triangles+mesh.stats.triangles,drawCalls,atlases:ref.atlases+(coarse?0:1),textureBytesEstimate:ref.textureBytesEstimate+addedTexture};next.visual[level]=newRef;
   const file=child(out,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,result,{flag:'wx'});files.push({path:name,sha256:digest,bytes:result.length});const proof={...preserved,addedTriangles:mesh.stats.triangles,addedDraws:coarse?0:1,addedTextureBytes:addedTexture};cache.set(ref.path,{ref:newRef,proof});proofs.push({level,...proof});
  }
  assert.deepEqual(next.collision,cell.collision);pinned(world,cell.collision);updates.push({cell:cell.id,before:cell,after:next,proofs});
 }
 assert.equal(sha(fs.readFileSync(path.join(world,'manifest.json'))),sha(manifestBytes));assert.equal(sha(fs.readFileSync(profileFile)),sha(profileBytes));assert.equal(sha(fs.readFileSync(child(path.dirname(profileFile),profile.osm.path))),sha(extractBytes));assert.deepEqual(producerPins(),producer,'Tram producer changed during asset application');
 const result={schemaVersion:1,status:'PATCH_PAYLOADS_READY',runtimeAcceptance:'REQUIRED',producer,currentManifestSha256:sha(manifestBytes),profile:profile.id,profileSha256:sha(profileBytes),sourceOsmSha256:sha(extractBytes),totals:plan.totals,bridges,updates,files,
  preserved:{oldCompressedGeometryAndImagesBinPrefix:true,oldDecodedGeometryPrefixes:true,existingMannerheimRailNodes:true,collisionAndLowTierDescriptors:true,allUnrelatedManifestFields:true},limitations:profile.limitations};
 fs.writeFileSync(path.join(out,'patches.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const{values}=parseArgs({options:{world:{type:'string'},profile:{type:'string'},out:{type:'string'},'plan-only':{type:'boolean'}}});assert.ok(values.world&&values.profile&&values.out,'--world --profile --out required');
 const result=await applyDeliveryTramVisuals({world:values.world,profile:values.profile,out:values.out,planOnly:values['plan-only']});console.log(JSON.stringify({status:result.status,...result.totals,problems:'problems'in result?result.problems:[]}));if(result.status==='BLOCKED_SOURCE_OR_SUPPORT')process.exitCode=1;
}
