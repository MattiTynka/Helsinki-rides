// Metadata-only repair of a new working build; never modifies active releases.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import{parseArgs}from'node:util';
import{declareQuantizedAttributes}from'./lib/glb-quantization.ts';
const{values}=parseArgs({options:{cells:{type:'string'}}});if(!values.cells)throw new Error('--cells required');
const root=path.resolve('data/work')+path.sep,dir=path.resolve(values.cells);if(!dir.startsWith(root))throw new Error('only working builds may be repaired');
const evidence=path.join(dir,'quantization-metadata.json');if(existsSync(evidence))throw new Error('already repaired');
const index=JSON.parse(readFileSync(path.join(dir,'cells.json'),'utf8')),report=JSON.parse(readFileSync(path.join(dir,'report.json'),'utf8'));
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),changes=[];
for(const c of index.cells){const file=path.join(dir,c.visual.lod0.path),before=readFileSync(file);if(sha(before)!==c.visual.lod0.sha256)throw new Error('source hash mismatch');
  const after=declareQuantizedAttributes(before);if(sha(before)===sha(after))continue;
  const a=Buffer.from(after),oldTail=before.subarray(20+before.readUInt32LE(12)),newTail=a.subarray(20+a.readUInt32LE(12));
  if(!oldTail.equals(newTail))throw new Error('binary payload changed');
  changes.push({cell:c.id,before:sha(before),after:sha(after),binaryPayloadExact:true});
  writeFileSync(file,after);Object.assign(c.visual.lod0,{bytes:after.byteLength,sha256:sha(after)});
  report.cells.find((s:{cell:string})=>s.cell===c.id).glbBytes=after.byteLength;
}
writeFileSync(path.join(dir,'cells.json'),JSON.stringify(index,null,1)+'\n');writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,1)+'\n');
writeFileSync(evidence,JSON.stringify({changes},null,1)+'\n');console.log(JSON.stringify({fixed:changes.length,binaryPayloads:'unchanged'}));
