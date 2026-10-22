import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AssetLibrary } from '../../../apps/game/src/render/assets.ts';
import type { GlbLoader } from '../../../apps/game/src/world/loader.ts';
import type { WorldManifest } from '../../../packages/world-schema/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const ids = ['character-civilian-rain-white', 'vehicle-patrol', 'character-rain', 'prop-pistol', 'character-snow', 'scenery-trees'];
const manifest = { assets: ids.map(id => ({ id, kind: 'prop', path: `${id}.glb` })) } as unknown as WorldManifest;

for (const concurrency of [1, 2, 99]) test(`hero asset work is bounded at ${Math.min(concurrency, 2)} and prioritizes player/police before optional civilians`, async () => {
  const assets = new AssetLibrary(), order: string[] = [];
  let active = 0, peak = 0;
  const loader = { load: async (url: string) => {
    active++; peak = Math.max(peak, active); order.push(url);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--; return { scene: new THREE.Group(), animations: [] };
  } } as unknown as GlbLoader;
  await assets.load(loader, '/', manifest, true, () => true, { concurrency });
  assert.ok(peak <= Math.min(concurrency, 2));
  assert.deepEqual(order, ['character-snow', 'prop-pistol', 'character-rain', 'vehicle-patrol', 'scenery-trees', 'character-civilian-rain-white'].map(id => `/${id}.glb`));
});

test('deferred assets keep police ahead of civilians and retry only failed work', async () => {
  const assets = new AssetLibrary(), order: string[] = [];
  let failed = false;
  const loader = { load: async (url: string) => {
    order.push(url);
    if (url.includes('civilian') && !failed) { failed = true; throw new Error('retryable transport failure'); }
    return { scene: new THREE.Group(), animations: [] };
  } } as unknown as GlbLoader;
  await assets.load(loader, '/', manifest, true, asset => asset.id === 'character-snow', { concurrency: 1 });
  assert.deepEqual(order, ['/character-snow.glb']);
  await assert.rejects(assets.loadDeferred(), /retryable transport/);
  assert.ok(order.indexOf('/character-rain.glb') < order.indexOf('/character-civilian-rain-white.glb'));
  await assets.loadDeferred();
  assert.equal(order.filter(url => url.includes('civilian')).length, 2);
  assert.equal(order.filter(url => url.includes('character-rain.glb')).length, 1);
});
