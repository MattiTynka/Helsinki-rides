import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { CharacterState, VehicleState } from '../../../packages/sim/src/index.ts';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { nativeLocomotionWeights, parseCharacterProfile } from '../../../apps/game/src/render/native-locomotion.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
// Rain's supplied manifest has its own measured speed anchors; none are borrowed from Finn.
const metadata = { schemaVersion: 1, id: 'rain-native-v1', phaseGroup: 'left-strike', upperBodyRoot: 'DEF-Spine1',
  locomotion: [
    { clip: 'walk', movementSpeed: 1.252, direction: 'forward' },
    { clip: 'jog', movementSpeed: 2.471, direction: 'forward' },
    { clip: 'run', movementSpeed: 3.562, direction: 'forward' },
    { clip: 'sprint', movementSpeed: 5.031, direction: 'forward' },
    { clip: 'walk_back', movementSpeed: .948, direction: 'backward' },
    { clip: 'jog_back', movementSpeed: 1.856, direction: 'backward' },
    { clip: 'strafe_left', movementSpeed: 1.021, direction: 'left' },
    { clip: 'jog_left', movementSpeed: 1.963, direction: 'left' },
    { clip: 'strafe_right', movementSpeed: 1.014, direction: 'right' },
    { clip: 'jog_right', movementSpeed: 1.975, direction: 'right' },
  ],
  // Aliased state names verify that aiming follows the declared profile instead of hard-coded action keys.
  states: { idle: 'idle', aim: 'rain_aim', fire: 'rain_fire', hit: 'rain_hit', death: 'rain_death', drive: 'rain_drive', arrested: 'rain_arrested' },
};
const names = new Set([...metadata.locomotion.map(c => c.clip), ...Object.values(metadata.states)]);
const profile = parseCharacterProfile(metadata, names)!;
const state = (changes: Partial<CharacterState> = {}): CharacterState => ({
  id: 'rain-officer', position: [0, 0, 0], yaw: 0, clip: 'idle', speed: 0, alive: true, health: 100,
  aiming: false, inVehicle: null, grounded: true, verticalSpeed: 0, jumpPhase: 'grounded',
  jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null, ...changes,
});

function fixture() {
  const root = new THREE.Group(), hips = new THREE.Bone(), spine = new THREE.Bone(), leg = new THREE.Bone(), hand = new THREE.Bone(), socket = new THREE.Group();
  hips.name = 'DEF-Hips'; spine.name = 'DEF-Spine1'; leg.name = 'DEF-ThighL'; hand.name = 'DEF-HandR'; socket.name = 'SOCKET_HAND_R';
  root.add(hips); hips.add(spine, leg); spine.add(hand); hand.add(socket);
  spine.position.y = 1; hand.position.set(.1, .4, .5);
  const clips = new Map<string, InstanceType<typeof THREE.AnimationClip>>();
  for (const [i, movement] of profile.locomotion.entries()) {
    const duration = 1.2 - i * .04;
    clips.set(movement.clip, new THREE.AnimationClip(movement.clip, duration, [
      new THREE.NumberKeyframeTrack(`${leg.name}.position[y]`, [0, duration], [i + 1, i + 1]),
      new THREE.NumberKeyframeTrack(`${leg.name}.position[x]`, [0, duration / 2, duration], [0, .2, 0]),
      new THREE.QuaternionKeyframeTrack(`${spine.name}.quaternion`, [0, duration], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]));
  }
  for (const [key, name] of Object.entries(profile.states)) clips.set(name, new THREE.AnimationClip(name, 1, [
    new THREE.NumberKeyframeTrack(`${leg.name}.position[y]`, [0, 1], key === 'aim' || key === 'fire' ? [-100, -100] : [0, 0]),
    new THREE.NumberKeyframeTrack(`${hips.name}.position[y]`, [0, 1], key === 'drive' ? [.4, .4] : [0, 0]),
    new THREE.QuaternionKeyframeTrack(`${spine.name}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]));
  const pistol = new THREE.Group(); pistol.rotation.y = .09;
  const assets = { cloneCharacter: () => ({ root, asset: { id: 'rain-fixture', scene: root, clips, height: 1.8, profile } }), clonePistol: () => pistol } as unknown as ConstructorParameters<typeof CharacterView>[0];
  return { view: new CharacterView(assets, 'rain-fixture', new THREE.MeshBasicMaterial()), clips, hips, spine, leg, pistol };
}

test('Rain keeps its explicit profile identity, measured gait anchors and fail-closed metadata', () => {
  assert.equal(profile.id, 'rain-native-v1'); assert.equal(profile.upperBodyRoot, 'DEF-Spine1');
  assert.equal(nativeLocomotionWeights(profile, 1.252, 0, 1).walk, 1);
  assert.equal(nativeLocomotionWeights(profile, 3.562, 0, 1).run, 1);
  assert.equal(nativeLocomotionWeights(profile, .948, 0, -1).walk_back, 1);
  assert.equal(nativeLocomotionWeights(profile, 1.021, 1, 0).strafe_left, 1);
  assert.throws(() => parseCharacterProfile({ ...metadata, id: 'unknown-native-v1' }, names), /Unsupported/);
  assert.throws(() => parseCharacterProfile(metadata, new Set([...names].filter(name => name !== profile.states.fire))), /state fire/);
});

test('Rain uses the shared distance-based gait clock across its different duration loops', () => {
  const { view } = fixture();
  for (const [clip, speed] of [['walk', 1.252], ['run', 3.562], ['sprint', 5.031]] as const) {
    view.update(state({ clip, speed }), .15, false);
    const walk = view.actions.get('walk')!, phase = walk.time / walk.getClip().duration;
    for (const movement of profile.locomotion) {
      const action = view.actions.get(movement.clip)!;
      assert.ok(Math.abs(action.time / action.getClip().duration - phase) < 1e-10);
    }
  }
  const before = view.actions.get('walk')!.time;
  view.update(state(), .2, false);
  assert.equal(view.actions.get('walk')!.time, before, 'blocked or stopped feet do not continue walking');
  view.dispose();
});

test('Rain masks aim at DEF-Spine1, keeps its moving legs and corrects the declared pistol action', () => {
  const { view, clips, spine, leg, pistol } = fixture();
  const original = clips.get(profile.states.aim)!.tracks.slice();
  for (let i = 0; i < 60; i++) view.update(state({ clip: 'aim', aiming: true, speed: 1.6, position: [i * 1.6 / 60, 0, 0] }), 1 / 60, true);
  assert.ok(leg.position.y > 7 && leg.position.y < 8, 'aim overlay does not replace Rain strafe legs');
  const planted = leg.position.clone(), base = spine.quaternion.clone();
  const target = new THREE.Vector3(1.5, 3, 10);
  view.aimAt(target);
  const muzzle = pistol.localToWorld(new THREE.Vector3(0, 0, .14));
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(pistol.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(direction.angleTo(target.clone().sub(muzzle)) < 1e-5, 'CharacterView uses Rain profile spine and aliased aim action');
  assert.ok(spine.quaternion.angleTo(base) > .05);
  assert.deepEqual(leg.position.toArray(), planted.toArray());
  view.update(state({ clip: 'fire', aiming: true, speed: 1.6, position: [1.6, 0, 0] }), 1 / 60, true);
  assert.ok(spine.quaternion.angleTo(base) < 1e-8, 'additive targeting restores before the next native mixer sample');
  assert.deepEqual(clips.get(profile.states.aim)!.tracks, original, 'supplied clip tracks stay unchanged');
  view.dispose();
});

test('Rain falling or seated states cannot instantiate Finn-only joint layers', () => {
  const { view, hips } = fixture();
  // This small Rain rig deliberately has neither Finn DEF-Spine nor its 71 vehicle/jump joints.
  assert.doesNotThrow(() => view.update(state({ grounded: false, jumpPhase: 'fall', jumpPhaseTime: .3, verticalSpeed: -3, groundDistance: 1 }), 1 / 60, false));
  const car = { id: 'patrol', position: [0, 0, 0], rotation: [0, 0, 0, 1] } as unknown as VehicleState;
  for (let i = 0; i < 60; i++) view.update(state({ clip: 'drive', inVehicle: car.id }), 1 / 60, false, { vehicleId: car.id, stage: 'seated', progress: 1, clip: 'enter', side: 'driver', startOffset: [0, 0, 0] }, car);
  assert.equal(view.current, 'drive', 'Finn-only standing baseline does not replace Rain drive state');
  assert.ok(Math.abs(hips.position.y - .4) < 1e-6);
  assert.equal(view.root.visible, false, 'officer vehicle visibility keeps the existing NPC behavior');
  view.dispose();
});
