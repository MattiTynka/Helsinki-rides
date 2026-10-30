// Hero assets: the two characters, the pistol and the two cars (contracts in content/assets). Loaded once from the
// release's assets list and cloned per entity. Scenery assets (trees) are kept whole for the instanced scenery.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import type { WorldManifest } from '@helsinki/world-schema';
import type { GlbLoader } from '../world/loader.ts';
import { parseCharacterProfile, type NativeCharacterProfile } from './native-locomotion.ts';
import { disposeCellResources } from './cell-resources.ts';

export interface CharacterAsset {
  readonly id: string;
  readonly scene: THREE.Object3D;
  readonly clips: Map<string, THREE.AnimationClip>;
  readonly height: number;
  readonly profile?: NativeCharacterProfile;
}

export interface VehicleAsset {
  readonly id: string;
  readonly scene: THREE.Object3D;
  readonly far: VehicleFarParts;
}

/** A car's distant level: merged accepted geometry, or an optional simplified low-preset asset. */
export interface VehicleFarParts {
  /** Opaque and glass parts merged, colour per vertex (base colour times one minus metalness: the diffuse share). */
  readonly body: THREE.BufferGeometry;
  /** Lamp parts merged per lamp material name, so headlights, brake lights and the light bar still show. */
  readonly lamps: Map<string, THREE.BufferGeometry>;
}

/** An asset about to be published, as its views will use it. */
export type PreparedAsset =
  | { readonly kind: 'character'; readonly asset: CharacterAsset }
  | { readonly kind: 'vehicle'; readonly asset: VehicleAsset }
  | { readonly kind: 'pistol'; readonly id: string };

/** Uploads and compiles what an asset's views draw before any view can exist; a rejection fails the asset's load. */
export type PrepareAsset = (root: THREE.Object3D, asset: PreparedAsset) => Promise<void>;

function disposeFarParts(far: VehicleFarParts): void {
  far.body.dispose();
  for (const geometry of far.lamps.values()) geometry.dispose();
}

export class AssetLibrary {
  readonly characters = new Map<string, CharacterAsset>();
  readonly vehicles = new Map<string, VehicleAsset>();
  pistol: THREE.Object3D | null = null;
  readonly scenery = new Map<string, THREE.Object3D>();
  /** Shared by every distant car; the car materials are flat colours and double-sided. */
  readonly farMaterial = new THREE.MeshStandardMaterial({ name: 'car_far', vertexColors: true, roughness: 0.5, metalness: 0, side: THREE.DoubleSide });

  private deferred: (() => Promise<void>) | null = null;
  private deferredLoad: Promise<void> | null = null;
  /** Assets loaded completely; a retried deferred load requests only the others. */
  private readonly loaded = new Set<string>();
  private concurrency = 2;
  private prepare: PrepareAsset | null = null;

  /**
   * Load the assets play starts with. Assets `startup` leaves out are loaded by `loadDeferred`; until then views
   * that need them are not created. A near car and its `-far-low` variant must be in the same set. `prepare` runs on
   * every character, car and the pistol before it is published; with `prefetch`, the left-out assets' bytes are
   * requested at once, at low priority, and parsed later by `loadDeferred`.
   */
  async load(loader: GlbLoader, base: string, manifest: WorldManifest, _lowPreset = false, startup: (asset: WorldManifest['assets'][number]) => boolean = () => true,
    options: { readonly concurrency?: number; readonly prepare?: PrepareAsset; readonly prefetch?: boolean } = {}): Promise<void> {
    this.concurrency = Math.max(1, Math.min(2, Math.floor(options.concurrency ?? 2) || 1));
    this.prepare = options.prepare ?? null;
    const later = manifest.assets.filter(a => !startup(a));
    if (options.prefetch) for (const a of later) loader.prefetch(base + a.path);
    this.deferred = later.length ? () => this.loadSet(loader, base, manifest, later.filter(a => !this.loaded.has(a.id))) : null;
    await this.loadSet(loader, base, manifest, manifest.assets.filter(startup));
  }

  /** Load the assets left out of startup. A failed load is not kept: the next call retries the assets still missing. */
  loadDeferred(): Promise<void> {
    this.deferredLoad ??= (this.deferred ? this.deferred() : Promise.resolve()).catch((error: unknown) => {
      this.deferredLoad = null;
      throw error;
    });
    return this.deferredLoad;
  }

  /**
   * An asset is published (and `hasCharacter`/`hasVehicle` report it) only after `prepare` resolves; a rejected
   * preparation is a failed load, so the asset stays absent and a retry loads it again. A near car and its `-far-low`
   * variant are one unit: the car is published once both have loaded, with its final far parts prepared, so no view
   * ever holds far geometry that is later replaced and disposed.
   */
  private async loadSet(loader: GlbLoader, base: string, manifest: WorldManifest, assets: WorldManifest['assets']): Promise<void> {
    const ids = new Set(assets.map(a => a.id));
    /** Near cars waiting for their distant variant, or the reverse, until both have loaded. */
    const pairs = new Map<string, { near?: THREE.Object3D; far?: THREE.Object3D }>();
    const ordered = [...assets].sort((a, b) => assetPriority(a.id) - assetPriority(b.id));
    let next = 0;
    const results: PromiseSettledResult<void>[] = [];
    const prepared = async (root: THREE.Object3D, asset: PreparedAsset): Promise<void> => {
      if (!this.prepare) return;
      try { await this.prepare(root, asset); } catch (error) { disposeCellResources(root); throw error; }
    };
    const publishPair = async (id: string): Promise<void> => {
      const pair = pairs.get(id)!;
      if (!pair.near || !pair.far) return;
      pairs.delete(id);
      // buildFarParts owns independent buffers, so the temporary GLB source can be released without retaining a
      // second set of distant geometry/materials.
      const far = buildFarParts(pair.far);
      disposeCellResources(pair.far);
      const vehicle: VehicleAsset = { id, scene: pair.near, far };
      try { await prepared(pair.near, { kind: 'vehicle', asset: vehicle }); } catch (error) { disposeFarParts(far); throw error; }
      this.vehicles.set(id, vehicle);
      this.loaded.add(id);
      this.loaded.add(`${id}-far-low`);
    };
    const loadAsset = async (a: WorldManifest['assets'][number]): Promise<void> => {
      const candidate = a.id.endsWith('-far-low') ? a.id.slice(0, -'-far-low'.length) : null;
      const lowFarVehicle = candidate && manifest.assets.some(asset => asset.kind === 'vehicle' && asset.id === candidate) ? candidate : null;
      const gltf = await loader.load(base + a.path);
      gltf.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.frustumCulled = true; } });
      if (lowFarVehicle) {
        if (!ids.has(lowFarVehicle)) { disposeCellResources(gltf.scene); throw new Error(`distant car ${lowFarVehicle} has no near asset`); }
        pairs.set(lowFarVehicle, { ...pairs.get(lowFarVehicle), far: gltf.scene });
        await publishPair(lowFarVehicle);
      } else if (a.kind === 'character') {
        // Bind-pose bounds do not follow native gait, aiming or collapse poses.
        gltf.scene.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) node.frustumCulled = false; });
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const clips = new Map(gltf.animations.map(c => [c.name, c]));
        const profile = parseCharacterProfile(gltf.scene.userData.characterProfile, new Set(clips.keys()));
        const character: CharacterAsset = { id: a.id, scene: gltf.scene, clips, height: box.max.y - box.min.y, ...(profile ? { profile } : {}) };
        await prepared(gltf.scene, { kind: 'character', asset: character });
        this.characters.set(a.id, character);
        this.loaded.add(a.id);
      } else if (a.kind === 'vehicle') {
        gltf.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { const mats = Array.isArray(m.material) ? m.material : [m.material]; for (const mat of mats) { const s = mat as THREE.MeshStandardMaterial; if (s.name === 'car_glass') { s.depthWrite = false; } } } });
        splitWindshield(gltf.scene);
        if (ids.has(`${a.id}-far-low`)) {
          pairs.set(a.id, { ...pairs.get(a.id), near: gltf.scene });
          await publishPair(a.id);
          return;
        }
        const far = buildFarParts(gltf.scene);
        const vehicle: VehicleAsset = { id: a.id, scene: gltf.scene, far };
        try { await prepared(gltf.scene, { kind: 'vehicle', asset: vehicle }); } catch (error) { disposeFarParts(far); throw error; }
        this.vehicles.set(a.id, vehicle);
        this.loaded.add(a.id);
      } else if (a.kind === 'scenery') {
        this.scenery.set(a.id, gltf.scene);
        this.loaded.add(a.id);
      } else if (a.id === 'prop-pistol') {
        await prepared(gltf.scene, { kind: 'pistol', id: a.id });
        this.pistol = gltf.scene;
        this.loaded.add(a.id);
      } else {
        this.loaded.add(a.id);
      }
    };
    // Limit GLB parsing, far-mesh conversion, texture allocation and preparation together. Police precede optional civilians.
    await Promise.all(Array.from({ length: Math.min(this.concurrency, ordered.length) }, async () => {
      while (next < ordered.length) {
        const asset = ordered[next++]!;
        try { await loadAsset(asset); results.push({ status: 'fulfilled', value: undefined }); }
        catch (reason) { results.push({ status: 'rejected', reason }); }
      }
    }));
    // A car whose partner failed is not published; both halves are released and a retry loads the pair again.
    for (const pair of pairs.values()) {
      if (pair.near) disposeCellResources(pair.near);
      if (pair.far) disposeCellResources(pair.far);
    }
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  }

  hasCharacter(id: string): boolean { return this.characters.has(id); }
  hasVehicle(id: string): boolean { return this.vehicles.has(id); }

  cloneCharacter(id: string): { root: THREE.Object3D; asset: CharacterAsset } {
    const asset = this.characters.get(id);
    if (!asset) throw new Error(`character asset ${id} missing`);
    const root = skeletonClone(asset.scene);
    return { root, asset };
  }

  cloneVehicle(id: string): THREE.Object3D {
    const asset = this.vehicles.get(id);
    if (!asset) throw new Error(`vehicle asset ${id} missing`);
    const root = asset.scene.clone(true);
    // Lamp materials are driven per instance (headlights, light bar), so give each clone its own copies.
    root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (Array.isArray(m.material)) m.material = m.material.map(x => x.name.startsWith('car_lamp') ? x.clone() : x);
      else if (m.material.name.startsWith('car_lamp')) m.material = m.material.clone();
    });
    return root;
  }

  clonePistol(): THREE.Object3D | null {
    return this.pistol ? this.pistol.clone(true) : null;
  }
}

function assetPriority(id: string): number {
  if (id === 'character-snow') return 0;
  if (id === 'prop-pistol') return 1;
  if (id === 'character-rain') return 2;
  if (id.startsWith('vehicle-patrol')) return 3;
  if (id.startsWith('vehicle-lumi')) return 4;
  if (id.startsWith('vehicle-')) return 5;
  if (id.startsWith('character-civilian-')) return 7;
  return 6;
}

/**
 * The windshield is part of the merged CAR_GLASS mesh; split it into its own WINDSHIELD mesh by position and facing so
 * a car whose windshield was kicked out can hide it. The far level keeps it. Cars built with their own WINDSHIELD
 * node are left as they are.
 */
function splitWindshield(scene: THREE.Object3D): void {
  if (scene.getObjectByName('WINDSHIELD')) return;
  const glass = scene.getObjectByName('CAR_GLASS') as THREE.Mesh | undefined;
  if (!glass?.isMesh || !glass.geometry.index) return;
  const g = glass.geometry, pos = g.attributes.position!, index = g.index!, keep: number[] = [], cut: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), centre = new THREE.Vector3();
  for (let i = 0; i + 2 < index.count; i += 3) {
    a.fromBufferAttribute(pos, index.getX(i)); b.fromBufferAttribute(pos, index.getX(i + 1)); c.fromBufferAttribute(pos, index.getX(i + 2));
    centre.copy(a).add(b).add(c).divideScalar(3);
    n.subVectors(c, b).cross(a.sub(b)).normalize();
    const windshield = centre.z > -0.15 && centre.z < 0.9 && centre.y > 0.9 && Math.abs(n.z) > 0.25;
    (windshield ? cut : keep).push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  }
  if (cut.length === 0) return;
  const rest = g.clone(); rest.setIndex(keep); glass.geometry = rest;
  const part = g.clone(); part.setIndex(cut);
  const mesh = new THREE.Mesh(part, glass.material);
  mesh.name = 'WINDSHIELD';
  mesh.position.copy(glass.position); mesh.quaternion.copy(glass.quaternion); mesh.scale.copy(glass.scale);
  glass.parent!.add(mesh);
  g.dispose();
}

// Hidden behind dark glass at a distance, so the far level leaves them out.
const FAR_SKIP_MATERIALS = new Set(['car_interior']);
const FAR_SKIP_NODES = new Set(['STEERING_WHEEL']);

function buildFarParts(scene: THREE.Object3D): VehicleFarParts {
  scene.updateMatrixWorld(true);
  const toRoot = scene.matrixWorld.clone().invert();
  type Part = { positions: number[]; normals: number[]; colors: number[] };
  const body: Part = { positions: [], normals: [], colors: [] };
  const lamps = new Map<string, Part>();
  const m4 = new THREE.Matrix4();
  const n3 = new THREE.Matrix3();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  scene.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (let a: THREE.Object3D | null = mesh; a; a = a.parent) if (FAR_SKIP_NODES.has(a.name)) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (FAR_SKIP_MATERIALS.has(mat.name)) return;
    let part = body;
    if (mat.name.startsWith('car_lamp')) {
      part = lamps.get(mat.name) ?? { positions: [], normals: [], colors: [] };
      lamps.set(mat.name, part);
    }
    const geo = mesh.geometry;
    const pos = geo.attributes.position!;
    const nor = geo.attributes.normal;
    m4.multiplyMatrices(toRoot, mesh.matrixWorld);
    n3.getNormalMatrix(m4);
    const order = m4.determinant() < 0 ? [0, 2, 1] : [0, 1, 2];
    const k = 1 - (mat.metalness ?? 0);
    const count = geo.index ? geo.index.count : pos.count;
    for (let t = 0; t + 2 < count; t += 3) {
      for (const c of order) {
        const v = geo.index ? geo.index.getX(t + c) : t + c;
        p.fromBufferAttribute(pos, v).applyMatrix4(m4);
        part.positions.push(p.x, p.y, p.z);
        if (nor) n.fromBufferAttribute(nor, v).applyMatrix3(n3).normalize(); else n.set(0, 1, 0);
        part.normals.push(n.x, n.y, n.z);
        part.colors.push(mat.color.r * k, mat.color.g * k, mat.color.b * k);
      }
    }
  });
  const geometry = (q: Part, withColour: boolean): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(q.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(q.normals, 3));
    if (withColour) g.setAttribute('color', new THREE.Float32BufferAttribute(q.colors, 3));
    g.computeBoundingSphere();
    return g;
  };
  return { body: geometry(body, true), lamps: new Map([...lamps].map(([name, q]) => [name, geometry(q, false)])) };
}
