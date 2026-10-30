import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {linkOrCopyDeliveryFile,resolveAppendDeliveryBudget} from '../lib/delivery-city-files.ts';
import {deliverySha} from '../lib/delivery-city-payloads.ts';
import {freshDeliveryDirectory} from '../lib/delivery-city.ts';

test('fresh delivery outputs reject canonical source and accepted-world descendants before creating anything',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-delivery-paths-'));
 try{
  const current=path.join(root,'Current'),accepted=path.join(root,'Accepted');fs.mkdirSync(current);fs.mkdirSync(accepted);
  const protectedFile=path.join(accepted,'immutable.bin');fs.writeFileSync(protectedFile,'accepted bytes');
  for(const source of[current,accepted]){
   const out=path.join(source,'never-create','nested');assert.throws(()=>freshDeliveryDirectory(current,out,[accepted]),/overlap/);assert.equal(fs.existsSync(path.dirname(out)),false);
  }
  if(process.platform==='win32'){
   const out=path.join(current.toUpperCase(),'case-alias','nested');assert.throws(()=>freshDeliveryDirectory(current,out,[accepted]),/overlap/);assert.equal(fs.existsSync(path.join(current,'case-alias')),false);
  }
  const junction=path.join(root,'alias');fs.symlinkSync(current,junction,process.platform==='win32'?'junction':'dir');
  const throughAlias=path.join(junction,'never-create','nested');assert.throws(()=>freshDeliveryDirectory(current,throughAlias,[accepted]),/overlap/);assert.equal(fs.existsSync(path.join(current,'never-create')),false);
  const independent=path.join(root,'Fresh','nested');freshDeliveryDirectory(current,independent,[accepted]);assert.ok(fs.statSync(independent).isDirectory());
  assert.equal(fs.readFileSync(protectedFile,'utf8'),'accepted bytes');
 }finally{
  const absolute=path.resolve(root);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(absolute,{recursive:true,force:true});
 }
});

test('EXDEV copies and verifies exact bytes without changing source, while unrelated failures do not fall back',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-delivery-files-'));
 try{
  const source=path.join(root,'source.bin'),target=path.join(root,'copy.bin'),bytes=Buffer.from('accepted immutable bytes'),ref={path:'source.bin',bytes:bytes.length,sha256:deliverySha(bytes)};fs.writeFileSync(source,bytes);
  const crossVolume=()=>{throw Object.assign(new Error('cross-volume'),{code:'EXDEV'});};
  assert.equal(linkOrCopyDeliveryFile(source,target,ref,crossVolume),'verified-copy');assert.deepEqual(fs.readFileSync(target),bytes);assert.deepEqual(fs.readFileSync(source),bytes);
  fs.writeFileSync(target,'existing output');assert.throws(()=>linkOrCopyDeliveryFile(source,target,ref,crossVolume),{code:'EEXIST'});assert.equal(fs.readFileSync(target,'utf8'),'existing output');
  const forbidden=path.join(root,'forbidden.bin');assert.throws(()=>linkOrCopyDeliveryFile(source,forbidden,ref,()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});}),{code:'EPERM'});assert.equal(fs.existsSync(forbidden),false);
  assert.throws(()=>linkOrCopyDeliveryFile(source,forbidden,{...ref,sha256:'f'.repeat(64)},crossVolume),/hash changed/);assert.equal(fs.existsSync(forbidden),false);
  const corrupt=path.join(root,'corrupt.bin');assert.throws(()=>linkOrCopyDeliveryFile(source,corrupt,ref,()=>fs.writeFileSync(corrupt,Buffer.alloc(bytes.length))),/hash changed/);assert.equal(fs.existsSync(corrupt),false);
 }finally{const target=path.resolve(root);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('helsinki-delivery-files-'));fs.rmSync(target,{recursive:true,force:true});}
});

test('append delivery budgets keep Pages fixed and require an explicit bounded external mode',()=>{
 assert.deepEqual(resolveAppendDeliveryBudget(undefined),{mode:'pages',worldBudgetBytes:950_000_000,inclusive:false});
 assert.deepEqual(resolveAppendDeliveryBudget({mode:'pages'}),resolveAppendDeliveryBudget(undefined));
 assert.deepEqual(resolveAppendDeliveryBudget({mode:'external',worldBudgetBytes:2_000_000_000}),{mode:'external',worldBudgetBytes:2_000_000_000,inclusive:true});
 for(const invalid of[null,[],{}, {mode:'pages',worldBudgetBytes:2_000_000_000},{mode:'external'},{mode:'unknown'}, {mode:'external',worldBudgetBytes:4_000_000_001},{mode:'external',worldBudgetBytes:0},{mode:'external',worldBudgetBytes:1.5},{mode:'external',worldBudgetBytes:'2000'},{mode:'external',worldBudgetBytes:1000,unbounded:true}])assert.throws(()=>resolveAppendDeliveryBudget(invalid));
});
