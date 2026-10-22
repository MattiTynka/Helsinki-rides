import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { CharacterState } from '../../../packages/sim/src/index.ts';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { PedestrianAnimation, pedestrianGaitPhase } from '../../../apps/game/src/render/pedestrian-animation.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const state = (changes: Partial<CharacterState> = {}): CharacterState => ({ id: 'civilian-rain-black-1', position: [0, 0, 0], yaw: 0,
  clip: 'walk', speed: 1.2, alive: true, health: 100, aiming: false, inVehicle: null, grounded: true, verticalSpeed: 0,
  jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null, ...changes });

function fixture() {
  const root = new THREE.Group(), hips = new THREE.Bone(), chest = new THREE.Bone(), head = new THREE.Bone(), foot = new THREE.Bone();
  hips.name = 'Hips'; chest.name = 'Spine2'; head.name = 'Head'; foot.name = 'LeftFoot';
  root.add(hips); hips.add(chest, foot); chest.add(head); chest.position.y = .5; head.position.y = .4;
  // Nontrivial bone-local axes catch applying world Y directly as a local quaternion axis.
  hips.rotation.z = .2; chest.rotation.x = .1;
  const clips = new Map(['idle', 'walk', 'death'].map(name => [name, new THREE.AnimationClip(name, 1, [
    new THREE.NumberKeyframeTrack('Hips.position[y]', [0, .5, 1], name === 'death' ? [1, .5, .1] : [1, 1.01, 1]),
    new THREE.NumberKeyframeTrack('LeftFoot.position[z]', [0, .5, 1], [0, -.3, 0]),
  ])]));
  const assets = { cloneCharacter: () => ({ root, asset: { id: 'character-civilian-rain-black', scene: root, clips, height: 1.8 } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  return { root, hips, chest, head, foot, clips, assets };
}

test('civilian identities have independent, deterministic gait phases without altering stride cadence', () => {
  const phases = Array.from({ length: 32 }, (_, i) => pedestrianGaitPhase(`civilian-rain-black-${i + 1}`));
  assert.equal(new Set(phases).size, 32); assert.ok(phases.every(p => p >= 0 && p < 1));
  assert.ok(Math.max(...phases) - Math.min(...phases) > .7, 'neighbouring IDs span the cycle');
  const f = fixture(), original = JSON.stringify([...f.clips.values()].map(c => c.toJSON()));
  const view = new CharacterView(f.assets, 'character-civilian-rain-black', new THREE.MeshBasicMaterial());
  view.update(state(), 0, false);
  const before = view.actions.get('walk')!.time;
  assert.equal(before, pedestrianGaitPhase(state().id));
  for (let i = 0; i < 60; i++) view.update(state(), 1 / 60, false);
  const expected = (before + 1.2 / 1.4) % 1;
  assert.ok(Math.abs(view.actions.get('walk')!.time - expected) < 1e-10, 'seed affects phase only; one metre of motion keeps its authored stride');
  assert.equal(JSON.stringify([...f.clips.values()].map(c => c.toJSON())), original, 'source loops remain exact');
  view.dispose();
});

test('turn anticipation stays small, preserves feet/hips, restores before sampling and cannot accumulate', () => {
  const { root, hips, chest, head, foot } = fixture(), motion = new PedestrianAnimation(root);
  const original = [hips, chest, head, foot].map(node => node.quaternion.clone());
  const local = [hips, chest, head, foot].map(node => node.position.clone());
  motion.apply(state(), 1 / 60, false);
  for (let i = 1; i <= 120; i++) {
    motion.restore(); root.rotation.y = i / 120;
    motion.apply(state({ yaw: i / 120 }), 1 / 60, false);
    assert.ok(head.quaternion.angleTo(original[2]!) < .19, 'head lead remains below eleven degrees');
    assert.ok(chest.quaternion.angleTo(original[1]!) < .07, 'torso correction remains below four degrees');
    assert.deepEqual(hips.quaternion.toArray(), original[0]!.toArray()); assert.deepEqual(foot.quaternion.toArray(), original[3]!.toArray());
    for (const [index, node] of [hips, chest, head, foot].entries()) assert.deepEqual(node.position.toArray(), local[index]!.toArray());
  }
  const paused = [chest, head].map(node => node.quaternion.toArray());
  for (let frame = 0; frame < 20; frame++) {
    motion.restore(); motion.apply(state({ yaw: 1 }), 0, false);
    assert.deepEqual([chest, head].map(node => node.quaternion.toArray()), paused, 'zero-time frames hold the displayed turn pose');
  }
  motion.restore();
  assert.ok(chest.quaternion.angleTo(original[1]!) < 1e-7); assert.ok(head.quaternion.angleTo(original[2]!) < 1e-7);
  for (const changes of [{ alive: false }, { clip: 'death' as const }, { grounded: false }, { inVehicle: 'car' }]) {
    motion.apply(state({ yaw: 1.1, ...changes }), 1 / 60, false);
    assert.ok(chest.quaternion.angleTo(original[1]!) < 1e-7); assert.ok(head.quaternion.angleTo(original[2]!) < 1e-7);
  }
  motion.apply(state({ yaw: 1.2 }), 0, false);
  assert.ok(head.quaternion.angleTo(original[2]!) < 1e-7, 'paused renders do not move the head');
});
