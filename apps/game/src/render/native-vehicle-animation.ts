import * as THREE from 'three';
import type { PlayerState, VehicleClip, VehicleState } from '@helsinki/sim';
import type { VehicleDefinition } from '@helsinki/world-schema';
import poseData from '../../../../content/assets/finn-vehicle-poses.json' with { type: 'json' };
import kaamosPoseData from '../../../../content/assets/finn-vehicle-poses-kaamos.json' with { type: 'json' };
import revontuliPoseData from '../../../../content/assets/finn-vehicle-poses-revontuli.json' with { type: 'json' };

interface PoseFrame {
  readonly time: number;
  readonly rotations: Readonly<Record<string, readonly number[]>>;
  readonly hips: readonly number[];
}
export interface PoseClip {
  readonly duration: number;
  /** The door the clip opens; null for the windshield exit. */
  readonly door: string | null;
  readonly frames: readonly PoseFrame[];
  readonly doorCurve: readonly { readonly time: number; readonly value: number }[];
}
export interface VehiclePoses {
  readonly schemaVersion: number;
  readonly stage: readonly number[];
  readonly entryYawDeg: number;
  readonly exitYawDeg: number;
  readonly clips: Readonly<Record<VehicleClip, PoseClip>>;
}
export const VEHICLE_POSES = poseData as VehiclePoses;
/** Finn's clip sets by the car definition's `interaction.poses`, each authored in that car's cabin. */
const POSE_SETS: Readonly<Record<string, VehiclePoses>> = {
  'lumi-gt': VEHICLE_POSES, revontuli: revontuliPoseData as VehiclePoses, kaamos: kaamosPoseData as VehiclePoses,
};

/** The clip set fitted to this car; a car without its own uses the Lumi GT's. */
export function vehiclePoses(def: VehicleDefinition | null | undefined): VehiclePoses {
  const id = def?.interaction?.poses ?? 'lumi-gt';
  const set = POSE_SETS[id];
  if (!set) throw new Error(`Finn vehicle pose set ${id} missing`);
  return set;
}
type Interaction = PlayerState['vehicleInteraction'];

/** Blend from the walking mixer pose into the first entry frame, and from the last exit frame back to it. */
export const VEHICLE_POSE_BLEND_IN = 0.2;
export const VEHICLE_POSE_RELEASE = 0.2;
/** The walk-up may stop short of the stage; this long the entry takes to settle onto the authored path. */
export const VEHICLE_ROOT_WARP = 0.3;

const smooth = (x: number): number => { const t = THREE.MathUtils.clamp(x, 0, 1); return t * t * (3 - 2 * t); };

export function vehiclePoseSample(interaction: Interaction, poses = VEHICLE_POSES): { clip: PoseClip; time: number; seconds: number } | null {
  if (!interaction || interaction.stage === 'approach') return null;
  const clip = poses.clips[interaction.clip];
  const time = THREE.MathUtils.clamp(interaction.progress, 0, 1);
  return { clip, time, seconds: time * clip.duration };
}

/** The same authored clock moves the door and body; a damping delay can otherwise trap a leg in the door. */
export function vehicleDoorOpen(interaction: Interaction, door: string, poses = VEHICLE_POSES): number {
  const sample = vehiclePoseSample(interaction, poses);
  if (!sample || sample.clip.door !== door) return 0;
  const curve = sample.clip.doorCurve;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!, b = curve[i]!;
    if (sample.time <= b.time) {
      const t = THREE.MathUtils.clamp((sample.time - a.time) / (b.time - a.time), 0, 1);
      // Easing is already baked into the authored samples; easing each interval would pulse the door speed.
      return THREE.MathUtils.lerp(a.value, b.value, t);
    }
  }
  return curve[curve.length - 1]!.value;
}

/** A car-local, non-looping pose layer on Finn's existing 71-joint skin. Physics retains the capsule. */
export class NativeVehicleAnimation {
  private readonly bones = new Map<string, THREE.Object3D>();
  private readonly saved = new Map<THREE.Object3D, { q: THREE.Quaternion; p: THREE.Vector3 }>();
  /** The last applied pose, held after release and faded into the mixer pose. */
  private readonly last = new Map<THREE.Object3D, THREE.Quaternion>();
  private readonly lastHips = new THREE.Matrix4();
  private readonly hips: THREE.Object3D;
  private readonly a = new THREE.Quaternion();
  private readonly b = new THREE.Quaternion();
  private readonly m = new THREE.Matrix4();
  private readonly mixerHips = new THREE.Matrix4();
  private readonly inverse = new THREE.Matrix4();
  private readonly pa = new THREE.Vector3();
  private readonly pb = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly warp = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private applied = false;
  private releasing = 0;

  constructor(model: THREE.Object3D) {
    for (const name of Object.keys(VEHICLE_POSES.clips.enter.frames[0]!.rotations)) {
      const node = model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)) ?? model.getObjectByName(name);
      if (!node) throw new Error(`Finn vehicle pose is missing joint ${name}`);
      this.bones.set(name, node);
      this.saved.set(node, { q: new THREE.Quaternion(), p: new THREE.Vector3() });
      this.last.set(node, new THREE.Quaternion());
    }
    const hips = model.getObjectByName('DEF-Hips');
    if (!hips) throw new Error('Finn vehicle pose requires DEF-Hips');
    this.hips = hips;
  }

  /** Remove the previous override before the ordinary animation mixer evaluates this frame. */
  restore(): void {
    if (!this.applied) return;
    for (const [node, saved] of this.saved) { node.quaternion.copy(saved.q); node.position.copy(saved.p); }
    this.applied = false;
  }

  /**
   * Pose Finn in the car's frame. The root follows the car; at the start of the entry it is warped from where the
   * walk-up actually stopped, and the bones blend in from the mixer pose. When the layer lets go, its last pose fades
   * into the mixer over VEHICLE_POSE_RELEASE seconds. Returns whether the car layer owns the body this frame.
   */
  apply(root: THREE.Object3D, interaction: Interaction, vehicle: VehicleState | undefined, dt = 0, poses = VEHICLE_POSES): boolean {
    const sample = vehiclePoseSample(interaction, poses);
    if (!sample || !vehicle || !interaction) { this.release(root, dt); return false; }
    const enter = interaction.clip === 'enter' && interaction.stage === 'enter';
    const blend = enter ? smooth(sample.seconds / VEHICLE_POSE_BLEND_IN) : 1;
    if (blend < 1) { root.updateMatrixWorld(true); this.mixerHips.copy(this.hips.matrixWorld); }
    const frames = sample.clip.frames;
    // Samples carry explicit times so authoring can concentrate keys around foot and hand contacts.
    let index = 0;
    while (index < frames.length - 2 && frames[index + 1]!.time < sample.time) index++;
    const left = frames[index]!, right = frames[index + 1]!;
    const t = THREE.MathUtils.clamp((sample.time - left.time) / (right.time - left.time), 0, 1);
    for (const [name, node] of this.bones) {
      const saved = this.saved.get(node)!;
      saved.q.copy(node.quaternion); saved.p.copy(node.position);
      this.a.fromArray(left.rotations[name]!).normalize(); this.b.fromArray(right.rotations[name]!).normalize();
      this.a.slerp(this.b, t);
      if (node === this.hips) node.quaternion.copy(this.a);
      else node.quaternion.slerp(this.a, blend);
    }
    this.hips.position.set(
      THREE.MathUtils.lerp(left.hips[0]!, right.hips[0]!, t),
      THREE.MathUtils.lerp(left.hips[1]!, right.hips[1]!, t),
      THREE.MathUtils.lerp(left.hips[2]!, right.hips[2]!, t),
    );
    root.position.fromArray(vehicle.position);
    root.quaternion.fromArray(vehicle.rotation);
    const warp = enter ? 1 - smooth(sample.seconds / VEHICLE_ROOT_WARP) : 0;
    if (warp > 0) {
      // Rotate the remaining heading error about the staging point, then shift by the remaining position error.
      const [x, z, yaw] = interaction.startOffset;
      this.pivot.fromArray(poses.stage).applyQuaternion(root.quaternion);
      this.offset.set(x * warp, 0, z * warp).applyQuaternion(root.quaternion);
      this.warp.setFromAxisAngle(this.up, yaw * warp);
      root.position.add(this.pivot).sub(this.pb.copy(this.pivot).applyQuaternion(this.warp)).add(this.offset);
      root.quaternion.premultiply(this.warp);
    }
    root.visible = true;
    root.updateMatrixWorld(true);
    if (blend < 1) this.blendHips(this.mixerHips, blend);
    for (const [node, q] of this.last) q.copy(node.quaternion);
    this.lastHips.copy(this.hips.matrixWorld);
    this.applied = true;
    this.releasing = VEHICLE_POSE_RELEASE;
    return true;
  }

  /** Fade the last vehicle pose into the mixer pose that has just been evaluated. */
  private release(root: THREE.Object3D, dt: number): void {
    if (this.releasing <= 0) return;
    this.releasing = Math.max(0, this.releasing - dt);
    const weight = smooth(this.releasing / VEHICLE_POSE_RELEASE);
    if (weight <= 0) return;
    root.updateMatrixWorld(true);
    this.m.copy(this.hips.matrixWorld);
    for (const [node, saved] of this.saved) {
      saved.q.copy(node.quaternion); saved.p.copy(node.position);
      if (node !== this.hips) node.quaternion.slerp(this.last.get(node)!, weight);
    }
    // Hips are matched in world space: the vehicle pose was posed in the car's frame, the mixer in Finn's.
    this.blendHips(this.mixerHips.copy(this.m), weight, this.lastHips);
    this.applied = true;
  }

  /** Set the hips to `weight` of the way from `from` (world) to their current world transform, or to `to`. */
  private blendHips(from: THREE.Matrix4, weight: number, to = this.hips.matrixWorld): void {
    to.decompose(this.pb, this.b, this.scale);
    from.decompose(this.pa, this.a, this.scale);
    this.pa.lerp(this.pb, weight); this.a.slerp(this.b, weight);
    this.m.compose(this.pa, this.a, this.scale);
    const parent = this.hips.parent!;
    parent.updateWorldMatrix(true, false);
    this.m.premultiply(this.inverse.copy(parent.matrixWorld).invert());
    this.m.decompose(this.hips.position, this.hips.quaternion, this.scale);
    this.hips.updateMatrixWorld(true);
  }
}
