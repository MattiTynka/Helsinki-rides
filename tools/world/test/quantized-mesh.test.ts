import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {geodeticToGk25} from '../../../packages/world-schema/src/index.ts';
import { decodeQuantizedMesh, TileSampler, loadTerrainSnapshot, tileDegrees } from '../lib/quantized-mesh.ts';

test('a quantized-mesh tile decodes zig-zag deltas and high-water-mark indices, gzipped or not', () => {
  // One triangle over half the tile: corners SW, SE, NW at heights 10, 20 and the middle of the range.
  const n = 3, b = new Uint8Array(88 + 4 + n * 6 + 4 + 6), dv = new DataView(b.buffer);
  dv.setFloat32(24, 10, true); dv.setFloat32(28, 20, true); dv.setUint32(88, n, true);
  const zz = (d: number) => (d << 1) ^ (d >> 31);
  [[0, 32767, 0], [0, 0, 32767], [0, 32767, 16384]].forEach((vals, a) => vals.forEach((v, i) => dv.setUint16(92 + a * n * 2 + i * 2, zz(v - (vals[i - 1] ?? 0)), true)));
  dv.setUint32(110, 1, true); // triangle count; indices 0, 1, 2 are all new, so every code is 0
  for (const bytes of [b, new Uint8Array(gzipSync(b))]) {
    const tile = decodeQuantizedMesh(bytes);
    assert.deepEqual([...tile.indices], [0, 1, 2]);
    assert.deepEqual([...tile.height].map(h => Math.round(h * 1000) / 1000), [10, 20, 15]);
    const s = new TileSampler(tile);
    assert.equal(s.heightAt(32767 / 2, 0), 15);
    assert.equal(s.heightAt(32767, 32767), null);
  }
});

test('large terrain snapshots keep a bounded sampler set with identical heights after eviction and recheck changed files', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terrain-cache-'));
  try {
    const n=3,b=Buffer.alloc(88+4+n*6+4+6),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    v.setFloat32(24,10,true);v.setFloat32(28,20,true);v.setUint32(88,n,true);
    const zz=(d:number)=>(d<<1)^(d>>31);
    [[0,32767,0],[0,0,32767],[0,32767,16384]].forEach((vals,a)=>vals.forEach((value,i)=>v.setUint16(92+a*n*2+i*2,zz(value-(vals[i-1]??0)),true)));
    v.setUint32(110,1,true);
    const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),zoom=18,d=tileDegrees(zoom);
    const tiles:{file:string;x:number;y:number;sha256:string}[]=[];
    for(let i=0;i<12;i++){const file=`tile-${i}.terrain`;fs.writeFileSync(path.join(dir,file),b);tiles.push({file,x:298400+i,y:218700,sha256:sha(b)});}
    fs.writeFileSync(path.join(dir,'tiles.json'),JSON.stringify({zoom,tiles}));
    const snapshot=loadTerrainSnapshot(dir,sha,2);
    assert.equal(snapshot.tiles,12);assert.equal(snapshot.vertices,36);assert.equal(snapshot.triangles,12);
    assert.equal(snapshot.samplerCache.resident,0);
    const point=(i:number)=>geodeticToGk25((tiles[i]!.y+.2)*d-90,(tiles[i]!.x+.2)*d-180);
    const first=snapshot.heightAtEN(...point(0));assert.ok(first!==null);
    for(let i=1;i<12;i++){const height=snapshot.heightAtEN(...point(i));assert.ok(height!==null&&Math.abs(height-first)<1e-5);assert.ok(snapshot.samplerCache.resident<=2);}
    assert.equal(snapshot.heightAtEN(...point(0)),first);assert.equal(snapshot.samplerCache.loads,13);
    snapshot.heightAtEN(...point(10));snapshot.heightAtEN(...point(11));
    const changed=Buffer.from(b);changed[24]=changed[24]!^1;fs.writeFileSync(path.join(dir,tiles[0]!.file),changed);
    assert.throws(()=>snapshot.heightAtEN(...point(0)),/changed after terrain preflight/);
    assert.throws(()=>loadTerrainSnapshot(dir,sha,0),/cache must hold/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
