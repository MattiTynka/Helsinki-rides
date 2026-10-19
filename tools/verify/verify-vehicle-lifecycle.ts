// Focused ordinary-build browser regression. The police setup uses the native fixture
// teleport/scripted aiming; car entry and driving use real keys at fixed ticks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Button, NEUTRAL } from '../../packages/sim/src/index.ts';
import { game, openGame } from './lib/browser.ts';
type TestWindow = Window & { __HELSINKI_GAME__: {
  presentation(): { frameTime: number; player: { visible: boolean }; camera: { position: number[] }; vehicles: { id: string }[] };
  reset(): void;
} };

const { values } = parseArgs({ options: { out: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:5317/' } } });
if (!values.out || existsSync(values.out)) throw new Error('a fresh --out directory is required');
const out = values.out;
mkdirSync(out, { recursive: true });
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const session = await openGame(values.url);
const { page } = session;
const records: object[] = [];
try {
  const release = await game.release(page);
  const base = `apps/game/public/world/${release}`;
  const manifest = JSON.parse(readFileSync(`${base}/manifest.json`, 'utf8'));
  const gameplay = JSON.parse(readFileSync(`${base}/${manifest.gameplay.path}`, 'utf8'));
  const script = await page.locator('script[type="module"]').getAttribute('src');
  assert.ok(script && script.startsWith('/assets/index-'), 'test the compiled game');
  const bundle = await (await page.request.get(new URL(script, values.url).href)).body();
  assert.deepEqual(bundle, readFileSync(`apps/game/dist${script}`));
  await game.start(page); await game.pause(page);
  let s = await game.state(page);
  const unit = s.police[0]!;
  const car = s.vehicles.find(v => v.id === unit.vehicleId)!;
  await game.teleport(page, car.position[0] + 7, car.position[2]);
  s = await game.step(page, 30, NEUTRAL);
  for (let shot = 0; shot < 12; shot++) {
    const officer = s.characters.find(c => c.id === unit.officerId)!;
    if (!officer.alive) break;
    const target = officer.inVehicle ? s.vehicles.find(v => v.id === car.id)!.position : officer.position;
    const dx = target[0] - s.player.position[0], dz = target[2] - s.player.position[2];
    const pitch = Math.atan2(target[1] + 1.35 - (s.player.position[1] + 1.62), Math.hypot(dx, dz));
    s = await game.step(page, 1, { ...NEUTRAL, buttons: Button.fire | Button.aim, yaw: Math.atan2(dx, dz), pitch });
    s = await game.step(page, 12, NEUTRAL);
  }
  const dead = s.characters.find(c => c.id === unit.officerId)!;
  assert.equal(dead.alive, false, 'officer is down on foot through weapon damage');
  assert.equal(dead.inVehicle, null);
  const deathTick = s.tick;
  for (let i = 0; i < 100 && s.player.nearVehicle !== car.id; i++) {
    const v = s.vehicles.find(v => v.id === car.id)!;
    s = await game.step(page, 3, { ...NEUTRAL, moveZ: 1, yaw: Math.atan2(v.position[0] - s.player.position[0], v.position[2] - s.player.position[2]) });
  }
  assert.equal(s.player.nearVehicle, car.id);
  await game.setCommand(page, null);
  await page.keyboard.press('KeyF'); s = await game.step(page, 1);
  for (let i = 0; i < 1000 && s.player.mode === 'entering'; i++) s = await game.step(page, 1);
  assert.equal(s.player.mode, 'driving'); assert.equal(s.player.inVehicle, car.id);
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 10; i++) s = await game.step(page, 30);
  await page.keyboard.up('KeyW'); await page.keyboard.down('Space');
  let retiredAt: number | null = null;
  for (let i = 0; i < 40; i++) {
    s = await game.step(page, 30);
    assert.ok(s.vehicles.some(v => v.id === s.player.inVehicle), `occupied vehicle exists at tick ${s.tick}`);
    if (!s.police.some(u => u.id === unit.id)) retiredAt ??= s.tick;
  }
  await page.keyboard.up('Space');
  assert.ok(retiredAt && retiredAt - deathTick >= 1180, 'actual twenty-second officer cleanup ran');
  assert.equal(s.player.inVehicle, car.id); assert.equal(s.player.mode, 'driving');
  assert.ok(Math.hypot(s.player.position[0] - dead.position[0], s.player.position[2] - dead.position[2]) > 50);
  const frameBefore = await page.evaluate(() => (window as TestWindow).__HELSINKI_GAME__.presentation().frameTime);
  await game.resume(page); await page.waitForTimeout(1000); await game.pause(page);
  const presentation = await page.evaluate(() => (window as TestWindow).__HELSINKI_GAME__.presentation());
  assert.ok(presentation.frameTime > frameBefore + 500, 'animation frames continue after cleanup');
  assert.ok(presentation.camera.position.every(Number.isFinite));
  assert.ok(presentation.vehicles.some(v => v.id === car.id));
  assert.equal(presentation.player.visible, true, 'the driver remains rendered in the retained patrol car');
  await page.screenshot({ path: path.join(out, 'driving-after-cleanup.png') });
  records.push({ id: 'stolen-patrol-cleanup', deathTick, retiredAt, final: await game.state(page), presentation });
  await page.keyboard.press('KeyF'); s = await game.step(page, 1);
  for (let i = 0; i < 600 && s.player.mode !== 'onFoot'; i++) s = await game.step(page, 1);
  assert.equal(s.player.mode, 'onFoot'); assert.equal(s.player.inVehicle, null);
  records.push({ id: 'exit-after-cleanup', state: s });

  const a = gameplay.playArea;
  const probes: [number, number][] = [[-10000, -10000], [10000, 10000], [a.minX - 50, 0], [a.maxX + 50, 0], [0, a.minZ - 50], [0, a.maxZ + 50]];
  for (let i = 0; i < probes.length; i++) {
    await page.evaluate(() => (window as TestWindow).__HELSINKI_GAME__.reset());
    await game.pause(page);
    const [x, z] = probes[i]!;
    await game.teleport(page, x, z);
    const before = await game.state(page);
    s = await game.step(page, 1, NEUTRAL);
    assert.ok(s.player.position[0] > a.minX && s.player.position[0] < a.maxX && s.player.position[2] > a.minZ && s.player.position[2] < a.maxZ, 'recovery is inside the playable map');
    s = await game.step(page, 240, NEUTRAL);
    const events = await game.events(page, before.tick);
    assert.ok(events.filter(e => e.type === 'killPlane').length <= 1, 'no repeated fall recovery loop');
    assert.ok(s.player.grounded && s.player.health > 0 && s.player.position[1] > gameplay.killHeight);
    records.push({ id: `edge-${i}`, requested: [x, z], state: s, events });
  }
  await page.screenshot({ path: path.join(out, 'recovered-on-map.png') });
  assert.deepEqual(session.consoleErrors, []);
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'PASS', url: values.url, release, browser: session.browser.version(), bundle: { path: script, sha256: hash(bundle) }, records, consoleErrors: session.consoleErrors, visualReview: 'CAPTURED_NOT_REVIEWED' }, null, 2));
  console.log(`PASS retained patrol, continuing frames, exit and ${probes.length} stable map recoveries`);
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(error), state: await game.state(page), events: await game.events(page, 0), consoleErrors: session.consoleErrors }, null, 2));
  await page.screenshot({ path: path.join(out, 'failure.png') });
  throw error;
} finally {
  for (const key of ['KeyW', 'Space', 'KeyF']) await page.keyboard.up(key);
  await session.close();
}
