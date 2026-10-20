// Fetch the published world release: manifest, terrain, roads, gameplay, instanced scenery, collision bundles, cell
// visuals and hero and scenery assets. Everything is content-addressed under /world/<release>/ (tools/world/publish_release.ts).
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { GameplayBundle, RoadGraph, SceneryDocument, WorldManifest } from '@helsinki/world-schema';
import { RoadIndex, validateGameplayBundle, validateWorldManifest } from '@helsinki/world-schema';
import { collisionCellRefs, initialCollisionCells, type CollisionCellRef } from '@helsinki/sim';
import { basisDecoderUrl, runtimeDeployment, selectedRelease, validateManifestPaths, validateReleaseId, verifyManifestHash, worldReleaseUrl, worldRootUrl, type WorldDeployment } from './urls.ts';
import { fetchSimulationPayload } from './payload.ts';
import { OwnedKtx2Loader } from './owned-ktx2-loader.ts';
import { requestSlots } from './startup-queue.ts';

export interface WorldData {
  readonly release: string;
  readonly base: string;
  readonly manifest: WorldManifest;
  readonly terrain: Uint8Array;
  readonly roads: RoadGraph;
  readonly gameplay: GameplayBundle;
  /** Null for releases published before instanced scenery (decision 0006). */
  readonly scenery: SceneryDocument | null;
  /** Decoded collision bundles loaded at startup: the start's streamed residency, or every cell. */
  readonly collision: Map<string, Uint8Array>;
  readonly collisionMode: CollisionMode;
  /** Streamed: each cell's collision extent, which residency and prefetching measure; null when every cell loads. */
  readonly collisionCells: readonly CollisionCellRef[] | null;
}

/**
 * 'streamed': the simulation inserts collision cells as it moves (decision 0022); 'all': every cell at startup. A world
 * whose manifest does not record collision extents always loads every cell.
 */
export type CollisionMode = 'streamed' | 'all';

export type Progress = (done: number, total: number, label: string) => void;

export async function resolveRelease(requested: string | null, deployment = runtimeDeployment()): Promise<string> {
  if (deployment.pages && !deployment.release) {
    throw new Error('City assets are not configured. The maintainer must set VITE_WORLD_BASE_URL, VITE_WORLD_RELEASE and VITE_WORLD_MANIFEST_SHA256, then rebuild this Pages site.');
  }
  const release = selectedRelease(deployment, requested);
  if (release) return release;
  const r = await fetch(`${worldRootUrl(deployment)}current.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('no world release published: run pnpm world:release');
  const j = await r.json() as { release?: unknown };
  return validateReleaseId(j?.release);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

/** Load the data the simulation needs (no GPU work). */
export async function loadWorldData(release: string, progress: Progress, deployment: WorldDeployment = runtimeDeployment(), onManifest?: (manifest: WorldManifest, base: string) => void, collisionMode: CollisionMode = 'streamed'): Promise<WorldData> {
  mark('helsinki:manifest-start');
  const base = worldReleaseUrl(deployment, release);
  const manifestBytes = await fetchBytes(`${base}manifest.json`);
  await verifyManifestHash(manifestBytes, deployment.manifestSha256);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as WorldManifest;
  const problems = validateWorldManifest(manifest);
  if (problems.length) throw new Error(`manifest: ${problems.join('; ')}`);
  if (manifest.worldReleaseId !== release) throw new Error('World manifest release does not match the selected release');
  validateManifestPaths(manifest);
  mark('helsinki:manifest-ready');
  onManifest?.(manifest, base);
  let total = 3 + (manifest.scenery ? 1 : 0);
  let done = 0;
  const tick = (label: string) => progress(++done, total, label);
  // One six-request ceiling shared by terrain, JSON and collision. The start's collision cells follow the
  // road graph and gameplay (they decide the patrol spawns), overlapping the larger terrain download.
  const limit = requestSlots(6);
  const terrainJob = limit(() => fetchSimulationPayload(base + manifest.terrain.path, manifest.terrain)).then(bytes => { tick('terrain'); return bytes; });
  const roadsJob = limit(() => fetchJson<RoadGraph>(base + manifest.roads.path)).then(graph => { tick('roads'); return graph; });
  const gameplayJob = limit(() => fetchJson<GameplayBundle>(base + manifest.gameplay.path)).then(bundle => {
    const gp = validateGameplayBundle(bundle);
    if (gp.length) throw new Error(`gameplay: ${gp.join('; ')}`);
    tick('gameplay');
    return bundle;
  });
  const sceneryRef = manifest.scenery;
  const sceneryJob = sceneryRef ? limit(() => fetchJson<SceneryDocument>(base + sceneryRef.path)).then(doc => { tick('scenery'); return doc; }) : Promise.resolve(null);
  const collision = new Map<string, Uint8Array>();
  const collisionCells = collisionMode === 'streamed' ? collisionCellRefs(manifest.cells) : null;
  const collisionJob = Promise.all([roadsJob, gameplayJob]).then(async ([roads, gameplay]) => {
    const ids = collisionCells ? initialCollisionCells(collisionCells, new RoadIndex(roads), gameplay) : manifest.cells.map(c => c.id);
    const cells = new Map(manifest.cells.map(c => [c.id, c]));
    total += ids.length;
    const loaded = await Promise.all(ids.map(id => limit(() => fetchSimulationPayload(base + cells.get(id)!.collision.path, cells.get(id)!.collision)).then(bytes => {
      tick(`collision ${id}`);
      return bytes;
    })));
    // Request order, not completion order: manifest order when every cell loads.
    ids.forEach((id, i) => collision.set(id, loaded[i]!));
  });
  try {
    const [terrain, roads, gameplay, scenery] = await Promise.all([terrainJob, roadsJob, gameplayJob, sceneryJob, collisionJob]);
    mark('helsinki:world-data-ready');
    return { release, base, manifest, terrain, roads, gameplay, scenery, collision, collisionMode: collisionCells ? 'streamed' : 'all', collisionCells };
  } finally { limit.close(); }
}

/** Startup timing marks for the release smoke test (Performance API; no effect on play). */
export function mark(name: string): void {
  try { performance.mark(name); } catch { /* marks are diagnostics only */ }
}

export class GlbLoader {
  readonly loader: GLTFLoader;
  readonly ktx2: OwnedKtx2Loader;
  private readonly manager = new THREE.LoadingManager();

  constructor(renderer: THREE.WebGLRenderer) {
    this.ktx2 = new OwnedKtx2Loader(this.manager).setTranscoderPath(basisDecoderUrl(runtimeDeployment())).detectSupport(renderer);
    this.loader = new GLTFLoader().setKTX2Loader(this.ktx2).setMeshoptDecoder(MeshoptDecoder);
  }

  /**
   * Low preset: request each shared texture's half-resolution copy (manifest `sharedTexturesM1`) instead of the
   * original. Its mip levels are the original's levels below the top one, so only the sharpest level is missing.
   */
  useReducedTextures(manifest: WorldManifest): void {
    const reduced = new Map((manifest.sharedTexturesM1 ?? []).map(ref => [ref.source, ref.path]));
    if (!reduced.size) return;
    this.manager.setURLModifier(url => {
      const match = /(^|\/)(textures\/[0-9a-f]{64}\.ktx2)$/.exec(url);
      const target = match ? reduced.get(match[2]!) : undefined;
      return target ? url.slice(0, match!.index + match![1]!.length) + target : url;
    });
  }

  async load(url: string, signal?: AbortSignal): Promise<GLTF> {
    if (signal) {
      // Fetch directly so leaving a district cancels the GLB. Shared images use immutable same-origin
      // paths; parsing/transcoding retains its slot until completion and late results are disposed.
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      return this.loader.parseAsync(bytes, THREE.LoaderUtils.extractUrlBase(url));
    }
    return new Promise((resolve, reject) => this.loader.load(url, resolve, undefined, reject));
  }

  dispose(): void { this.ktx2.dispose(); }
}
