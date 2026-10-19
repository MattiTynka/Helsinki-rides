// Source-bound exceptions for a small explicit set of tree registrations.
import assert from 'node:assert/strict';
import { NodeIO, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { pointInPolygon } from './geometry.ts';
import { registrationSha256, type GroundRegistrationSupport, type RegistrationTree, type TreeRegistrationCorrection, type TreeSoilContext } from './tree-ground-registration.ts';

export type BarkPoint = [number, number, number];
export type BarkTriangle = [BarkPoint, BarkPoint, BarkPoint];
export interface VisibleTreeObstacle { cell: string; node: string; triangle: number; vertices: BarkTriangle; intersections: BarkPoint[] }
export interface TreeBarkModel { root: BarkPoint[]; triangles: BarkTriangle[] }
export interface TreeBarkProfile {
  rootPoints: [number, number][];
  rootSamples: (GroundRegistrationSupport | null)[];
  gridPoints: [number, number][];
  gridSamples: (GroundRegistrationSupport | null)[];
  range: [number, number] | null;
  missing: number;
  maximumAdjacentStep: number;
  plane: { slope: number; maximumResidual: number } | null;
  sha256: string;
}
export interface ContinuousTreeCase { id: string; maximumRangeMetres: number; maximumAdjacentStepMetres: number; maximumPlaneResidualMetres: number; maximumSlope: number }
const subtract = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v - b[i]!);
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
const cross = (a: readonly number[], b: readonly number[]): BarkPoint => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

function primitiveTriangles(p: Primitive, transform: (p: number[]) => BarkPoint): BarkTriangle[] {
  const P = p.getAttribute('POSITION'), I = p.getIndices(); assert.ok(P && I && p.getMode() === 4, 'Tree proof needs indexed triangles');
  return Array.from({ length: I.getCount() / 3 }, (_, k) => [0, 1, 2].map(j => transform(P.getElement(I.getScalar(k * 3 + j), []))) as BarkTriangle);
}
export async function decodeTreeBarkModels(bytes: Uint8Array): Promise<Map<string, TreeBarkModel>> {
  await MeshoptDecoder.ready; const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(bytes), models = new Map<string, TreeBarkModel>();
  for (const node of doc.getRoot().listNodes().filter(n => n.getMesh())) {
    const matrix = node.getWorldMatrix();
    const triangles = node.getMesh()!.listPrimitives().filter(p => p.getMaterial()?.getName() === 'tree_bark').flatMap(p => primitiveTriangles(p, v => [0, 1, 2].map(a => matrix[a]! * v[0]! + matrix[4 + a]! * v[1]! + matrix[8 + a]! * v[2]! + matrix[12 + a]!) as BarkPoint));
    if (!triangles.length) continue;
    const root: BarkPoint[] = [];
    for (const v of triangles.flat()) if (Math.abs(v[1]) < .002 && !root.some(p => Math.hypot(p[0] - v[0], p[2] - v[2]) < 1e-5)) root.push(v);
    assert.ok(root.length >= 3 && root.length <= 64, 'Expected bounded actual bark root ring');
    root.sort((a, b) => Math.atan2(a[2], a[0]) - Math.atan2(b[2], b[0]));
    models.set(node.getName(), { root, triangles });
  }
  return models;
}
export function transformedTreeBark(model: TreeBarkModel, tree: RegistrationTree, originY: number): BarkTriangle[] {
  const c = Math.cos(tree.yaw), s = Math.sin(tree.yaw);
  const transform = ([x, y, z]: BarkPoint): BarkPoint => [tree.position[0] + c * x * tree.scale[0] + s * z * tree.scale[2], originY + y * tree.scale[1], tree.position[2] - s * x * tree.scale[0] + c * z * tree.scale[2]];
  return model.triangles.map(t => t.map(transform) as BarkTriangle);
}
function fittedPlane(points: readonly (readonly [number, number])[], samples: readonly (GroundRegistrationSupport | null)[], x: number, z: number) {
  const A = Array.from({ length: 3 }, () => new Array<number>(4).fill(0));
  points.forEach((p, k) => { if (!samples[k]) return; const v = [p[0] - x, p[1] - z, 1]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i]![j]! += v[i]! * v[j]!; A[i]![3]! += v[i]! * samples[k]!.height; } });
  for (let i = 0; i < 3; i++) { let pivot = i; for (let j = i + 1; j < 3; j++) if (Math.abs(A[j]![i]!) > Math.abs(A[pivot]![i]!)) pivot = j; [A[i], A[pivot]] = [A[pivot]!, A[i]!]; const d = A[i]![i]!; if (Math.abs(d) < 1e-12) return null; for (let j = i; j < 4; j++) A[i]![j]! /= d; for (let k = 0; k < 3; k++) if (k !== i) { const f = A[k]![i]!; for (let j = i; j < 4; j++) A[k]![j]! -= f * A[i]![j]!; } }
  const c = A.map(r => r[3]!);
  return { slope: Math.hypot(c[0]!, c[1]!), maximumResidual: Math.max(...points.flatMap((p, i) => samples[i] ? [Math.abs(samples[i]!.height - c[0]! * (p[0] - x) - c[1]! * (p[1] - z) - c[2]!)] : [])) };
}
export function measureTreeBarkProfile(model: TreeBarkModel, tree: RegistrationTree, sample: (points: readonly [number, number][]) => (GroundRegistrationSupport | null)[]): TreeBarkProfile {
  const c = Math.cos(tree.yaw), s = Math.sin(tree.yaw), [x, , z] = tree.position;
  const ring: [number, number][] = model.root.map(([rx, , rz]) => [x + c * rx * tree.scale[0] + s * rz * tree.scale[2], z - s * rx * tree.scale[0] + c * rz * tree.scale[2]]);
  const rootPoints: [number, number][] = [[x, z], ...ring], radius = Math.max(...ring.map(p => Math.hypot(p[0] - x, p[1] - z))), n = Math.ceil(radius / .02), gridPoints: [number, number][] = [], keys: string[] = [];
  for (let iz = -n; iz <= n; iz++) for (let ix = -n; ix <= n; ix++) { const p: [number, number] = [x + ix * .02, z + iz * .02]; if (pointInPolygon(p, [ring])) { gridPoints.push(p); keys.push(`${ix}:${iz}`); } }
  const rootSamples = sample(rootPoints), gridSamples = sample(gridPoints), heights = [...rootSamples, ...gridSamples].flatMap(p => p ? [p.height] : []), by = new Map(keys.map((k, i) => [k, gridSamples[i]]));
  let maximumAdjacentStep = 0;
  for (let i = 0; i < keys.length; i++) { const [ix, iz] = keys[i]!.split(':').map(Number); for (const [dx, dz] of [[1, 0], [0, 1]]) { const a = gridSamples[i], b = by.get(`${ix! + dx!}:${iz! + dz!}`); if (a && b) maximumAdjacentStep = Math.max(maximumAdjacentStep, Math.abs(a.height - b.height)); } }
  const body = { rootPoints, rootSamples, gridPoints, gridSamples, range: heights.length ? [Math.min(...heights), Math.max(...heights)] as [number, number] : null, missing: [...rootSamples, ...gridSamples].filter(p => !p).length, maximumAdjacentStep, plane: fittedPlane(gridPoints, gridSamples, x, z) };
  return { ...body, sha256: registrationSha256(JSON.stringify(body)) };
}
export function segmentBarkTriangle(a: BarkPoint, b: BarkPoint, triangle: BarkTriangle): BarkPoint | null {
  const d = subtract(b, a), e1 = subtract(triangle[1], triangle[0]), e2 = subtract(triangle[2], triangle[0]), p = cross(d, e2), determinant = dot(e1, p);
  if (Math.abs(determinant) < 1e-12) return null;
  const inverse = 1 / determinant, s = subtract(a, triangle[0]), u = dot(s, p) * inverse;
  if (u < -1e-7 || u > 1 + 1e-7) return null;
  const q = cross(s, e1), v = dot(d, q) * inverse, t = dot(e2, q) * inverse;
  if (v < -1e-7 || u + v > 1 + 1e-7 || t < -1e-7 || t > 1 + 1e-7) return null;
  return a.map((x, i) => x + t * d[i]!) as BarkPoint;
}
export function barkTriangleIntersections(a: BarkTriangle, b: BarkTriangle): BarkPoint[] {
  const out: BarkPoint[] = [];
  for (const [one, two] of [[a, b], [b, a]] as const) for (let i = 0; i < 3; i++) { const p = segmentBarkTriangle(one[i]!, one[(i + 1) % 3]!, two); if (p && !out.some(q => Math.hypot(...subtract(q, p)) < 1e-7)) out.push(p); }
  return out;
}
export async function visibleTreeObstacles(tree: RegistrationTree, model: TreeBarkModel, originY: number, soil: [number, number], cells: readonly { id: string; bytes: Uint8Array }[]): Promise<VisibleTreeObstacle[]> {
  await MeshoptDecoder.ready; const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }), bark = transformedTreeBark(model, tree, originY), radius = tree.trunkRadius + 1, [x, , z] = tree.position, out: VisibleTreeObstacle[] = [];
  const bounds = (v: BarkTriangle) => [0, 1, 2].map(a => [Math.min(...v.map(p => p[a]!)), Math.max(...v.map(p => p[a]!))]);
  const barkBoxes = bark.map(bounds);
  for (const cell of cells) { const doc = await io.readBinary(cell.bytes); for (const node of doc.getRoot().listNodes().filter(n => n.getMesh() && !n.getName().includes('_water'))) { const M = node.getWorldMatrix(); for (const primitive of node.getMesh()!.listPrimitives()) {
    const triangles = primitiveTriangles(primitive, v => [0, 1, 2].map(a => M[a]! * v[0]! + M[4 + a]! * v[1]! + M[8 + a]! * v[2]! + M[12 + a]!) as BarkPoint);
    triangles.forEach((v, index) => { const box = bounds(v); if (box[0]![0]! > x + radius || box[0]![1]! < x - radius || box[2]![0]! > z + radius || box[2]![1]! < z - radius || box[1]![0]! > soil[1] + 2 || box[1]![1]! < soil[0] + .01) return;
      const normal = cross(subtract(v[1], v[0]), subtract(v[2], v[0])); if (Math.abs(normal[1]) / Math.hypot(...normal) > .3) return;
      const intersections: BarkPoint[] = [];
      for (let i = 0; i < bark.length; i++) { if (!box.every((q, axis) => q[0]! <= barkBoxes[i]![axis]![1]! + 1e-7 && q[1]! >= barkBoxes[i]![axis]![0]! - 1e-7)) continue; for (const p of barkTriangleIntersections(bark[i]!, v)) if (p[1] > soil[0] + .01 && p[1] < soil[1] + 2 && !intersections.some(q => Math.hypot(...subtract(q, p)) < 1e-5)) intersections.push(p); }
      if (intersections.length) out.push({ cell: cell.id, node: node.getName(), triangle: index, vertices: v, intersections });
    });
  } } }
  return out;
}
export function qualifyContinuousTreeCase(profile: TreeBarkProfile, context: TreeSoilContext, obstacles: readonly VisibleTreeObstacle[], limits: ContinuousTreeCase) {
  assert.ok(limits.maximumRangeMetres > .6 && limits.maximumRangeMetres <= 2 && limits.maximumAdjacentStepMetres > 0 && limits.maximumAdjacentStepMetres <= .08 && limits.maximumPlaneResidualMetres <= .16 && limits.maximumSlope <= 4, 'Unbounded continuous-soil exception');
  const barriers = obstacles.filter(o => !o.node.endsWith('_ground_yard') && !o.node.endsWith('_ground_grass'));
  const qualified = profile.missing === 0 && !!profile.range && profile.range[1] - profile.range[0] <= limits.maximumRangeMetres && profile.maximumAdjacentStep <= limits.maximumAdjacentStepMetres && !!profile.plane && profile.plane.maximumResidual <= limits.maximumPlaneResidualMetres && profile.plane.slope <= limits.maximumSlope && !context.retainingWallIds.length && !context.buildingIds.length && !context.waterPointIndices.length && !barriers.length;
  assert.ok(qualified, `${limits.id}: final continuous-soil exception no longer qualified`);
  return { profileSha256: profile.sha256, range: profile.range, plane: profile.plane, maximumAdjacentStep: profile.maximumAdjacentStep, context, obstacleCount: obstacles.length, barrierCount: barriers.length };
}
export function planTreeCaseSink(tree: RegistrationTree, baseline: readonly (GroundRegistrationSupport | null)[], final: readonly (GroundRegistrationSupport | null)[], anchor: number, target: number, threshold: number, policy: 'continuous-soil-sink' | 'shore-bank-sink'): TreeRegistrationCorrection {
  const heights = final.flatMap(p => p ? [p.height] : []); assert.ok(heights.length && Number.isFinite(anchor) && Number.isFinite(target)); const delta = target - tree.position[1], applied = Math.abs(delta) > threshold;
  return { policy, id: tree.id, beforeY: tree.position[1], afterY: applied ? target : tree.position[1], delta: applied ? delta : 0, anchorHeight: anchor, baselineOffset: baseline[0] ? tree.position[1] - baseline[0].height : null, baselineSamples: baseline, finalSamples: final, finalSupportRange: [Math.min(...heights), Math.max(...heights)], maximumRimOffsetChange: null, applied };
}
export function qualifyTreeBank(profile: TreeBarkProfile, context: TreeSoilContext, visual: readonly (GroundRegistrationSupport | null)[], obstacles: readonly VisibleTreeObstacle[], waterY: number, denseContext: TreeSoilContext) {
  assert.equal(profile.rootSamples.length, visual.length); assert.ok(profile.rootSamples[0] && visual[0], 'Bank centre must have actual rendered and colliding dry support');
  const wet = new Set(context.waterPointIndices), samples = profile.rootSamples, missing = samples.flatMap((s, i) => !s ? [i] : []), dry = samples.filter((s): s is GroundRegistrationSupport => !!s);
  samples.forEach((s, i) => { assert.equal(!!s, !!visual[i], 'Bank visual/collision root support mismatch'); if (s) assert.ok(Math.abs(s.height - visual[i]!.height) < .02); });
  assert.ok(!context.retainingWallIds.length && !context.buildingIds.length && !wet.has(0) && missing.length > 0 && missing.every(i => wet.has(i)) && samples.every((s, i) => !s || !wet.has(i)), 'Bank source ambiguity');
  assert.ok(samples.slice(1).filter(Boolean).length >= Math.ceil((samples.length - 1) / 2), 'At least half the actual bark rim must be dry');
  const denseWet = new Set(denseContext.waterPointIndices);
  assert.ok(!denseContext.retainingWallIds.length && !denseContext.buildingIds.length && profile.gridSamples.every((s, i) => s ? !denseWet.has(i) : denseWet.has(i)), 'Bank interior has unsupported non-water or conflicting soil');
  const range: [number, number] = profile.range ?? [Math.min(...dry.map(s => s.height)), Math.max(...dry.map(s => s.height))];
  assert.ok(range[1] - range[0] < .10 && profile.maximumAdjacentStep <= .02 && !obstacles.length, 'Bank root is discontinuous or intersects an obstacle');
  assert.ok(Number.isFinite(waterY) && range[0] > waterY && range[0] - waterY < 1, 'Bank water/soil elevation inconsistent');
  const target = Math.min(range[0] - .3, waterY - .02);
  return { anchor: range[0], target, bankBurial: range[0] - target, waterY, missingRootIndices: missing, dryRimCount: samples.slice(1).filter(Boolean).length, actualRootRange: range, profileSha256: profile.sha256 };
}
