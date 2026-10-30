import assert from 'node:assert/strict';
import {test} from 'node:test';
import {productionWorldBinding} from '../lib/production-world-binding.ts';

const fixture = {pageUrl: 'http://127.0.0.1:5331/', release: 'southwest-final', cells: [
  {visual: {lod0: {path: 'cells/near.glb'}, lod1: {path: 'cells/near.glb'}}},
  {visual: {lod0: {path: 'cells/other.glb'}}},
]};
test('production binding recognizes external startup visuals and preserves the local provider', () => {
  const commit = 'a'.repeat(40), base = `https://raw.githubusercontent.com/MattiTynka/Helsinki-rides/${commit}/world/`;
  const external = productionWorldBinding({...fixture, worldBaseUrl: base});
  assert.equal(external.manifestUrl, `${base}southwest-final/manifest.json`);
  assert.ok(external.detailUrls.has(`${base}southwest-final/cells/near.glb`));
  assert.equal(external.detailUrls.size, 2);
  assert.ok(!external.detailUrls.has('http://127.0.0.1:5331/world/southwest-final/cells/near.glb'));
  assert.equal(productionWorldBinding(fixture).manifestUrl, 'http://127.0.0.1:5331/world/southwest-final/manifest.json');
  assert.equal(productionWorldBinding({...fixture, pageUrl: 'http://localhost:5331/Helsinki-rides/'}).releaseBase,
    'http://localhost:5331/Helsinki-rides/world/southwest-final/');
});
test('live verification requires the exact authorized game and immutable provider, rejecting destination escapes', () => {
  const live = 'https://mattitynka.github.io/Helsinki-rides/';
  const credentialFixture = new URL('http://localhost/');
  credentialFixture.username = 'fixture'; credentialFixture.password = 'example';
  assert.throws(() => productionWorldBinding({...fixture, pageUrl: live}));
  assert.equal(productionWorldBinding({...fixture, pageUrl: live, allowLive: true}).pageUrl, live);
  for (const pageUrl of ['https://example.com/', 'https://mattitynka.github.io/Other/', live + '?review=1',
    credentialFixture.href, 'http://127.0.0.1/#hidden']) {
    assert.throws(() => productionWorldBinding({...fixture, pageUrl, allowLive: true}));
  }
  for (const worldBaseUrl of ['https://raw.githubusercontent.com/MattiTynka/Helsinki-rides/main/world/',
    'https://raw.githubusercontent.com/Other/Helsinki-rides/' + 'a'.repeat(40) + '/world/',
    'https://example.com/world/', 'https://127.0.0.1/world/', 'https://mattitynka.github.io/Helsinki-rides/world/../']) {
    assert.throws(() => productionWorldBinding({...fixture, worldBaseUrl}));
  }
  assert.throws(() => productionWorldBinding({...fixture, cells: [{visual: {lod0: {path: '../secret'}}}]}));
});
