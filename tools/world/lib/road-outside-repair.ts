import assert from 'node:assert/strict';
import {containsSupportedArea, type GameplayBundle, type RoadGraph, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {isDeepStrictEqual} from 'node:util';
import {sourceSha256} from './source-files.ts';
import {reviewedRoadBaseline,isLiteralInheritedRoad,isLiteralHorizontalRegistration,type OutsideRoadAuthority} from './road-inheritance-context.ts';

type Coverage = Pick<GameplayBundle, 'playArea' | 'supportedArea'>;
export interface RoadProjection {height: number; triangles: string[]}
export type RoadProjector = (x: number, z: number) => RoadProjection | null;
function edges(coverage: Coverage) {
  const b = coverage.playArea, rectangle = [[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ]];
  const rings = [rectangle, ...coverage.supportedArea?.regions.flatMap(region => [region.outer, ...region.holes ?? []]) ?? []];
  return rings.flatMap(ring => ring.map((point, i) => [point, ring[(i + 1) % ring.length]!] as const));
}
function cuts(a: Vec3, b: Vec3, boundaries: ReturnType<typeof edges>) {
  const dx = b[0] - a[0], dz = b[2] - a[2], knots = [0, 1], squared = dx * dx + dz * dz;
  if (!squared) return knots;
  for (const [p, q] of boundaries) {
    const ex = q[0]! - p[0]!, ez = q[1]! - p[1]!, px = p[0]! - a[0], pz = p[1]! - a[2], denominator = dx * ez - dz * ex;
    if (Math.abs(denominator) > 1e-12) {const t = (px * ez - pz * ex) / denominator, u = (px * dz - pz * dx) / denominator; if (t > 0 && t < 1 && u >= 0 && u <= 1) knots.push(t);}
    else if (Math.abs(px * dz - pz * dx) < 1e-8) for (const point of [p, q]) {const t = ((point[0]! - a[0]) * dx + (point[1]! - a[2]) * dz) / squared; if (t > 0 && t < 1) knots.push(t);}
  }
  return [...new Set(knots)].sort((x, y) => x - y);
}
const interpolate = (a: Vec3, b: Vec3, t: number): Vec3 => t === 0 ? [...a] : t === 1 ? [...b] : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sameXZ = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]) <= 1e-8;

/** Verify the complete old inside polyline, including interpolated boundary entry/exit heights.
 * Every original XZ vertex is retained in order; new vertices may only subdivide original segments. */
export function assertOutsideOnlyPolylineRepair(before: readonly Vec3[], after: readonly Vec3[], accepted: Coverage) {
  assert.ok(before.length >= 2 && after.length >= before.length);
  let cursor = 0;
  for (const point of before) {
    while (cursor < after.length && !sameXZ(point, after[cursor]!)) cursor++;
    assert.ok(cursor < after.length, 'Repair removes or moves an original XZ vertex');
    if (containsSupportedArea(accepted, point[0], point[2])) assert.deepEqual(after[cursor], point, 'Repair changes an accepted inside vertex');
    cursor++;
  }
  assert.deepEqual([after[0]![0], after[0]![2], after.at(-1)![0], after.at(-1)![2]], [before[0]![0], before[0]![2], before.at(-1)![0], before.at(-1)![2]], 'Repair changes path endpoints');
  let segment = 0, lastT = -1;
  for (const point of after) {
    let found = false;
    while (segment < before.length - 1) {
      const a = before[segment]!, b = before[segment + 1]!, dx = b[0] - a[0], dz = b[2] - a[2], length2 = dx * dx + dz * dz;
      const t = length2 ? ((point[0] - a[0]) * dx + (point[2] - a[2]) * dz) / length2 : 0, expected = interpolate(a, b, Math.max(0, Math.min(1, t)));
      if (t >= lastT - 1e-9 && t >= -1e-9 && t <= 1 + 1e-9 && sameXZ(expected, point)) {
        if (containsSupportedArea(accepted, point[0], point[2])) assert.ok(Math.abs(point[1] - expected[1]) <= 1e-9, 'Repair changes accepted piecewise height');
        lastT = t; found = true; break;
      }
      segment++; lastT = -1;
    }
    assert.ok(found, 'Repair changes or reverses the source XZ polyline');
  }
  // Explicit boundary vertices prevent changing interpolation inside the old area by moving an outside endpoint.
  const boundary = edges(accepted);
  for (let i = 1; i < before.length; i++) {
    const a = before[i - 1]!, b = before[i]!, knots = cuts(a, b, boundary);
    for (let k = 1; k < knots.length; k++) {
      const mid = interpolate(a, b, (knots[k - 1]! + knots[k]!) / 2);
      if (!containsSupportedArea(accepted, mid[0], mid[2])) continue;
      for (const t of [knots[k - 1]!, knots[k]!]) {const point = interpolate(a, b, t), match = after.find(candidate => sameXZ(candidate, point)); assert.ok(match && Math.abs(match[1] - point[1]) <= 1e-9, 'Repair lacks exact protected boundary interpolation');}
    }
  }
}

export function repairOutsidePolyline(before: readonly Vec3[], accepted: Coverage, expanded: Coverage, project: RoadProjector, step = .25, preservedBoundaryCoverage?: Coverage) {
  assert.ok(before.length >= 2 && before.length <= 100000 && before.every(p => p.length === 3 && p.every(Number.isFinite)));
  assert.ok(step > 0 && step <= .25);
  const after: Vec3[] = [], projectedFlags: boolean[] = [], witnesses = new Set<string>(), protectedBoundaries: {point: Vec3; nativeHeight: number; deviation: number}[] = [];
  let projectedPoints = 0;
  const append = (point: Vec3, projected: boolean, protectedOriginal = false) => {
    const previous = after.at(-1);
    if (previous && sameXZ(previous, point)) {
      // A coverage cut may round onto an existing endpoint. In the current-area
      // path, retain the literal protected input vertex instead of the rounded
      // cut; the existing distance/height policies are unchanged.
      if(protectedOriginal){assert.ok(!projected);assert.ok(Math.abs(previous[1]-point[1])<=1e-8,'Conflicting protected original vertex');after[after.length-1]=point;projectedFlags[projectedFlags.length-1]=false;return;}
      if (projected && !projectedFlags.at(-1) && !containsSupportedArea(accepted, point[0], point[2])) {after[after.length - 1] = point; projectedFlags[projectedFlags.length - 1] = true;}
      else if (!projected && projectedFlags.at(-1) && !containsSupportedArea(accepted, point[0], point[2])) return;
      else assert.ok(Math.abs(previous[1] - point[1]) <= 1e-8, 'Repair would introduce a vertical discontinuity');
      return;
    }
    after.push(point); projectedFlags.push(projected);
  };
  const boundaries = [...edges(accepted), ...edges(expanded), ...(preservedBoundaryCoverage?edges(preservedBoundaryCoverage):[])];
  for (let i = 1; i < before.length; i++) {
    const a = before[i - 1]!, b = before[i]!, knots = cuts(a, b, boundaries), length = Math.hypot(b[0] - a[0], b[2] - a[2]);
    assert.ok(length > 0 && length <= 5000, 'Invalid road segment length');
    for (let k = 1; k < knots.length; k++) {
      const lo = knots[k - 1]!, hi = knots[k]!, midpoint = interpolate(a, b, (lo + hi) / 2);
      const exposed = !containsSupportedArea(accepted, midpoint[0], midpoint[2]) && containsSupportedArea(expanded, midpoint[0], midpoint[2]);
      const steps = exposed ? Math.max(1, Math.ceil((hi - lo) * length / step)) : 1;
      for (let j = 0; j <= steps; j++) {
        const t=preservedBoundaryCoverage?(j===0?lo:j===steps?hi:lo+(hi-lo)*j/steps):lo+(hi-lo)*j/steps;
        const point = interpolate(a, b, t);
        if (exposed) {
          const hit = project(point[0], point[2]); assert.ok(hit && Number.isFinite(hit.height) && hit.triangles.length, `No unique native road support at ${point[0]},${point[2]}`);
          for (const triangle of hit.triangles) witnesses.add(triangle);
          if (containsSupportedArea(accepted, point[0], point[2])) {
            const deviation = Math.abs(hit.height - point[1]); protectedBoundaries.push({point: [...point], nativeHeight: hit.height, deviation});
            assert.ok(deviation <= .2, `Protected old boundary height lacks native support at ${point[0]},${point[2]}: ${deviation}m`);
          } else {point[1] = hit.height; projectedPoints++;}
        }
        append(point, exposed && !containsSupportedArea(accepted, point[0], point[2]),!!preservedBoundaryCoverage&&(t===0||t===1)&&containsSupportedArea(accepted,point[0],point[2])); assert.ok(after.length <= 100000, 'Road repair point cap');
      }
    }
  }
  assertOutsideOnlyPolylineRepair(before, after, accepted);
  return {points: after, proof: {beforePointsSha256: sourceSha256(JSON.stringify(before)), afterPointsSha256: sourceSha256(JSON.stringify(after)), projectedPoints, stepMetres: step, protectedBoundaries, nativeTriangles: [...witnesses].sort(), acceptedPiecewiseGeometryPreserved: true}};
}

/** Narrow append exception: only lane/connector/footway heights and collinear subdivisions outside old support. */
export function assertOutsideOnlyRoadGraphRepair(before: RoadGraph, after: RoadGraph, accepted: Coverage, registration?: OutsideRoadAuthority) {
  const baseline = reviewedRoadBaseline(registration,before,accepted);
  const {lanes: beforeLanes, connectors: beforeConnectors, footways: beforeFootways, ...beforeOther} = before;
  const {lanes: afterLanes, connectors: afterConnectors, footways: afterFootways, ...afterOther} = after;
  assert.deepEqual(afterOther, beforeOther, 'Outside road repair changes unrelated accepted records');
  const changes: {kind:'lanes'|'connectors'|'footways';id:string;beforeSha256:string;afterSha256:string;acceptedPiecewiseGeometryPreserved:boolean;inheritedHeightMetadataReviewed?:boolean;protectedHorizontalRegistrationReviewed?:boolean}[] = [];
  for (const [kind, prior, next] of [['lanes', beforeLanes, afterLanes], ['connectors', beforeConnectors, afterConnectors], ['footways', beforeFootways, afterFootways]] as const) {
    assert.equal(prior.length, next.length, 'Outside road repair adds/removes accepted records');
    for (let i = 0; i < prior.length; i++) {
      const old = prior[i]!, checked = baseline[kind][i]!, fresh = next[i]!;
      if(isLiteralInheritedRoad(registration,before,accepted,kind,fresh)){
        changes.push({kind,id:old.id,beforeSha256:sourceSha256(JSON.stringify(old)),afterSha256:sourceSha256(JSON.stringify(fresh)),acceptedPiecewiseGeometryPreserved:false,...(isLiteralHorizontalRegistration(registration,before,accepted,kind,fresh)?{protectedHorizontalRegistrationReviewed:true}:{inheritedHeightMetadataReviewed:true})});continue;
      }
      if (isDeepStrictEqual(old, fresh) && isDeepStrictEqual(old, checked)) continue;
      const {points: oldPoints, ...oldFields} = checked, {points: newPoints, ...newFields} = fresh;
      assert.deepEqual(newFields, oldFields, 'Outside road repair changes source identity or metadata');
      assertOutsideOnlyPolylineRepair(oldPoints, newPoints, accepted);
      changes.push({kind, id: old.id, beforeSha256: sourceSha256(JSON.stringify(old)), afterSha256: sourceSha256(JSON.stringify(fresh)), acceptedPiecewiseGeometryPreserved: true});
    }
  }
  return changes;
}
