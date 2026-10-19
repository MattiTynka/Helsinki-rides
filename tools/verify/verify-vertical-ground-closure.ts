// Independent actual-HCOL gate: repairs must not add any horizontal floor area.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {parseCollisionBundle} from '../../packages/world-schema/src/index.ts';
const{values}=parseArgs({options:{base:{type:'string'},cells:{type:'string'},out:{type:'string'}}});
assert.ok(values.base&&values.cells&&values.out,'--base --cells --out required');assert.ok(!fs.existsSync(values.out),'Fresh evidence required');
const files:Record<string,string>={},sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),read=(p:string)=>{const b=fs.readFileSync(p);files[p]=sha(b);return b;};
const before=JSON.parse(read(path.join(values.base,'cells.json')).toString()),after=JSON.parse(read(path.join(values.cells,'cells.json')).toString());read(import.meta.filename);
let changedCells=0,triangles=0,maximumNormalY=0;const failures:any[]=[];
for(const cell of after.cells){
  const old=before.cells.find((c:any)=>c.id===cell.id);assert.ok(old);if(cell.collision.sha256===old.collision.sha256)continue;
  const ab=read(path.join(values.base,old.collision.path)),bb=read(path.join(values.cells,cell.collision.path));assert.equal(sha(ab),old.collision.sha256);assert.equal(sha(bb),cell.collision.sha256);
  const A=parseCollisionBundle(ab),B=parseCollisionBundle(bb);assert.equal(A.colliders.length,B.colliders.length);assert.deepEqual(A.header.surfaceTags,B.header.surfaceTags);changedCells++;
  for(let k=0;k<A.colliders.length;k++){
    const a=A.colliders[k]!,b=B.colliders[k]!;assert.equal(a.id,b.id);assert.equal(a.group,b.group);assert.equal(a.ref,b.ref);
    for(const field of ['positions','indices','triangleTags'] as const){const x=a[field],y=b[field].subarray(0,x.length);assert.deepEqual(Buffer.from(x.buffer,x.byteOffset,x.byteLength),Buffer.from(y.buffer,y.byteOffset,y.byteLength),'Original collider prefix changed');}
    if(a.id!==`g:${cell.id}`){assert.equal(a.indices.length,b.indices.length);assert.equal(a.positions.length,b.positions.length);continue;}
    for(let i=a.indices.length;i<b.indices.length;i+=3){
      const p=[0,1,2].map(j=>[0,1,2].map(axis=>b.positions[b.indices[i+j]!*3+axis]!)),u=p[1]!.map((v,j)=>v-p[0]![j]!),v=p[2]!.map((x,j)=>x-p[0]![j]!),n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],length=Math.hypot(...n),normalY=length?Math.abs(n[1]!)/length:NaN;
      triangles++;maximumNormalY=Math.max(maximumNormalY,normalY);if(!(length>0&&n[1]===0)&&failures.length<100)failures.push({cell:cell.id,collider:b.id,triangle:i/3,normalY,vertices:p});
    }
  }global.gc?.();
}
const result={schemaVersion:1,status:failures.length?'FAIL':'PASS_EXACT_VERTICAL_ACTUAL_HCOL',base:values.base,cells:values.cells,changedCells,triangles,maximumNormalY,files,failures,rssMiB:process.memoryUsage().rss/2**20};
fs.writeFileSync(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,changedCells,triangles,maximumNormalY,failures:failures.length,out:values.out}));if(failures.length)process.exitCode=1;
