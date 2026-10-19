import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { VEHICLE_INTERACTION, vehicleExitRoute, type CharacterState, type PlayerState, type VehicleClip, type VehicleState } from '../../../packages/sim/src/index.ts';
import { NativeVehicleAnimation, VEHICLE_POSE_RELEASE, VEHICLE_POSES, VEHICLE_ROOT_WARP, vehicleDoorOpen, vehiclePoseSample } from '../../../apps/game/src/render/native-vehicle-animation.ts';
import { VehicleView } from '../../../apps/game/src/render/vehicles.ts';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { parseCharacterProfile } from '../../../apps/game/src/render/native-locomotion.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
type Interaction = NonNullable<PlayerState['vehicleInteraction']>;
const CLIP: Record<Interaction['stage'], VehicleClip> = { approach: 'enter', enter: 'enter', seated: 'enter', exit: 'exit' };
const interaction = (stage: Interaction['stage'], progress = 0, clip = CLIP[stage], startOffset: [number, number, number] = [0, 0, 0]): Interaction =>
  ({ vehicleId: 'car', stage, progress, clip, side: vehicleExitRoute(clip), startOffset });
const car = {
  id: 'car', position: [14, 2, -8], rotation: [0, Math.sin(.7), 0, Math.cos(.7)],
} as unknown as VehicleState;
const CLIPS = Object.keys(VEHICLE_INTERACTION.durations) as VehicleClip[];
const EXITS = CLIPS.filter(clip => clip !== 'enter');
/** Past the entry's root warp and bone blend-in. */
const SETTLED = (VEHICLE_ROOT_WARP + .05) / VEHICLE_INTERACTION.durations.enter;

function fixture() {
  const root = new THREE.Group(), model = new THREE.Group(); root.add(model);
  const before = new Map<string, { q: number[]; p: number[]; s: number[] }>();
  for (const [index, name] of Object.keys(VEHICLE_POSES.clips.enter.frames[0]!.rotations).entries()) {
    // GLTFLoader sanitizes punctuation; use the loaded names rather than the authoring names.
    const bone = new THREE.Bone(); bone.name = THREE.PropertyBinding.sanitizeNodeName(name);
    bone.position.set(.1 + index * .001, .2, -.03);
    bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), index * .002);
    model.add(bone);
    before.set(bone.name, { q: bone.quaternion.toArray(), p: bone.position.toArray(), s: bone.scale.toArray() });
  }
  return { root, model, before, animation: new NativeVehicleAnimation(model) };
}

test('vehicle clocks are inactive during the walk-up and each clip opens only its own door', () => {
  assert.equal(vehiclePoseSample(null), null);
  assert.equal(vehiclePoseSample(interaction('approach', .6)), null);
  assert.equal(vehicleDoorOpen(interaction('approach', .6), 'DOOR_FL'), 0);
  assert.equal(vehicleDoorOpen(interaction('enter', 0), 'DOOR_FL'), 0);
  assert.equal(vehicleDoorOpen(interaction('seated', 1), 'DOOR_FL'), 0);
  for (let i = 0; i <= 100; i++) {
    const u = i / 100;
    for (const clip of CLIPS) {
      const own = VEHICLE_POSES.clips[clip].door;
      const stage = clip === 'enter' ? 'enter' : 'exit';
      for (const door of ['DOOR_FL', 'DOOR_FR']) {
        const open = vehicleDoorOpen(interaction(stage, u, clip), door);
        if (door === own) assert.ok(open >= 0 && open <= 1);
        else assert.equal(open, 0, `${clip} leaves ${door} shut`);
      }
    }
  }
  assert.equal(VEHICLE_POSES.clips.exitPassenger.door, 'DOOR_FR');
  assert.equal(VEHICLE_POSES.clips.exitFlipped.door, 'DOOR_FL');
  assert.equal(VEHICLE_POSES.clips.exitFlippedPassenger.door, 'DOOR_FR');
  assert.equal(VEHICLE_POSES.clips.exitWindshield.door, null);
  // The door holds open while the legs pass the sill (1.3 to 3.0 s of the entry).
  for (const seconds of [1.3, 2.0, 2.6, 3.0]) assert.ok(vehicleDoorOpen(interaction('enter', seconds / 3.8), 'DOOR_FL') > .7);
});

test('authored clips match the sim: durations, stages, seated seams and a complete native rig', () => {
  const [sx, , sz] = VEHICLE_INTERACTION.stage;
  assert.deepEqual(VEHICLE_POSES.stage, VEHICLE_INTERACTION.stage);
  assert.equal(VEHICLE_POSES.entryYawDeg * Math.PI / 180, VEHICLE_INTERACTION.entryYaw);
  assert.equal(VEHICLE_POSES.exitYawDeg * Math.PI / 180, VEHICLE_INTERACTION.exitYaw);
  const names = Object.keys(VEHICLE_POSES.clips.enter.frames[0]!.rotations).sort();
  assert.equal(names.length, 71);
  for (const clip of CLIPS) {
    const { frames, duration } = VEHICLE_POSES.clips[clip];
    assert.equal(duration, VEHICLE_INTERACTION.durations[clip]);
    assert.ok(frames.length > 20, 'non-looping motion has enough samples to inspect contact changes');
    assert.equal(frames[0]!.time, 0);
    assert.equal(frames.at(-1)!.time, 1);
    for (const [index, frame] of frames.entries()) {
      assert.ok(frame.hips.length === 3 && frame.hips.every(Number.isFinite));
      assert.deepEqual(Object.keys(frame.rotations).sort(), names);
      if (index) assert.ok(frame.time > frames[index - 1]!.time);
      for (const [name, q] of Object.entries(frame.rotations)) {
        assert.ok(q.length === 4 && q.every(Number.isFinite), name);
        // Rotations are stored to five decimals.
        assert.ok(Math.abs(Math.hypot(...q) - 1) < 2e-5, `${name}: unit quaternion`);
        if (index) {
          const previous = frames[index - 1]!.rotations[name]!;
          const dot = Math.min(1, Math.abs(q.reduce((sum, component, i) => sum + component * previous[i]!, 0)));
          assert.ok(2 * Math.acos(dot) < .65, `${clip} ${name}: no large discontinuity between authored samples`);
        }
      }
    }
  }
  // Hips are stored in the rig's Blender axes: [x, -z, height].
  const { enter, exit, exitPassenger, exitWindshield, exitFlipped, exitFlippedPassenger } = VEHICLE_POSES.clips;
  assert.deepEqual(enter.frames[0]!.hips.slice(0, 2), [sx, -sz]);
  assert.deepEqual(exit.frames.at(-1)!.hips.slice(0, 2), [sx, -sz]);
  assert.deepEqual(exitPassenger.frames.at(-1)!.hips.slice(0, 2), [-sx, -sz]);
  const [wx, , wz] = VEHICLE_INTERACTION.windshieldStage, [fx, fz] = VEHICLE_INTERACTION.flippedStage;
  assert.deepEqual(exitWindshield.frames.at(-1)!.hips.slice(0, 2), [wx, -wz]);
  assert.deepEqual(exitFlipped.frames.at(-1)!.hips.slice(0, 2), [fx, -fz]);
  assert.deepEqual(exitFlippedPassenger.frames.at(-1)!.hips.slice(0, 2), [-fx, -fz]);
  // Exits start from the held seated pose (q and -q are the same rotation); a car on its roof does not change it.
  for (const clip of EXITS.map(name => VEHICLE_POSES.clips[name])) for (const name of names) {
    const a = enter.frames.at(-1)!.rotations[name]!, b = clip.frames[0]!.rotations[name]!;
    assert.ok(Math.abs(a.reduce((sum, c, i) => sum + c * b[i]!, 0)) / (Math.hypot(...a) * Math.hypot(...b)) > 1 - 1e-6, `${name}: seated seam`);
  }
});

test('the exit is its own motion, not the entry played backwards', () => {
  const { root, model, animation } = fixture();
  let largest = 0;
  for (const u of [.25, .4, .5, .6, .75]) {
    animation.apply(root, interaction('enter', u), car);
    const entering = model.children.map((node: { quaternion: InstanceType<typeof THREE.Quaternion> }) => node.quaternion.clone());
    animation.restore();
    animation.apply(root, interaction('exit', 1 - u), car);
    for (const [i, node] of model.children.entries()) largest = Math.max(largest, node.quaternion.angleTo(entering[i]!));
    animation.restore();
  }
  assert.ok(largest > .5, `exit differs from the reversed entry (largest joint difference ${largest.toFixed(2)} rad)`);
});

test('native vehicle layer follows the complete car transform and never stretches non-hip joints', () => {
  const { root, model, before, animation } = fixture();
  assert.equal(animation.apply(root, interaction('approach'), car), false);
  assert.equal(animation.apply(root, interaction('enter', .5), undefined), false);
  for (const clip of CLIPS) {
    assert.equal(animation.apply(root, interaction(clip === 'enter' ? 'enter' : 'exit', .5, clip), car), true);
    assert.deepEqual(root.position.toArray(), car.position);
    assert.deepEqual(root.quaternion.toArray(), car.rotation);
    assert.equal(root.visible, true);
    for (const node of model.children) {
      const rest = before.get(node.name)!;
      assert.deepEqual(node.scale.toArray(), rest.s, `${node.name}: scale preserved`);
      if (node.name !== 'DEF-Hips') assert.deepEqual(node.position.toArray(), rest.p, `${node.name}: fixed bone length`);
    }
    animation.restore();
  }
});

test('the entry starts where the walk-up stopped, blends in from the mixer pose and settles onto the authored path', () => {
  const { root, model, before, animation } = fixture();
  const offset: [number, number, number] = [.15, -.1, .5];
  assert.ok(animation.apply(root, interaction('enter', 0, 'enter', offset), car));
  for (const node of model.children) {
    if (node.name !== 'DEF-Hips') assert.ok(node.quaternion.angleTo(new THREE.Quaternion().fromArray(before.get(node.name)!.q)) < 1e-6, `${node.name}: first frame is the mixer pose`);
  }
  // The authored first frame stands on the stage; the warped root puts it where Finn actually stopped.
  const carQ = new THREE.Quaternion().fromArray(car.rotation);
  const stage = new THREE.Vector3().fromArray(VEHICLE_INTERACTION.stage);
  const stageWorld = stage.clone().applyQuaternion(root.quaternion).add(root.position);
  const expected = stage.clone().add(new THREE.Vector3(offset[0], 0, offset[1])).applyQuaternion(carQ).add(new THREE.Vector3().fromArray(car.position));
  assert.ok(stageWorld.distanceTo(expected) < 1e-9, 'stage point is moved by the walk-up offset');
  assert.ok(Math.abs(root.quaternion.angleTo(carQ) - offset[2]) < 1e-9, 'heading error is carried, then removed');
  animation.restore();
  assert.ok(animation.apply(root, interaction('enter', SETTLED, 'enter', offset), car));
  assert.deepEqual(root.position.toArray(), car.position);
  assert.ok(root.quaternion.angleTo(carQ) < 1e-12);
  animation.restore();
});

test('vehicle override restores the latest mixer pose rather than an obsolete bind pose', () => {
  const { root, model, before, animation } = fixture();
  const wrist = model.children.find((node: { name: string }) => /Wrist/.test(node.name))!;
  for (let cycle = 0; cycle < 3; cycle++) {
    wrist.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), .2 + cycle * .1);
    const pose = wrist.quaternion.toArray();
    animation.apply(root, interaction('seated', 1), car);
    animation.restore();
    assert.deepEqual(wrist.quaternion.toArray(), pose);
  }
  for (const node of model.children) if (node !== wrist) {
    assert.deepEqual(node.quaternion.toArray(), before.get(node.name)!.q, `${node.name}: restored rotation`);
    assert.deepEqual(node.position.toArray(), before.get(node.name)!.p, `${node.name}: restored position`);
  }
});

test('incomplete rigs fail explicitly before applying a partial seated pose', () => {
  assert.throws(() => new NativeVehicleAnimation(new THREE.Group()), /missing joint/);
});

test('the vehicle view opens the clip\'s own door with no frame-rate-dependent lag', () => {
  const driver = new THREE.Object3D(), passenger = new THREE.Object3D();
  driver.name = 'DOOR_FL'; passenger.name = 'DOOR_FR';
  const rest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .08);
  const context = {
    root: new THREE.Group(), wheels: [], doorOpen: {},
    doors: [{ node: driver, openDeg: 65, sign: -1, rest }, { node: passenger, openDeg: 65, sign: 1, rest }],
    steering: null, lampHead: [], lampTail: [], lampBlue: [], shadow: { visible: false }, windshield: { visible: true },
  };
  const state = { ...car, wheels: [], lightsOn: false, sirenOn: false, throttle: 0, forwardSpeed: 0 } as unknown as VehicleState;
  const swing = (sign: number, open: number) => rest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sign * 65 * Math.PI / 180 * open));
  for (const dt of [1 / 144, 1 / 60, 1 / 20]) for (const u of [.1, .25, .6, .9, 1]) {
    for (const [stage, clip] of [['enter', 'enter'], ['exit', 'exitPassenger']] as const) {
      const state2 = interaction(stage, u, clip);
      const targets = { DOOR_FL: vehicleDoorOpen(state2, 'DOOR_FL'), DOOR_FR: vehicleDoorOpen(state2, 'DOOR_FR') };
      VehicleView.prototype.update.call(context as unknown as VehicleView, state, 0, targets, dt);
      assert.ok(driver.quaternion.angleTo(swing(-1, targets.DOOR_FL)) < 1e-7, 'driver door samples the authored clock without damping');
      assert.ok(passenger.quaternion.angleTo(swing(1, targets.DOOR_FR)) < 1e-7, 'passenger door samples the authored clock without damping');
      if (clip === 'enter') assert.deepEqual(passenger.quaternion.toArray(), rest.toArray(), 'entry leaves the passenger door shut');
    }
  }
  assert.equal(context.windshield.visible, true);
  VehicleView.prototype.update.call(context as unknown as VehicleView, { ...state, windshieldBroken: true }, 0, {}, 1 / 60);
  assert.equal(context.windshield.visible, false, 'a kicked-out windshield is hidden');
});

test('after the exit Finn fades into standing, never the obsolete seated drive clip', () => {
  const { model } = fixture();
  const metadata = JSON.parse(readFileSync(new URL('../../../content/assets/finn-locomotion.json', import.meta.url), 'utf8'));
  const names = new Set<string>([...metadata.locomotion.map((clip: { clip: string }) => clip.clip), ...Object.values(metadata.states) as string[]]);
  const profile = parseCharacterProfile(metadata, names)!;
  const clips = new Map<string, InstanceType<typeof THREE.AnimationClip>>();
  for (const name of names) clips.set(name, new THREE.AnimationClip(name, 1, [
    new THREE.VectorKeyframeTrack('DEF-Hips.position', [0, 1], name === profile.states.drive ? [0, .45, 0, 0, .45, 0] : [0, 1, 0, 0, 1, 0]),
    new THREE.QuaternionKeyframeTrack('DEF-Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]));
  const assets = { cloneCharacter: () => ({ root: model, asset: { id: 'native-fixture', scene: model, clips, height: 1.8, profile } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  const view = new CharacterView(assets, 'native-fixture', new THREE.MeshBasicMaterial());
  const base: CharacterState = { id: 'fixture', position: [14, 2, -8], yaw: 1.4, clip: 'idle', speed: 0, alive: true, health: 100,
    inVehicle: null, aiming: false, grounded: true, verticalSpeed: 0, jumpPhase: 'grounded', jumpPhaseTime: 0,
    jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null };
  const seated: CharacterState = { ...base, clip: 'drive', inVehicle: car.id };
  const hips = model.getObjectByName('DEF-Hips')!;
  view.update(base, 1 / 60, false);
  for (let tick = 0; tick < 60; tick++) view.update(seated, 1 / 60, false, interaction('seated', 1), car);
  const ticks = Math.round(VEHICLE_INTERACTION.durations.exit * 60);
  for (let tick = 0; tick <= ticks; tick++) view.update(seated, 1 / 60, false, interaction('exit', tick / ticks), car);
  view.update(base, 1 / 60, false);
  assert.equal(view.actions.get(profile.states.drive)!.getEffectiveWeight(), 0, 'old drive clip does not compete with the finished exit');
  assert.notDeepEqual(hips.position.toArray(), [0, .45, 0], 'no seated crouch flashes on the first on-foot frame');
  for (let t = 0; t < VEHICLE_POSE_RELEASE; t += 1 / 60) view.update(base, 1 / 60, false);
  view.update(base, 1 / 60, false);
  assert.deepEqual(hips.position.toArray(), [0, 1, 0], 'the release fade ends exactly on the mixer pose');
  assert.equal(view.root.visible, true);
  view.dispose();
});
