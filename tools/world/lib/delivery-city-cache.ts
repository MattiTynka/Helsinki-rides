import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serialize} from 'node:v8';
import {createHash} from 'node:crypto';
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
/** Private offline cache: bind the actual import tree, never a cwd lookalike. */
export function bindDeliveryGroundCache(inputs:Record<string,string>){
  const producerRoot=fileURLToPath(new URL('../../../',import.meta.url)),producerHashes:Record<string,string>={},visited=new Set<string>();
  function bind(file:string){file=path.resolve(file);if(visited.has(file))return;visited.add(file);const relative=path.relative(producerRoot,file);assert.ok(relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`),'Producer import escapes export');const body=fs.readFileSync(file,'utf8');producerHashes[relative.replaceAll('\\','/')]=sha(body);for(const match of body.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+\.ts)['"]/g))if(match[1]!.startsWith('.'))bind(path.resolve(path.dirname(file),match[1]!));}
  bind(fileURLToPath(new URL('../build_cells.ts',import.meta.url)));
  const bound=Object.fromEntries(Object.entries(inputs).map(([key,file])=>[key,{path:path.resolve(file),sha256:sha(fs.readFileSync(file))}]));
  return{inputs:bound,producerRoot,producerHashes};
}
export function writeDeliveryGroundCache(prefix:string,result:unknown,binding:ReturnType<typeof bindDeliveryGroundCache>,target:unknown){
  for(const suffix of ['.bin','.json'])assert.ok(!fs.existsSync(prefix+suffix),'Native ground cache output must be fresh');
  for(const ref of Object.values(binding.inputs))assert.equal(sha(fs.readFileSync(ref.path)),ref.sha256,'Ground source changed during native assembly');
  for(const[file,hash]of Object.entries(binding.producerHashes))assert.equal(sha(fs.readFileSync(path.join(binding.producerRoot,file))),hash,'Ground producer changed during native assembly');
  fs.mkdirSync(path.dirname(prefix),{recursive:true});const bytes=serialize(result);fs.writeFileSync(prefix+'.bin',bytes,{flag:'wx'});
  const metadata={schemaVersion:1,kind:'native-delivery-ground-cache',target,...binding,cache:{path:path.resolve(prefix+'.bin'),bytes:bytes.length,sha256:sha(bytes)}};
  fs.writeFileSync(prefix+'.json',JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});return{bytes:bytes.length,sha256:sha(bytes),metadataSha256:sha(fs.readFileSync(prefix+'.json'))};
}
