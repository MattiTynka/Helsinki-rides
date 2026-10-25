// Focused ordinary-build Rain inspection. Player teleports are explicitly labelled fixtures;
// police exit, pursuit, firing and death still run through the real simulation and commands.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Button, NEUTRAL, type CharacterState, type Command, type SimState } from '../../packages/sim/src/index.ts';
import type { WorldManifest } from '../../packages/world-schema/src/index.ts';
import type { CharacterPoseSnapshot } from '../../apps/game/src/render/character-inspection.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  out: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:5317/' },
  release: { type: 'string' }, headful: { type: 'boolean', default: false },
} });
if (!values.out || !values.release || existsSync(values.out)) throw new Error('fresh --out and --release directories are required');
const out = values.out, releaseDir = values.release;
mkdirSync(out, { recursive: true });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = readFileSync(path.join(releaseDir, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
const asset = manifest.assets.find(a => a.id === 'character-rain');
assert.ok(asset, 'release includes Rain');
const bytes = readFileSync(path.join(releaseDir, asset.path));
assert.equal(hash(bytes), asset.sha256);
assert.equal(bytes.length, asset.bytes);
assert.equal(bytes.readUInt32LE(0), 0x46546c67);
const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as {
  nodes: { name?: string }[]; skins: { joints: number[] }[];
  animations: { name: string }[]; meshes: { name: string }[]; materials: { name: string }[];
};
const clips = doc.animations.map(a => a.name), nativeClips = ['idle', 'walk', 'jog', 'run', 'sprint', 'walk_back', 'jog_back', 'strafe_left', 'jog_left', 'strafe_right', 'jog_right'];
assert.equal(doc.skins[0]?.joints.length, 70, 'the supplied seventy-joint Rain skin is present');
for (const clip of [...nativeClips, 'aim', 'fire', 'hit', 'death', 'drive', 'arrested']) assert.ok(clips.includes(clip), `${clip} is in the shipped GLB`);
const sourceIdentity = Object.fromEntries(['apps/game/src/render/characters.ts', 'apps/game/src/render/native-character-animation.ts',
  'apps/game/src/render/native-locomotion.ts', 'apps/game/src/render/character-inspection.ts', 'apps/game/src/game.ts',
  'apps/game/src/testapi.ts', 'tools/verify/verify-rain-native.ts'].map(file => [file, hash(readFileSync(file))]));

const session = await openGame(values.url, { width: 1440, height: 900, headful: values.headful, videoDir: path.join(out, 'video') });
const { page } = session;
type InspectionWindow = Window & { __HELSINKI_GAME__: {
  characterPose(id: string): CharacterPoseSnapshot | null;
  presentation(): { camera: { position: number[] } };
  state(): SimState;
  teleport(x: number, z: number, heading?: number): void;
  setCamera(yaw: number, pitch: number): void;
  step(ticks: number, command: Command): SimState;
} };
interface Frame { label: string; fixture: string | null; state: SimState; pose: CharacterPoseSnapshot; screenshot: string }
const frames: Frame[] = [], observations: { label: string; tick: number; detail: unknown }[] = [];
let officerId = '', unitId = '', failure: string | null = null, bundle: { path: string; sha256: string } | null = null;
const video = page.video();
const officer = (s: SimState): CharacterState => { const c = s.characters.find(c => c.id === officerId); assert.ok(c, 'inspected officer exists'); return c; };
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);
const directionTo = (s: SimState, target: readonly number[], height = 1.2) => {
  const dx = target[0]! - s.player.position[0], dz = target[2]! - s.player.position[2];
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(target[1]! + height - (s.player.position[1] + 1.62), Math.hypot(dx, dz)) };
};
const pose = () => page.evaluate(id => (window as InspectionWindow).__HELSINKI_GAME__.characterPose(id), officerId);
function validate(p: CharacterPoseSnapshot, visible = true): void {
  assert.equal(p.assetId, 'character-rain'); assert.equal(p.profileId, 'rain-native-v1');
  if (visible) assert.equal(p.visible, true, 'the actual on-foot officer mesh is displayed');
  assert.equal(Object.keys(p.bones).length, 70, 'actual loaded Rain skeleton has all seventy joints');
  assert.ok(Object.values(p.bones).flat().every(Number.isFinite));
  assert.ok(Object.values(p.localQuaternions).flat().every(Number.isFinite));
  assert.ok([...p.bounds.min, ...p.bounds.max].every(Number.isFinite));
  assert.ok(p.bounds.max.every((value, axis) => value > p.bounds.min[axis]!), 'posed skin bounds are nonempty');
  assert.ok(p.bounds.max[1]! - p.bounds.min[1]! < 2.25, 'skin does not stretch apart');
  assert.ok(p.meshes.some(mesh => /RAIN-top/i.test(mesh.name)), 'the supplied uniform top is loaded');
  const top = p.materials.find(m => m.name === 'rain_top');
  assert.ok(top?.mapName && top.mapWidth > 0 && top.mapHeight > 0, 'the uniform base-colour texture is decoded and attached');
  const loaded = new Set(p.actions.map(a => a.name));
  for (const clip of [...nativeClips, 'aim', 'fire', 'hit', 'death', 'drive', 'arrested']) assert.ok(loaded.has(clip));
}
async function capture(label: string, s: SimState, fixture: string | null = null): Promise<CharacterPoseSnapshot> {
  const p = await pose(); assert.ok(p); validate(p, officer(s).inVehicle === null);
  const screenshot = `${label}.png`; await page.screenshot({ path: path.join(out, screenshot) });
  frames.push({ label, fixture, state: s, pose: p, screenshot });
  console.log(`${label}: tick ${s.tick}, ${officer(s).clip}, speed ${officer(s).speed.toFixed(2)}, health ${officer(s).health}`);
  return p;
}
async function viewToward(s: SimState, offset = .35): Promise<void> {
  const target = officer(s).position, yaw = Math.atan2(target[0] - s.player.position[0], target[2] - s.player.position[2]);
  // Looking directly through Snow hides the officer behind the player's own mesh.
  await game.setCamera(page, yaw + offset, officer(s).alive ? -.08 : -.28);
}
async function waitFor(label: string, predicate: (s: SimState) => boolean, ticks: number, command = NEUTRAL): Promise<SimState> {
  let s = await game.state(page);
  for (let i = 0; i < ticks && !predicate(s); i++) {
    s = await game.step(page, 1, command);
    assert.equal(s.player.mode, 'onFoot', `${label}: the fixture player remains available`);
  }
  assert.ok(predicate(s), `${label}: timed out at tick ${s.tick}, ${officer(s).clip}, health ${s.player.health}`);
  return s;
}
async function uniformSide(label: string, side: 1 | -1, s: SimState): Promise<SimState> {
  const c = officer(s), forward = [Math.sin(c.yaw), Math.cos(c.yaw)];
  // The teleport fixture projects onto the road centre. A little more rear
  // distance keeps that lateral correction from turning the back view side-on.
  const standOff = side < 0 ? 3 : 1.5;
  // Keep teleport, actual road-snapped position, and camera setup in one task so
  // a paused RAF cannot initialise the chase camera between these operations.
  const framed = await page.evaluate(async ({ x, z, target, alive, neutral }) => {
    const api = (window as InspectionWindow).__HELSINKI_GAME__;
    // Both resolve without leaving this task when the destination's collision cells are already loaded.
    await api.teleport(x, z);
    const actual = api.state().player.position;
    api.setCamera(Math.atan2(target[0]! - actual[0], target[2]! - actual[2]) + .6, alive ? -.08 : -.28);
    const state = await api.step(0, neutral);
    return { state, camera: api.presentation().camera.position };
  }, { x: c.position[0] + forward[0]! * side * standOff, z: c.position[2] + forward[1]! * side * standOff,
    target: c.position, alive: c.alive, neutral: NEUTRAL });
  s = framed.state;
  const camera = framed.camera;
  const projected = ((camera[0]! - c.position[0]) * forward[0]! + (camera[2]! - c.position[2]) * forward[1]!) * side;
  assert.ok(projected > .5, `${label}: camera is on the requested side of the frozen officer`);
  const p = await capture(label, s, 'Player relocated on the road with simulation paused; officer rig/clip unchanged.');
  assert.ok(Math.abs(p.screen.centre[0]!) < 1 && Math.abs(p.screen.centre[1]!) < 1 && p.screen.centre[2]! < 1, 'uniform is inside the camera frame');
  return s;
}

try {
  assert.equal(await game.release(page), manifest.worldReleaseId);
  const script = await page.locator('script[type="module"]').getAttribute('src');
  assert.ok(typeof script === 'string' && script.startsWith('/assets/index-'), 'verify the compiled game');
  const response = await page.request.get(new URL(script, values.url).href); assert.ok(response.ok());
  const served = await response.body(); assert.deepEqual(served, readFileSync(`apps/game/dist${script}`));
  bundle = { path: script, sha256: hash(served) };
  await game.start(page); await game.pause(page);
  let s = await game.step(page, 20, NEUTRAL);
  const unit = s.police[0]; assert.ok(unit);
  officerId = unit.officerId; unitId = unit.id;
  const initialPose = await pose(); assert.ok(initialPose); validate(initialPose, false);
  observations.push({ label: 'initial-patrol-asset', tick: s.tick, detail: initialPose });
  const car = s.vehicles.find(v => v.id === unit.vehicleId); assert.ok(car);

  // Fixture proximity only: ordinary sky fire raises wanted, police AI leaves its car.
  await game.teleport(page, car.position[0] + 8, car.position[2] + 8);
  s = await game.step(page, 25, NEUTRAL);
  s = await game.step(page, 1, { ...NEUTRAL, buttons: Button.fire, yaw: 0, pitch: 1.1 });
  s = await waitFor('police exit', state => officer(state).inVehicle === null, 600);
  await viewToward(s);
  await capture('01-natural-officer-exit', s, 'Player placed near initial patrol; sky shot triggers normal wanted/AI response.');

  // Move the player along the road, then let actual AI chase animate the officer.
  const start = officer(s).position;
  await game.teleport(page, start[0], start[2] + 14);
  s = await game.step(page, 1, NEUTRAL);
  s = await waitFor('native pursuit gait', state => officer(state).speed > 1 && ['walk', 'run', 'sprint'].includes(officer(state).clip), 240);
  const moving: CharacterPoseSnapshot[] = [];
  for (let i = 0; i < 8; i++) {
    await viewToward(s); s = await game.step(page, 4, NEUTRAL);
    moving.push(await capture(`movement-${String(i).padStart(2, '0')}`, s, 'Player proximity fixture; police velocity and gait are AI-driven.'));
  }
  assert.ok(distance(start, officer(s).position) > .4, 'the officer actually pursued the player');
  const legKeys = Object.keys(moving[0]!.localQuaternions).filter(name => /Thigh|Knee/.test(name));
  assert.ok(legKeys.some(name => moving.some(p => p.localQuaternions[name]!.some((v, axis) => Math.abs(v - moving[0]!.localQuaternions[name]![axis]!) > .02))), 'native gait changes the displayed thigh/knee poses');
  assert.ok(moving.some(p => p.actions.some(a => a.weight > .1 && ['walk', 'jog', 'run', 'sprint'].includes(a.name))), 'native locomotion actions have visible weight');

  // Give pursuit room to clear the patrol before inspecting the rear uniform: its
  // roof otherwise hides the lettering even when the character projects on-screen.
  const pursuitStart = officer(s).position;
  await game.teleport(page, pursuitStart[0], pursuitStart[2] + 18);
  s = await waitFor('officer clears patrol for inspection', state => distance(car.position, officer(state).position) > 11, 240);
  const closeStart = officer(s).position;
  await game.teleport(page, closeStart[0], closeStart[2] + 6);
  s = await game.state(page);
  for (let i = 0; i < 6; i++) {
    await viewToward(s, .6); s = await game.step(page, 3, NEUTRAL);
    await capture(`movement-close-${String(i).padStart(2, '0')}`, s, 'Player proximity fixture after ordinary police pursuit away from patrol; no officer mutation.');
  }
  s = await uniformSide('uniform-front', 1, s);
  s = await uniformSide('uniform-back-poliisi', -1, s);

  // A body shot through the regular weapon path raises police aggression without killing Rain.
  const target = officer(s).position;
  await game.teleport(page, target[0], target[2] + 12);
  s = await game.step(page, 3, NEUTRAL);
  const aim = directionTo(s, officer(s).position, 1.1);
  s = await game.step(page, 1, { ...NEUTRAL, ...aim, buttons: Button.fire | Button.aim });
  assert.ok(officer(s).alive, 'the combat inspection target survives the warning body shot');
  const armed = { ...NEUTRAL, buttons: Button.aim, yaw: aim.yaw, pitch: .8 };
  s = await waitFor('officer aims', state => officer(state).clip === 'aim' && officer(state).speed < .2, 240, armed);
  await viewToward(s); s = await game.step(page, 1, armed);
  const aimed = await capture('combat-aim', s, 'Police aggression caused by a normal player body shot.');
  assert.ok(aimed.pistol?.visible && aimed.pistol.socketName === 'SOCKET_HAND_R', 'pistol is attached to the native right-hand socket');
  s = await waitFor('officer fires', state => state.events.some(e => e.type === 'policeFire' && e.detail === unitId), 120, armed);
  await viewToward(s);
  const firing = await capture('combat-fire', s);
  const shot = s.shots.find(shot => shot.shooter === officerId); assert.ok(shot, 'fire frame contains the officer simulated shot');
  assert.ok(firing.pistol?.visible);
  const toPlayer = [s.player.position[0] - firing.pistol.position[0]!, s.player.position[1] + 1.2 - firing.pistol.position[1]!, s.player.position[2] - firing.pistol.position[2]!];
  const len = Math.hypot(...toPlayer), dot = toPlayer.reduce((sum, v, i) => sum + v / len * firing.pistol!.direction[i]!, 0);
  const errorDegrees = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  observations.push({ label: 'pistol-direction', tick: s.tick, detail: { errorDegrees, shot } });
  assert.ok(errorDegrees < 12, `native pistol visibly aims toward its simulated target (${errorDegrees.toFixed(2)} degrees)`);

  // Finish through ordinary weapon damage; sample the actual non-looping death clip.
  for (let i = 0; i < 12 && officer(s).alive; i++) {
    const heading = directionTo(s, officer(s).position, 1.68);
    s = await game.step(page, 1, { ...NEUTRAL, ...heading, buttons: Button.fire | Button.aim });
    if (officer(s).alive) s = await game.step(page, 11, { ...NEUTRAL, ...heading, buttons: Button.aim });
  }
  assert.equal(officer(s).alive, false, 'officer dies from normal hit resolution');
  for (const [label, ticks] of [['death-start', 1], ['death-falling', 35], ['death-settled', 70]] as const) {
    await viewToward(s); s = await game.step(page, ticks, NEUTRAL); await capture(label, s);
  }
  s = await uniformSide('death-ground-close', 1, s);
  const dead = frames.at(-1)!.pose;
  assert.ok(dead.bounds.max[1]! - dead.bounds.min[1]! < .8, 'death finishes on the ground instead of a standing bind pose');
  assert.ok(dead.actions.some(a => a.name === 'death' && a.weight > .9), 'the real death action owns the final pose');
  assert.deepEqual(session.consoleErrors, []);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ failure, state: await game.state(page).catch(() => null), pose: await pose().catch(() => null) }, null, 2));
} finally {
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', failure,
    scope: 'Fixture player teleports plus ordinary police AI, weapons and death. No NPC/bone/mixer mutation. Full gameplay journey is separate.',
    release: manifest.worldReleaseId, manifestSha256: hash(manifestBytes), bundle, sourceIdentity,
    asset: { id: asset.id, sha256: asset.sha256, bytes: asset.bytes, joints: doc.skins[0]?.joints.length, clips, meshNames: doc.meshes.map(m => m.name), materialNames: doc.materials.map(m => m.name) },
    frames, observations, events: await game.events(page, 0).catch(() => []), consoleErrors: session.consoleErrors, visualReview: 'CAPTURED_NOT_REVIEWED',
  }, null, 2));
  writeFileSync(path.join(out, 'console.log'), session.consoleLines.join('\n'));
  await session.close();
  if (video) writeFileSync(path.join(out, 'video-path.txt'), await video.path());
  console.log(`${failure ? 'FAIL' : 'PASS'}: ${out}`);
  if (failure) process.exitCode = 1;
}
