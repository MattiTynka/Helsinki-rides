// Decode the shipped ground, compare it with the complete Rapier collision world, then traverse the reported
// stair flights through real keyboard input. The report locates flights; it does not supply measured heights.
// node tools/verify/verify-ground-repair.ts --release apps/game/public/world/ID --cells data/work/REPAIR --url http://127.0.0.1:5317/ --out data/evidence/NEW
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { initPhysics, StaticWorld, type EncodedCommand, type SimState } from '../../packages/sim/src/index.ts';
import type { FileRef, GameplayBundle, RoadGraph, WorldManifest } from '../../packages/world-schema/src/index.ts';
import { game, openGame } from './lib/browser.ts';
import { readRoadGraph, readSimulationPayload } from './lib/simulation-payload.ts';
import { parseGlb } from './glb.ts';

type Point = [number, number, number];
type AxisPoint = [number, number];
interface Spec { id: string; axis: AxisPoint[]; width: number; steps: number }
interface Flight { id: string; parts: string[]; status: string; spec: Spec | null }
interface Check { id: string; pass: boolean; detail: string }
interface Triangle { a: Point; b: Point; c: Point; node: string }
interface Support { visual: number | null; collision: number | null; surface: string | null; safety: number | null }
interface Probe extends Support { flight: string; step: number; across: number; x: number; z: number }
interface Frame { tick: number; wallMs: number; phase: 'approach' | 'flight'; position: readonly number[]; speed: number; clip: string; support: Support; file?: string }
interface Route { id: string; flight: string; direction: string; controls: string[]; fixtureRequest: AxisPoint | null; target: AxisPoint; frames: Frame[]; commands: EncodedCommand[]; start: SimState; end: SimState }

const { values } = parseArgs({ options: {
  release: { type: 'string' }, cells: { type: 'string' }, out: { type: 'string' },
  url: { type: 'string', default: 'http://127.0.0.1:5317/' }, headful: { type: 'boolean', default: false },
  'geometry-only': { type: 'boolean', default: false },
} });
if (!values.release || !values.cells || !values.out) throw new Error('--release, --cells and --out are required');
const out = values.out, releaseDir = values.release;
if (existsSync(out)) throw new Error(`${out} exists; evidence is never overwritten`);
mkdirSync(path.join(out, 'frames'), { recursive: true });
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const manifestBytes = readFileSync(path.join(releaseDir, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
const reportBytes = readFileSync(path.join(values.cells, 'report.json'));
const report = JSON.parse(reportBytes.toString('utf8')) as { stairs: { register: Flight[] } };
const checks: Check[] = [], probes: Probe[] = [], routes: Route[] = [];
const check = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};
const files: Record<string, string> = {};
function load(ref: FileRef): Buffer {
  const bytes = readFileSync(path.join(releaseDir, ref.path)), hash = sha256(bytes);
  if (hash !== ref.sha256 || bytes.length !== ref.bytes) throw new Error(`released bytes differ from manifest: ${ref.path}`);
  files[ref.path] = hash;
  return bytes;
}
const flights = report.stairs.register.filter(f => f.status === 'drawn' && f.spec);
const cathedral = flights.find(f => f.id.includes('460008') || f.parts.includes('460008'));
const university = flights.filter(f => ['472018', '472023', '472024'].some(id => f.id.includes(id) || f.parts.includes(id)));
if (!cathedral?.spec || !university.length) throw new Error('repaired report must locate Cathedral 460008 and University 472018/472023/472024 flights');
check('reported-fixtures', true, `Cathedral ${cathedral.id}; University ${university.map(f => f.id).join(', ')}`);

// This index contains only decoded, transformed render triangles. In particular, integer accessor values must
// be normalized before the quantization scale/translation is applied; treating their raw numbers as metres
// would conceal metre-scale disagreements while appearing to inspect the GLB.
const triangles: Triangle[] = [], buckets = new Map<string, number[]>(), bucketSize = 2;
function addTriangle(triangle: Triangle): void {
  const index = triangles.length;
  triangles.push(triangle);
  const p = [triangle.a, triangle.b, triangle.c];
  for (let ix = Math.floor(Math.min(...p.map(v => v[0])) / bucketSize); ix <= Math.floor(Math.max(...p.map(v => v[0])) / bucketSize); ix++) {
    for (let iz = Math.floor(Math.min(...p.map(v => v[2])) / bucketSize); iz <= Math.floor(Math.max(...p.map(v => v[2])) / bucketSize); iz++) {
      const key = `${ix},${iz}`, list = buckets.get(key) ?? []; list.push(index); buckets.set(key, list);
    }
  }
}
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
let transformedNodes = 0, normalizedAccessors = 0;
// Expanded releases retain the original flights. Decode only cells intersecting those
// probe corridors, rather than retaining millions of unrelated city triangles in this tool.
const corridors = flights.map(flight => {
  const spec = flight.spec!, padding = spec.width / 2 + 10;
  return [Math.min(...spec.axis.map(p => p[0])) - padding, Math.min(...spec.axis.map(p => -p[1])) - padding,
    Math.max(...spec.axis.map(p => p[0])) + padding, Math.max(...spec.axis.map(p => -p[1])) + padding];
});
const renderCells = manifest.cells.filter(cell => {
  const bounds = [...cell.boundsXZ];
  for (const building of cell.buildings) {
    bounds[0] = Math.min(bounds[0]!, building.boundsRuntime.min[0]); bounds[1] = Math.min(bounds[1]!, building.boundsRuntime.min[2]);
    bounds[2] = Math.max(bounds[2]!, building.boundsRuntime.max[0]); bounds[3] = Math.max(bounds[3]!, building.boundsRuntime.max[2]);
  }
  return corridors.some(b => bounds[0]! <= b[2]! && bounds[2]! >= b[0]! && bounds[1]! <= b[3]! && bounds[3]! >= b[1]!);
});
for (const cell of renderCells) {
  const encoded = load(cell.visual.lod0), json = parseGlb(encoded).json as ReturnType<typeof parseGlb>['json'] & { buffers?: { uri?: string }[] };
  if (json.buffers?.some(buffer => buffer.uri !== undefined)) throw new Error('External visual buffers are unsupported');
  for (const image of json.images ?? []) if (image.uri !== undefined) {
    if (!/^\.\.\/textures\/[a-f0-9]{64}\.(?:ktx2|png)$/.test(image.uri)) throw new Error('Unapproved visual image URI');
    const ref = manifest.sharedTextures?.find(texture => texture.path === image.uri!.slice(3));
    if (!ref) throw new Error('Visual image is absent from the pinned shared texture inventory');
    load(ref);
  }
  const doc = await io.read(path.join(releaseDir, cell.visual.lod0.path));
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !(node.getName().includes('_ground_') || mesh.getName().includes('_ground_'))) continue;
    const m = node.getWorldMatrix();
    if (m.some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-8)) transformedNodes++;
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) throw new Error('ground primitive is not triangles');
      const pos = primitive.getAttribute('POSITION'), indices = primitive.getIndices();
      if (!pos) throw new Error('ground primitive has no positions');
      if (pos.getNormalized()) normalizedAccessors++;
      const vertices: Point[] = [];
      for (let i = 0; i < pos.getCount(); i++) {
        const p = pos.getElement(i, []);
        vertices.push([
          m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
          m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
          m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
        ]);
      }
      const count = indices?.getCount() ?? vertices.length;
      const index = (i: number) => indices?.getScalar(i) ?? i;
      for (let i = 0; i < count; i += 3) addTriangle({ a: vertices[index(i)]!, b: vertices[index(i + 1)]!, c: vertices[index(i + 2)]!, node: node.getName() });
    }
  }
}
check('decoded-ground', triangles.length > 0, `${triangles.length} triangles; ${transformedNodes} transformed nodes, ${normalizedAccessors} normalized position accessors`);
function visualHeight(x: number, z: number): number | null {
  let highest = -Infinity;
  for (const index of buckets.get(`${Math.floor(x / bucketSize)},${Math.floor(z / bucketSize)}`) ?? []) {
    const { a, b, c } = triangles[index]!;
    const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(det) < 1e-10) continue; // Vertical wall/riser is not a horizontal support.
    const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
    const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) highest = Math.max(highest, u * a[1] + v * b[1] + (1 - u - v) * c[1]);
  }
  return Number.isFinite(highest) ? highest : null;
}
await initPhysics();
const terrain = await readSimulationPayload(releaseDir, manifest.terrain), roads = await readRoadGraph(releaseDir,manifest.roads);
const gameplay = JSON.parse(load(manifest.gameplay).toString('utf8')) as GameplayBundle;
const collisionWorld = StaticWorld.fromBytes(terrain, roads, gameplay);
const safetyWorld = StaticWorld.fromBytes(terrain, roads, gameplay);
for (const cell of manifest.cells) collisionWorld.addCell(cell.id, await readSimulationPayload(releaseDir, cell.collision));
collisionWorld.physics.step(); safetyWorld.physics.step();
function supportAt(x: number, z: number): Support {
  const visual = visualHeight(x, z), rayY = (visual ?? collisionWorld.groundHeight(x, z)) + 20;
  const collision = collisionWorld.groundBelow(x, rayY, z, 100), safety = safetyWorld.groundBelow(x, rayY, z, 100);
  return { visual, collision: collision?.y ?? null, surface: collision?.surface?.group ?? null, safety: safety?.y ?? null };
}
function frame(spec: Spec) {
  const first = spec.axis[0]!, last = spec.axis.at(-1)!;
  let a: AxisPoint = [first[0], -first[1]], b: AxisPoint = [last[0], -last[1]];
  // The builder's register axis is normally uphill; determine direction from the exported mesh itself.
  const at = (t: number) => visualHeight(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  if ((at(0.1) ?? 0) > (at(0.9) ?? 0)) [a, b] = [b, a];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u: AxisPoint = [(b[0] - a[0]) / length, (b[1] - a[1]) / length], v: AxisPoint = [-u[1], u[0]];
  return { a, b, u, v, length, at: (along: number, across: number): AxisPoint => [a[0] + u[0] * along + v[0] * across, a[1] + u[1] * along + v[1] * across] };
}

for (const flight of flights) {
  const spec = flight.spec!, f = frame(spec), start = probes.length;
  // Every tread at quarter/mid/three-quarter depth, across its full width including both edge strips.
  const acrossValues = [...new Set([-spec.width / 2 + 0.15, -spec.width / 4, 0, spec.width / 4, spec.width / 2 - 0.15])];
  for (let step = 0; step < spec.steps; step++) for (const depth of [0.25, 0.5, 0.75]) for (const across of acrossValues) {
    const [x, z] = f.at((step + depth) * f.length / spec.steps, across);
    probes.push({ flight: flight.id, step, across, x, z, ...supportAt(x, z) });
  }
  const p = probes.slice(start), missing = p.filter(s => s.visual === null || s.collision === null);
  const differences = p.map(s => s.visual !== null && s.collision !== null ? Math.abs(s.visual - s.collision) : Infinity);
  const worst = Math.max(...differences), falseSafety = p.filter(s => s.visual !== null && s.safety !== null && s.safety > s.visual + 0.035);
  const nonGround = p.filter(s => s.surface !== 'ground');
  check(`mesh-collision-${flight.id}`, !missing.length && worst <= 0.035 && !nonGround.length,
    `${p.length} samples; max visual/collider delta ${worst.toFixed(4)} m; missing ${missing.length}; non-ground hits ${nonGround.length}`);
  check(`safety-terrain-${flight.id}`, !falseSafety.length, `${falseSafety.length} safety-heightfield hits above the visible stair by >35 mm`);
  let maxTreadSpread = 0;
  for (let step = 0; step < spec.steps; step++) {
    const heights = p.filter(s => s.step === step && s.visual !== null).map(s => s.visual!);
    if (heights.length) maxTreadSpread = Math.max(maxTreadSpread, Math.max(...heights) - Math.min(...heights));
  }
  check(`flat-treads-${flight.id}`, maxTreadSpread <= 0.035, `max height spread within one exported tread ${maxTreadSpread.toFixed(4)} m`);
}
writeFileSync(path.join(out, 'geometry.json'), JSON.stringify({ probes, checks, triangles: triangles.length }, null, 2) + '\n');

let consoleErrors: string[] = [], failure: string | null = null;
const browserAssets: Record<string, string> = {};
if (!values['geometry-only']) {
  const url = new URL(values.url);
  url.searchParams.set('review', '1'); url.searchParams.set('release', manifest.worldReleaseId);
  const session = await openGame(url.toString(), { headful: values.headful, width: 1200, height: 850, videoDir: path.join(out, 'video') });
  const { page } = session, held = new Set<string>();
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const keys = async (next: readonly string[]) => {
    for (const key of [...held]) if (!next.includes(key)) { await page.keyboard.up(key); held.delete(key); }
    for (const key of next) if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
  };
  type WindowApi = Window & { __HELSINKI_GAME__: { commands(): EncodedCommand[]; reset(): void } };
  const commands = () => page.evaluate(() => (window as unknown as WindowApi).__HELSINKI_GAME__.commands());
  async function traverse(id: string, flight: Flight, across: number, direction: 'ascent' | 'descent', walk: boolean, fixture: boolean): Promise<void> {
    const f = frame(flight.spec!), forward = direction === 'ascent';
    const from = f.at(forward ? -0.8 : f.length + 0.5, across), target = f.at(forward ? f.length + 0.5 : -0.8, across);
    await keys([]); await game.setCommand(page, null);
    if (fixture) {
      await game.pause(page);
      await page.evaluate(() => (window as unknown as WindowApi).__HELSINKI_GAME__.reset());
      await game.teleport(page, from[0], from[1]);
      await game.resume(page); await sleep(300);
    }
    const start = await game.state(page), logStart = (await commands()).length;
    const controls = walk ? ['KeyW', 'AltLeft'] : ['KeyW'];
    const frames: Frame[] = [], started = Date.now();
    let nextImage = 0;
    let approaching = fixture, progressPosition = start.player.position, progressTime = Date.now();
    // The existing adapter deliberately snaps its teleport request to a road. Walk from that actual position
    // to the foot of the flight; only then start the stair leg. Record both legs, never relabel the road fixture
    // as a successful teleport onto the requested stair coordinates.
    const approachDistance = Math.hypot(start.player.position[0] - from[0], start.player.position[2] - from[1]);
    const timeout = (f.length + 1.3) / (walk ? 1.4 : 3.6) * 2.8 + approachDistance / 3.6 * 2 + 6;
    while ((Date.now() - started) / 1000 < timeout) {
      const state = await game.state(page), [x, y, z] = state.player.position;
      if (approaching && Math.hypot(from[0] - x, from[1] - z) < 0.28) approaching = false;
      const next = approaching ? from : target;
      await game.setCamera(page, Math.atan2(next[0] - x, next[1] - z), -0.14);
      await keys(approaching ? ['KeyW'] : controls);
      const wallMs = Date.now() - started;
      const sample: Frame = { tick: state.tick, wallMs, phase: approaching ? 'approach' : 'flight', position: [x, y, z], speed: state.player.speed, clip: state.player.clip, support: supportAt(x, z) };
      if (wallMs >= nextImage) {
        sample.file = `frames/${id}-${String(frames.length).padStart(4, '0')}.jpg`;
        await page.screenshot({ path: path.join(out, sample.file), type: 'jpeg', quality: 90 });
        nextImage = wallMs + 500;
      }
      frames.push(sample);
      if (Math.hypot(x - progressPosition[0], z - progressPosition[2]) > 0.4) { progressPosition = state.player.position; progressTime = Date.now(); }
      if ((!approaching && Math.hypot(target[0] - x, target[1] - z) < 0.28) || state.player.mode !== 'onFoot' || Date.now() - progressTime > 6500) break;
      await sleep(80);
    }
    await keys([]); await sleep(250);
    const end = await game.state(page), trace = (await commands()).slice(logStart);
    routes.push({ id, flight: flight.id, direction, controls, fixtureRequest: fixture ? from : null, target, frames, commands: trace, start, end });
    const endDistance = Math.hypot(end.player.position[0] - target[0], end.player.position[2] - target[1]);
    const onFlight = frames.filter(s => {
      const x = s.position[0]! - f.a[0], z = s.position[2]! - f.a[1], along = x * f.u[0] + z * f.u[1];
      return s.phase === 'flight' && along >= 0 && along <= f.length;
    });
    const missing = onFlight.filter(s => s.support.visual === null);
    const worstBelow = Math.max(0, ...onFlight.map(s => (s.support.visual ?? s.position[1]!) - s.position[1]!));
    const worstAbove = Math.max(0, ...onFlight.map(s => s.position[1]! - (s.support.visual ?? s.position[1]!)));
    check(`${id}-progress`, !approaching && endDistance < 0.6 && onFlight.length >= 4, `${endDistance.toFixed(2)} m from target; ${onFlight.length} samples on stairs; road approach ${approaching ? 'not completed' : 'completed'}`);
    check(`${id}-feet-support`, onFlight.length >= 4 && !missing.length && worstBelow <= 0.05 && worstAbove <= 0.5,
      `capsule feet max below ${worstBelow.toFixed(3)} m, above ${worstAbove.toFixed(3)} m; missing visual support ${missing.length}; pose-level shoe contact requires visual review`);
    check(`${id}-real-input`, trace.some(c => c[1] > 0 && (walk ? c[1] < 512 : c[1] === 1024)), `${trace.length} recorded commands; ${controls.join(' + ')}`);
    await page.screenshot({ path: path.join(out, 'frames', `${id}-end.png`) });
    if (!forward) {
      for (const [label, offset] of [['uphill', 0], ['left-join', -0.6], ['right-join', 0.6]] as const) {
        await game.setCamera(page, Math.atan2(f.u[0], f.u[1]) + offset, 0.04); await sleep(400);
        await page.screenshot({ path: path.join(out, 'frames', `${id}-${label}.png`) });
      }
    }
  }
  try {
    await game.start(page);
    check('browser-release', await game.release(page) === manifest.worldReleaseId, manifest.worldReleaseId);
    // Compare bytes actually served by this browser's origin. A query-selected release must not accidentally
    // pass against local files while the browser receives an old terrain/collider under an unchanged name.
    const refs = [{ path: 'manifest.json', sha256: sha256(manifestBytes), bytes: manifestBytes.length }, manifest.terrain, ...manifest.cells.map(c => c.collision)];
    for (const [index, ref] of refs.entries()) {
      const stored = await page.evaluate(async ({ release, file }) => {
        const entry = performance.getEntriesByType('resource').find(resource => new URL(resource.name).pathname.endsWith(`/world/${release}/manifest.json`));
        if (!entry || new URL(entry.name).origin !== location.origin) throw new Error('Missing same-origin manifest request');
        const response = await fetch(new URL(file, entry.name), { cache: 'no-store', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`asset ${file}: HTTP ${response.status}`);
        const bytes = await response.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes);
        return { bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
      }, { release: manifest.worldReleaseId, file: ref.path });
      browserAssets[ref.path] = stored.sha256;
      if (stored.bytes !== ref.bytes || stored.sha256 !== ref.sha256) throw new Error(`browser bytes differ: ${ref.path}`);
      if (index % 64 === 0) console.log(`Checked browser simulation payload ${index + 1}/${refs.length}`);
    }
    check('browser-collision-bytes', true, `manifest, terrain and ${manifest.cells.length} HCOL payloads match the independent geometry probe`);
    await traverse('cathedral-centre-up-walk', cathedral, 0, 'ascent', true, true);
    await traverse('cathedral-centre-down-run', cathedral, 0, 'descent', false, false);
    const cf = frame(cathedral.spec), edge = cf.v[0] > 0 ? -cathedral.spec.width / 2 + 1 : cathedral.spec.width / 2 - 1;
    await traverse('cathedral-west-up-walk', cathedral, edge, 'ascent', true, true);
    await traverse('cathedral-west-down-run', cathedral, edge, 'descent', false, false);
    for (const flight of university) {
      const id = flight.id.replace(/[^a-z0-9_-]/gi, '-');
      await traverse(`${id}-up-walk`, flight, 0, 'ascent', true, true);
      await traverse(`${id}-down-run`, flight, 0, 'descent', false, false);
    }
    check('browser-console', session.consoleErrors.length === 0, `${session.consoleErrors.length} browser errors`);
  } catch (error) { failure = String(error); check('browser-completed', false, failure); }
  finally {
    await keys([]); consoleErrors = session.consoleErrors;
    writeFileSync(path.join(out, 'console.log'), session.consoleLines.join('\n') + '\n');
    await session.close();
  }
}
collisionWorld.physics.free(); safetyWorld.physics.free();
const result = {
  status: checks.every(c => c.pass) && !failure ? 'PASS' : 'RETHINK', visualReview: 'CAPTURED_NOT_REVIEWED',
  release: manifest.worldReleaseId, manifestSha256: sha256(manifestBytes), reportSha256: sha256(reportBytes),
  verifierSha256: sha256(readFileSync(import.meta.filename)), files, browserAssets, checks, failure, consoleErrors, routes,
  limits: ['Fixtures locate each independent flight; these runs do not prove reachability from spawn.',
    'Support measurements use the capsule feet origin. Animated shoe contact, wall appearance and posture require opening captures.',
    'GLB point probes cover reported stair flights; the stationary wall views must be inspected for openings and intersecting faces.'],
};
writeFileSync(path.join(out, 'ground-repair.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${result.status}: ${checks.filter(c => c.pass).length}/${checks.length} checks; ${out}`);
if (result.status !== 'PASS') process.exitCode = 1;
