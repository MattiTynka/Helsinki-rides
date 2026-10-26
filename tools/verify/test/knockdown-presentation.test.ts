import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { knockdownProgress } from '../../../apps/game/src/render/knockdown-presentation.ts';
import { JUMP_POSES } from '../../../apps/game/src/render/native-jump-animation.ts';
import type { CharacterState } from '../../../packages/sim/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const timing = { fallSeconds: 1.4, holdSeconds: .6, riseSeconds: 1.6 };

test('knockdown has continuous collapse, floor hold and recovery, and never recovers a dead actor', () => {
  for (const [elapsed, progress] of [[0, 0], [.7, .5], [1.4, 1], [1.8, 1], [2, 1], [2.8, .5], [3.6, 0]]) {
    assert.ok(Math.abs(knockdownProgress({ ...timing, elapsed: elapsed! }, true)! - progress!) < 1e-12);
  }
  assert.equal(knockdownProgress({ ...timing, elapsed: 3 }, false), null);
  assert.equal(knockdownProgress(null, true), null);
  assert.equal(knockdownProgress({ ...timing, elapsed: NaN }, true), null);
});

test('legacy civilian collapse samples forward then backward without restarting the action each frame', () => {
  const model = new THREE.Group(), hips = new THREE.Bone(); hips.name = 'hips'; model.add(hips);
  const idle = new THREE.AnimationClip('idle', 1, [new THREE.NumberKeyframeTrack('hips.position[y]', [0, 1], [1, 1])]);
  const death = new THREE.AnimationClip('death', 1.4, [new THREE.NumberKeyframeTrack('hips.position[y]', [0, 1.4], [1, 0])]);
  const clips = new Map([['idle', idle], ['death', death]]);
  const assets = { cloneCharacter: () => ({ root: model, asset: { id: 'civilian', scene: model, clips, height: 1.7 } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  const view = new CharacterView(assets, 'civilian', new THREE.MeshBasicMaterial());
  const state = { id: 'civilian', position: [0, 0, 0], yaw: 0, clip: 'death', speed: 0, alive: true, health: 100, aiming: false, inVehicle: null, grounded: true, verticalSpeed: 0, jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null } as CharacterState;
  for (const elapsed of [.7, 1.4, 1.8, 2.8, 3.6]) {
    view.update({ ...state, knockdown: { ...timing, elapsed } }, 1 / 60, false);
    assert.ok(Math.abs(hips.position.y - (1 - knockdownProgress({ ...timing, elapsed }, true)!)) < 1e-6);
    assert.equal(view.actions.get('death')!.getEffectiveWeight(), 1);
    assert.equal(view.actions.get('death')!.paused, true);
  }
  view.update({ ...state, clip: 'idle' }, 1 / 60, false);
  assert.equal(view.actions.get('death')!.paused, false);
  assert.ok(hips.position.y > .99, 'standing recovery transitions back into ordinary idle');
  view.dispose();
});

test('a surviving collapse takes the whole skeleton from a civilian\'s jump poses and grip, and hands the jump back after recovery', () => {
  const model = new THREE.Group();
  const bone = (name: string, parent: { add(child: unknown): unknown }, y: number, x = 0) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, 0); parent.add(b); return b; };
  const hips = bone('hips', model, 1), chest = bone('Spine2', hips, .5);
  for (const [side, x] of [['Left', .2], ['Right', -.2]] as const) bone(`${side}Hand`, bone(`${side}ForeArm`, bone(`${side}Arm`, chest, .3, x), -.28), -.25);
  const level = (name: string, seconds: number, values: number[]) => new THREE.AnimationClip(name, seconds, [new THREE.NumberKeyframeTrack('hips.position[y]', [0, seconds], values)]);
  // Carried jump and climb poses hold the hips up where the collapse lowers them.
  const jumps = Object.keys(JUMP_POSES.clips).filter(key => !key.startsWith('super_')).map(key => level(key, 1, [1, 1]));
  const clips = new Map([level('idle', 1, [1, 1]), level('death', 1.4, [1, 0]), ...jumps].map(clip => [clip.name, clip]));
  const assets = { cloneCharacter: () => ({ root: model, asset: { id: 'civilian', scene: model, clips, height: 1.7 } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  const view = new CharacterView(assets, 'civilian', new THREE.MeshBasicMaterial());
  // The jump layer's actions live on the shared mixer only.
  const jumpWeight = () => (view.mixer as unknown as { _actions: { getClip(): { name: string }; getEffectiveWeight(): number }[] })._actions
    .filter(action => action.getClip().name.startsWith('__jump_')).reduce((sum, action) => sum + action.getEffectiveWeight(), 0);
  const arms = ['Left', 'Right'].flatMap(side => ['Arm', 'ForeArm', 'Hand'].map(part => model.getObjectByName(`${side}${part}`)!));
  const rest = arms.map(arm => arm.quaternion.clone());
  const gripped = () => Math.max(...arms.map((arm, i) => arm.quaternion.angleTo(rest[i]!)));
  const state = { id: 'civilian', position: [0, 0, 0], yaw: 0, clip: 'idle', speed: 0, alive: true, health: 100, aiming: false, inVehicle: null, grounded: true, verticalSpeed: 0, jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null } as CharacterState;
  const climbing = { ...state, grounded: false, jumpPhase: 'climb', jumpKind: 'normal', climb: { height: 1.2, duration: 1.1, edge: [0, 1.2, .5], normal: [0, -1] } } as CharacterState;
  for (let i = 0; i < 30; i++) view.update({ ...climbing, jumpPhaseTime: i / 60 }, 1 / 60, false);
  assert.ok(jumpWeight() > .9, `the climb holds the skeleton: ${jumpWeight()}`);
  assert.ok(gripped() > .01, `the grip pins the hands to the edge: ${gripped()}`);
  const falling = { ...state, clip: 'death', grounded: false, jumpPhase: 'fall', jumpKind: null, verticalSpeed: -2, groundDistance: .5 } as CharacterState;
  // Knocked down still holding the edge, then falling: hips at 0.55 when the collapse is sampled at 0.63 s, not 0.775.
  for (const [frame, elapsed] of [.63, .7, 1.4, 2.8, 3.6].entries()) {
    view.update({ ...(frame ? falling : { ...climbing, clip: 'death', jumpPhaseTime: .5 }), knockdown: { ...timing, elapsed } }, 1 / 60, false);
    assert.equal(jumpWeight(), 0, `${elapsed}: no jump pose under the collapse`);
    assert.ok(Math.abs(hips.position.y - (1 - knockdownProgress({ ...timing, elapsed }, true)!)) < 1e-6, `${elapsed}: the sampled collapse alone: ${hips.position.y}`);
    assert.ok(gripped() < 1e-6, `${elapsed}: no grip correction: ${gripped()}`);
  }
  view.update(state, 1 / 60, false);
  assert.equal(jumpWeight(), 0, 'nothing stale after getting up');
  assert.ok(hips.position.y > .99, 'standing again');
  for (let i = 0; i < 24; i++) view.update({ ...state, grounded: false, jumpPhase: 'rise', jumpPhaseTime: i / 60, jumpKind: 'normal', verticalSpeed: 4 - i * .16, groundDistance: .1 + i * .03 }, 1 / 60, false);
  assert.ok(jumpWeight() > .9, `a later jump is posed again: ${jumpWeight()}`);
  view.dispose();
});
