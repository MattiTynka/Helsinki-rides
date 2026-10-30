// Live city visuals (docs/live-kartta-cells-plan-2026-10-30.md, section 5): the 128 m squares the release lacks, built
// in the browser from the City of Helsinki's textured LoD2 tiles and the live ground payload. A detail stream (tile
// error 2.5 m, 5 m on Low) and a fallback stream (10 m, 20 m on Low) select from a window of live squares near the
// focus, and every view takes the release cells' path through CityScene: material adaptation, budgeted upload and
// compile, show and dispose. The game's missing-coverage check reads the manifest only, so live squares never hold
// a frame back.
import * as THREE from 'three';
import type { CellDescriptor, TerrainGrid, VisualLod } from '@helsinki/world-schema';
import { LIVE_CELL_SIZE, type LiveGrid } from '@helsinki/sim';
import type { CellView, CityScene } from '../../render/scene.ts';
import type { StreamRange } from '../../render/quality-tiers.ts';
import { geometryBytesOf, textureGpuBytes } from '../../render/cell-resources.ts';
import { CellVisualStream, type CellStreamBackend, type CellStreamStats, type StreamFocus } from '../cell-streaming.ts';
import type { GlbLoader } from '../loader.ts';
import type { LiveBuildingPart, LiveGroundVisual, LiveSurface, LiveTextureBytes } from './contract.ts';
import { edgeOverrides, type LiveCellSource } from './live-source.ts';
import { LiveTextures, type LiveTextureLease } from './live-textures.ts';

export interface LiveVisualOptions {
  readonly scene: CityScene;
  readonly loader: GlbLoader;
  readonly grid: LiveGrid;
  readonly source: LiveCellSource;
  readonly terrain: TerrainGrid;
  readonly low: boolean;
  readonly mobile: boolean;
  /** The tier's ranges (quality-tiers TierParameters). */
  readonly detail: StreamRange;
  readonly fallback: StreamRange;
  readonly detailTextureBudgetBytes: number;
  readonly fallbackTextureBudgetBytes: number;
}

const MiB = 2 ** 20;
/** The window holds live squares within the fallback radius plus this margin and moves after the focus travels STEP. */
const WINDOW_MARGIN = 256, WINDOW_STEP = 128;

/** Ground paint per register class (sRGB): asphalt, paving slabs, lawn, gravel yard. */
const GROUND_COLOURS: Readonly<Record<LiveSurface, number>> = { road: 0x56585b, walk: 0x9b968d, green: 0x5e7b3f, yard: 0x8b8173 };

/** Selection estimates before a square's real costs are known (the stream then uses measured costs). */
const estimate = (textureBytesEstimate: number): VisualLod => ({ path: '', bytes: 0, sha256: '', triangles: 4000, drawCalls: 6, atlases: 0, textureBytesEstimate });
const LIVE_VISUAL: CellDescriptor['visual'] = { lod0: estimate(4 * MiB), lod1: estimate(4 * MiB), lod2: estimate(MiB) };

function liveDescriptor(id: string, cx: number, cz: number): CellDescriptor {
  const x0 = cx * LIVE_CELL_SIZE, z0 = cz * LIVE_CELL_SIZE;
  // Only the visual streams read this: live collision comes from LiveCellSource, never from this placeholder file ref.
  const collision = { path: '', bytes: 0, sha256: '', triangles: 0 } as unknown as CellDescriptor['collision'];
  return { id, cx, cz, boundsXZ: [x0, z0, x0 + LIVE_CELL_SIZE, z0 + LIVE_CELL_SIZE], visual: LIVE_VISUAL, collision, buildingIds: [], buildings: [], sourceTiles: [] };
}

// Source materials, built as GLTFLoader builds the release cells' materials so CityScene.adoptCellGroup adapts them
// identically (tools/world/build_cells.ts, tools/world/lib/gltf.ts).

/** Release facade atlases: white base colour, roughness 0.95, and `bakedLighting` because the images are the flight's photos. */
function facadeMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0 });
  material.name = 'live_facades';
  material.userData['bakedLighting'] = true;
  return material;
}

/** Untextured LoD2 parts keep the tile's own base colour factor (linear). */
function flatMaterial(color: readonly [number, number, number]): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  material.color.setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace);
  material.name = 'live_flat';
  return material;
}

function groundMaterial(surface: LiveSurface): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: GROUND_COLOURS[surface], roughness: 1, metalness: 0 });
  material.name = `live_ground_${surface}`;
  return material;
}

/** The release cells' `coastal_water` material; it is per GLB, so live squares build an equal one. */
function waterMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.15 });
  material.color.setRGB(0.07, 0.18, 0.23, THREE.LinearSRGBColorSpace);
  material.name = 'coastal_water';
  return material;
}

/** The array itself when it spans its buffer; geometryBytesOf counts whole buffers, so a view into a larger one is copied. */
function own(array: Float32Array): Float32Array {
  return array.byteOffset === 0 && array.byteLength === array.buffer.byteLength ? array : array.slice();
}

function indexArray(count: number, vertices: number): Uint16Array | Uint32Array {
  return vertices <= 0x10000 ? new Uint16Array(count) : new Uint32Array(count);
}

interface GroundArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly index: Uint16Array | Uint32Array;
  readonly groups: readonly { readonly start: number; readonly count: number; readonly surface: LiveSurface }[];
  readonly water: { readonly positions: Float32Array; readonly normals: Float32Array; readonly index: Uint16Array | Uint32Array } | null;
}

/** Per ground payload, shared by the detail and fallback views (each still gets its own geometry and GPU buffers). */
const groundArrays = new WeakMap<LiveGroundVisual, GroundArrays>();

function groundArraysOf(ground: LiveGroundVisual): GroundArrays {
  const cached = groundArrays.get(ground);
  if (cached) return cached;
  // No-data lattice points have NaN heights and belong to no class; a finite stand-in keeps the bounding sphere valid.
  const positions = Float32Array.from(ground.positions);
  let floor = Infinity;
  for (let i = 1; i < positions.length; i += 3) if (positions[i]! < floor) floor = positions[i]!;
  if (!Number.isFinite(floor)) floor = 0;
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i]!)) positions[i] = i % 3 === 1 ? floor : 0;
  const vertices = positions.length / 3;
  const index = indexArray(ground.classes.reduce((sum, c) => sum + c.indices.length, 0), vertices);
  const groups: { start: number; count: number; surface: LiveSurface }[] = [];
  let start = 0;
  for (const { surface, indices } of ground.classes) {
    if (!indices.length) continue;
    index.set(indices, start);
    groups.push({ start, count: indices.length, surface });
    start += indices.length;
  }
  let water: GroundArrays['water'] = null;
  if (ground.water && ground.water.indices.length) {
    const waterPositions = own(ground.water.positions), normals = new Float32Array(waterPositions.length);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    const waterIndex = indexArray(ground.water.indices.length, waterPositions.length / 3);
    waterIndex.set(ground.water.indices);
    water = { positions: waterPositions, normals, index: waterIndex };
  }
  const arrays: GroundArrays = { positions, normals: own(ground.normals), index, groups, water };
  groundArrays.set(ground, arrays);
  return arrays;
}

/** One multi-material terrain mesh (a draw group per surface class) and the flat sea quads. */
function groundMeshes(id: string, ground: LiveGroundVisual): THREE.Mesh[] {
  const arrays = groundArraysOf(ground), meshes: THREE.Mesh[] = [];
  if (arrays.groups.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(arrays.index, 1));
    const surfaces: LiveSurface[] = [];
    for (const group of arrays.groups) {
      let slot = surfaces.indexOf(group.surface);
      if (slot < 0) { slot = surfaces.length; surfaces.push(group.surface); }
      geometry.addGroup(group.start, group.count, slot);
    }
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, surfaces.map(groundMaterial));
    mesh.name = `${id}_ground`;
    meshes.push(mesh);
  }
  if (arrays.water) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arrays.water.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.water.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(arrays.water.index, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, waterMaterial());
    mesh.name = `${id}_water`;
    meshes.push(mesh);
  }
  return meshes;
}

/**
 * One mesh per building part. Parts reach up to about 38 m past their square (centroid ownership), so culling uses
 * each part's own bounding sphere. Parts that share a texture or a colour share one source material.
 */
function buildingMeshes(id: string, parts: readonly LiveBuildingPart[], maps: ReadonlyMap<string, THREE.Texture>): THREE.Mesh[] {
  const textured = new Map<THREE.Texture, THREE.Material>(), flat = new Map<string, THREE.Material>(), meshes: THREE.Mesh[] = [];
  parts.forEach((part, i) => {
    const vertices = part.positions.length / 3;
    if (!vertices || part.positions.length % 9) return;
    const uvs = part.uvs && part.uvs.length === vertices * 2 ? part.uvs : null;
    const map = uvs && part.texture !== null ? maps.get(part.texture) : undefined;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(own(part.positions), 3));
    if (part.normals.length === part.positions.length) geometry.setAttribute('normal', new THREE.BufferAttribute(own(part.normals), 3));
    else geometry.computeVertexNormals();
    if (map && uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(own(uvs), 2));
    geometry.computeBoundingSphere();
    let material: THREE.Material;
    if (map) {
      const known = textured.get(map);
      material = known ?? facadeMaterial(map);
      if (!known) textured.set(map, material);
    } else {
      const key = part.color.join(','), known = flat.get(key);
      material = known ?? flatMaterial(part.color);
      if (!known) flat.set(key, material);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${id}_${map ? 'facades' : 'flat'}_${i}`;
    meshes.push(mesh);
  });
  return meshes;
}

export class LiveVisuals {
  private readonly scene: CityScene;
  private readonly grid: LiveGrid;
  private readonly source: LiveCellSource;
  private readonly terrain: TerrainGrid;
  private readonly textures: LiveTextures;
  private readonly detail: CellVisualStream<CellView>;
  private readonly fallback: CellVisualStream<CellView>;
  /** Texture leases of every built view, released with it. */
  private readonly leases = new Map<CellView, readonly LiveTextureLease[]>();
  /** One descriptor object per square while it stays in the window, so residency and cost caches stay keyed alike. */
  private descriptors = new Map<string, CellDescriptor>();
  private fallbackRadius: number;
  private window: { readonly x: number; readonly z: number } | null = null;
  private focus: StreamFocus | null = null;
  /** Adapted warm-up materials stay alive: disposing the last holder of a program would release it. */
  private warm: { readonly materials: readonly THREE.Material[]; readonly texture: THREE.Texture } | null = null;
  private disposed = false;

  constructor(options: LiveVisualOptions) {
    this.scene = options.scene;
    this.grid = options.grid;
    this.source = options.source;
    this.terrain = options.terrain;
    this.textures = new LiveTextures(options.loader.ktx2);
    this.fallbackRadius = options.fallback.radius;
    const concurrency = options.mobile ? 1 : 2;
    this.detail = new CellVisualStream<CellView>([], this.backend(options.low ? 5 : 2.5, 'lod0'), {
      textureBudgetBytes: options.detailTextureBudgetBytes, geometryBudgetBytes: options.detail.geometryBudgetMiB * MiB,
      radius: options.detail.radius, maxCells: options.detail.maxCells, lookaheadSeconds: 3, maxLookahead: 180, concurrency, level: 'lod0',
    });
    this.fallback = new CellVisualStream<CellView>([], this.backend(options.low ? 20 : 10, 'lod2'), {
      textureBudgetBytes: options.fallbackTextureBudgetBytes, geometryBudgetBytes: options.fallback.geometryBudgetMiB * MiB,
      radius: options.fallback.radius, maxCells: options.fallback.maxCells, lookaheadSeconds: 3, maxLookahead: 180, concurrency, level: 'lod2',
    });
  }

  /** Every frame, with the focus the release streams get. */
  update(focus: StreamFocus): void {
    if (this.disposed || ![focus.x, focus.z, focus.velocityX, focus.velocityZ].every(Number.isFinite)) return;
    this.focus = focus;
    // The streams take the new focus first, so a window change never reselects around a stale one.
    this.fallback.update(focus);
    this.detail.update(focus);
    if (!this.window || Math.hypot(focus.x - this.window.x, focus.z - this.window.z) > WINDOW_STEP) this.rebuildWindow(focus.x, focus.z);
  }

  /** A detail-tier change: both streams' ranges and budgets, and the window's reach. */
  setRanges(detail: StreamRange, fallback: StreamRange): void {
    if (this.disposed) return;
    this.fallbackRadius = fallback.radius;
    this.detail.setOptions({ radius: detail.radius, maxCells: detail.maxCells, geometryBudgetBytes: detail.geometryBudgetMiB * MiB });
    this.fallback.setOptions({ radius: fallback.radius, maxCells: fallback.maxCells, geometryBudgetBytes: fallback.geometryBudgetMiB * MiB });
    if (this.focus) this.rebuildWindow(this.focus.x, this.focus.z);
  }

  /**
   * Before Play: one stand-in mesh per live material variant (each ground class, water, a textured facade, a flat
   * part), adapted through CityScene.adoptCellGroup with the current lighting and material class, then uploaded and
   * compiled by CityScene.prepareObject. A live view's own preparation then links nothing new. The geometry goes; the
   * adapted materials and their small texture are kept for the session so their programs stay linked.
   */
  async prepareWarmup(): Promise<void> {
    if (this.disposed || this.warm) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0]), 2));
    // Programs depend on whether a map is present, not on its format, so a small sRGB image stands in for a transcoded tile.
    const texture = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const group = new THREE.Group();
    const sources = [...(Object.keys(GROUND_COLOURS) as LiveSurface[]).map(groundMaterial), waterMaterial(), facadeMaterial(texture), flatMaterial([0.6, 0.6, 0.6])];
    for (const material of sources) group.add(new THREE.Mesh(geometry, material));
    this.scene.adoptCellGroup(group, 'lod0');
    const materials = new Set<THREE.Material>();
    group.traverse(node => { const mesh = node as THREE.Mesh; if (mesh.isMesh) materials.add(mesh.material as THREE.Material); });
    try { await this.scene.prepareObject(group); }
    catch (error) {
      for (const material of materials) material.dispose();
      texture.dispose();
      throw error;
    } finally {
      group.clear();
      geometry.dispose();
    }
    if (this.disposed) {
      for (const material of materials) material.dispose();
      texture.dispose();
      return;
    }
    this.warm = { materials: [...materials], texture };
  }

  /** Whether any live square lies in the current window (its streams then need their texture budgets). */
  get near(): boolean { return this.descriptors.size > 0; }

  stats(): { detail: CellStreamStats; fallback: CellStreamStats } {
    return { detail: this.detail.stats(), fallback: this.fallback.stats() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detail.dispose();
    this.fallback.dispose();
    // Views of loads still settling release their leases later; those become no-ops.
    this.textures.dispose();
    if (this.warm) {
      for (const material of this.warm.materials) material.dispose();
      this.warm.texture.dispose();
      this.warm = null;
    }
  }

  /** Live squares within the fallback radius plus the margin of (x, z); squares leaving the window are evicted. */
  private rebuildWindow(x: number, z: number): void {
    const reach = this.fallbackRadius + WINDOW_MARGIN, size = LIVE_CELL_SIZE;
    const cells: CellDescriptor[] = [], kept = new Map<string, CellDescriptor>();
    const cz1 = Math.floor((z + reach) / size), cx1 = Math.floor((x + reach) / size);
    for (let cz = Math.floor((z - reach) / size); cz <= cz1; cz++) for (let cx = Math.floor((x - reach) / size); cx <= cx1; cx++) {
      if (!this.grid.isLive(cx, cz)) continue;
      const x0 = cx * size, z0 = cz * size;
      if (Math.hypot(Math.max(x0 - x, 0, x - x0 - size), Math.max(z0 - z, 0, z - z0 - size)) > reach) continue;
      const id = this.grid.id(cx, cz);
      const descriptor = this.descriptors.get(id) ?? liveDescriptor(id, cx, cz);
      kept.set(id, descriptor);
      cells.push(descriptor);
    }
    this.descriptors = kept;
    this.window = { x, z };
    this.fallback.setCells(cells);
    this.detail.setCells(cells);
  }

  private backend(maxGeometricError: number, lod: 'lod0' | 'lod2'): CellStreamBackend<CellView> {
    return {
      load: (cell, signal) => this.build(cell, maxGeometricError, lod, signal),
      prepare: (_cell, view, signal) => this.scene.prepareCell(view, signal),
      show: (_cell, view) => this.scene.showCell(view),
      dispose: (_cell, view) => {
        try { this.scene.disposeCell(view); }
        finally {
          for (const lease of this.leases.get(view) ?? []) lease.release();
          this.leases.delete(view);
        }
      },
    };
  }

  /**
   * Ground (the collision payload's mesh, built first if the collision stream has not asked for it yet) plus the
   * LoD2 parts at this stream's tile error. Texture cost is each image's device bytes times this square's share of it.
   */
  private async build(cell: CellDescriptor, maxGeometricError: number, lod: 'lod0' | 'lod2', signal: AbortSignal): Promise<CellView> {
    const square = this.grid.parse(cell.id);
    if (!square) throw new Error(`${cell.id} is not a live square`);
    const [cx, cz] = square;
    const ground = this.source.ground(cell.id) ?? (await this.source.collision(cx, cz, edgeOverrides(this.grid, this.terrain, cx, cz), signal, true)).ground;
    signal.throwIfAborted();
    const result = await this.source.visual(cx, cz, maxGeometricError, signal);
    signal.throwIfAborted();
    const used = new Set<string>();
    for (const part of result.parts) if (part.texture !== null) used.add(part.texture);
    const images = new Map<string, { image: LiveTextureBytes; share: number }>();
    for (const image of result.textures) {
      if (!used.has(image.key)) continue;
      const share = Number.isFinite(image.share) ? Math.max(0, image.share) : 1;
      const known = images.get(image.key);
      if (known) known.share = Math.min(1, known.share + share);
      else images.set(image.key, { image, share: Math.min(1, share) });
    }
    const entries = [...images.values()];
    const leases = entries.map(({ image }) => this.textures.acquire(image));
    try {
      const loaded = await Promise.all(leases.map(lease => lease.texture));
      signal.throwIfAborted();
      const maps = new Map<string, THREE.Texture>();
      let textureBytes = 0;
      entries.forEach(({ image, share }, i) => {
        const texture = loaded[i]!;
        maps.set(image.key, texture);
        textureBytes += textureGpuBytes(texture) * share;
      });
      const group = new THREE.Group();
      group.name = `live:${cell.id}:${lod}`;
      if (ground) for (const mesh of groundMeshes(cell.id, ground)) group.add(mesh);
      for (const mesh of buildingMeshes(cell.id, result.parts, maps)) group.add(mesh);
      const triangles = this.scene.adoptCellGroup(group, lod);
      const view: CellView = { id: cell.id, group, descriptor: cell, lod, triangles, textureBytes, geometryBytes: geometryBytesOf(group) };
      this.leases.set(view, leases);
      return view;
    } catch (error) {
      for (const lease of leases) lease.release();
      throw error;
    }
  }
}
