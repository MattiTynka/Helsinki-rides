// Local review fixtures use native drop-ins; damage, pursuit and falls use normal simulation inputs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Button, NEUTRAL, civilianVariant, type SimState } from '../../packages/sim/src/index.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.url && values.out && !existsSync(values.out), '--url and a fresh --out required');
mkdirSync(values.out, { recursive: true });
const session = await openGame(values.url, { width: 1440, height: 900, timeoutMs: 300000 }), { page } = session;
const records: unknown[] = [], captures: string[] = [];
async function capture(name: string) {
  await game.awaitVisuals(page); await page.screenshot({ path: path.join(values.out!, `${name}.png`) }); captures.push(`${name}.png`);
}
async function frameCivilian(id: string, teleport = true): Promise<SimState> {
  let state = await game.state(page);
  const initial = state.characters.find(c => c.id === id); assert.ok(initial);
  // Drop-ins snap to the road, not the requested sidewalk coordinates. Walk from that
  // actual placement to the camera anchor; never reposition or pose the subject.
  if (teleport) await game.teleport(page, initial.position[0], initial.position[2]);
  for (let ticks = 0; ticks < 600; ticks += 3) {
    state = await game.state(page);
    const c = state.characters.find(c => c.id === id); assert.ok(c?.alive, `${id}: subject remains alive`);
    const cameraYaw = c.yaw + Math.PI + .25;
    const f = [Math.sin(cameraYaw), Math.cos(cameraYaw)];
    // The normal chase camera is 3.4m behind Snow. Put Snow 0.70m behind
    // the civilian so the civilian is in the foreground, facing the camera.
    const x = c.position[0] + f[0]! * .70 + .25 * Math.cos(cameraYaw);
    const z = c.position[2] + f[1]! * .70 - .25 * Math.sin(cameraYaw);
    const dx = x - state.player.position[0], dz = z - state.player.position[2], distance = Math.hypot(dx, dz);
    await game.setCamera(page, cameraYaw, .33);
    if (distance < .16 && ticks >= 30) return state;
    state = await game.step(page, 3, { ...NEUTRAL, moveZ: distance > .15 ? 1 : 0,
      yaw: Math.atan2(dx, dz), buttons: distance > 3 ? Button.sprint : 0 });
  }
  throw new Error(`${id}: could not reach a close-up camera anchor through native collision`);
}
async function captureCivilian(name: string, id: string, fallen = false) {
  await game.awaitVisuals(page); await page.evaluate(() => window.__HELSINKI_GAME__!.render());
  const snapshot = await page.evaluate(id => {
    const api = window.__HELSINKI_GAME__!;
    return { state: api.state().characters.find(c => c.id === id), pose: api.characterPose(id), presentation: api.presentation() };
  }, id);
  const { state, pose, presentation } = snapshot; assert.ok(state && pose?.visible, `${id}: visible subject`);
  assert.equal(pose.assetId, `character-civilian-${civilianVariant(id)}`);
  const matrix = presentation.camera.viewProjection, cs = Math.cos(state.yaw), sn = Math.sin(state.yaw);
  const project = (point: readonly number[]) => {
    const x = state.position[0] + cs * point[0]! + sn * point[2]!, y = state.position[1] + point[1]!,
      z = state.position[2] - sn * point[0]! + cs * point[2]!;
    const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
    assert.ok(w > 0, `${id}: subject is in front of camera`);
    return [(matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / w,
      (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / w];
  };
  const points = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => project([
    x ? pose.bounds.max[0]! : pose.bounds.min[0]!, y ? pose.bounds.max[1]! : pose.bounds.min[1]!,
    z ? pose.bounds.max[2]! : pose.bounds.min[2]!] ))));
  const min = [0, 1].map(axis => Math.min(...points.map(p => p[axis]!))), max = [0, 1].map(axis => Math.max(...points.map(p => p[axis]!)));
  const viewport = page.viewportSize()!;
  const subjectPixels = { width: (max[0]! - min[0]!) * viewport.width / 2, height: (max[1]! - min[1]!) * viewport.height / 2 };
  await capture(name);
  assert.ok(min.every(v => v > -1) && max.every(v => v < 1), `${id}: whole posed body must fit the screenshot (${JSON.stringify({ min, max })})`);
  assert.ok(fallen ? Math.max(subjectPixels.width, subjectPixels.height) >= 220 : subjectPixels.height >= 400,
    `${id}: actual civilian must occupy a readable close-up (${JSON.stringify(subjectPixels)})`);
  const head = pose.bones.Head ? project(pose.bones.Head) : null;
  const left = Math.max(0, Math.floor((min[0]! + 1) * viewport.width / 2) - 32);
  const top = Math.max(0, Math.floor((1 - max[1]!) * viewport.height / 2) - 32);
  const right = Math.min(viewport.width, Math.ceil((max[0]! + 1) * viewport.width / 2) + 32);
  const bottom = Math.min(viewport.height, Math.ceil((1 - min[1]!) * viewport.height / 2) + 32);
  await page.screenshot({ path: path.join(values.out!, `${name}-subject.png`), clip: { x: left, y: top, width: right - left, height: bottom - top } });
  captures.push(`${name}-subject.png`);
  records.push({ capture: name, subjectId: id, assetId: pose.assetId, subjectPixels, projectedBounds: { min, max }, head,
    camera: presentation.camera, subject: state, pose, fixture: 'Native drop-in plus normal movement inputs; original NPC pose and chase camera' });
  return pose;
}
try {
  const script = await page.locator('script[type="module"]').getAttribute('src'); assert.ok(script);
  const response = await page.request.get(new URL(script, values.url).href); assert.equal(response.status(), 200);
  const bundle = { path: script, sha256: createHash('sha256').update(await response.body()).digest('hex') };
  await game.start(page); await game.pause(page);
  const labels = ['Esplanadi', 'Mannerheimintie / Lasipalatsi', 'Hakaniementori'];
  for (const [index, label] of labels.entries()) {
    await page.evaluate(() => window.__HELSINKI_GAME__!.reset()); await game.pause(page); await game.dropIn(page, label);
    let state = await game.step(page, 650, NEUTRAL);
    const walkers = state.characters.filter(c => civilianVariant(c.id)); assert.ok(walkers.length >= 4 && walkers.length <= 8, label);
    const before = new Map(walkers.map(c => [c.id, c.position]));
    state = await game.step(page, 90, NEUTRAL);
    assert.ok(state.characters.some(c => before.has(c.id) && Math.hypot(c.position[0] - before.get(c.id)![0], c.position[2] - before.get(c.id)![2]) > .3), `${label}: moving`);
    records.push({ label, civilians: state.characters.filter(c => civilianVariant(c.id)), stats: await game.stats(page) });
    if (index === 0) {
      for (const variant of [...new Set(walkers.map(c => civilianVariant(c.id)!))]) {
        await page.evaluate(() => window.__HELSINKI_GAME__!.reset()); await game.pause(page); await game.dropIn(page, label);
        state = await game.step(page, 650, NEUTRAL);
        // Prefer the same street level: a road-snapped fixture cannot walk directly
        // through a retaining wall to an otherwise valid elevated sidewalk.
        const c = state.characters.filter(c => civilianVariant(c.id) === variant)
          .sort((a, b) => Math.abs(a.position[1] - state.player.position[1]) - Math.abs(b.position[1] - state.player.position[1]))[0]!;
        assert.ok(c);
        state = await frameCivilian(c.id);
        const pose = await captureCivilian(`civilian-${variant}-walking`, c.id);
        assert.ok(pose.materials.every(m => m.mapName && m.mapWidth > 0), `${variant}: decoded textures`);
        const target = state.characters.find(subject => subject.id === c.id)!;
        const dx = target.position[0] - state.player.position[0], dz = target.position[2] - state.player.position[2];
        const yaw = Math.atan2(dx, dz), pitch = Math.atan2(target.position[1] + 1 - state.player.position[1] - 1.62, Math.hypot(dx, dz));
        state = await game.step(page, 1, { ...NEUTRAL, buttons: Button.fire | Button.aim, yaw, pitch });
        assert.ok(state.shots.some(shot => shot.shooter === 'player' && shot.hitId === c.id), `${variant}: actual shot hits selected civilian`);
        // Holster on the following tick: preserve the assault/report while keeping the
        // recovered subject's portrait free of a continuing armed police encounter.
        state = await game.step(page, 60, { ...NEUTRAL, buttons: Button.holster });
        const down = state.characters.find(subject => subject.id === c.id)!;
        assert.ok(down.alive && down.knockdown, `${variant}: nonlethal shot causes fall`);
        const fallenPose = await captureCivilian(`civilian-${variant}-fallen`, c.id, true);
        assert.ok(fallenPose.bounds.max[1]! < 1.3, `${variant}: actual posed body is down`);
        state = await game.step(page, 200, NEUTRAL);
        assert.ok(state.wanted.stars > 0, `${variant}: civilian assault dispatches police`);
        assert.ok(!state.characters.find(subject => subject.id === c.id)?.knockdown, `${variant}: survivor recovers`);
        await frameCivilian(c.id, false);
        await captureCivilian(`civilian-${variant}-recovered`, c.id);
        records.push({ variant, assault: { victim: c.id, down, fallenPose, wanted: state.wanted } });
      }
    } else await capture(`district-${index}`);
  }
  assert.deepEqual(session.consoleErrors, []);
  writeFileSync(path.join(values.out, 'result.json'), JSON.stringify({ status: 'PASS', release: await game.release(page), bundle,
    browser: session.browser.version(), records, captures, consoleErrors: session.consoleErrors, visualReview: 'CAPTURED_NOT_REVIEWED' }, null, 2) + '\n');
} catch (error) {
  writeFileSync(path.join(values.out, 'failure.json'), JSON.stringify({ error: String(error), records, captures, consoleErrors: session.consoleErrors }, null, 2)); throw error;
} finally { await session.close(); }
