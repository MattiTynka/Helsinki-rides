// Bridge-specific derivative of the frozen source-fragment partitioner.
// Unlike the lane repair, adjacent curved deck quads have internal boundaries:
// old walls aligned to those internal cuts must not remain inside a new deck.
import assert from 'node:assert/strict';
import {encodeCollisionBundle,parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import type {FrontierMesh} from './frontier-ground.ts';
import type {GroundAttributeArray} from './replace-ground-glb.ts';
import type {SupportTriangle,SupportVertex,TramSupportPatch} from './tram-support-repair.ts';
import type {TramPoint} from './tram-visuals.ts';
export interface BridgeReplacementPatch extends TramSupportPatch {
  /** Remove only obsolete source triangles wholly below this absolute Y.
   * This protects the real, higher bank when a surveyed bridge footprint
   * also contains an old terrain-derived sheet down near the water. */
  maximumSourceY?:number;
  /** Explicitly reconstructed original coast-seal walls, indexed by the
   * polygon edge. Other true outer walls remain protected. */
  replaceBoundaryEdges?:readonly number[];
  /** Whole original shoreline segments avoid row-end rounding artifacts. */
  replaceBoundarySegments?:readonly(readonly[TramPoint,TramPoint])[];
}
function weights(t: SupportTriangle, v: SupportVertex): number[] {
  const [a, b, c] = t, den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  assert.ok(Math.abs(den) > 1e-10);
  const u = ((b[2] - c[2]) * (v[0] - c[0]) + (c[0] - b[0]) * (v[2] - c[2])) / den;
  const w = ((c[2] - a[2]) * (v[0] - c[0]) + (a[0] - c[0]) * (v[2] - c[2])) / den;
  return [u, w, 1 - u - w];
}
interface ClipVertex {attributes: Record<string, number[]>}
/** Partition each selected source triangle into disjoint outside fragments.
 * Original vertices stay literal prefixes, and every wholly outside triangle
 * retains its original three indices and attributes. */
export function retainOutsideBridge(mesh: FrontierMesh, patches: readonly BridgeReplacementPatch[], select: (triangle: number) => boolean = () => true) {
  const extras = Object.fromEntries(Object.keys(mesh.attributes).map(k => [k, [] as number[]])), indices: number[] = [], sourceTriangles: number[] = [], removed: number[] = [], clipped: number[] = [];
  const position = (v: ClipVertex) => v.attributes.POSITION!;
  let activePatches=patches;
  const unionContains=(q:TramPoint)=>activePatches.some(zone=>{const B=zone.boundsXZ;if(q[0]<B[0]-1e-10||q[0]>B[2]+1e-10||q[1]<B[1]-1e-10||q[1]>B[3]+1e-10)return false;const r=zone.footprint!,sign=Math.sign((r[1]![0]-r[0]![0])*(r[2]![1]-r[0]![1])-(r[1]![1]-r[0]![1])*(r[2]![0]-r[0]![0]));return r.every((a,j)=>{const c=r[(j+1)%r.length]!;return((c[0]-a[0])*(q[1]-a[1])-(c[1]-a[1])*(q[0]-a[0]))*sign>=-1e-12;});});
  const strictlyInside=(q:TramPoint)=>[[1e-6,0],[-1e-6,0],[0,1e-6],[0,-1e-6]].every(([x,z])=>unionContains([q[0]+x!,q[1]+z!]));

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
    const relevant=patches.filter(p=>{if(p.maximumSourceY!==undefined&&ring.some(v=>position(v)[1]!>p.maximumSourceY!))return false;const b=p.boundsXZ,x=ring.map(v=>position(v)[0]!),z=ring.map(v=>position(v)[2]!);return Math.min(...x)<=b[2]&&Math.max(...x)>=b[0]&&Math.min(...z)<=b[3]&&Math.max(...z)>=b[1];});
    if(!relevant.length){indices.push(...ids);sourceTriangles.push(t);continue;}
    activePatches=relevant;
    for (const patch of relevant) {
      assert.ok(patch.footprint&&patch.footprint.length>=3, 'Replacement needs an exact convex oriented footprint');
      const polygon = patch.footprint!, orientation = Math.sign((polygon[1]![0] - polygon[0]![0]) * (polygon[2]![1] - polygon[0]![1]) - (polygon[1]![1] - polygon[0]![1]) * (polygon[2]![0] - polygon[0]![0])), next: ClipVertex[][] = [];
      for (const fragment of fragments) {
        let inside = fragment; const outside: ClipVertex[][] = [];
        for (let j = 0; j < polygon.length && inside.length >= 3; j++) {const a = polygon[j]!, b = polygon[(j + 1) % polygon.length]!, value = (v: ClipVertex) => {const p = position(v); return ((b[0] - a[0]) * (p[2]! - a[1]) - (b[1] - a[1]) * (p[0]! - a[0])) * orientation;}; const part = cut(inside, v => -value(v)); if (part.length >= 3) outside.push(part); inside = cut(inside, value);}
        if (inside.length >= 3) {
          const p = inside.map(position), a = p[0]!; let area = 0;
          for (let i = 1; i < p.length - 1; i++) {const u = p[i]!.map((v, k) => v - a[k]!), v = p[i + 1]!.map((n, k) => n - a[k]!); area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;}
          const aligned = polygon.some((a, j) => {const b = polygon[(j + 1) % polygon.length]!; return p.every(v => Math.abs((b[0] - a[0]) * (v[2]! - a[1]) - (b[1] - a[1]) * (v[0]! - a[0])) < 1e-10);});
          const centre=[p.reduce((n,v)=>n+v[0]!,0)/p.length,p.reduce((n,v)=>n+v[2]!,0)/p.length] as TramPoint;
          const interiorSeam=aligned&&strictlyInside(centre);
          if (area > 1e-10 && (!aligned||interiorSeam)) touched = true;
        }
        next.push(...outside);
      }
      fragments = next;
    }
    // A named original seal can cross the current shoreline. Split only its
    // collinear source wall at the two exact segment endpoints, retaining the
    // land-side fragment and all interpolated original attributes.
    for(const zone of relevant)for(const[a,c]of zone.replaceBoundarySegments??[]){
      const dx=c[0]-a[0],dz=c[1]-a[1],L2=dx*dx+dz*dz;if(L2<=1e-16)continue;
      const u=(v:ClipVertex)=>((position(v)[0]!-a[0])*dx+(position(v)[2]!-a[1])*dz)/L2,next:ClipVertex[][]=[];
      for(const fragment of fragments){
        if(!fragment.every(v=>Math.abs(dx*(position(v)[2]!-a[1])-dz*(position(v)[0]!-a[0]))/Math.sqrt(L2)<.00008)||Math.max(...fragment.map(u))<=0||Math.min(...fragment.map(u))>=1){next.push(fragment);continue;}
        const inside=cut(cut(fragment,u),v=>1-u(v));if(inside.length<3){next.push(fragment);continue;}
        touched=true;for(const part of[cut(fragment,v=>-u(v)),cut(fragment,v=>u(v)-1)])if(part.length>=3)next.push(part);
      }fragments=next;
    }
    const outsideFragments=fragments.filter(fragment=>{const P=fragment.map(position),centre:[number,number]=[P.reduce((n,p)=>n+p[0]!,0)/P.length,P.reduce((n,p)=>n+p[2]!,0)/P.length],replacedBoundary=relevant.some(zone=>[...(zone.replaceBoundaryEdges??[]).map(edge=>[zone.footprint![edge]!,zone.footprint![(edge+1)%zone.footprint!.length]!] as const),...(zone.replaceBoundarySegments??[])].some(([a,c])=>{const dx=c[0]-a[0],dz=c[1]-a[1],L2=dx*dx+dz*dz;return L2>1e-16&&P.every(p=>{const u=((p[0]!-a[0])*dx+(p[2]!-a[1])*dz)/L2;return u>=-1e-7&&u<=1+1e-7&&Math.abs(dx*(p[2]!-a[1])-dz*(p[0]!-a[0]))/Math.sqrt(L2)<.00008;});}));return !strictlyInside(centre)&&!replacedBoundary;});
    if(outsideFragments.length!==fragments.length)touched=true;fragments=outsideFragments;
    if (!touched) {indices.push(...ids); sourceTriangles.push(t); continue;}
    removed.push(t); if (fragments.length) clipped.push(t);
    const densify = (fragment: ClipVertex[]): ClipVertex[] => {
      const out: ClipVertex[] = [];
      for (let i = 0; i < fragment.length; i++) {
        const a = fragment[i]!, b = fragment[(i + 1) % fragment.length]!, A = position(a), B = position(b), dx = B[0]! - A[0]!, dz = B[2]! - A[2]!, length2 = dx * dx + dz * dz;
        out.push(a); if (length2 < 1e-18) continue;
        const candidates: {u: number; vertex: ClipVertex}[] = [];
        for (const patch of relevant) {
        const onBoundary = patch.footprint!.some((p, j) => {const r = patch.footprint![(j + 1) % patch.footprint!.length]!, distance = (v: readonly number[]) => Math.abs((r[0] - p[0]) * (v[2]! - p[1]) - (r[1] - p[1]) * (v[0]! - p[0])) / Math.hypot(r[0] - p[0], r[1] - p[1]); return distance(A) < 1e-7 && distance(B) < 1e-7;});
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
export function replaceBridgeCollision(bytes:Uint8Array,patches:readonly BridgeReplacementPatch[]){
 const old=parseCollisionBundle(bytes),proof:unknown[]=[];
 const kept=old.colliders.map(c=>{if(c.group!=='ground'&&c.group!=='kerbs')return c;const out=retainOutsideBridge({attributes:{POSITION:c.positions},components:{POSITION:3},normalized:{POSITION:false},indices:c.indices},patches);proof.push({collider:c.id,...out.proof});return{...c,positions:out.mesh.attributes.POSITION as Float32Array,indices:out.mesh.indices,triangleTags:Uint16Array.from(out.sourceTriangles,t=>c.triangleTags[t]!)};});
 const next=encodeCollisionBundle(old.header,kept);for(const c of old.colliders.filter(c=>c.group!=='ground'&&c.group!=='kerbs'))assert.deepEqual(parseCollisionBundle(next).colliders.find(n=>n.id===c.id),c);return{bytes:next,proof};
}
