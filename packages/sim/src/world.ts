// Static world: terrain, per-cell collision bundles and the road graph loaded into a Rapier world. The sim never
// sees visual geometry; every collider here comes from the baked HCOL bundles (plan section 2, three representations).
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import {
  parseCollisionBundle, parseTerrain, sampleTerrain, RoadIndex,
  type CollisionBundle, type GameplayBundle, type RoadGraph, type TerrainGrid,
} from '@helsinki/world-schema';
import { TICK_SECONDS } from './commands.ts';

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
    return new StaticWorld(parseTerrain(terrainBytes), roads, gameplay);
  }

  groundHeight(x: number, z: number): number {
    return sampleTerrain(this.terrain, x, z);
  }

  addCell(cellId: string, bundleBytes: Uint8Array): CollisionBundle {
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
      this.triangleTags.set(collider.handle, { tags: c.triangleTags, names: bundle.header.surfaceTags, group: c.group, ref: c.ref });
      this.staticHandles.add(collider.handle);
      handles.push(collider.handle);
    }
    this.cellColliders.set(cellId, handles);
    return bundle;
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
}

/** Rapier heightfields are column-major: heights[j * nrows + i] where i runs along +Z (rows) and j along +X. */
function heightfieldRows(t: TerrainGrid): Float32Array {
  const out = new Float32Array(t.nx * t.nz);
  for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) out[ix * t.nz + iz] = t.heights[iz * t.nx + ix]!;
  return out;
}
