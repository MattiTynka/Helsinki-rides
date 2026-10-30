// Source/topology candidate preparation only. Native projection, public mask, serialized collision and real controls remain gates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {decodeRoadGraph, decodeSimulationPayload, type RoadLane} from '../../packages/world-schema/src/index.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}}}); assert.ok(values.plan && values.out && !fs.existsSync(values.out));
const pin = (file: string) => ({file: path.resolve(file), sha256: sourceSha256(fs.readFileSync(file))});
const read = (ref: {file: string; sha256: string}) => {const bytes = fs.readFileSync(ref.file); assert.ok(bytes.length < 128_000_000); assert.equal(sourceSha256(bytes), ref.sha256); return JSON.parse(bytes.toString());};
const planPin = pin(values.plan), plan = read(planPin); assert.equal(plan.schemaVersion, 1); assert.ok(plan.routes.length > 0 && plan.routes.length <= 10);
const manifest = read({file: path.join(plan.acceptedWorld, 'manifest.json'), sha256: plan.acceptedManifestSha256}), accepted = decodeRoadGraph(await decodeSimulationPayload(readSourceFile(plan.acceptedWorld, manifest.roads), manifest.roads));
const candidate = decodeRoadGraph(fs.readFileSync(plan.candidateRoads.file)); assert.equal(pin(plan.candidateRoads.file).sha256, plan.candidateRoads.sha256); const osm = read(plan.osm); assert.equal(candidate.source.sha256, plan.osm.sha256);
const ways = new Map<number, any>(osm.elements.filter((e: any) => e.type === 'way').map((e: any) => [e.id, e])), old = new Map(accepted.lanes.map(lane => [lane.id, lane]));
const rejected: {id: string; reason: string}[] = [], accessWitnesses = new Map<string, unknown>(), allowed = new Map<string, RoadLane>();
const r = plan.boundsXZ as [number, number, number, number]; assert.ok(r.length === 4 && r.every(Number.isFinite));
for (const lane of candidate.lanes) {
  try {
    assert.ok(lane.points.every(p => p[0] >= r[0] && p[0] <= r[2] && p[2] >= r[1] && p[2] <= r[3]), 'outside bounded route area');
    const source = ways.get(lane.wayId); assert.ok(source?.nodes && source.tags, 'missing complete OSM source'); const tags = source.tags, access = tags.motor_vehicle ?? tags.vehicle ?? tags.access;
    assert.ok(access === undefined || ['yes', 'designated', 'permissive'].includes(access), 'non-public vehicle access');
    assert.ok((!tags.bridge || tags.bridge === 'no') && (!tags.tunnel || tags.tunnel === 'no') && Number(tags.layer ?? 0) === 0 && tags.area !== 'yes', 'unqualified structure/area/level');
    assert.ok(!Object.keys(tags).some(key => /^(motor_vehicle|vehicle|access).*:conditional$/.test(key)), 'conditional access requires explicit review');
    const direction = /:[fb]\d+$/.exec(lane.id)?.[0][1]; assert.ok(direction === 'f' || direction === 'b');
    const directional = direction === 'f' ? 'forward' : 'backward', oneWay = ['yes', '1', '-1'].includes(tags.oneway) || tags.junction === 'roundabout', laneAccess = [];
    for (const key of ['access', 'vehicle', 'motor_vehicle']) {
      const field = tags[`${key}:lanes:${directional}`] !== undefined ? `${key}:lanes:${directional}` : tags[`${key}:lanes`] !== undefined ? `${key}:lanes` : null;
      if (!field) continue; assert.ok(field.endsWith(directional) || oneWay, 'undirected two-way lane access needs explicit mapping');
      const slots = tags[field].split('|'); assert.equal(slots.length, lane.count, 'per-lane access count differs from native layout');
      const value = slots[lane.index]; assert.ok(['yes', 'designated', 'permissive'].includes(value), `lane access ${field}=${value}`); laneAccess.push({field, index: lane.index, nativeIndexOrder: 'left-to-right in travel direction', value});
    }
    const prior = old.get(lane.id);
    if (prior) assert.ok(prior.from === lane.from && prior.to === lane.to && prior.index === lane.index && prior.count === lane.count, 'accepted identity has changed source segmentation');
    else {
      const from = source.nodes.indexOf(Number(lane.from.slice(1))), to = source.nodes.indexOf(Number(lane.to.slice(1))); assert.ok(from >= 0 && to >= 0, 'lane source endpoints missing');
      for (const prior of accepted.lanes.filter(prior => prior.wayId === lane.wayId && prior.index === lane.index)) {const a = source.nodes.indexOf(Number(prior.from.slice(1))), b = source.nodes.indexOf(Number(prior.to.slice(1))); assert.ok(a >= 0 && b >= 0, 'accepted interval no longer in source'); if (Math.sign(b - a) === Math.sign(to - from)) assert.ok(Math.max(Math.min(a, b), Math.min(from, to)) >= Math.min(Math.max(a, b), Math.max(from, to)), 'overlaps an accepted source interval');}
    }
    allowed.set(lane.id, lane); accessWitnesses.set(lane.id, {id: lane.id, wayId: lane.wayId, sourceWaySha256: sourceSha256(JSON.stringify(source)), generalAccess: access ?? 'public-default', laneAccess, acceptedIdentity: !!prior});
  } catch (error) {rejected.push({id: lane.id, reason: (error as Error).message.split('\n')[0]!});}
}
const outgoing = new Map<string, {id: string; to: string; length: number}[]>();
for (const connector of candidate.connectors) if (allowed.has(connector.from) && allowed.has(connector.to)) {
  const from = allowed.get(connector.from)!, to = allowed.get(connector.to)!; if (from.to !== connector.node || to.from !== connector.node) continue;
  const list = outgoing.get(connector.from) ?? []; list.push({id: connector.id, to: connector.to, length: connector.length}); outgoing.set(connector.from, list);
}
function route(start: string, end: string) {
  assert.ok(allowed.has(start), `Start lane ${start} rejected: ${rejected.find(lane => lane.id === start)?.reason}`); assert.ok(allowed.has(end), `Goal lane ${end} rejected: ${rejected.find(lane => lane.id === end)?.reason}`);
  const queue = [{id: start, distance: 0}], distances = new Map([[start, 0]]), previous = new Map<string, {lane: string; connector: string}>();
  while (queue.length) {queue.sort((a, b) => a.distance - b.distance); const next = queue.shift()!; if (next.distance !== distances.get(next.id)) continue; if (next.id === end) break;
    for (const edge of outgoing.get(next.id) ?? []) {const distance = next.distance + edge.length + allowed.get(edge.to)!.length; if (distance >= (distances.get(edge.to) ?? Infinity)) continue; distances.set(edge.to, distance); previous.set(edge.to, {lane: next.id, connector: edge.id}); queue.push({id: edge.to, distance});}
  }
  assert.ok(start === end || previous.has(end), `No public source-native route from ${start} to ${end}`); const lanes = [end], connectors = [];
  for (let id = end; id !== start;) {const prior = previous.get(id)!; connectors.push(prior.connector); lanes.push(prior.lane); id = prior.lane;} lanes.reverse(); connectors.reverse(); return {laneIds: lanes, connectorIds: connectors, lengthMetres: distances.get(end)!};
}
const routes = plan.routes.map((entry: any) => {assert.ok(Array.isArray(entry.laneGoals) && entry.laneGoals.length >= 2 && entry.laneGoals.length <= 12); assert.ok(old.has(entry.laneGoals[0]) && old.has(entry.laneGoals.at(-1)), 'Each candidate route must start/end on accepted lane identities');
  const laneIds: string[] = [], connectorIds: string[] = []; let lengthMetres = 0;
  for (let i = 1; i < entry.laneGoals.length; i++) {const leg = route(entry.laneGoals[i - 1], entry.laneGoals[i]); laneIds.push(...leg.laneIds.slice(i === 1 ? 0 : 1)); connectorIds.push(...leg.connectorIds); lengthMetres += leg.lengthMetres;}
  return {id: entry.id, laneGoals: entry.laneGoals, laneIds, connectorIds, lengthMetres, names: [...new Set(laneIds.map(id => allowed.get(id)!.name))]};
});
const laneIds = [...new Set(routes.flatMap((route: any) => route.laneIds))] as string[], connectorIds = [...new Set(routes.flatMap((route: any) => route.connectorIds))] as string[];
const result = {schemaVersion: 1, status: 'PUBLIC_SOURCE_CONNECTED_CANDIDATE_PENDING_NATIVE_PROJECTION_MASK_COLLISION_AND_TRAVEL', planPin, candidateRoads: plan.candidateRoads, osm: plan.osm, acceptedManifestSha256: plan.acceptedManifestSha256, boundsXZ: r, routes,
  retainedLaneIds: laneIds.filter(id => old.has(id)), newLaneIds: laneIds.filter(id => !old.has(id)), connectorIds, sourceAccessWitnesses: laneIds.map(id => accessWitnesses.get(id)), rejectedLaneCount: rejected.length, rejectedLanes: rejected};
fs.mkdirSync(values.out, {recursive: true}); writeSourceJson(values.out, 'route-candidates.json', result); console.log(JSON.stringify({routes: routes.map((route: any) => ({id: route.id, lanes: route.laneIds.length, metres: route.lengthMetres, names: route.names})), retained: result.retainedLaneIds.length, new: result.newLaneIds.length, connectors: connectorIds.length, rejected: rejected.length}));
