// Transient shooting presentation. Fixed pools share geometry/materials; no per-shot GPU allocation.
import * as THREE from 'three';
import type { Shot } from '@helsinki/sim';

const MAX_TRACERS = 24;
export const MAX_MUZZLE_LIGHTS = 4;
export const MUZZLE_FLASH_SECONDS = .05;
// A pistol muzzle is much nearer the face than the reference rifle. This scene also uses NoToneMapping:
// reference-scale light power clips skin to white. Calibrated against native Snow/Rain return-fire frames.
export const MUZZLE_LIGHT_INTENSITY = 1.2;
export type MuzzleResolver = (shooter: string, position: THREE.Vector3, direction: THREE.Vector3) => boolean;
export interface ShootingEffectsSnapshot {
  activeTracers: number;
  flashes: { shooter: string | null; remainingSeconds: number; visible: boolean; intensity: number;
    color: number[]; position: number[]; range: number; castsShadow: boolean }[];
}

interface Flash {
  root: THREE.Group;
  flame: THREE.Group;
  light: THREE.PointLight;
  ttl: number;
  shooter: string | null;
}

export class Effects {
  readonly group = new THREE.Group();
  private readonly tracers: { line: THREE.Line; ttl: number }[] = [];
  private readonly flashes: Flash[] = [];
  private readonly tracerMaterial = new THREE.LineBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: .9 });
  private readonly flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffb64a, transparent: true, opacity: .85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  private readonly coreMaterial = new THREE.MeshBasicMaterial({ color: 0xfff3c4, depthWrite: false, toneMapped: false });
  private readonly flashGeometry = new THREE.ConeGeometry(.035, .13, 5, 1, false);
  private readonly coreGeometry = new THREE.ConeGeometry(.018, .065, 5, 1, false);
  private readonly position = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private sequence = 0;
  private disposed = false;

  constructor() {
    for (let i = 0; i < MAX_TRACERS; i++) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geometry, this.tracerMaterial);
      line.visible = false;
      line.frustumCulled = false;
      this.group.add(line);
      this.tracers.push({ line, ttl: 0 });
    }
    for (let i = 0; i < MAX_MUZZLE_LIGHTS; i++) {
      const root = new THREE.Group(), flame = new THREE.Group();
      const outer = new THREE.Mesh(this.flashGeometry, this.flashMaterial), core = new THREE.Mesh(this.coreGeometry, this.coreMaterial);
      outer.rotation.x = Math.PI / 2; outer.position.z = .065;
      core.rotation.x = Math.PI / 2; core.position.z = .0325;
      outer.frustumCulled = core.frustumCulled = false;
      flame.add(outer, core); flame.visible = false;
      // Constant light count avoids material recompiles on each gunshot; no shadow passes.
      const light = new THREE.PointLight(0xffb050, 0, 3.5, 2);
      light.castShadow = false;
      root.add(flame, light); this.group.add(root);
      this.flashes.push({ root, flame, light, ttl: 0, shooter: null });
    }
  }

  /** Caller passes only newly emitted simulation shots, after the current frame's weapon transforms. */
  addShots(shots: readonly Shot[], resolveMuzzle?: MuzzleResolver): void {
    if (this.disposed) return;
    for (const shot of shots) {
      const visibleMuzzle = resolveMuzzle?.(shot.shooter, this.position, this.direction) ?? false;
      if (!visibleMuzzle) this.position.set(...shot.origin);
      const tracer = this.tracers.find(entry => entry.ttl <= 0) ?? this.tracers[this.sequence % MAX_TRACERS]!;
      const points = tracer.line.geometry.attributes.position as THREE.BufferAttribute;
      points.setXYZ(0, this.position.x, this.position.y, this.position.z);
      points.setXYZ(1, ...shot.end); points.needsUpdate = true;
      tracer.line.visible = true; tracer.ttl = .08;
      // Missing/deferred/dead character views get only the ballistic tracer.
      if (visibleMuzzle) {
        const flash = this.flashes.find(entry => entry.shooter === shot.shooter && entry.ttl > 0)
          ?? this.flashes.find(entry => entry.ttl <= 0) ?? this.flashes[this.sequence % MAX_MUZZLE_LIGHTS]!;
        flash.root.position.copy(this.position); flash.root.quaternion.setFromUnitVectors(this.forward, this.direction);
        flash.flame.rotation.z = (this.sequence * 2.399963229728653) % (2 * Math.PI);
        flash.flame.scale.setScalar(.9 + (this.sequence % 3) * .1);
        flash.ttl = MUZZLE_FLASH_SECONDS; flash.shooter = shot.shooter;
        flash.flame.visible = true; flash.light.intensity = MUZZLE_LIGHT_INTENSITY;
      }
      this.sequence++;
    }
  }

  /** Age old effects before adding this frame's shots, so a fresh flash gets one visible frame. */
  update(dt: number, resolveMuzzle?: MuzzleResolver): void {
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    for (const tracer of this.tracers) {
      tracer.ttl = Math.max(0, tracer.ttl - dt); tracer.line.visible = tracer.ttl > 0;
    }
    for (const flash of this.flashes) {
      flash.ttl = Math.max(0, flash.ttl - dt);
      if (flash.ttl > 0 && flash.shooter && resolveMuzzle) {
        if (resolveMuzzle(flash.shooter, this.position, this.direction)) {
          flash.root.position.copy(this.position); flash.root.quaternion.setFromUnitVectors(this.forward, this.direction);
        } else flash.ttl = 0;
      }
      const weight = flash.ttl / MUZZLE_FLASH_SECONDS;
      flash.flame.visible = weight > 0;
      flash.light.intensity = MUZZLE_LIGHT_INTENSITY * weight * weight;
      if (flash.ttl === 0) flash.shooter = null;
    }
  }

  reset(): void {
    for (const tracer of this.tracers) { tracer.ttl = 0; tracer.line.visible = false; }
    for (const flash of this.flashes) { flash.ttl = 0; flash.shooter = null; flash.flame.visible = false; flash.light.intensity = 0; }
    this.sequence = 0;
  }

  /** Holstering ends this weapon's light; already emitted ballistic tracers retain their own lifetime. */
  cancelShooter(shooter: string): void {
    for (const flash of this.flashes) if (flash.shooter === shooter) {
      flash.ttl = 0; flash.shooter = null; flash.flame.visible = false; flash.light.intensity = 0;
    }
  }

  /** The pooled tracer and flash materials and geometries, so the startup warm-up can compile them before the first shot. */
  get parts(): { readonly tracer: THREE.LineBasicMaterial; readonly flash: THREE.MeshBasicMaterial; readonly core: THREE.MeshBasicMaterial;
    readonly flashGeometry: THREE.BufferGeometry; readonly coreGeometry: THREE.BufferGeometry } {
    return { tracer: this.tracerMaterial, flash: this.flashMaterial, core: this.coreMaterial, flashGeometry: this.flashGeometry, coreGeometry: this.coreGeometry };
  }

  /** Read-only review evidence from the actual pooled scene lights, never evaluated by ordinary frames. */
  snapshot(): ShootingEffectsSnapshot {
    return { activeTracers: this.tracers.filter(tracer => tracer.line.visible).length,
      flashes: this.flashes.map(flash => ({ shooter: flash.shooter, remainingSeconds: flash.ttl,
        visible: flash.flame.visible, intensity: flash.light.intensity, color: flash.light.color.toArray(),
        position: flash.light.getWorldPosition(new THREE.Vector3()).toArray(), range: flash.light.distance,
        castsShadow: flash.light.castShadow })) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.reset();
    for (const tracer of this.tracers) tracer.line.geometry.dispose();
    for (const flash of this.flashes) flash.light.dispose();
    this.tracerMaterial.dispose(); this.flashMaterial.dispose(); this.coreMaterial.dispose();
    this.flashGeometry.dispose(); this.coreGeometry.dispose();
    this.group.removeFromParent(); this.group.clear();
  }
}
