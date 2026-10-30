// Source-only retained-record inventory. Runtime admission and physical support are separate gates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {containsSupportedArea, decodeRoadGraph, decodeSimulationPayload, type Vec3} from '../../packages/world-schema/src/index.ts';
import {inspectRetainedPathExposure} from './lib/expansion-road-merge.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, area: {type: 'string'}, out: {type: 'string'}}}); assert.ok(values.plan && values.area && values.out && !fs.existsSync(values.out));
const pin = (file: string) => ({file: path.resolve(file), sha256: sourceSha256(fs.readFileSync(file))});
const plan = JSON.parse(fs.readFileSync(values.plan, 'utf8')), area = JSON.parse(fs.readFileSync(values.area, 'utf8'));
const manifestFile = path.join(plan.acceptedWorld, 'manifest.json'); assert.equal(pin(manifestFile).sha256, plan.acceptedManifestSha256); assert.equal(area.acceptedManifestSha256, plan.acceptedManifestSha256);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), acceptedCoverage = JSON.parse(readSourceFile(plan.acceptedWorld, manifest.gameplay).toString()), expandedCoverage = {playArea: area.expandedPlayArea, supportedArea: area.supportedArea};
const graph = decodeRoadGraph(await decodeSimulationPayload(readSourceFile(plan.acceptedWorld, manifest.roads), manifest.roads));
assert.equal(pin(plan.osm.file).sha256, plan.osm.sha256); const osm = JSON.parse(fs.readFileSync(plan.osm.file, 'utf8')), ways = new Map<number, any>(osm.elements.filter((e: any) => e.type === 'way').map((e: any) => [e.id, e]));
const sourceCandidate = decodeRoadGraph(fs.readFileSync(plan.candidateRoads.file)); assert.equal(pin(plan.candidateRoads.file).sha256, plan.candidateRoads.sha256);
const broadPhase = <T extends {id: string; points: readonly Vec3[]}>(records: readonly T[]) => records.filter(record => record.points.some(p => !containsSupportedArea(acceptedCoverage, p[0], p[2])));
const groups = [];
for (const kind of ['lanes', 'footways'] as const) {
  const records = graph[kind], candidates = broadPhase(records), source = new Map(sourceCandidate[kind].map(record => [record.id, record]));
  const exposed = inspectRetainedPathExposure(candidates, acceptedCoverage, expandedCoverage).map(item => {
    const before = records.find(record => record.id === item.id)!, current = source.get(item.id), wayId = 'wayId' in before ? Number(before.wayId) : Number(/^w(\d+)$/.exec(before.id)?.[1]), way = ways.get(wayId);
    assert.ok(Number.isSafeInteger(wayId) && wayId > 0);
    const endpointsXZMatch = !!current && [0, before.points.length - 1].every((index, endpoint) => {const p = before.points[index]!, q = current.points[endpoint ? current.points.length - 1 : 0]!; return p[0] === q[0] && p[2] === q[2];});
    return {...item, wayId, name: 'name' in before ? before.name : way?.tags?.name ?? null,
      sourceWay: way ? {sha256: sourceSha256(JSON.stringify(way)), tags: way.tags, nodeIds: way.nodes} : null,
      sameNativeSourceIdentity: current && 'from' in before && 'from' in current && 'to' in before && 'to' in current ? before.from === current.from && before.to === current.to : null,
      endpointsXZMatch, footwaySourceIdentityStatus: kind === 'footways' ? 'SOURCE_WAY_ID_BOUND_OLD_SOURCE_NODE_SEQUENCE_REVIEW_PENDING' : null,
      beforeEndpoints: [before.points[0], before.points.at(-1)], currentEndpoints: current ? [current.points[0], current.points.at(-1)] : null,
      qualification: 'PENDING_SOURCE_ACCESS_LEVEL_NATIVE_SUPPORT_BOUNDARY_HEIGHT_AND_ACTUAL_FOOTPRINT'};
  });
  groups.push({kind, acceptedCount: records.length, outsideVertexCandidates: candidates.length, exposedCount: exposed.length, exposed});
}
fs.mkdirSync(values.out, {recursive: true}); const ref = writeSourceJson(values.out, 'retained-exposure.json', {schemaVersion: 1, status: 'SOURCE_MASK_EXPOSURE_INVENTORY_NOT_PLAYABILITY_PROOF', acceptedManifestSha256: plan.acceptedManifestSha256,
  sourcePins: [pin(values.plan), pin(values.area), pin(plan.osm.file), pin(plan.candidateRoads.file)], sourceAreaStatus: area.qualification.status, groups});
console.log(JSON.stringify({file: path.resolve(values.out, ref.path), sha256: ref.sha256, groups: groups.map(group => ({kind: group.kind, candidates: group.outsideVertexCandidates, exposed: group.exposedCount}))}));
