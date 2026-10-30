import assert from 'node:assert/strict';
import {pointAlong, polylineLength, type RoadGraph, type RoadLane, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {sourceSha256} from './source-files.ts';

const recordSha256 = (record: unknown) => sourceSha256(JSON.stringify(record));
function trimEndpoint(lane: RoadLane, start: boolean, metres: number) {
  const length = polylineLength(lane.points); assert.ok(length > metres * 4, 'Short lane cannot support bounded connector repair');
  const boundary = pointAlong(lane.points, start ? metres : length - metres).point;
  let distance = 0;
  const retained = lane.points.filter((point, i, points) => {
    if (i) distance += Math.hypot(point[0] - points[i - 1]![0], point[2] - points[i - 1]![2]);
    return start ? distance > metres + 1e-9 : distance < length - metres - 1e-9;
  });
  const points = start ? [boundary, ...retained] : [...retained, boundary];
  return {...lane, points, length: polylineLength(points)};
}

/** Repair only newly selected straight junctions whose native minimum cubic handles reverse a centimetre-scale span.
 * Trimming new lane endpoints follows their exact source polyline; accepted records are never edited.
 */
export function repairNewStraightConnectorOvershoot(accepted: RoadGraph, candidate: RoadGraph, selectedLaneIds: readonly string[], connectorIds: readonly string[], project: (x: number, z: number) => {height: number} | null, reviewedCurves: readonly {id: string; maximumAngleDegrees: number}[] = [], projectConnector?: (id:string,x:number,z:number)=>{height:number}|null) {
  const curveReviews = new Map(reviewedCurves.map(review => [review.id, review]));
  assert.equal(curveReviews.size, reviewedCurves.length, 'Duplicate source continuation review');
  assert.ok(reviewedCurves.length <= 1000 && reviewedCurves.every(review => connectorIds.includes(review.id) && Number.isFinite(review.maximumAngleDegrees) && review.maximumAngleDegrees > 15 && review.maximumAngleDegrees <= 30), 'Invalid bounded source continuation review');
  const consumedReviews = new Set<string>();
  const selected = new Set(selectedLaneIds), old = new Map(accepted.lanes.map(lane => [lane.id, lane])), graph = structuredClone(candidate);
  const changes: {kind: 'lanes' | 'connectors'; id: string; beforeSha256: string; afterSha256: string; before: unknown; after: unknown}[] = [], junctions = [];
  const lane = (id: string) => old.get(id) ?? graph.lanes.find(lane => lane.id === id)!;
  for (const id of connectorIds) {
    const index = graph.connectors.findIndex(connector => connector.id === id), connector = graph.connectors[index]; assert.ok(connector && !accepted.connectors.some(prior => prior.id === id));
    const from = lane(connector.from), to = lane(connector.to); assert.ok(from && to && from.to === connector.node && to.from === connector.node, 'Connector repair requires the same explicit source node');
    const a = from.points.at(-1)!, b = to.points[0]!, span = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (connector.turn !== 'straight' || span > .05 || polylineLength(connector.points) <= span + .1) continue;
    const incoming = pointAlong(from.points, polylineLength(from.points)).tangent, outgoing = pointAlong(to.points, 0).tangent;
    const review = curveReviews.get(id), maximumAngleDegrees = review?.maximumAngleDegrees ?? 15;
    if (review) {
      assert.ok(span <= .001 && selected.has(from.id) && selected.has(to.id) && !old.has(from.id) && !old.has(to.id), 'Reviewed curve requires coincident, newly authored source endpoints on both sides');
      consumedReviews.add(id);
    }
    assert.ok(incoming[0] * outgoing[0] + incoming[1] * outgoing[1] >= Math.cos(maximumAngleDegrees * Math.PI / 180), `Near-coincident connector is not a qualified straight continuation: ${id}`);
    assert.ok(selected.has(from.id) || selected.has(to.id), 'Connector repair cannot trim accepted endpoints');
    const trims = [];
    for (const [record, start] of [[from, false], [to, true]] as const) if (selected.has(record.id)) {
      assert.ok(!old.has(record.id)); const replacement = trimEndpoint(record, start, .1), at = graph.lanes.findIndex(lane => lane.id === record.id); assert.ok(at >= 0);
      (graph.lanes as RoadLane[])[at] = replacement;
      changes.push({kind: 'lanes', id: record.id, beforeSha256: recordSha256(record), afterSha256: recordSha256(replacement), before: record, after: replacement});
      trims.push({id: record.id, endpoint: start ? 'start' : 'end', metres: .1});
    }
    const source = lane(from.id), destination = lane(to.id), p = source.points.at(-1)!, q = destination.points[0]!, dx = q[0] - p[0], dz = q[2] - p[2], distance = Math.hypot(dx, dz);
    const u = pointAlong(source.points, polylineLength(source.points)).tangent, v = pointAlong(destination.points, 0).tangent;
    assert.ok(distance >= .05 && distance <= .26 && (dx * u[0] + dz * u[1]) / distance > .95 && (dx * v[0] + dz * v[1]) / distance > .95, 'Trimmed connector is not forward and source-aligned');
    const handle = Math.min(.1, distance / 3), c = [p[0] + u[0] * handle, p[2] + u[1] * handle], d = [q[0] - v[0] * handle, q[2] - v[1] * handle];
    const points: Vec3[] = [];
    for (let i = 0, steps = Math.max(2, Math.ceil(distance / .05)); i <= steps; i++) {
      if (!i) {points.push([...p]); continue;} if (i === steps) {points.push([...q]); continue;}
      const t = i / steps, s = 1 - t, x = s ** 3 * p[0] + 3 * s * s * t * c[0]! + 3 * s * t * t * d[0]! + t ** 3 * q[0], z = s ** 3 * p[2] + 3 * s * s * t * c[1]! + 3 * s * t * t * d[1]! + t ** 3 * q[2];
      const hit = projectConnector?projectConnector(id,x,z):project(x, z); assert.ok(hit, 'Repaired connector lacks native road ground'); points.push([x, hit.height, z]);
    }
    for (let i = 1; i < points.length; i++) assert.ok((points[i]![0] - points[i - 1]![0]) * u[0] + (points[i]![2] - points[i - 1]![2]) * u[1] > 0, 'Repaired connector reverses direction');
    const replacement = {...connector, points, length: polylineLength(points)}; (graph.connectors as typeof replacement[])[index] = replacement;
    changes.push({kind: 'connectors', id, beforeSha256: recordSha256(connector), afterSha256: recordSha256(replacement), before: connector, after: replacement});
    junctions.push({id, node: connector.node, originalEndpointSpanMetres: span, originalLengthMetres: polylineLength(connector.points), originalEndpoints: [a, b], finalEndpoints: [p, q], incoming, outgoing, trims, handleMetres: handle, finalLengthMetres: replacement.length, ...(review ? {sourceCurveReview: review} : {})});
  }
  assert.equal(consumedReviews.size, curveReviews.size, 'Source continuation review did not match a repaired junction');
  return {graph, witness: {policy: 'source-identical straight junction, original span <= 0.05 m, trim only new source polylines by 0.10 m, monotone cubic handles <= min(0.10 m, span/3)', ...(reviewedCurves.length ? {reviewedCurves, curvePolicy: 'Only explicitly source-pinned coincident new endpoints; at most 30 degrees; unchanged forward alignment > 0.95 and native ground gates'} : {}), changes, junctions}};
}
