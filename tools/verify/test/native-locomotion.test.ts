import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { advanceNativeGaitPhase, localTravelDirection, nativeLocomotionWeights, parseCharacterProfile } from '../../../apps/game/src/render/native-locomotion.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const metadata = JSON.parse(readFileSync(new URL('../../../content/assets/finn-locomotion.json', import.meta.url), 'utf8'));
const clipNames = new Set<string>([...metadata.locomotion.map((clip: { clip: string }) => clip.clip), ...Object.values(metadata.states) as string[]]);
const profile = parseCharacterProfile(metadata, clipNames)!;
type State = Parameters<CharacterView['update']>[0];

function fixture() {
  const root = new THREE.Group(), hips = new THREE.Bone(), spine = new THREE.Bone(), leg = new THREE.Bone();
  hips.name = 'DEF-Hips'; spine.name = 'DEF-Spine'; leg.name = 'DEF-Leg';
  root.add(hips); hips.add(spine, leg);
  const clips = new Map<string, InstanceType<typeof THREE.AnimationClip>>();
  for (const [i, movement] of profile.locomotion.entries()) {
    const duration = 1.1 - i * .025;
    clips.set(movement.clip, new THREE.AnimationClip(movement.clip, duration, [
      new THREE.NumberKeyframeTrack('DEF-Leg.position[y]', [0, duration], [i + 1, i + 1]),
      new THREE.NumberKeyframeTrack('DEF-Leg.position[x]', [0, duration / 2, duration], [0, .2, 0]),
      new THREE.NumberKeyframeTrack('DEF-Spine.position[x]', [0, duration], [.1, .1]),
    ]));
  }
  const stateClip = (name: string, seconds: number, node: string, axis: string, end: number) => new THREE.AnimationClip(name, seconds, [new THREE.NumberKeyframeTrack(`${node}.position[${axis}]`, [0, seconds], [end, end])]);
  clips.set('idle', new THREE.AnimationClip('idle', 2, [new THREE.NumberKeyframeTrack('DEF-Leg.position[y]', [0, 2], [0, 0]), new THREE.NumberKeyframeTrack('DEF-Spine.position[x]', [0, 2], [0, 0])]));
  for (const name of ['aim', 'fire']) clips.set(name, new THREE.AnimationClip(name, name === 'fire' ? .25 : 1, [
    new THREE.NumberKeyframeTrack('DEF-Spine.position[x]', [0, 1], [2, 2]),
    // An overlay carrying accidental neutral/lower-body tracks must never replace the moving legs.
    new THREE.NumberKeyframeTrack('DEF-Leg.position[y]', [0, 1], [-100, -100]),
  ]));
  clips.set('hit', stateClip('hit', .5, 'DEF-Hips', 'y', -.2));
  clips.set('death', stateClip('death', 1.4, 'DEF-Hips', 'y', -1));
  clips.set('drive', stateClip('drive', 2, 'DEF-Hips', 'y', .3));
  clips.set('arrested', stateClip('arrested', 2, 'DEF-Spine', 'x', 3));
  const assets = { cloneCharacter: () => ({ root, asset: { id: 'native-fixture', scene: root, clips, height: 1.8, profile } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  return { view: new CharacterView(assets, 'native-fixture', new THREE.MeshBasicMaterial()), clips, hips, spine, leg };
}
function update(view: CharacterView, clip: State['clip'], speed: number, dt: number, position: [number, number, number] = [0, 0, 0], yaw = 0): void {
  view.update({ id: 'fixture', position, yaw, clip, speed, alive: clip !== 'death', health: 100, aiming: clip === 'aim', inVehicle: clip === 'drive' ? 'car' : null,
    grounded: true, verticalSpeed: 0, jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null }, dt, false);
}
const phase = (view: CharacterView) => view.actions.get('walk')!.time / view.actions.get('walk')!.getClip().duration;

test('native profile is explicit, complete and validates actual exported clip names', () => {
  assert.equal(parseCharacterProfile(undefined, clipNames), undefined, 'legacy Rain keeps its existing animation path');
  assert.equal(profile.locomotion.length, 10);
  assert.throws(() => parseCharacterProfile({ ...metadata, phaseGroup: 'unknown' }, clipNames), /Unsupported/);
  assert.throws(() => parseCharacterProfile(metadata, new Set([...clipNames].filter(name => name !== 'death'))), /state death/);
  assert.throws(() => parseCharacterProfile({ ...metadata, locomotion: metadata.locomotion.map((c: object, i: number) => i === 0 ? { ...c, movementSpeed: 0 } : c) }, clipNames), /movement clip/);
});

test('native speed/direction blend remains normalized and uses supplied authored speed anchors', () => {
  for (const direction of [[0, 1], [0, -1], [1, 0], [-1, 0], [.6, -.8]]) for (let speed = 0; speed < 8; speed += .043) {
    const weights = nativeLocomotionWeights(profile, speed, direction[0]!, direction[1]!);
    assert.ok(Object.values(weights).every(w => w >= 0 && w <= 1));
    assert.ok(Math.abs(Object.values(weights).reduce((sum, w) => sum + w, 0) - 1) < 1e-12);
  }
  assert.deepEqual(nativeLocomotionWeights(profile, 0, 1, 0), { idle: 1 });
  assert.equal(nativeLocomotionWeights(profile, 1.233, 0, 1).walk, 1);
  assert.equal(nativeLocomotionWeights(profile, 3.506, 0, 1).run, 1);
  assert.equal(nativeLocomotionWeights(profile, 1.005, 1, 0).strafe_left, 1);
  assert.equal(nativeLocomotionWeights(profile, .933, 0, -1).walk_back, 1);
  const local = localTravelDirection(1, 0, Math.PI / 2);
  assert.ok(Math.abs(local[0]) < 1e-12 && Math.abs(local[1] - 1) < 1e-12, 'world+X is forward at yaw90deg');
});

test('native gait clock uses loaded durations, actual authored speeds and freezes at collision stops', () => {
  const durations = new Map([['walk', 1.1], ['jog', .9]]);
  assert.ok(Math.abs(advanceNativeGaitPhase(0, .1233, 1, profile, { walk: 1 }, durations) - 1 / 11) < 1e-12);
  assert.equal(advanceNativeGaitPhase(.4, 0, 1, profile, { walk: 1 }, durations), .4);
  assert.ok(Math.abs(advanceNativeGaitPhase(0, 2.432, .45, profile, { jog: 1 }, durations) - .5) < 1e-12);
});

test('actual native mixer keeps all source-declared left-strike phases aligned across gaits and stops', () => {
  const { view } = fixture();
  for (const [clip, speed] of [['walk', 1.4], ['run', 3.6], ['sprint', 6]] as const) {
    update(view, clip, speed, .1);
    const reference = phase(view);
    for (const movement of profile.locomotion) {
      const action = view.actions.get(movement.clip)!;
      assert.ok(Math.abs(action.time / action.getClip().duration - reference) < 1e-10);
    }
  }
  const before = phase(view); update(view, 'idle', 0, .3); assert.equal(phase(view), before);
  view.dispose();
});

test('native aim/fire mask overrides upper body while measured sideways travel drives lower legs', () => {
  const { view, leg, spine, clips } = fixture();
  const originalTracks = clips.get('aim')!.tracks.slice();
  update(view, 'idle', 0, 0);
  for (let i = 1; i <= 60; i++) update(view, 'aim', 1.6, 1 / 60, [i * 1.6 / 60, 0, 0]);
  assert.ok(Math.abs(spine.position.x - 2) < 1e-4, 'upper aim pose has full influence');
  assert.ok(leg.position.y > 7 && leg.position.y < 8, 'native left strafe/jog legs keep moving rather than the overlay leg pose');
  update(view, 'fire', 1.6, .05, [1.68, 0, 0]);
  assert.ok(leg.position.y > 7, 'fire overlay does not collapse the lower body');
  assert.deepEqual(clips.get('aim')!.tracks, originalTracks, 'runtime masks never edit supplied native tracks');
  view.dispose();
});

test('native full-body reactions suspend gait, clamp held death and restart on later state entry', () => {
  const { view, hips } = fixture(); update(view, 'run', 3.6, .2); const before = phase(view);
  update(view, 'death', 0, 2); assert.equal(phase(view), before); assert.equal(view.actions.get('death')!.paused, true); assert.ok(Math.abs(hips.position.y + 1) < 1e-8);
  const time = view.actions.get('death')!.time; update(view, 'death', 0, .2); assert.equal(view.actions.get('death')!.time, time);
  update(view, 'idle', 0, .2); update(view, 'death', 0, .01); assert.equal(view.actions.get('death')!.paused, true, 'death is explicitly sampled'); assert.ok(view.actions.get('death')!.time < .1);
  view.dispose();
});
