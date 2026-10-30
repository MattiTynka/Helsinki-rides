import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import type {RoadSourceElement, RoadSupportTriangle} from './expansion-road-merge.ts';
import type {LocalPolygon} from './geometry.ts';
import type {GroundPiece} from './ground.ts';
import {sourceSha256} from './source-files.ts';
import {buildExtraBridgeDeck, type ExtraBridgeDeckProfile} from './delivery-extra-bridges-mesh.ts';
import {splitBridgeFaces} from './bridge-reconstruction.ts';

// Literal, independently reviewed source/native proposal. An arbitrary caller
// cannot create a new walking level by supplying a self-hashed profile.
export const EAST_BRIDGE_WALKING_SEAM_SHA256 = 'c756d737ab75509a3f31b6dcdb324258d53be7dbc839f93cbdb9fdedead1c9c0';
export const EAST_BRIDGE_WALKING_SEAM_PUBLICATION = 'publication/extra-bridges/selkamerensilta/walking-seam-profile.json';
type Point = [number, number];
interface SeamProfile {
  schemaVersion: 1; kind: 'source-bound-bridge-walking-seam'; id: string; parentProfileSha256: string; approvedProposalSha256: string; role: 'upperWalking';
  source: {osmSha256: string; streetPartsSha256: string; wayId: number; waySha256: string; parts: {partId: string; sha256: string; subtype: string; edge: {a: Point; b: Point; maximumDistance: number}}[]};
  originalHole: polygonClipping.MultiPolygon; rawSourceGap: polygonClipping.MultiPolygon; physicalDomain: Point[];
  faces: {cell: string; points: [Vec3, Vec3, Vec3]}[]; literalFlanks: RoadSupportTriangle[];
}
interface BaseProfile {deck: ExtraBridgeDeckProfile; sources: {osm: {sha256: string}; streetParts: {sha256: string}}}
declare const authorityBrand: unique symbol;
export interface ReviewedBridgeWalkingSeam {readonly [authorityBrand]: true}
const authorities = new WeakMap<object, SeamProfile>();
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
const cross = (a: Point, b: Point, p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const ringArea = (ring: readonly Point[]) => Math.abs(ring.slice(1, -1).reduce((sum, p, i) => sum + cross(ring[0]!, p, ring[i + 2]!), 0)) / 2;
const area = (geometry: polygonClipping.MultiPolygon) => geometry.reduce((sum, p) => sum + ringArea(p[0]!) - p.slice(1).reduce((n, ring) => n + ringArea(ring), 0), 0);
function segmentDistance(q: Point, a: Point, b: Point) {
  const dx = b[0] - a[0], dz = b[1] - a[1], length = dx * dx + dz * dz;
  const t = length ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / length)) : 0;
  return Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dz * t);
}
function distance(points: readonly Vec3[], q: Point) {
  const p = points.map(v => [v[0], v[2]] as Point), sign = Math.sign(cross(p[0]!, p[1]!, p[2]!));
  if (!sign) return Infinity;
  if (p.every((a, i) => sign * cross(a, p[(i + 1) % 3]!, q) >= 0)) return 0;
  return Math.min(...p.map((a, i) => segmentDistance(q, a, p[(i + 1) % 3]!)));
}
function height(points: readonly Vec3[], q: Point) {
  const [a, b, c] = points as [Vec3, Vec3, Vec3], d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
  assert.ok(Math.abs(d) > 1e-12);
  const u = ((b[0] - q[0]) * (c[2] - q[1]) - (c[0] - q[0]) * (b[2] - q[1])) / d;
  const v = ((c[0] - q[0]) * (a[2] - q[1]) - (a[0] - q[0]) * (c[2] - q[1])) / d;
  return u * a[1] + v * b[1] + (1 - u - v) * c[1];
}
function normal(points: readonly Vec3[]) {
  const [a, b, c] = points as [Vec3, Vec3, Vec3], u = b.map((v, i) => v - a[i]!), v = c.map((n, i) => n - a[i]!);
  const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  return n[1]! / Math.hypot(...n);
}
export function readBridgeWalkingSeamProfile(bytes: Uint8Array, baseBytes: Uint8Array) {
  assert.equal(sourceSha256(bytes), EAST_BRIDGE_WALKING_SEAM_SHA256, 'Unapproved bridge walking seam profile');
  const profile = JSON.parse(Buffer.from(bytes).toString()) as SeamProfile;
  assert.equal(sourceSha256(baseBytes), profile.parentProfileSha256, 'Bridge seam parent profile changed');
  return profile;
}
/** Geometry verifier has no authority side effect. Only the pinned constructor
 * below may issue an additive role token after raw source identity checks. */
export function qualifyBridgeWalkingSeamGeometry(profile: SeamProfile, base: BaseProfile, floor: readonly RoadSupportTriangle[]) {
  const authored = new Map<string, {sourcePartIds: number[]}>();
  for (const [cell, faces] of splitBridgeFaces(buildExtraBridgeDeck(base.deck).faces)) for (const face of faces) {
    if (face.role === 'footway') authored.set(cell + '|' + hash(face.points), face as typeof face & {sourcePartIds: number[]});
  }
  const actual = new Map(floor.map(face => [face.id, face]));
  const flanks = profile.literalFlanks.map(face => {
    assert.deepEqual(actual.get(face.id), face, 'Original bridge walking flank changed');
    assert.equal(face.tag, 'raised:asphalt:bridge-reconstruction');
    const source = authored.get(face.id.split(':')[1]! + '|' + hash(face.points));
    assert.ok(source && source.sourcePartIds.every(id => profile.source.parts.some(p => p.partId === String(id))), 'Seam flank is not its published upper walking sheet');
    return face;
  });
  const domain: polygonClipping.Polygon = [profile.physicalDomain], continuous = [], overlaps = [];
  let maximumDistance = 0, maximumHeightError = 0, minimumNormal = 1;
  for (const face of profile.faces) {
    assert.equal(face.cell, 'c_m16_p06'); assert.ok(face.points.flat().every(v => Number.isFinite(v) && Math.fround(v) === v));
    const n = normal(face.points); assert.ok(n > .98, 'Bridge seam changes walking grade'); minimumNormal = Math.min(minimumNormal, n);
    const triangle: polygonClipping.Polygon = [face.points.map(p => [p[0], p[2]])];
    assert.ok(area(polygonClipping.difference(triangle, domain)) < 1e-10, 'Bridge seam leaves its reviewed physical domain');
    const common = flanks.map(t => ({id: t.id, distance: Math.max(...face.points.map(p => distance(t.points, [p[0], p[2]]))), error: Math.max(...face.points.map(p => Math.abs(p[1] - height(t.points, [p[0], p[2]]))))})).filter(w => w.distance <= .005 && w.error < .002).sort((a, b) => a.distance - b.distance)[0];
    assert.ok(common, 'Entire bridge seam face requires one literal native flank within5mm/2mm'); continuous.push(common);
    maximumDistance = Math.max(maximumDistance, common.distance); maximumHeightError = Math.max(maximumHeightError, common.error);
    for (const p of face.points) {
      const near = flanks.filter(t => distance(t.points, [p[0], p[2]]) <= .005); assert.ok(near.length);
      const heights = near.map(t => height(t.points, [p[0], p[2]])); assert.ok(Math.max(...heights) - Math.min(...heights) < .002, 'Bridge seam crosses distinct levels');
    }
    for (const t of flanks) {
      const intersection = polygonClipping.intersection(triangle, [t.points.map(p => [p[0], p[2]] as Point)]); if (!intersection.length) continue;
      const error = Math.max(...intersection.flat(2).map(q => Math.abs(height(face.points, q) - height(t.points, q))));
      assert.ok(error < .002, 'Bridge seam changes an overlapped native plane'); maximumHeightError = Math.max(maximumHeightError, error); overlaps.push({id: t.id, error});
    }
  }
  const union = polygonClipping.union(...profile.faces.map(f => [f.points.map(p => [p[0], p[2]] as Point)]) as [polygonClipping.Polygon, ...polygonClipping.Polygon[]]);
  assert.ok(area(polygonClipping.difference(profile.originalHole, union)) < 1e-10, 'Bridge seam does not close its complete reviewed gap');
  return {maximumDistance, maximumHeightError, minimumNormal, continuous, overlaps, originalFlanks: flanks.map(f => ({id: f.id, sha256: hash(f.points)}))};
}
export function prepareReviewedBridgeWalkingSeam(input: {profileBytes: Uint8Array; baseProfileBytes: Uint8Array; sourcePins: {osmSha256: string; streetPartsSha256: string}; parts: readonly LocalPolygon[]; way: RoadSourceElement; floor: readonly RoadSupportTriangle[]}) {
  const profile = readBridgeWalkingSeamProfile(input.profileBytes, input.baseProfileBytes), base = JSON.parse(Buffer.from(input.baseProfileBytes).toString()) as BaseProfile;
  assert.equal(input.sourcePins.osmSha256, profile.source.osmSha256); assert.equal(input.sourcePins.streetPartsSha256, profile.source.streetPartsSha256);
  assert.equal(base.sources.osm.sha256, profile.source.osmSha256); assert.equal(base.sources.streetParts.sha256, profile.source.streetPartsSha256);
  assert.equal(input.way.id, profile.source.wayId); assert.equal(hash(input.way), profile.source.waySha256, 'Bridge seam public source way changed');
  const selected = profile.source.parts.map(ref => {
    const part = input.parts.find(p => p.id === ref.partId); assert.ok(part); assert.equal(hash(part), ref.sha256, 'Bridge seam municipal source part changed');
    assert.equal(part.properties.paatyyppi, 'Silta'); assert.equal(base.deck.upperParts.find(p => String(p.id) === part.id)?.role, 'walk');
    assert.ok(profile.physicalDomain.every(p => segmentDistance(p, ref.edge.a, ref.edge.b) <= .006)); return part;
  });
  const source = polygonClipping.union(...selected.map(p => p.rings.map(r => r.map(([x, n]) => [x, -n] as Point))) as [polygonClipping.Polygon, ...polygonClipping.Polygon[]]);
  assert.deepEqual(polygonClipping.difference(profile.originalHole, source), profile.rawSourceGap, 'Raw walking source partition gap changed');
  const geometry = qualifyBridgeWalkingSeamGeometry(profile, base, input.floor), token = Object.freeze({}) as ReviewedBridgeWalkingSeam;
  authorities.set(token, structuredClone(profile));
  const pieces: GroundPiece[] = profile.faces.map(face => ({cell: face.cell, finish: 'asphalt', level: 'raised', tag: 'raised:asphalt:bridge-reconstruction', positions: face.points.flat(), uvs: face.points.flatMap(p => [Math.fround(p[0] / 6), Math.fround(-p[2] / 6)]), indices: [0, 1, 2]}));
  return {authority: token, pieces, proof: {profileSha256: EAST_BRIDGE_WALKING_SEAM_SHA256, approvedProposalSha256: profile.approvedProposalSha256, parentProfileSha256: profile.parentProfileSha256, source: profile.source, role: profile.role, faces: profile.faces, geometry}};
}
export function reviewedBridgeWalkingSeamFaces(authority: ReviewedBridgeWalkingSeam) {
  const profile = authorities.get(authority); assert.ok(profile, 'Missing opaque reviewed bridge walking seam authority');
  return structuredClone({faces: profile.faces, sourcePartIds: profile.source.parts.map(p => Number(p.partId)), sourceWayId: profile.source.wayId});
}
