import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { CharacterCollapse } from '../../../apps/game/src/render/character-collapse.ts';
import { parseCharacterProfile } from '../../../apps/game/src/render/native-locomotion.ts';
import type { CharacterState } from '../../../packages/sim/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const metadata = JSON.parse(readFileSync(new URL('../../../content/assets/finn-locomotion.json', import.meta.url), 'utf8'));
const timing = { fallSeconds: 1.4, holdSeconds: .6, riseSeconds: 1.6 };
const state = (changes: Partial<CharacterState> = {}): CharacterState => ({ id: 'subject', position: [0, 0, 0], yaw: 0,
  clip: 'walk', speed: 1.2, alive: true, health: 100, aiming: false, inVehicle: null, grounded: true, verticalSpeed: 0,
  jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null, ...changes });

function fixture(native: boolean) {
  const root = new THREE.Group(), hips = new THREE.Bone(), spine = new THREE.Bone();
  hips.name = 'Hips'; spine.name = 'DEF-Spine'; root.add(hips); hips.add(spine);
  const names = ['idle', ...metadata.locomotion.map((entry: { clip: string }) => entry.clip), ...Object.values(metadata.states)] as string[];
  const clips = new Map<string, InstanceType<typeof THREE.AnimationClip>>();
  for (const name of new Set(names)) clips.set(name, new THREE.AnimationClip(name, name === 'death' ? 1.4 : 1, [
    new THREE.NumberKeyframeTrack('Hips.position[y]', [0, name === 'death' ? 1.4 : 1], name === 'death' ? [1, .1] : [1, 1]),
    new THREE.QuaternionKeyframeTrack('DEF-Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]));
  const profile = native ? parseCharacterProfile(metadata, new Set(clips.keys())) : undefined;
  const assets = { cloneCharacter: () => ({ root, asset: { id: 'fixture', scene: root, clips, height: 1.8, profile } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  return { view: new CharacterView(assets, 'fixture', new THREE.MeshBasicMaterial()), hips };
}

test('fatal collapse preserves current knockdown pose and never reverses even during recovery', () => {
  for (const elapsed of [.7, 1.8, 2.8]) {
    const collapse = new CharacterCollapse();
    let previous = collapse.update(state({ knockdown: { ...timing, elapsed } }), 1 / 60, 1.4)!;
    for (let tick = 0; tick <= 480; tick++) {
      const progress = collapse.update(state({ alive: false, deathElapsed: tick / 60 }), 1 / 60, 1.4)!;
      assert.ok(progress >= previous, 'a fatal hit never raises the body toward standing'); previous = progress;
    }
    assert.equal(previous, 1);
    assert.equal(collapse.update(state({ alive: false, deathElapsed: 1 }), 0, 1.4), 1, 'older samples cannot raise a settled corpse');
    assert.equal(collapse.update(state(), 0, 1.4), null, 'a genuine reset with alive=true permits locomotion');
  }
});

for (const native of [false, true]) {
  test(`${native ? 'native' : 'legacy'} mixer keeps killed actors down despite stale gait, paused renders and view recreation`, () => {
    let { view, hips } = fixture(native);
    view.update(state(), .2, false);
    // The fatal-contact snapshot may precede an AI clip update. Literal alive state has priority.
    view.update(state({ alive: false, health: 0, deathElapsed: .7 }), .01, false);
    assert.equal(view.current, 'death'); assert.ok(Math.abs(hips.position.y - .55) < 1e-6);
    for (let i = 0; i < 120; i++) view.update(state({ alive: false, health: 0, deathElapsed: .7 }), 0, false);
    assert.ok(Math.abs(hips.position.y - .55) < 1e-6, 'paused wall time does not advance the authoritative fall');
    view.update(state({ alive: false, health: 0, deathElapsed: 8 }), .01, false);
    assert.ok(Math.abs(hips.position.y - .1) < 1e-6);
    const terminal = view.actions.get('death')!.time;
    for (let i = 0; i < 240; i++) view.update(state({ alive: false, health: 0, deathElapsed: 8 + i / 60 }), 1 / 60, false);
    assert.equal(view.actions.get('death')!.time, terminal); assert.equal(view.actions.get('death')!.paused, true);
    view.dispose();
    ({ view, hips } = fixture(native));
    view.update(state({ alive: false, health: 0, deathElapsed: 12 }), 0, false);
    assert.equal(view.current, 'death'); assert.ok(Math.abs(hips.position.y - .1) < 1e-6, 'newly created corpse view starts lying down');
    view.dispose();
  });
  test(`${native ? 'native' : 'legacy'} fatal shot during sampled recovery never restarts standing`, () => {
    const { view, hips } = fixture(native);
    view.update(state({ clip: 'death', knockdown: { ...timing, elapsed: 2.8 } }), 1 / 60, false);
    let previous = hips.position.y;
    for (let tick = 0; tick <= 240; tick++) {
      view.update(state({ clip: 'death', alive: false, health: 0, deathElapsed: tick / 60 }), 1 / 60, false);
      assert.ok(hips.position.y <= previous + 1e-6); previous = hips.position.y;
    }
    assert.ok(Math.abs(hips.position.y - .1) < 1e-6); view.dispose();
  });
}
