import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { decodeCommand, encodeCommand, GROUP, groups, initPhysics, NEUTRAL, RAPIER, Rng, type StaticWorld, type V3, type WeaponDefinition } from '../src/index.ts';
import { resolveAimDirection } from '../src/aim.ts';
import { fireRay } from '../src/weapons.ts';

before(async () => { await initPhysics(); });
const weapon: WeaponDefinition = { id: 'test', label: 'test', damage: 1, headshotMultiplier: 1, rangeMeters: 120, spreadDeg: 0, recoilDeg: 0, roundsPerMinute: 360, magazine: 12, reloadSeconds: 1, automatic: false };
const eye: V3 = [0, 1.62, 0];
function fixture() {
  const physics = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const world = { physics } as StaticWorld;
  const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number) => physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setCollisionGroups(groups(GROUP.static, GROUP.bullet)));
  return { world, physics, box };
}

test('camera rays round-trip through commands while existing five-field recordings remain unchanged', () => {
  assert.deepEqual(encodeCommand(NEUTRAL), [0, 0, 0, 0, 0]);
  assert.deepEqual(decodeCommand([0, 0, 0, 0, 0]), NEUTRAL);
  const command = { ...NEUTRAL, aimRay: { origin: [-.5504, 1.5504, -1.9004] as V3, direction: [.0000004, 0, 1] as V3 } };
  const encoded = encodeCommand(command);
  assert.deepEqual(encoded[5], [-550, 1550, -1900, 0, 0, 1000000]);
  assert.deepEqual(encodeCommand(decodeCommand(encoded)), encoded);
});

test('shoulder reticle and zero-spread shot converge on close and distant walls at varied pitch', () => {
  for (const distance of [3, 10, 80]) for (const pitch of [-.15, 0, .2]) {
    const { world, physics, box } = fixture();
    box(0, 5, distance, 20, 20, .1); physics.step();
    const ray = { origin: [-.55, 1.55, -1.9] as V3, direction: [0, Math.sin(pitch), Math.cos(pitch)] as V3 };
    const dir = resolveAimDirection(world, eye, [0, 0, 1], ray, 120);
    const shot = fireRay(world, new Rng(1), eye, dir, weapon, undefined, () => false);
    const rayDistance = (distance - .1 - ray.origin[2]) / ray.direction[2];
    const target = ray.origin.map((value, i) => value + ray.direction[i]! * rayDistance);
    assert.ok(Math.hypot(...shot.end.map((value, i) => value - target[i]!)) < .0001, `wall ${distance}, pitch ${pitch}: ${shot.end} vs ${target}`);
    physics.free();
  }
});

test('the weapon ray still hits cover that the offset camera can see past', () => {
  const { world, physics, box } = fixture();
  box(0, 2, 10, 3, 3, .1);
  const cover = box(-.02, 1.62, .4, .15, .5, .1);
  physics.step();
  const dir = resolveAimDirection(world, eye, [0, 0, 1], { origin: [-.55, 1.55, -1.9], direction: [0, 0, 1] }, 120);
  const shot = fireRay(world, new Rng(1), eye, dir, weapon, undefined, () => false);
  assert.equal(shot.colliderHandle, cover.handle);
  assert.ok(shot.distance < .5, 'reticle does not allow firing through the nearby wall');
  physics.free();
});

test('invalid remote/nonfinite rays fall back, and camera-side obstructions cannot reverse the gun', () => {
  const { world, physics, box } = fixture(), fallback: V3 = [0, 0, 1];
  for (const origin of [[100, 1, 0], [NaN, 1, 0]] as V3[]) assert.deepEqual(resolveAimDirection(world, eye, fallback, { origin, direction: [0, 0, 1] }, 120), fallback);
  assert.deepEqual(resolveAimDirection(world, eye, fallback, { origin: [0, 1.6, -2], direction: [0, 0, 0] }, 120), fallback);
  box(-.55, 1.55, -1, .2, .3, .1); physics.step();
  assert.deepEqual(resolveAimDirection(world, eye, fallback, { origin: [-.55, 1.55, -1.9], direction: [0, 0, 1] }, 120), [0, 0, 1]);
  physics.free();
});
