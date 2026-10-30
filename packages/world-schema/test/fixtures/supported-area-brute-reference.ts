// Frozen exact pre-index validation semantics; bounds enlarged for differential tests only.
import type { GameplayBundle, SupportedArea } from '../../src/types.ts';
import type { Vec2 } from '../../src/coordinates.ts';

type Area = GameplayBundle['playArea'];
type Coverage = Pick<GameplayBundle, 'playArea' | 'supportedArea'>;
type Ring = readonly Vec2[];
const EPSILON = 1e-8;
const MAX_VERTICES = 65536;
const edges = (ring: Ring): readonly [Vec2, Vec2][] => ring.map((p, i) => [p, ring[(i + 1) % ring.length]!] as const);
const cross = (a: Vec2, b: Vec2, c: Vec2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function pointDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], d = dx * dx + dz * dz;
  const t = d ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / d)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
function intersects(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  if (Math.max(a[0], b[0]) + EPSILON < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) + EPSILON < Math.min(a[0], b[0])
    || Math.max(a[1], b[1]) + EPSILON < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) + EPSILON < Math.min(a[1], b[1])) return false;
  const ab = [cross(a, b, c), cross(a, b, d)], cd = [cross(c, d, a), cross(c, d, b)];
  return Math.min(...ab) <= EPSILON && Math.max(...ab) >= -EPSILON && Math.min(...cd) <= EPSILON && Math.max(...cd) >= -EPSILON;
}
interface Dyadic { n: bigint; exponent: number }
const floatBits = new DataView(new ArrayBuffer(8));
function dyadic(value: number): Dyadic {
  floatBits.setFloat64(0, value, false);
  const raw = floatBits.getBigUint64(0, false), exponent = Number((raw >> 52n) & 2047n), fraction = raw & ((1n << 52n) - 1n);
  return { n: (raw >> 63n ? -1n : 1n) * (exponent ? (1n << 52n) + fraction : fraction), exponent: exponent ? exponent - 1075 : -1074 };
}
function subtractDyadic(a: Dyadic, b: Dyadic): Dyadic {
  const exponent = Math.min(a.exponent, b.exponent);
  return { n: (a.n << BigInt(a.exponent - exponent)) - (b.n << BigInt(b.exponent - exponent)), exponent };
}
function multiplyDyadic(a: Dyadic, b: Dyadic): Dyadic { return { n: a.n * b.n, exponent: a.exponent + b.exponent }; }
function exactDeterminant(a: Vec2, b: Vec2, c: Vec2): Dyadic {
  const ax = dyadic(a[0]), az = dyadic(a[1]);
  return subtractDyadic(multiplyDyadic(subtractDyadic(dyadic(b[0]), ax), subtractDyadic(dyadic(c[1]), az)),
    multiplyDyadic(subtractDyadic(dyadic(b[1]), az), subtractDyadic(dyadic(c[0]), ax)));
}
/** Validation uses exact source topology, not the gameplay clearance epsilon. */
function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  const left = (b[0] - a[0]) * (c[1] - a[1]), right = (b[1] - a[1]) * (c[0] - a[0]), determinant = left - right;
  if (Number.isFinite(determinant) && Math.abs(determinant) > (Math.abs(left) + Math.abs(right)) * Number.EPSILON * 16) return Math.sign(determinant);
  const exact = exactDeterminant(a, b, c).n; return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}
function topologyIntersects(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0])
    || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  return orientation(a, b, c) * orientation(a, b, d) <= 0 && orientation(c, d, a) * orientation(c, d, b) <= 0;
}
/** -1 outside, 0 exactly on an edge, 1 inside; used only for schema topology. */
function location(ring: Ring, p: Vec2): number {
  let inside = false;
  for (const [a, b] of edges(ring)) {
    const sign = orientation(a, b, p);
    if (sign === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
      && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) return 0;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && (sign > 0) === (b[1] > a[1])) inside = !inside;
  }
  return inside ? 1 : -1;
}
function ringsIntersect(a: Ring, b: Ring): boolean { return edges(a).some(([p, q]) => edges(b).some(([r, s]) => topologyIntersects(p, q, r, s))); }
function exactLocation(ring: Ring, p: readonly [Dyadic, Dyadic]): number {
  let inside = false;
  const compare = (a: Dyadic, b: Dyadic) => { const n = subtractDyadic(a, b).n; return n > 0n ? 1 : n < 0n ? -1 : 0; };
  for (const [a, b] of edges(ring)) {
    const ax = dyadic(a[0]), az = dyadic(a[1]), bx = dyadic(b[0]), bz = dyadic(b[1]);
    const determinant = subtractDyadic(multiplyDyadic(subtractDyadic(bx, ax), subtractDyadic(p[1], az)), multiplyDyadic(subtractDyadic(bz, az), subtractDyadic(p[0], ax))).n;
    if (determinant === 0n && compare(p[0], dyadic(Math.min(a[0], b[0]))) >= 0 && compare(p[0], dyadic(Math.max(a[0], b[0]))) <= 0
      && compare(p[1], dyadic(Math.min(a[1], b[1]))) >= 0 && compare(p[1], dyadic(Math.max(a[1], b[1]))) <= 0) return 0;
    if ((compare(az, p[1]) > 0) !== (compare(bz, p[1]) > 0) && (determinant > 0n) === (b[1] > a[1])) inside = !inside;
  }
  return inside ? 1 : -1;
}
/** Point contacts preserve the excluded union. Any positive overlap/shared edge is rejected.
 * Partition edges at all contacts before probing; a vertex-on-edge crossing may hide
 * an overlapping interval even when every polygon vertex lies on/outside the other. */
function holesConflict(a: Ring, b: Ring): boolean {
  const box = (r: Ring) => [Math.min(...r.map(p => p[0])), Math.min(...r.map(p => p[1])), Math.max(...r.map(p => p[0])), Math.max(...r.map(p => p[1]))];
  const ab = box(a), bb = box(b);
  if (ab[2]! < bb[0]! || bb[2]! < ab[0]! || ab[3]! < bb[1]! || bb[3]! < ab[1]!) return false;
  const ae = edges(a), be = edges(b), cutsA = ae.map(([p, q]) => [p, q]), cutsB = be.map(([p, q]) => [p, q]); let contact = false;
  const onSegment = (p: Vec2, q: Vec2, v: Vec2) => orientation(p, q, v) === 0 && v[0] >= Math.min(p[0], q[0]) && v[0] <= Math.max(p[0], q[0]) && v[1] >= Math.min(p[1], q[1]) && v[1] <= Math.max(p[1], q[1]);
  for (let i = 0; i < ae.length; i++) for (let j = 0; j < be.length; j++) {
    const [p, q] = ae[i]!, [r, s] = be[j]!;
    if (!topologyIntersects(p, q, r, s)) continue;
    contact = true;
    const signs = [orientation(p, q, r), orientation(p, q, s), orientation(r, s, p), orientation(r, s, q)];
    if (signs[0]! * signs[1]! < 0 && signs[2]! * signs[3]! < 0) return true;
    if (signs.every(sign => sign === 0)) {
      const axis = Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1]) ? 0 : 1;
      if (Math.max(Math.min(p[axis], q[axis]), Math.min(r[axis], s[axis])) < Math.min(Math.max(p[axis], q[axis]), Math.max(r[axis], s[axis]))) return true;
    }
    for (const v of [r, s]) if (onSegment(p, q, v)) cutsA[i]!.push(v);
    for (const v of [p, q]) if (onSegment(r, s, v)) cutsB[j]!.push(v);
  }
  if (!contact) return location(a, b[0]!) > 0 || location(b, a[0]!) > 0;
  if (a.some(p => location(b, p) > 0) || b.some(p => location(a, p) > 0)) return true;
  const interior = (segments: readonly (readonly Vec2[])[], other: Ring) => segments.some(points => {
    const first = points[0]!, second = points[1]!, axis = Math.abs(second[0] - first[0]) >= Math.abs(second[1] - first[1]) ? 0 : 1;
    const sorted = [...points].sort((p, q) => p[axis] - q[axis]);
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1]!, q = sorted[i]!; if (p[0] === q[0] && p[1] === q[1]) continue;
      const midpoint = [0, 1].map(k => { const term = dyadic(q[k]!), sum = subtractDyadic(dyadic(p[k]!), { ...term, n: -term.n }); return { n: sum.n, exponent: sum.exponent - 1 }; }) as [Dyadic, Dyadic];
      if (exactLocation(other, midpoint) > 0) return true;
    }
    return false;
  });
  return interior(cutsA, b) || interior(cutsB, a);
}
/** A hole may meet the outer ring at points, but none of its open edge intervals may escape it. */
function holeWithinOuter(hole: Ring, outer: Ring): boolean {
  if (hole.some(p => location(outer, p) < 0)) return false;
  for (const [a, b] of edges(hole)) {
    const cuts: Vec2[] = [a, b];
    for (const [c, d] of edges(outer)) {
      if (!topologyIntersects(a, b, c, d)) continue;
      const signs = [orientation(a, b, c), orientation(a, b, d), orientation(c, d, a), orientation(c, d, b)];
      if (signs[0]! * signs[1]! < 0 && signs[2]! * signs[3]! < 0) return false;
      const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
      if (signs.every(sign => sign === 0) && Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) < Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))) return false;
      for (const p of [c, d]) if (orientation(a, b, p) === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) cuts.push(p);
    }
    const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1; cuts.sort((p, q) => p[axis] - q[axis]);
    for (let i = 1; i < cuts.length; i++) {
      const p = cuts[i - 1]!, q = cuts[i]!; if (p[0] === q[0] && p[1] === q[1]) continue;
      const midpoint = [0, 1].map(k => { const term = dyadic(q[k]!), sum = subtractDyadic(dyadic(p[k]!), { ...term, n: -term.n }); return { n: sum.n, exponent: sum.exponent - 1 }; }) as [Dyadic, Dyadic];
      if (exactLocation(outer, midpoint) < 0) return false;
    }
  }
  return true;
}
function keys(value: object, required: string[], optional: string[] = []): boolean {
  return required.every(k => k in value) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
}
/** Translate before summing; exact fallback retains every nonzero source sliver. */
function hasArea(ring: Ring): boolean {
  const origin = ring[0]!; let sum = 0, magnitude = 0;
  for (let i = 1; i + 1 < ring.length; i++) { const a = ring[i]!, b = ring[i + 1]!;
    const left = (a[0] - origin[0]) * (b[1] - origin[1]), right = (b[0] - origin[0]) * (a[1] - origin[1]);
    sum += left - right; magnitude += Math.abs(left) + Math.abs(right);
  }
  if (Number.isFinite(sum) && Math.abs(sum) > magnitude * Number.EPSILON * ring.length * 16) return true;
  let exact: Dyadic = { n: 0n, exponent: 0 };
  for (let i = 1; i + 1 < ring.length; i++) { const term = exactDeterminant(origin, ring[i]!, ring[i + 1]!); exact = subtractDyadic(exact, { ...term, n: -term.n }); }
  return exact.n !== 0n;
}
export function validateSupportedArea(value: unknown, area: Area): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || !keys(value, ['schemaVersion', 'regions'])
    || (value as SupportedArea).schemaVersion !== 1 || !Array.isArray((value as SupportedArea).regions)
    || !(value as SupportedArea).regions.length || (value as SupportedArea).regions.length > 128) return ['supportedArea must contain 1 to 128 normalized regions'];
  const regions = (value as SupportedArea).regions, ids = new Set<string>();
  let vertices = 0;
  for (const region of regions) {
    if (!region || typeof region !== 'object' || !keys(region, ['id', 'outer'], ['holes']) || typeof region.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(region.id) || ids.has(region.id)
      || (region.holes !== undefined && (!Array.isArray(region.holes) || region.holes.length > 8192))) return ['supportedArea has an invalid region'];
    ids.add(region.id);
    for (const ring of [region.outer, ...region.holes ?? []]) {
      if (!Array.isArray(ring) || ring.length < 3 || (vertices += ring.length) > MAX_VERTICES
        || ring.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v))
          || p[0] < area.minX || p[0] > area.maxX || p[1] < area.minZ || p[1] > area.maxZ)) return ['supportedArea has an invalid or out-of-bounds ring'];
      const lines = edges(ring);
      if (lines.some(([a, b]) => a[0] === b[0] && a[1] === b[1])
        || !hasArea(ring)) return ['supportedArea has an empty or degenerate ring'];
      for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
        if (j === i + 1 || (i === 0 && j === lines.length - 1)) continue;
        if (topologyIntersects(...lines[i]!, ...lines[j]!)) return ['supportedArea rings must be simple'];
      }
    }
    const holes = region.holes ?? [];
    for (let i = 0; i < holes.length; i++) {
      const hole = holes[i]!;
      if (!holeWithinOuter(hole, region.outer)) return ['supportedArea hole must lie inside its outer ring without crossings or shared edges'];
      for (let j = 0; j < i; j++) if (holesConflict(hole, holes[j]!))
        return ['supportedArea hole interiors must be disjoint without shared edges'];
    }
  }
  for (let i = 0; i < regions.length; i++) for (let j = 0; j < i; j++) {
    const a = regions[i]!, b = regions[j]!;
    if (ringsIntersect(a.outer, b.outer) || location(a.outer, b.outer[0]!) >= 0 || location(b.outer, a.outer[0]!) >= 0)
      errors.push('supportedArea components must be disjoint and normalized');
  }
  return errors;
}
