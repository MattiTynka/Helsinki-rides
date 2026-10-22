// Static world: terrain, per-cell collision bundles and the road graph loaded into a Rapier world. The sim never
// sees visual geometry; every collider here comes from the baked HCOL bundles (plan section 2, three representations).
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import {
  parseCollisionBundle, parseTerrain, sampleTerrain, RoadIndex,
  type CollisionBundle, type GameplayBundle, type RoadGraph, type TerrainGrid,
} from '@helsinki/world-schema';
import { TICK_SECONDS } from './commands.ts';
import { CollisionResidency, residencyPins, type CollisionCellRef, type ResidencyPlan, type ResidencySource } from './collision-residency.ts';

export { RAPIER };

/** Collision group bits: membership << 16 | filter. */
export const GROUP = { static: 0x0001, vehicle: 0x0002, character: 0x0004, bullet: 0x0008, all: 0xffff } as const;
export const groups = (membership: number, filter: number): number => ((membership & 0xffff) << 16) | (filter & 0xffff);

export interface SurfaceInfo {
  readonly tag: string;
  readonly group: string;
  readonly ref: string | null;
}

export class StaticWorld {
  readonly physics: RAPIER.World;
  readonly terrain: TerrainGrid;
  readonly roads: RoadIndex;
  readonly gameplay: GameplayBundle;
  /** collider handle -> surface tags per triangle, for contact tagging */
  private readonly triangleTags = new Map<number, { tags: Uint16Array; names: readonly string[]; group: string; ref: string | null }>();
  readonly staticHandles = new Set<number>();
  readonly cellColliders = new Map<string, number[]>();
  private readonly cellBodies = new Map<string, RAPIER.RigidBody>();
  /** Streaming mode only: residency rules and the decoded HCOL bytes of each cell when available. */
  private streaming: { readonly residency: CollisionResidency; readonly source: (cellId: string) => Uint8Array | undefined } | null = null;
  /** Cells inserted since the last physics step; Rapier queries cannot see them yet. */
  private readonly unsettled = new Set<string>();

  constructor(terrain: TerrainGrid, roads: RoadGraph, gameplay: GameplayBundle) {
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = TICK_SECONDS;
    this.terrain = terrain;
    this.roads = new RoadIndex(roads);
    this.gameplay = gameplay;
    // Fallback heightfield well below the authored ground, so the kill plane is not the only safety net.
    const hf = RAPIER.ColliderDesc.heightfield(terrain.nz - 1, terrain.nx - 1, heightfieldRows(terrain), { x: (terrain.nx - 1) * terrain.resolution, y: 1, z: (terrain.nz - 1) * terrain.resolution })
      .setTranslation(terrain.x0 + (terrain.nx - 1) * terrain.resolution / 2, -0.4, terrain.z0 + (terrain.nz - 1) * terrain.resolution / 2)
      .setFriction(0.9).setCollisionGroups(groups(GROUP.static, GROUP.all));
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const c = this.physics.createCollider(hf, body);
    this.staticHandles.add(c.handle);
  }

  static fromBytes(terrainBytes: Uint8Array, roads: RoadGraph, gameplay: GameplayBundle): StaticWorld {
    return new StaticWorld(parseTerrain(terrainBytes, { copy: false }), roads, gameplay);
  }

  groundHeight(x: number, z: number): number {
    return sampleTerrain(this.terrain, x, z);
  }

  addCell(cellId: string, bundleBytes: Uint8Array): CollisionBundle {
    if (this.cellColliders.has(cellId)) throw new Error(`collision cell ${cellId} is already resident`);
    const bundle = parseCollisionBundle(bundleBytes);
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const handles: number[] = [];
    for (const c of bundle.colliders) {
      if (c.indices.length === 0) continue;
      const flags = c.group === 'ground' ? RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES : undefined;
      const desc = RAPIER.ColliderDesc.trimesh(c.positions, c.indices, flags)
        .setFriction(c.group === 'ground' ? 1.0 : 0.6)
        .setCollisionGroups(groups(GROUP.static, GROUP.all));
      const collider = this.physics.createCollider(desc, body);
      // A copy, so a streamed cell does not keep its whole decoded bundle alive after Rapier copied the mesh.
      this.triangleTags.set(collider.handle, { tags: c.triangleTags.slice(), names: bundle.header.surfaceTags, group: c.group, ref: c.ref });
      this.staticHandles.add(collider.handle);
      handles.push(collider.handle);
    }
    this.cellColliders.set(cellId, handles);
    this.cellBodies.set(cellId, body);
    this.unsettled.add(cellId);
    return bundle;
  }

  /** Remove a resident cell's colliders (streaming residency). */
  removeCell(cellId: string): void {
    const body = this.cellBodies.get(cellId);
    if (!body) throw new Error(`collision cell ${cellId} is not resident`);
    for (const handle of this.cellColliders.get(cellId) ?? []) { this.triangleTags.delete(handle); this.staticHandles.delete(handle); }
    this.physics.removeRigidBody(body);
    this.cellColliders.delete(cellId);
    this.cellBodies.delete(cellId);
    this.unsettled.delete(cellId);
  }

  /**
   * Opt into collision streaming before any cell is added. Residency then follows the simulation (see
   * collision-residency.ts); `source` returns a cell's decoded HCOL bytes, or undefined while they are unavailable.
   */
  enableStreaming(cells: readonly CollisionCellRef[], source: (cellId: string) => Uint8Array | undefined): void {
    if (this.cellColliders.size) throw new Error('Collision streaming must be enabled before any cell is added');
    this.streaming = { residency: new CollisionResidency(cells, residencyPins(this.roads, this.gameplay)), source };
  }

  get streamed(): boolean { return this.streaming !== null; }

  /** Residency changes for these sources; the pinned destinations are always included. */
  planResidency(sources: readonly ResidencySource[], ahead?: number): ResidencyPlan {
    if (!this.streaming) return { insert: [], remove: [] };
    return this.streaming.residency.plan(sources, new Set(this.cellColliders.keys()), ahead);
  }

  /** Cells of a plan whose bytes are not available yet; the plan cannot be applied until this is empty. */
  unavailable(plan: ResidencyPlan): string[] {
    const source = this.streaming?.source;
    return source ? plan.insert.filter(id => !source(id)) : [];
  }

  applyResidency(plan: ResidencyPlan): void {
    const streaming = this.streaming;
    if (!streaming) return;
    const missing = this.unavailable(plan);
    if (missing.length) throw new Error(`Collision cells are not loaded: ${missing.join(', ')}`);
    for (const id of plan.remove) this.removeCell(id);
    for (const id of plan.insert) this.addCell(id, streaming.source(id)!);
  }

  /** Called after every physics step: every inserted cell is now visible to queries. */
  markStepped(): void { this.unsettled.clear(); }

  /** Whether queries at XZ see the complete static collision there (always, unless streaming). */
  queryable(x: number, z: number): boolean {
    if (!this.streaming) return true;
    return this.streaming.residency.cellsAt(x, z).every(c => this.cellColliders.has(c.id) && !this.unsettled.has(c.id));
  }

  residentCells(): string[] { return [...this.cellColliders.keys()]; }

  /** Streamed cells whose bounds contain or touch XZ. */
  cellsAt(x: number, z: number): string[] {
    return this.streaming ? this.streaming.residency.cellsAt(x, z).map(c => c.id) : [];
  }

  /** Surface info for a static collider hit; `featureId` is the triangle index when the query reports one. */
  surfaceAt(colliderHandle: number, triangle: number | null): SurfaceInfo | null {
    const info = this.triangleTags.get(colliderHandle);
    if (!info) return this.staticHandles.has(colliderHandle) ? { tag: 'terrain', group: 'terrain', ref: null } : null;
    const tag = triangle !== null && triangle >= 0 && triangle < info.tags.length ? info.names[info.tags[triangle]!] ?? info.group : info.group;
    return { tag, group: info.group, ref: info.ref };
  }

  isStatic(colliderHandle: number): boolean {
    return this.staticHandles.has(colliderHandle);
  }

  /** Ray cast downward from (x, y, z): returns the hit height or null. */
  groundBelow(x: number, y: number, z: number, maxDistance = 50, excludeBody?: RAPIER.RigidBody): { y: number; surface: SurfaceInfo | null } | null {
    const ray = new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 });
    const hit = this.physics.castRay(ray, maxDistance, true, undefined, groups(GROUP.bullet, GROUP.static), undefined, excludeBody);
    if (!hit) return null;
    const toi = (hit as unknown as { timeOfImpact?: number; toi?: number }).timeOfImpact ?? (hit as unknown as { toi: number }).toi;
    return { y: y - toi, surface: this.surfaceAt(hit.collider.handle, null) };
  }

  /** Extra normal-bearing query used only to qualify a spawn seam fallback. */
  spawnGroundBelow(x:number,y:number,z:number,maxDistance:number){
    const hit=this.physics.castRayAndGetNormal(new RAPIER.Ray({x,y,z},{x:0,y:-1,z:0}),maxDistance,true,undefined,groups(GROUP.bullet,GROUP.static));
    return hit?{y:y-hit.timeOfImpact,normalY:hit.normal.y,surface:this.surfaceAt(hit.collider.handle,hit.featureId??null)}:null;
  }
}

/**
 * Highest bundle surface at XZ between `y` and `y - maxDistance`, computed on the CPU. A streamed cell that was just
 * inserted is not visible to Rapier queries before the next physics step, so an out-of-band drop-in probes its bytes.
 */
export function groundBelowBundle(bundle: CollisionBundle, x: number, y: number, z: number, maxDistance: number): number | null {
  let best: number | null = null;
  for (const c of bundle.colliders) {
    const p = c.positions, idx = c.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * 3, b = idx[t + 1]! * 3, d = idx[t + 2]! * 3;
      const ax = p[a]!, az = p[a + 2]!, bx = p[b]!, bz = p[b + 2]!, cx = p[d]!, cz = p[d + 2]!;
      if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || z < Math.min(az, bz, cz) || z > Math.max(az, bz, cz)) continue;
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-12) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const w = 1 - u - v;
      if (u < -1e-7 || v < -1e-7 || w < -1e-7) continue;
      const h = u * p[a + 1]! + v * p[b + 1]! + w * p[d + 1]!;
      if (h <= y && h >= y - maxDistance && (best === null || h > best)) best = h;
    }
  }
  return best;
}

/** Rapier heightfields are column-major: heights[j * nrows + i] where i runs along +Z (rows) and j along +X. */
function heightfieldRows(t: TerrainGrid): Float32Array {
  const out = new Float32Array(t.nx * t.nz);
  for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) out[ix * t.nz + iz] = t.heights[iz * t.nx + ix]!;
  return out;
}
