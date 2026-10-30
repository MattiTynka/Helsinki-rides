import assert from 'node:assert/strict';
import type {GroundPiece} from './ground.ts';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import {measuredFaceKey, type MeasuredGroundFace} from './delivery-measured-ground.ts';

type Ground = {pieces: readonly GroundPiece[]; kerbs: readonly GroundPiece[]};
export type AuthoredGradeChangedFace = MeasuredGroundFace & {originalPiece: number; triangle: number; key: string};
const zero = (P: Vec3[]) => {const u = P[1]!.map((v,i) => v-P[0]![i]!), v = P[2]!.map((v,i) => v-P[0]![i]!); return u[1]!*v[2]!-u[2]!*v[1]! === 0 && u[2]!*v[0]!-u[0]!*v[2]! === 0 && u[0]!*v[1]!-u[1]!*v[0]! === 0;};

/** Recompute a height-only native delta and prove its complete coincidence
 * closure, including outside pieces omitted from the candidate subset. */
export function replayAuthoredRoadGradeDelta(original: Ground, candidate: Ground, mapping: {pieces: number[]; kerbs: number[]}) {
  const changes: AuthoredGradeChangedFace[] = [], discardedExactDegenerate: unknown[] = [];
  const byPiece = {pieces: new Map<number, GroundPiece>(), kerbs: new Map<number, GroundPiece>()};
  const deltas = new Map<string, number>();
  for (const kind of ['pieces','kerbs'] as const) {
    assert.equal(mapping[kind].length, candidate[kind].length); assert.equal(new Set(mapping[kind]).size, mapping[kind].length);
    for (const [i,index] of mapping[kind].entries()) {
      assert.ok(Number.isSafeInteger(index) && index >= 0); const a = original[kind][index], b = candidate[kind][i]; assert.ok(a && b);
      const {positions: ap,...restA} = a, {positions: bp,...restB} = b; assert.deepEqual(restB, restA, 'Grade authoring changed native indices, UVs, finish or metadata'); assert.equal(bp.length, ap.length);
      for (let j = 0; j < ap.length; j += 3) {
        assert.ok([bp[j],bp[j+1],bp[j+2]].every(v => typeof v === 'number' && Number.isFinite(v))); assert.equal(bp[j],ap[j]); assert.equal(bp[j+2],ap[j+2]);
        const delta = bp[j+1]! - ap[j+1]!; if (Math.abs(delta) < 1e-12) continue;
        const key = `${Math.fround(ap[j]!)},${Math.fround(ap[j+2]!)}`, prior = deltas.get(key); if (prior !== undefined) assert.ok(Math.abs(prior-delta) <= 1e-10, 'Coincident ground and curb offsets differ'); else deltas.set(key,delta);
      }
      byPiece[kind].set(index,b);
      for (let t = 0; t < a.indices.length; t += 3) {
        const points = (p: GroundPiece) => p.indices.slice(t,t+3).map(i => p.positions.slice(i*3,i*3+3).map(Math.fround) as Vec3), before = points(a), after = points(b);
        if (measuredFaceKey(before) === measuredFaceKey(after)) continue;
        if (zero(before)) {assert.ok(zero(after), 'Grade authoring resurrects discarded degenerate geometry'); discardedExactDegenerate.push({kind,originalPiece:index,triangle:t/3,before,after}); continue;}
        changes.push({cell:a.cell,kind,originalPiece:index,triangle:t/3,tag:a.tag,finish:a.finish,use:a.use??'both',before,after,key:measuredFaceKey(before)});
      }
    }
  }
  assert.ok(changes.length > 0 && changes.length <= 5000);
  const groups = new Map<string, {references: number; minimumY: number; maximumY: number}>();
  for (const kind of ['pieces','kerbs'] as const) for (const [index,p] of original[kind].entries()) for (let j = 0; j < p.positions.length; j += 3) {
    const key = `${Math.fround(p.positions[j]!)},${Math.fround(p.positions[j+2]!)}`, expected = deltas.get(key); if (expected === undefined) continue;
    const actual = byPiece[kind].get(index), delta = (actual?.positions[j+1] ?? p.positions[j+1]!) - p.positions[j+1]!;
    assert.ok(Math.abs(delta-expected) <= 1e-10, 'Grade authoring omitted a coincident native floor or curb reference');
    const group = groups.get(key) ?? {references:0,minimumY:Infinity,maximumY:-Infinity}; group.references++; group.minimumY=Math.min(group.minimumY,p.positions[j+1]!); group.maximumY=Math.max(group.maximumY,p.positions[j+1]!); groups.set(key,group);
  }
  for (const g of groups.values()) assert.ok(g.maximumY-g.minimumY <= .4, 'Grade authoring moves a separated physical level');
  return {changes,discardedExactDegenerate,coincidentGroups:[...groups].map(([pointXZ,g]) => ({pointXZ:pointXZ.split(',').map(Number),delta:deltas.get(pointXZ)!,...g})),nativeIndicesUVsFinishesAndCoincidentOffsetsPreserved:true as const};
}
