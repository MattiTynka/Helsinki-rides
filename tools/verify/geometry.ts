// Planar helpers for the footprint/mesh agreement checks (runtime XZ plane).
export type XZ = readonly [number, number];

export function pointInRing([x, z]: XZ, ring: readonly XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!, [xj, zj] = ring[j]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(p: XZ, rings: readonly (readonly XZ[])[]): boolean {
  return pointInRing(p, rings[0]!) && !rings.slice(1).some(hole => pointInRing(p, hole));
}

export function distanceToSegment([px, pz]: XZ, [ax, az]: XZ, [bx, bz]: XZ): number {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

export function distanceToRings(p: XZ, rings: readonly (readonly XZ[])[]): number {
  let best = Infinity;
  for (const ring of rings) for (let i = 0; i + 1 < ring.length; i++) best = Math.min(best, distanceToSegment(p, ring[i]!, ring[i + 1]!));
  return best;
}

/** Grid samples inside the polygon at least `inset` metres from any edge. */
export function interiorSamples(rings: readonly (readonly XZ[])[], step: number, inset: number): XZ[] {
  const xs = rings[0]!.map(p => p[0]), zs = rings[0]!.map(p => p[1]);
  const out: XZ[] = [];
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
    for (let z = Math.min(...zs) + step / 2; z < Math.max(...zs); z += step) {
      const p: XZ = [x, z];
      if (pointInPolygon(p, rings) && distanceToRings(p, rings) >= inset) out.push(p);
    }
  }
  return out;
}

/** Points `offset` metres outside each outer edge (every `spacing` metres along it). */
export function exteriorSamples(rings: readonly (readonly XZ[])[], offset: number, spacing: number): XZ[] {
  const ring = rings[0]!;
  const out: XZ[] = [];
  for (let i = 0; i + 1 < ring.length; i++) {
    const [ax, az] = ring[i]!, [bx, bz] = ring[i + 1]!;
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1e-6) continue;
    const nx = -(bz - az) / length, nz = (bx - ax) / length;
    for (let s = spacing / 2; s < length; s += spacing) {
      const mx = ax + ((bx - ax) * s) / length, mz = az + ((bz - az) * s) / length;
      let p: XZ = [mx + nx * offset, mz + nz * offset];
      if (pointInPolygon(p, rings)) p = [mx - nx * offset, mz - nz * offset];
      if (!pointInPolygon(p, rings)) out.push(p);
    }
  }
  return out;
}

export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;
}
