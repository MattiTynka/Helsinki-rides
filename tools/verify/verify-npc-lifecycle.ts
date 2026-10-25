// Actual-game NPC evidence: native player drop-ins, ordinary movement and fire only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Button, NEUTRAL, civilianVariant, type SimState } from '../../packages/sim/src/index.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' }, variant: { type: 'string' } } });
assert.ok(values.url && values.out && !existsSync(values.out), '--url and a fresh --out required');
mkdirSync(values.out, { recursive: true });
const session = await openGame(values.url, { width: 1440, height: 900, timeoutMs: 300000 });
const { page } = session;
const records: unknown[] = [], captures: string[] = [];
const coverageFailures: string[] = [];
const portraitAnchors = new Map<string, number>();
let bundle: { path: string; sha256: string } | null = null;
const repository = fileURLToPath(new URL('../../', import.meta.url));
const sourceFiles = ['packages/sim/src/character.ts', 'packages/sim/src/simulation.ts', 'packages/sim/src/pedestrians.ts',
  'apps/game/src/render/characters.ts', 'apps/game/src/render/character-collapse.ts', 'apps/game/src/render/pedestrian-animation.ts',
  'apps/game/src/render/native-character-animation.ts', 'apps/game/src/render/native-locomotion.ts',
  'apps/game/src/render/locomotion.ts', 'tools/verify/verify-npc-lifecycle.ts'];
const sourceSnapshot = () => Object.fromEntries(sourceFiles.map(file => [file,
  createHash('sha256').update(readFileSync(path.join(repository, file))).digest('hex')]));
const sourceStart = sourceSnapshot();
const variants = ['rain-black', 'rain-white', 'snow-black'] as const;
const selectedVariants = values.variant ? variants.filter(variant => variant === values.variant) : variants;
assert.ok(selectedVariants.length, '--variant must be rain-black, rain-white or snow-black');
type Npc = SimState['characters'][number];
const subject = (state: SimState, id: string): Npc => {
  const c = state.characters.find(c => c.id === id); assert.ok(c, `${id}: retained simulation character`); return c;
};
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

async function fresh(variant: typeof variants[number]): Promise<string> {
  await page.evaluate(() => window.__HELSINKI_GAME__!.reset());
  await game.pause(page); await game.dropIn(page, 'Esplanadi');
  const state = await game.step(page, 650, NEUTRAL);
  const c = state.characters.filter(c => civilianVariant(c.id) === variant)
    .sort((a, b) => Math.abs(a.position[1] - state.player.position[1]) - Math.abs(b.position[1] - state.player.position[1]))[0];
  assert.ok(c?.alive, `${variant}: native pedestrian spawn`);
  portraitAnchors.delete(c.id); portraitAnchors.delete(`${c.id}:floor`);
  return c.id;
}

/** Reach a portrait with ordinary walking from the native road-snapped player fixture. */
async function frameSubject(id: string, teleport: boolean, floorBody = false): Promise<SimState> {
  let state = await game.state(page);
  const c = subject(state, id);
  if (teleport) await game.teleport(page, c.position[0], c.position[2]);
  const key = floorBody ? `${id}:floor` : id, preferred = portraitAnchors.get(key) ?? 0;
  const anchors = [preferred, ...[0, 1, 2, 3].filter(anchor => anchor !== preferred)];
  for (let ticks = 0; ticks < 1200; ticks += 3) {
    state = await game.state(page);
    const c = subject(state, id), anchor = anchors[Math.floor(ticks / 300)]!;
    const cameraYaw = c.yaw + [Math.PI + .25, Math.PI - .25, Math.PI / 2, -Math.PI / 2][anchor]!;
    const along = floorBody ? -.3 : .70, across = (anchor === 1 ? -1 : 1) * (floorBody ? 1.2 : .25);
    const x = c.position[0] + Math.sin(cameraYaw) * along + across * Math.cos(cameraYaw);
    const z = c.position[2] + Math.cos(cameraYaw) * along - across * Math.sin(cameraYaw);
    const dx = x - state.player.position[0], dz = z - state.player.position[2], distance = Math.hypot(dx, dz);
    await game.setCamera(page, cameraYaw, floorBody ? -.12 : .33);
    if (distance < .16 && ticks >= (teleport ? 30 : 0)) {
      portraitAnchors.set(key, anchor);
      records.push({ framing: { id, tick: state.tick, anchor, floorBody, positionError: distance } });
      return state;
    }
    if (ticks % 300 === 297) records.push({ framingAttempt: { id, tick: state.tick, anchor, floorBody,
      positionError: distance, target: [x, z], subject: c, player: state.player } });
    state = await game.step(page, 3, { ...NEUTRAL, moveZ: distance > .15 ? 1 : 0,
      yaw: Math.atan2(dx, dz), buttons: distance > 3 ? Button.sprint : 0 });
  }
  await page.screenshot({ path: path.join(values.out!, `${id}-framing-failure.png`) });
  throw new Error(`${id}: camera anchor inaccessible through native collision`);
}

async function inspect(id: string) {
  await page.evaluate(() => window.__HELSINKI_GAME__!.render());
  return page.evaluate(id => {
    const api = window.__HELSINKI_GAME__!;
    return { state: api.state(), character: api.state().characters.find(c => c.id === id),
      pose: api.characterPose(id), presentation: api.presentation() };
  }, id);
}

async function capture(name: string, id: string, minimumPixels = 210) {
  await game.awaitVisuals(page);
  const snapshot = await inspect(id), { character: c, pose, presentation } = snapshot;
  assert.ok(c && pose?.visible, `${id}: actual displayed subject`);
  assert.equal(pose.assetId, `character-civilian-${civilianVariant(id)}`);
  const matrix = presentation.camera.viewProjection, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const project = (point: readonly number[]) => {
    const x = c.position[0] + cs * point[0]! + sn * point[2]!, y = c.position[1] + point[1]!,
      z = c.position[2] - sn * point[0]! + cs * point[2]!;
    const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
    assert.ok(w > 0, `${id}: in front of camera`);
    return [(matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / w,
      (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / w];
  };
  const points = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => project([
    x ? pose.bounds.max[0]! : pose.bounds.min[0]!, y ? pose.bounds.max[1]! : pose.bounds.min[1]!,
    z ? pose.bounds.max[2]! : pose.bounds.min[2]!] ))));
  const min = [0, 1].map(a => Math.min(...points.map(p => p[a]!))), max = [0, 1].map(a => Math.max(...points.map(p => p[a]!)));
  const viewport = page.viewportSize()!;
  const pixels = { width: (max[0]! - min[0]!) * viewport.width / 2, height: (max[1]! - min[1]!) * viewport.height / 2 };
  await page.screenshot({ path: path.join(values.out!, `${name}.png`) }); captures.push(`${name}.png`);
  assert.ok(min.every(v => v > -1) && max.every(v => v < 1), `${name}: whole posed body fits (${JSON.stringify({ min, max })})`);
  assert.ok(Math.max(pixels.width, pixels.height) >= minimumPixels, `${name}: readable subject (${JSON.stringify(pixels)})`);
  const left = Math.max(0, Math.floor((min[0]! + 1) * viewport.width / 2) - 24);
  const top = Math.max(0, Math.floor((1 - max[1]!) * viewport.height / 2) - 24);
  const right = Math.min(viewport.width, Math.ceil((max[0]! + 1) * viewport.width / 2) + 24);
  const bottom = Math.min(viewport.height, Math.ceil((1 - min[1]!) * viewport.height / 2) + 24);
  await page.screenshot({ path: path.join(values.out!, `${name}-subject.png`), clip: { x: left, y: top, width: right - left, height: bottom - top } });
  captures.push(`${name}-subject.png`);
  records.push({ capture: name, tick: snapshot.state.tick, subjectId: id, subject: c, pose, camera: presentation.camera,
    pixels, projectedBounds: { min, max }, player: snapshot.state.player, wanted: snapshot.state.wanted });
  return snapshot;
}

function assertCorpse(snapshot: Awaited<ReturnType<typeof inspect>>, name: string) {
  const { character: c, pose } = snapshot;
  assert.ok(c && pose?.visible, `${name}: retained visible body`);
  assert.equal(c.alive, false, `${name}: no resurrection`);
  assert.equal(c.health, 0, `${name}: lethal health remains zero`);
  assert.equal(c.clip, 'death', `${name}: terminal animation state`);
  assert.equal(c.knockdown, null, `${name}: death never enters survivor recovery`);
  assert.ok(pose.bounds.max[1]! < 1.3, `${name}: evaluated skinned body stays below standing height (${pose.bounds.max[1]})`);
  const death = pose.actions.find(a => a.name === 'death'); assert.ok(death, `${name}: death action`);
  assert.ok(death.weight > .99, `${name}: full death weight (${death.weight})`);
  assert.ok(death.time >= death.duration * .9, `${name}: remains at the collapsed end of death (${death.time}/${death.duration})`);
}

try {
  const script = await page.locator('script[type="module"]').getAttribute('src'); assert.ok(script);
  const response = await page.request.get(new URL(script, values.url).href); assert.equal(response.status(), 200);
  bundle = { path: script, sha256: createHash('sha256').update(await response.body()).digest('hex') };
  await game.start(page); await game.pause(page);
  for (const variant of selectedVariants) {
    console.log(`[npc-lifecycle] ${variant}: natural walking and stop/turn`);
    let id = await fresh(variant), state = await frameSubject(id, true);
    for (let n = 0; n < 240 && (subject(state, id).speed < .5 || subject(state, id).clip !== 'walk'); n += 3)
      state = await game.step(page, 3, NEUTRAL);
    assert.ok(subject(state, id).speed > .5, `${variant}: native walking fixture`);
    await frameSubject(id, false);
    const walking: Awaited<ReturnType<typeof inspect>>[] = [];
    for (let sample = 0; sample < 9; sample++) {
      if (sample) { await game.step(page, 10, NEUTRAL); await frameSubject(id, false); }
      walking.push(await capture(`${variant}-walk-${sample}`, id));
    }
    const movingSamples = walking.filter(s => s.character!.speed > .3 && s.character!.clip === 'walk');
    assert.ok(movingSamples.length >= 4, `${variant}: several samples during actual locomotion`);
    const first = movingSamples[0]!.pose!;
    const poseChange = Math.max(...movingSamples.flatMap(s => Object.entries(s.pose!.localQuaternions).map(([name, q]) => {
      const prior = first.localQuaternions[name];
      return prior ? 1 - Math.abs(q.reduce((sum, value, i) => sum + value * prior[i]!, 0)) : 0;
    })));
    assert.ok(poseChange > .001, `${variant}: evaluated limbs animate across the walking cycle (${poseChange})`);
    records.push({ variant, walkingCycle: { firstTick: walking[0]!.state.tick, lastTick: walking.at(-1)!.state.tick,
      movingSamples: movingSamples.length, quaternionChange: poseChange } });

    // Follow through real movement so the natural AI endpoint/obstacle stop and turn remain local.
    let stop: Npc | null = null, previous = subject(await game.state(page), id);
    for (let ticks = 0; ticks < 3600; ticks += 6) {
      state = await game.step(page, 6, NEUTRAL);
      const c = subject(state, id);
      if (c.clip === 'idle' && c.speed < .15 && (previous.clip === 'walk' || previous.speed > .3)) { stop = c; break; }
      if (ticks % 30 === 0) await frameSubject(id, false);
      previous = c;
    }
    assert.ok(stop, `${variant}: native stop observed`);
    await frameSubject(id, false);
    const stopped = await capture(`${variant}-natural-stop`, id, 160);
    assert.ok(stopped.character!.clip === 'idle' && stopped.character!.speed < .15, `${variant}: captured native stopped pose`);
    const turnStart = stop.yaw;
    const turnTimeline: { tick: number; position: readonly number[]; yaw: number; speed: number; clip: string }[] = [];
    let turned = false;
    // A temporary support/alignment pause may resume the same heading. Observe a
    // later natural direction change independently, rather than requiring every
    // idle transition to reverse within five seconds.
    for (let ticks = 0; ticks < 1800; ticks += 6) {
      state = await game.step(page, 6, NEUTRAL);
      const c = subject(state, id);
      turnTimeline.push({ tick: state.tick, position: c.position, yaw: c.yaw, speed: c.speed, clip: c.clip });
      if (Math.abs(angleDelta(c.yaw, turnStart)) > .25) {
        await capture(`${variant}-natural-turn`, id, 160); turned = true; break;
      }
      if (ticks % 30 === 0) await frameSubject(id, false);
    }
    const replay = await page.evaluate(() => {
      const api = window.__HELSINKI_GAME__!;
      return { seed: api.seed(), commands: api.commands(), events: api.events(-1), hash: api.hash(), finalState: api.state() };
    });
    writeFileSync(path.join(values.out!, `${variant}-walking-replay.json`), JSON.stringify(replay, null, 2) + '\n');
    records.push({ variant, naturalTurn: { stopTick: stopped.state.tick, stop: stopped.character, turnTimeline, turned },
      replay: `${variant}-walking-replay.json` });
    if (!turned) coverageFailures.push(`${variant}: natural direction change not observed`);

    // A fresh native population keeps the lethal test independent of the long walking fixture.
    console.log(`[npc-lifecycle] ${variant}: actual lethal shots and late corpse poses`);
    id = await fresh(variant); state = await frameSubject(id, true);
    const shots: unknown[] = [];
    for (let ticks = 0; ticks < 240 && subject(state, id).alive; ticks++) {
      const c = subject(state, id), dx = c.position[0] - state.player.position[0], dz = c.position[2] - state.player.position[2];
      const yaw = Math.atan2(dx, dz), pitch = Math.atan2(c.position[1] + 1 - state.player.position[1] - 1.62, Math.hypot(dx, dz));
      state = await game.step(page, 1, { ...NEUTRAL, buttons: Button.fire | Button.aim, yaw, pitch });
      shots.push(...state.shots.filter(s => s.shooter === 'player'));
    }
    assert.equal(subject(state, id).health, 0, `${variant}: killed by real shots`);
    assert.ok(shots.some(s => (s as { hitId: string }).hitId === id), `${variant}: shot damage hits selected native subject`);
    const deathTick = state.tick;
    state = await game.step(page, 1, { ...NEUTRAL, buttons: Button.holster });
    // A corpse extends toward the portrait camera. Walk Snow farther away and to
    // its side, then use the normal orbit camera's downward pitch for floor bodies.
    await frameSubject(id, false, true);
    await game.step(page, 30, NEUTRAL);
    for (const seconds of [2, 8, 14]) {
      const now = (await game.state(page)).tick;
      if (now < deathTick + seconds * 60) await game.step(page, deathTick + seconds * 60 - now, NEUTRAL);
      const snapshot = await capture(`${variant}-dead-${seconds}s`, id);
      assertCorpse(snapshot, `${variant} at ${seconds}s`);
    }
    const beforeRender = await inspect(id);
    assert.ok(beforeRender.character!.deathElapsed! >= 14 - 1 / 60, `${variant}: fixed death timeline published`);
    for (let i = 0; i < 5; i++) await page.evaluate(() => window.__HELSINKI_GAME__!.render());
    const afterRender = await inspect(id);
    assertCorpse(afterRender, `${variant}: repeated paused rendering`);
    assert.deepEqual(afterRender.pose!.localQuaternions, beforeRender.pose!.localQuaternions, `${variant}: paused rendering cannot advance or reset death`);
    records.push({ variant, lethal: { id, deathTick, shots, finalTick: afterRender.state.tick, afterRender },
      viewRecreation: 'No native view-only eviction exists: Game.syncViews retains every view while its simulation identity exists. Repeated rendering and late authoritative death samples are covered here; unit mixer fixtures cover a new CharacterView.' });
  }
  assert.deepEqual(coverageFailures, [], 'native movement coverage');
  assert.deepEqual(session.consoleErrors, []);
  writeFileSync(path.join(values.out, 'result.json'), JSON.stringify({ status: 'PASS', release: await game.release(page), bundle,
    browser: session.browser.version(), variants: selectedVariants, records, captures, consoleErrors: session.consoleErrors,
    sourceStart, sourceEnd: sourceSnapshot(), visualReview: 'CAPTURED_NOT_REVIEWED',
    fixture: 'Only player drop-in/camera and normal commands; no NPC, health or animation state mutation.' }, null, 2) + '\n');
} catch (error) {
  writeFileSync(path.join(values.out, 'failure.json'), JSON.stringify({ error: String(error), bundle, sourceStart, sourceEnd: sourceSnapshot(),
    records, captures, consoleErrors: session.consoleErrors }, null, 2));
  throw error;
} finally { await session.close(); }
