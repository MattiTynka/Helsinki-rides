import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeCollisionBundle, parseCollisionBundle, type CollisionBundle } from '../../../packages/world-schema/src/index.ts';
import { pointInPolygon, PolygonGrid, type LocalPolygon } from './geometry.ts';

export interface RegistrationTree {
  id: string;
  model: string;
  position: [number, number, number];
  yaw: number;
  scale: [number, number, number];
  trunkRadius: number;
  colliderHeight: number;
  [key: string]: unknown;
}
export interface RegistrationScenery {
  id: string;
  asset: string;
  node: string;
  position: [number, number, number];
  yaw: number;
  scale: [number, number, number];
  [key: string]: unknown;
}
export interface GroundRegistrationSupport { height: number; group: string; tag: string; collider: string; cell: string }
export interface TreeRegistrationCorrection {
  policy: 'preserve-offset' | 'intended-soil-sink' | 'continuous-soil-sink' | 'shore-bank-sink';
  id: string;
  beforeY: number;
  afterY: number;
  delta: number;
  baselineOffset: number | null;
  baselineSamples: readonly (GroundRegistrationSupport | null)[];
  finalSamples: readonly (GroundRegistrationSupport | null)[];
  finalSupportRange: [number, number];
  maximumRimOffsetChange: number | null;
  anchorHeight: number;
  applied: boolean;
}
export const registrationSha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function assertRegistrationHash(bytes: Uint8Array | string, expected: string, label: string) {
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(registrationSha256(bytes), expected, `Stale tree registration source: ${label}`);
}

/** Centre plus the exact octagonal trunk's eight vertices, without widening or relocating it. */
export function treeRegistrationPoints(tree: RegistrationTree): [number, number][] {
  const [x, , z] = tree.position;
  assert.ok(Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(tree.trunkRadius) && tree.trunkRadius > 0);
  return [[x, z], ...Array.from({ length: 8 }, (_, k): [number, number] => [x + tree.trunkRadius * Math.cos(k * Math.PI / 4), z + tree.trunkRadius * Math.sin(k * Math.PI / 4)])];
}

/** Actual HCOL ground/kerb triangles only. Tree caps and building roofs never support their own scenery. */
export function sampleTreeRegistrationGround(bundles: readonly CollisionBundle[], points: readonly (readonly [number, number])[]): (GroundRegistrationSupport | null)[] {
  const best: (GroundRegistrationSupport | null)[] = points.map(() => null);
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minZ = Math.min(...points.map(p => p[1])), maxZ = Math.max(...points.map(p => p[1]));
  for (const bundle of bundles) for (const collider of bundle.colliders) {
    if (collider.group !== 'ground' && collider.group !== 'kerbs') continue;
    for (let i = 0; i < collider.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map(k => collider.positions.subarray(collider.indices[i + k]! * 3, collider.indices[i + k]! * 3 + 3)) as [Float32Array, Float32Array, Float32Array];
      if (Math.max(a[0]!, b[0]!, c[0]!) < minX || Math.min(a[0]!, b[0]!, c[0]!) > maxX || Math.max(a[2]!, b[2]!, c[2]!) < minZ || Math.min(a[2]!, b[2]!, c[2]!) > maxZ) continue;
      const den = (b[2]! - c[2]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[2]! - c[2]!);
      if (Math.abs(den) < 1e-12) continue;
      for (let k = 0; k < points.length; k++) {
        const [x, z] = points[k]!, u = ((b[2]! - c[2]!) * (x - c[0]!) + (c[0]! - b[0]!) * (z - c[2]!)) / den;
        const v = ((c[2]! - a[2]!) * (x - c[0]!) + (a[0]! - c[0]!) * (z - c[2]!)) / den;
        if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) continue;
        const height = u * a[1]! + v * b[1]! + (1 - u - v) * c[1]!;
        if (!best[k] || height > best[k]!.height) best[k] = { height, group: collider.group, tag: bundle.header.surfaceTags[collider.triangleTags[i / 3]!]!, collider: collider.id, cell: bundle.header.cell };
      }
    }
  }
  return best;
}

/** Preserve the existing registration offset, rather than imposing a new tree height or ground level.
 * The centre is the original placement anchor. All nine support points are recorded; a nonuniform
 * slope change cannot be hidden by moving the trunk to an unrelated nearby surface. */
export function planTreeRegistration(tree: RegistrationTree, baseline: readonly (GroundRegistrationSupport | null)[], final: readonly (GroundRegistrationSupport | null)[], threshold: number): TreeRegistrationCorrection {
  assert.equal(baseline.length, 9); assert.equal(final.length, 9);
  assert.ok(baseline.every(p => p && Number.isFinite(p.height)) && final.every(p => p && Number.isFinite(p.height)), `${tree.id}: incomplete trunk-footprint support`);
  const baselineSamples = baseline as GroundRegistrationSupport[], finalSamples = final as GroundRegistrationSupport[];
  const baselineOffset = tree.position[1] - baselineSamples[0]!.height;
  assert.ok(baselineOffset >= -.45 && baselineOffset <= -.15, `${tree.id}: baseline burial is not physically reasonable for offset preservation`);
  const delta = finalSamples[0]!.height - baselineSamples[0]!.height, applied = Math.abs(delta) > threshold;
  return { policy: 'preserve-offset', id: tree.id, beforeY: tree.position[1], afterY: tree.position[1] + (applied ? delta : 0), delta: applied ? delta : 0,
    baselineOffset, baselineSamples, finalSamples, anchorHeight: finalSamples[0]!.height,
    finalSupportRange: [Math.min(...finalSamples.map(p => p.height)), Math.max(...finalSamples.map(p => p.height))],
    maximumRimOffsetChange: Math.max(...finalSamples.slice(1).map((p, k) => Math.abs(delta - (p.height - baselineSamples[k + 1]!.height)))), applied };
}

export interface TreeSoilContext { retainingWallIds: string[]; buildingIds: string[]; waterPointIndices: number[] }
export function createTreeSoilInspector(parts: readonly LocalPolygon[], footprints: readonly LocalPolygon[], water: readonly LocalPolygon[], decks: readonly LocalPolygon[]) {
  const wallGrid = new PolygonGrid(parts.filter(p => p.properties['paatyyppi'] === 'Varusteet' && p.properties['alatyyppi'] === 'Tukimuuri'), 16);
  const buildingGrid = new PolygonGrid(footprints, 16), waterGrid = new PolygonGrid(water, 16), deckGrid = new PolygonGrid(decks, 16);
  const inspectPoints = (points: readonly (readonly [number, number])[]): TreeSoilContext => {
    const walls = new Set<string>(), buildings = new Set<string>(), wet: number[] = [];
    points.forEach(([x, z], i) => {
      for (const p of wallGrid.containing(x, -z)) walls.add(p.id);
      for (const p of buildingGrid.containing(x, -z)) buildings.add(p.id);
      if (waterGrid.containing(x, -z).length && !deckGrid.candidates(x, -z).some(p => pointInPolygon([x, -z], p.rings))) wet.push(i);
    });
    return { retainingWallIds: [...walls].sort(), buildingIds: [...buildings].sort(), waterPointIndices: wet };
  };
  return Object.assign((tree: RegistrationTree) => inspectPoints(treeRegistrationPoints(tree)), { points: inspectPoints });
}

export function qualifyTreeSoil(samples: readonly (GroundRegistrationSupport | null)[], context: TreeSoilContext, maximumRange = .6) {
  assert.equal(samples.length, 9);
  const heights = samples.filter((p): p is GroundRegistrationSupport => !!p && Number.isFinite(p.height)).map(p => p.height);
  const range: [number, number] | null = heights.length ? [Math.min(...heights), Math.max(...heights)] : null;
  const reasons = [heights.length < 9 ? 'incomplete-support' : null, range && range[1] - range[0] > maximumRange ? 'range-over-limit' : null,
    context.retainingWallIds.length ? 'source-retaining-wall' : null, context.buildingIds.length ? 'source-building' : null, context.waterPointIndices.length ? 'source-water' : null].filter((p): p is string => p !== null);
  return { qualified: reasons.length === 0, reasons, range, context };
}

/** Same0.3m root-burial intent as build_trees, measured against final actual soil.
 * The lowest qualified rim/centre sample keeps the lower root rim planted. */
export function planTreeSoilSink(tree: RegistrationTree, baseline: readonly (GroundRegistrationSupport | null)[], final: readonly (GroundRegistrationSupport | null)[], threshold: number, context: TreeSoilContext): TreeRegistrationCorrection {
  const qualification = qualifyTreeSoil(final, context); assert.ok(qualification.qualified, `${tree.id}: unresolved soil: ${qualification.reasons.join(',')}`);
  const finalSamples = final as GroundRegistrationSupport[], anchorHeight = qualification.range![0], target = anchorHeight - .3;
  const delta = target - tree.position[1], applied = Math.abs(delta) > threshold;
  const rimChanges = finalSamples.slice(1).flatMap((p, k) => baseline[k + 1] ? [Math.abs(delta - (p.height - baseline[k + 1]!.height))] : []);
  return { policy: 'intended-soil-sink', id: tree.id, beforeY: tree.position[1], afterY: applied ? target : tree.position[1], delta: applied ? delta : 0,
    baselineOffset: baseline[0] ? tree.position[1] - baseline[0].height : null, baselineSamples: baseline, finalSamples, finalSupportRange: qualification.range!, anchorHeight,
    maximumRimOffsetChange: rimChanges.length ? Math.max(...rimChanges) : null, applied };
}

/** Source ids and accepted placement/policy are immutable; only selected Y values may change. */
export function applyTreeRegistrations(trees: readonly RegistrationTree[], scenery: readonly RegistrationScenery[], corrections: readonly TreeRegistrationCorrection[], accepted: ReadonlySet<string>, asset: string) {
  const changes = new Map(corrections.filter(c => c.applied).map(c => [c.id, c]));
  assert.equal(new Set(corrections.map(c => c.id)).size, corrections.length, 'Duplicate tree authority');
  for (const c of corrections) assert.ok(!accepted.has(c.id), `Accepted tree cannot be reseated: ${c.id}`);
  assert.equal(new Set(trees.map(t => t.id)).size, trees.length); assert.equal(new Set(scenery.map(t => t.id)).size, scenery.length);
  const source = new Map(trees.map(t => [t.id, t]));
  for (const c of corrections) { const t = source.get(c.id); assert.ok(t, `Missing source tree: ${c.id}`); assert.equal(t.position[1], c.beforeY, `Stale source tree Y: ${c.id}`); }
  const sceneById = new Map(scenery.filter(s => s.asset === asset).map(s => [s.id, s]));
  assert.equal(sceneById.size, trees.length, 'Tree/scenery source ID set changed');
  for (const tree of trees) {
    const s = sceneById.get(tree.id); assert.ok(s, `Missing scenery tree: ${tree.id}`);
    assert.equal(s.node, tree.model); assert.equal(s.yaw, tree.yaw); assert.deepEqual(s.scale, tree.scale); assert.deepEqual(s.position, tree.position);
  }
  return {
    trees: trees.map(t => { const c = changes.get(t.id); return c ? { ...t, position: [t.position[0], c.afterY, t.position[2]] as [number, number, number] } : t; }),
    scenery: scenery.map(t => { const c = t.asset === asset ? changes.get(t.id) : undefined; return c ? { ...t, position: [t.position[0], c.afterY, t.position[2]] as [number, number, number] } : t; }),
  };
}

/** Patch only Float32 Y words in an existing tree collider's position slice.
 * Header, layout, tags, ground, other colliders, padding and every other byte remain exact. */
export function translateRegisteredTreeColliders(original: Uint8Array, trees: readonly RegistrationTree[], corrections: readonly TreeRegistrationCorrection[]) {
  const output = new Uint8Array(original), bundle = parseCollisionBundle(output), allowed = new Set<number>(), changed: string[] = [];
  const source = new Map(trees.map(t => [t.id, t]));
  for (const correction of corrections.filter(c => c.applied)) {
    const tree = source.get(correction.id); assert.ok(tree); const colliders = bundle.colliders.filter(c => c.ref === tree.id || c.id === `t:${tree.id}`);
    assert.equal(colliders.length, tree.colliderHeight > 0 ? 1 : 0, `${tree.id}: trunk collider policy mismatch`);
    if (!colliders.length) continue;
    const c = colliders[0]!; assert.equal(c.group, 'trees'); assert.equal(c.id, `t:${tree.id}`); assert.equal(c.ref, tree.id);
    const heights = Array.from(c.positions).filter((_, i) => i % 3 === 1);
    assert.ok(Math.abs(Math.min(...heights) - tree.position[1]) < 1e-4 && Math.abs(Math.max(...heights) - tree.position[1] - tree.colliderHeight) < 1e-4, `${tree.id}: collider is not bound to source placement`);
    for (let i = 1; i < c.positions.length; i += 3) {
      const offset = c.positions.byteOffset - output.byteOffset + i * 4;
      for (let k = 0; k < 4; k++) allowed.add(offset + k);
      c.positions[i] = Math.fround(c.positions[i]! + correction.delta);
    }
    changed.push(c.id);
  }
  for (let i = 0; i < output.length; i++) if (output[i] !== original[i]) assert.ok(allowed.has(i), 'Non-tree-Y collision byte changed');
  return { bytes: output, changedColliderIds: changed, allowedYBytes: allowed.size };
}

/** Conditional runtime omissions require a header rebuild. Prove exact ordered retained
 * collider values and header fields, rather than claiming whole-file byte identity. */
export function omitRegisteredTreeColliders(original: Uint8Array, trees: readonly RegistrationTree[], omittedIds: ReadonlySet<string>) {
  const before = parseCollisionBundle(original), source = new Map(trees.map(t => [t.id, t])), removed: string[] = [];
  for (const id of omittedIds) {
    const t = source.get(id); assert.ok(t); const matches = before.colliders.filter(c => c.id === `t:${id}` || c.ref === id);
    assert.equal(matches.length, t.colliderHeight > 0 ? 1 : 0, `${id}: omitted trunk policy mismatch`);
    for (const c of matches) { assert.equal(c.group, 'trees'); assert.equal(c.id, `t:${id}`); assert.equal(c.ref, id); removed.push(c.id); }
  }
  if (!removed.length) return { bytes: new Uint8Array(original), removedColliderIds: removed, retained: [], reencoded: false };
  const retained = before.colliders.filter(c => !removed.includes(c.id));
  const bytes = encodeCollisionBundle({ originId: before.header.originId, frame: before.header.frame, cell: before.header.cell, surfaceTags: before.header.surfaceTags }, retained);
  const after = parseCollisionBundle(bytes);
  for (const key of ['version', 'originId', 'frame', 'cell', 'surfaceTags'] as const) assert.deepEqual(after.header[key], before.header[key]);
  const proof = retained.map((old, i) => {
    const next = after.colliders[i]!; assert.deepEqual([next.id, next.group, next.ref], [old.id, old.group, old.ref]);
    const arrays = Object.fromEntries((['positions', 'indices', 'triangleTags'] as const).map(field => { const a = old[field], b = next[field]; const digest = registrationSha256(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); assertRegistrationHash(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), digest, `retained ${old.id}/${field}`); return [field, digest]; }));
    return { id: old.id, group: old.group, ref: old.ref, arrays };
  });
  return { bytes, removedColliderIds: removed, retained: proof, reencoded: true };
}

export function conditionalTreeOmission(collision: readonly (GroundRegistrationSupport | null)[], visual: readonly (GroundRegistrationSupport | null)[]) {
  assert.equal(collision.length, 9); assert.equal(visual.length, 9);
  assert.equal(Boolean(collision[0]), Boolean(visual[0]), 'Rendered soil/collision disagree at an omission centre; fix support instead of hiding the tree');
  return collision[0] === null && visual[0] === null;
}
