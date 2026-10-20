// Read-only lane-width discontinuity diagnosis. Candidate-bound evidence, not a substitute for driving.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { initPhysics, StaticWorld } from '../../packages/sim/src/index.ts';
import { pointAlong } from '../../packages/world-schema/src/index.ts';
import { readSimulationPayload } from './lib/simulation-payload.ts';

const { values } = parseArgs({ options: { release: { type: 'string' }, out: { type: 'string' } } });
if (!values.release || !values.out || fs.existsSync(values.out)) throw new Error('release and fresh out required');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(values.release, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const payload = ref => {
  const bytes = fs.readFileSync(path.join(values.release, ref.path));
  if (sha(bytes) !== ref.sha256) throw new Error(`Hash mismatch: ${ref.path}`);
  return bytes;
};
await initPhysics();
const roads = JSON.parse(payload(manifest.roads)), gameplay = JSON.parse(payload(manifest.gameplay));
const world = StaticWorld.fromBytes(await readSimulationPayload(values.release, manifest.terrain), roads, gameplay);
for (const cell of manifest.cells) world.addCell(cell.id, await readSimulationPayload(values.release, cell.collision));
world.physics.step();
const area = gameplay.playArea;
const inArea = (x, z) => x > area.minX + .2 && x < area.maxX - .2 && z > area.minZ + .2 && z < area.maxZ - .2;
const rows = [], flagged = [], holes = [], obstructions = [];
let samples = 0, rejectedRayEdges = 0;
const ground = (x, z, laneY) => world.groundBelow(x, laneY + 2, z, 30);
function probe(x, z, laneY, s, across) {
  if (!inArea(x, z)) return null;
  samples++;
  return { x, z, s, across, laneY, hit: ground(x, z, laneY) };
}
// A bad zero-width edge ray must not masquerade as a cliff. Retain raw evidence but confirm each end
// with four 2 mm offsets; three must agree within 5 cm before classifying a discontinuity.
function confirm(p) {
  const neighbors = [[.002, 0], [-.002, 0], [0, .002], [0, -.002]].map(([dx, dz]) => ground(p.x + dx, p.z + dz, p.laneY));
  return { pass: neighbors.filter(n => n && p.hit && Math.abs(n.y - p.hit.y) < .05).length >= 3, neighbors };
}
function compare(lane, axis, a, b) {
  if (!a?.hit || !b?.hit) return;
  const distance = Math.hypot(b.x - a.x, b.z - a.z), delta = b.hit.y - a.hit.y;
  if (Math.abs(delta) <= .35 || distance > .8) return;
  const proofA = confirm(a), proofB = confirm(b);
  if (!proofA.pass || !proofB.pass) { rejectedRayEdges++; return; }
  flagged.push({ lane: lane.id, name: lane.name, width: lane.width, axis, distance, delta, a, b, proofA, proofB });
}
try {
  for (const lane of roads.lanes) {
    let previous = null, laneSamples = 0;
    const segmentCount = Math.ceil(lane.length / .5), widthCount = Math.ceil(lane.width / .25);
    for (let k = 0; k <= segmentCount; k++) {
      const s = lane.length * k / segmentCount, { point, tangent } = pointAlong(lane.points, s), current = [];
      for (let j = 0; j <= widthCount; j++) {
        const across = -lane.width / 2 + lane.width * j / widthCount;
        const p = probe(point[0] - tangent[1] * across, point[2] + tangent[0] * across, point[1], s, across);
        current.push(p);
        if (!p) continue;
        laneSamples++;
        if (!p.hit) holes.push({ lane: lane.id, ...p });
        else if (p.hit.surface?.group !== 'ground') obstructions.push({ lane: lane.id, ...p });
        if (j) compare(lane, 'across', current[j - 1], p);
        if (previous) compare(lane, 'along', previous[j], p);
      }
      previous = current;
    }
    rows.push({ lane: lane.id, name: lane.name, samples: laneSamples });
  }
  const grouped = [...new Set(flagged.map(f => f.lane))].map(id => {
    const points = flagged.filter(f => f.lane === id), worst = points.reduce((a, b) => Math.abs(a.delta) > Math.abs(b.delta) ? a : b);
    return { lane: id, name: worst.name, flags: points.length, minS: Math.min(...points.map(p => p.a.s)), maxS: Math.max(...points.map(p => p.b.s)),
      maxStep: Math.abs(worst.delta), worst };
  }).sort((a, b) => b.maxStep - a.maxStep);
  const report = { release: manifest.worldReleaseId, manifestSha256: sha(manifestBytes), scriptSha256: sha(fs.readFileSync(import.meta.filename)),
    sampling: { maxAlongMetres: .5, maxAcrossMetres: .25, minStepMetres: .35, rayNeighborOffsetMetres: .002, neighborAgreementMetres: .05 },
    samples, rejectedRayEdges, holes, obstructions, grouped, flagged, rows };
  fs.writeFileSync(values.out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ release: report.release, samples, holes: holes.length, obstructions: obstructions.length, flagged: flagged.length,
    lanes: grouped.map(({ lane, name, flags, minS, maxS, maxStep, worst }) => ({ lane, name, flags, minS, maxS, maxStep, at: [worst.a.x, worst.a.z] })) }));
} finally { world.physics.free(); }
