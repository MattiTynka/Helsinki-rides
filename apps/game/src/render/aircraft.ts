import * as THREE from 'three';
import { type AircraftState } from '@helsinki/sim';
import type { GlbLoader } from '../world/loader.ts';

const trainerUrl = new URL('../assets/aircraft/trainer.glb', import.meta.url).href;
const helicopterUrl = new URL('../assets/aircraft/helicopter.glb', import.meta.url).href;

interface AircraftView {
  root: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  spin: THREE.AnimationAction;
}

/** Two small licensed models, fetched only when Malmi or an aircraft is approached. */
export class AircraftViews {
  private readonly views = new Map<AircraftState['kind'], AircraftView>();
  private loading: Promise<void> | null = null;
  private retryAt = 0;
  failed = false;
  private readonly loader: GlbLoader;
  private readonly scene: THREE.Scene;

  constructor(loader: GlbLoader, scene: THREE.Scene) { this.loader = loader; this.scene = scene; }

  get ready(): boolean { return this.views.size === 2; }
  roots(): THREE.Object3D[] { return [...this.views.values()].map(view => view.root); }

  ensureLoaded(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    if (performance.now() < this.retryAt) return Promise.reject(new Error('Aircraft model retry pending'));
    this.loading = this.load().then(() => { this.failed = false; }, error => {
      this.failed = true;
      this.retryAt = performance.now() + 2000;
      throw error;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  private async load(): Promise<void> {
    for (const [kind, url, pivot] of [
      ['plane', trainerUrl, 'trainer_propeller'],
      ['helicopter', helicopterUrl, 'helicopter_rotor_main'],
    ] as const) {
      if (this.views.has(kind)) continue;
      const gltf = await this.loader.load(url);
      const clip = gltf.animations.find(animation => animation.name === 'spin');
      if (!clip || !gltf.scene.getObjectByName(pivot)) throw new Error(`Aircraft ${kind} lacks its animation rig`);
      const root = new THREE.Group();
      root.name = `aircraft-${kind}`;
      root.visible = false;
      root.add(gltf.scene);
      const mixer = new THREE.AnimationMixer(gltf.scene);
      const spin = mixer.clipAction(clip).play();
      gltf.scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
      });
      this.scene.add(root);
      this.views.set(kind, { root, model: gltf.scene, mixer, spin });
    }
  }

  update(states: readonly AircraftState[], dt: number, playerPosition: readonly number[]): void {
    if (!this.ready && performance.now() >= this.retryAt && states.some(state => state.occupied
      || Math.hypot(state.position[0] - playerPosition[0]!, state.position[2] - playerPosition[2]!) < 450)) {
      void this.ensureLoaded().catch(() => { console.warn('Aircraft models unavailable; retrying'); });
    }
    for (const view of this.views.values()) view.root.visible = false;
    for (const state of states) {
      const view = this.views.get(state.kind);
      if (!view) continue;
      view.root.visible = Math.hypot(state.position[0] - playerPosition[0]!, state.position[2] - playerPosition[2]!) < 1800 || state.occupied;
      view.root.position.set(...state.position);
      view.root.quaternion.set(...state.rotation);
      view.spin.timeScale = state.occupied ? 0.3 + state.throttle * 2 : 0;
      view.mixer.update(Math.min(0.1, Math.max(0, dt)));
      if (state.kind === 'plane') {
        const roll = new THREE.Euler().setFromQuaternion(view.root.quaternion, 'YXZ').z;
        const elevator = view.model.getObjectByName('trainer_elevator');
        const left = view.model.getObjectByName('trainer_aileron_left');
        const right = view.model.getObjectByName('trainer_aileron_right');
        const rudder = view.model.getObjectByName('trainer_rudder');
        if (elevator) elevator.rotation.x = THREE.MathUtils.clamp(-state.verticalSpeed * 0.025, -0.3, 0.3);
        if (left) left.rotation.x = -roll * 0.6;
        if (right) right.rotation.x = roll * 0.6;
        if (rudder) rudder.rotation.y = roll * 0.4;
      }
    }
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    for (const view of this.views.values()) {
      view.mixer.stopAllAction();
      view.mixer.uncacheRoot(view.model);
      view.root.removeFromParent();
      view.model.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          materials.add(material);
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
        }
      });
    }
    for (const resource of [...geometries, ...materials, ...textures]) resource.dispose();
    this.views.clear();
  }
}
