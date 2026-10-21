import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {authorizeNewStripFacades} from '../lib/delivery-city-source.ts';
test('new-vintage facade isolation rejects model/index drift and any reused accepted building',()=>{
  const bytes=(j:unknown)=>Buffer.from(JSON.stringify(j)),sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
  const building={id:'new',boundsENU:{min:[0,5,0],max:[2,7,3]}},model={source:{snapshotSha256:'a'.repeat(64),tilesetVersion:'current'},buildings:[building]},accepted=bytes({cells:[{id:'cell',buildingIds:['old'],buildings:[{id:'old'}]}]}),coverage=bytes({cells:[{id:'cell',collision:{}}]}),modelBytes=bytes(model),config={curatedFacades:'none-new-strips',continuation:{kind:'current-vintage-new-strips-only',modelSha256:sha(modelBytes),acceptedCoverageIndexSha256:sha(coverage),acceptedSourceManifestSha256:sha(accepted),sourceSnapshotSha256:model.source.snapshotSha256,sourceTilesetVersion:'current',appendRegionXZ:[0,-10,10,0],protectedPlayArea:{minX:0,maxX:10,minZ:0,maxZ:10}}};
  assert.equal(authorizeNewStripFacades(config,modelBytes,coverage,accepted),true);
  assert.throws(()=>authorizeNewStripFacades(config,bytes({...model,buildings:[{...building,id:'drift'}]}),coverage,accepted),/model authority/);
  assert.throws(()=>authorizeNewStripFacades(config,modelBytes,bytes({cells:[]}),accepted),/index authority/);
  const reused=bytes({...model,buildings:[{...building,id:'old'}]});assert.throws(()=>authorizeNewStripFacades({...config,continuation:{...config.continuation,modelSha256:sha(reused)}},reused,coverage,accepted),/accepted building/);
  assert.throws(()=>authorizeNewStripFacades({...config,continuation:{...config.continuation,acceptedSourceManifestSha256:sha(coverage)}},modelBytes,coverage,coverage),/Coverage proxies/);
  const interior=bytes({...model,buildings:[{...building,boundsENU:{min:[0,-7,0],max:[2,-5,3]}}]});assert.throws(()=>authorizeNewStripFacades({...config,continuation:{...config.continuation,modelSha256:sha(interior),appendRegionXZ:[0,-10,10,10]}},interior,coverage,accepted),/protected interior/);
});
