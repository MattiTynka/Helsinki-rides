// Three.js scene: renderer, sky, sun and the static city cells (plan section 5). The lighting A/B of M0 is a load-time
// material swap: `lit` keeps the baked GLB materials under a sun + sky light, `unlit` renders facades with their
// texture colour only. In `lit`, materials marked `bakedLighting`
// (facade photos, which already carry the flight's light) take most of their colour as emissive and only a share
// from the lights, so walls the flight saw in shade are not darkened a second time (decision 0003). Instanced scenery
// (the register trees, decision 0006) uses cell-owned buffers, per-instance culling and low-preset foliage LOD.
import * as THREE from 'three';
import { cellId, cellIndexFor, type CellDescriptor, type SceneryDocument, type SceneryInstance, type WorldManifest } from '@helsinki/world-schema';
import type { GlbLoader } from '../world/loader.ts';
import type { Lighting, Preset } from '../config.ts';
import { disposeCellResources, geometryBytesOf, textureBytesOf } from './cell-resources.ts';
import { SceneryInstanceCuller } from './scenery-culling.ts';
import { partitionCoarseCell } from './coarse-batching.ts';
import { createFoliageLods, type FoliageLods, type SceneryLodLevel } from './scenery-lod.ts';

export interface CellView {
  readonly id: string;
  readonly group: THREE.Group;
  readonly descriptor: CellDescriptor;
  readonly lod: 'lod0' | 'lod1' | 'lod2';
  readonly textureBytes: number;
  readonly geometryBytes: number;
  triangles: number;
}

/** Sun matched to the light baked into the facade photos (decision 0003): azimuth from north, clockwise, and elevation. */
const SUN_AZIMUTH_DEG = 127, SUN_ELEVATION_DEG = 38;
/** Baked-light facades: emissive share of the texture colour, and the diffuse share left to the sun and sky. */
const BAKED_EMISSIVE = 0.72, BAKED_DIFFUSE = 0.45;

export class CityScene {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly sky: THREE.HemisphereLight;
  readonly cells = new Map<string, CellView>();
  readonly fallbackCells = new Map<string, CellView>();
  private readonly sceneryDefinitions = new Map<string, SceneryInstance[]>();
  private readonly sceneryCellViews = new Map<string, THREE.Group>();
  private readonly sceneryMaterials = new Map<THREE.Material, THREE.Material>();
  private sceneryFoliageLods = new Map<THREE.BufferGeometry, FoliageLods | null>();
  private readonly sceneryRoot = new THREE.Group();
  private sceneryCulling: { meshes: Map<THREE.InstancedMesh, SceneryInstanceCuller>; frustum: THREE.Frustum; projection: THREE.Matrix4 } | null = null;
  private sceneryAssets: ReadonlyMap<string, THREE.Object3D> | null = null;
  private sceneryStreamed = false;
  lighting: Lighting;
  readonly preset: Preset;

  constructor(canvas: HTMLCanvasElement, preset: Preset, lighting: Lighting, pixelRatioCap: number) {
    this.preset = preset;
    this.lighting = lighting;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: preset !== 'low', powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, pixelRatioCap));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = false;
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1200);
    this.scene.background = new THREE.Color(0x9fb8d4);
    this.scene.fog = new THREE.Fog(0x9fb8d4, 250, 900);
    // Morning sun from the south-east, as in the facade photos (runtime +Z is south, +X east).
    this.sun = new THREE.DirectionalLight(0xfff2dc, lighting === 'lit' ? 2.4 : 0);
    const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG), el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
    this.sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(200);
    this.scene.add(this.sun);
    this.sky = new THREE.HemisphereLight(0xcfe0f5, 0x6b6558, lighting === 'lit' ? 1.3 : 0.0);
    this.scene.add(this.sky);
    this.resize();
  }

  resize(): void {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async loadCell(loader: GlbLoader, base: string, descriptor: CellDescriptor, requestedLod: 'lod0' | 'lod1' | 'lod2' = 'lod0'): Promise<CellView> {
    const lod = requestedLod === 'lod1' && !descriptor.visual.lod1 ? 'lod0' : requestedLod;
    const source = descriptor.visual[lod];
    if (!source) throw new Error(`cell ${descriptor.id} has no ${lod}`);
    const gltf = await loader.load(base + source.path);
    const group = gltf.scene;
    if (this.preset === 'low' && lod === 'lod2') partitionCoarseCell(group);
    let triangles = 0;
    const adapted = new Map<THREE.Material, THREE.Material>();
    const materialFor = (material: THREE.Material): THREE.Material => {
      let result = adapted.get(material);
      if (!result) { result = this.adaptMaterial(material); adapted.set(material, result); }
      return result;
    };
    group.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      const geo = mesh.geometry;
      triangles += geo.index ? geo.index.count / 3 : geo.attributes.position!.count / 3;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.material = Array.isArray(mesh.material) ? mats.map(materialFor) : materialFor(mats[0]!);
    });
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const view: CellView = { id: descriptor.id, group, descriptor, lod, triangles, textureBytes: textureBytesOf([group]), geometryBytes: geometryBytesOf(group) };
    return view;
  }

  showCell(view: CellView): void {
    const map = view.lod === 'lod2' ? this.fallbackCells : this.cells;
    const previous = map.get(view.id);
    if (previous && previous !== view) this.disposeCell(previous);
    map.set(view.id, view);
    view.group.visible = view.lod !== 'lod2' || !this.cells.has(view.id);
    this.scene.add(view.group);
    if (view.lod !== 'lod2') { const fallback = this.fallbackCells.get(view.id); if (fallback) fallback.group.visible = false; }
    this.refreshSceneryCells();
  }

  disposeCell(view: CellView): void {
    const map = view.lod === 'lod2' ? this.fallbackCells : this.cells;
    // A cancelled old request must not remove a newer mounted generation of the same cell.
    if (map.get(view.id) === view) {
      map.delete(view.id);
      if (view.lod !== 'lod2') { const fallback = this.fallbackCells.get(view.id); if (fallback) fallback.group.visible = true; }
    }
    disposeCellResources(view.group);
    this.refreshSceneryCells();
  }

  async addCell(loader: GlbLoader, base: string, descriptor: CellDescriptor): Promise<CellView> {
    const view = await this.loadCell(loader, base, descriptor);
    this.showCell(view);
    return view;
  }

  /** Retain only lightweight placement records globally; instance buffers follow coarse visual residency. */
  addScenery(doc: SceneryDocument, assets: ReadonlyMap<string, THREE.Object3D>, cellSize = 128, streamed = false): THREE.Group {
    this.sceneryAssets = assets;
    this.sceneryStreamed = streamed;
    for (const instance of doc.instances) {
      const id = cellId(...cellIndexFor(instance.position[0], instance.position[2], cellSize));
      const list = this.sceneryDefinitions.get(id) ?? [];
      list.push(instance);
      this.sceneryDefinitions.set(id, list);
    }
    this.sceneryRoot.name = 'scenery';
    this.sceneryRoot.matrixAutoUpdate = false;
    this.scene.add(this.sceneryRoot);
    this.refreshSceneryCells();
    return this.sceneryRoot;
  }

  sceneryStats(): { residentCells: number; residentInstances: number; totalInstances: number } {
    return { residentCells: this.sceneryCellViews.size,
      residentInstances: [...this.sceneryCellViews.keys()].reduce((sum, id) => sum + (this.sceneryDefinitions.get(id)?.length ?? 0), 0),
      totalInstances: [...this.sceneryDefinitions.values()].reduce((sum, list) => sum + list.length, 0) };
  }

  /** Use the final rendered camera; the simulation and resident source placements are unchanged. */
  prepareSceneryForRender(): void {
    const culling = this.sceneryCulling;
    if (!culling) return;
    this.camera.updateWorldMatrix(true, false);
    culling.projection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    culling.frustum.setFromProjectionMatrix(culling.projection);
    for (const mesh of culling.meshes.values()) mesh.update(culling.frustum, this.camera.position);
  }

  private refreshSceneryCells(): void {
    if (!this.sceneryAssets) return;
    const wanted = this.sceneryStreamed ? new Set([...this.cells.keys(), ...this.fallbackCells.keys()]) : new Set(this.sceneryDefinitions.keys());
    for (const [id, group] of this.sceneryCellViews) if (!wanted.has(id)) {
      group.removeFromParent();
      // Instance buffers are cell-owned; the template geometry, material and textures belong to AssetLibrary.
      group.traverse(node => { const mesh = node as THREE.InstancedMesh; if (mesh.isInstancedMesh) { this.sceneryCulling?.meshes.get(mesh)?.dispose(); this.sceneryCulling?.meshes.delete(mesh); mesh.dispose(); } });
      group.clear();
      this.sceneryCellViews.delete(id);
    }
    for (const id of wanted) {
      const list = this.sceneryDefinitions.get(id);
      if (!list || this.sceneryCellViews.has(id)) continue;
      const group = this.buildSceneryGroup(list, this.sceneryAssets);
      group.name = `scenery:${id}`;
      this.sceneryRoot.add(group);
      if (this.preset === 'low') {
        const culling = this.sceneryCulling ??= { meshes: new Map(), frustum: new THREE.Frustum(), projection: new THREE.Matrix4() };
        group.updateWorldMatrix(true, true);
        group.traverse(node => { const mesh = node as THREE.InstancedMesh; if (mesh.isInstancedMesh) culling.meshes.set(mesh, new SceneryInstanceCuller(mesh, mesh.userData['sceneryLodLevel'] as SceneryLodLevel | undefined)); });
      }
      this.sceneryCellViews.set(id, group);
    }
  }

  private buildSceneryGroup(instances: readonly SceneryInstance[], assets: ReadonlyMap<string, THREE.Object3D>): THREE.Group {
    const group = new THREE.Group();
    const byNode = new Map<string, SceneryInstance[]>();
    for (const i of instances) {
      // Trees use cell/model batches: exact per-instance culling avoids submitting
      // offscreen neighbours, while near/mid/far foliage avoids multiplying draws across32m batches.
      const spatialBatch = this.preset === 'low' && i.asset !== 'scenery-trees' ? `/${Math.floor(i.position[0] / 32)},${Math.floor(i.position[2] / 32)}` : '';
      const key = `${i.asset}/${i.node}${spatialBatch}`;
      const list = byNode.get(key) ?? [];
      list.push(i); byNode.set(key, list);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (const list of byNode.values()) {
      const { asset, node: name } = list[0]!;
      const root = assets.get(asset);
      const node = root?.getObjectByName(name);
      if (!root || !node) throw new Error(`scenery node ${asset}/${name} missing`);
      root.updateMatrixWorld(true);
      const toNode = node.matrixWorld.clone().invert();
      node.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const local = toNode.clone().multiply(mesh.matrixWorld);
        const source = mesh.material as THREE.Material;
        let material = this.sceneryMaterials.get(source);
        if (!material) { material = this.adaptMaterial(source); this.sceneryMaterials.set(source, material); }
        // Alpha-masked leaves: smooth their cut-out edges where the renderer multisamples.
        if (material.alphaTest > 0 && this.preset !== 'low') material.alphaToCoverage = true;
        let levels: FoliageLods | null = null;
        if (this.preset === 'low' && asset === 'scenery-trees' && source.name === 'tree_leaves') {
          this.sceneryFoliageLods ??= new Map();
          if (!this.sceneryFoliageLods.has(mesh.geometry)) this.sceneryFoliageLods.set(mesh.geometry, createFoliageLods(mesh.geometry));
          levels = this.sceneryFoliageLods.get(mesh.geometry)!;
        }
        const variants: { geometry: THREE.BufferGeometry; level?: SceneryLodLevel }[] = levels ? [{ geometry: mesh.geometry, level: 0 }, { geometry: levels.mid, level: 1 }, { geometry: levels.far, level: 2 }] : [{ geometry: mesh.geometry }];
        for (const variant of variants) {
          const inst = new THREE.InstancedMesh(variant.geometry, material, list.length);
          inst.name = `${name}:${mesh.name}${variant.level === undefined ? '' : `:lod${variant.level}`}`;
          if (variant.level !== undefined) inst.userData['sceneryLodLevel'] = variant.level;
          list.forEach((it, k) => inst.setMatrixAt(k, m.compose(p.fromArray(it.position), q.setFromAxisAngle(up, it.yaw), s.fromArray(it.scale)).multiply(local)));
          inst.instanceMatrix.needsUpdate = true;
          inst.computeBoundingSphere();
          inst.matrixAutoUpdate = false;
          group.add(inst);
        }
      });
    }
    group.matrixAutoUpdate = false;
    return group;
  }

  /** Lit: keep PBR but flatten roughness/metalness (baked-light photos mostly emissive); unlit: colour × texture only. */
  private adaptMaterial(m: THREE.Material): THREE.Material {
    const src = m as THREE.MeshStandardMaterial;
    const isUnlitSource = (m as THREE.MeshBasicMaterial).isMeshBasicMaterial;
    if (this.lighting === 'unlit' || isUnlitSource) {
      if (isUnlitSource) { m.toneMapped = false; return m; }
      const basic = new THREE.MeshBasicMaterial({ map: src.map ?? null, color: src.color, side: src.side, transparent: src.transparent, alphaTest: src.alphaTest, opacity: src.opacity, vertexColors: src.vertexColors });
      basic.name = src.name;
      basic.toneMapped = false;
      src.dispose();
      return basic;
    }
    src.roughness = 1;
    src.metalness = 0;
    src.envMapIntensity = 0;
    if (src.userData['bakedLighting'] === true && src.map) {
      src.emissiveMap = src.map;
      src.emissive.setScalar(BAKED_EMISSIVE);
      src.color.multiplyScalar(BAKED_DIFFUSE);
    }
    return src;
  }

  setLighting(lighting: Lighting): void {
    this.lighting = lighting;
    this.sun.intensity = lighting === 'lit' ? 2.4 : 0;
    this.sky.intensity = lighting === 'lit' ? 1.3 : 0;
  }

  get drawInfo(): THREE.WebGLInfo { return this.renderer.info; }
}
