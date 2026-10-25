import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CharacterFiring } from '../../../apps/game/src/render/character-firing.ts';
import { Effects, MAX_MUZZLE_LIGHTS } from '../../../apps/game/src/render/effects.ts';
import type { Shot } from '../../../packages/sim/src/simulation.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);

function fixture(rain = false) {
  const model = new THREE.Group(), pistol = new THREE.Group(), wrists = [], bones = [];
  for (const [side, sign] of [['R', -1], ['L', 1]] as const) {
    const upper = new THREE.Bone(), lower = new THREE.Bone(), wrist = new THREE.Bone();
    upper.name = `DEF-${rain ? 'Upperarm1' : 'UpperArm_1'}.${side}`;
    lower.name = `DEF-${rain ? 'Forearm1' : 'Forearm_1'}.${side}`;
    wrist.name = `DEF-${rain ? 'Hand' : 'Wrist'}.${side}`;
    upper.position.set(sign * .18, 1.4, 0);
    lower.position.set(sign * .04, -.2, .24); wrist.position.set(-sign * .18, .2, .21);
    model.add(upper); upper.add(lower); lower.add(wrist);
    if (side === 'R') wrist.add(pistol);
    wrists.push(wrist); bones.push(upper, lower, wrist);
  }
  model.rotation.y = .4; model.updateWorldMatrix(true, true);
  return { model, pistol, wrists, bones, firing: new CharacterFiring(model, pistol) };
}

for (const rain of [false, true]) test(`${rain ? 'Rain' : 'Snow'} recoil keeps both grip contacts and returns to the authored pose`, () => {
  const { firing, pistol, wrists, bones } = fixture(rain);
  const base = bones.map(bone => bone.quaternion.clone());
  const grip = wrists[1]!.getWorldPosition(new THREE.Vector3()).sub(wrists[0]!.getWorldPosition(new THREE.Vector3()));
  const gunBefore = pistol.getWorldPosition(new THREE.Vector3());
  firing.notifyShot(); firing.advance(1 / 60, true); firing.apply(1);
  assert.equal(firing.snapshot().pairedArms, true);
  assert.ok(firing.snapshot().wristTargetError < 1e-7);
  assert.ok(pistol.getWorldPosition(new THREE.Vector3()).distanceTo(gunBefore) > .01);
  const barrel = new THREE.Vector3(0, 0, 1).applyQuaternion(pistol.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(barrel.y > .04, 'muzzle rises with the firing wrist');
  const afterGrip = wrists[1]!.getWorldPosition(new THREE.Vector3()).sub(wrists[0]!.getWorldPosition(new THREE.Vector3()));
  assert.ok(Math.abs(grip.length() - afterGrip.length()) < 1e-7, 'support hand stays in contact');
  for (let i = 0; i < 180; i++) {
    firing.restore();
    for (let j = 0; j < bones.length; j++) assert.ok(bones[j]!.quaternion.angleTo(base[j]!) < 1e-7);
    firing.advance(1 / 60, true); firing.apply(1);
  }
  assert.equal(firing.snapshot().recoil, 0);
});

test('shot spring recovery is independent of presentation frame rate and cannot accumulate during holstering', () => {
  const slow = fixture().firing, fast = fixture().firing;
  slow.notifyShot(); fast.notifyShot();
  for (let i = 0; i < 6; i++) slow.advance(1 / 30, true);
  for (let i = 0; i < 24; i++) fast.advance(1 / 120, true);
  assert.ok(Math.abs(slow.snapshot().recoil - fast.snapshot().recoil) < 1e-12);
  slow.advance(0, false); assert.equal(slow.snapshot().recoil, 0);
  const unsupported = new CharacterFiring(new THREE.Group(), new THREE.Group());
  unsupported.notifyShot(); assert.doesNotThrow(() => unsupported.apply(1));
  assert.equal(unsupported.snapshot().pairedArms, false);
});

const shot = (shooter: string): Shot => ({ shooter, origin: [100, 100, 100], end: [0, 1, 10], hit: null } as unknown as Shot);

test('both player and police flashes originate at the rendered barrel, light the nearby face and follow recovery', () => {
  const effects = new Effects();
  let x = 2;
  const resolver = (_: string, p: InstanceType<typeof THREE.Vector3>, d: InstanceType<typeof THREE.Vector3>) => { p.set(x, 1.4, 3); d.set(1, 0, 0); return true; };
  effects.addShots([shot('player'), shot('police-1')], resolver);
  const lights: InstanceType<typeof THREE.PointLight>[] = [];
  effects.group.traverse((node: InstanceType<typeof THREE.Object3D>) => { if ((node as InstanceType<typeof THREE.PointLight>).isPointLight) lights.push(node as InstanceType<typeof THREE.PointLight>); });
  assert.equal(lights.length, MAX_MUZZLE_LIGHTS);
  const active = lights.filter(light => light.intensity > 0);
  assert.equal(active.length, 2);
  const snapshot = effects.snapshot();
  assert.equal(snapshot.activeTracers, 2);
  assert.deepEqual(snapshot.flashes.filter(flash => flash.visible).map(flash => flash.shooter), ['player', 'police-1']);
  snapshot.flashes[0]!.intensity = 0;
  snapshot.flashes[0]!.position[0] = 900;
  assert.equal(effects.snapshot().flashes[0]!.intensity, 1.2, 'review snapshots cannot mutate the calibrated light');
  assert.equal(effects.snapshot().flashes[0]!.position[0], 2);
  for (const light of active) {
    assert.deepEqual(light.getWorldPosition(new THREE.Vector3()).toArray(), [2, 1.4, 3]);
    assert.ok(light.color.r > light.color.b && light.distance > 2 && light.decay === 2);
    assert.equal(light.castShadow, false);
  }
  const tracer = effects.group.children.find((node: InstanceType<typeof THREE.Object3D>) => (node as InstanceType<typeof THREE.Line>).isLine && node.visible) as InstanceType<typeof THREE.Line>;
  assert.deepEqual(Array.from(tracer.geometry.attributes.position!.array as ArrayLike<number>).slice(0, 3).map(n => Math.round(n * 10) / 10), [2, 1.4, 3]);
  x = 2.1; effects.update(.02, resolver);
  assert.ok(active[0]!.intensity > 0 && active[0]!.intensity < 1.2);
  assert.equal(active[0]!.getWorldPosition(new THREE.Vector3()).x, 2.1);
  effects.update(.04, resolver); assert.ok(lights.every(light => light.intensity === 0));
  effects.addShots([shot('police-2')], resolver); effects.update(0, () => false);
  assert.ok(lights.every(light => light.intensity === 0), 'despawned or holstered weapon does not leave its flash behind');
  effects.dispose();
});

test('shot bursts keep fixed resource counts and disposal releases each shared resource once', () => {
  const effects = new Effects(), geometries = new Set<InstanceType<typeof THREE.BufferGeometry>>(), materials = new Set<InstanceType<typeof THREE.Material>>();
  const children = effects.group.children.length;
  effects.group.traverse((node: InstanceType<typeof THREE.Object3D>) => {
    const mesh = node as InstanceType<typeof THREE.Mesh>;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material && !Array.isArray(mesh.material)) materials.add(mesh.material);
  });
  const disposals: number[] = [];
  for (const resource of [...geometries, ...materials]) { const i = disposals.length; disposals.push(0); resource.addEventListener('dispose', () => { disposals[i] = disposals[i]! + 1; }); }
  for (let i = 0; i < 1000; i++) effects.addShots([shot(`police-${i}`)], (_, p, d) => { p.set(0, 1, 0); d.set(0, 0, 1); return true; });
  assert.equal(effects.group.children.length, children);
  effects.reset(); effects.dispose(); effects.dispose();
  assert.ok(disposals.every(count => count === 1)); assert.equal(effects.group.children.length, 0);
});

test('holster cancels only that shooter light and leaves actual ballistic traces and other actors intact', () => {
  const effects = new Effects();
  const resolver = (_: string, p: InstanceType<typeof THREE.Vector3>, d: InstanceType<typeof THREE.Vector3>) => { p.set(0, 1.4, 0); d.set(0, 0, 1); return true; };
  effects.addShots([shot('player'), shot('police-1')], resolver);
  effects.cancelShooter('player');
  effects.update(0, resolver);
  assert.equal(effects.snapshot().activeTracers, 2);
  assert.deepEqual(effects.snapshot().flashes.filter(flash => flash.visible).map(flash => flash.shooter), ['police-1']);
  effects.addShots([shot('player')], resolver);
  assert.equal(effects.snapshot().flashes.filter(flash => flash.visible && flash.shooter === 'player').length, 1);
  effects.dispose();
});
