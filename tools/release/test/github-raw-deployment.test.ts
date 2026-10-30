import assert from 'node:assert/strict';
import {test} from 'node:test';
import {basisDecoderUrl,createWorldDeployment,selectedRelease,worldReleaseUrl} from '../../../apps/game/src/world/urls.ts';

test('GitHub raw pinned data URLs retain commit identity while executable decoders remain on Pages',()=>{
  const root=`https://raw.githubusercontent.com/MattiTynka/Helsinki-rides/${'a'.repeat(40)}/world/`;
  const deployment=createWorldDeployment({appBase:'/Helsinki-rides/',pages:true,requirePinned:true,
    worldBaseUrl:root,release:'central-fixture',manifestSha256:'b'.repeat(64)});
  assert.equal(selectedRelease(deployment,'another-release'),'central-fixture');
  const base=worldReleaseUrl(deployment,'central-fixture');
  assert.equal(base,root+'central-fixture/');
  assert.equal(new URL('../textures/atlas.ktx2',base+'cells/model.glb').href,base+'textures/atlas.ktx2');
  assert.equal(basisDecoderUrl(deployment),'/Helsinki-rides/basis/');
  assert.throws(()=>worldReleaseUrl(deployment,'another-release'),/pinned world release/);
});
