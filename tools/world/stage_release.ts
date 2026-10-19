// Verify and stage an immutable local candidate without changing either live pointer.
// Hardlinks avoid storing three copies of the same large content-addressed pack.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,linkSync,copyFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {validateWorldManifest,type WorldManifest} from '../../packages/world-schema/src/index.ts';

const {values}=parseArgs({options:{release:{type:'string'},out:{type:'string'}}});
assert.ok(values.release&&values.out,'--release and fresh --out evidence file required');
assert.ok(!existsSync(values.out),'Evidence file already exists');
const root=path.resolve(values.release),manifestBytes=readFileSync(path.join(root,'manifest.json'));
const manifest=JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
assert.deepEqual(validateWorldManifest(manifest),[]);
assert.match(manifest.worldReleaseId,/^senate-\d{8}-[a-f0-9]{8}$/);
assert.equal(path.basename(root),manifest.worldReleaseId);
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const refs=[manifest.terrain,manifest.roads,manifest.gameplay,...manifest.assets,...(manifest.scenery?[manifest.scenery]:[]),
  ...manifest.cells.flatMap(cell=>[cell.collision,cell.visual.lod0,...(cell.visual.lod1?[cell.visual.lod1]:[]),...(cell.visual.lod2?[cell.visual.lod2]:[])])];
const files=new Map<string,{bytes:number;sha256:string}>();
for(const ref of refs){
  const source=path.resolve(root,ref.path);
  assert.ok(source.startsWith(root+path.sep),`Payload escapes release: ${ref.path}`);
  const bytes=readFileSync(source);assert.equal(bytes.length,ref.bytes,ref.path);assert.equal(sha(bytes),ref.sha256,ref.path);
  const previous=files.get(ref.path);assert.ok(!previous||previous.sha256===ref.sha256,'Conflicting payload path');
  files.set(ref.path,{bytes:ref.bytes,sha256:ref.sha256});
}
files.set('manifest.json',{bytes:manifestBytes.length,sha256:sha(manifestBytes)});
// Preflight every existing destination before writing any new file.
const destinations=['apps/game/public/world','apps/game/dist/world'].map(directory=>path.resolve(directory,manifest.worldReleaseId));
for(const destination of destinations)for(const [relative,ref] of files){
  const target=path.resolve(destination,relative);assert.ok(target.startsWith(destination+path.sep));
  if(existsSync(target)){const bytes=readFileSync(target);assert.equal(bytes.length,ref.bytes);assert.equal(sha(bytes),ref.sha256,`Existing candidate differs: ${target}`);}
}
let linked=0,copied=0;
for(const destination of destinations)for(const relative of files.keys()){
  const target=path.join(destination,relative);if(existsSync(target))continue;
  mkdirSync(path.dirname(target),{recursive:true});
  try{linkSync(path.join(root,relative),target);linked++;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error;copyFileSync(path.join(root,relative),target);copied++;}
}
// Re-read actual served bytes, including pre-existing files.
for(const destination of destinations)for(const [relative,ref]of files){const bytes=readFileSync(path.join(destination,relative));assert.equal(bytes.length,ref.bytes);assert.equal(sha(bytes),ref.sha256);}
const report={status:'PASS',release:manifest.worldReleaseId,manifestSha256:sha(manifestBytes),payloadFiles:refs.length,uniqueFiles:files.size,
  payloadBytes:refs.reduce((n,ref)=>n+ref.bytes,0),destinations,linked,copied,pointersChanged:false,
  note:'Staged releases are immutable. Do not edit their linked payloads in place; build a fresh candidate.'};
mkdirSync(path.dirname(values.out),{recursive:true});writeFileSync(values.out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
