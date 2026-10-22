// Real browser touch journey. The review API is used strictly for read-only observations/recording.
// No scripted commands, simulation stepping, teleports, camera setters, resets or state mutation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createNativeTouch } from './lib/native-touch.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.url && values.out, '--url and --out are required');
const target = new URL(values.url);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'this recording requires a local review build');
await mkdir(path.dirname(values.out), { recursive: true }); await mkdir(values.out, { recursive: false });
const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${process.env.HELSINKI_VERIFY_ANGLE ?? 'vulkan'}`, '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
  const pointers = []; window.__touchJourneyPointers = pointers;
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) addEventListener(type, event => {
    if (pointers.length < 2000) pointers.push({ type, pointerType: event.pointerType, id: event.pointerId,
      role: event.target?.dataset?.touchRole ?? event.target?.className });
  }, true);
});
const page = await context.newPage(), errors = [], stages = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const cdp = await context.newCDPSession(page), touch = createNativeTouch(cdp);
const started = Date.now();
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const observe = () => page.evaluate(() => {
  const game = window.__HELSINKI_GAME__;
  return { state: game.state(), camera: game.camera(), stats: game.stats() };
});
async function centre(selector) {
  const rect = await page.locator(selector).boundingBox(); assert.ok(rect, `${selector} is visible`);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
}
async function tap(selector, id = 90) { const p = await centre(selector); await touch('touchStart', id, p.x, p.y); await touch('touchEnd', id); }
async function hold(role, ms, id = 80) {
  const p = await centre(`[data-touch-role="${role}"]`); await touch('touchStart', id, p.x, p.y);
  await page.waitForTimeout(ms); await touch('touchEnd', id);
}
async function capture(name) {
  const sample = await observe(); stages.push({ name, elapsedMs: Date.now() - started, ...sample });
  await page.screenshot({ path: path.join(values.out, `${name}.png`) });
  console.log(`${name}: tick ${sample.state.tick}, mode ${sample.state.player.mode}`); return sample;
}
function check(id, pass, detail) { checks.push({ id, pass, detail }); assert.ok(pass, `${id}: ${detail}`); }
async function waitFor(label, predicate, timeout = 12000) {
  const from = Date.now(); let sample;
  do {
    sample = await observe(); if (predicate(sample)) return sample;
    assert.ok(sample.state.player.alive && sample.state.player.mode !== 'busted', `${label}: player remains active`);
    await page.waitForTimeout(80);
  } while (Date.now() - from < timeout);
  throw new Error(`${label} timed out at ${JSON.stringify(sample.state.player)}`);
}
async function turnToward(yaw) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const camera = (await observe()).camera, error = wrap(yaw - camera.yaw);
    if (Math.abs(error) < .06) return;
    // The free right-hand look pane, away from the action cluster and pause toolbar.
    await touch('touchStart', 2, 520, 145);
    await touch('touchMove', 2, 520 + Math.max(-150, Math.min(150, -error / .004)), 145);
    await page.waitForTimeout(70); await touch('touchEnd', 2); await page.waitForTimeout(40);
  }
  throw new Error('native look gestures could not face the nearby car');
}
try {
  await page.goto(target.href, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__HELSINKI_GAME__?.ready || !!window.__HELSINKI_ERROR__, null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.__HELSINKI_ERROR__ ?? null), null);
  await page.locator('#touch-controls').waitFor({ state: 'visible', timeout: 30000 });
  // Deferred character residency can interrupt the first frame. Start after ordinary fixed ticks
  // have demonstrably advanced, so a loading cancellation cannot masquerade as a held walking finger.
  await waitFor('initial playable ticks', sample => sample.state.tick >= 90, 30000);
  await page.locator('#touch-controls').waitFor({ state: 'visible', timeout: 30000 });
  const initial = await capture('01-start');
  const candidates = initial.state.vehicles.filter(vehicle => vehicle.driver === null && vehicle.damage !== 'wrecked');
  candidates.sort((a, b) => Math.hypot(a.position[0] - initial.state.player.position[0], a.position[2] - initial.state.player.position[2])
    - Math.hypot(b.position[0] - initial.state.player.position[0], b.position[2] - initial.state.player.position[2]));
  const car = candidates[0]; assert.ok(car, 'a stealable car is present');
  const yaw = Math.atan2(car.position[0] - initial.state.player.position[0], car.position[2] - initial.state.player.position[2]);
  await turnToward(yaw);
  const stick = await centre('.touch-stick');
  await touch('touchStart', 1, stick.x, stick.y - stick.height * .42);
  const walkStart = Date.now(); let approached;
  for (;;) {
    approached = await observe();
    if (approached.state.player.nearVehicle) break;
    if (Date.now() - walkStart > 18000) throw new Error('native stick walk did not reach a car');
    const p = approached.state.player.position, targetCar = approached.state.vehicles.find(vehicle => vehicle.id === car.id) ?? car;
    await turnToward(Math.atan2(targetCar.position[0] - p[0], targetCar.position[2] - p[2]));
    await page.waitForTimeout(180);
  }
  await touch('touchEnd', 1);
  const walked = Math.hypot(approached.state.player.position[0] - initial.state.player.position[0], approached.state.player.position[2] - initial.state.player.position[2]);
  check('native-stick-walk', walked > 1, `walked ${walked.toFixed(2)} metres to ${approached.state.player.nearVehicle}`);
  await capture('02-near-car');
  await tap('[data-touch-role="interact"]');
  const seated = await waitFor('full vehicle entry', sample => sample.state.player.mode === 'driving');
  const vehicleId = seated.state.player.inVehicle;
  check('native-entry', typeof vehicleId === 'string', 'touch entry completes the authored approach and seated transition');
  const seatedCar = seated.state.vehicles.find(vehicle => vehicle.id === vehicleId);
  await capture('03-seated');
  const pedal = await centre('[data-touch-role="accelerate"]');
  await touch('touchStart', 3, pedal.x, pedal.y); await page.waitForTimeout(1100);
  const accelerated = await observe(), acceleratingCar = accelerated.state.vehicles.find(vehicle => vehicle.id === vehicleId);
  check('accelerator', acceleratingCar.forwardSpeed > 1, `forward speed ${acceleratingCar.forwardSpeed.toFixed(2)} m/s`);
  const steering = await centre('.touch-stick');
  await touch('touchStart', 1, steering.x + steering.width * .3, steering.y); await page.waitForTimeout(400);
  const steered = await observe(), steeringCar = steered.state.vehicles.find(vehicle => vehicle.id === vehicleId);
  check('steering', Math.abs(steeringCar.steerAngle) > .02, `steer angle ${steeringCar.steerAngle.toFixed(3)}`);
  await touch('touchEnd', 1); await touch('touchEnd', 3);
  const moved = Math.hypot(steeringCar.position[0] - seatedCar.position[0], steeringCar.position[2] - seatedCar.position[2]);
  check('driving-distance', moved > 1, `drove ${moved.toFixed(2)} metres`);
  await capture('04-driving');
  await hold('brake', 1100);
  const braking = await observe(), brakingCar = braking.state.vehicles.find(vehicle => vehicle.id === vehicleId);
  check('brake', brakingCar.forwardSpeed < acceleratingCar.forwardSpeed, `${acceleratingCar.forwardSpeed.toFixed(2)} to ${brakingCar.forwardSpeed.toFixed(2)} m/s`);
  await hold('brake', 1400);
  const reversing = await observe(), reversingCar = reversing.state.vehicles.find(vehicle => vehicle.id === vehicleId);
  check('reverse', reversingCar.forwardSpeed < -.15, `reverse speed ${reversingCar.forwardSpeed.toFixed(2)} m/s`);
  await capture('05-reversing');
  const handbrake = await centre('[data-touch-role="handbrake"]'), horn = await centre('[data-touch-role="horn"]');
  await touch('touchStart', 4, handbrake.x, handbrake.y); await touch('touchStart', 5, horn.x, horn.y);
  await page.waitForTimeout(250);
  const sounding = await observe();
  check('horn', sounding.state.vehicles.find(vehicle => vehicle.id === vehicleId).horn, 'native held horn reaches the vehicle');
  const brakeCommands = await page.evaluate(() => window.__HELSINKI_GAME__.commands().slice(-12));
  check('handbrake', brakeCommands.some(command => (command[4] & 16) !== 0), 'actual touch commands contain held handbrake');
  await touch('touchEnd', 5);
  // Exit is only valid when stopped. Keep the real handbrake held until the car reaches that
  // precondition, rather than assuming one fixed wait stops it on every terrain/initial speed.
  const stopped = await waitFor('native handbrake stop', sample => sample.state.vehicles.find(vehicle => vehicle.id === vehicleId).speed < .2, 8000);
  check('stopped-before-exit', stopped.state.vehicles.find(vehicle => vehicle.id === vehicleId).speed < .2, 'actual vehicle speed is below 0.2 m/s, within the simulation exit threshold');
  check('horn-released-independently', !stopped.state.vehicles.find(vehicle => vehicle.id === vehicleId).horn, 'releasing the horn thumb preserves handbrake and ends the horn');
  await touch('touchEnd', 4);
  await capture('06-stopped');
  await tap('[data-touch-role="interact"]');
  const exited = await waitFor('full vehicle exit', sample => sample.state.player.mode === 'onFoot' && sample.state.player.inVehicle === null);
  check('native-exit', exited.state.player.alive, 'touch exit finishes with the character outside the car');
  await capture('07-exited');
  await tap('#pause-button'); await page.locator('#pause-menu').waitFor({ state: 'visible' });
  const recording = await page.evaluate(() => {
    const game = window.__HELSINKI_GAME__, commands = game.commands();
    return { release: game.release, seed: game.seed(), ending: 'touch-driving-exit', ticks: commands.length,
      hash: game.hash(), commands, collision: game.collision().residency ?? undefined, events: game.events(), finalState: game.state() };
  });
  await writeFile(path.join(values.out, 'recording.json'), `${JSON.stringify(recording)}\n`);
  const pointers = await page.evaluate(() => window.__touchJourneyPointers);
  for (const role of ['interact', 'accelerate', 'brake', 'handbrake', 'horn']) check(`native-pointer-${role}`,
    pointers.some(pointer => pointer.pointerType === 'touch' && pointer.type === 'gotpointercapture' && pointer.role === role), 'browser captured a real touch pointer');
  check('no-pointer-lock', await page.evaluate(() => document.pointerLockElement === null), 'touch camera and driving require no pointer lock');
  check('browser-errors', errors.length === 0, JSON.stringify(errors));
  await writeFile(path.join(values.out, 'result.json'), JSON.stringify({ status: 'PASS', scope: 'Chromium native touch emulation; physical device performance unmeasured',
    release: recording.release, hash: recording.hash, ticks: recording.ticks, seconds: recording.ticks / 60, checks, stages, pointers, errors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', release: recording.release, hash: recording.hash, ticks: recording.ticks }));
} catch (error) {
  await page.screenshot({ path: path.join(values.out, 'failure.png') }).catch(() => {});
  const last = await observe().catch(() => null);
  await writeFile(path.join(values.out, 'result.json'), JSON.stringify({ status: 'FAIL', message: error.message, checks, stages, last, errors }, null, 2));
  throw error;
} finally { await context.close(); await browser.close(); }
