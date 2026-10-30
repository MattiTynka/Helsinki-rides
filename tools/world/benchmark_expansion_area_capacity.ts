// Advisory offline capacity benchmark. This never changes the production schema or publishes a mask.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {parseArgs} from 'node:util';
import polygonClipping from 'polygon-clipping';
import {containsSupportedArea, supportsSegment, type SupportedArea, type Vec3} from '../../packages/world-schema/src/index.ts';
import {supportsVehiclePose, supportsVehicleTransition} from '../../packages/sim/src/coverage-footprint.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
const {values} = parseArgs({options: {south: {type: 'string'}, west: {type: 'string'}, routes: {type: 'string'}, out: {type: 'string'}}});
assert.ok(values.south && values.west && values.routes && values.out && !fs.existsSync(values.out));
const pin = (file: string) => ({path: path.resolve(file), sha256: sourceSha256(fs.readFileSync(file))});
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const south = read(values.south), west = read(values.west), routePlan = read(values.routes), roads = read(routePlan.candidateRoads.file);
assert.equal(sourceSha256(fs.readFileSync(routePlan.candidateRoads.file)), routePlan.candidateRoads.sha256);
assert.equal(south.acceptedManifestSha256, west.acceptedManifestSha256); assert.equal(south.acceptedManifestSha256, routePlan.acceptedManifestSha256);
const asPolygons = (area: SupportedArea): polygonClipping.MultiPolygon => area.regions.map(r => [r.outer.map(p => [...p] as [number, number]), ...(r.holes ?? []).map(h => h.map(p => [...p] as [number, number]))]);
const combined = polygonClipping.union(asPolygons(south.supportedArea), asPolygons(west.supportedArea));
const supportedArea: SupportedArea = {schemaVersion: 1, regions: combined.map((p, i) => ({id: `capacity-${i}`, outer: p[0]!.slice(0, -1), holes: p.slice(1).map(h => h.slice(0, -1))}))};
const playArea = {minX: -2816, minZ: -2304, maxX: 800, maxZ: 1792};
const source = fs.readFileSync('packages/world-schema/src/supported-area.ts', 'utf8');
assert.equal(source.split('const MAX_VERTICES = 4096;').length, 2); assert.equal(source.split('region.holes.length > 512').length, 2);
const experimental = source.replace('const MAX_VERTICES = 4096;', 'const MAX_VERTICES = 32768;').replace('region.holes.length > 512', 'region.holes.length > 4096');
fs.mkdirSync(values.out, {recursive: true});
const copy = path.resolve(values.out, 'supported-area.cap-only-experiment.ts'); fs.writeFileSync(copy, experimental);
const validator = await import(pathToFileURL(copy).href);
const routeSourcePlan = read(routePlan.planPin.file), manifest = read(path.join(routeSourcePlan.acceptedWorld, 'manifest.json'));
const gameplay = JSON.parse(readSourceFile(routeSourcePlan.acceptedWorld, manifest.gameplay).toString());
const ids = new Set([...routePlan.retainedLaneIds, ...routePlan.newLaneIds]);
const points: Vec3[] = roads.lanes.filter((lane: any) => ids.has(lane.id)).flatMap((lane: any) => lane.points);
assert.ok(points.length > 100);
const measures = [];
for (const [name, area] of [['south', south.supportedArea], ['south-plus-west-upper-envelope', supportedArea]] as const) {
  const bytes = Buffer.from(JSON.stringify(area)), before = performance.now(), errors = validator.validateSupportedArea(area, playArea), validationMs = performance.now() - before;
  const coverage = {playArea, supportedArea: area}; const memoryBefore = process.memoryUsage().heapUsed, coldStart = performance.now(); containsSupportedArea(coverage, -12, 14, .34); const coldQueryAndBvhMs = performance.now() - coldStart, heapDeltaAfterBvhBytes = process.memoryUsage().heapUsed - memoryBefore;
  const workloads = [];
  for (const task of ['point', 'walking-segment', 'vehicle-pose', 'vehicle-transition']) {
    const repetitions = task.startsWith('vehicle') ? 1500 : 10000, timings = []; let admitted = 0;
    for (let round = 0; round < 3; round++) {const t = performance.now(); for (let i = 0; i < repetitions; i++) {
      const p = points[(i * 17) % points.length]!, q: Vec3 = [p[0] + .25, p[1], p[2] + .10], rotation: [number, number, number, number] = [0, Math.sin(i * .01), 0, Math.cos(i * .01)], def = gameplay.vehicleDefinitions[i % gameplay.vehicleDefinitions.length];
      const result = task === 'point' ? containsSupportedArea(coverage, p[0], p[2], .34) : task === 'walking-segment' ? supportsSegment(coverage, [p[0], p[2]], [q[0], q[2]], .34)
        : task === 'vehicle-pose' ? supportsVehiclePose(coverage, def, p, rotation) : supportsVehicleTransition(coverage, def, {position: p, rotation}, {position: q, rotation});
      if (result) admitted++;
    } timings.push(performance.now() - t);}
    workloads.push({task, repetitions, rounds: 3, timingsMs: timings, meanMicrosecondsPerCall: timings.reduce((a, b) => a + b, 0) * 1000 / repetitions / 3, admitted});
  }
  const perRegion = area.regions.map((r: SupportedArea['regions'][number]) => ({id: r.id, holes: r.holes?.length ?? 0, outerVertices: r.outer.length, vertices: r.outer.length + (r.holes ?? []).reduce((sum, h) => sum + h.length, 0)}));
  measures.push({name, perRegion, jsonBytes: bytes.length, gzipBytes: gzipSync(bytes).length, capOnlyValidationErrors: errors, validationMs, coldQueryAndBvhMs, heapDeltaAfterBvhBytes, workloads});
  console.log(JSON.stringify({name, perRegion, validationMs, errors, coldQueryAndBvhMs, workloads}));
}
writeSourceJson(values.out, 'capacity-source-geometry.json', {schemaVersion: 1, status: 'CAPACITY_UPPER_ENVELOPE_NOT_PLAYABLE_ADMISSION', supportedArea, playArea});
writeSourceJson(values.out, 'benchmark.json', {schemaVersion: 1, status: 'ADVISORY_OFFLINE_NODE_BENCHMARK_NOT_BROWSER_OR_PHYSICAL_ACCEPTANCE', sourcePins: [pin(values.south), pin(values.west), pin(values.routes), pin(routePlan.candidateRoads.file), pin('packages/world-schema/src/supported-area.ts'), pin('packages/sim/src/coverage-footprint.ts')],
  experiment: {file: copy, sha256: sourceSha256(experimental), onlyChanges: {maxVertices: [4096, 32768], maxHolesPerRegion: [512, 4096]}, originalUnmodified: true}, node: process.version, measures});
