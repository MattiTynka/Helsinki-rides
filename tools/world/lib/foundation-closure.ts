// Extend a reviewed, frozen skirt edge to the actual authored ground. This is a
// vertical foundation strip; it never changes the facade or fills a land area.
import assert from 'node:assert/strict';
import type {Document, Material} from '@gltf-transform/core';

export interface FoundationRepair {
  readonly building: string;
  readonly vtj: string | null;
  readonly cell: string;
  readonly materialName: string;
  readonly edgeRuntime: readonly [readonly [number, number, number], readonly [number, number, number]];
  readonly uv: readonly [readonly [number, number], readonly [number, number]];
  readonly exterior: readonly [number, number];
  readonly reason: string;
}

export function buildFoundationClosure(repair: FoundationRepair,
  supportAt: (x: number, z: number) => number | null, buryMetres = 0.3) {
  const [a, b] = repair.edgeRuntime, [ua, ub] = repair.uv, [nx, nz] = repair.exterior;
  assert.ok([a, b].every(p => p.length === 3 && p.every(Number.isFinite)));
  assert.ok([ua, ub].every(p => p.length === 2 && p.every(Number.isFinite)));
  assert.ok(Number.isFinite(nx) && Number.isFinite(nz) && Math.abs(Math.hypot(nx, nz) - 1) < 1e-5);
  assert.ok(Number.isFinite(buryMetres) && buryMetres > 0 && buryMetres <= 0.5);
  const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
  assert.ok(length > 1e-4 && length <= 300, 'Foundation interval must be a bounded actual wall edge');
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const count = Math.ceil(length / 0.5), point = (t: number) => a.map((v, i) => v + (b[i]! - v) * t);
  let maxExposedGap = 0, maxExtension = 0, closedSegments = 0;
  for (let segment = 0; segment < count; segment++) {
    const start = segment / count, end = (segment + 1) / count;
    const supports = Array.from({length:5}, (_, i) => {
      const p = point(start + (end - start) * i / 4);
      const values = [0.01, 0.05].map(offset => supportAt(p[0]! + nx * offset, p[2]! + nz * offset));
      assert.ok(values.every(v => v !== null && Number.isFinite(v)), `${repair.building}: foundation lacks dry ground support`);
      return Math.min(...values as number[]);
    });
    const p = point(start), q = point(end), lowerGround = Math.min(...supports);
    const gap = Math.max(p[1]!, q[1]!) - lowerGround;
    if (gap <= 0.01) continue;
    const bottom = Math.min(p[1]!, q[1]!, lowerGround - buryMetres);
    assert.ok(Math.max(p[1]!, q[1]!) - bottom <= 8, `${repair.building}: unreviewed foundation extension over 8m`);
    const uv = (t: number) => ua.map((v, i) => v + (ub[i]! - v) * t), u = uv(start), v = uv(end);
    const corners = [[p[0]!, p[1]!, p[2]!], [q[0]!, q[1]!, q[2]!], [q[0]!, bottom, q[2]!], [p[0]!, bottom, p[2]!]];
    const cornerUvs = [u, v, v, u];
    // Separate both sides so flatNormals does not cancel opposite windings.
    for (const order of [[0, 1, 2, 0, 2, 3], [0, 2, 1, 0, 3, 2]]) for (const id of order) {
      indices.push(positions.length / 3); positions.push(...corners[id]!); uvs.push(...cornerUvs[id]!);
    }
    maxExposedGap = Math.max(maxExposedGap, gap); maxExtension = Math.max(maxExtension, Math.max(p[1]!, q[1]!) - bottom); closedSegments++;
  }
  return {positions, uvs, indices, audit:{building:repair.building, vtj:repair.vtj, cell:repair.cell,
    lengthMetres:length, segments:count, closedSegments, maxExposedGap, maxExtension, buryMetres,
    method:'Exact reviewed frozen skirt edge; matching existing palette material/UV; vertical-only strip to final authored exterior ground'}};
}

// The proposal binds the frozen cell index; additionally prove that the complete
// selected interval lies on an actual encoded skirt edge with its matching UVs.
export function foundationMaterial(doc: Document, repair: FoundationRepair): Material {
  let material: Material | null = null;
  for (const node of doc.getRoot().listNodes()) for (const p of node.getMesh()?.listPrimitives() ?? []) {
    const m = p.getMaterial(), P = p.getAttribute('POSITION'), U = p.getAttribute('TEXCOORD_0'), I = p.getIndices();
    if (m?.getName() !== repair.materialName || !P || !U || !I || node.getName().includes('_ground_')) continue;
    const M = node.getWorldMatrix();
    const world = (id: number) => { const v = P.getElement(id, []); return [
      M[0]! * v[0]! + M[4]! * v[1]! + M[8]! * v[2]! + M[12]!,
      M[1]! * v[0]! + M[5]! * v[1]! + M[9]! * v[2]! + M[13]!,
      M[2]! * v[0]! + M[6]! * v[1]! + M[10]! * v[2]! + M[14]!]; };
    for (let i = 0; i < I.getCount(); i += 3) for (let k = 0; k < 3; k++) {
      const ia = I.getScalar(i + k), ib = I.getScalar(i + (k + 1) % 3), a = world(ia), b = world(ib), d = b.map((v,j) => v - a[j]!);
      const length2 = d.reduce((sum,v) => sum + v*v,0); if (length2 < 1e-10) continue;
      const ua = U.getElement(ia, []), ub = U.getElement(ib, []);
      if (repair.edgeRuntime.every((point,j) => {
        const t = point.reduce((sum,v,n) => sum + (v-a[n]!) * d[n]!,0) / length2;
        return t >= -1e-5 && t <= 1 + 1e-5 && Math.hypot(...point.map((v,n) => v - a[n]! - d[n]! * t)) <= .002 &&
          repair.uv[j]!.every((v,n) => Math.abs(v - ua[n]! - (ub[n]! - ua[n]!) * t) < 1e-4);
      })) material = m;
    }
  }
  assert.ok(material, `${repair.building}: selected skirt/material/UV interval not present in frozen geometry`);
  return material;
}
