import * as THREE from 'three';
import type { CharacterState } from '@helsinki/sim';

/** Stable identity gives each walker its own foot cycle without changing cadence or stride distance. */
export function pedestrianGaitPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

const limit = (value: number, maximum: number) => Math.max(-maximum, Math.min(maximum, value));

/** Small turn anticipation on the accepted civilian skeleton; feet and authored posture stay intact. */
export class PedestrianAnimation {
  private readonly chest: THREE.Object3D | undefined;
  private readonly head: THREE.Object3D | undefined;
  private readonly restored = new Map<THREE.Object3D, { rotation: THREE.Quaternion; dirty: boolean }>();
  private previousYaw: number | null = null;
  private turnRate = 0;
  private readonly parentRotation = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();

  constructor(root: THREE.Object3D) {
    this.chest = root.getObjectByName('Spine2');
    this.head = root.getObjectByName('Head');
    for (const node of [this.chest, this.head]) if (node) this.restored.set(node, { rotation: new THREE.Quaternion(), dirty: false });
  }

  restore(): void {
    for (const [node, saved] of this.restored) if (saved.dirty) { node.quaternion.copy(saved.rotation); saved.dirty = false; }
  }

  apply(state: CharacterState, dt: number, collapsed: boolean): void {
    const previous = this.previousYaw;
    this.previousYaw = state.yaw;
    const walking = state.alive && !collapsed && state.grounded && state.inVehicle === null
      && (state.clip === 'walk' || state.clip === 'idle');
    if (!walking) { this.turnRate = 0; return; }
    const delta = previous === null ? 0 : Math.atan2(Math.sin(state.yaw - previous), Math.cos(state.yaw - previous));
    // A discontinuous placement is not a physical turn.
    if (Math.abs(delta) >= 1) this.turnRate = 0;
    else if (dt > 0 && Number.isFinite(dt)) {
      const rate = limit(delta / dt, 4);
      this.turnRate += (rate - this.turnRate) * (1 - Math.exp(-8 * dt));
    }
    this.rotate(this.head, 0, 1, 0, limit(this.turnRate * .09, .18));
    this.rotate(this.chest, 0, 1, 0, limit(this.turnRate * .02, .05));
    const bank = limit(-this.turnRate * Math.min(state.speed, 1.4) * .015, .04);
    this.rotate(this.chest, Math.sin(state.yaw), 0, Math.cos(state.yaw), bank);
  }

  private rotate(node: THREE.Object3D | undefined, x: number, y: number, z: number, angle: number): void {
    if (!node?.parent || Math.abs(angle) < 1e-6) return;
    const saved = this.restored.get(node)!;
    if (!saved.dirty) { saved.rotation.copy(node.quaternion); saved.dirty = true; }
    node.parent.getWorldQuaternion(this.parentRotation).invert();
    this.axis.set(x, y, z).applyQuaternion(this.parentRotation);
    node.quaternion.premultiply(this.rotation.setFromAxisAngle(this.axis, angle));
  }
}
