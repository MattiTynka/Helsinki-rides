import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function bindDeliveryProducer(entry:URL){
  const root=fileURLToPath(new URL('../../../',import.meta.url)),files:Record<string,string>={},visited=new Set<string>();
  const bind=(file:string)=>{file=path.resolve(file);if(visited.has(file))return;visited.add(file);const relative=path.relative(root,file).replaceAll('\\','/');assert.ok(relative&&!relative.startsWith('../')&&!path.isAbsolute(relative),'Delivery producer import escapes actual export');const bytes=fs.readFileSync(file);files[relative]=sha(bytes);if(file.endsWith('.ts'))for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+\.ts)['"]/g))if(match[1]!.startsWith('.'))bind(path.resolve(path.dirname(file),match[1]!));};
  bind(fileURLToPath(entry));for(const file of['pnpm-lock.yaml','package.json'])bind(path.join(root,file));return{root,files,runtime:{node:process.versions.node,v8:process.versions.v8}};
}
export function verifyDeliveryProducer(binding:ReturnType<typeof bindDeliveryProducer>){for(const[file,hash]of Object.entries(binding.files))assert.equal(sha(fs.readFileSync(path.resolve(binding.root,file))),hash,`Delivery producer changed during production: ${file}`);}
export function publicDeliveryProducer(binding:ReturnType<typeof bindDeliveryProducer>){return{files:binding.files,runtime:binding.runtime};}
