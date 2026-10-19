// Painted trees on the textured LoD2 walls (decision 0006). The city's oblique flights photographed the trees that
// stand in front of a facade onto the wall behind them, so the walls carried flat pictures of trees that the game
// now draws as real ones (tools/world/build_trees.ts). A painted tree is found from seeds: foliage-coloured wall
// texels whose line towards an oblique camera (rising between the configured elevations, up to the configured
// sideways spread) passes through a register tree's crown cylinder (plus a margin). From them the whole connected
// patch of foliage colour is taken, within a reach of that region, so a crown is never cut along a straight line;
// then the shaded leaves and gaps it encloses, and the dark rim around it. A candidate is replaced only by one
// coherent same-chart bay copy whose unchanged boundary agrees. Uncertain or extensively occluded architecture
// stays as delivered. There is deliberately no blur, brightest-pixel selection or per-pixel donor fallback.

export interface TreeVolume {
  readonly x: number;
  readonly z: number;
  /** Crown radius in metres. */
  readonly radius: number;
  readonly base: number;
  readonly top: number;
}

export interface VegetationOptions {
  /** Production keeps original photos. Repeat-based erasure is an explicitly experimental calibration route. */
  readonly mode?: 'restore-original' | 'experimental-repeats';
  /** Added to the crown radius, in metres. */
  readonly margin: number;
  /** Elevation range of the oblique cameras, in degrees. */
  readonly elevationDeg: readonly [number, number];
  /** Sideways spread of the camera line per metre travelled away from the wall (tan of the azimuth offset). */
  readonly sideways: number;
  /** A texel reads as foliage where green exceeds red and blue by these amounts (8-bit sRGB), is at least minValue and
   *  its saturation (green - min(red, blue)) / green is at least minSaturation (greenish-grey plaster is not). */
  readonly greenOverRed: number;
  readonly greenOverBlue: number;
  readonly minValue: number;
  readonly minSaturation: number;
  /** How far beyond the region behind the trees a painted crown is followed, in metres of wall. */
  readonly reachMetres: number;
  /** Closing radius that takes in the shaded leaves and gaps of a crown, and the dark rim taken around it, in metres. */
  readonly closeMetres: number;
  /** Enclosed patches up to this size (side of a square, metres) inside a crown are erased with it. */
  readonly holeMetres: number;
  /** Texels darker than this luma (8-bit) next to a crown are its shaded rim. */
  readonly darkLuma: number;
  /** Seam grown around the erased region, in texels. */
  readonly dilate: number;
  /** Window-bay search range for the periodic fill, in metres, and the least row correlation that counts as a period. */
  readonly bayMetres: readonly [number, number];
  readonly minBayCorrelation: number;
  /** Maximum candidate area divided by its source chart area. Larger occlusions retain the original photograph. */
  readonly maxChartEraseFraction?: number;
  /** Maximum width or height of one connected repair, measured on the wall. */
  readonly maxRegionMetres?: number;
  /** Mean RGB error on the unchanged border allowed for a coherent bay copy (8-bit sRGB). */
  readonly maxBoundaryError?: number;
}

export interface VegetationRepairDecision {
  readonly pixels: number;
  readonly reason: string;
  readonly accepted: boolean;
  readonly shift?: number;
  readonly boundaryError?: number;
}
export interface VegetationRepairDiagnostics {
  candidates: number;
  changed: number;
  decisions: VegetationRepairDecision[];
}

/** A wall triangle of one texture page: page UVs (glTF top-left convention, 0..1) and runtime-frame positions. */
export interface PageTriangle { readonly uv: readonly number[]; readonly pos: readonly number[] }

/** Whether a wall point (wx, wz) at heights wyLo..wyHi, with horizontal outward unit normal (nx, nz), can show tree `t`
 *  in an oblique photo. */
function behind(t: TreeVolume, wx: number, wyLo: number, wyHi: number, wz: number, nx: number, nz: number, o: VegetationOptions, tanLo: number, tanHi: number): boolean {
  const dx = t.x - wx, dz = t.z - wz, r = t.radius + o.margin;
  const ahead = dx * nx + dz * nz, side = Math.abs(dx * nz - dz * nx);
  if (ahead < -r) return false;
  if (side > r + o.sideways * Math.max(0, ahead)) return false;
  // The camera line reaches the crown between `ahead - r` and `ahead + r` metres out, rising tanLo..tanHi per metre.
  return wyLo <= t.top + o.margin - tanLo * Math.max(0, ahead - r) && wyHi >= t.base - o.margin - tanHi * (ahead + r);
}

/** Wall triangles (|normal.y| < 0.3) that can show one of the trees, with those trees. */
export function trianglesNearTrees(positions: ArrayLike<number>, uvs: ArrayLike<number>, indices: ArrayLike<number>, trees: readonly TreeVolume[], o: VegetationOptions): { tri: PageTriangle; trees: TreeVolume[] }[] {
  const out: { tri: PageTriangle; trees: TreeVolume[] }[] = [];
  const tanLo = Math.tan(o.elevationDeg[0] * Math.PI / 180), tanHi = Math.tan(o.elevationDeg[1] * Math.PI / 180);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
    const P = (i: number, k: number) => positions[i * 3 + k]!;
    const ux = P(b, 0) - P(a, 0), uy = P(b, 1) - P(a, 1), uz = P(b, 2) - P(a, 2), vx = P(c, 0) - P(a, 0), vy = P(c, 1) - P(a, 1), vz = P(c, 2) - P(a, 2);
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz), hl = Math.hypot(nx, nz);
    if (len === 0 || Math.abs(ny / len) >= 0.3) continue;
    // Test the corners and the centroid; a tree that any of them can show is kept for the per-texel test.
    const pts = [[P(a, 0), P(a, 1), P(a, 2)], [P(b, 0), P(b, 1), P(b, 2)], [P(c, 0), P(c, 1), P(c, 2)]];
    pts.push([0, 1, 2].map(k => (pts[0]![k]! + pts[1]![k]! + pts[2]![k]!) / 3));
    const ymin = Math.min(P(a, 1), P(b, 1), P(c, 1)), ymax = Math.max(P(a, 1), P(b, 1), P(c, 1));
    const near = trees.filter(tr => {
      if (ymin > tr.top + o.margin) return false;
      const slack = Math.hypot(pts[0]![0]! - pts[3]![0]!, pts[0]![2]! - pts[3]![2]!) + Math.hypot(pts[1]![0]! - pts[3]![0]!, pts[1]![2]! - pts[3]![2]!) + Math.hypot(pts[2]![0]! - pts[3]![0]!, pts[2]![2]! - pts[3]![2]!);
      const grown = { ...tr, radius: tr.radius + slack };
      return pts.some(p => behind(grown, p[0]!, ymin, ymax, p[2]!, nx / hl, nz / hl, o, tanLo, tanHi));
    });
    if (!near.length) continue;
    out.push({ tri: { uv: [uvs[a * 2]!, uvs[a * 2 + 1]!, uvs[b * 2]!, uvs[b * 2 + 1]!, uvs[c * 2]!, uvs[c * 2 + 1]!], pos: pts.slice(0, 3).flat() }, trees: near });
  }
  return out;
}

/** Erase painted foliage on one resampled page in place; returns the number of texels changed. */
export function eraseVegetation(rgba: Uint8Array, w: number, h: number, tris: readonly { tri: PageTriangle; trees: readonly TreeVolume[] }[], o: VegetationOptions, diagnostics?: VegetationRepairDiagnostics): number {
  if (o.mode !== 'experimental-repeats') {
    if (o.mode && o.mode !== 'restore-original') throw new Error(`unknown vegetation repair mode ${o.mode}`);
    if (diagnostics) { diagnostics.candidates = 0; diagnostics.changed = 0; diagnostics.decisions = [{ pixels: 0, accepted: false, reason: 'production source restoration; automatic erasure disabled' }]; }
    return 0;
  }
  const tanLo = Math.tan(o.elevationDeg[0] * Math.PI / 180), tanHi = Math.tan(o.elevationDeg[1] * Math.PI / 180);
  // 1. Region behind the trees, with each texel's row axis (0: rows run along x, 1: along y, 2: slanted, 3: no wall
  // triangle here) and texels per metre along it.
  const mask = new Uint8Array(w * h), axis = new Uint8Array(w * h).fill(3), tpm = new Float32Array(w * h);
  for (const { tri, trees } of tris) {
    const [u0, v0, u1, v1, u2, v2] = tri.uv.map((v, i) => v * (i % 2 ? h : w)) as [number, number, number, number, number, number];
    const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(den) < 1e-9) continue;
    const p = tri.pos;
    // World position as an affine function of texel coordinates: P = P2 + A (px - u2) + B (py - v2).
    const du1 = u0 - u2, dv1 = v0 - v2, du2 = u1 - u2, dv2 = v1 - v2, det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-9) continue;
    const A = [0, 1, 2].map(k => ((p[k]! - p[6 + k]!) * dv2 - (p[3 + k]! - p[6 + k]!) * dv1) / det);
    const B = [0, 1, 2].map(k => ((p[3 + k]! - p[6 + k]!) * du1 - (p[k]! - p[6 + k]!) * du2) / det);
    const ax = Math.abs(A[1]!) * 4 < Math.abs(B[1]!) ? 0 : Math.abs(B[1]!) * 4 < Math.abs(A[1]!) ? 1 : 2;
    const along = ax === 0 ? Math.hypot(A[0]!, A[2]!) : ax === 1 ? Math.hypot(B[0]!, B[2]!) : Math.sqrt(Math.hypot(...A) * Math.hypot(...B));
    const ux = p[3]! - p[0]!, uy = p[4]! - p[1]!, uz = p[5]! - p[2]!, vx = p[6]! - p[0]!, vy = p[7]! - p[1]!, vz = p[8]! - p[2]!;
    let nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
    const hl = Math.hypot(nx, nz); nx /= hl; nz /= hl;
    const x0 = Math.max(0, Math.floor(Math.min(u0, u1, u2))), x1 = Math.min(w - 1, Math.ceil(Math.max(u0, u1, u2)));
    const y0 = Math.max(0, Math.floor(Math.min(v0, v1, v2))), y1 = Math.min(h - 1, Math.ceil(Math.max(v0, v1, v2)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) / den, l1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) / den, l2 = 1 - l0 - l1;
      if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
      const wx = l0 * p[0]! + l1 * p[3]! + l2 * p[6]!, wy = l0 * p[1]! + l1 * p[4]! + l2 * p[7]!, wz = l0 * p[2]! + l1 * p[5]! + l2 * p[8]!;
      const i = y * w + x;
      axis[i] = ax; tpm[i] = along > 0 ? 1 / along : 0;
      if (!mask[i] && trees.some(tr => behind(tr, wx, wy, wy, wz, nx, nz, o, tanLo, tanHi))) mask[i] = 1;
    }
  }
  const scales: number[] = [];
  for (let i = 0; i < w * h; i++) if (mask[i] && tpm[i]) scales.push(tpm[i]!);
  if (!scales.length) return 0;
  scales.sort((a, b) => a - b);
  const perMetre = scales[scales.length >> 1]!;
  const lumaAt = (i: number) => 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
  const padding = (i: number) => Math.max(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!) < 6;
  const foliage = (i: number) => {
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!;
    return g >= r + o.greenOverRed && g >= b + o.greenOverBlue && g >= o.minValue && g - Math.min(r, b) >= o.minSaturation * g;
  };

  // 2. The painted crowns. `near`: within reachMetres of the region behind the trees (chamfer distance, texels).
  const dist = new Float32Array(w * h).fill(Infinity);
  for (let i = 0; i < w * h; i++) if (mask[i]) dist[i] = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0) dist[i] = Math.min(dist[i]!, dist[i - 1]! + 1);
    if (y > 0) { dist[i] = Math.min(dist[i]!, dist[i - w]! + 1); if (x > 0) dist[i] = Math.min(dist[i]!, dist[i - w - 1]! + 1.414); if (x + 1 < w) dist[i] = Math.min(dist[i]!, dist[i - w + 1]! + 1.414); }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x + 1 < w) dist[i] = Math.min(dist[i]!, dist[i + 1]! + 1);
    if (y + 1 < h) { dist[i] = Math.min(dist[i]!, dist[i + w]! + 1); if (x + 1 < w) dist[i] = Math.min(dist[i]!, dist[i + w + 1]! + 1.414); if (x > 0) dist[i] = Math.min(dist[i]!, dist[i + w - 1]! + 1.414); }
  }
  const reach = o.reachMetres * perMetre;
  const near = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (dist[i]! <= reach && !padding(i)) near[i] = 1;
  // Whole connected foliage patches (8-neighbour) that have a seed behind a tree.
  let erase = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let i = 0; i < w * h; i++) if (mask[i] && near[i] && foliage(i)) { erase[i] = 1; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!, x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!erase[j] && near[j] && foliage(j)) { erase[j] = 1; queue.push(j); }
    }
  }
  /** One 4-neighbour step inside `near`: grow (value 1) where `allow` holds, or shrink (value 0) where a neighbour
   *  inside `near` is outside the set; the page edge and texels outside `near` never cause a change. */
  const step = (set: Uint8Array, value: 0 | 1, allow: (i: number) => boolean = () => true) => {
    const next = Uint8Array.from(set);
    const at = (j: number) => near[j] ? set[j] : 1 - value;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (set[i] === value || !near[i] || (value === 1 && !allow(i))) continue;
      if ((x > 0 && at(i - 1) === value) || (x + 1 < w && at(i + 1) === value) || (y > 0 && at(i - w) === value) || (y + 1 < h && at(i + w) === value)) next[i] = value;
    }
    return next;
  };
  const close = Math.max(1, Math.round(o.closeMetres * perMetre));
  for (let k = 0; k < close; k++) erase = step(erase, 1);
  for (let k = 0; k < close; k++) erase = step(erase, 0);
  // Enclosed patches (shaded leaves, gaps, the shadow under the crown): 4-neighbour components of the rest of `near`
  // that touch neither the page edge, padding nor the outside of `near`, up to holeMetres square.
  const maxHole = (o.holeMetres * perMetre) ** 2, seen = new Uint8Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (erase[start] || seen[start] || !near[start]) continue;
    const comp: number[] = [start];
    seen[start] = 1;
    let open = false;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q]!, x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) open = true;
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) {
        if (j < 0 || erase[j] || seen[j]) continue;
        if (!near[j]) { open = true; continue; }
        seen[j] = 1; comp.push(j);
      }
    }
    if (!open && comp.length <= maxHole) for (const i of comp) erase[i] = 1;
  }
  // The crown's dark rim: shaded leaves the colour test misses, grown into from the crown.
  for (let k = 0; k < close; k++) erase = step(erase, 1, i => lumaAt(i) < o.darkLuma);
  for (let k = 0; k < o.dilate; k++) erase = step(erase, 1);
  let count = 0;
  for (let i = 0; i < w * h; i++) count += erase[i]!;
  if (!count) return 0;

  return repairFacadeMask(rgba, w, h, erase, axis, tpm, o, diagnostics);
}

/** Apply only complete, aligned copies from an unoccluded repeat of the same facade chart. The mask is a
 * candidate, not permission to invent missing architecture. Rejected regions leave every source byte intact. */
export function repairFacadeMask(rgba: Uint8Array, w: number, h: number, mask: Uint8Array, axis: Uint8Array,
  texelsPerMetre: Float32Array, o: VegetationOptions, diagnostics?: VegetationRepairDiagnostics): number {
  const size = w * h;
  if (rgba.length !== size * 4 || mask.length !== size || axis.length !== size || texelsPerMetre.length !== size) throw new Error('facade repair array dimensions disagree');
  const src = Uint8Array.from(rgba);
  const padding = (i: number) => Math.max(src[i * 4]!, src[i * 4 + 1]!, src[i * 4 + 2]!) < 6 || src[i * 4 + 3] === 0;
  const foliage = (i: number) => src[i * 4 + 1]! >= src[i * 4]! + o.greenOverRed && src[i * 4 + 1]! >= src[i * 4 + 2]! + o.greenOverBlue && src[i * 4 + 1]! >= o.minValue && src[i * 4 + 1]! - Math.min(src[i * 4]!, src[i * 4 + 2]!) >= o.minSaturation * src[i * 4 + 1]!;
  const neighbours = (i: number) => [i % w > 0 ? i - 1 : -1, i % w + 1 < w ? i + 1 : -1, i >= w ? i - w : -1, i + w < size ? i + w : -1];
  const chart = new Int32Array(size).fill(-1), chartSizes: number[] = [], chartMask: number[] = [];
  for (let start = 0; start < size; start++) {
    if (chart[start]! >= 0 || padding(start)) continue;
    const label = chartSizes.length, stack = [start]; chart[start] = label;
    let area = 0, covered = 0;
    for (let q = 0; q < stack.length; q++) {
      const i = stack[q]!; area++; covered += mask[i] ? 1 : 0;
      for (const j of neighbours(i)) if (j >= 0 && chart[j]! < 0 && !padding(j)) { chart[j] = label; stack.push(j); }
    }
    chartSizes.push(area); chartMask.push(covered);
  }
  const visited = new Uint8Array(size), decisions: VegetationRepairDecision[] = [];
  let changed = 0, candidates = 0;
  for (let start = 0; start < size; start++) {
    if (!mask[start] || visited[start]) continue;
    const region = [start]; visited[start] = 1;
    for (let q = 0; q < region.length; q++) for (const j of neighbours(region[q]!)) if (j >= 0 && mask[j] && !visited[j]) { visited[j] = 1; region.push(j); }
    candidates += region.length;
    const reject = (reason: string) => decisions.push({ pixels: region.length, reason, accepted: false });
    const label = chart[start]!;
    if (label < 0 || region.some(i => chart[i] !== label)) { reject('cross-chart candidate'); continue; }
    if (chartMask[label]! / chartSizes[label]! > (o.maxChartEraseFraction ?? 0.08)) { reject('chart heavily occluded; retained original photograph'); continue; }
    const ax = axis[start]!;
    if (ax > 1 || region.some(i => axis[i] !== ax)) { reject('slanted or ambiguous wall rows'); continue; }
    const scales = region.map(i => texelsPerMetre[i]!).filter(v => v > 0).sort((a, b) => a - b);
    const perMetre = scales[scales.length >> 1] ?? 0;
    if (!perMetre) { reject('missing wall scale'); continue; }
    const R = ax === 0 ? h : w, C = ax === 0 ? w : h;
    const at = (r: number, c: number) => ax === 0 ? r * w + c : c * w + r;
    const rc = (i: number): [number, number] => ax === 0 ? [(i / w) | 0, i % w] : [i % w, (i / w) | 0];
    let r0 = R, r1 = -1, c0 = C, c1 = -1;
    for (const i of region) { const [r, c] = rc(i); r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
    if (Math.max(r1 - r0 + 1, c1 - c0 + 1) > (o.maxRegionMetres ?? 4) * perMetre) { reject('repair extent exceeds bounded architectural region'); continue; }
    const border = new Set<number>(), guard = Math.max(2, Math.min(5, Math.round(perMetre * 0.2)));
    for (const i of region) { const [r, c] = rc(i); for (let dr = -guard; dr <= guard; dr++) for (let dc = -guard; dc <= guard; dc++) {
      if (r + dr < 0 || r + dr >= R || c + dc < 0 || c + dc >= C) continue;
      const j = at(r + dr, c + dc);
      if (!mask[j] && chart[j] === label && axis[j] === ax && !foliage(j)) border.add(j);
    } }
    if (border.size < Math.max(24, Math.sqrt(region.length) * 3)) { reject('insufficient unoccluded boundary context'); continue; }
    const kept = (i: number) => chart[i] === label && axis[i] === ax && !mask[i] && !foliage(i);
    const lo = Math.max(0, c0 - Math.round(12 * perMetre)), hi = Math.min(C - 1, c1 + Math.round(12 * perMetre));
    const prof = new Float64Array(hi - lo + 1).fill(NaN);
    for (let c = lo; c <= hi; c++) {
      let sum = 0, n = 0;
      for (let r = Math.max(0, r0 - guard); r <= Math.min(R - 1, r1 + guard); r++) { const i = at(r, c); if (kept(i)) { sum += 0.299 * src[i * 4]! + 0.587 * src[i * 4 + 1]! + 0.114 * src[i * 4 + 2]!; n++; } }
      if (n >= Math.max(3, (r1 - r0 + 1) * 0.6)) prof[c - lo] = sum / n;
    }
    const periods: { lag: number; correlation: number }[] = [];
    for (let lag = Math.max(2, Math.round(o.bayMetres[0] * perMetre)); lag <= Math.round(o.bayMetres[1] * perMetre); lag++) {
      let n = 0, sa = 0, sb = 0, aa = 0, bb = 0, ab = 0;
      for (let k = 0; k + lag < prof.length; k++) { const a = prof[k]!, b = prof[k + lag]!; if (!Number.isFinite(a) || !Number.isFinite(b)) continue; n++; sa += a; sb += b; aa += a * a; bb += b * b; ab += a * b; }
      const va = aa / n - (sa / n) ** 2, vb = bb / n - (sb / n) ** 2;
      if (n >= Math.max(12, lag * 2) && va > 9 && vb > 9) periods.push({ lag, correlation: (ab / n - sa * sb / n ** 2) / Math.sqrt(va * vb) });
    }
    const best = Math.max(0, ...periods.map(p => p.correlation));
    const period = periods.find(p => p.correlation >= Math.max(o.minBayCorrelation, 0.9, best - 0.02))?.lag;
    if (!period) { reject('no strong repeated window-bay evidence'); continue; }
    let winner: { shift: number; error: number } | undefined;
    for (let multiple = 1; multiple * period <= 12 * perMetre; multiple++) for (const shift of [-multiple * period, multiple * period]) {
      const shifted = (i: number) => { const [r, c] = rc(i); return c + shift < 0 || c + shift >= C ? -1 : at(r, c + shift); };
      if (region.some(i => { const j = shifted(i); return j < 0 || !kept(j); })) continue;
      const errors: number[] = [];
      let total = 0, valid = true;
      for (const i of border) {
        const j = shifted(i); if (j < 0 || !kept(j)) { valid = false; break; }
        let e = 0; for (let ch = 0; ch < 3; ch++) e += Math.abs(src[i * 4 + ch]! - src[j * 4 + ch]!);
        e /= 3; errors.push(e); total += e;
      }
      if (!valid) continue;
      const error = total / border.size; errors.sort((a, b) => a - b);
      if (error > (o.maxBoundaryError ?? 10) || errors[Math.floor(errors.length * 0.95)]! > 30) continue;
      if (!winner || error < winner.error) winner = { shift, error };
    }
    if (!winner) { reject('no complete donor with aligned architectural boundary'); continue; }
    for (const i of region) { const [r, c] = rc(i), j = at(r, c + winner.shift); rgba.set(src.subarray(j * 4, j * 4 + 3), i * 4); }
    changed += region.length;
    decisions.push({ pixels: region.length, reason: 'one coherent same-chart window-bay copy', accepted: true, shift: winner.shift, boundaryError: winner.error });
  }
  if (diagnostics) { diagnostics.candidates = candidates; diagnostics.changed = changed; diagnostics.decisions = decisions; }
  return changed;
}
