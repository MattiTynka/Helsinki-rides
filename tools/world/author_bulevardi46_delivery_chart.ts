// A dedicated chart for the two source front triangles; no edits to the v1 atlas repair.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {bulevardi46Layout,renderBulevardi46Svg} from './author_bulevardi46_facade.ts';
import {sourceBuildingFaces} from './census_delivery_new_area_facades.ts';
import {chartForSourceTriangles} from './author_senate_facade_charts.ts';
import {deliveryFacadeImages,type DeliveryFacadeProfile} from './apply_delivery_facade_charts.ts';
import {readFacadeChartTriangles} from './lib/facade-chart-glb.ts';
import {facadeChartSha256 as sha} from './lib/facade-charts.ts';
import {groundTriangleLine,groundLineEnvelope,measuredGroundAt,warpGroundedFacade,type GroundLinePiece} from './lib/bulevardi46-ground-chart.ts';
import {DeliveryGroundSampler} from './lib/delivery-city-ground-sampler.ts';
import {ownerInputReader,type OwnerPin} from './lib/delivery-owner-facade-atlas.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './lib/delivery-city-provenance.ts';
import {deliveryFile} from './lib/delivery-city.ts';
import type {AppendDeliveryBudget} from './lib/delivery-city-files.ts';
import {validateWorldManifest,type WorldManifest} from '../../packages/world-schema/src/index.ts';

export interface Bulevardi46ChartPlan {
 schemaVersion:1;status:'REFERENCE_QUALIFIED';world:{directory:string;manifestSha256:string};accepted:{directory:string;manifestSha256:string};cityModel:{directory:string;jsonSha256:string};references:OwnerPin[];release:string;delivery?:AppendDeliveryBudget;
}

export async function authorBulevardi46DeliveryChart(o:{plan:OwnerPin;out:string}){
 assert.ok(!fs.existsSync(o.out),'Fresh chart authoring directory required');const producer=bindDeliveryProducer(new URL('./author_bulevardi46_delivery_chart.ts',import.meta.url)),reader=ownerInputReader();
 const plan=JSON.parse(reader.read(o.plan.path,o.plan.sha256).toString()) as Bulevardi46ChartPlan;assert.equal(plan.schemaVersion,1);assert.equal(plan.status,'REFERENCE_QUALIFIED');assert.ok(plan.references.length);for(const r of plan.references)reader.read(r.path,r.sha256);
 const m=JSON.parse(reader.read(path.join(plan.world.directory,'manifest.json'),plan.world.manifestSha256).toString()) as WorldManifest,accepted=JSON.parse(reader.read(path.join(plan.accepted.directory,'manifest.json'),plan.accepted.manifestSha256).toString()) as WorldManifest;assert.deepEqual(validateWorldManifest(m),[]);assert.deepEqual(validateWorldManifest(accepted),[]);assert.equal(m.origin.id,accepted.origin.id);
 assert.ok(!accepted.cells.some(c=>c.buildings.some(b=>b.id===bulevardi46Layout.building)),'Accepted building cannot enter the new-front repair');
 const cityBytes=reader.read(path.join(plan.cityModel.directory,'city-model.json'),plan.cityModel.jsonSha256),city=JSON.parse(cityBytes.toString()),bin=reader.read(path.join(plan.cityModel.directory,city.binary.file),city.binary.sha256);assert.equal(city.originId,m.origin.id);
 const building=city.buildings.filter((b:any)=>b.id===bulevardi46Layout.building);assert.equal(building.length,1);assert.equal(building[0].vtj,bulevardi46Layout.vtj);
 const selected=sourceBuildingFaces(building[0],bin).filter(f=>f.part===5&&[0,1].includes(f.triangle));assert.equal(selected.length,2);assert.ok(selected.every(f=>f.kind==='wall'));
 const id='bulevardi46-front-grounded-v2',chart=chartForSourceTriangles(id,bulevardi46Layout.building,selected.map(f=>f.points),[1,1,1022,288]),width=chart.bounds[2]-chart.bounds[0];assert.ok(Math.abs(width-bulevardi46Layout.widthMetres)<.01);assert.ok(chart.uAxis[0]<0&&chart.uAxis[2]>0,'Artwork must run from the NE corner to the SW corner');
 const owners=m.cells.filter(c=>c.buildings.some(b=>b.id===bulevardi46Layout.building));assert.equal(owners.length,1);const owner=owners[0]!;
 // Exact serialized visual pavement at 5cm outside the front plane. HCOL and visual
 // support are independently compared at every piece endpoint/midpoint plus <=25cm samples.
 const offset=.05,origin=[chart.origin[0]-chart.uAxis[2]*offset,chart.origin[2]+chart.uAxis[0]*offset],end=[origin[0]!+chart.uAxis[0]*chart.bounds[2],origin[1]!+chart.uAxis[2]*chart.bounds[2]],minX=Math.min(origin[0]!,end[0]!),maxX=Math.max(origin[0]!,end[0]!),minZ=Math.min(origin[1]!,end[1]!),maxZ=Math.max(origin[1]!,end[1]!);
 const candidates=m.cells.filter(c=>{const r=c.collision.boundsXZ??c.boundsXZ;return r[0]<=maxX&&r[2]>=minX&&r[1]<=maxZ&&r[3]>=minZ;}),pieces:GroundLinePiece[]=[];
 for(const cell of candidates){reader.read(deliveryFile(plan.world.directory,cell.collision.path),cell.collision.sha256);const ref=cell.visual.lod0,bytes=reader.read(deliveryFile(plan.world.directory,ref.path),ref.sha256),images=deliveryFacadeImages(plan.world.directory,ref,bytes,m.sharedTextures??[]);for(const uri of images.keys()){const relative=path.posix.normalize(path.posix.join(path.posix.dirname(ref.path),uri)),shared=m.sharedTextures!.find(r=>r.path===relative)!;reader.read(deliveryFile(plan.world.directory,relative),shared.sha256);}
  for(const face of await readFacadeChartTriangles(bytes,images)){if(!face.node.includes('_ground')&&!face.node.includes('_kerb'))continue;const piece=groundTriangleLine(face.points,chart,offset,cell.id+':'+face.node+':'+face.key);if(piece)pieces.push(piece);}
 }
 const profile=groundLineEnvelope(pieces,chart.bounds[0],chart.bounds[2]),sampler=new DeliveryGroundSampler(plan.world.directory,candidates),stations=new Set<number>(profile.flatMap(p=>[p.from,(p.from+p.to)/2,p.to]));for(let i=0;i<=Math.ceil(width/.25);i++)stations.add(chart.bounds[0]+width*i/Math.ceil(width/.25));for(const axis of bulevardi46Layout.entranceAxes)stations.add(chart.bounds[0]+width*(axis-.5)/15);
 const samples=[...stations].sort((a,b)=>a-b).map(u=>{const x=origin[0]!+chart.uAxis[0]*u,z=origin[1]!+chart.uAxis[2]*u,visual=measuredGroundAt(profile,u),hits=sampler.at(x,z);assert.ok(hits.length,`No serialized HCOL at front station ${u}`);const collision=hits.at(-1)!;assert.ok(Math.abs(visual-collision.height)<.0001,`Visual/HCOL front floor differs at ${u}: ${visual} vs ${collision.height}`);return{u,x,z,visual,collision};});
 // A v2 original palette avoids applying the photographic global grade to vector art.
 // Layout and opening counts remain those of the independently checked v1 generator.
 let svg=renderBulevardi46Svg();for(const [before,after]of [['#925638','#934e41'],['#a16243','#a55b4a'],['#72452f','#704339'],['#b28c70','#b58b7a'],['#b37455','#ad6b59'],['#b27a59','#ab705e']])svg=svg.replaceAll(before!,after!);
 // Preserve the 1022x288 content resolution in a power-of-two canvas: both the
 // Standard atlas and its literal half-size Low mip are valid GPU block sizes.
 const original=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({resolveWithObject:true}),data=warpGroundedFacade({data:original.data,width:original.info.width,height:original.info.height},chart,profile,1024,512),png=await sharp(data,{raw:{width:1024,height:512,channels:4}}).png({compressionLevel:9}).toBuffer();
 const art:DeliveryFacadeProfile['art']={path:'front-v2.png',sha256:sha(png),width:1024,height:512,license:'CC0-1.0',attribution:'Original reference-led vector artwork by Helsinki Rides (2026); reference photographs are not reproduced.',references:bulevardi46Layout.references.map(url=>({title:url.split('/').at(-1)!,url,role:'appearance-reference-only'}))};
 const source={cityJsonSha256:sha(cityBytes),cityBinSha256:sha(bin),originId:city.originId},deliveryProfile:DeliveryFacadeProfile={schemaVersion:1,id,baselineManifestSha256:plan.world.manifestSha256,source,art,material:{name:id,unlit:true,roughness:.95,doubleSided:false},charts:[chart],cells:[{id:owner.id,buildings:[{id:bulevardi46Layout.building,vtj:bulevardi46Layout.vtj}],baselineLevels:Object.fromEntries(Object.entries(owner.visual).map(([k,r])=>[k,r.sha256])),faces:selected.map(f=>({key:f.key,chart:id}))}]};
 reader.verify();verifyDeliveryProducer(producer);const receipt={schemaVersion:1,kind:'source-native-grounded-original-facade-chart',status:'SOURCE_BOUND_COMPRESSED_GAME_REVIEW_REQUIRED',planSha256:o.plan.sha256,manifestSha256:plan.world.manifestSha256,acceptedManifestSha256:plan.accepted.manifestSha256,producer:publicDeliveryProducer(producer),inputDigests:[...reader.inputs].sort(),source,layout:bulevardi46Layout,sourceTriangles:selected,chart,ground:{method:'Exact upper envelope of serialized upward visual ground/kerb triangles, independently matched to actual serialized HCOL; no heightfield or invented floor',outwardOffsetMetres:offset,profile,samples,minY:Math.min(...samples.map(s=>s.visual)),maxY:Math.max(...samples.map(s=>s.visual)),maxVisualCollisionDifference:Math.max(...samples.map(s=>Math.abs(s.visual-s.collision.height)))},art:{...art,referencePixelsCopied:false,photographicGrade:false,sourceSvgSha256:sha(svg),geometryUnchanged:true},limitations:['Masonry, glazing and proportions are authored appearance approximations, not a measured photographic elevation.','Artwork is vertically mapped between native cornice and the measured pavement 5cm outside the facade; no collision, ground or building geometry is moved.','Actual Standard/Low compressed game captures and cell budgets remain acceptance gates.']};
 fs.mkdirSync(o.out,{recursive:true});for(const [name,bytes]of Object.entries({'front-v2.svg':svg,'front-v2.png':png,'profile.json':JSON.stringify(deliveryProfile,null,2)+'\n','source-ledger.json':JSON.stringify(receipt,null,2)+'\n'}))fs.writeFileSync(path.join(o.out,name),bytes,{flag:'wx'});reader.verify();verifyDeliveryProducer(producer);return{status:receipt.status,profileSha256:sha(fs.readFileSync(path.join(o.out,'profile.json'))),artSha256:sha(png),groundSegments:profile.length,groundSamples:samples.length,groundMinY:receipt.ground.minY,groundMaxY:receipt.ground.maxY};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:Object.fromEntries(['plan','plan-sha256','out'].map(k=>[k,{type:'string'as const}]))});for(const k of['plan','plan-sha256','out'])assert.ok(values[k]);console.log(JSON.stringify(await authorBulevardi46DeliveryChart({plan:{path:values.plan!,sha256:values['plan-sha256']!},out:values.out!})));}
