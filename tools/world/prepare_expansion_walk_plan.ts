// Build a real-control Senate departure/return plan from current public OSM node connectivity and the qualified new circuit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {geodeticToGk25, supportsSegment} from '../../packages/world-schema/src/index.ts';
import {sourceSha256, readSourceFile} from './lib/source-files.ts';
const {values} = parseArgs({options: {'walking-plan': {type: 'string'}, 'road-merge': {type: 'string'}, 'accepted-osm-ledger': {type: 'string'}, out: {type: 'string'}}}); assert.ok(values['walking-plan'] && values['road-merge'] && values['accepted-osm-ledger'] && values.out && !fs.existsSync(values.out));
const pin = (file: string) => ({path: path.relative(process.cwd(), path.resolve(file)).replaceAll('\\', '/'), sha256: sourceSha256(fs.readFileSync(file))});
const planPin = pin(values['walking-plan']), plan = JSON.parse(fs.readFileSync(values['walking-plan'], 'utf8')), mergePin = pin(values['road-merge']), merge = JSON.parse(fs.readFileSync(values['road-merge'], 'utf8'));
assert.equal(merge.status, 'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME'); assert.equal(merge.walking.status, 'PASS_SOURCE_AND_NATIVE_WALKING_NETWORK_PENDING_ACTUAL_CONTROLS'); assert.equal(merge.acceptedManifestSha256, plan.acceptedManifestSha256);
const root = plan.acceptedWorld, manifestPin = pin(path.join(root, 'manifest.json')); assert.equal(manifestPin.sha256, plan.acceptedManifestSha256); const manifest = JSON.parse(fs.readFileSync(manifestPin.path, 'utf8')), gameplay = JSON.parse(readSourceFile(root, manifest.gameplay).toString());
const osmPin = pin(plan.osm.file); assert.equal(osmPin.sha256, plan.osm.sha256); const currentOsm = JSON.parse(fs.readFileSync(plan.osm.file, 'utf8'));
const acceptedLedgerPin = pin(values['accepted-osm-ledger']), ledger = JSON.parse(fs.readFileSync(values['accepted-osm-ledger'], 'utf8')), snapshots = Object.values(ledger.snapshots) as {path: string; sha256: string; sourceSnapshotSha256: string}[];
assert.equal(snapshots.length, 1); assert.equal(ledger.source.id, merge.acceptedSourceRetained.id); assert.equal(snapshots[0]!.sourceSnapshotSha256, merge.acceptedSourceRetained.sha256, 'Approach source does not derive from accepted roads authority');
const acceptedOsmPin = pin(path.join(path.dirname(values['accepted-osm-ledger']), snapshots[0]!.path)); assert.equal(acceptedOsmPin.sha256, snapshots[0]!.sha256); const osm = JSON.parse(fs.readFileSync(acceptedOsmPin.path, 'utf8'));
const oldTarget = osm.elements.find((e: any) => e.type === 'node' && e.id === plan.steps[0].fromNode), currentTarget = currentOsm.elements.find((e: any) => e.type === 'node' && e.id === plan.steps[0].fromNode); assert.ok(oldTarget && currentTarget); assert.equal(oldTarget.lat, currentTarget.lat); assert.equal(oldTarget.lon, currentTarget.lon);
const nodes = new Map<number, any>(osm.elements.filter((e: any) => e.type === 'node').map((e: any) => [e.id, e])), ways = new Map<number, any>();
const coordinates = new Map<number, [number, number]>(), coordinate = (id: number): [number, number] => {let result = coordinates.get(id); if (!result) {const node = nodes.get(id); assert.ok(Number.isFinite(node?.lat) && Number.isFinite(node?.lon)); const [e, n] = geodeticToGk25(node.lat, node.lon); result = [e - manifest.origin.originProjected[0], manifest.origin.originProjected[1] - n]; coordinates.set(id, result);} return result;};
type Edge = {to: number; way: number; metres: number}; const adjacent = new Map<number, Edge[]>();
for (const way of osm.elements.filter((e: any) => e.type === 'way' && e.nodes && e.tags)) {
  const tags = way.tags, access = tags.foot ?? tags.access;
  if (!['footway', 'pedestrian', 'path', 'living_street', 'cycleway'].includes(tags.highway) || access !== undefined && !['yes', 'designated', 'permissive'].includes(access)
    || tags.highway === 'cycleway' && !['yes', 'designated', 'permissive'].includes(tags.foot) || tags.area === 'yes' || tags.indoor === 'yes' || tags.bridge && tags.bridge !== 'no' || tags.tunnel && tags.tunnel !== 'no' || Number(tags.layer ?? 0) !== 0) continue;
  ways.set(way.id, way);
  for (let i = 1; i < way.nodes.length; i++) {const from = way.nodes[i - 1], to = way.nodes[i]; if (!nodes.has(from) || !nodes.has(to)) continue; const a = coordinate(from), b = coordinate(to); if (!supportsSegment(gameplay, a, b, .38)) continue;
    const metres = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!metres) continue;
    for (const [u, v, allowed] of [[from, to, tags['oneway:foot'] !== '-1'], [to, from, tags['oneway:foot'] !== 'yes']] as const) if (allowed) {const edges = adjacent.get(u) ?? []; edges.push({to: v, way: way.id, metres}); adjacent.set(u, edges);}
  }
}
const start = 314737043, target = plan.steps[0].fromNode; assert.ok(adjacent.has(start) && adjacent.has(target), 'Accepted public approach anchors are absent');
type Queue = {id: number; distance: number}; const heap: Queue[] = [], push = (entry: Queue) => {let i = heap.length; heap.push(entry); while (i) {const parent = Math.floor((i - 1) / 2); if (heap[parent]!.distance <= entry.distance) break; heap[i] = heap[parent]!; i = parent;} heap[i] = entry;};
const pop = () => {const first = heap[0]!, last = heap.pop()!; if (heap.length) {let i = 0; while (i * 2 + 1 < heap.length) {let child = i * 2 + 1; if (child + 1 < heap.length && heap[child + 1]!.distance < heap[child]!.distance) child++; if (heap[child]!.distance >= last.distance) break; heap[i] = heap[child]!; i = child;} heap[i] = last;} return first;};
const distances = new Map<number, number>([[start, 0]]), prior = new Map<number, {node: number; way: number}>(); push({id: start, distance: 0});
while (heap.length) {const next = pop(); if (next.distance !== distances.get(next.id)) continue; if (next.id === target) break; for (const edge of adjacent.get(next.id) ?? []) {const distance = next.distance + edge.metres; if (distance >= (distances.get(edge.to) ?? Infinity)) continue; distances.set(edge.to, distance); prior.set(edge.to, {node: next.id, way: edge.way}); push({id: edge.to, distance});}}
assert.ok(prior.has(target), 'No source-connected public walking approach within accepted geography'); const approach: {from: number; to: number; wayId: number}[] = [];
for (let id = target; id !== start;) {const p = prior.get(id)!; approach.push({from: p.node, to: id, wayId: p.way}); id = p.node;} approach.reverse();
const waypoint = (label: string, xz: [number, number], radius: number, source: unknown, capture = false) => ({label, xz: xz.map(value => Math.round(value * 1000) / 1000), radius, timeoutSeconds: 120, source, ...(capture ? {capture: true} : {})});
const acceptedApproach = [waypoint('Senate Square west public crossing', [-63, 24], .8, {kind: 'accepted-square-approach', baselinePlan: 'content/helsinki/district-expansion/walk-plan.json'}), waypoint('Unioninkatu Aleksanterinkatu crossing', coordinate(start), .6, {type: 'node', id: start})];
for (const edge of approach) acceptedApproach.push(waypoint(`Accepted public node ${edge.to}`, coordinate(edge.to), .45, {type: 'node', id: edge.to, wayId: edge.wayId, highway: ways.get(edge.wayId).tags.highway}));
const circuit: ReturnType<typeof waypoint>[] = [];
for (const [index, step] of (merge.walking.routes[0].steps as any[]).entries()) {
  const points = step.points as number[][];
  for (let i = 1; i < points.length; i++) {const a = points[i - 1]!, b = points[i]!, length = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!); if (length < 1e-7) continue;
    // Native projection subdivisions retain exact turns; compact only collinear stretches to bounded 2m goals.
    const previous = i >= 2 ? points[i - 2]! : undefined;
    if (i < points.length - 1 && previous) {const next = points[i + 1]!, cross = (b[0]! - a[0]!) * (next[2]! - b[2]!) - (b[2]! - a[2]!) * (next[0]! - b[0]!); const last = circuit.at(-1)?.xz;
      if (Math.abs(cross) < 1e-8 && last && Math.hypot(b[0]! - last[0]!, b[2]! - last[1]!) < 1.5) continue;}
    const xz: [number, number] = [b[0]!, b[2]!]; circuit.push(waypoint(`Circuit ${index + 1} way ${step.wayId} point ${i}`, xz, .18, {wayId: step.wayId, sourceNodePair: [step.fromNode, step.toNode], qualifiedMergeSha256: mergePin.sha256}, i === points.length - 1));
  }
}
const returning = approach.slice().reverse().map(edge => waypoint(`Return public node ${edge.from}`, coordinate(edge.from), .45, {type: 'node', id: edge.from, wayId: edge.wayId, highway: ways.get(edge.wayId).tags.highway}));
returning.push(waypoint('Senate Square west return', [-63, 24], .8, {kind: 'accepted-square-approach'}), waypoint('Native Senate player spawn return', gameplay.player.spawn.position, .8, {kind: 'accepted-player-spawn', manifestSha256: manifestPin.sha256}, true));
const sourceWays = [...new Set(approach.map(edge => edge.wayId))].map(id => ({id, sha256: sourceSha256(JSON.stringify(ways.get(id))), highway: ways.get(id).tags.highway, foot: ways.get(id).tags.foot ?? null, access: ways.get(id).tags.access ?? null}));
const output = {schemaVersion: 1, scope: 'First Bulevardi/Abrahaminkatu walking circuit only; broader district walking remains unqualified', evidencePolicy: 'Real keyboard walking from native Senate spawn through source-confirmed accepted public paths, exact qualified new footway/crossing circuit, and return. No fixture teleport. This is a runnable plan, not a completed journey.',
  binding: {walkingPlan: planPin, roadMerge: mergePin, osm: osmPin, acceptedApproachOsm: acceptedOsmPin, acceptedApproachLedger: acceptedLedgerPin, acceptedManifest: manifestPin, expandedSupportedAreaSha256: merge.expandedSupportedAreaSha256, mergedRoadsSha256: merge.mergedRoadsSha256, producerSha256: sourceSha256(fs.readFileSync(import.meta.filename))},
  approach: {sourceNodeStart: start, sourceNodeEnd: target, lengthMetres: distances.get(target), sourceWays, steps: approach, geometryStatus: 'PUBLIC_OSM_SOURCE_CONNECTED_WITHIN_ACCEPTED_GEOGRAPHY; ACTUAL_COLLISION_TRAVEL_PENDING'},
  routes: [{id: 'senate-bulevardi-crossing-return', waypoints: [...acceptedApproach, ...circuit, ...returning]}], fixtures: []};
fs.mkdirSync(path.dirname(values.out), {recursive: true}); fs.writeFileSync(values.out, JSON.stringify(output, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({file: values.out, sha256: pin(values.out).sha256, waypoints: output.routes[0]!.waypoints.length, approachMetres: distances.get(target), circuitWaypoints: circuit.length, status: 'SOURCE_PLANNED_NOT_PLAYED'}));
