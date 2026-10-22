import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { advanceGaitPhase, locomotionWeights, MOVEMENT_CLIPS } from '../../../apps/game/src/render/locomotion.ts';

// Resolve the game's pinned Three.js dependency without adding a second runtime dependency to the tools.
const threeEntry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(threeEntry)).href);
const durations = { walk: 1, run: 0.7, sprint: 0.6 };
type State = Parameters<CharacterView['update']>[0];

function createView(): CharacterView {
  const root = new THREE.Group();
  const clips = new Map(Object.entries({ idle: 2, ...durations, aim: 1, fire: 0.25, hit: 0.5, death: 1.4, drive: 2, arrested: 2 })
    .map(([name, duration]) => [name, new THREE.AnimationClip(name, duration, [
      new THREE.NumberKeyframeTrack('.position[x]', [0, duration / 2, duration], [0, 0.1, 0]),
    ])]));
  const assets = {
    cloneCharacter: () => ({ root, asset: { id: 'fixture', scene: root, clips, height: 1.8 } }),
    clonePistol: () => null,
  } as unknown as ConstructorParameters<typeof CharacterView>[0];
  return new CharacterView(assets, 'fixture', new THREE.MeshBasicMaterial());
}

function update(view: CharacterView, clip: State['clip'], speed: number, dt: number, inVehicle: string | null = null): void {
  view.update({ id: 'fixture', position: [0, 0, 0], yaw: 0, clip, speed, alive: clip !== 'death', health: 100, aiming: clip === 'aim', inVehicle,
    grounded: true, verticalSpeed: 0, jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null }, dt, false);
}

function phase(view: CharacterView): number {
  return view.actions.get('walk')!.time / view.actions.get('walk')!.getClip().duration;
}

function assertSynchronized(view: CharacterView): void {
  const reference = phase(view);
  for (const name of MOVEMENT_CLIPS) {
    const action = view.actions.get(name)!;
    assert.ok(Math.abs(action.time / action.getClip().duration - reference) < 1e-10, `${name} lost foot phase`);
  }
  assert.ok(Math.abs([...view.actions.values()].reduce((sum, action) => sum + action.getEffectiveWeight(), 0) - 1) < 1e-10);
}

test('actual speed continuously selects a normalized adjacent-gait blend across simulation thresholds', () => {
  for (let speed = 0; speed < 8; speed += 0.013) {
    const weights = locomotionWeights(speed);
    assert.ok(Object.values(weights).every(weight => weight >= 0 && weight <= 1));
    assert.ok(Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
    assert.ok(Object.values(weights).filter(weight => weight > 0).length <= 2);
  }
  for (const threshold of [0.03, 0.35, 1.4, 2.4, 3.6, 4.8, 6]) {
    const below = locomotionWeights(threshold - 1e-6);
    const above = locomotionWeights(threshold + 1e-6);
    for (const name of ['idle', ...MOVEMENT_CLIPS] as const) assert.ok(Math.abs(below[name] - above[name]) < 1e-5);
  }
  assert.deepEqual(locomotionWeights(0), { idle: 1, walk: 0, run: 0, sprint: 0 });
});

test('gait clock covers authored stride distance and immediately follows collision slowdowns', () => {
  const walking = { walk: 1, run: 0, sprint: 0 };
  assert.equal(advanceGaitPhase(0.2, 0, 1, walking, durations), 0.2);
  assert.ok(Math.abs(advanceGaitPhase(0, 0.14, 1, walking, durations) - 0.1) < 1e-12, 'slow walking must not inherit a minimum playback speed');
  assert.ok(Math.abs(advanceGaitPhase(0, 3.6, 0.35, { walk: 0, run: 1, sprint: 0 }, durations) - 0.5) < 1e-12);
  assert.ok(Math.abs(advanceGaitPhase(0, 1.4, 1, walking, { walk: 2 }) - 0.5) < 1e-12, 'clock must use the loaded export duration');
});

test('walk/run/sprint changes preserve the current foot phase in the actual Three mixer', () => {
  const view = createView();
  update(view, 'walk', 1.4, 0.4);
  const before = phase(view);
  assert.ok(before > 0.2);
  update(view, 'run', 3.6, 0);
  assert.equal(phase(view), before);
  assertSynchronized(view);
  for (const [clip, speed] of [['run', 3.6], ['sprint', 6], ['walk', 1.4]] as const) {
    update(view, clip, speed, 1 / 60);
    assertSynchronized(view);
  }
  view.dispose();
});

test('release or a blocked capsule freezes the feet while the pose settles to idle', () => {
  const view = createView();
  update(view, 'run', 3.6, 0.3);
  const before = phase(view);
  for (let frame = 0; frame < 30; frame++) {
    update(view, 'idle', 0, 1 / 60);
    assert.equal(phase(view), before);
    assertSynchronized(view);
  }
  assert.ok(view.actions.get('idle')!.getEffectiveWeight() > 0.999);
  view.dispose();
});

test('full-body states suspend locomotion and held death/one-shots do not restart every update', () => {
  const view = createView();
  update(view, 'sprint', 6, 0.2);
  const before = phase(view);
  for (const clip of ['aim', 'fire', 'hit', 'drive', 'arrested', 'death'] as const) {
    update(view, clip, 6, 0.8, clip === 'drive' ? 'car' : null);
    assert.equal(phase(view), before);
    assert.ok(view.actions.get(clip)!.getEffectiveWeight() > 0.999);
    assertSynchronized(view);
  }
  update(view, 'death', 0, 2);
  const death = view.actions.get('death')!;
  assert.equal(death.time, death.getClip().duration);
  assert.equal(death.paused, true);
  update(view, 'death', 0, 0.1);
  assert.equal(death.time, death.getClip().duration);
  update(view, 'idle', 0, 0.2);
  update(view, 'death', 0, 0.01);
  assert.ok(death.time < 0.1, 'a new death after recovery must restart');
  assert.equal(death.paused, true, 'terminal collapse uses an explicit pose sample');
  update(view, 'hit', 0, 0.8);
  assert.equal(view.actions.get('hit')!.paused, true);
  update(view, 'idle', 0, 0.2);
  update(view, 'hit', 0, 0.01);
  assert.equal(view.actions.get('hit')!.paused, false);
  assert.ok(view.actions.get('hit')!.time < 0.1, 're-entering an interrupted reaction must restart');
  view.dispose();
});
