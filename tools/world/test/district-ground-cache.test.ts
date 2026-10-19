import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {serialize,deserialize} from 'node:v8';
import {buildDistrictGround,type CachedGroundAssembly,type GroundAssemblyCache} from '../lib/district-ground.ts';
import {encodeTerrain,type TerrainGrid} from '../../../packages/world-schema/src/index.ts';

test('exact pre-coast cache round-trip preserves ground and safety terrain and rejects changed authoring inputs',()=>{
  const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'helsinki-ground-cache-'));
  try {
    const origin=[25497350,6672960,7.5],osm=path.join(dir,'osm.json'),ledger=path.join(dir,'ledger.json'),parts=path.join(dir,'parts.geojson');
    const osmBytes=Buffer.from(JSON.stringify({elements:[]}));writeFileSync(osm,osmBytes);
    writeFileSync(ledger,JSON.stringify({snapshots:{test:{path:'osm.json',sha256:createHash('sha256').update(osmBytes).digest('hex')}}}));
    writeFileSync(parts,JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{osan_id:1,paatyyppi:'Ajorata',alatyyppi:'Ajorata'},geometry:{type:'Polygon',coordinates:[
      [[-4,-8],[4,-8],[4,8],[-4,8],[-4,-8]].map(([x,n])=>[origin[0]!+x!,origin[1]!+n!])
    ]}}]}));
    const config=JSON.parse(readFileSync(new URL('../../../content/helsinki/district-expansion/cells.json',import.meta.url),'utf8'));
    config.playArea={minX:-8,maxX:8,minZ:-8,maxZ:8};delete config.carriagewayGrade;delete config.drivableCorridors;delete config.coastal;
    const terrain:TerrainGrid={x0:-8,z0:-8,nx:33,nz:33,resolution:.5,heights:new Float32Array(1089).fill(1)};
    const stored=new Map<string,Uint8Array>();let writes=0,hits=0;
    const cache:GroundAssemblyCache={read(key){const value=stored.get(key);if(!value)return null;hits++;return deserialize(value) as CachedGroundAssembly;},write(key,value){writes++;stored.set(key,serialize(value));}};
    const options={terrain,footprints:[],originProjected:origin,config,osmLedger:ledger,osmSnapshot:'test',streetParts:parts,groundCache:cache};
    const first=buildDistrictGround(options),again=buildDistrictGround(options);
    assert.equal(writes,1);assert.equal(hits,1);assert.deepEqual(again.ground,first.ground);
    assert.deepEqual(encodeTerrain(again.runtimeTerrain),encodeTerrain(first.runtimeTerrain));
    assert.notEqual(again.ground,first.ground,'The mutable output must be a fresh decoded cache value');
    const changed={...terrain,heights:terrain.heights.slice()};changed.heights[544]=1.5;
    buildDistrictGround({...options,terrain:changed});assert.equal(writes,2,'Changed terrain must miss');
    buildDistrictGround({...options,config:{...config,curbHeight:.15}});assert.equal(writes,3,'Changed geometry config must miss');
    assert.deepEqual(terrain.heights,new Float32Array(1089).fill(1),'Neither source samples nor caller objects are cache storage');
  } finally {
    assert.ok(path.resolve(dir).startsWith(tempRoot+path.sep) && path.basename(dir).startsWith('helsinki-ground-cache-'));
    rmSync(dir,{recursive:true,force:true});
  }
});
