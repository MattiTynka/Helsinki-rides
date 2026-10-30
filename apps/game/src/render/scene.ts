// Three.js scene: renderer, sky, sun and the static city cells (plan section 5). The lighting A/B of M0 is a load-time
// material swap: `lit` keeps the baked GLB materials under a sun + sky light, `unlit` renders facades with their
// texture colour only. In `lit`, materials marked `bakedLighting`
// (facade photos, which already carry the flight's light) take most of their colour as emissive and only a share
// from the lights, so walls the flight saw in shade are not darkened a second time (decision 0003). The tier's
// material class picks flattened PBR or Lambert shading for those lit materials (city-materials.ts). Instanced scenery
// (the register trees, decision 0006) uses cell-owned buffers, per-instance culling and distance-scaled foliage LOD.
// A detail-tier change (`applyTier`) rebuilds resident scenery at once; resident city cells keep the material class
// they were loaded with until they are evicted, because the class is a load-time rule.
import * as THREE from 'three';
import { cellId, cellIndexFor, type CellDescriptor, type SceneryDocument, type SceneryInstance, type WorldManifest } from '@helsinki/world-schema';
import type { GlbLoader } from '../world/loader.ts';
import type { Lighting, Preset } from '../config.ts';
import { cellTextures, disposeCellResources, geometryBytesOf, textureBytesOf } from './cell-resources.ts';
import { UploadQueue } from './upload-queue.ts';
import { SceneryInstanceCuller } from './scenery-culling.ts';
import { partitionCoarseCell } from './coarse-batching.ts';
import { createFoliageLods, type FoliageLods, type SceneryLodLevel } from './scenery-lod.ts';
import { AdaptiveResolution, drawingPixelRatio, type ResolutionOptions } from './frame-pacing.ts';
import { adaptCityMaterial } from './city-materials.ts';
import type { MaterialClass, TierParameters } from './quality-tiers.ts';

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
export const SUN_AZIMUTH_DEG = 127, SUN_ELEVATION_DEG = 38;

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
  /** Adapted copies of asset-library scenery materials, one per material class; the sources stay untouched. */
  private readonly sceneryMaterials = new Map<THREE.Material, Partial<Record<MaterialClass, THREE.Material>>>();
  private sceneryFoliageLods = new Map<THREE.BufferGeometry, FoliageLods | null>();
  private readonly sceneryRoot = new THREE.Group();
  private sceneryCulling: { meshes: Map<THREE.InstancedMesh, SceneryInstanceCuller>; frustum: THREE.Frustum; projection: THREE.Matrix4 } | null = null;
  private sceneryAssets: ReadonlyMap<string, THREE.Object3D> | null = null;
  private sceneryStreamed = false;
  lighting: Lighting;
  readonly preset: Preset;
  /** Shading of lit city cells and scenery built from now on (the active tier's class). */
  materialClass: MaterialClass;
  /** Non-tree scenery batches per 32 m block on the low-detail tiers, per cell on Standard. */
  private spatialSceneryBatches: boolean;
  /** The active tier's foliage LOD distance scale. */
  private foliageLodScale: number;
  private readonly uploads = new UploadQueue();
  /** Whether the context links programs in parallel (KHR_parallel_shader_compile), checked at the first preparation. */
  private parallelCompile: boolean | null = null;
  private offscreen: THREE.WebGLRenderTarget | null = null;
  private readonly maxPixelRatio: number;
  private readonly resolution: AdaptiveResolution;
  private readonly maxRenderPixels: number;

  constructor(canvas: HTMLCanvasElement, preset: Preset, lighting: Lighting, pixelRatioCap: number,
    options: ResolutionOptions & { readonly materialClass?: MaterialClass; readonly foliageLodScale?: number } = {}) {
    this.preset = preset;
    this.lighting = lighting;
    this.materialClass = options.materialClass ?? 'standard';
    this.spatialSceneryBatches = this.materialClass === 'lambert';
    this.foliageLodScale = options.foliageLodScale ?? 1;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: preset !== 'low', powerPreference: 'high-performance', stencil: false });
    this.maxPixelRatio = Math.min(devicePixelRatio, pixelRatioCap);
    this.resolution = new AdaptiveResolution(options);
    this.maxRenderPixels = options.maxRenderPixels ?? Number.POSITIVE_INFINITY;
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

  /**
   * Dynamic resolution. Frames that stay slow while their CPU part is short (a fill-rate bound GPU) lower the
   * drawing-buffer pixel ratio in steps down to the configured floor (`minRenderScale`: 50% of the capped ratio on
   * desktops, 60% on touch-first hardware); a long run of full-rate frames raises it again. Frames up to one second
   * count, and those at least twice the target interval take a larger step. A display-limited 60 Hz frame never lowers it.
   */
  adaptResolution(intervalSeconds: number, cpuMs: number): void {
    if (this.resolution.update(intervalSeconds, cpuMs)) this.resize();
  }

  get resolutionScale(): number { return this.resolution.scale; }
  get resolutionAtFloor(): boolean { return this.resolution.atFloor; }
  get resolutionFloor(): number { return this.resolution.minScale; }
  get resolutionAtCeiling(): boolean { return this.resolution.atCeiling; }

  /**
   * A detail-tier change without a reload: fog and far plane, the material class of cells loaded from now on, and the
   * resident scenery rebuilt with the tier's batching, material class and foliage LOD scale. The adapted scenery
   * materials are cached per (source, class), so switching back reuses the earlier copies.
   */
  applyTier(params: TierParameters): void {
    this.materialClass = params.materialClass;
    this.spatialSceneryBatches = params.materialClass === 'lambert';
    this.foliageLodScale = params.foliageLodScale;
    if (this.scene.fog instanceof THREE.Fog) { this.scene.fog.near = params.fog.near; this.scene.fog.far = params.fog.far; }
    this.camera.far = params.cameraFar;
    this.camera.updateProjectionMatrix();
    for (const [id, group] of [...this.sceneryCellViews]) this.removeSceneryGroup(id, group);
    this.refreshSceneryCells();
  }

  setTargetFrameRate(rate: 30 | 60): void { this.resolution.setTargetFrameRate(rate); }

  resize(): void {
    const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
    this.renderer.setPixelRatio(drawingPixelRatio(w, h, this.maxPixelRatio, this.resolution.scale, this.maxRenderPixels));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async loadCell(loader: GlbLoader, base: string, descriptor: CellDescriptor, requestedLod: 'lod0' | 'lod1' | 'lod2' = 'lod0', signal?: AbortSignal): Promise<CellView> {
    const lod = requestedLod === 'lod1' && !descriptor.visual.lod1 ? 'lod0' : requestedLod;
    const source = descriptor.visual[lod];
    if (!source) throw new Error(`cell ${descriptor.id} has no ${lod}`);
    const gltf = await loader.load(base + source.path, signal);
    const group = gltf.scene;
    if (this.preset === 'low' && lod === 'lod2') partitionCoarseCell(group);
    let triangles = 0;
    const adapted = new Map<THREE.Material, THREE.Material>();
    const materialFor = (material: THREE.Material): THREE.Material => {
      let result = adapted.get(material);
      if (!result) { result = adaptCityMaterial(material, { lighting: this.lighting, materialClass: this.materialClass }); adapted.set(material, result); }
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
    // The parsed materials belong to this cell's GLB and were never rendered; the adapted ones replace them.
    for (const source of adapted.keys()) source.dispose();
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const view: CellView = { id: descriptor.id, group, descriptor, lod, triangles, textureBytes: textureBytesOf([group]), geometryBytes: geometryBytesOf(group) };
    return view;
  }

  async prepareCell(view: CellView, signal?: AbortSignal): Promise<void> {
    await this.prepareObject(view.group, signal);
  }

  /**
   * Upload the textures of `root` (a detached root, or the scene itself) through the frame-budgeted queue and compile
   * its programs against this scene's fog and final light set, so its first draw neither uploads nor links. Without
   * KHR_parallel_shader_compile three.js reports every program ready at once and only waits for the link at its first
   * use, inside a later frame; the root is then also drawn once into a tiny offscreen target, so that wait happens here.
   */
  async prepareObject(root: THREE.Object3D, signal?: AbortSignal): Promise<void> {
    const pending = new AbortController(), abort = () => pending.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) pending.abort();
    try {
      const properties = this.renderer.properties;
      const fresh = cellTextures(root).filter(texture => !properties.has(texture) || (properties.get(texture) as { __version?: number }).__version !== texture.version);
      await Promise.all(fresh.map(texture => this.uploads.enqueue(() => this.renderer.initTexture(texture), pending.signal)));
      pending.signal.throwIfAborted();
      await this.renderer.compileAsync(root, this.camera, this.scene);
      pending.signal.throwIfAborted();
      this.parallelCompile ??= this.renderer.getContext().getExtension('KHR_parallel_shader_compile') !== null;
      if (!this.parallelCompile) this.drawOffscreen(root);
    } catch (error) {
      pending.abort();
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  /**
   * One draw of `root` with this scene's lights into a 4 × 4 target, everything else in the scene hidden and frustum
   * culling off, then the renderer state restored. The target is flagged like an XR target with the canvas colour
   * space: a plain render target selects linear output and so a different program than the canvas draws use.
   */
  private drawOffscreen(root: THREE.Object3D): void {
    const renderer = this.renderer, scene = this.scene;
    this.offscreen ??= Object.assign(new THREE.WebGLRenderTarget(4, 4, { colorSpace: renderer.outputColorSpace as THREE.ColorSpace }), { isXRRenderTarget: true });
    const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel(), autoClear = renderer.autoClear;
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    const culled: THREE.Object3D[] = [], hidden: THREE.Object3D[] = [], attach = root !== scene;
    root.traverse(node => { if (node.frustumCulled) { node.frustumCulled = false; culled.push(node); } });
    if (attach) {
      // Children holding lights stay visible: the light set is part of every program.
      for (const child of scene.children) {
        let light = false;
        child.traverse(node => { light ||= (node as THREE.Light).isLight === true; });
        if (child.visible && !light) { child.visible = false; hidden.push(child); }
      }
      scene.add(root);
    }
    try {
      renderer.setRenderTarget(this.offscreen);
      renderer.autoClear = true;
      renderer.render(scene, this.camera);
    } finally {
      if (attach) scene.remove(root);
      for (const node of hidden) node.visible = true;
      for (const node of culled) node.frustumCulled = true;
      renderer.setRenderTarget(target, face, level);
      renderer.autoClear = autoClear;
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
    }
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
    for (const [id, group] of this.sceneryCellViews) if (!wanted.has(id)) this.removeSceneryGroup(id, group);
    for (const id of wanted) {
      const list = this.sceneryDefinitions.get(id);
      if (!list || this.sceneryCellViews.has(id)) continue;
      const group = this.buildSceneryGroup(list, this.sceneryAssets);
      group.name = `scenery:${id}`;
      this.sceneryRoot.add(group);
      {
        const culling = this.sceneryCulling ??= { meshes: new Map(), frustum: new THREE.Frustum(), projection: new THREE.Matrix4() };
        group.updateWorldMatrix(true, true);
        group.traverse(node => { const mesh = node as THREE.InstancedMesh; if (mesh.isInstancedMesh) culling.meshes.set(mesh, new SceneryInstanceCuller(mesh, mesh.userData['sceneryLodLevel'] as SceneryLodLevel | undefined, this.foliageLodScale)); });
      }
      this.sceneryCellViews.set(id, group);
    }
  }

  private removeSceneryGroup(id: string, group: THREE.Group): void {
    group.removeFromParent();
    // Instance buffers are cell-owned; the template geometry, material and textures belong to AssetLibrary.
    group.traverse(node => { const mesh = node as THREE.InstancedMesh; if (mesh.isInstancedMesh) { this.sceneryCulling?.meshes.get(mesh)?.dispose(); this.sceneryCulling?.meshes.delete(mesh); mesh.dispose(); } });
    group.clear();
    this.sceneryCellViews.delete(id);
  }

  private buildSceneryGroup(instances: readonly SceneryInstance[], assets: ReadonlyMap<string, THREE.Object3D>): THREE.Group {
    const group = new THREE.Group();
    const byNode = new Map<string, SceneryInstance[]>();
    for (const i of instances) {
      // Trees use cell/model batches: exact per-instance culling avoids submitting
      // offscreen neighbours, while near/mid/far foliage avoids multiplying draws across32m batches.
      const spatialBatch = this.spatialSceneryBatches && i.asset !== 'scenery-trees' ? `/${Math.floor(i.position[0] / 32)},${Math.floor(i.position[2] / 32)}` : '';
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
        const adapted = this.sceneryMaterials.get(source) ?? {};
        let material = adapted[this.materialClass];
        if (!material) {
          material = adaptCityMaterial(source, { lighting: this.lighting, materialClass: this.materialClass });
          // Alpha-masked leaves: smooth their cut-out edges where the renderer multisamples.
          if (material.alphaTest > 0 && this.preset !== 'low') material.alphaToCoverage = true;
          adapted[this.materialClass] = material;
          this.sceneryMaterials.set(source, adapted);
        }
        let levels: FoliageLods | null = null;
        if (asset === 'scenery-trees' && source.name === 'tree_leaves') {
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

  setLighting(lighting: Lighting): void {
    this.lighting = lighting;
    this.sun.intensity = lighting === 'lit' ? 2.4 : 0;
    this.sky.intensity = lighting === 'lit' ? 1.3 : 0;
  }

  get drawInfo(): THREE.WebGLInfo { return this.renderer.info; }
}
