// Source-connected park walking candidates; no physical or runtime acceptance is claimed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {containsSupportedArea, geodeticToGk25, type Vec3} from '../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons, pointInPolygon, bbox} from './lib/geometry.ts';
import {sourceSha256, writeSourceJson} from './lib/source-files.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}}}); assert.ok(values.plan && values.out && !fs.existsSync(values.out));
const pin = (file: string) => ({file: path.resolve(file), sha256: sourceSha256(fs.readFileSync(file))}), read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const plan = read(values.plan), routePlan = read(plan.routePlan.file), area = read(plan.sourceArea.file); assert.equal(pin(plan.routePlan.file).sha256, plan.routePlan.sha256); assert.equal(pin(plan.sourceArea.file).sha256, plan.sourceArea.sha256);
const manifestFile = path.join(routePlan.acceptedWorld, 'manifest.json'), manifest = read(manifestFile); assert.equal(pin(manifestFile).sha256, routePlan.acceptedManifestSha256); assert.equal(area.acceptedManifestSha256, routePlan.acceptedManifestSha256);
assert.equal(pin(routePlan.osm.file).sha256, routePlan.osm.sha256); assert.equal(pin(routePlan.candidateRoads.file).sha256, routePlan.candidateRoads.sha256);
const osm = read(routePlan.osm.file), graph = read(routePlan.candidateRoads.file), ways = new Map<number, any>(osm.elements.filter((e: any) => e.type === 'way').map((e: any) => [e.id, e])), nodes = new Map<number, Vec3>();
for (const node of osm.elements.filter((e: any) => e.type === 'node')) {const [e, n] = geodeticToGk25(node.lat, node.lon); nodes.set(node.id, [e - manifest.origin.originProjected[0], 0, manifest.origin.originProjected[1] - n]);}
const r = plan.boundsXZ, edges = new Map<number, {to: number; wayId: number; length: number}[]>(), rejected = [];
for (const record of graph.footways) {
  const way = ways.get(Number(record.id.slice(1))), t = way?.tags ?? {}, access = t.foot ?? t.access;
  if (!way?.nodes || !['footway', 'pedestrian', 'path', 'living_street', 'cycleway'].includes(t.highway) || (t.highway === 'cycleway' && !['yes', 'designated', 'permissive'].includes(t.foot))
    || (access !== undefined && !['yes', 'designated', 'permissive'].includes(access)) || (t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no') || Number(t.layer ?? 0) !== 0
    || Object.keys(t).some(key => /^(foot|access).*:conditional$/.test(key)) || (t['oneway:foot'] && !['no', 'yes', '-1'].includes(t['oneway:foot']))) {rejected.push(record.id); continue;}
  for (let i = 1; i < way.nodes.length; i++) {const a = nodes.get(way.nodes[i - 1])!, b = nodes.get(way.nodes[i])!; assert.ok(a && b);
    if ([a, b].some(p => p[0] < r[0] || p[0] > r[2] || p[2] < r[1] || p[2] > r[3])) continue;
    const length = Math.hypot(b[0] - a[0], b[2] - a[2]); if (!length) continue;
    for (const [from, to, permitted] of [[way.nodes[i - 1], way.nodes[i], t['oneway:foot'] !== '-1'], [way.nodes[i], way.nodes[i - 1], t['oneway:foot'] !== 'yes']]) if (permitted) {const list = edges.get(from) ?? []; list.push({to, wayId: way.id, length}); edges.set(from, list);}
  }
}
assert.ok(edges.has(plan.anchorNode));
const partsPin = area.sourceFiles.find((p: any) => p.path.endsWith('.geojson')); assert.ok(partsPin); assert.equal(pin(partsPin.path).sha256, partsPin.sha256);
const parts = loadGeoJsonPolygons(partsPin.path, manifest.origin.originProjected[0], manifest.origin.originProjected[1], (p, i) => String(p.osan_id ?? i));
function shortest(start: number, goal: number) {
  const queue = [{id: start, distance: 0}], distance = new Map([[start, 0]]), previous = new Map<number, {from: number; wayId: number}>();
  while (queue.length) {queue.sort((a, b) => a.distance - b.distance); const next = queue.shift()!; if (next.distance !== distance.get(next.id)) continue; if (next.id === goal) break;
    for (const edge of edges.get(next.id) ?? []) {const d = next.distance + edge.length; if (d >= (distance.get(edge.to) ?? Infinity)) continue; distance.set(edge.to, d); previous.set(edge.to, {from: next.id, wayId: edge.wayId}); queue.push({id: edge.to, distance: d});}
  }
  if (!previous.has(goal)) return null;
  const steps: {wayId: number; fromNode: number; toNode: number}[] = []; for (let id = goal; id !== start;) {const p = previous.get(id)!; steps.push({wayId: p.wayId, fromNode: p.from, toNode: id}); id = p.from;} steps.reverse(); return {metres: distance.get(goal)!, steps};
}
const candidates = plan.parks.map((park: any) => {
  const polygons = parts.filter(part => part.properties.alueen_nimi === park.sourceMunicipalName); assert.ok(polygons.length);
  const boxes = polygons.map(part => bbox(part.rings)), centre = [(Math.min(...boxes.map(b => b[0])) + Math.max(...boxes.map(b => b[2]))) / 2, -(Math.min(...boxes.map(b => b[1])) + Math.max(...boxes.map(b => b[3]))) / 2];
  const goals = [...edges.keys()].filter(id => {const p = nodes.get(id)!; return polygons.some(part => pointInPolygon([p[0], -p[2]], part.rings));}).sort((a, b) => {const p = nodes.get(a)!, q = nodes.get(b)!; return Math.hypot(p[0] - centre[0]!, p[2] - centre[1]!) - Math.hypot(q[0] - centre[0]!, q[2] - centre[1]!);});
  assert.ok(goals.length, `No public native source footway nodes in ${park.sourceMunicipalName}`);
  for (const goal of goals.slice(0, 100)) {const out = shortest(plan.anchorNode, goal), back = shortest(goal, plan.anchorNode); if (!out || !back) continue;
    const raw = [...out.steps, ...back.steps], steps: typeof raw = []; for (const step of raw) {const prior = steps.at(-1), sequence = ways.get(step.wayId)!.nodes;
      const direction = Math.sign(sequence.indexOf(step.toNode) - sequence.indexOf(step.fromNode)), priorDirection = prior?.wayId === step.wayId ? Math.sign(sequence.indexOf(prior.toNode) - sequence.indexOf(prior.fromNode)) : 0;
      if (prior && prior.wayId === step.wayId && prior.toNode === step.fromNode && priorDirection === direction) prior.toNode = step.toNode; else steps.push({...step});}
    const nodeIds = [...new Set(raw.flatMap(step => [step.fromNode, step.toNode]))], outsideSourceMask = nodeIds.filter(id => {const p = nodes.get(id)!; return !containsSupportedArea({playArea: area.expandedPlayArea, supportedArea: area.supportedArea}, p[0], p[2], .38);});
    return {id: park.id, sourceMunicipalName: park.sourceMunicipalName, goalNode: goal, goalPoint: nodes.get(goal), sourceParkPartIds: polygons.map(part => part.id), metres: out.metres + back.metres, steps, nodeIds, sourceCapsuleBlockedNodeIds: outsideSourceMask};
  }
  return {id: park.id, sourceMunicipalName: park.sourceMunicipalName, status: 'NO_SOURCE_CONNECTED_OUT_AND_BACK_WITHIN_BOUNDS'};
});
fs.mkdirSync(values.out, {recursive: true}); const ref = writeSourceJson(values.out, 'park-walk-candidates.json', {schemaVersion: 1, status: 'PUBLIC_SOURCE_TOPOLOGY_ONLY_NATIVE_PROJECTION_MASK_AND_CONTROLS_PENDING', sourcePins: [pin(values.plan), pin(plan.routePlan.file), pin(plan.sourceArea.file), routePlan.osm, routePlan.candidateRoads], acceptedManifestSha256: routePlan.acceptedManifestSha256, anchorNode: plan.anchorNode, rejectedFootwayIds: rejected, routes: candidates});
console.log(JSON.stringify({file: path.resolve(values.out, ref.path), sha256: ref.sha256, routes: candidates.map((c: any) => ({id: c.id, goal: c.goalNode, metres: c.metres, steps: c.steps?.length, blockedSourceCapsules: c.sourceCapsuleBlockedNodeIds?.length, status: c.status}))}));
