import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { CharacterState } from '../../../packages/sim/src/index.ts';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { JUMP_POSES } from '../../../apps/game/src/render/native-jump-animation.ts';
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

/** A civilian rig with arms, its gait loops and carried jump poses that lift the left arm. */
function jumpFixture() {
  const root = new THREE.Group();
  const bone = (name: string, parent: { add(child: unknown): unknown }, y: number, x = 0) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, 0); parent.add(b); return b; };
  const hips = bone('Hips', root, 1), chest = bone('Spine2', hips, .5);
  bone('Head', chest, .4); bone('LeftFoot', hips, -.9);
  for (const [side, x] of [['Left', .2], ['Right', -.2]] as const) bone(`${side}Hand`, bone(`${side}ForeArm`, bone(`${side}Arm`, chest, .3, x), -.28), -.25);
  const lift = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
  const gait = ['idle', 'walk', 'run', 'sprint', 'death'].map(name => new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack('Hips.position[y]', [0, 1], [1, 1])]));
  const jumps = Object.keys(JUMP_POSES.clips).filter(key => !key.startsWith('super_'))
    .map(key => new THREE.AnimationClip(key, 1, [new THREE.QuaternionKeyframeTrack('LeftArm.quaternion', [0, 1], [...lift.toArray(), ...lift.toArray()])]));
  const clips = new Map([...gait, ...jumps].map(clip => [clip.name, clip]));
  const assets = { cloneCharacter: () => ({ root, asset: { id: 'character-civilian-rain-black', scene: root, clips, height: 1.8 } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  return { assets, arm: root.getObjectByName('LeftArm')!, lift };
}

test('a civilian\'s carried jump and climb poses take over from its gait in the air and hand it back after landing', () => {
  const f = jumpFixture(), view = new CharacterView(f.assets, 'character-civilian-rain-black', new THREE.MeshBasicMaterial());
  assert.ok(Object.keys(JUMP_POSES.clips).every(key => !view.actions.has(key)), 'jump poses are not gait or reaction actions');
  const gait = () => ['idle', 'walk', 'run', 'sprint'].reduce((sum, name) => sum + view.actions.get(name)!.getEffectiveWeight(), 0);
  const run = state({ clip: 'sprint', speed: 5 }), jump = { ...run, jumpKind: 'normal' as const };
  for (let i = 0; i < 60; i++) view.update(run, 1 / 60, false);
  assert.ok(Math.abs(gait() - 1) < .02, `running: ${gait()}`);
  for (let i = 0; i < 6; i++) view.update({ ...jump, jumpPhase: 'takeoff', jumpPhaseTime: i / 60 }, 1 / 60, false);
  for (let i = 0; i < 24; i++) view.update({ ...jump, grounded: false, jumpPhase: 'rise', jumpPhaseTime: i / 60, verticalSpeed: 4 - i * .16, groundDistance: .1 + i * .03 }, 1 / 60, false);
  assert.ok(gait() < .05, `the jump takes over in the air: ${gait()}`);
  assert.ok(f.arm.quaternion.angleTo(f.lift) < .05, `the arm shows the carried pose: ${f.arm.quaternion.angleTo(f.lift)}`);
  for (let i = 0; i < 24; i++) view.update({ ...jump, grounded: false, jumpPhase: 'fall', jumpPhaseTime: i / 60, verticalSpeed: -i * .16, groundDistance: .8 - i * .03 }, 1 / 60, false);
  for (let i = 0; i < 11; i++) view.update({ ...jump, jumpPhase: 'land', jumpPhaseTime: i / 60, landingSpeed: 4 }, 1 / 60, false);
  for (let i = 0; i < 40; i++) view.update(run, 1 / 60, false);
  assert.ok(Math.abs(gait() - 1) < .02, `the gait is back after landing: ${gait()}`);
  for (let i = 0; i < 30; i++) view.update({ ...jump, grounded: false, jumpPhase: 'climb', jumpPhaseTime: i / 60, speed: 0,
    climb: { height: 1.2, duration: 1.1, edge: [0, 1.2, .5], normal: [0, -1] } }, 1 / 60, false);
  assert.ok(gait() < .1, `a ledge climb takes over too: ${gait()}`);
  view.dispose();
});
