// Fetch the published world release: manifest, terrain, roads, gameplay, instanced scenery, collision bundles, cell
// visuals and hero and scenery assets. Everything is content-addressed under /world/<release>/ (tools/world/publish_release.ts).
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { GameplayBundle, RoadGraph, SceneryDocument, WorldManifest } from '@helsinki/world-schema';
import { validateGameplayBundle, validateWorldManifest } from '@helsinki/world-schema';
import { basisDecoderUrl, runtimeDeployment, selectedRelease, validateManifestPaths, validateReleaseId, verifyManifestHash, worldReleaseUrl, worldRootUrl, type WorldDeployment } from './urls.ts';

export interface WorldData {
  readonly release: string;
  readonly base: string;
  readonly manifest: WorldManifest;
  readonly terrain: Uint8Array;
  readonly roads: RoadGraph;
  readonly gameplay: GameplayBundle;
  /** Null for releases published before instanced scenery (decision 0006). */
  readonly scenery: SceneryDocument | null;
  readonly collision: Map<string, Uint8Array>;
}

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
export async function loadWorldData(release: string, progress: Progress, deployment: WorldDeployment = runtimeDeployment()): Promise<WorldData> {
  const base = worldReleaseUrl(deployment, release);
  const manifestBytes = await fetchBytes(`${base}manifest.json`);
  await verifyManifestHash(manifestBytes, deployment.manifestSha256);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as WorldManifest;
  const problems = validateWorldManifest(manifest);
  if (problems.length) throw new Error(`manifest: ${problems.join('; ')}`);
  if (manifest.worldReleaseId !== release) throw new Error('World manifest release does not match the selected release');
  validateManifestPaths(manifest);
  const total = 3 + (manifest.scenery ? 1 : 0) + manifest.cells.length;
  let done = 0;
  const tick = (label: string) => progress(++done, total, label);
  const [terrain, roads, gameplay, scenery] = await Promise.all([
    fetchBytes(base + manifest.terrain.path).then(b => { tick('terrain'); return b; }),
    fetchJson<RoadGraph>(base + manifest.roads.path).then(r => { tick('roads'); return r; }),
    fetchJson<GameplayBundle>(base + manifest.gameplay.path).then(g => { tick('gameplay'); return g; }),
    manifest.scenery ? fetchJson<SceneryDocument>(base + manifest.scenery.path).then(s => { tick('scenery'); return s; }) : Promise.resolve(null),
  ]);
  const gp = validateGameplayBundle(gameplay);
  if (gp.length) throw new Error(`gameplay: ${gp.join('; ')}`);
  // Bound startup requests without changing simulation construction order or the collision payloads.
  const collisionBytes = new Array<Uint8Array>(manifest.cells.length);
  let nextCell = 0;
  let collisionFailed = false;
  await Promise.all(Array.from({ length: Math.min(6, manifest.cells.length) }, async () => {
    while (!collisionFailed) {
      const index = nextCell++;
      const cell = manifest.cells[index];
      if (!cell) return;
      try { collisionBytes[index] = await fetchBytes(base + cell.collision.path); tick(`collision ${cell.id}`); }
      catch (error) { collisionFailed = true; throw error; }
    }
  }));
  const collision = new Map(manifest.cells.map((cell, index) => [cell.id, collisionBytes[index]!]));
  return { release, base, manifest, terrain, roads, gameplay, scenery, collision };
}

export class GlbLoader {
  readonly loader: GLTFLoader;
  readonly ktx2: KTX2Loader;

  constructor(renderer: THREE.WebGLRenderer) {
    this.ktx2 = new KTX2Loader().setTranscoderPath(basisDecoderUrl(runtimeDeployment())).detectSupport(renderer);
    this.loader = new GLTFLoader().setKTX2Loader(this.ktx2).setMeshoptDecoder(MeshoptDecoder);
  }

  load(url: string): Promise<GLTF> {
    return new Promise((resolve, reject) => this.loader.load(url, resolve, undefined, reject));
  }

  dispose(): void { this.ktx2.dispose(); }
}
