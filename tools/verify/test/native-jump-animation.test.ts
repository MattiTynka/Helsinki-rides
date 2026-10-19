import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CHARACTER, CLIMB, type CharacterState } from '../../../packages/sim/src/index.ts';
import poses from '../../../content/assets/finn-jump-poses.json' with { type: 'json' };
import { climbVariantWeights, hasJumpPose, JumpPoseState, NativeJumpAnimation } from '../../../apps/game/src/render/native-jump-animation.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const state = (changes: Partial<CharacterState> = {}): CharacterState => ({ id: 'fixture', position: [0, 0, 0], yaw: 0, clip: 'idle', speed: 0,
  alive: true, health: 100, aiming: false, inVehicle: null, grounded: true, verticalSpeed: 0,
  jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null, ...changes });

test('jump visuals require a physics phase and stop for death, arrest, vehicle entry or grounded state', () => {
  const airborne = state({ grounded: false, jumpPhase: 'rise', jumpPhaseTime: .2, jumpKind: 'normal', verticalSpeed: 3, groundDistance: .5 });
  assert.ok(hasJumpPose(airborne));
  for (const change of [{ alive: false }, { clip: 'arrested' as const }, { inVehicle: 'car' }, { jumpPhase: 'grounded' as const }]) {
    assert.equal(hasJumpPose({ ...airborne, ...change }), false);
    const memory = new JumpPoseState();
    assert.ok(memory.step(airborne, 1 / 60, 0).clips.size > 0);
    assert.equal(memory.step({ ...airborne, ...change }, 1 / 60, 0).clips.size, 0);
  }
});

test('landing preparation responds to elevated support clearance rather than a fixed jump timer', () => {
  const falling = state({ grounded: false, jumpPhase: 'fall', jumpKind: 'super', verticalSpeed: -2.5, jumpPhaseTime: .1 });
  const fallTime = (groundDistance: number | null) => new JumpPoseState().step({ ...falling, groundDistance }, 1 / 60, 0).clips.get('super_stand_fall')!.time;
  const lowFloor = fallTime(2), highPlatform = fallTime(.12);
  assert.ok(highPlatform > lowFloor + .4, 'legs extend earlier before the close platform');
  assert.equal(fallTime(0), 1);
  assert.ok(Number.isFinite(fallTime(null)), 'absent support keeps a finite airborne pose');
  const memory = new JumpPoseState();
  const before = memory.step({ ...falling, groundDistance: 2 }, 1 / 60, 0).clips.get('super_stand_fall')!.time;
  const after = memory.step({ ...falling, groundDistance: 0 }, 1 / 60, 0).clips.get('super_stand_fall')!.time;
  assert.ok(after > before && after - before <= 5 / 60 + 1e-12, 'a suddenly closer support cannot snap the legs to touchdown');
});

test('native jump data has complete fixed-scale rig poses with only local hips translation', () => {
  assert.equal(poses.nativeJoints, 71);
  for (const [name, phase] of Object.entries(poses.clips)) {
    const rotations = phase.tracks.filter(track => track.path === 'quaternion');
    const translations = phase.tracks.filter(track => track.path !== 'quaternion');
    assert.equal(rotations.length, 71, name);
    assert.deepEqual(translations.map(track => [track.node, track.path]), [['DEF-Hips', 'position']]);
    for (const track of phase.tracks) {
      assert.ok(track.values.every(Number.isFinite));
      assert.equal(track.times[0], 0); assert.equal(track.times.at(-1), 1);
      assert.equal(track.values.length, track.times.length * (track.path === 'quaternion' ? 4 : 3));
      if (track.path === 'quaternion') for (let i = 0; i < track.values.length; i += 4)
        // v2 stores five decimal places: four independently rounded components permit 1e-5 norm error.
        assert.ok(Math.abs(Math.hypot(...track.values.slice(i, i + 4)) - 1) <= 1.01e-5, `${name}/${track.node}: normalized within serialization precision`);
    }
  }
});

test('native jump mixer binds sanitized bones, preserves lengths, masks aim and releases every action', () => {
  const root = new THREE.Group();
  for (const track of poses.clips.normal_stand_takeoff.tracks.filter(track => track.path === 'quaternion')) {
    const bone = new THREE.Bone(); bone.name = THREE.PropertyBinding.sanitizeNodeName(track.node); bone.position.set(.1, .2, .3); root.add(bone);
  }
  const hips = root.getObjectByName('DEF-Hips')!, spine = root.getObjectByName('DEF-Spine')!;
  const before = new Map<string, number[]>(root.children.filter((node: { uuid: string }) => node !== hips).map((node: { uuid: string; position: { toArray(): number[] } }) => [node.uuid, node.position.toArray()]));
  const mixer = new THREE.AnimationMixer(root);
  const controller = new NativeJumpAnimation(mixer, root, track => THREE.PropertyBinding.parseTrackName(track.name).nodeName === spine.name);
  const airborne = state({ grounded: false, jumpPhase: 'rise', jumpPhaseTime: .24, jumpKind: 'super', verticalSpeed: 2, groundDistance: 2 });
  for (let i = 0; i < 30; i++) { controller.update(airborne, 1 / 60, true); mixer.update(1 / 60); }
  assert.equal(spine.quaternion.angleTo(new THREE.Quaternion()), 0, 'aim-masked spine remains owned by the upper animation');
  assert.ok(hips.position.length() > .7 && hips.position.length() < 1.2, 'pose is local anatomical height in the native parent frame, not world jump displacement');
  for (const node of root.children) if (node !== hips) assert.deepEqual(node.position.toArray(), before.get(node.uuid)!, 'no bone translations/stretch');
  for (let i = 0; i < 30; i++) { controller.update(state(), 1 / 60, false); mixer.update(1 / 60); }
  assert.equal(controller.update(state(), 1 / 60, false).weight, 0, 'settled grounded state has no stale jump weight');
  controller.update(airborne, 1 / 60, false); mixer.update(1 / 60);
  assert.equal(controller.update(state({ inVehicle: 'car' }), 1 / 60, false).weight, 0, 'vehicle entry releases all jump weights immediately');
  mixer.stopAllAction();
});

test('running takeoff latches the stance foot and returns its landing phase to locomotion', () => {
  for (const [gait, foot, touchdown] of [[0, 'L', .5], [.6, 'R', 0]] as const) {
    const memory = new JumpPoseState();
    const takeoff = state({ speed: 3.6, jumpPhase: 'takeoff', jumpKind: 'normal', jumpPhaseTime: .05 });
    assert.deepEqual([...memory.step(takeoff, 1 / 60, gait).clips.keys()], [`normal_run${foot}_takeoff`]);
    const rise = memory.step({ ...takeoff, speed: 0, jumpPhase: 'rise', verticalSpeed: 3 }, 1 / 60, 1 - gait);
    assert.deepEqual([...rise.clips.keys()], [`normal_run${foot}_rise`], 'changing input in air cannot switch the takeoff foot');
    const land = memory.step({ ...takeoff, jumpPhase: 'land', landingSpeed: 4, jumpPhaseTime: 0 }, 1 / 60, gait);
    assert.equal(land.gaitPhase, touchdown);
    assert.ok(land.clips.has(`normal_run${foot}_land`));
    assert.equal(memory.step(state({ speed: 3.6 }), 1, gait).clips.size, 0, 'completed absorption gives locomotion its full weight');
  }
});

test('climb presentation uses simulation timing and blends neighboring measured ledge heights', () => {
  assert.equal(poses.climb.radius, CHARACTER.radius);
  for (const key of ['riseFraction', 'lift', 'wallGap', 'inset', 'baseSeconds', 'perMetreSeconds'] as const)
    assert.equal(poses.climb[key], CLIMB[key], `${key}: authored and capsule paths stay in agreement`);
  for (let height = 0; height <= 2; height += .025) {
    const weights = climbVariantWeights(height);
    assert.ok(weights.every(w => w >= 0 && w <= 1));
    assert.ok(Math.abs(weights.reduce((sum, w) => sum + w, 0) - 1) < 1e-12);
    assert.ok(weights.filter(w => w > 0).length <= 2);
  }
  const height = (poses.climb.variants[1]!.height + poses.climb.variants[2]!.height) / 2;
  const duration = CLIMB.baseSeconds + CLIMB.perMetreSeconds * height;
  const pose = new JumpPoseState().step(state({ jumpPhase: 'climb', jumpPhaseTime: duration * .3,
    climb: { height, duration, edge: [1, 2, 3], normal: [0, -1] } }), 1 / 60, 0);
  assert.equal(pose.clips.size, 2);
  for (const clip of pose.clips.values()) { assert.equal(clip.weight, .5); assert.ok(Math.abs(clip.time - .3) < 1e-12); }
  assert.ok(pose.climb && pose.climb.grip > .9 && pose.climb.wrists.every(Number.isFinite));
});
