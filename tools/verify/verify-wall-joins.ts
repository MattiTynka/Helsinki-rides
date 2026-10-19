// Exported-geometry regression for gaps in the sides of stairs and retaining walls. Downward support rays cannot
// see these holes: cast horizontal and oblique rays through the height difference, respecting material culling.
// node tools/verify/verify-wall-joins.ts --release apps/game/public/world/ID --cells data/work/CELLS --out data/evidence/NEW
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { geodeticToGk25, type WorldManifest } from '../../packages/world-schema/src/index.ts';

type V = [number, number, number];
interface Triangle { a: V; b: V; c: V; doubleSided: boolean; node: string; cell: string }
interface Spec { id: string; axis: [number, number][]; width: number; steps: number }
interface Hit { distance: number; triangle: number; node: string; cell: string }
interface Probe { id: string; flight: string; step: number; side: number; origin: V; direction: V; maxDistance: number; visibleHit: Hit | null; twoSidedHit: Hit | null; low: number; high: number; kind: 'known-regression' | 'side-join' | 'top-landing-join' | 'finite-wall-end'; }
const { values } = parseArgs({ options: { release: { type: 'string' }, cells: { type: 'string' }, out: { type: 'string' }, osm: { type: 'string', default: 'data/raw/osm/senate-district.json' } } });
if (!values.release || !values.cells || !values.out) throw new Error('--release, --cells and --out are required');
const out = values.out, release = values.release;
if (existsSync(out)) throw new Error(`${out} exists; evidence is not overwritten`);
mkdirSync(out, { recursive: true });
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const manifestBytes = readFileSync(path.join(release, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
const reportBytes = readFileSync(path.join(values.cells, 'report.json'));
const report = JSON.parse(reportBytes.toString('utf8')) as { inputs: { osm: { sha256: string } }; stairs: { register: { id: string; status: string; spec: Spec | null; osmWay: string | null }[]; flights: { id: string; steps: number; width: number }[] } };
const specs = report.stairs.register.flatMap(f => f.status === 'drawn' && f.spec ? [f.spec] : []);
// Include the remaining OSM flight, not just the register-derived ones. Its source chord is geographic data;
// resolve it from the frozen snapshot, not from the implementation's generated faces or private helpers.
const uncovered = report.stairs.flights.filter(f => !specs.some(s => s.id === f.id));
let osmSha256: string | null = null;
if (uncovered.length) {
  const osmBytes = readFileSync(values.osm), osm = JSON.parse(osmBytes.toString('utf8')) as { elements: { type: string; id: number; lon?: number; lat?: number; nodes?: number[] }[] };
  osmSha256 = sha256(osmBytes);
  if (osmSha256 !== report.inputs.osm.sha256) throw new Error('OSM snapshot differs from the cell report');
  const nodes = new Map(osm.elements.filter(e => e.type === 'node').map(e => [e.id, e]));
  for (const flight of uncovered) {
    const way = osm.elements.find(e => e.type === 'way' && `osm-way-${e.id}` === flight.id);
    if (!way?.nodes?.length) throw new Error(`cannot locate unverified flight ${flight.id}`);
    const axis = way.nodes.map(id => {
      const node = nodes.get(id); if (node?.lat === undefined || node.lon === undefined) throw new Error(`OSM node ${id} missing`);
      const [east, north] = geodeticToGk25(node.lat, node.lon);
      return [east - manifest.origin.originProjected[0], north - manifest.origin.originProjected[1]] as [number, number];
    });
    specs.push({ id: flight.id, axis, steps: flight.steps, width: flight.width });
  }
}
const triangles: Triangle[] = [], buckets = new Map<string, Set<number>>(), bucketSize = 2;
const files: Record<string, string> = {};
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const cell of manifest.cells) {
  const ref = cell.visual.lod0, bytes = readFileSync(path.join(release, ref.path)), hash = sha256(bytes);
  if (hash !== ref.sha256 || bytes.length !== ref.bytes) throw new Error(`manifest mismatch ${ref.path}`);
  files[ref.path] = hash;
  const doc = await io.readBinary(bytes);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !node.getName().includes('_ground_')) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const positions = prim.getAttribute('POSITION'), indices = prim.getIndices();
      if (!positions || prim.getMode() !== 4) throw new Error('ground primitive requires triangle positions');
      const vertices: V[] = [];
      for (let i = 0; i < positions.getCount(); i++) {
        const p = positions.getElement(i, []);
        vertices.push([m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!]);
      }
      const count = indices?.getCount() ?? vertices.length, idx = (i: number) => indices?.getScalar(i) ?? i;
      for (let i = 0; i < count; i += 3) {
        const tri: Triangle = { a: vertices[idx(i)]!, b: vertices[idx(i + 1)]!, c: vertices[idx(i + 2)]!, doubleSided: prim.getMaterial()?.getDoubleSided() ?? false, node: node.getName(), cell: cell.id };
        const index = triangles.length; triangles.push(tri);
        const pts = [tri.a, tri.b, tri.c];
        for (let x = Math.floor(Math.min(...pts.map(p => p[0])) / bucketSize); x <= Math.floor(Math.max(...pts.map(p => p[0])) / bucketSize); x++) {
          for (let z = Math.floor(Math.min(...pts.map(p => p[2])) / bucketSize); z <= Math.floor(Math.max(...pts.map(p => p[2])) / bucketSize); z++) {
            const key = `${x},${z}`, list = buckets.get(key) ?? new Set<number>(); list.add(index); buckets.set(key, list);
          }
        }
      }
    }
  }
}
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v: V): V => { const n = Math.hypot(...v); return v.map(c => c / n) as V; };
function ray(origin: V, direction: V, maxDistance: number, forceTwoSided = false): Hit | null {
  const end: V = [origin[0] + direction[0] * maxDistance, origin[1] + direction[1] * maxDistance, origin[2] + direction[2] * maxDistance];
  const candidates = new Set<number>();
  for (let x = Math.floor(Math.min(origin[0], end[0]) / bucketSize); x <= Math.floor(Math.max(origin[0], end[0]) / bucketSize); x++) {
    for (let z = Math.floor(Math.min(origin[2], end[2]) / bucketSize); z <= Math.floor(Math.max(origin[2], end[2]) / bucketSize); z++) for (const index of buckets.get(`${x},${z}`) ?? []) candidates.add(index);
  }
  let closest: Hit | null = null;
  for (const index of candidates) {
    const tri = triangles[index]!, e1 = sub(tri.b, tri.a), e2 = sub(tri.c, tri.a), p = cross(direction, e2), determinant = dot(e1, p);
    if (forceTwoSided || tri.doubleSided ? Math.abs(determinant) < 1e-10 : determinant < 1e-10) continue;
    const t = sub(origin, tri.a), u = dot(t, p) / determinant;
    if (u < -1e-8 || u > 1 + 1e-8) continue;
    const q = cross(t, e1), v = dot(direction, q) / determinant;
    if (v < -1e-8 || u + v > 1 + 1e-8) continue;
    const distance = dot(e2, q) / determinant;
    if (distance < 1e-5 || distance > maxDistance || (closest && distance >= closest.distance)) continue;
    closest = { distance, triangle: index, node: tri.node, cell: tri.cell };
  }
  return closest;
}
function groundHeight(x: number, z: number): number | null {
  const hit = ray([x, 100, z], [0, -1, 0], 130);
  return hit ? 100 - hit.distance : null;
}
const probes: Probe[] = [], skipped: { id: string; reason: string }[] = [];
function probe(input: Omit<Probe, 'visibleHit' | 'twoSidedHit'>): void {
  probes.push({ ...input, visibleHit: ray(input.origin, input.direction, input.maxDistance), twoSidedHit: ray(input.origin, input.direction, input.maxDistance, true) });
}
function basis(spec: Spec) {
  const first = spec.axis[0]!, last = spec.axis.at(-1)!;
  const a: V = [first[0], 0, -first[1]], b: V = [last[0], 0, -last[1]], u = normalize(sub(b, a));
  const v: V = [-u[2], 0, u[0]], length = Math.hypot(b[0] - a[0], b[2] - a[2]);
  return { a, u, v, length, at: (s: number, t: number): V => [a[0] + u[0] * s + v[0] * t, 0, a[2] + u[2] * s + v[2] * t] };
}
for (const spec of specs) {
  const f = basis(spec);
  for (const side of [-1, 1]) for (let step = 0; step < spec.steps; step++) for (const depth of [0.25, 0.5, 0.75]) {
    const along = (step + depth) * f.length / spec.steps;
    const inside = f.at(along, side * (spec.width / 2 - 0.2)), outside = f.at(along, side * (spec.width / 2 + 0.4));
    const hi = groundHeight(inside[0], inside[2]), ho = groundHeight(outside[0], outside[2]);
    const id = `${spec.id}/${side}/${step}/${depth}`;
    if (hi === null || ho === null) { skipped.push({ id, reason: 'no adjacent rendered ground support; requires scene inspection' }); continue; }
    if (Math.abs(hi - ho) < 0.12) continue;
    // Sample each oblique segment's actual endpoints. Reusing the normal segment's heights can manufacture
    // a miss above a sloping cap: the height on one parallel cross-section says nothing about another one.
    // A continuous opaque surface between these endpoints must occlude a horizontal ray between their heights.
    for (const oblique of [-0.5, 0, 0.5]) {
      const inner: V = [inside[0] - f.u[0] * 0.2 * oblique, 0, inside[2] - f.u[2] * 0.2 * oblique];
      const outer: V = [outside[0] + f.u[0] * 0.4 * oblique, 0, outside[2] + f.u[2] * 0.4 * oblique];
      const innerHeight = groundHeight(inner[0], inner[2]), outerHeight = groundHeight(outer[0], outer[2]);
      if (innerHeight === null || outerHeight === null) { skipped.push({ id: `${id}/${oblique}`, reason: 'no rendered support at an oblique segment endpoint; requires scene inspection' }); continue; }
      if (Math.abs(innerHeight - outerHeight) < 0.12) continue;
      const low = Math.min(innerHeight, outerHeight), high = Math.max(innerHeight, outerHeight);
      const start = innerHeight < outerHeight ? inner : outer, end = innerHeight < outerHeight ? outer : inner;
      const delta = sub(end, start), direction = normalize(delta), maxDistance = Math.hypot(...delta) + 0.001;
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const y = low + 0.05 + fraction * (high - low - 0.1), origin: V = [start[0], y, start[2]];
        probe({ id: `${id}/${oblique}/${fraction}`, flight: spec.id, step, side, origin, direction, maxDistance, low, high, kind: 'side-join' });
      }
    }
  }
}
// Fixed ray origins bind the exact owner-reported defect, rather than deriving all assertions from the repaired
// builder's own output. Step numbers are zero-based; this is the west pier at the ninth/tenth tread interval.
const cathedral = specs.find(s => s.id === 'ylre-460008');
if (!cathedral) throw new Error('Cathedral flight missing from report');
const cf = basis(cathedral);
for (const [step, x, y, z] of [[9, -34.614804791, 3.773328794, -41.331181152], [10, -34.631894159, 3.956591467, -41.686110439]] as const) {
  for (const dy of [0.05, 0.2, 0.5, 1]) for (const oblique of [-0.5, 0, 0.5]) {
    const origin: V = [x - cf.u[0] * 0.2 * oblique, y + dy, z - cf.u[2] * 0.2 * oblique];
    const direction = normalize([-cf.v[0] + cf.u[0] * oblique, 0, -cf.v[2] + cf.u[2] * oblique]);
    probe({ id: `reported-west-pier/${step}/${dy}/${oblique}`, flight: cathedral.id, step, side: -1, origin, direction, maxDistance: 0.8, low: y, high: y + 1.5, kind: 'known-regression' });
  }
}
// The fitted first landing lies just outside the last tread. Cover both ends of that strip on every flight;
// checking only the treads cannot detect its newly exposed triangular side opening.
for (const spec of specs) {
  const f = basis(spec), nearA = f.at(0.05, 0), nearB = f.at(f.length - 0.05, 0);
  const hA = groundHeight(nearA[0], nearA[2]), hB = groundHeight(nearB[0], nearB[2]);
  if (hA === null || hB === null) { skipped.push({ id: `${spec.id}/landing`, reason: 'cannot determine high end from exported support' }); continue; }
  const beyond = hB > hA ? 1 : -1, top = beyond > 0 ? f.length : 0;
  for (const side of [-1, 1]) for (const depth of [0.1, 0.35, 0.65, 0.9]) for (const oblique of [-0.5, 0, 0.5]) {
    const along = top + beyond * depth * f.length / spec.steps;
    const inside = f.at(along - 0.02 * oblique, side * (spec.width / 2 - 0.02));
    const outside = f.at(along + 0.02 * oblique, side * (spec.width / 2 + 0.02));
    const innerHeight = groundHeight(inside[0], inside[2]), outerHeight = groundHeight(outside[0], outside[2]);
    const id = `${spec.id}/landing/${side}/${depth}/${oblique}`;
    if (innerHeight === null || outerHeight === null) { skipped.push({ id, reason: 'missing rendered support at landing-side endpoint' }); continue; }
    if (Math.abs(innerHeight - outerHeight) < 0.05) continue;
    const low = Math.min(innerHeight, outerHeight), high = Math.max(innerHeight, outerHeight);
    const start = innerHeight < outerHeight ? inside : outside, end = innerHeight < outerHeight ? outside : inside;
    const delta = sub(end, start), direction = normalize(delta);
    for (const fraction of [0.2, 0.5, 0.8]) {
      probe({ id: `${id}/${fraction}`, flight: spec.id, step: spec.steps, side, origin: [start[0], low + (high - low) * fraction, start[2]], direction, maxDistance: Math.hypot(...delta) + 0.001, low, high, kind: 'top-landing-join' });
    }
  }
}
// Frozen screenshot-pixel rays from the owner-reviewed v5 top-end opening (camera yaw -3.0457937352,pitch -.14).
// These stop immediately behind the expected seam, before the invisible safety terrain can mask the opening.
const endpointOrigin: V = [-33.88833121206096, 12.941810846232345, -51.6290144486421];
for (const [index, direction] of ([
  [-0.39374041680005734, -0.5027314019707434, -0.7695645662650066],
  [-0.39170260196313816, -0.512402878274718, -0.7642070151150747],
  [-0.38939566559585426, -0.49880517370730054, -0.7743154488307665],
  [-0.38788682770073224, -0.47975095977975635, -0.7870087836146843],
  [-0.39490923450527043, -0.520913356508906, -0.7567667880616105],
] as V[]).entries()) probe({ id: `reported-top-endpoint/${index}`, flight: cathedral.id, step: cathedral.steps, side: -1, origin: endpointOrigin, direction, maxDistance: 5, low: 10.73, high: 11.03, kind: 'known-regression' });
// Pixel-center rays expose the remaining ~6 mm slit just beyond the finite west cheek endpoint. The broad
// landing closure above cannot substitute for joining that finite endpoint to its neighboring ground face.
const thinEndpointOrigin: V = [-33.89433950595649, 12.950914304905398, -51.703205001258624];
for (const [index, direction] of ([
  [-0.4140808042821362, -0.5264383216939099, -0.742562981151874],
  [-0.4086143064136612, -0.5448116681282114, -0.7322667511675224],
  [-0.4042074624961542, -0.5582472277539039, -0.7245525239535784],
  [-0.3997634639694058, -0.5713417953704014, -0.7167689486425229],
  [-0.39528873684937543, -0.5840964447194421, -0.7089274700462193],
] as V[]).entries()) probe({ id: `reported-thin-endpoint/${index}`, flight: cathedral.id, step: cathedral.steps, side: -1, origin: thinEndpointOrigin, direction, maxDistance: 5, low: 10.65, high: 10.98, kind: 'known-regression' });
const lowerEndpointOrigin: V = [-32.40629280231113, 5.749830816388432, -38.51882303105288];
for (const [index, direction] of ([
  [-0.6777617951486199, -0.028458896632201577, -0.7347305902433883],
  [-0.6743217734049501, -0.1110681202185386, -0.730036998091962],
  [-0.6652399953480017, -0.19309769497761592, -0.7212274459445666],
  [-0.6527575369639442, -0.272806397458037, -0.7067420091113394],
  [-0.6353716979922338, -0.3488512825376595, -0.6889162416885638],
  [-0.6157493338455591, -0.4199200164553318, -0.6667232841658557],
] as V[]).entries()) probe({ id: `reported-lower-endpoint/${index}`, flight: cathedral.id, step: 9, side: -1, origin: lowerEndpointOrigin, direction, maxDistance: 5, low: 4.11, high: 5.65, kind: 'known-regression' });
// Frozen surveyed west-cheek endpoints, independent of the candidate's authored replacement metadata.
// A cap can block every side ray yet still form the owner's folded fin, so also inspect its actual plane.
const westRuns: [V, V][] = [
  [[-34.8045074495, 0, -41.1125034796], [-35.0287771110, 0, -45.7703625679]],
  [[-35.1618429849, 0, -48.5340091794], [-35.4483510349, 0, -54.4844980500]],
];
// Include the two access-side ends as well as the outer ends seen in the screenshots. The measured slit is
// inside the 10 mm finite-end cut, which ordinary tread-midpoint samples cannot reach.
for (const [run, [a, b]] of westRuns.entries()) {
  const along = normalize(sub(b, a)), across: V = [along[2], 0, -along[0]];
  for (const [endIndex, end] of [a, b].entries()) for (const offset of [-0.008, -0.004, 0.004, 0.008]) {
    const centre: V = [end[0] + along[0] * offset, 0, end[2] + along[2] * offset];
    const inner: V = [centre[0] - across[0] * 0.2, 0, centre[2] - across[2] * 0.2];
    const outer: V = [centre[0] + across[0] * 0.2, 0, centre[2] + across[2] * 0.2];
    const ih = groundHeight(inner[0], inner[2]), oh = groundHeight(outer[0], outer[2]), id = `finite-west-end/${run}/${endIndex}/${offset}`;
    if (ih === null || oh === null) { skipped.push({ id, reason: 'finite-end neighbor has no rendered support' }); continue; }
    if (Math.abs(ih - oh) < 0.05) continue;
    const low = Math.min(ih, oh), high = Math.max(ih, oh), start = ih < oh ? inner : outer, finish = ih < oh ? outer : inner;
    for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) probe({ id: `${id}/${fraction}`, flight: cathedral.id, step: -1, side: -1, origin: [start[0], low + fraction * (high - low), start[2]], direction: normalize(sub(finish, start)), maxDistance: 0.401, low, high, kind: 'finite-wall-end' });
  }
}
const missing = probes.filter(p => !p.visibleHit), backfaces = missing.filter(p => p.twoSidedHit);
const cheekShape = westRuns.map(([a, b], run) => {
  const along = normalize(sub(b, a)), across: V = [along[2], 0, -along[0]], length = Math.hypot(...sub(b, a));
  const caps: { triangle: number; acrossSpan: number; acrossRisePer20mm: number }[] = [];
  const faces: { triangle: number; maxPlaneDeviation: number }[] = [];
  for (let index = 0; index < triangles.length; index++) {
    const tri = triangles[index]!, vertices = [tri.a, tri.b, tri.c];
    const s = vertices.map(p => dot(sub(p, a), along)), t = vertices.map(p => dot(sub(p, a), across));
    // Inspect the literal 10 cm corridor occupied by the visible cheek/cap, excluding end faces and wide terrain.
    if (Math.min(...s) < 0.02 || Math.max(...s) > length - 0.02 || t.some(v => Math.abs(v) > 0.1)) continue;
    const normal = cross(sub(tri.b, tri.a), sub(tri.c, tri.a)), magnitude = Math.hypot(...normal);
    if (magnitude < 1e-9) continue;
    const acrossSpan = Math.max(...t) - Math.min(...t), alongSpan = Math.max(...s) - Math.min(...s);
    if (acrossSpan > 0.002 && Math.abs(normal[1]) > 1e-8) {
      caps.push({ triangle: index, acrossSpan, acrossRisePer20mm: Math.abs(dot(normal, across) / normal[1]) * 0.02 });
    } else if (Math.abs(normal[1]) / magnitude < 0.001 && alongSpan > 0.05 && Math.max(...vertices.map(p => p[1])) - Math.min(...vertices.map(p => p[1])) > 0.2) {
      faces.push({ triangle: index, maxPlaneDeviation: Math.max(...t.map(Math.abs)) });
    }
  }
  return { run, a, b, caps, faces, capFailures: caps.filter(c => c.acrossRisePer20mm > 0.001), faceFailures: faces.filter(f => f.maxPlaneDeviation > 0.001) };
});
// The 2.7669 m break between these runs is an access route, not an omitted wall. Fixed absolute heights stop
// a mistakenly inserted wall from raising its own probe origin and manufacturing a pass.
const accessA = westRuns[0]![1], accessB = westRuns[1]![0], accessAlong = normalize(sub(accessB, accessA));
const accessAcross: V = [accessAlong[2], 0, -accessAlong[0]];
const landingAccess: { fraction: number; height: number; side: number; origin: V; direction: V; hit: Hit | null }[] = [];
for (const fraction of [0.15, 0.35, 0.5, 0.65, 0.85]) for (const height of [7.6, 8.1, 8.6]) for (const side of [-1, 1]) {
  const origin: V = [accessA[0] + fraction * (accessB[0] - accessA[0]) + side * 0.35 * accessAcross[0], height, accessA[2] + fraction * (accessB[2] - accessA[2]) + side * 0.35 * accessAcross[2]];
  const direction: V = [-side * accessAcross[0], 0, -side * accessAcross[2]];
  landingAccess.push({ fraction, height, side, origin, direction, hit: ray(origin, direction, 0.7, true) });
}
const shapeFailures = cheekShape.reduce((n, s) => n + s.capFailures.length + s.faceFailures.length, 0);
const accessBlocked = landingAccess.filter(p => p.hit).length;
const shapeIncomplete = cheekShape.some(s => !s.caps.length || !s.faces.length);
const summary = specs.map(spec => { const p = probes.filter(p => p.flight === spec.id); return { flight: spec.id, probes: p.length, misses: p.filter(p => !p.visibleHit).length, backfaceOnly: p.filter(p => !p.visibleHit && p.twoSidedHit).length }; });
const result = { status: missing.length || shapeFailures || accessBlocked ? 'RETHINK' : skipped.length || shapeIncomplete ? 'INCOMPLETE' : 'PASS', release: manifest.worldReleaseId, manifestSha256: sha256(manifestBytes), reportSha256: sha256(reportBytes), verifierSha256: sha256(readFileSync(import.meta.filename)), osmSha256, sourceFlightCoverage: { reported: report.stairs.flights.map(f => f.id), verified: specs.map(s => s.id), registerReplacesOsm: report.stairs.register.filter(f => f.status === 'drawn' && f.osmWay).map(f => ({ flight: f.id, sourceWay: f.osmWay })) }, files, triangles: triangles.length, summary, probes, skipped, cheekShape, landingAccess,
  limitations: ['Tests side joins with adjacent rendered surfaces at different heights; does not assert that each building facade is complete.', 'Actual runtime angle captures and visual inspection remain required; this report alone is not visual acceptance.'] };
writeFileSync(path.join(out, 'wall-joins.json'), JSON.stringify(result, null, 2) + '\n');
for (const row of summary) console.log(`${row.misses ? 'FAIL' : 'PASS'} ${row.flight}: ${row.probes} rays, ${row.misses} misses, ${row.backfaceOnly} backface-only`);
console.log(`${result.status}: ${missing.length}/${probes.length} rays miss opaque ground faces; ${backfaces.length} backface-only; ${skipped.length} stations require scene inspection`);
console.log(`West cheek: ${shapeFailures} nonplanar/offset triangles, ${accessBlocked}/${landingAccess.length} blocked access rays; shape coverage ${shapeIncomplete ? 'INCOMPLETE' : 'complete'}`);
if (result.status !== 'PASS') process.exitCode = 1;
