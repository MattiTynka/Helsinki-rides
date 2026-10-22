// Native-city combat review. Only normal commands/F-key entry change gameplay; player relocation is labelled.
// Captured muzzle lights come from real shots. No NPC, mixer, weapon, light or health mutation is available here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Button, NEUTRAL, yawOf, type Command, type SimState } from '../../packages/sim/src/index.ts';
import type { WorldManifest } from '../../packages/world-schema/src/index.ts';
import type { HelsinkiTestApi } from '../../apps/game/src/testapi.ts';
import type { CharacterPoseSnapshot } from '../../apps/game/src/render/character-inspection.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, out: { type: 'string' }, release: { type: 'string' },
  district: { type: 'string', default: 'Esplanadi' }, headful: { type: 'boolean', default: false },
} });
if (!values.url || !values.out || !values.release || existsSync(values.out)) throw Error('--url, --release and a fresh --out are required');
const url = new URL(values.url), out = values.out;
if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw Error('A loopback review build is required');
mkdirSync(out, { recursive: true });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = readFileSync(path.join(values.release, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
const assets = ['character-snow', 'character-rain', 'prop-pistol'].map(id => {
  const asset = manifest.assets.find(a => a.id === id); assert.ok(asset, `${id} exists in the selected world`);
  const bytes = readFileSync(path.join(values.release!, asset.path));
  assert.equal(bytes.length, asset.bytes); assert.equal(hash(bytes), asset.sha256);
  return { id, path: asset.path, bytes: asset.bytes, sha256: asset.sha256 };
});
const sourceIdentity = Object.fromEntries(['apps/game/src/game.ts', 'apps/game/src/render/characters.ts',
  'apps/game/src/render/character-firing.ts', 'apps/game/src/render/native-character-animation.ts',
  'apps/game/src/render/effects.ts', 'apps/game/src/testapi.ts', 'packages/sim/src/police.ts',
  'packages/sim/src/wanted.ts', 'tools/verify/verify-police-combat.ts'].map(file => [file, hash(readFileSync(new URL(`../../${file}`, import.meta.url)))]));
type ReviewWindow = Window & { __HELSINKI_GAME__: HelsinkiTestApi };
const session = await openGame(url.href, { width: 1600, height: 1000, timeoutMs: 300000, headful: values.headful });
const { page } = session, frames: object[] = [], observations: object[] = [], runtimeAssets: object[] = [];
let officerId = '', firstPlayerShotTick: number | null = null, failure: string | null = null;
let bundle: { path: string; bytes: number; sha256: string } | null = null;
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);
const officer = (s: SimState) => { const c = s.characters.find(c => c.id === officerId); assert.ok(c, `Officer ${officerId} exists`); return c; };
const effects = () => page.evaluate(() => (window as ReviewWindow).__HELSINKI_GAME__.shootingEffects());
const pose = (id = officerId) => page.evaluate(id => (window as ReviewWindow).__HELSINKI_GAME__.characterPose(id), id);
function assertNoFirstFire(s: SimState): void {
  assert.equal(s.wanted.playerHasFired, false, 'the player has never discharged a weapon');
  assert.equal(s.events.some(e => e.type === 'policeFire'), false, 'police cannot fire before the player');
  assert.equal(s.shots.length, 0, 'there are no fabricated or unsolicited shots');
}
async function capture(label: string, s: SimState, fixture: string | null = null, id = officerId): Promise<CharacterPoseSnapshot | null> {
  const p = id ? await pose(id) : null, shootingEffects = await effects(), screenshot = `${label}.png`;
  await page.screenshot({ path: path.join(out, screenshot) });
  frames.push({ label, fixture, state: s, pose: p, shootingEffects, screenshot });
  console.log(`${label}: tick ${s.tick}; ${id ? s.characters.find(c => c.id === id)?.clip ?? s.player.clip : s.player.mode}`);
  return p;
}
async function waitFor(label: string, predicate: (s: SimState) => boolean, limit: number, command: Partial<Command> = NEUTRAL, beforeFirstShot = true): Promise<SimState> {
  let s = await game.state(page);
  for (let i = 0; i < limit && !predicate(s); i++) {
    s = await game.step(page, 1, command);
    if (beforeFirstShot) assertNoFirstFire(s);
    assert.ok(s.player.health > 0 && s.player.mode !== 'busted', `${label}: the player remains available`);
  }
  assert.ok(predicate(s), `${label}: timed out at tick ${s.tick}`);
  return s;
}
async function viewToward(s: SimState): Promise<void> {
  const c = officer(s), p = s.player.position;
  await game.setCamera(page, Math.atan2(c.position[0] - p[0], c.position[2] - p[2]) + .4, -.08);
  await game.step(page, 0);
}
function assertFiringPose(p: CharacterPoseSnapshot | null): asserts p is CharacterPoseSnapshot {
  assert.ok(p?.visible && p.pistol?.visible, 'actual native officer and hand-mounted pistol are visible');
  assert.equal(p.assetId, 'character-rain'); assert.equal(p.profileId, 'rain-native-v1');
  assert.equal(p.pistol.socketName, 'SOCKET_HAND_R');
  assert.ok(p.shooting?.pairedArms && p.shooting.recoil > 0, 'actual shot drives paired-arm recoil');
  assert.ok(p.shooting.wristTargetError < .002, 'both wrists maintain their authored grip contacts');
}

try {
  assert.equal(await game.release(page), manifest.worldReleaseId);
  const script = await page.locator('script[type="module"]').getAttribute('src');
  assert.ok(typeof script === 'string' && script.startsWith('/Helsinki-rides/assets/index-'), 'compiled Pages-base review bundle required');
  const response = await page.request.get(new URL(script, url).href); assert.equal(response.status(), 200);
  const served = await response.body(); bundle = { path: script, bytes: served.length, sha256: hash(served) };
  const manifestRequest = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname.endsWith('/manifest.json')));
  assert.ok(manifestRequest && new URL(manifestRequest).origin === url.origin, 'world manifest was requested from the review server');
  const servedManifest = await page.request.get(manifestRequest); assert.equal(servedManifest.status(), 200);
  assert.equal(hash(await servedManifest.body()), hash(manifestBytes), 'runtime requested the exact selected manifest bytes');
  await game.start(page); await game.pause(page);
  await game.dropIn(page, values.district);
  let s = await game.step(page, 600, NEUTRAL);
  assertNoFirstFire(s); assert.equal(s.wanted.stars, 0);
  const patrolPositions = s.police.map(u => s.vehicles.find(v => v.id === u.vehicleId)?.position).filter(p => !!p);
  const cars = s.vehicles.filter(v => v.id.startsWith('city-car-') && distance(v.position, s.player.position) < 180)
    .sort((a, b) => Math.min(...patrolPositions.map(p => distance(b.position, p))) - Math.min(...patrolPositions.map(p => distance(a.position, p))));
  const car = cars[0]; assert.ok(car, 'district has a generated civilian car');
  const yaw = yawOf(car.rotation), sin = Math.sin(yaw), cos = Math.cos(yaw);
  await game.teleport(page, car.position[0] + 2.1 * cos - .95 * sin, car.position[2] - .95 * cos - 2.1 * sin, 180 - yaw * 180 / Math.PI);
  s = await game.step(page, 30, NEUTRAL);
  assert.equal(s.player.nearVehicle, car.id, 'generated civilian car is reachable at its door');
  await game.setCommand(page, null); await page.keyboard.press('KeyF');
  s = await game.step(page, 1);
  for (let i = 0; i < 1200 && s.player.mode === 'entering'; i++) { s = await game.step(page, 1); assertNoFirstFire(s); }
  assert.equal(s.player.mode, 'driving', 'a real F press completes the door/seat animation');
  assert.equal(s.player.inVehicle, car.id);
  const completedTheftTick = s.tick;
  assert.equal(s.wanted.stars, 0, 'chosen first theft is not immediately observed by police');
  s = await waitFor('delayed first-theft report', state => state.wanted.stars > 0, 360);
  const report = (await game.events(page, completedTheftTick)).find(e => e.type === 'crime' && e.detail === 'takeCar');
  assert.ok(report, 'wanted originates from the completed theft');
  const reportSeconds = (report.tick - completedTheftTick) / 60;
  assert.ok(reportSeconds >= 3 && reportSeconds <= 6, `first theft report takes 3–6 seconds (${reportSeconds})`);
  observations.push({ label: 'completed-first-theft', fixture: 'Player drop-in and door proximity only; real F-key interaction.',
    district: values.district, carId: car.id, completedTheftTick, reportTick: report.tick, reportSeconds });
  await game.awaitVisuals(page); await capture('01-first-theft-reported', s);

  // Leave using the same normal interaction key. No driving collision or firearm crime precedes the report.
  await game.setCommand(page, null); await page.keyboard.press('KeyF'); s = await game.step(page, 1);
  s = await waitFor('normal vehicle exit', state => state.player.mode === 'onFoot', 600);
  const unit = [...s.police].sort((a, b) => {
    const pa = s.characters.find(c => c.id === a.officerId)!.position, pb = s.characters.find(c => c.id === b.officerId)!.position;
    return distance(pa, s.player.position) - distance(pb, s.player.position);
  })[0]; assert.ok(unit, 'police dispatch exists after the report'); officerId = unit.officerId;
  const patrol = s.vehicles.find(v => v.id === unit.vehicleId); assert.ok(patrol);
  await game.teleport(page, patrol.position[0] + 8, patrol.position[2] + 8);
  s = await waitFor('police approaches on foot', state => officer(state).inVehicle === null, 600);
  const start = [...officer(s).position];
  await game.teleport(page, start[0]!, start[2]! + 24);
  s = await waitFor('actual police pursuit', state => officer(state).speed > 1 && distance(start, officer(state).position) > .4, 240);
  await viewToward(s); await capture('02-nonviolent-theft-pursuit', s, 'Player placed near responding patrol, then 24 m along the road; police AI controls the officer.');
  assert.ok(['walk', 'run', 'sprint'].includes(officer(s).clip));

  // Aiming alone must never authorise a police shot, even with a wanted level and line of sight.
  const preAimStart = officer(s).position;
  await game.teleport(page, preAimStart[0], preAimStart[2] + 24);
  const armed = { ...NEUTRAL, buttons: Button.aim, yaw: 0, pitch: 1.1 };
  for (let i = 0; i < 120; i++) { s = await game.step(page, 1, armed); assertNoFirstFire(s); }
  assert.ok(s.wanted.seen, 'aiming prohibition was exercised in actual police sight');
  assert.ok(s.player.weapon, 'player visibly holds a weapon before the first discharge');
  await viewToward(s); await capture('03-aiming-without-police-gunfire', s, 'Player moved 24 m along the road before holding aim for two seconds.');
  observations.push({ label: 'no-police-first-fire', throughTick: s.tick, aimingTicks: 120,
    policeFireEvents: (await game.events(page, 0)).filter(e => e.type === 'policeFire'), seen: s.wanted.seen });

  s = await game.step(page, 1, { ...armed, buttons: Button.aim | Button.fire });
  firstPlayerShotTick = s.tick;
  assert.ok(s.shots.some(shot => shot.shooter === 'player'), 'first shot comes from ordinary player weapon input');
  assert.ok(s.wanted.playerHasFired);
  await capture('04-real-first-player-shot', s, 'Real sky-directed shot avoids harming the inspection target.', 'player');
  s = await waitFor('real officer return fire', state => state.shots.some(shot => shot.shooter === officerId), 180, armed, false);
  const returnShot = s.shots.find(shot => shot.shooter === officerId)!;
  assert.ok(s.tick >= firstPlayerShotTick);
  await viewToward(s);
  const firing = await capture('05-real-officer-return-fire', s); assertFiringPose(firing);
  const flash = (await effects()).flashes.find(flash => flash.shooter === officerId && flash.visible);
  assert.ok(flash && flash.intensity > 0 && flash.color[0]! > flash.color[2]!, 'actual return fire creates warm muzzle illumination');
  assert.ok(Math.hypot(...flash.position.map((value, axis) => value - firing.pistol!.position[axis]!)) < .002, 'light is at the actual rendered barrel');
  const toPlayer = s.player.position.map((value, axis) => value + (axis === 1 ? 1.2 : 0) - firing.pistol!.position[axis]!);
  const dot = toPlayer.reduce((sum, value, axis) => sum + value * firing.pistol!.direction[axis]!, 0) / Math.hypot(...toPlayer);
  const aimErrorDegrees = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  assert.ok(aimErrorDegrees < 12, 'first returning shot visibly points at the player while the gun is raised and recoiling');
  observations.push({ label: 'return-fire', tick: s.tick, shot: returnShot, flash, firstPlayerShotTick, aimErrorDegrees });

  // Freeze the genuine return-fire frame and put the chase camera on the officer's face side.
  // Relocation changes the player only. No simulation tick, light, NPC or animation is fabricated.
  const c = officer(s);
  s = await page.evaluate(async ({ x, z, target, command }) => {
    const api = (window as ReviewWindow).__HELSINKI_GAME__;
    await api.teleport(x, z);
    const actual = api.state().player.position;
    api.setCamera(Math.atan2(target[0] - actual[0], target[2] - actual[2]) + .6, -.08);
    return await api.step(0, command);
  }, { x: c.position[0] + Math.sin(c.yaw) * 1.5, z: c.position[2] + Math.cos(c.yaw) * 1.5, target: c.position, command: armed });
  const close = await capture('06-real-flash-face-closeup', s, 'Paused real return-fire frame; atomic player teleport + camera framing + zero-tick render.');
  assertFiringPose(close);
  assert.ok(close.screen.head && Math.abs(close.screen.head[0]!) < 1 && Math.abs(close.screen.head[1]!) < 1 && close.screen.head[2]! < 1, 'face is in the captured camera frame');
  for (const ticks of [1, 1, 2]) {
    s = await game.step(page, ticks, armed);
    const p = await capture(`07-recovery-${s.tick}`, s, 'Normal simulation recovery from the same shot; closeup player-position fixture remains.');
    assert.ok(p?.pistol?.visible && ['aim', 'fire'].includes(officer(s).clip), 'pistol remains raised between actual shots');
  }
  assert.equal((await effects()).flashes.some(flash => flash.shooter === officerId && flash.visible), false, 'the actual 50 ms flash expires');
  assert.equal((await game.events(page, firstPlayerShotTick - 1)).filter(e => e.type === 'policeFire').length > 0, true);
  const requests = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  for (const asset of assets) {
    const requested = requests.find(request => new URL(request).pathname.endsWith(`/${asset.path}`));
    assert.ok(requested && new URL(requested).origin === url.origin, `${asset.id}: the runtime requested this asset`);
    const response = await page.request.get(requested); assert.equal(response.status(), 200);
    const bytes = await response.body(); assert.equal(bytes.length, asset.bytes); assert.equal(hash(bytes), asset.sha256);
    runtimeAssets.push({ id: asset.id, path: new URL(requested).pathname, bytes: bytes.length, sha256: hash(bytes), status: response.status() });
  }
  assert.deepEqual(session.consoleErrors, []);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', failure,
    scope: 'Native city, normal F-key vehicle interaction, normal player input and police AI. Explicit player relocation fixtures; no NPC or effect mutation.',
    release: manifest.worldReleaseId, manifestSha256: hash(manifestBytes), bundle, assets, runtimeAssets, sourceIdentity,
    browser: session.browser.version(), frames, observations, state: await game.state(page).catch(() => null),
    events: await game.events(page, 0).catch(() => []), consoleErrors: session.consoleErrors, visualReview: 'CAPTURED_NOT_REVIEWED',
  }, null, 2) + '\n');
  writeFileSync(path.join(out, 'console.log'), session.consoleLines.join('\n'));
  await session.close(); console.log(`${failure ? 'FAIL' : 'PASS'}: ${out}`);
  if (failure) process.exitCode = 1;
}
