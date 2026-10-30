import assert from 'node:assert/strict';
import type {GroundPiece} from './ground.ts';

export interface MeasuredGroundWitness {
  height: number;
  anchor: 'road' | 'raised';
  sourceTriangleIds: number[];
  sourcePartIds: string[];
}
export interface MeasuredGroundCorrectionOptions {
  patchRegion: readonly [number, number, number, number];
  correctionRegion: readonly [number, number, number, number];
  maximumCorrectionMetres: number;
  /** Explicit authored transition to unchanged native ground. Continuous source-plane
   * deviation must still be qualified separately after this interpolation. */
  boundaryBlendMetres?: number;
  /** Independently calibrated agreement of the two measured sources, not a runtime
   * support tolerance. Existing heights inside this interval are retained exactly. */
  sourceAgreementMetres?: number;
  /** Must resolve an explicit source domain and an unambiguous measured physical floor.
   * Null means the coordinate is outside that reviewed source domain, never missing floor.
   */
  sourceAt: (x: number, z: number) => MeasuredGroundWitness | null;
}
const within = (x: number, z: number, b: readonly number[]) => x >= b[0]! && x <= b[2]! && z >= b[1]! && z <= b[3]!;

/** Preserve native triangulation and finish separation. All vertices that serialize to the
 * same XZ receive one delta, including the already existing kerb and below-floor underlay.
 * This creates no floor and cannot repair a second physical level or protected old city.
 */
export function correctMeasuredGroundVertices(input: {pieces: readonly GroundPiece[]; kerbs: readonly GroundPiece[]}, options: MeasuredGroundCorrectionOptions) {
  const {patchRegion, correctionRegion} = options;
  assert.ok([...patchRegion, ...correctionRegion].every(Number.isFinite));
  assert.ok(correctionRegion[0] > patchRegion[0] && correctionRegion[1] > patchRegion[1] && correctionRegion[2] < patchRegion[2] && correctionRegion[3] < patchRegion[3], 'Correction must have a preserved patch border');
  assert.ok(options.maximumCorrectionMetres > 0 && options.maximumCorrectionMetres <= 2);
  const blend = options.boundaryBlendMetres ?? 0;
  const agreement = options.sourceAgreementMetres ?? 0;
  assert.ok(Number.isFinite(agreement) && agreement >= 0 && agreement <= .1);
  assert.ok(Number.isFinite(blend) && blend >= 0 && blend <= Math.min(correctionRegion[2] - correctionRegion[0], correctionRegion[3] - correctionRegion[1]) / 2);
  const result = {pieces: structuredClone(input.pieces) as GroundPiece[], kerbs: structuredClone(input.kerbs) as GroundPiece[]};
  type Ref = {kind: 'pieces' | 'kerbs'; piece: number; vertex: number; y: number; tag: string; use?: string};
  const groups = new Map<string, {x: number; z: number; refs: Ref[]}>();
  for (const kind of ['pieces', 'kerbs'] as const) for (const [i, p] of input[kind].entries()) {
    assert.equal(p.positions.length % 3, 0);
    for (let j = 0; j < p.positions.length; j += 3) {
      const x = Math.fround(p.positions[j]!), z = Math.fround(p.positions[j + 2]!);
      if (!within(x, z, correctionRegion)) continue;
      const key = `${x},${z}`, group = groups.get(key) ?? {x, z, refs: []};
      group.refs.push({kind, piece: i, vertex: j / 3, y: p.positions[j + 1]!, tag: p.tag, ...(p.use ? {use: p.use} : {})}); groups.set(key, group);
    }
  }
  const witnesses: {pointXZ: [number, number]; delta: number; blendWeight: number; anchorHeightBefore: number; source: MeasuredGroundWitness; refs: Ref[]}[] = [];
  const changed = new Set<string>();
  for (const group of groups.values()) {
    const source = options.sourceAt(group.x, group.z); if (!source) continue;
    assert.ok(Number.isFinite(source.height) && source.sourceTriangleIds.length > 0 && source.sourcePartIds.length > 0, 'Measured height needs explicit source witnesses');
    const candidates = group.refs.filter(r => r.kind === 'pieces' && r.tag.startsWith(`${source.anchor}:`) && !r.tag.endsWith(':yard'));
    assert.ok(candidates.length > 0, `No native ${source.anchor} floor at ${group.x},${group.z}`);
    const heights = candidates.map(r => r.y);
    assert.ok(Math.max(...heights) - Math.min(...heights) < .001, 'Native anchor has distinct physical levels');
    const all = group.refs.map(r => r.y);
    assert.ok(Math.max(...all) - Math.min(...all) <= .4, 'Ground correction cannot move another physical level');
    const anchor = heights.reduce((a, b) => a + b) / heights.length, measuredDelta = source.height - anchor;
    assert.ok(Math.abs(measuredDelta) <= options.maximumCorrectionMetres, 'Measured correction exceeds explicit bound');
    const t = blend ? Math.min(1, Math.min(group.x - correctionRegion[0], group.z - correctionRegion[1], correctionRegion[2] - group.x, correctionRegion[3] - group.z) / blend) : 1;
    const blendWeight = t * t * (3 - 2 * t);
    const boundedDelta = Math.sign(measuredDelta) * Math.max(0, Math.abs(measuredDelta) - agreement), delta = boundedDelta * blendWeight;
    if (Math.abs(delta) < 1e-8) continue;
    for (const ref of group.refs) {result[ref.kind][ref.piece]!.positions[ref.vertex * 3 + 1] = ref.y + delta; changed.add(`${ref.kind}:${ref.piece}:${ref.vertex}`);}
    witnesses.push({pointXZ: [group.x, group.z], delta, blendWeight, anchorHeightBefore: anchor, source, refs: group.refs});
  }
  assert.ok(witnesses.length, 'Measured correction changed no ground');
  // A changed native triangle must be wholly inside the serialization patch. This proves
  // the old exterior and the new interior have exactly the same piecewise boundary height.
  let affectedTriangles = 0;
  for (const kind of ['pieces', 'kerbs'] as const) for (const [i, p] of input[kind].entries()) for (let j = 0; j < p.indices.length; j += 3) {
    const ids = p.indices.slice(j, j + 3); if (!ids.some(id => changed.has(`${kind}:${i}:${id}`))) continue;
    affectedTriangles++;
    assert.ok(ids.every(id => within(p.positions[id * 3]!, p.positions[id * 3 + 2]!, patchRegion)), 'Changed triangle crosses preserved patch boundary');
  }
  return {...result, witnesses, affectedTriangles, boundaryPiecewiseGeometryPreserved: true as const};
}
