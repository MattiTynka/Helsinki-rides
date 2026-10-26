import * as THREE from 'three';
import type { CharacterState } from '@helsinki/sim';
import { LOCOMOTION_SPEED } from './locomotion.ts';

/** Stable identity gives each walker its own foot cycle without changing cadence or stride distance. */
export function pedestrianGaitPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

const limit = (value: number, maximum: number) => Math.max(-maximum, Math.min(maximum, value));
const smoothstep = (low: number, high: number, value: number) => { const t = Math.max(0, Math.min(1, (value - low) / (high - low))); return t * t * (3 - 2 * t); };
const GAIT_CLIPS = new Set(['idle', 'walk', 'run', 'sprint']);
/**
 * Extra fore-aft upper-arm swing while running (motion-design runtime layer): the Kimodo run and sprint carry the arms
 * close to the chest, which reads as jogging; fleeing pumps them. A share of each arm's swing about the two arms' mean.
 */
export const RUN_ARM_SWING = { run: 0.35, sprint: 0.5 } as const;

/** Small turn anticipation and running arm swing on the accepted civilian skeleton; feet and authored posture stay intact. */
export class PedestrianAnimation {
  private readonly chest: THREE.Object3D | undefined;
  private readonly head: THREE.Object3D | undefined;
  private readonly arms: readonly { readonly upper: THREE.Object3D; readonly lower: THREE.Object3D }[];
  private readonly restored = new Map<THREE.Object3D, { rotation: THREE.Quaternion; dirty: boolean }>();
  private previousYaw: number | null = null;
  private turnRate = 0;
  private readonly parentRotation = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();

  constructor(root: THREE.Object3D) {
    this.chest = root.getObjectByName('Spine2');
    this.head = root.getObjectByName('Head');
    this.arms = ['Left', 'Right'].flatMap(side => {
      const upper = root.getObjectByName(`${side}Arm`), lower = root.getObjectByName(`${side}ForeArm`);
      return upper && lower ? [{ upper, lower }] : [];
    });
    for (const node of [this.chest, this.head, ...this.arms.map(arm => arm.upper)]) if (node) this.restored.set(node, { rotation: new THREE.Quaternion(), dirty: false });
  }

  restore(): void {
    for (const [node, saved] of this.restored) if (saved.dirty) { node.quaternion.copy(saved.rotation); saved.dirty = false; }
  }

  apply(state: CharacterState, dt: number, collapsed: boolean, jumpWeight = 0): void {
    const previous = this.previousYaw;
    this.previousYaw = state.yaw;
    const walking = state.alive && !collapsed && state.grounded && state.inVehicle === null && GAIT_CLIPS.has(state.clip);
    if (!walking) { this.turnRate = 0; return; }
    this.swingArms(state, 1 - jumpWeight);
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

  private swingArms(state: CharacterState, share: number): void {
    const speed = state.speed, extra = share * (RUN_ARM_SWING.run * smoothstep(LOCOMOTION_SPEED.walk, LOCOMOTION_SPEED.run, speed)
      + (RUN_ARM_SWING.sprint - RUN_ARM_SWING.run) * smoothstep(LOCOMOTION_SPEED.run, LOCOMOTION_SPEED.sprint, speed));
    if (extra < 1e-3 || this.arms.length !== 2) return;
    // Character forward is +Z at yaw 0; + about its right axis swings an upper arm forward.
    const forward = this.axis.set(Math.sin(state.yaw), 0, Math.cos(state.yaw)).clone(), right = new THREE.Vector3(-forward.z, 0, forward.x);
    const swing = this.arms.map(({ upper, lower }) => {
      upper.updateWorldMatrix(true, true);
      const d = lower.getWorldPosition(new THREE.Vector3()).sub(upper.getWorldPosition(new THREE.Vector3()));
      return Math.atan2(d.dot(forward), -d.y);
    });
    const mean = (swing[0]! + swing[1]!) / 2;
    this.arms.forEach(({ upper }, i) => this.rotate(upper, right.x, right.y, right.z, (swing[i]! - mean) * extra));
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
