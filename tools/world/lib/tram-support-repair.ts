// Append-only local road support. Source coordinates, textures and collision stay immutable.
import assert from 'node:assert/strict';
import type {Document, Primitive} from '@gltf-transform/core';
import {encodeCollisionBundle, parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {appendGroundGlb, type GroundGlbAppend} from './append-ground-glb.ts';
import {readFacadeGlb} from './facade-glb.ts';
import type {GroundAttributeArray} from './replace-ground-glb.ts';
import {drapeTramFootprints, DEFAULT_TRAM_PROFILE, type TramGroundTriangle, type TramPoint} from './tram-visuals.ts';
import earcut from 'earcut';
import {replaceGroundGlb, type GroundGlbReplacement} from './replace-ground-glb.ts';
import type {FrontierMesh} from './frontier-ground.ts';

export type SupportVertex = [number, number, number];
export type SupportTriangle = [SupportVertex, SupportVertex, SupportVertex];
export interface TramSupportPatch {
  id: string;
  cell: string;
  boundsXZ: [number, number, number, number];
  footprint?: TramPoint[];
  boundary?: SupportVertex[];
  triangles: SupportTriangle[];
  sourceNode: string;
  sourcePrimitive: number;
  observations: string[];
}
export interface SupportApproachSpec {
  id: string; cell: string; origin: TramPoint; lowerDirection: TramPoint;
  length: number; upperLength: number; wheelHalfWidth: number; returnWidth: number; seamSearch: number;
  sourceNode: string; sourcePrimitive: number;
}
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]!;
function clipPositive(ring: TramPoint[], value: (p: TramPoint) => number): TramPoint[] {
  const out: TramPoint[] = [];
  for (let i = 0; i < ring.length; i++) {const a = ring[i]!, b = ring[(i + 1) % ring.length]!, va = value(a), vb = value(b); if (va >= 0) out.push(a); if ((va >= 0) !== (vb >= 0)) {const t = va / (va - vb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);}}
  return out;
}
function intersectConvex(a: TramPoint[], b: TramPoint[]): TramPoint[] {
  const cross = (a: TramPoint, b: TramPoint, c: TramPoint) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const sign = Math.sign(cross(b[0]!, b[1]!, b[2]!)); let out = a;
  for (let i = 0; i < b.length && out.length >= 3; i++) out = clipPositive(out, p => cross(b[i]!, b[(i + 1) % b.length]!, p) * sign);
  return out;
}
export function supportHeight(t: SupportTriangle, p: TramPoint): number {const w = weights(t, [p[0], 0, p[1]]); return w.reduce((n, v, i) => n + v * t[i]![1], 0);}
/** Construct only positive overlays of the actual highest rendered/collision
 * floor. Old source triangles are not flattened or removed. Crossfall stays
 * measured; a lane has a full wheel strip and explicit lateral returns. */
export function buildSupportApproach(ground: readonly TramGroundTriangle[], spec: SupportApproachSpec, physicalSource: readonly SupportTriangle[] = ground.map(t => t.vertices)): {patch: TramSupportPatch; proof: Record<string, unknown>} {
  assert.ok(spec.length > 0 && spec.upperLength > 0 && spec.length + spec.upperLength <= 12);
  assert.ok(spec.wheelHalfWidth >= .8 && spec.returnWidth >= .15);
  const d = spec.lowerDirection, n: TramPoint = [d[1], -d[0]], half = spec.wheelHalfWidth + spec.returnWidth;
  assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-8);
  const world = (t: number, s: number): TramPoint => [spec.origin[0] + n[0] * t + d[0] * s, spec.origin[1] + n[1] * t + d[1] * s];
  const local = (p: TramPoint): TramPoint => {const q = [p[0] - spec.origin[0], p[1] - spec.origin[1]]; return [dot(q, n), dot(q, d)];};
  const floors = physicalSource.filter(t => {
    const a = t.map(v => local([v[0], v[2]]));
    return Math.min(...a.map(v => v[0])) <= half && Math.max(...a.map(v => v[0])) >= -half && Math.min(...a.map(v => v[1])) <= spec.length + .2 && Math.max(...a.map(v => v[1])) >= -spec.upperLength - .2;
  }).filter(t => {try {weights(t, t[0]); return true;} catch {return false;}});
  const at = (p: TramPoint) => {let h = -Infinity; for (const t of floors) {const w = weights(t, [p[0], 0, p[1]]); if (w.every(v => v >= -1e-7)) h = Math.max(h, supportHeight(t, p));} return h;};
  const resolve = (p: TramPoint) => {let h = at(p); if (!Number.isFinite(h)) for (const r of [.0002, .002, .02]) {for (const [x, z] of [[-r, 0], [r, 0], [0, -r], [0, r]]) h = Math.max(h, at([p[0] + x!, p[1] + z!])); if (Number.isFinite(h)) break;} assert.ok(Number.isFinite(h), `No actual road support near ${p}`); return h;};
  // Break the boundary at EVERY source triangle edge. Also split crossings of
  // overlapping source planes, so the old highest envelope is reproduced.
  function lineBreaks(axis: 0 | 1, fixed: number, lo: number, hi: number): number[] {
    let values = [lo, hi];
    for (const t of floors) for (let i = 0; i < 3; i++) {const a = local([t[i]![0], t[i]![2]]), b = local([t[(i + 1) % 3]![0], t[(i + 1) % 3]![2]]); if (a[axis] !== b[axis] && fixed >= Math.min(a[axis], b[axis]) && fixed <= Math.max(a[axis], b[axis])) {const u = (fixed - a[axis]) / (b[axis] - a[axis]), v = a[1 - axis]! + (b[1 - axis]! - a[1 - axis]!) * u; if (v > lo && v < hi) values.push(v);}}
    values = [...new Set(values)].sort((a, b) => a - b);
    const extra: number[] = [];
    for (let i = 0; i < values.length - 1; i++) {
      const a = values[i]!, b = values[i + 1]!, mid = (a + b) / 2, q = axis === 0 ? world(fixed, mid) : world(mid, fixed), candidates = floors.filter(t => weights(t, [q[0], 0, q[1]]).every(w => w >= -1e-7));
      for (let j = 0; j < candidates.length; j++) for (let k = j + 1; k < candidates.length; k++) {const point = (v: number) => axis === 0 ? world(fixed, v) : world(v, fixed), delta = (v: number) => supportHeight(candidates[j]!, point(v)) - supportHeight(candidates[k]!, point(v)), da = delta(a), db = delta(b); if (da * db < 0) extra.push(a + (b - a) * da / (da - db));}
    }
    return [...new Set([...values, ...extra])].sort((a, b) => a - b);
  }
  const merge = (values: number[], tolerance: number) => {const sorted = [...new Set(values)].sort((a, b) => a - b), out = [sorted[0]!]; for (const v of sorted.slice(1)) if (v - out.at(-1)! > tolerance) out.push(v); if (sorted.at(-1)! - out.at(-1)! <= tolerance) out[out.length - 1] = sorted.at(-1)!; return out;};
  const cross = merge([-half, -spec.wheelHalfWidth, spec.wheelHalfWidth, half, ...Array.from({length: 21}, (_, i) => -half + 2 * half * i / 20), ...lineBreaks(1, -spec.upperLength, -half, half), ...lineBreaks(1, spec.length, -half, half)], 1e-10);
  const anchors = cross.map(t => {const values = lineBreaks(0, t, -spec.seamSearch, spec.seamSearch); let y = -Infinity, along = 0; for (const s of values) {const h = at(world(t, s)); if (h > y) {y = h; along = s;}} assert.ok(Number.isFinite(y)); return {across: t, along, y};});
  const upperEnds = cross.map(t => resolve(world(t, -spec.upperLength))), lowerEnds = cross.map(t => resolve(world(t, spec.length)));
  const parameters: number[] = [0, 1, 2];
  for (let i = 0; i <= Math.ceil(spec.upperLength / .1); i++) parameters.push(i / Math.ceil(spec.upperLength / .1));
  for (let i = 0; i <= Math.ceil(spec.length / .1); i++) parameters.push(1 + i / Math.ceil(spec.length / .1));
  for (const [t, anchor] of [[-half, anchors[0]!], [half, anchors.at(-1)!]] as const) for (const s of lineBreaks(0, t, -spec.upperLength, spec.length)) parameters.push(s <= anchor.along ? (s + spec.upperLength) / (anchor.along + spec.upperLength) : 1 + (s - anchor.along) / (spec.length - anchor.along));
  const us = merge(parameters, 1e-12), vertices: SupportVertex[][] = [];
  const welded = new Map<string, {p: SupportVertex; boundary: boolean}[]>(); let maximumFloat32CanonicalHeightAdjustment = 0;
  const vertex = (q: TramPoint, y: number, boundary: boolean): SupportVertex => {
    const p: SupportVertex = [Math.fround(q[0]), Math.fround(y), Math.fround(q[1])], key = `${p[0]},${p[2]}`, peers = welded.get(key) ?? [];
    let prior = peers.find(v => Math.abs(v.p[1] - p[1]) <= .000001);
    if (!prior && (!boundary || !peers.some(v => v.boundary))) prior = peers[0];
    if (prior) {maximumFloat32CanonicalHeightAdjustment = Math.max(maximumFloat32CanonicalHeightAdjustment, Math.abs(prior.p[1] - p[1])); if (boundary && !prior.boundary) {prior.p[1] = p[1]; prior.boundary = true;} return prior.p;}
    peers.push({p, boundary}); welded.set(key, peers); return p;
  };
  let maximumAddedHeight = 0, maximumLowerAddedHeight = 0, maximumUpperAddedHeight = 0;
  for (let i = 0; i < cross.length; i++) {
    const t = cross[i]!, anchor = anchors[i]!, row: SupportVertex[] = [], weight = Math.min(1, Math.max(0, (half - Math.abs(t)) / spec.returnWidth));
    for (const u of us) {const s = u <= 1 ? -spec.upperLength + (anchor.along + spec.upperLength) * u : anchor.along + (spec.length - anchor.along) * (u - 1), q = world(t, s), base = resolve(q), road = u <= 1 ? upperEnds[i]! + (anchor.y - upperEnds[i]!) * u : anchor.y + (lowerEnds[i]! - anchor.y) * (u - 1), y = base + weight * (road - base), lift = y - base; maximumAddedHeight = Math.max(maximumAddedHeight, lift); if (s < 0) maximumUpperAddedHeight = Math.max(maximumUpperAddedHeight, lift); else maximumLowerAddedHeight = Math.max(maximumLowerAddedHeight, lift); row.push(vertex(q, y, i === 0 || i === cross.length - 1 || u === 0 || u === 2));}
    vertices.push(row);
  }
  const triangles: SupportTriangle[] = [], emitted = new Set<string>(); let wallTriangles = 0, maximumPhysicalLongitudinalGrade = 0, maximumCrossfall = 0;
  for (let i = 0; i < cross.length - 1; i++) for (let j = 0; j < us.length - 1; j++) for (let triangle of [[vertices[i]![j]!, vertices[i + 1]![j]!, vertices[i + 1]![j + 1]!], [vertices[i]![j]!, vertices[i + 1]![j + 1]!, vertices[i]![j + 1]!]] as SupportTriangle[]) {
    const area = (triangle[1][0] - triangle[0][0]) * (triangle[2][2] - triangle[0][2]) - (triangle[1][2] - triangle[0][2]) * (triangle[2][0] - triangle[0][0]); if (area > 0) triangle = [triangle[0], triangle[2], triangle[1]];
    let normal: SupportVertex; try {normal = supportNormal(triangle);} catch {continue;} const key = triangle.map(v => v.join(',')).sort().join('|'); if (emitted.has(key)) continue; emitted.add(key); if (normal[1] <= .3) wallTriangles++; if (normal[1] > 0) {maximumPhysicalLongitudinalGrade = Math.max(maximumPhysicalLongitudinalGrade, Math.abs((normal[0] * d[0] + normal[2] * d[1]) / normal[1])); maximumCrossfall = Math.max(maximumCrossfall, Math.abs((normal[0] * n[0] + normal[2] * n[1]) / normal[1]));} triangles.push(triangle);
  }
  const footprint = [world(-half, -spec.upperLength), world(half, -spec.upperLength), world(half, spec.length), world(-half, spec.length)], all = triangles.flat();
  const boundary = [...vertices[0]!, ...vertices.slice(1).map(row => row.at(-1)!), ...vertices.at(-1)!.slice(0, -1).reverse(), ...vertices.slice(1, -1).reverse().map(row => row[0]!)];
  const patch: TramSupportPatch = {id: spec.id, cell: spec.cell, footprint, boundary, boundsXZ: [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[2])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[2]))], triangles, sourceNode: spec.sourceNode, sourcePrimitive: spec.sourcePrimitive, observations: ['Bounded replacement of overlapping ground sheets and wall joins only; every outside source fragment and all architecture remain exact.', 'A single shared-vertex road surface retains the measured source boundary, with full wheel strip and lateral returns.']};
  validateSupportPatch(patch);
  const addedRiseGrade = Math.max(maximumUpperAddedHeight / spec.upperLength, maximumLowerAddedHeight / spec.length);
  return {patch, proof: {spec, anchors, boundaryKnots: {cross: cross.length, along: us.length}, maximumAddedHeight, maximumUpperAddedHeight, maximumLowerAddedHeight, addedRiseGrade, maximumPhysicalLongitudinalGrade, maximumCrossfall, maximumFloat32CanonicalHeightAdjustment, triangles: triangles.length, wallTriangles, gradeBoundPassed: addedRiseGrade <= .0601}};
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function supportNormal(t: SupportTriangle): SupportVertex {
  const [a, b, c] = t, u = b.map((n, i) => n - a[i]!), v = c.map((n, i) => n - a[i]!);
  const n: SupportVertex = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const length = Math.hypot(...n); assert.ok(length > 1e-12, 'Support may not collapse at Float32 precision');
  return n.map(x => x / length) as SupportVertex;
}
export function validateSupportPatch(patch: TramSupportPatch): void {
  assert.match(patch.id, /^[a-z0-9][a-z0-9-]+$/); assert.match(patch.cell, /^c_[mp]\d+_[mp]\d+$/);
  assert.ok(patch.triangles.length > 0 && patch.triangles.length < 200000);
  const [x0, z0, x1, z1] = patch.boundsXZ; assert.ok(x1 > x0 && z1 > z0);
  for (const triangle of patch.triangles) {
    assert.equal(triangle.length, 3);
    for (const vertex of triangle) {
      assert.equal(vertex.length, 3); assert.ok(vertex.every(Number.isFinite));
      assert.ok(vertex.every(v => Object.is(v, Math.fround(v))), 'Serialize the actual Float32 support before validating');
      assert.ok(vertex[0] >= x0 && vertex[0] <= x1 && vertex[2] >= z0 && vertex[2] <= z1, 'Support escaped its surveyed footprint');
    }
    assert.ok(supportNormal(triangle)[1] >= 0, 'Road or retained boundary wall must face upward');
  }
}
function triangles(p: Primitive): SupportTriangle[] {
  const P = p.getAttribute('POSITION')!, I = p.getIndices()!;
  return Array.from({length: I.getCount() / 3}, (_, t) => [0, 1, 2].map(k => P.getElement(I.getScalar(t * 3 + k), [])) as unknown as SupportTriangle);
}
function weights(t: SupportTriangle, v: SupportVertex): number[] {
  const [a, b, c] = t, den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  assert.ok(Math.abs(den) > 1e-10);
  const u = ((b[2] - c[2]) * (v[0] - c[0]) + (c[0] - b[0]) * (v[2] - c[2])) / den;
  const w = ((c[2] - a[2]) * (v[0] - c[0]) + (a[0] - c[0]) * (v[2] - c[2])) / den;
  return [u, w, 1 - u - w];
}
/** Source road UVs are affine in world X/Z. Fit an actual original nonvertical
 * triangle, then preserve its mapping on the added approach, including phase. */
function uvMapping(p: Primitive): (v: SupportVertex) => number[] {
  const U = p.getAttribute('TEXCOORD_0'), I = p.getIndices(); assert.ok(U && I);
  const ts = triangles(p); let at = -1;
  for (let t = 0; t < ts.length; t++) {try {weights(ts[t]!, ts[t]![0]); at = t; break;} catch { /* vertical face */ }}
  assert.ok(at >= 0); const t = ts[at]!, uv = [0, 1, 2].map(k => U.getElement(I.getScalar(at * 3 + k), []));
  return v => {const w = weights(t, v); return [0, 1].map(k => w.reduce((sum, n, i) => sum + n * uv[i]![k]!, 0));};
}
/** Grow selected decoded accessors only. Compressed source BIN, original
 * materials, textures, image definitions and old accessor definitions remain literal prefixes. */
export async function appendSupportVisual(bytes: Uint8Array, doc: Document, patches: readonly TramSupportPatch[], coarse = false): Promise<Uint8Array> {
  const groups = new Map<string, {node: string; primitive: number; patches: TramSupportPatch[]}>();
  for (const patch of patches) {
    validateSupportPatch(patch);
    const node = coarse ? doc.getRoot().listNodes().find(n => n.getMesh()?.listPrimitives().some(p => p.getAttribute('COLOR_0'))) : doc.getRoot().listNodes().find(n => n.getName() === patch.sourceNode);
    assert.ok(node); assert.ok(node.getMesh()); assert.deepEqual(node.getWorldMatrix(), identity);
    const primitive = coarse ? node.getMesh()!.listPrimitives().findIndex(p => !!p.getAttribute('COLOR_0')) : patch.sourcePrimitive;
    const key = `${node.getName()}:${primitive}`, group = groups.get(key) ?? {node: node.getName(), primitive, patches: []}; group.patches.push(patch); groups.set(key, group);
  }
  const additions: GroundGlbAppend[] = [];
  for (const group of groups.values()) {
    const node = doc.getRoot().listNodes().find(n => n.getName() === group.node)!, p = node.getMesh()!.listPrimitives()[group.primitive]!;
    const first = p.getAttribute('POSITION')!.getCount(), attributes: Record<string, {original: GroundAttributeArray; appended: number[]}> = {};
    const uv = coarse ? null : uvMapping(p), points = group.patches.flatMap(patch => patch.triangles), normals = points.map(supportNormal);
    for (const semantic of p.listSemantics()) {
      const a = p.getAttribute(semantic)!, extra: number[] = [];
      const scale = a.getNormalized() ? a.getComponentType() === 5121 ? 255 : a.getComponentType() === 5123 ? 65535 : a.getComponentType() === 5120 ? 127 : a.getComponentType() === 5122 ? 32767 : NaN : 1;
      assert.ok(Number.isFinite(scale));
      for (const [t, triangle] of points.entries()) for (const v of triangle) {
        if (semantic === 'POSITION') extra.push(...v);
        else if (semantic === 'NORMAL') extra.push(...normals[t]!.map(n => scale === 1 ? n : Math.round(n * scale)));
        else if (semantic === 'TEXCOORD_0') extra.push(...uv!(v));
        else if (semantic === 'COLOR_0') {for (const c of [.12, .12, .125]) extra.push(scale === 1 ? c : Math.round(c * scale)); if (a.getElementSize() === 4) extra.push(scale);}
        else throw Error(`Unsupported source support semantic ${semantic}`);
      }
      attributes[semantic] = {original: a.getArray()! as GroundAttributeArray, appended: extra};
    }
    additions.push({nodeName: group.node, primitiveIndex: group.primitive, attributes, indices: {original: p.getIndices()!.getArray()! as GroundAttributeArray, appended: Array.from({length: points.length * 3}, (_, i) => first + i)}});
  }
  const out = await appendGroundGlb(bytes, additions), a = readFacadeGlb(bytes), b = readFacadeGlb(out);
  assert.deepEqual(b.bin.subarray(0, a.bin.length), a.bin);
  for (const key of ['accessors', 'bufferViews', 'materials', 'textures', 'images', 'samplers', 'nodes'] as const) assert.deepEqual((b.json[key] as unknown[] ?? []).slice(0, (a.json[key] as unknown[] ?? []).length), a.json[key] ?? []);
  return out;
}
export function appendSupportCollision(bytes: Uint8Array, patches: readonly TramSupportPatch[]): Uint8Array {
  const old = parseCollisionBundle(bytes), triangles = patches.flatMap(p => {validateSupportPatch(p); return p.triangles;}), points = triangles.flat(1), tag = 'road:asphalt:tram-support', tags = [...old.header.surfaceTags];
  assert.ok(!old.colliders.some(c => c.id.startsWith('tram-support:')), 'Support is already appended');
  let index = tags.indexOf(tag); if (index < 0) {index = tags.length; tags.push(tag);}
  let wall = tags.indexOf('wall:tram-support'); if (wall < 0) {wall = tags.length; tags.push('wall:tram-support');}
  const appended = {id: `tram-support:${old.header.cell}`, group: 'ground' as const, ref: null, positions: Float32Array.from(points.flat()), indices: Uint32Array.from({length: points.length}, (_, i) => i), triangleTags: Uint16Array.from(triangles, t => supportNormal(t)[1] > .3 ? index : wall)};
  const out = encodeCollisionBundle({...old.header, surfaceTags: tags}, [...old.colliders, appended]), next = parseCollisionBundle(out);
  assert.deepEqual(next.colliders.slice(0, old.colliders.length), old.colliders, 'Every old collider must remain byte-exact');
  return out;
}

interface ClipVertex {attributes: Record<string, number[]>}
/** Partition each selected source triangle into disjoint outside fragments.
 * Original vertices stay literal prefixes, and every wholly outside triangle
 * retains its original three indices and attributes. */
export function retainOutsideSupport(mesh: FrontierMesh, patches: readonly TramSupportPatch[], select: (triangle: number) => boolean = () => true) {
  const extras = Object.fromEntries(Object.keys(mesh.attributes).map(k => [k, [] as number[]])), indices: number[] = [], sourceTriangles: number[] = [], removed: number[] = [], clipped: number[] = [];
  const position = (v: ClipVertex) => v.attributes.POSITION!;
  const cut = (ring: ClipVertex[], value: (v: ClipVertex) => number) => {
    const out: ClipVertex[] = [];
    for (let i = 0; i < ring.length; i++) {const a = ring[i]!, b = ring[(i + 1) % ring.length]!, va = value(a), vb = value(b); if (va >= 0) out.push(a); if ((va >= 0) !== (vb >= 0)) {const t = va / (va - vb), attributes: Record<string, number[]> = {}; for (const semantic of Object.keys(a.attributes)) attributes[semantic] = a.attributes[semantic]!.map((v, j) => v + (b.attributes[semantic]![j]! - v) * t); out.push({attributes});}}
    return out;
  };
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const ids = Array.from(mesh.indices.subarray(t * 3, t * 3 + 3));
    if (!select(t)) {indices.push(...ids); sourceTriangles.push(t); continue;}
    const ring = ids.map(id => ({attributes: Object.fromEntries(Object.entries(mesh.attributes).map(([k, a]) => [k, Array.from(a.subarray(id * mesh.components[k]!, (id + 1) * mesh.components[k]!))]))}));
    let fragments = [ring], touched = false;
    for (const patch of patches) {
      assert.ok(patch.footprint?.length === 4, 'Replacement needs the exact oriented footprint');
      const polygon = patch.footprint!, orientation = Math.sign((polygon[1]![0] - polygon[0]![0]) * (polygon[2]![1] - polygon[0]![1]) - (polygon[1]![1] - polygon[0]![1]) * (polygon[2]![0] - polygon[0]![0])), next: ClipVertex[][] = [];
      for (const fragment of fragments) {
        let inside = fragment; const outside: ClipVertex[][] = [];
        for (let j = 0; j < polygon.length && inside.length >= 3; j++) {const a = polygon[j]!, b = polygon[(j + 1) % polygon.length]!, value = (v: ClipVertex) => {const p = position(v); return ((b[0] - a[0]) * (p[2]! - a[1]) - (b[1] - a[1]) * (p[0]! - a[0])) * orientation;}; const part = cut(inside, v => -value(v)); if (part.length >= 3) outside.push(part); inside = cut(inside, value);}
        if (inside.length >= 3) {
          const p = inside.map(position), a = p[0]!; let area = 0;
          for (let i = 1; i < p.length - 1; i++) {const u = p[i]!.map((v, k) => v - a[k]!), v = p[i + 1]!.map((n, k) => n - a[k]!); area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;}
          const aligned = polygon.some((a, j) => {const b = polygon[(j + 1) % polygon.length]!; return p.every(v => Math.abs((b[0] - a[0]) * (v[2]! - a[1]) - (b[1] - a[1]) * (v[0]! - a[0])) < 1e-10);});
          if (area > 1e-10 && !aligned) touched = true;
        }
        next.push(...outside);
      }
      fragments = next;
    }
    if (!touched) {indices.push(...ids); sourceTriangles.push(t); continue;}
    removed.push(t); if (fragments.length) clipped.push(t);
    const densify = (fragment: ClipVertex[]): ClipVertex[] => {
      const out: ClipVertex[] = [];
      for (let i = 0; i < fragment.length; i++) {
        const a = fragment[i]!, b = fragment[(i + 1) % fragment.length]!, A = position(a), B = position(b), dx = B[0]! - A[0]!, dz = B[2]! - A[2]!, length2 = dx * dx + dz * dz;
        out.push(a); if (length2 < 1e-18) continue;
        const candidates: {u: number; vertex: ClipVertex}[] = [];
        for (const patch of patches) {
        const onBoundary = patch.footprint!.some((p, j) => {const r = patch.footprint![(j + 1) % 4]!, distance = (v: readonly number[]) => Math.abs((r[0] - p[0]) * (v[2]! - p[1]) - (r[1] - p[1]) * (v[0]! - p[0])) / Math.hypot(r[0] - p[0], r[1] - p[1]); return distance(A) < 1e-7 && distance(B) < 1e-7;});
        if (!onBoundary) continue;
        for (const q of patch.boundary ?? []) {
          const u = ((q[0] - A[0]!) * dx + (q[2] - A[2]!) * dz) / length2;
          if (u <= 1e-8 || u >= 1 - 1e-8) continue;
          const distance = Math.abs(dx * (q[2] - A[2]!) - dz * (q[0] - A[0]!)) / Math.sqrt(length2); if (distance > .00008) continue;
          const attributes: Record<string, number[]> = {};
          let barycentric: number[] | null = null;
          try {barycentric = weights(ring.map(v => position(v)) as SupportTriangle, q);} catch { /* retained vertical boundary */ }
          if (barycentric && barycentric.some(w => w < -.0001)) continue;
          for (const semantic of Object.keys(a.attributes)) attributes[semantic] = barycentric ? a.attributes[semantic]!.map((_, k) => barycentric!.reduce((sum, w, v) => sum + w * ring[v]!.attributes[semantic]![k]!, 0)) : a.attributes[semantic]!.map((v, k) => v + (b.attributes[semantic]![k]! - v) * u);
          attributes.POSITION![0] = q[0]; attributes.POSITION![2] = q[2];
          if (Math.abs(attributes.POSITION![1]! - q[1]) <= .00001) attributes.POSITION![1] = q[1];
          candidates.push({u, vertex: {attributes}});
        }
        }
        const unique = new Set<string>();
        for (const candidate of candidates.sort((a, b) => a.u - b.u)) {const key = position(candidate.vertex).map(Math.fround).join(','); if (!unique.has(key)) {unique.add(key); out.push(candidate.vertex);}}
      }
      return out;
    };
    for (const raw of fragments) {const fragment = densify(raw); for (let j = 1; j < fragment.length - 1; j++) {
      const triangle = [fragment[0]!, fragment[j]!, fragment[j + 1]!], xyz = triangle.map(v => Float32Array.from(position(v)));
      const a = xyz[0]!, u = xyz[1]!.map((v, i) => v - a[i]!), v = xyz[2]!.map((n, i) => n - a[i]!);
      if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) === 0) continue;
      for (const vertex of triangle) {indices.push(mesh.attributes.POSITION!.length / 3 + extras.POSITION!.length / 3); for (const [semantic, values] of Object.entries(vertex.attributes)) for (const value of values) extras[semantic]!.push(mesh.attributes[semantic] instanceof Float32Array ? value : Math.round(value));} sourceTriangles.push(t);
    }
    }
  }
  const attributes: Record<string, GroundAttributeArray> = {};
  for (const [semantic, original] of Object.entries(mesh.attributes)) {const Type = original.constructor as {new(length: number): GroundAttributeArray}, next = new Type(original.length + extras[semantic]!.length); next.set(original); next.set(extras[semantic]!, original.length); attributes[semantic] = next;}
  return {mesh: {...mesh, attributes, indices: Uint32Array.from(indices)}, sourceTriangles, proof: {removedSourceTriangles: removed, clippedSourceTriangles: clipped, retainedTriangles: indices.length / 3}};
}
const triangleKey = (t: readonly (readonly number[])[]) => t.map(v => v.map(Math.fround).join(',')).sort().join('|');
const primitiveMesh = (p: Primitive): FrontierMesh => ({attributes: Object.fromEntries(p.listSemantics().map(s => [s, p.getAttribute(s)!.getArray()! as GroundAttributeArray])), components: Object.fromEntries(p.listSemantics().map(s => [s, p.getAttribute(s)!.getElementSize()])), normalized: Object.fromEntries(p.listSemantics().map(s => [s, p.getAttribute(s)!.getNormalized()])), indices: Uint32Array.from(p.getIndices()!.getArray()!)});
export async function replaceSupportVisual(bytes: Uint8Array, doc: Document, patches: readonly TramSupportPatch[], sourceGroundKeys: ReadonlySet<string>, coarse: boolean) {
  const replacements: GroundGlbReplacement[] = [], proof: unknown[] = [];
  for (const node of doc.getRoot().listNodes()) if (node.getMesh()) {
    if (!coarse && !node.getName().includes('_ground_') && !/kerb/.test(node.getName())) continue;
    assert.deepEqual(node.getWorldMatrix(), identity);
    for (const [i, p] of node.getMesh()!.listPrimitives().entries()) {
      const ts = triangles(p), select = ts.map(t => !coarse || sourceGroundKeys.has(triangleKey(t))); if (!select.some(Boolean)) continue;
      const clipped = retainOutsideSupport(primitiveMesh(p), patches, t => select[t]!); if (!clipped.proof.removedSourceTriangles.length) continue;
      replacements.push({nodeName: node.getName(), primitiveIndex: i, ...(coarse ? {kind: 'distant-ground' as const} : {}), attributes: clipped.mesh.attributes, indices: clipped.mesh.indices}); proof.push({node: node.getName(), primitive: i, ...clipped.proof});
    }
  }
  return {bytes: await replaceGroundGlb(bytes, replacements), proof};
}
export function replaceSupportCollision(bytes: Uint8Array, patches: readonly TramSupportPatch[], authored: readonly TramSupportPatch[] = patches) {
  const old = parseCollisionBundle(bytes), proof: unknown[] = [];
  const kept = old.colliders.map(c => {if (c.group !== 'ground' && c.group !== 'kerbs') return c; const out = retainOutsideSupport({attributes: {POSITION: c.positions}, components: {POSITION: 3}, normalized: {POSITION: false}, indices: c.indices}, patches); proof.push({collider: c.id, ...out.proof}); return {...c, positions: out.mesh.attributes.POSITION as Float32Array, indices: out.mesh.indices, triangleTags: Uint16Array.from(out.sourceTriangles, t => c.triangleTags[t]!)};});
  const clipped = encodeCollisionBundle(old.header, kept), next = authored.length ? appendSupportCollision(clipped, authored) : clipped;
  for (const c of old.colliders.filter(c => c.group !== 'ground' && c.group !== 'kerbs')) assert.deepEqual(parseCollisionBundle(next).colliders.find(n => n.id === c.id), c);
  return {bytes: next, proof};
}
