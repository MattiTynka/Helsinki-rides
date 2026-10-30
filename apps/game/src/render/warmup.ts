// Startup warm-up: before an actor asset is published, its textures are uploaded and every program its views draw
// with is compiled, from a detached stand-in built the way CharacterView and VehicleView build their meshes. A
// program depends on the object (skinning, vertex colours, instancing) as well as on the material, so the stand-ins
// reuse the asset's own meshes, geometry and materials. The animation layers (character-collapse.ts,
// knockdown-presentation.ts, pedestrian-animation.ts, native-vehicle-animation.ts) only pose bones and create no
// materials, so the asset materials cover them.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import type { AssetLibrary, PrepareAsset, PreparedAsset } from './assets.ts';
import { createContactShadow } from './contact-shadow.ts';
import type { Effects } from './effects.ts';

/** Uploads and compiles a detached root against the city scene (`CityScene.prepareObject`). */
export type PrepareRoot = (root: THREE.Object3D) => Promise<void>;

/** A detached stand-in and the release of what was created for it; shared asset resources are never disposed. */
export interface WarmupRoot {
  readonly root: THREE.Group;
  dispose(): void;
}

/**
 * A character's skinned scene with the pistol in the hand socket, as CharacterView holds it (shown here, so a
 * fallback draw reaches it), or a car's detail scene beside its far body under `farMaterial` and far lamp meshes.
 * The far lamps use the asset's lamp materials: each view's lamp copies compile to the same programs, and disposing
 * a warm-up copy would release the program when no other material holds it yet.
 */
export function assetWarmupRoot(source: THREE.Object3D, asset: PreparedAsset, library: AssetLibrary): WarmupRoot {
  const root = new THREE.Group();
  const skeletons = new Set<THREE.Skeleton>();
  if (asset.kind === 'character') {
    const model = skeletonClone(source);
    model.traverse(node => { const mesh = node as THREE.SkinnedMesh; if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton); });
    const socket = model.getObjectByName('SOCKET_HAND_R');
    const pistol = library.pistol?.clone(true);
    if (socket && pistol) { pistol.visible = true; socket.add(pistol); }
    root.add(model);
  } else if (asset.kind === 'vehicle') {
    root.add(source.clone(true));
    const lamps = new Map<string, THREE.Material>();
    source.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material.name.startsWith('car_lamp') && !lamps.has(material.name)) lamps.set(material.name, material);
      }
    });
    const far = new THREE.Group();
    far.add(new THREE.Mesh(asset.asset.far.body, library.farMaterial));
    for (const [name, geometry] of asset.asset.far.lamps) {
      const material = lamps.get(name);
      if (material) far.add(new THREE.Mesh(geometry, material));
    }
    root.add(far);
  } else {
    root.add(source.clone(true));
  }
  // Cloned skeletons get a bone texture if the fallback draw renders them; geometry and materials stay the asset's.
  return { root, dispose: () => { for (const skeleton of skeletons) skeleton.dispose(); root.clear(); } };
}

/**
 * The library's prepare hook plus the shared actor presentation. The contact-shadow stand-in is kept for the
 * session: its material copy would otherwise be the only holder of that program until the first view exists.
 */
export class ActorWarmup {
  private readonly shadow: THREE.Mesh;
  private readonly prepareRoot: PrepareRoot;
  private readonly library: AssetLibrary;
  private readonly effects: Effects;

  constructor(prepareRoot: PrepareRoot, library: AssetLibrary, shadowMaterial: THREE.Material, effects: Effects) {
    this.prepareRoot = prepareRoot;
    this.library = library;
    this.effects = effects;
    this.shadow = createContactShadow(shadowMaterial);
  }

  readonly prepareAsset: PrepareAsset = async (source, asset) => {
    const warm = assetWarmupRoot(source, asset, this.library);
    try { await this.prepareRoot(warm.root); } finally { warm.dispose(); }
  };

  /** The contact shadow and the first shot's tracer, muzzle flash and flash core, before any of them is drawn. */
  async prepareShared(): Promise<void> {
    const warm = effectsWarmupRoot(this.effects, this.shadow);
    try { await this.prepareRoot(warm.root); } finally { warm.dispose(); }
  }
}

/** Visible stand-ins over the pooled effect materials and geometries; only the tracer's two-point line is created here. */
export function effectsWarmupRoot(effects: Effects, shadow: THREE.Mesh): WarmupRoot {
  const parts = effects.parts, root = new THREE.Group();
  const line = new THREE.BufferGeometry();
  line.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  root.add(new THREE.Line(line, parts.tracer), new THREE.Mesh(parts.flashGeometry, parts.flash), new THREE.Mesh(parts.coreGeometry, parts.core));
  root.add(shadow);
  return { root, dispose: () => { line.dispose(); root.clear(); } };
}
