import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Document,NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';

test('distant cell keeps transformed ground coordinates, one draw and no textures',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'helsinki-distant-test-'));
  try{
    mkdirSync(path.join(dir,'visual'));const d=new Document(),b=d.createBuffer();
    const p=d.createPrimitive().setAttribute('POSITION',d.createAccessor().setBuffer(b).setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,0,1])))
      .setMaterial(d.createMaterial().setBaseColorFactor([.4,.5,.6,1]));
    d.createScene().addChild(d.createNode().setTranslation([10,2,-3]).setScale([2,1,3]).setMesh(d.createMesh().addPrimitive(p)));
    const bytes=await new NodeIO().writeBinary(d);writeFileSync(path.join(dir,'visual/source.glb'),bytes);
    writeFileSync(path.join(dir,'cells.json'),JSON.stringify({cells:[{id:'test',visual:{lod0:{path:'visual/source.glb',sha256:createHash('sha256').update(bytes).digest('hex')}}}]}));
    const run=spawnSync(process.execPath,['tools/world/build_distant_cells.mjs','--cells',dir],{encoding:'utf8',timeout:60000});
    assert.equal(run.status,0,run.stderr);const index=JSON.parse(readFileSync(path.join(dir,'cells.json'))),lod=index.cells[0].visual.lod2;
    assert.equal(lod.drawCalls,1);assert.equal(lod.textureBytesEstimate,0);assert.equal(lod.triangles,1);
    await MeshoptDecoder.ready;const result=await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}).read(path.join(dir,lod.path));
    assert.equal(result.getRoot().listTextures().length,0);
    const out=result.getRoot().listMeshes()[0].listPrimitives()[0],positions=out.getAttribute('POSITION');
    const actual=Array.from({length:positions.getCount()},(_,i)=>positions.getElement(i,[]).join(',')).sort();
    assert.deepEqual(actual,['10,2,-3','12,2,-3','10,2,0'].sort());
    const colour=out.getAttribute('COLOR_0').getElement(0,[]);
    for(let i=0;i<3;i++)assert.ok(Math.abs(colour[i]-[.4,.5,.6][i])<1e-6);
  }finally{
    const absolute=path.resolve(dir),root=path.resolve(tmpdir())+path.sep;
    assert.ok(absolute.startsWith(root)&&path.basename(absolute).startsWith('helsinki-distant-test-'));
    rmSync(absolute,{recursive:true,force:true});
  }
});
