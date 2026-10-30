import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readScopedPassageDocuments} from '../lib/delivery-bridge-scoped-passages.ts';
import {sourceSha256} from '../lib/source-files.ts';
test('reviewed passage documents require exact hashes, bounded local paths and strict contract keys',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-scoped-bridge-'));try{
  const bytes=Buffer.from(JSON.stringify({schemaVersion:1})),ref={path:'review.json',sha256:sourceSha256(bytes)};fs.writeFileSync(path.join(root,ref.path),bytes);const contract={schemaVersion:1 as const,open:[ref],closed:[ref]};assert.equal(readScopedPassageDocuments(contract,root).open.length,1);
  assert.throws(()=>readScopedPassageDocuments({...contract,passed:true}as any,root));assert.throws(()=>readScopedPassageDocuments({...contract,open:[]},root));assert.throws(()=>readScopedPassageDocuments({...contract,open:[{...ref,path:'../review.json'}]},root));
  fs.writeFileSync(path.join(root,ref.path),JSON.stringify({schemaVersion:1,status:'PASS'}));assert.throws(()=>readScopedPassageDocuments(contract,root),/document changed/);
 }finally{const absolute=path.resolve(root);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('helsinki-scoped-bridge-'));fs.rmSync(absolute,{recursive:true,force:true});}
});
