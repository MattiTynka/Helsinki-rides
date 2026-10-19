// Focused real-input acceptance for jump, control direction, aim and display-frame motion.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { SimState } from '../../packages/sim/src/index.ts';
import { game, openGame } from './lib/browser.ts';

interface PresentationSnapshot {
  frameTime: number; tick: number; alpha: number; time: number;
  player: { position: number[]; yaw: number; visible: boolean };
  vehicles: { id: string; position: number[]; rotation: number[] }[];
  camera: { position: number[]; quaternion: number[]; direction: number[]; viewProjection: number[] };
  muzzle: { position: number[]; direction: number[]; screen: number[] } | null;
  aimTarget: { position: number[]; screen: number[] } | null;
  shots: { origin: number[]; end: number[]; screenOrigin: number[]; screenEnd: number[] }[];
}
type NativeWindow = Window & { __HELSINKI_GAME__: { reset(): void; state(): SimState; presentation(): PresentationSnapshot } };

const { values } = parseArgs({ options: { out: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:5317/?review=1' } } });
if (!values.out || existsSync(values.out)) throw new Error('Fresh --out directory required');
const out = values.out;
mkdirSync(out, { recursive: true });
const session = await openGame(values.url!, { width: 1200, height: 850 });
const { page } = session;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const checks: { id: string; pass: boolean; detail: unknown }[] = [];
const scenarios: object[] = [];
function check(id: string, pass: boolean, detail: unknown) { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${JSON.stringify(detail)}`); }
const reset = async () => {
  for (const key of ['Space', 'KeyW', 'KeyA', 'KeyD', 'KeyF', 'ShiftLeft']) await page.keyboard.up(key);
  await page.mouse.up({ button: 'left' }); await page.mouse.up({ button: 'right' });
  await game.pause(page); await page.evaluate(() => (window as NativeWindow).__HELSINKI_GAME__.reset());
  await game.setCamera(page, 0, 0); await game.setCommand(page, null); await game.step(page, 30);
};
const tick = async (n = 1) => { let state = await game.state(page); for (let i = 0; i < n; i++) state = await game.step(page, 1); return state; };
const snap = async (name: string) => page.screenshot({ path: `${out}/${name}.png` });
const inspect = () => page.evaluate(() => (window as NativeWindow).__HELSINKI_GAME__.presentation());

async function jump(id: string, secondTap: number | null, hold = false) {
  await reset();
  const before = await game.state(page), frames: SimState['player'][] = [];
  await page.keyboard.down('Space');
  for (let i = 0; i < 150; i++) {
    if (i === 1 && !hold) await page.keyboard.up('Space');
    if (i === secondTap) await page.keyboard.down('Space');
    if (secondTap !== null && i === secondTap + 1) await page.keyboard.up('Space');
    const state = await tick(); frames.push(state.player);
    if ([3, 17, secondTap === null ? 30 : 49, secondTap === null ? 56 : 98].includes(i)) await snap(`${id}-${i}`);
  }
  await page.keyboard.up('Space');
  const maxRise = Math.max(...frames.map(f => f.position[1])) - before.player.position[1];
  const end = frames.at(-1)!;
  const events = await game.events(page, before.tick);
  const superJump = secondTap !== null && secondTap < 17;
  check(id, Math.abs(maxRise - (superJump ? 2.8 : .9)) < .09 && end.grounded && end.jumpPhase === 'grounded'
    && events.filter(e => e.type === 'jump').length === 1 && events.filter(e => e.type === 'superJump').length === (superJump ? 1 : 0),
    { maxRise, grounded: end.grounded, events: events.filter(e => e.type === 'jump' || e.type === 'superJump') });
  scenarios.push({ id, before, frames, events });
}

async function sampleFrames(ms: number) {
  return page.evaluate(duration => new Promise<{ at: number; state: SimState; presentation: PresentationSnapshot }[]>(resolve => {
    const frames: { at: number; state: SimState; presentation: PresentationSnapshot }[] = [];
    const start = performance.now();
    const sample = (at: number) => {
      const api = (window as NativeWindow).__HELSINKI_GAME__;
      frames.push({ at, state: api.state(), presentation: api.presentation() });
      if (at - start >= duration) resolve(frames); else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), ms);
}

function checkCadence(id: string, frames: Awaited<ReturnType<typeof sampleFrames>>) {
  let sameTickMoving = 0, sameTick = 0, progressing = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!, b = frames[i]!;
    const distance = Math.hypot(...b.presentation.player.position.map((v, k) => v - a.presentation.player.position[k]!));
    if (distance > .0001) progressing++;
    if (b.state.tick === a.state.tick && b.state.player.speed > 1) { sameTick++; if (distance > .0001) sameTickMoving++; }
  }
  check(id, progressing > frames.length * .85 && (sameTick < 10 || sameTickMoving > sameTick * .85),
    { frames: frames.length, progressing, sameTick, sameTickMoving, fps: 1000 * (frames.length - 1) / (frames.at(-1)!.at - frames[0]!.at) });
  scenarios.push({ id, frames });
}

try {
  await game.start(page);
  for (const yaw of [0, Math.PI / 2]) for (const key of ['KeyA', 'KeyD']) {
    await reset(); await game.setCamera(page, yaw, 0);
    const before = await game.state(page);
    await page.keyboard.down(key); const after = await tick(30); await page.keyboard.up(key);
    const dx = after.player.position[0] - before.player.position[0], dz = after.player.position[2] - before.player.position[2];
    const right = dx * -Math.cos(yaw) + dz * Math.sin(yaw);
    check(`direction-${key}-${yaw.toFixed(2)}`, key === 'KeyA' ? right < -1.5 : right > 1.5, { right, yaw: after.player.yaw });
  }
  await jump('normal', null);
  await jump('super', 9);
  await jump('held-space', null, true);
  await jump('late-second-tap', 25);

  // Existing Cathedral side stone: the fixture uses the normal road-projected drop-in,
  // then every centimetre of approach and the 1.2m raised landing uses keyboard movement.
  await reset(); await game.teleport(page, -36.7, -40.5, 90); await tick(30);
  for (let i = 0; i < 60; i++) {
    const state = await game.state(page), dx = -36.7 - state.player.position[0], dz = -40.5 - state.player.position[2];
    if (Math.hypot(dx, dz) < .1) break;
    await game.setCamera(page, Math.atan2(dx, dz), -.12);
    await page.keyboard.down('KeyW'); await tick();
  }
  await page.keyboard.up('KeyW'); await game.setCamera(page, Math.PI / 2, -.12); await tick(20);
  const ledgeStart = await game.state(page), ledgeFrames: SimState['player'][] = [];
  await snap('cathedral-before'); await page.keyboard.down('KeyW'); await page.keyboard.down('Space');
  for (let i = 0; i < 150; i++) {
    if (i === 1 || i === 9) await page.keyboard.up('Space');
    if (i === 8) await page.keyboard.down('Space');
    if (i >= 51) await page.keyboard.up('KeyW');
    const state = await tick(); ledgeFrames.push(state.player);
    if ([20, 45, 80, 110].includes(i)) await snap(`cathedral-jump-${i}`);
  }
  const ledgeEnd = ledgeFrames.at(-1)!;
  check('cathedral-raised-stone-landing', ledgeEnd.grounded && ledgeEnd.jumpPhase === 'grounded'
    && ledgeEnd.position[1] - ledgeStart.player.position[1] > 1.05
    && ledgeEnd.position[0] - ledgeStart.player.position[0] > 2.8,
    { start: ledgeStart.player.position, end: ledgeEnd.position, rise: ledgeEnd.position[1] - ledgeStart.player.position[1] });
  scenarios.push({ id: 'cathedral-raised-stone-landing', start: ledgeStart, frames: ledgeFrames });

  // Existing 2.32 m wall near the Cathedral (found by data/evidence/finn-jump-climb-20261017/find-ledges.ts):
  // walk up to it with W (Alt for the last metre), then W + one Space grabs the edge and pulls up.
  await reset(); await game.teleport(page, -56, -52.4, 180); await tick(30);
  for (const [tx, tz, tolerance, walk] of [[-56, -50.9, .3, false], [-56, -52.4, .1, true]] as const) {
    for (let i = 0; i < 400; i++) {
      const state = await game.state(page), dx = tx - state.player.position[0], dz = tz - state.player.position[2];
      if (Math.hypot(dx, dz) < tolerance) break;
      await game.setCamera(page, Math.atan2(dx, dz), -.12);
      if (walk) await page.keyboard.down('AltLeft');
      await page.keyboard.down('KeyW'); await tick();
    }
    await page.keyboard.up('KeyW'); await page.keyboard.up('AltLeft');
  }
  await game.setCamera(page, Math.PI, -.12); await tick(20);
  const climbStart = await game.state(page), climbFrames: SimState['player'][] = [];
  await snap('ledge-before'); await page.keyboard.down('KeyW'); await page.keyboard.down('Space');
  for (let i = 0; i < 150; i++) {
    if (i === 1) await page.keyboard.up('Space');
    if (i >= 100) await page.keyboard.up('KeyW');
    const state = await tick(); climbFrames.push(state.player);
    const climb = state.player.climb;
    if (climb && [.15, .45, .75].some(u => Math.abs(state.player.jumpPhaseTime / climb.duration - u) < .5 / 60 / climb.duration)) await snap(`ledge-climb-${i}`);
  }
  const climbEnd = climbFrames.at(-1)!, climbEvents = await game.events(page, climbStart.tick);
  check('ledge-grab-pull-up', climbEvents.filter(e => e.type === 'climb').length === 1 && climbFrames.some(f => f.jumpPhase === 'climb')
    && climbEnd.grounded && climbEnd.jumpPhase === 'grounded' && climbEnd.position[1] - climbStart.player.position[1] > 2.2,
    { start: climbStart.player.position, end: climbEnd.position, climb: climbFrames.find(f => f.climb)?.climb ?? null });
  scenarios.push({ id: 'ledge-grab-pull-up', start: climbStart, frames: climbFrames, events: climbEvents });

  // Continuous play after the precise phase tests, with real keys and the real rAF loop.
  await reset(); await game.resume(page); await page.keyboard.down('Space');
  await sleep(45); await page.keyboard.up('Space'); await sleep(85); await page.keyboard.down('Space');
  await sleep(40); await page.keyboard.up('Space');
  const airborne = await sampleFrames(1700);
  check('continuous-double-space', airborne.some(f => f.state.player.jumpKind === 'super') && airborne.at(-1)!.state.player.grounded,
    { maxY: Math.max(...airborne.map(f => f.state.player.position[1])), lastPhase: airborne.at(-1)!.state.player.jumpPhase });
  scenarios.push({ id: 'continuous-double-space', frames: airborne });

  await reset(); await game.resume(page); await page.keyboard.down('KeyW'); await sleep(600);
  checkCadence('running-display-cadence', await sampleFrames(2400)); await snap('running'); await page.keyboard.up('KeyW');

  // Walk from spawn to the existing car with W, enter with F and drive it.
  await reset();
  for (let i = 0; i < 400; i++) {
    const state = await game.state(page);
    if (state.player.nearVehicle === 'car-1') break;
    const car = state.vehicles.find(v => v.id === 'car-1')!;
    await game.setCamera(page, Math.atan2(car.position[0] - state.player.position[0], car.position[2] - state.player.position[2]), -.12);
    await page.keyboard.down('KeyW'); await tick();
  }
  await page.keyboard.up('KeyW'); await page.keyboard.press('KeyF'); await tick();
  for (let i = 0; i < 1000 && (await game.state(page)).player.mode === 'entering'; i++) await tick();
  check('real-car-entry', (await game.state(page)).player.mode === 'driving', (await game.state(page)).player.mode);
  await game.resume(page); await page.keyboard.down('KeyW'); await sleep(900);
  checkCadence('driving-display-cadence', await sampleFrames(2000)); await snap('driving');
  await page.keyboard.down('Space'); await sleep(200);
  const inCar = await game.state(page);
  check('space-remains-handbrake', inCar.player.mode === 'driving' && inCar.player.jumpKind === null, inCar.player.mode);
  await page.keyboard.up('Space'); await page.keyboard.up('KeyW');

  // Camera-ray and posed muzzle evidence at level and pitched targets; spread is checked separately.
  for (const pitch of [0, -.2, .25]) {
    await reset(); await game.setCamera(page, Math.PI, pitch);
    await page.mouse.down({ button: 'right' }); await tick(45); await sleep(400);
    const aim = await inspect(); await snap(`aim-${pitch}`);
    const delta = aim.aimTarget && aim.muzzle ? aim.aimTarget.position.map((v, k) => v - aim.muzzle!.position[k]!) : null;
    const angle = delta && aim.muzzle ? Math.acos(Math.max(-1, Math.min(1, delta.reduce((sum, v, k) => sum + v * aim.muzzle!.direction[k]!, 0) / Math.hypot(...delta)))) * 180 / Math.PI : Infinity;
    check(`aim-barrel-${pitch}`, angle < 1 && !!aim.aimTarget && Math.hypot(...aim.aimTarget.screen.slice(0, 2)) < .001,
      { barrelErrorDegrees: angle, targetScreen: aim.aimTarget?.screen });
    await page.mouse.down({ button: 'left' }); const shots: PresentationSnapshot[] = [];
    for (let i = 0; i < 30; i++) { await tick(); const p = await inspect(); if (p.shots.length) shots.push(p); }
    await page.mouse.up({ button: 'left' }); await page.mouse.up({ button: 'right' });
    const pixels = shots.flatMap(p => p.shots.map(s => [s.screenEnd[0]! * 600, s.screenEnd[1]! * 425]));
    check(`aim-shot-ray-${pitch}`, shots.length > 0 && pixels.every(p => p.every(Number.isFinite)) && pixels.every(p => Math.hypot(...p) < 22),
      { shots: shots.length, pixelsFromReticle: pixels });
    scenarios.push({ id: `aim-${pitch}`, aim, shots });
  }
  check('no-browser-errors', session.consoleErrors.length === 0, session.consoleErrors);
} finally {
  const bundle = await page.locator('script[type="module"]').getAttribute('src');
  writeFileSync(`${out}/results.json`, JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? 'PASS' : 'FAIL',
    release: await game.release(page), bundle, bundleSha256: bundle?.startsWith('/assets/') ? createHash('sha256').update(readFileSync(`apps/game/dist${bundle}`)).digest('hex') : null,
    checks, scenarios, consoleErrors: session.consoleErrors }, null, 2));
  await session.close();
}
assert.ok(checks.every(c => c.pass), 'focused browser checks failed');
