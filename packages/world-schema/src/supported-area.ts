import type { GameplayBundle, SupportedArea } from './types.ts';
import type { Vec2 } from './coordinates.ts';

type Area = GameplayBundle['playArea'];
type Coverage = Pick<GameplayBundle, 'playArea' | 'supportedArea'>;
type Ring = readonly Vec2[];
const EPSILON = 1e-8;
const MAX_VERTICES = 65536;
const MAX_HOLES_PER_REGION = 8192;
const MAX_TOPOLOGY_WORK = 2_000_000;
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
class TopologyComplexityError extends Error {}
interface TopologyRing { lines: readonly [Vec2, Vec2][]; boxes: readonly { bounds: Bounds }[]; index: EdgeNode; bounds: Bounds }
/** Index lifetime is one validation call: callers may mutate a rejected input before retrying. */
class TopologyValidation {
  private readonly rings = new Map<Ring, TopologyRing>();
  private work = 0;
  spend() { if (++this.work > MAX_TOPOLOGY_WORK) throw new TopologyComplexityError(); }
  ring(ring: Ring): TopologyRing {
    let prepared = this.rings.get(ring);
    if (!prepared) {
      const lines = edges(ring), boxes = lines.map(([a, b]) => ({ bounds: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] as Bounds }));
      const index = indexEdges(boxes, boxes.map((_, i) => i)); prepared = { lines, boxes, index, bounds: index.bounds }; this.rings.set(ring, prepared);
    }
    return prepared;
  }
  visit(ring: Ring, query: Bounds, visitor: (line: readonly [Vec2, Vec2], index: number) => boolean): boolean {
    const prepared = this.ring(ring);
    return visitBoxIndices(prepared.index, query, i => {
      if (!boundsOverlap(prepared.boxes[i]!.bounds, query)) return true;
      this.spend(); return visitor(prepared.lines[i]!, i);
    });
  }
}
function visitBoxIndices(node: EdgeNode, query: Bounds, visitor: (index: number) => boolean): boolean {
  if (!boundsOverlap(node.bounds, query)) return true;
  if (node.indices) { for (const i of node.indices) if (!visitor(i)) return false; return true; }
  return visitBoxIndices(node.left!, query, visitor) && visitBoxIndices(node.right!, query, visitor);
}
/** -1 outside, 0 exactly on an edge, 1 inside; used only for schema topology. */
function location(ring: Ring, p: Vec2, topology: TopologyValidation): number {
  let inside = false, boundary = false; const bounds = topology.ring(ring).bounds;
  topology.visit(ring, [bounds[0], p[1], bounds[2], p[1]], ([a, b]) => {
    const sign = orientation(a, b, p);
    if (sign === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
      && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) { boundary = true; return false; }
    if ((a[1] > p[1]) !== (b[1] > p[1]) && (sign > 0) === (b[1] > a[1])) inside = !inside;
    return true;
  });
  return boundary ? 0 : inside ? 1 : -1;
}
function ringsIntersect(a: Ring, b: Ring, topology: TopologyValidation): boolean {
  return topology.ring(a).lines.some(([p, q], i) => !topology.visit(b, topology.ring(a).boxes[i]!.bounds, ([r, s]) => !topologyIntersects(p, q, r, s)));
}
function exactLocation(ring: Ring, p: readonly [Dyadic, Dyadic], topology: TopologyValidation): number {
  let inside = false;
  const compare = (a: Dyadic, b: Dyadic) => { const n = subtractDyadic(a, b).n; return n > 0n ? 1 : n < 0n ? -1 : 0; };
  for (const [a, b] of topology.ring(ring).lines) {
    topology.spend();
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
function holesConflict(a: Ring, b: Ring, topology: TopologyValidation): boolean {
  const ab = topology.ring(a).bounds, bb = topology.ring(b).bounds;
  if (ab[2]! < bb[0]! || bb[2]! < ab[0]! || ab[3]! < bb[1]! || bb[3]! < ab[1]!) return false;
  const ae = topology.ring(a).lines, be = topology.ring(b).lines, cutsA = ae.map(([p, q]) => [p, q]), cutsB = be.map(([p, q]) => [p, q]); let contact = false, crossing = false;
  const onSegment = (p: Vec2, q: Vec2, v: Vec2) => orientation(p, q, v) === 0 && v[0] >= Math.min(p[0], q[0]) && v[0] <= Math.max(p[0], q[0]) && v[1] >= Math.min(p[1], q[1]) && v[1] <= Math.max(p[1], q[1]);
  for (let i = 0; i < ae.length && !crossing; i++) topology.visit(b, topology.ring(a).boxes[i]!.bounds, (_line, j) => {
    const [p, q] = ae[i]!, [r, s] = be[j]!;
    if (!topologyIntersects(p, q, r, s)) return true;
    contact = true;
    const signs = [orientation(p, q, r), orientation(p, q, s), orientation(r, s, p), orientation(r, s, q)];
    if (signs[0]! * signs[1]! < 0 && signs[2]! * signs[3]! < 0) { crossing = true; return false; }
    if (signs.every(sign => sign === 0)) {
      const axis = Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1]) ? 0 : 1;
      if (Math.max(Math.min(p[axis], q[axis]), Math.min(r[axis], s[axis])) < Math.min(Math.max(p[axis], q[axis]), Math.max(r[axis], s[axis]))) { crossing = true; return false; }
    }
    for (const v of [r, s]) if (onSegment(p, q, v)) cutsA[i]!.push(v);
    for (const v of [p, q]) if (onSegment(r, s, v)) cutsB[j]!.push(v);
    return true;
  });
  if (crossing) return true;
  if (!contact) return location(a, b[0]!, topology) > 0 || location(b, a[0]!, topology) > 0;
  if (a.some(p => location(b, p, topology) > 0) || b.some(p => location(a, p, topology) > 0)) return true;
  const interior = (segments: readonly (readonly Vec2[])[], other: Ring) => segments.some(points => {
    const first = points[0]!, second = points[1]!, axis = Math.abs(second[0] - first[0]) >= Math.abs(second[1] - first[1]) ? 0 : 1;
    const sorted = [...points].sort((p, q) => p[axis] - q[axis]);
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1]!, q = sorted[i]!; if (p[0] === q[0] && p[1] === q[1]) continue;
      const midpoint = [0, 1].map(k => { const term = dyadic(q[k]!), sum = subtractDyadic(dyadic(p[k]!), { ...term, n: -term.n }); return { n: sum.n, exponent: sum.exponent - 1 }; }) as [Dyadic, Dyadic];
      if (exactLocation(other, midpoint, topology) > 0) return true;
    }
    return false;
  });
  return interior(cutsA, b) || interior(cutsB, a);
}
/** A hole may meet the outer ring at points, but none of its open edge intervals may escape it. */
function holeWithinOuter(hole: Ring, outer: Ring, topology: TopologyValidation): boolean {
  if (hole.some(p => location(outer, p, topology) < 0)) return false;
  for (const [index, [a, b]] of topology.ring(hole).lines.entries()) {
    const cuts: Vec2[] = [a, b]; let crossing = false, contact = false;
    topology.visit(outer, topology.ring(hole).boxes[index]!.bounds, ([c, d]) => {
      if (!topologyIntersects(a, b, c, d)) return true;
      contact = true;
      const signs = [orientation(a, b, c), orientation(a, b, d), orientation(c, d, a), orientation(c, d, b)];
      if (signs[0]! * signs[1]! < 0 && signs[2]! * signs[3]! < 0) { crossing = true; return false; }
      const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
      if (signs.every(sign => sign === 0) && Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) < Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))) { crossing = true; return false; }
      for (const p of [c, d]) if (orientation(a, b, p) === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) cuts.push(p);
      return true;
    });
    if (crossing) return false;
    // With inside endpoints, a simple outer ring cannot be exited without an edge contact.
    if (!contact) continue;
    const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1; cuts.sort((p, q) => p[axis] - q[axis]);
    for (let i = 1; i < cuts.length; i++) {
      const p = cuts[i - 1]!, q = cuts[i]!; if (p[0] === q[0] && p[1] === q[1]) continue;
      const midpoint = [0, 1].map(k => { const term = dyadic(q[k]!), sum = subtractDyadic(dyadic(p[k]!), { ...term, n: -term.n }); return { n: sum.n, exponent: sum.exponent - 1 }; }) as [Dyadic, Dyadic];
      if (exactLocation(outer, midpoint, topology) < 0) return false;
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
  try { return validateSupportedAreaBounded(value, area, new TopologyValidation()); }
  catch (error) { if (error instanceof TopologyComplexityError) return ['supportedArea topology exceeds the bounded validation work limit']; throw error; }
}
function validateSupportedAreaBounded(value: unknown, area: Area, topology: TopologyValidation): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || !keys(value, ['schemaVersion', 'regions'])
    || (value as SupportedArea).schemaVersion !== 1 || !Array.isArray((value as SupportedArea).regions)
    || !(value as SupportedArea).regions.length || (value as SupportedArea).regions.length > 128) return ['supportedArea must contain 1 to 128 normalized regions'];
  const regions = (value as SupportedArea).regions, ids = new Set<string>();
  let vertices = 0;
  for (const region of regions) {
    if (!region || typeof region !== 'object' || !keys(region, ['id', 'outer'], ['holes']) || typeof region.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(region.id) || ids.has(region.id)
      || (region.holes !== undefined && (!Array.isArray(region.holes) || region.holes.length > MAX_HOLES_PER_REGION))) return ['supportedArea has an invalid region'];
    ids.add(region.id);
    for (const ring of [region.outer, ...region.holes ?? []]) {
      if (!Array.isArray(ring) || ring.length < 3 || (vertices += ring.length) > MAX_VERTICES
        || ring.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v))
          || p[0] < area.minX || p[0] > area.maxX || p[1] < area.minZ || p[1] > area.maxZ)) return ['supportedArea has an invalid or out-of-bounds ring'];
      const lines = topology.ring(ring).lines;
      if (lines.some(([a, b]) => a[0] === b[0] && a[1] === b[1])
        || !hasArea(ring)) return ['supportedArea has an empty or degenerate ring'];
      for (let i = 0; i < lines.length; i++) if (!topology.visit(ring, topology.ring(ring).boxes[i]!.bounds, (line, j) => {
        if (j <= i || j === i + 1 || (i === 0 && j === lines.length - 1)) return true;
        return !topologyIntersects(...lines[i]!, ...line);
      })) return ['supportedArea rings must be simple'];
    }
    const holes = region.holes ?? [];
    const holeBoxes = holes.map(hole => ({ bounds: topology.ring(hole).bounds })), holeIndex = holes.length ? indexEdges(holeBoxes, holes.map((_, i) => i)) : null;
    for (let i = 0; i < holes.length; i++) {
      const hole = holes[i]!;
      if (!holeWithinOuter(hole, region.outer, topology)) return ['supportedArea hole must lie inside its outer ring without crossings or shared edges'];
      if (!visitBoxIndices(holeIndex!, holeBoxes[i]!.bounds, j => {
        if (j >= i || !boundsOverlap(holeBoxes[i]!.bounds, holeBoxes[j]!.bounds)) return true;
        topology.spend(); return !holesConflict(hole, holes[j]!, topology);
      }))
        return ['supportedArea hole interiors must be disjoint without shared edges'];
    }
  }
  for (let i = 0; i < regions.length; i++) for (let j = 0; j < i; j++) {
    const a = regions[i]!, b = regions[j]!;
    // A component strictly inside another component's hole is disjoint positive
    // geography. Test the complete outer ring against that hole, so one point
    // inside a hole cannot excuse a crossing or touching occupied boundary.
    const containedInHole = (inner: Ring, region: typeof a) => (region.holes ?? []).some(hole =>
      location(hole, inner[0]!, topology) > 0 && !ringsIntersect(inner, hole, topology));
    if (ringsIntersect(a.outer, b.outer, topology)
      || (location(a.outer, b.outer[0]!, topology) >= 0 && !containedInHole(b.outer, a))
      || (location(b.outer, a.outer[0]!, topology) >= 0 && !containedInHole(a.outer, b)))
      errors.push('supportedArea components must be disjoint and normalized');
  }
  return errors;
}

type Bounds = readonly [number, number, number, number];
interface PreparedEdge { a: Vec2; b: Vec2; bounds: Bounds; hole: boolean; ring: number }
interface EdgeNode { bounds: Bounds; indices?: readonly number[]; left?: EdgeNode; right?: EdgeNode }
interface PreparedRegion {
  edges: readonly PreparedEdge[]; edgeIndex: EdgeNode; bounds: Bounds;
  interiorTiles: Map<string, boolean | null>;
}
const boundsOverlap = (a: Bounds, b: Bounds): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
/** Median splits bound depth and allocation by the global vertex cap, even for very long edges. */
function indexEdges(lines: readonly { bounds: Bounds }[], indices: number[]): EdgeNode {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const i of indices) { const b = lines[i]!.bounds; x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[1]); x1 = Math.max(x1, b[2]); z1 = Math.max(z1, b[3]); }
  const bounds: Bounds = [x0, z0, x1, z1];
  if (indices.length <= 8) return { bounds, indices };
  const axis = x1 - x0 >= z1 - z0 ? 0 : 1;
  indices.sort((i, j) => { const a = lines[i]!.bounds, b = lines[j]!.bounds; return (a[axis]! / 2 + a[axis + 2]! / 2) - (b[axis]! / 2 + b[axis + 2]! / 2); });
  const middle = Math.floor(indices.length / 2);
  return { bounds, left: indexEdges(lines, indices.slice(0, middle)), right: indexEdges(lines, indices.slice(middle)) };
}
/** False from the visitor stops the query. The broad phase never changes exact geometry predicates. */
function visitEdges(region: PreparedRegion, query: Bounds, visit: (edge: PreparedEdge) => boolean, node = region.edgeIndex): boolean {
  if (!boundsOverlap(node.bounds, query)) return true;
  if (node.indices) { for (const i of node.indices) { const edge = region.edges[i]!; if (boundsOverlap(edge.bounds, query) && !visit(edge)) return false; } return true; }
  return visitEdges(region, query, visit, node.left!) && visitEdges(region, query, visit, node.right!);
}
const prepared = new WeakMap<SupportedArea, readonly PreparedRegion[]>();
function regions(mask: SupportedArea): readonly PreparedRegion[] {
  let result = prepared.get(mask);
  if (!result) {
    result = mask.regions.map(r => {
      const lines = [r.outer, ...r.holes ?? []].flatMap((ring, ringIndex) => edges(ring).map(([a, b]) => ({
        a, b, hole: ringIndex > 0, ring: ringIndex, bounds: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] as Bounds,
      })));
      const edgeIndex = indexEdges(lines, lines.map((_, i) => i));
      return { edges: lines, edgeIndex, bounds: edgeIndex.bounds, interiorTiles: new Map<string, boolean | null>() };
    });
    prepared.set(mask, result);
  }
  return result;
}
function insideRegion(region: PreparedRegion, p: Vec2): boolean {
  let insideOuter = false, outerBoundary = false, holeBoundary = false;
  const containingHoles = new Set<number>();
  // Keep the full horizontal span to preserve the original crossing arithmetic.
  visitEdges(region, [region.bounds[0], p[1] - EPSILON, region.bounds[2], p[1] + EPSILON], ({ a, b, hole, ring }) => {
    if (p[0] >= Math.min(a[0], b[0]) - EPSILON && p[0] <= Math.max(a[0], b[0]) + EPSILON
      && p[1] >= Math.min(a[1], b[1]) - EPSILON && p[1] <= Math.max(a[1], b[1]) + EPSILON
      && pointDistance(p, a, b) <= EPSILON) {
      if (hole) { holeBoundary = true; return false; }
      outerBoundary = true;
    }
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) {
      if (hole) { if (containingHoles.has(ring)) containingHoles.delete(ring); else containingHoles.add(ring); }
      else insideOuter = !insideOuter;
    }
    return true;
  });
  return !holeBoundary && (outerBoundary || insideOuter) && containingHoles.size === 0;
}
function contains(r: PreparedRegion, p: Vec2, margin: number): boolean {
  const b = r.bounds;
  if (!(p[0] >= b[0] + margin && p[0] <= b[2] - margin && p[1] >= b[1] + margin && p[1] <= b[3] - margin)) return false;
  const x0 = Math.floor(p[0] / 128) * 128, z0 = Math.floor(p[1] / 128) * 128;
  if (p[0] - margin > x0 && p[0] + margin < x0 + 128 && p[1] - margin > z0 && p[1] + margin < z0 + 128) {
    const key = `${x0},${z0}`;
    if (!r.interiorTiles.has(key)) {
      const boundary = !visitEdges(r, [x0, z0, x0 + 128, z0 + 128], () => false);
      if (r.interiorTiles.size >= 512) r.interiorTiles.delete(r.interiorTiles.keys().next().value!);
      r.interiorTiles.set(key, boundary ? null : insideRegion(r, p));
    }
    const interior = r.interiorTiles.get(key);
    if (interior !== null && interior !== undefined) return interior;
  }
  return insideRegion(r, p) && (margin === 0 || visitEdges(r, [p[0] - margin, p[1] - margin, p[0] + margin, p[1] + margin],
    ({ a, b }) => pointDistance(p, a, b) + EPSILON >= margin));
}
export function containsSupportedArea(gameplay: Coverage, x: number, z: number, margin = 0): boolean {
  if (![x, z, margin].every(Number.isFinite) || margin < 0) return false;
  const b = gameplay.playArea;
  if (x < b.minX + margin || x > b.maxX - margin || z < b.minZ + margin || z > b.maxZ - margin) return false;
  return !gameplay.supportedArea || regions(gameplay.supportedArea).some(r => contains(r, [x, z], margin));
}
export function supportsSegment(gameplay: Coverage, from: Vec2, to: Vec2, margin = 0): boolean {
  const rectangle = { playArea: gameplay.playArea };
  if (!containsSupportedArea(rectangle, from[0], from[1], margin) || !containsSupportedArea(rectangle, to[0], to[1], margin)) return false;
  if (!gameplay.supportedArea) return true;
  const x0 = Math.min(from[0], to[0]) - margin, z0 = Math.min(from[1], to[1]) - margin;
  const x1 = Math.max(from[0], to[0]) + margin, z1 = Math.max(from[1], to[1]) + margin;
  return regions(gameplay.supportedArea).some(r => contains(r, from, margin) && contains(r, to, margin)
    && visitEdges(r, [x0, z0, x1, z1], ({ a, b }) => !intersects(from, to, a, b)
      && (margin === 0 || Math.min(pointDistance(from, a, b), pointDistance(to, a, b), pointDistance(a, from, to), pointDistance(b, from, to)) + EPSILON >= margin)));
}
/** Complete convex footprint, including its interior. Edge-only checks miss a hole enclosed by a car.
 * The supplied ring must be convex, ordered, finite and implicitly closed. Clearance is Euclidean. */
export function supportsConvexFootprint(gameplay: Coverage, polygon: readonly Vec2[], margin = 0): boolean {
  if (!Number.isFinite(margin) || margin < 0 || polygon.length < 3 || polygon.length > 128
    || polygon.some(p => p.length !== 2 || !p.every(Number.isFinite))) return false;
  let winding = 0;
  for (let i = 0; i < polygon.length; i++) {
    const sign = orientation(polygon[i]!, polygon[(i + 1) % polygon.length]!, polygon[(i + 2) % polygon.length]!);
    if (sign && winding && sign !== winding) return false;
    if (sign) winding = sign;
  }
  if (!winding) return false;
  const lines = edges(polygon), rectangle = { playArea: gameplay.playArea };
  // Checking every edge against every vertex also rejects multiply wound/self-crossing inputs.
  if (lines.some(([a, b]) => (a[0] === b[0] && a[1] === b[1]) || polygon.some(p => orientation(a, b, p) * winding < 0))) return false;
  if (polygon.some(p => !containsSupportedArea(rectangle, p[0], p[1], margin))) return false;
  if (!gameplay.supportedArea) return true;
  const box: Bounds = [Math.min(...polygon.map(p => p[0])) - margin, Math.min(...polygon.map(p => p[1])) - margin,
    Math.max(...polygon.map(p => p[0])) + margin, Math.max(...polygon.map(p => p[1])) + margin];
  const inside = (p: Vec2) => lines.every(([a, b]) => cross(a, b, p) * winding >= -EPSILON);
  return regions(gameplay.supportedArea).some(r => contains(r, polygon[0]!, margin)
    && visitEdges(r, box, ({ a, b }) => !inside(a) && !inside(b) && lines.every(([p, q]) => !intersects(p, q, a, b)
      && (margin === 0 || Math.min(pointDistance(p, a, b), pointDistance(q, a, b), pointDistance(a, p, q), pointDistance(b, p, q)) + EPSILON >= margin))));
}
/** Maximum safe prefix of a requested move. This constrains movement at the edge, without a recovery teleport. */
export function supportedMotionFraction(gameplay: Coverage, from: Vec2, to: Vec2, margin: number): number {
  if (!gameplay.supportedArea || supportsSegment(gameplay, from, to, margin)) return 1;
  if (!containsSupportedArea(gameplay, from[0], from[1], margin)) return 0;
  let low = 0, high = 1;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2, p: Vec2 = [from[0] + (to[0] - from[0]) * middle, from[1] + (to[1] - from[1]) * middle];
    if (supportsSegment(gameplay, from, p, margin)) low = middle; else high = middle;
  }
  return Math.max(0, low - 1e-7);
}

