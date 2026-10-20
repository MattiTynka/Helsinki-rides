// The redistributable supplied extra car in the current full city: real keyboard approach,
// entry, driving and exit, followed by a fresh deterministic Node replay.
// node tools/verify/verify-extra-cars.mjs --url http://127.0.0.1:5317/?review=1 --release PATH/TO/RELEASE --out FRESH_EVIDENCE_DIR
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import validator from 'gltf-validator';
import { decodeCommand, initPhysics, Simulation, StaticWorld, yawOf } from '../../packages/sim/src/index.ts';
import { validateGameplayBundle, validateWorldManifest } from '../../packages/world-schema/src/index.ts';
import { parseGlb, worldMatrices, nodeBounds, transformPoint, triangleCount } from './glb.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5317/?review=1' },
  release: { type: 'string' }, out: { type: 'string' }, headful: { type: 'boolean', default: false },
} });
if (!values.release || !values.out || existsSync(values.out)) throw new Error('--release and a fresh --out are required');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = readFileSync(path.join(values.release, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.deepEqual(validateWorldManifest(manifest), []);
assert.ok(manifest.cells.length >= 304, 'verify the current expanded city, never the historical 69-cell world');
function payload(ref) {
  const bytes = readFileSync(path.join(values.release, ref.path));
  assert.equal(bytes.length, ref.bytes, `${ref.path}: byte count`);
  assert.equal(sha(bytes), ref.sha256, `${ref.path}: hash`);
  return bytes;
}
const gameplay = JSON.parse(payload(manifest.gameplay).toString('utf8'));
assert.deepEqual(validateGameplayBundle(gameplay), []);
const restrictedVehicle = value => typeof value === 'string' && /^(?:vehicle[-_]?)?(?:kaamos|gt[-_]?40)(?:[-_.][A-Za-z0-9_.-]+)?$/i.test(value);
assert.ok(!manifest.assets.some(asset => restrictedVehicle(asset.id) || restrictedVehicle(path.basename(asset.path, path.extname(asset.path)))),
  'the published world excludes nonredistributable vehicle assets');
assert.ok(!gameplay.vehicleDefinitions.some(definition => [definition.id, definition.assetId, definition.interaction?.poses].some(restrictedVehicle)),
  'the current gameplay excludes nonredistributable vehicle definitions');
assert.ok(!gameplay.vehicles.some(spawn => restrictedVehicle(spawn.id) || restrictedVehicle(spawn.definition)),
  'the current gameplay excludes nonredistributable vehicle spawns');
const cars = [
  { id: 'revontuli', vehicleId: 'car-3', sha256: '7e35d6a031433dbd4054a587da8195737dddddb3c87efc950e9ffd403c0262e7', triangles: 36743 },
];
const assetChecks = [];
for (const car of cars) {
  car.definition = gameplay.vehicleDefinitions.find(d => d.id === car.id);
  assert.ok(car.definition, `${car.id}: gameplay definition`);
  assert.equal(gameplay.vehicles.find(v => v.id === car.vehicleId)?.definition, car.id);
  car.asset = manifest.assets.find(a => a.id === `vehicle-${car.id}`);
  assert.ok(car.asset && car.asset.kind === 'vehicle');
  assert.equal(car.asset.sha256, car.sha256, `${car.id}: accepted exported model`);
  car.poses = read(`content/assets/finn-vehicle-poses-${car.id}.json`);
  const contract = read(`content/assets/vehicle-${car.id}.contract.json`);
  assert.equal(car.poses.carSha256, car.sha256);
  assert.equal(manifest.assets.find(a => a.id === 'character-snow')?.sha256, car.poses.sourcePackagedSha256,
    'use the Finn skin these cabin poses were authored for');
  const { poses, ...interaction } = car.definition.interaction;
  assert.equal(poses, car.id);
  assert.deepEqual(interaction, car.poses.interaction);
  const bytes = payload(car.asset), glb = parseGlb(bytes), json = glb.json;
  const validation = await validator.validateBytes(bytes, { maxIssues: 100 });
  assert.equal(validation.issues.numErrors, 0, `${car.id}: Khronos glTF validation`);
  const required = [contract.nodes.root, contract.nodes.body, ...contract.nodes.wheels, ...contract.nodes.doors,
    contract.nodes.steeringWheel, 'WINDSHIELD', ...contract.sockets.map(s => s.node)];
  for (const name of required) assert.ok(json.nodes.some(node => node.name === name), `${car.id}: ${name}`);
  assert.equal(triangleCount(json), car.triangles);
  assert.ok(car.triangles <= contract.budgets.triangles && bytes.length <= contract.budgets.fileBytes);
  assert.ok(json.materials.length <= contract.budgets.materials);
  assert.equal(json.textures?.length ?? 0, 0, `${car.id}: no new texture residency`);
  const matrices = worldMatrices(json), bodyIndex = json.nodes.findIndex(n => n.name === contract.nodes.body);
  const bounds = nodeBounds(json, bodyIndex, matrices.get(bodyIndex));
  assert.ok(bounds);
  const dimensions = { lengthM: bounds.max[2] - bounds.min[2], widthM: bounds.max[0] - bounds.min[0], heightM: bounds.max[1] };
  for (const [name, value] of Object.entries(dimensions)) {
    const range = contract.expectedDimensions[name];
    assert.ok(value >= range[0] && value <= range[1], `${car.id}: ${name} ${value}`);
  }
  const hub = name => transformPoint(matrices.get(json.nodes.findIndex(n => n.name === name)), [0, 0, 0]);
  const fl = hub('WHEEL_FL'), fr = hub('WHEEL_FR'), rl = hub('WHEEL_RL');
  assert.ok(fl[0] > 0 && fr[0] < 0 && fl[2] > rl[2], `${car.id}: wheel axes`);
  const wheelbase = fl[2] - rl[2], [minimum, maximum] = contract.expectedDimensions.wheelbaseM;
  assert.ok(wheelbase >= minimum && wheelbase <= maximum);
  assetChecks.push({ id: car.id, sha256: car.sha256, bytes: bytes.length, triangles: car.triangles,
    materials: json.materials.length, dimensions, wheelbase, validatorErrors: validation.issues.numErrors,
    validatorWarnings: validation.issues.numWarnings });
}

mkdirSync(values.out, { recursive: true });
const frames = [], interactions = [], trips = [];
let session, failure = null, recording = null, replay = null, browserIdentity = null;
const held = new Set();
const out = name => path.join(values.out, name);
try {
  session = await openGame(values.url, { headful: values.headful, timeoutMs: 240000 });
  const { page } = session;
  await game.pause(page);
  await game.start(page);
  await game.setCommand(page, null);
  assert.equal(await game.release(page), manifest.worldReleaseId);
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  const manifestUrl = resources.find(url => new URL(url).pathname.endsWith(`/${manifest.worldReleaseId}/manifest.json`));
  assert.ok(manifestUrl, 'the page downloaded the selected manifest');
  const servedManifest = await page.request.get(manifestUrl);
  assert.ok(servedManifest.ok());
  assert.deepEqual(await servedManifest.body(), manifestBytes, 'served and local world manifests are byte-identical');
  for (const car of cars) {
    const loaded = resources.find(url => new URL(url).pathname.endsWith(`/${car.asset.path}`));
    assert.ok(loaded, `${car.id}: the runtime requested its asset before inspection`);
    const response = await page.request.get(loaded);
    assert.ok(response.ok());
    assert.equal(sha(await response.body()), car.sha256, `${car.id}: served model is the accepted model`);
  }
  const script = await page.locator('script[type="module"][src]').first().getAttribute('src');
  assert.ok(script && /\/assets\/index-[\w-]+\.js$/.test(new URL(script, values.url).pathname), 'verify a compiled review build');
  const runtime = await page.request.get(new URL(script, values.url).href);
  assert.ok(runtime.ok());
  browserIdentity = { browser: session.browser.version(), script, sha256: sha(await runtime.body()) };
  const key = async (code, down) => {
    if (down && !held.has(code)) { await page.keyboard.down(code); held.add(code); }
    if (!down && held.has(code)) { await page.keyboard.up(code); held.delete(code); }
  };
  const releaseKeys = async () => { for (const code of [...held]) await key(code, false); };
  const vehicle = (state, id) => {
    const result = state.vehicles.find(v => v.id === id);
    assert.ok(result, `${id}: vehicle remains in the simulation`);
    return result;
  };
  const checkAlive = state => assert.ok(state.player.health > 0 && !['wasted', 'busted'].includes(state.player.mode),
    `interaction remains playable at tick ${state.tick}`);
  async function capture(car, label, inspectPose = false) {
    const state = await game.state(page);
    await game.awaitVisuals(page);
    await page.evaluate(() => window.__HELSINKI_GAME__.render());
    const pose = inspectPose ? await page.evaluate(() => window.__HELSINKI_GAME__.vehiclePose()) : null;
    if (inspectPose) {
      assert.ok(pose && pose.visible && pose.vehicleId === car.vehicleId, 'the actual native Finn remains visible in this car');
      assert.ok(Object.keys(pose.bones).length >= 71);
      assert.ok([...Object.values(pose.bones).flat(), ...pose.bounds.min, ...pose.bounds.max].every(Number.isFinite));
      assert.ok(pose.doors.DOOR_FL && pose.doors.DOOR_FR, 'both rigged doors are present');
    }
    const presentation = await page.evaluate(() => window.__HELSINKI_GAME__.presentation());
    assert.ok(presentation.player.visible);
    assert.ok(presentation.vehicles.some(v => v.id === car.vehicleId));
    assert.deepEqual(session.consoleErrors, []);
    const screenshot = `${car.id}-${label}.png`;
    await page.screenshot({ path: out(screenshot) });
    frames.push({ car: car.id, label, tick: state.tick, screenshot, player: state.player, vehicle: vehicle(state, car.vehicleId), pose });
    console.log(`[extra-cars] ${car.id} ${label}: tick ${state.tick}, ${state.player.mode}`);
    return { state, pose };
  }
  async function advance(label, predicate, maxTicks, chunk = 3) {
    let state = await game.state(page), ticks = 0;
    while (!predicate(state) && ticks < maxTicks) {
      const amount = Math.min(chunk, maxTicks - ticks);
      state = await game.step(page, amount); ticks += amount; checkAlive(state);
    }
    assert.ok(predicate(state), `${label}: timeout at tick ${state.tick}, ${state.player.mode}/${state.player.vehicleInteraction?.stage ?? 'none'}`);
    return state;
  }
  async function walkTo(target, stopWithin, maxTicks = 1200) {
    let state = await game.state(page);
    await key('KeyW', true);
    try {
      let ticks = 0;
      while (Math.hypot(target[0] - state.player.position[0], target[1] - state.player.position[2]) > stopWithin && ticks < maxTicks) {
        await game.setCamera(page, Math.atan2(target[0] - state.player.position[0], target[1] - state.player.position[2]), -.14);
        state = await game.step(page, 3); ticks += 3; checkAlive(state);
      }
      assert.ok(Math.hypot(target[0] - state.player.position[0], target[1] - state.player.position[2]) <= stopWithin,
        `keyboard approach reaches ${target.join(',')}, got ${state.player.position.join(',')}`);
      return state;
    } finally { await key('KeyW', false); }
  }
  let state = await game.state(page);
  for (const car of cars) {
    assert.equal(vehicle(state, car.vehicleId).definition, car.id);
  }
  for (const car of cars) {
    const startTick = state.tick, initialCar = vehicle(state, car.vehicleId), yaw = yawOf(initialCar.rotation);
    const stage = car.definition.interaction.stage;
    const target = [initialCar.position[0] + Math.cos(yaw) * stage[0] + Math.sin(yaw) * stage[2],
      initialCar.position[2] - Math.sin(yaw) * stage[0] + Math.cos(yaw) * stage[2]];
    // The car row is north of this waypoint. Walking around its back avoids the
    // parked Lumi GT and the neighbouring extra car without moving any entity.
    state = await walkTo([target[0], Math.max(17, initialCar.position[2] + 7)], .65);
    state = await walkTo(target, .65);
    assert.equal(state.player.nearVehicle, car.vehicleId, 'real approach selects the requested car');
    await game.setCamera(page, Math.atan2(initialCar.position[0] - state.player.position[0], initialCar.position[2] - state.player.position[2]), -.14);
    await capture(car, 'approach');
    const drawn = await page.evaluate(() => window.__HELSINKI_GAME__.renderBreakdown());
    assert.ok(drawn.groups.some(group => group.id === `vehicle:${car.vehicleId}` && group.triangles > 0), `${car.id}: loaded asset submits visible geometry`);
    await page.keyboard.press('KeyF'); state = await game.step(page, 1);
    assert.equal(state.player.mode, 'entering');
    state = await advance(`${car.id} entry`, s => s.player.vehicleInteraction?.stage === 'enter', 900, 1);
    const beginning = await capture(car, 'entry-begin', true);
    state = await advance(`${car.id} entry midpoint`, s => s.player.vehicleInteraction?.stage === 'enter' && s.player.vehicleInteraction.progress >= .5, 240, 1);
    const middle = await capture(car, 'entry-middle', true);
    const dot = Math.abs(beginning.pose.doors.DOOR_FL.reduce((sum, value, i) => sum + value * middle.pose.doors.DOOR_FL[i], 0));
    assert.ok(2 * Math.acos(Math.min(1, dot)) > .1, `${car.id}: driver door visibly opens during entry`);
    state = await advance(`${car.id} seated`, s => s.player.mode === 'driving', 300, 1);
    assert.equal(state.player.inVehicle, car.vehicleId);
    await capture(car, 'seated', true);
    const beforeDrive = [...vehicle(state, car.vehicleId).position];
    await key('KeyW', true); state = await game.step(page, 60); await key('KeyW', false);
    const distance = Math.hypot(vehicle(state, car.vehicleId).position[0] - beforeDrive[0], vehicle(state, car.vehicleId).position[2] - beforeDrive[2]);
    assert.ok(distance >= 1, `${car.id}: real throttle moves the car, got ${distance} m`);
    await capture(car, 'driving', true);
    await key('Space', true);
    state = await advance(`${car.id} braking`, s => vehicle(s, car.vehicleId).speed <= .25, 900);
    await key('Space', false);
    await page.keyboard.press('KeyF'); state = await game.step(page, 1);
    assert.equal(state.player.mode, 'exiting');
    const exitClip = state.player.vehicleInteraction.clip;
    state = await advance(`${car.id} exit midpoint`, s => s.player.vehicleInteraction?.stage === 'exit' && s.player.vehicleInteraction.progress >= .5, 600, 1);
    await capture(car, 'exit-middle', true);
    state = await advance(`${car.id} on foot`, s => s.player.mode === 'onFoot', 600, 1);
    assert.equal(state.player.inVehicle, null);
    assert.equal(state.player.vehicleInteraction, null);
    await capture(car, 'after-exit');
    trips.push({ id: car.id, vehicleId: car.vehicleId, startTick, endTick: state.tick, drivenMetres: distance, exitClip });
    interactions.push(...await game.events(page, startTick));
    await releaseKeys();
  }
  assert.deepEqual(session.consoleErrors, []);
  recording = await page.evaluate(() => {
    const api = window.__HELSINKI_GAME__;
    return { release: api.release, seed: api.seed(), ending: 'extra-cars-upright', ticks: api.tick(), hash: api.hash(), commands: api.commands() };
  });
  assert.equal(recording.commands.length, recording.ticks, 'review recording includes every boot and interaction tick');
  writeFileSync(out('recording.json'), JSON.stringify(recording));
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  if (session) await session.page.screenshot({ path: out('failure.png') }).catch(() => {});
} finally {
  if (session) {
    for (const code of [...held, 'KeyF']) await session.page.keyboard.up(code).catch(() => {});
    await session.close();
  }
}

// Release the browser before constructing another complete collision world.
if (!failure && recording) {
  let world, sim;
  try {
    await initPhysics();
    world = StaticWorld.fromBytes(new Uint8Array(payload(manifest.terrain)), JSON.parse(payload(manifest.roads).toString('utf8')), gameplay);
    for (const cell of manifest.cells) world.addCell(cell.id, new Uint8Array(payload(cell.collision)));
    sim = new Simulation(world, { seed: recording.seed });
    for (const command of recording.commands) sim.step(decodeCommand(command));
    replay = { hash: sim.hash(), ticks: sim.tick, mode: sim.mode };
    assert.equal(replay.hash, recording.hash, 'fresh Node replay matches the browser state hash');
    assert.equal(replay.ticks, recording.ticks);
    console.log(`[extra-cars] PASS ${cars.length} keyboard cycle and ${recording.ticks}-tick Node replay (${replay.hash})`);
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    sim?.eventQueue.free();
    world?.physics.free();
  }
}
writeFileSync(out('results.json'), JSON.stringify({
  status: failure ? 'FAIL' : 'PASS', failure, url: values.url,
  world: { release: manifest.worldReleaseId, manifestSha256: sha(manifestBytes), cells: manifest.cells.length },
  runtime: browserIdentity, assetChecks, trips, interactions, frames,
  recording: recording ? { file: 'recording.json', ticks: recording.ticks, hash: recording.hash, seed: recording.seed } : null,
  replay, consoleErrors: session?.consoleErrors ?? [],
  input: 'Real keyboard from ordinary spawn. The native review API only controls camera, fixed-tick timing and read-only inspection; no teleports, resets or scripted simulation commands.',
  visualReview: 'CAPTURED_NOT_REVIEWED',
}, null, 2) + '\n');
if (failure) { console.error(failure); process.exitCode = 1; }
