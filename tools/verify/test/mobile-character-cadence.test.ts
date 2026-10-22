import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { parseCharacterProfile } from '../../../apps/game/src/render/native-locomotion.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const metadata = JSON.parse(readFileSync(new URL('../../../content/assets/finn-locomotion.json', import.meta.url), 'utf8'));
type State = Parameters<CharacterView['update']>[0];
const state = (changes: Partial<State> = {}): State => ({ id: 'subject', position: [0, 0, 0], yaw: 0,
  clip: 'walk', speed: 1.4, alive: true, health: 100, aiming: false, inVehicle: null, grounded: true, verticalSpeed: 0,
  jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null, ...changes });
const options = { mobile: true, cameraPosition: { x: 0, y: 0, z: 100 } };

function fixture(native: boolean) {
  const root = new THREE.Group(), hips = new THREE.Bone(), spine = new THREE.Bone();
  hips.name = 'Hips'; spine.name = 'DEF-Spine'; root.add(hips); hips.add(spine);
  const names = ['idle', 'walk', 'run', 'sprint', ...metadata.locomotion.map((clip: { clip: string }) => clip.clip), ...Object.values(metadata.states)] as string[];
  const clips = new Map<string, InstanceType<typeof THREE.AnimationClip>>();
  for (const name of new Set(names)) clips.set(name, new THREE.AnimationClip(name, name === 'death' ? 1.4 : 1, [
    new THREE.NumberKeyframeTrack('Hips.position[y]', [0, name === 'death' ? 1.4 : 1], name === 'death' ? [1, .1] : [1, 1]),
    new THREE.QuaternionKeyframeTrack('DEF-Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]));
  const profile = native ? parseCharacterProfile(metadata, new Set(clips.keys())) : undefined;
  const assets = { cloneCharacter: () => ({ root, asset: { id: 'fixture', scene: root, clips, height: 1.8, profile } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  return { view: new CharacterView(assets, 'fixture', new THREE.MeshBasicMaterial()), hips };
}

for (const native of [false, true]) test(`${native ? 'native' : 'legacy'} mobile skeleton samples less often, preserves its clock, and presents lethal hits immediately`, () => {
  const distant = fixture(native), full = fixture(native);
  let calls = 0;
  const original = distant.view.mixer.update.bind(distant.view.mixer);
  distant.view.mixer.update = seconds => { calls++; return original(seconds); };
  for (let frame = 0; frame < 120; frame++) {
    const moving = state({ position: [0, 0, frame / 60] });
    distant.view.update(moving, 1 / 60, false, null, undefined, undefined, options);
    full.view.update(moving, 1 / 60, false);
    assert.equal(distant.view.root.position.z, frame / 60, 'root motion is not sampled');
  }
  distant.view.update(state({ position: [0, 0, 2] }), 0, false, null, undefined, undefined, options);
  full.view.update(state({ position: [0, 0, 2] }), 0, false);
  assert.ok(calls <= 22, `expected about 20 distant mixer samples, got ${calls}`);
  const gait = native ? metadata.locomotion[0].clip : 'walk';
  const delta = Math.abs(distant.view.actions.get(gait)!.time - full.view.actions.get(gait)!.time);
  const duration = distant.view.actions.get(gait)!.getClip().duration;
  assert.ok(Math.min(delta, Math.abs(duration - delta)) < 1e-8, `phase ${distant.view.actions.get(gait)!.time} vs ${full.view.actions.get(gait)!.time}`);
  distant.view.update(state(), 1 / 60, false, null, undefined, undefined, options);
  const before = calls;
  distant.view.update(state({ alive: false, health: 0, deathElapsed: .7 }), 1 / 60, false, null, undefined, undefined, options);
  assert.ok(calls > before); assert.equal(distant.view.current, 'death'); assert.ok(Math.abs(distant.hips.position.y - .55) < 1e-6);
  distant.view.update(state({ alive: false, health: 0, deathElapsed: 8 }), 1 / 60, false, null, undefined, undefined, options);
  assert.ok(Math.abs(distant.hips.position.y - .1) < 1e-6);
  distant.view.update(state({ alive: false, health: 0, deathElapsed: 8 }), 0, false, null, undefined, undefined, options);
  assert.ok(Math.abs(distant.hips.position.y - .1) < 1e-6);
  distant.view.dispose(); full.view.dispose();
});
