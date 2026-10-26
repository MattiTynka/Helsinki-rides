import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { adaptCityMaterial, SKIRT_DEPTH_OFFSET } from '../../../apps/game/src/render/city-materials.ts';

// Resolve the game's pinned Three.js dependency without adding a second runtime dependency to the tools.
const threeEntry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(threeEntry)).href);

test('a cell palette (plinth skirts) draws just behind coplanar facades in every material class; other materials do not', () => {
  for (const options of [{ lighting: 'lit', materialClass: 'standard' }, { lighting: 'lit', materialClass: 'lambert' }, { lighting: 'unlit' }] as const) {
    for (const source of [new THREE.MeshStandardMaterial({ name: 'c_p03_m10_palette' }), new THREE.MeshBasicMaterial({ name: 'c_p03_m10_palette' })]) {
      const adapted = adaptCityMaterial(source, options);
      assert.equal(adapted.polygonOffset, true, `${options.lighting}/${options.materialClass ?? '-'}: ${source.type}`);
      assert.equal(adapted.polygonOffsetFactor, SKIRT_DEPTH_OFFSET.factor);
      assert.equal(adapted.polygonOffsetUnits, SKIRT_DEPTH_OFFSET.units);
      assert.equal(source.polygonOffset, false, 'the source is never modified');
    }
    for (const name of ['c_p03_m10_facades_0', 'asphalt', 'palette']) {
      assert.equal(adaptCityMaterial(new THREE.MeshStandardMaterial({ name }), options).polygonOffset, false, name);
    }
  }
});
