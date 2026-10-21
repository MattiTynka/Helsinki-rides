// Adapt existing original reference-qualified facade profiles to the external
// KTX2/M1 writer. Every painted face binds its unchanged native source triangle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {deliverySha} from './lib/delivery-city-payloads.ts';
import {facadeChartUv,validateFacadeTriangle} from './lib/facade-charts.ts';
import {deliveryFacadeSourceOwners,type DeliveryFacadeProfile} from './apply_delivery_facade_charts.ts';
import {sourceBuildingFaces} from './census_delivery_new_area_facades.ts';
import {applyDeliveryNativeFacades} from './apply_delivery_native_facades.ts';

export async function applyDeliveryOriginalFacades(args:{baseline:string;world:string;expected:string;profile:string;profileSha256:string;cityModel:string;config:string;configSha256:string;out:string;release:string}) {
 const bytes=fs.readFileSync(args.profile);assert.equal(deliverySha(bytes),args.profileSha256);const p=JSON.parse(bytes.toString()) as DeliveryFacadeProfile;
 assert.equal(p.schemaVersion,1);assert.ok(p.id&&p.cells.length&&p.charts.length);
 const baselineBytes=fs.readFileSync(path.join(args.baseline,'manifest.json'));assert.equal(deliverySha(baselineBytes),p.baselineManifestSha256);const baseline=JSON.parse(baselineBytes.toString());
 const currentBytes=fs.readFileSync(path.join(args.world,'manifest.json'));assert.equal(deliverySha(currentBytes),args.expected);const current=JSON.parse(currentBytes.toString());
 const sourceBytes=fs.readFileSync(path.join(args.cityModel,'city-model.json'));assert.equal(deliverySha(sourceBytes),p.source.cityJsonSha256);const city=JSON.parse(sourceBytes.toString());
 const binary=fs.readFileSync(path.join(args.cityModel,city.binary.file));assert.equal(deliverySha(binary),p.source.cityBinSha256);assert.equal(deliverySha(binary),city.binary.sha256);
 for(const origin of [baseline.origin.id,current.origin.id,city.originId])assert.equal(origin,p.source.originId);
 const artFile=path.resolve(path.dirname(args.profile),p.art.path),relative=path.relative(path.dirname(args.profile),artFile);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
 const artBytes=fs.readFileSync(artFile);assert.equal(deliverySha(artBytes),p.art.sha256);assert.ok(p.art.license&&p.art.attribution&&p.art.references.length);
 for(const reference of p.art.references){assert.equal(reference.role,'appearance-reference-only');const url=new URL(reference.url);assert.equal(url.protocol,'https:');assert.ok(reference.title);}
 const art=await sharp(artBytes,{limitInputPixels:1024*1024}).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(art.info.width,p.art.width);assert.equal(art.info.height,p.art.height);assert.ok(p.art.width<=1024&&p.art.height<=1024);
 for(let i=3;i<art.data.length;i+=4)assert.equal(art.data[i],255,'Original facade art must be opaque');
 const buildings=new Map<string,any>();const selectedKeys=new Set<string>();
 assert.equal(new Set(p.cells.map(c=>c.id)).size,p.cells.length);
 for(const selected of p.cells){
  const baseCell=baseline.cells.find((c:any)=>c.id===selected.id),currentCell=current.cells.find((c:any)=>c.id===selected.id);assert.ok(baseCell&&currentCell);
  for(const [tier,hash] of Object.entries(selected.baselineLevels))assert.equal(baseCell.visual[tier]?.sha256,hash,'Authored baseline cell changed');
  const owners=deliveryFacadeSourceOwners(selected),sources=owners.map(owner=>{const matches=city.buildings.filter((b:any)=>b.id===owner.id&&b.vtj===owner.vtj);assert.equal(matches.length,1);assert.equal(currentCell.buildings.find((b:any)=>b.id===owner.id)?.vtj,owner.vtj);return{owner,faces:sourceBuildingFaces(matches[0],binary)};});
  for(const selection of selected.faces){
   assert.ok(!selectedKeys.has(selection.key),'Repeated source chart face');selectedKeys.add(selection.key);const chart=p.charts.find(c=>c.id===selection.chart);assert.ok(chart);const source=sources.find(s=>s.owner.id===chart.building);assert.ok(source);
   const matches=source.faces.filter(f=>f.key===selection.key);assert.equal(matches.length,1);const f=matches[0]!;assert.equal(f.kind,'wall');assert.equal(f.texture,null,'New-area original repairs may select source-null walls only');validateFacadeTriangle(f.points,chart);
   const group=buildings.get(source.owner.id)??{id:source.owner.id,vtj:source.owner.vtj,address:city.buildings.find((b:any)=>b.id===source.owner.id).address,sourceWallTriangles:source.faces.filter(f=>f.kind==='wall').length,matchedWallTriangles:0,unmatchedWallTriangles:0,faces:[],unmatched:[]};
   group.faces.push({...f,uv:f.points.map(point=>facadeChartUv(point,chart,p.art.width,p.art.height)),image:'art.png',polygon:chart.id,sourceVertices:f.points,sourceVertexErrorMetres:0});group.matchedWallTriangles++;buildings.set(source.owner.id,group);
  }
 }
 for(const group of buildings.values()){group.unmatchedWallTriangles=group.sourceWallTriangles-group.matchedWallTriangles;assert.ok(group.unmatchedWallTriangles>=0);}
 assert.ok(typeof p.material.doubleSided==='boolean'&&typeof p.material.unlit==='boolean'&&Number.isFinite(p.material.roughness)&&p.material.roughness>=0&&p.material.roughness<=1);
 const prepared={schemaVersion:1,status:'ORIGINAL_CHART_ADAPTER_REQUIRES_RUNTIME_REVIEW',source:{citySha256:p.source.cityJsonSha256,binarySha256:p.source.cityBinSha256,originId:p.source.originId,theme:'original-reference-qualified',license:p.art.license,attribution:p.art.attribution,originalProfileSha256:args.profileSha256,originalArtSha256:p.art.sha256,baselineManifestSha256:p.baselineManifestSha256,references:p.art.references},material:p.material,identityGate:{maximumVertexDistanceMetres:0,sameBIDAndVTJ:true,nativePositionsChanged:false,nativeWindingPreserved:true},images:[{path:'images/art.png',sha256:p.art.sha256,bytes:artBytes.length}],buildings:[...buildings.values()]};
 const inputs=args.out+'.inputs';assert.ok(!fs.existsSync(inputs));fs.mkdirSync(path.join(inputs,'images'),{recursive:true});fs.writeFileSync(path.join(inputs,'images/art.png'),artBytes,{flag:'wx'});const preparedBytes=Buffer.from(JSON.stringify(prepared)+'\n'),preparedFile=path.join(inputs,'profile.json');fs.writeFileSync(preparedFile,preparedBytes,{flag:'wx'});
 const result=await applyDeliveryNativeFacades({...args,profile:preparedFile,profileSha256:deliverySha(preparedBytes)});assert.equal(deliverySha(fs.readFileSync(args.profile)),args.profileSha256);return {...result,originalProfileSha256:args.profileSha256,adapterProfileSha256:deliverySha(preparedBytes)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values}=parseArgs({options:{baseline:{type:'string'},world:{type:'string'},expected:{type:'string'},profile:{type:'string'},'profile-sha256':{type:'string'},'city-model':{type:'string'},config:{type:'string'},'config-sha256':{type:'string'},out:{type:'string'},release:{type:'string'}}});
 for(const key of ['baseline','world','expected','profile','profile-sha256','city-model','config','config-sha256','out','release'] as const)assert.ok(values[key]);
 console.log(JSON.stringify(await applyDeliveryOriginalFacades({baseline:values.baseline!,world:values.world!,expected:values.expected!,profile:values.profile!,profileSha256:values['profile-sha256']!,cityModel:values['city-model']!,config:values.config!,configSha256:values['config-sha256']!,out:values.out!,release:values.release!})));
}
