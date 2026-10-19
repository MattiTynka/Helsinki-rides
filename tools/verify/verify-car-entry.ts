// Real keyboard path from the ordinary spawn. Fixed-tick captures inspect entry contacts;
// a second uninterrupted real-time entry/exit cycle supplies motion video, without teleports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { VEHICLE_INTERACTION, yawOf, type EncodedCommand, type SimState, type VehicleState } from '../../packages/sim/src/index.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  out: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:5317/' }, headful: { type: 'boolean', default: false },
} });
if (!values.out || existsSync(values.out)) throw new Error('a fresh --out directory is required');
const out = values.out;
mkdirSync(out, { recursive: true });
const session = await openGame(values.url, { width: 1440, height: 900, headful: values.headful, videoDir: path.join(out, 'video') });
const { page } = session;
interface Pose { visible: boolean; vehicleId: string; bones: Record<string, number[]>; bounds: { min: number[]; max: number[] }; doors: Record<string, number[]> }
type TestWindow = Window & { __HELSINKI_GAME__: {
  vehiclePose(): Pose | null;
  presentation(): { player: { visible: boolean } };
  commands(): EncodedCommand[];
} };
type RecordFrame = { label: string; state: SimState; pose: Pose | null; screenshot: string };
const frames: RecordFrame[] = [];
const timeline: { label: string; tick: number; mode: string; interaction: SimState['player']['vehicleInteraction'] }[] = [];
let passengerDoor: number[] | null = null;
let release = '', script = '', bundleHash = '';
const video = page.video();
let failure: string | null = null;

const note = (label: string, s: SimState) => {
  timeline.push({ label, tick: s.tick, mode: s.player.mode, interaction: s.player.vehicleInteraction });
  console.log(`${label}: tick ${s.tick}, ${s.player.mode}, ${s.player.vehicleInteraction?.stage ?? 'none'} ${s.player.vehicleInteraction?.progress.toFixed(3) ?? ''}`);
};
const carIn = (s: SimState, id: string): VehicleState => {
  const car = s.vehicles.find(v => v.id === id); assert.ok(car, 'the active vehicle remains present'); return car;
};
async function readPose(): Promise<Pose | null> {
  return page.evaluate(() => (window as unknown as TestWindow).__HELSINKI_GAME__.vehiclePose());
}
function validatePose(pose: Pose, seated: boolean): void {
  assert.equal(pose.visible, true, 'Finn remains visible during entry, while seated and on exit');
  assert.ok(Object.keys(pose.bones).length >= 71, 'inspect the actual loaded skin hierarchy');
  assert.ok(Object.values(pose.bones).flat().every(Number.isFinite), 'all actual joint locations are finite');
  assert.ok([...pose.bounds.min, ...pose.bounds.max].every(Number.isFinite), 'posed skin bounds are finite');
  const right = pose.doors.DOOR_FR; assert.ok(right, 'passenger door exists');
  if (!passengerDoor) passengerDoor = [...right];
  assert.deepEqual(right, passengerDoor, 'the passenger door stays shut throughout the driver interaction');
  if (seated) {
    assert.ok(pose.bounds.max[1]! <= 1.383, `seated hair/skin stays below the 1.378 m roof underside (got ${pose.bounds.max[1]})`);
    assert.ok(pose.bounds.min[1]! >= .311, `seated shoes stay above the 0.321 m floor (got ${pose.bounds.min[1]})`);
    for (const [name, position] of Object.entries(pose.bones)) if (/DEF-Foot/.test(name))
      assert.ok(position[1]! >= .315, `${name} stays above the cabin floor`);
  }
}
async function capture(label: string, s: SimState, seated = false): Promise<void> {
  const pose = await readPose();
  if (s.player.vehicleInteraction) { assert.ok(pose); validatePose(pose, seated); }
  const screenshot = `${label}.png`;
  await page.screenshot({ path: path.join(out, screenshot) });
  frames.push({ label, state: s, pose, screenshot }); note(label, s);
}
async function advanceUntil(label: string, predicate: (s: SimState) => boolean, maxTicks: number): Promise<SimState> {
  let s = await game.state(page);
  for (let tick = 0; tick < maxTicks && !predicate(s); tick++) s = await game.step(page, 1);
  assert.ok(predicate(s), `${label}: timed out at ${s.player.mode}/${s.player.vehicleInteraction?.stage ?? 'none'}`);
  return s;
}
async function realTimeUntil(label: string, predicate: (s: SimState) => boolean, seconds: number): Promise<SimState> {
  const start = Date.now(); let s = await game.state(page);
  while (!predicate(s) && Date.now() - start < seconds * 1000) {
    await page.waitForTimeout(80); s = await game.state(page);
    assert.deepEqual(session.consoleErrors, []);
  }
  assert.ok(predicate(s), `${label}: real-time timeout at ${s.player.mode}/${s.player.vehicleInteraction?.stage ?? 'none'}`);
  note(label, s); return s;
}

try {
  release = await game.release(page);
  script = await page.locator('script[type="module"]').getAttribute('src') ?? '';
  assert.ok(script.startsWith('/assets/index-'), 'verify the compiled ordinary build');
  const response = await page.request.get(new URL(script, values.url).href);
  assert.ok(response.ok()); const bytes = await response.body();
  assert.deepEqual(bytes, readFileSync(`apps/game/dist${script}`), 'served bundle exactly matches local build');
  bundleHash = createHash('sha256').update(bytes).digest('hex');
  await game.start(page); await game.pause(page); await game.setCommand(page, null);
  let s = await game.step(page, 2);
  const candidates = s.vehicles.filter(v => v.driver === null && !v.definition.includes('patrol'));
  candidates.sort((a, b) => Math.hypot(a.position[0] - s.player.position[0], a.position[2] - s.player.position[2]) - Math.hypot(b.position[0] - s.player.position[0], b.position[2] - s.player.position[2]));
  const target = candidates[0]; assert.ok(target, 'there is an unoccupied civilian car at the ordinary spawn');
  await capture('00-spawn', s);
  await page.keyboard.down('KeyW');
  for (let tick = 0; tick < 1200 && s.player.nearVehicle !== target.id; tick += 3) {
    const car = carIn(s, target.id);
    await game.setCamera(page, Math.atan2(car.position[0] - s.player.position[0], car.position[2] - s.player.position[2]), -.12);
    s = await game.step(page, 3);
  }
  await page.keyboard.up('KeyW');
  assert.equal(s.player.nearVehicle, target.id, 'walked from spawn into interaction range using the keyboard');
  await page.keyboard.press('KeyF'); s = await game.step(page, 1);
  assert.equal(s.player.mode, 'entering');
  await capture('01-approach', s);
  s = await advanceUntil('reach driver staging point', state => state.player.vehicleInteraction?.stage === 'enter', 900);
  const car = carIn(s, target.id);
  await game.setCamera(page, yawOf(car.rotation) - Math.PI / 2, -.12);
  // One tick per pose keeps fixed-step controls and the car/character presentation on the same clock.
  const phases = [0, .15, .3, .45, .6, .75, .9];
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!;
    s = await advanceUntil(`entry ${phase}`, state => state.player.vehicleInteraction?.stage === 'enter' && state.player.vehicleInteraction.progress >= phase, Math.ceil(VEHICLE_INTERACTION.durations.enter * 60));
    await capture(`entry-${index}-${String(Math.round(phase * 100)).padStart(2, '0')}`, s);
  }
  s = await advanceUntil('seated', state => state.player.mode === 'driving', 120);
  assert.equal(s.player.inVehicle, target.id);
  assert.equal(s.player.vehicleInteraction?.stage, 'seated');
  await capture('seated', s, true);
  const initialPosition = [...carIn(s, target.id).position];
  await page.keyboard.down('KeyW'); s = await game.step(page, 40); await page.keyboard.up('KeyW');
  assert.ok(Math.hypot(carIn(s, target.id).position[0] - initialPosition[0]!, carIn(s, target.id).position[2] - initialPosition[2]!) > .25, 'car drives with its visible seated driver');
  await capture('driving', s, true);
  await page.keyboard.down('Space');
  s = await advanceUntil('braking before exit', state => carIn(state, target.id).speed <= .2, 600);
  await page.keyboard.up('Space'); await page.keyboard.press('KeyF'); s = await game.step(page, 1);
  assert.equal(s.player.mode, 'exiting');
  for (const phase of [0, .15, .3, .45, .6, .75, .9]) {
    s = await advanceUntil(`exit ${phase}`, state => state.player.vehicleInteraction?.stage === 'exit' && state.player.vehicleInteraction.progress >= phase, Math.ceil(VEHICLE_INTERACTION.durations.exit * 60));
    await capture(`exit-${String(Math.round(phase * 100)).padStart(2, '0')}`, s);
  }
  s = await advanceUntil('back on foot', state => state.player.mode === 'onFoot', 120);
  assert.equal(s.player.inVehicle, null);
  assert.equal(s.player.vehicleInteraction, null);
  assert.equal(await readPose(), null);
  assert.equal(await page.evaluate(() => (window as unknown as TestWindow).__HELSINKI_GAME__.presentation().player.visible), true);
  await capture('after-exit', s);

  // Continuous wall-clock playback of a fresh cycle makes timing and contacts reviewable in video.
  await game.setCamera(page, yawOf(carIn(s, target.id).rotation) - Math.PI / 2, -.12);
  await game.resume(page);
  await realTimeUntil('on-foot interaction debounce elapsed', state => state.player.mode === 'onFoot' && state.player.modeTicks > 10, 3);
  await page.keyboard.press('KeyF');
  s = await realTimeUntil('real-time entry begins', state => state.player.mode === 'entering', 3);
  s = await realTimeUntil('real-time seated', state => state.player.mode === 'driving', 18);
  const seatedPose = await readPose(); assert.ok(seatedPose); validatePose(seatedPose, true);
  await page.waitForTimeout(750);
  await page.keyboard.press('KeyF');
  s = await realTimeUntil('real-time exit begins', state => state.player.mode === 'exiting', 3);
  s = await realTimeUntil('real-time on foot', state => state.player.mode === 'onFoot', 18);
  await page.waitForTimeout(300); await game.pause(page);
  await capture('real-time-cycle-complete', await game.state(page));
  assert.deepEqual(session.consoleErrors, []);
  const commands = await page.evaluate(() => (window as unknown as TestWindow).__HELSINKI_GAME__.commands());
  writeFileSync(path.join(out, 'commands.json'), JSON.stringify(commands));
  console.log('PASS keyboard approach, visible entry/seat/driving/exit, passenger door, cabin bounds and real-time repeat');
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space']) await page.keyboard.up(key).catch(() => {});
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({
    status: failure ? 'FAIL' : 'PASS', failure, url: values.url, release, browser: session.browser.version(),
    bundle: { path: script, sha256: bundleHash }, input: 'Real keyboard from ordinary spawn; no teleports or simulation mutations. First cycle uses fixed ticks for captures; second cycle runs continuously in real time.',
    timeline, frames, consoleErrors: session.consoleErrors, visualReview: 'CAPTURED_NOT_REVIEWED',
  }, null, 2));
  await session.close();
  if (video) writeFileSync(path.join(out, 'video-path.txt'), await video.path());
}
