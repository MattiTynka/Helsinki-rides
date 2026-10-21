// Merge exact source receipts per native city band so one owner gets one atlas.
import assert from'node:assert/strict';
import fs from'node:fs';
import path from'node:path';
import{parseArgs}from'node:util';
import{fileURLToPath}from'node:url';
import{deliverySha as sha}from'./lib/delivery-city-payloads.ts';
import{classifyFacadeTriangle}from'./lib/delivery-new-area-facades.ts';
export function mergeDeliveryNativeFacadeSources(args:{profiles:readonly string[];hashes:readonly string[];out:string}){
 assert.ok(args.profiles.length&&args.profiles.length===args.hashes.length);assert.ok(!fs.existsSync(args.out),'Fresh merged source output required');
 const parsed=args.profiles.map((file,i)=>{const bytes=fs.readFileSync(file);assert.equal(sha(bytes),args.hashes[i]);const p=JSON.parse(bytes.toString());assert.equal(p.schemaVersion,1);assert.ok(['rgbTexture_2024','rgbTexture_2021'].includes(p.source.theme));assert.equal(p.identityGate.maximumVertexDistanceMetres,.005);assert.equal(p.identityGate.nativePositionsChanged,false);return{file,p,hash:sha(bytes)};});
 assert.equal(new Set(parsed.map(p=>p.hash)).size,parsed.length,'Duplicate source profile');const first=parsed[0]!.p;
 for(const{p}of parsed)for(const key of['citySha256','binarySha256','originId'])assert.equal(p.source[key],first.source[key],'Only one exact native city band may be merged');
 const buildings:any[]=[],ids=new Set<string>(),images=new Map<string,{bytes:Buffer;file:string;sha256:string}>(),sources:any[]=[];
 for(const{file,p,hash}of parsed){
  sources.push({profileSha256:hash,theme:p.source.theme,archiveSha256:p.source.archiveSha256,archiveBytes:p.source.archiveBytes,gmlSha256:p.source.gmlSha256});
  for(const b of p.buildings){assert.ok(!ids.has(b.id),'Duplicate building; choose one theme explicitly before merging');ids.add(b.id);assert.ok(b.faces.length);assert.equal(new Set(b.faces.map((f:any)=>f.key)).size,b.faces.length);assert.ok(b.faces.every((f:any)=>f.sourceVertexErrorMetres<=.005));buildings.push(b);}
  for(const r of p.images){const name=path.posix.basename(r.path);assert.match(name,/^[a-f0-9]{64}\.(jpg|jpeg|png)$/);assert.equal(name.split('.')[0],r.sha256);const source=path.resolve(path.dirname(file),r.path),relative=path.relative(path.dirname(file),source);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));assert.ok(fs.lstatSync(source).isFile()&&!fs.lstatSync(source).isSymbolicLink());const bytes=fs.readFileSync(source);assert.equal(bytes.length,r.bytes);assert.equal(sha(bytes),r.sha256);const previous=images.get(name);if(previous)assert.equal(previous.sha256,r.sha256);else images.set(name,{bytes,file:source,sha256:r.sha256});}
 }
 const used=new Set<string>(buildings.flatMap(b=>b.faces.map((f:any)=>f.image)));for(const name of used)assert.ok(images.has(name));const themes=[...new Set(parsed.map(p=>p.p.source.theme))].sort(),theme=themes.length===1?themes[0]:'rgbTexture_2024+rgbTexture_2021';
 const merged={schemaVersion:1,status:'MERGED_NATIVE_SOURCE_UV_RUNTIME_REVIEW_REQUIRED',source:{citySha256:first.source.citySha256,binarySha256:first.source.binarySha256,originId:first.source.originId,theme,themes,sourceProfiles:sources,license:'CC-BY-4.0',attribution:'Buildings and original municipal appearance imagery © City of Helsinki, CC BY4.0; native UV transfer and wall-chart resampling by Helsinki Rides.'},identityGate:first.identityGate,images:[...used].sort().map(name=>({path:'images/'+name,sha256:images.get(name)!.sha256,bytes:images.get(name)!.bytes.length})),buildings:buildings.sort((a,b)=>a.id.localeCompare(b.id))};
 fs.mkdirSync(path.join(args.out,'images'),{recursive:true});for(const name of used)fs.linkSync(images.get(name)!.file,path.join(args.out,'images',name));const output=Buffer.from(JSON.stringify(merged)+'\n');fs.writeFileSync(path.join(args.out,'profile.json'),output,{flag:'wx'});
 return{profileSha256:sha(output),buildings:buildings.length,images:used.size,sourceImageBytes:[...used].reduce((s,n)=>s+images.get(n)!.bytes.length,0),matchedWallTriangles:buildings.reduce((s,b)=>s+b.faces.length,0),unmatchedWallTriangles:buildings.reduce((s,b)=>s+b.unmatched.length,0),matchedWallArea:buildings.reduce((s,b)=>s+b.faces.reduce((a:number,f:any)=>a+classifyFacadeTriangle(f.points).area,0),0),unmatchedWallArea:buildings.reduce((s,b)=>s+b.unmatched.reduce((a:number,f:any)=>a+classifyFacadeTriangle(f.points).area,0),0)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:{profile:{type:'string',multiple:true},'profile-sha256':{type:'string',multiple:true},out:{type:'string'}}});assert.ok(values.profile?.length&&values['profile-sha256']?.length&&values.out);console.log(JSON.stringify(mergeDeliveryNativeFacadeSources({profiles:values.profile,hashes:values['profile-sha256'],out:values.out})));}
