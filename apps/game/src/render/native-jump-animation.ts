import * as THREE from 'three';
import { JUMP, TICK_SECONDS, type CharacterState, type ClimbView, type JumpPhase } from '@helsinki/sim';
import poseData from '../../../../content/assets/finn-jump-poses.json' with { type: 'json' };

interface ClipRecord {
  readonly seconds?: number;
  readonly loop?: boolean;
  readonly tracks: readonly { readonly node: string; readonly path: string; readonly times: number[]; readonly values: number[] }[];
}
export interface ClimbVariant {
  readonly clip: string;
  readonly height: number;
  /** Hand grip weight per sample over the climb. */
  readonly grip: readonly number[];
  /** Per sample: left then right wrist offsets from the edge (lateral toward the climber's left, onto the top, up). */
  readonly wrists: readonly (readonly number[])[];
}
interface PoseFile {
  readonly nativeJoints: number;
  readonly climb: { readonly radius: number; readonly riseFraction: number; readonly lift: number; readonly wallGap: number; readonly inset: number;
    readonly baseSeconds: number; readonly perMetreSeconds: number; readonly variants: readonly ClimbVariant[] };
  readonly clips: Readonly<Record<string, ClipRecord>>;
}
export const JUMP_POSES = poseData as unknown as PoseFile;
/** Per climb variant, the six wrist-offset columns as curves over u. */
const WRIST_CURVES = JUMP_POSES.climb.variants.map(variant => [0, 1, 2, 3, 4, 5].map(c => variant.wrists.map(sample => sample[c]!)));

type Style = 'stand' | 'runL' | 'runR';
type Phase = 'takeoff' | 'rise' | 'fall' | 'land';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };
/** Running jumps take over from standing ones between these take-off speeds (m/s). */
const RUN_FROM = 1.6, RUN_FULL = 3.2;
/** A super jump landing harder than this ends in the crouched hand-down landing (m/s). */
const HERO_IMPACT = 5.5;
/** Falls longer than this (s) blend into the airborne balance loop. */
const LONG_FALL = 1.1;
const AIR_LOOP_SECONDS = 1.2;

export function jumpLaunchSpeed(kind: 'normal' | 'super'): number {
  return Math.sqrt(2 * JUMP.gravity * (kind === 'super' ? JUMP.superHeight : JUMP.normalHeight)) + JUMP.gravity * TICK_SECONDS / 2;
}

/** Linear sample of a per-sample curve over u in [0, 1]. */
export function sampleCurve(values: readonly number[], u: number): number {
  const x = clamp(u) * (values.length - 1), i = Math.min(values.length - 2, Math.floor(x));
  return i < 0 ? values[0]! : values[i]! + (values[i + 1]! - values[i]!) * (x - i);
}

/** Weights of the authored climb heights for a ledge `height` above the feet (piecewise linear, clamped). */
export function climbVariantWeights(height: number, variants: readonly Pick<ClimbVariant, 'height'>[] = JUMP_POSES.climb.variants): number[] {
  const weights = variants.map(() => 0);
  if (height <= variants[0]!.height) { weights[0] = 1; return weights; }
  for (let i = 0; i < variants.length - 1; i++) {
    const a = variants[i]!.height, b = variants[i + 1]!.height;
    if (height <= b) { const t = (height - a) / (b - a); weights[i] = 1 - t; weights[i + 1] = t; return weights; }
  }
  weights[weights.length - 1] = 1;
  return weights;
}

export interface JumpPose {
  /** False when no jump presentation may show (death, arrest, vehicle): every jump weight drops at once. */
  readonly valid: boolean;
  /** Clip -> normalized time and target weight. */
  readonly clips: ReadonlyMap<string, { readonly time: number; readonly weight: number }>;
  /** Set on the frame of a running touchdown: the gait phase whose foot just landed. */
  readonly gaitPhase: number | null;
  readonly climb: { readonly view: ClimbView; readonly grip: number; readonly wrists: readonly number[] } | null;
}

export function hasJumpPose(state: Pick<CharacterState, 'alive' | 'inVehicle' | 'clip' | 'jumpPhase'>): boolean {
  return state.alive && state.inVehicle === null && state.clip !== 'arrested' && !!state.jumpPhase && state.jumpPhase !== 'grounded';
}

type JumpInput = Pick<CharacterState, 'alive' | 'inVehicle' | 'clip' | 'speed' | 'verticalSpeed' | 'groundDistance' | 'jumpPhase' | 'jumpPhaseTime' | 'jumpKind' | 'landingSpeed' | 'climb'>;

/**
 * Presentation memory of one character's jump. The simulation state chooses every pose clock: take-off by
 * phase time, rise by vertical speed, fall by time to contact, climbs by climb progress. Only what the state
 * cannot say is kept here: the style latched at take-off and how long a landing has been absorbing.
 */
export class JumpPoseState {
  private phase: JumpPhase | null = null;
  private run = 0;
  private foot: 'L' | 'R' = 'L';
  private superBlend = 0;
  private fallU = 0;
  private airClock = 0;
  /** Airborne without a jump (walked off an edge): no take-off, no apex tuck. */
  private walkOff = false;
  /** How much of the latest fall was shown; a landing is never stronger than the fall before it. */
  private presence = 1;
  private landing: { time: number; super: boolean; intensity: number } | null = null;

  step(state: JumpInput, dt: number, gaitPhase: number): JumpPose {
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const clips = new Map<string, { time: number; weight: number }>();
    if (!state.alive || state.inVehicle !== null || state.clip === 'arrested' || !state.jumpPhase) {
      this.phase = null; this.landing = null; this.superBlend = 0;
      return { valid: false, clips, gaitPhase: null, climb: null };
    }
    const phase = state.jumpPhase, previous = this.phase;
    this.phase = phase;
    const leftGround = previous === null || previous === 'grounded' || previous === 'land';
    if (phase !== previous && leftGround && (phase === 'takeoff' || phase === 'rise' || phase === 'fall')) {
      // Style is chosen when the feet leave the ground: running take-offs push from the stance foot.
      this.run = smooth((state.speed - RUN_FROM) / (RUN_FULL - RUN_FROM));
      this.foot = ((gaitPhase + .12) % 1 + 1) % 1 < .5 ? 'L' : 'R';
      this.superBlend = state.jumpKind === 'super' ? 1 : 0;
      this.landing = null; this.airClock = 0; this.fallU = 0;
      this.walkOff = phase === 'fall' && state.jumpKind === null;
      this.presence = 1;
    }
    if (phase === 'takeoff' || phase === 'rise' || phase === 'fall')
      this.superBlend += ((state.jumpKind === 'super' ? 1 : 0) - this.superBlend) * (1 - Math.exp(-dt * 22));
    const add = (key: string, time: number, weight: number) => {
      if (weight <= 0) return;
      const entry = clips.get(key);
      if (entry) entry.weight += weight; else clips.set(key, { time: clamp(time), weight });
    };
    const runStyle: Style = this.foot === 'L' ? 'runL' : 'runR';
    const styled = (kind: 'normal' | 'super', p: Phase, time: (style: Style) => number, weight: (style: Style) => number) => {
      for (const [style, share] of [['stand', 1 - this.run], [runStyle, this.run]] as const)
        if (share > 0) add(`${kind}_${style}_${p}`, time(style), share * weight(style));
    };
    const both = (p: Phase, time: number, weight = 1) => {
      styled('normal', p, () => time, () => weight * (1 - this.superBlend));
      styled('super', p, () => time, () => weight * this.superBlend);
    };
    let touchdownPhase: number | null = null;
    if (phase === 'takeoff') both('takeoff', state.jumpPhaseTime / JUMP.takeoffSeconds);
    else if (phase === 'rise') {
      const v0 = jumpLaunchSpeed(state.jumpKind === 'super' ? 'super' : 'normal');
      both('rise', 1 - state.verticalSpeed / v0);
    } else if (phase === 'fall') {
      // Time to contact with the support actually below (car roofs, platforms, the street).
      const t = state.jumpPhaseTime, down = Math.max(0, -state.verticalSpeed), h = state.groundDistance;
      const contact = h === null ? Infinity : (Math.sqrt(down * down + 2 * JUMP.gravity * Math.max(0, h)) - down) / JUMP.gravity;
      const total = t + contact;
      let target: number, air = 0;
      if (total <= LONG_FALL) target = total > 0 ? t / total : 1;
      else {
        target = contact < .55 ? .45 + .55 * (1 - contact / .55) : .45 * Math.min(1, t / .35);
        air = smooth((t - .2) / .3) * (contact === Infinity ? 1 : smooth((contact - .4) / .25));
      }
      // Stepping off an edge starts with the legs already reaching; a curb-height drop shows nothing.
      if (this.walkOff) target = .7 + .3 * target;
      const presence = this.presence = this.walkOff ? smooth((total - .12) / .2) : 1;
      // A rate-limited follower: a support appearing or vanishing below never snaps the legs.
      this.fallU = phase !== previous ? target : this.fallU + Math.max(-1.5 * dt, Math.min(5 * dt, target - this.fallU));
      this.airClock += dt;
      both('fall', this.fallU, (1 - air) * presence);
      add('air_loop', (this.airClock / AIR_LOOP_SECONDS) % 1, air);
    } else if (phase === 'climb' && state.climb) {
      this.landing = null;
      const u = clamp(state.jumpPhaseTime / state.climb.duration), weights = climbVariantWeights(state.climb.height);
      let grip = 0;
      const wrists = [0, 0, 0, 0, 0, 0];
      JUMP_POSES.climb.variants.forEach((variant, i) => {
        const w = weights[i]!;
        if (w <= 0) return;
        add(variant.clip, u, w);
        grip += w * sampleCurve(variant.grip, u);
        for (let c = 0; c < 6; c++) wrists[c] = wrists[c]! + w * sampleCurve(WRIST_CURVES[i]![c]!, u);
      });
      return { valid: true, clips, gaitPhase: null, climb: { view: state.climb, grip, wrists } };
    }
    if (phase === 'land' && (phase !== previous || !this.landing)) {
      this.landing = { time: state.jumpPhaseTime, super: this.superBlend > .5 && state.landingSpeed > HERO_IMPACT,
        intensity: smooth((state.landingSpeed - .8) / 2.5) * this.presence };
      if (this.run > .5) touchdownPhase = this.foot === 'L' ? .5 : 0;
    } else if (this.landing && (phase === 'land' || phase === 'grounded')) this.landing.time += dt;
    else if (phase !== 'land' && phase !== 'grounded') this.landing = null;
    if (this.landing && (phase === 'land' || phase === 'grounded')) {
      const landing = this.landing, kind = landing.super ? 'super' : 'normal';
      const seconds = (style: Style) => JUMP_POSES.clips[`${kind}_${style}_land`]?.seconds ?? JUMP.landingSeconds;
      // A standing landing hands over to steering once the impact is absorbed; a running one flows into the stride.
      const steer = state.speed > 1 ? 1 - smooth((landing.time - .1) / .14) : 1;
      styled(kind, 'land', style => landing.time / seconds(style),
        style => landing.intensity * (1 - smooth((landing.time / seconds(style) - .75) / .25)) * (style === 'stand' ? steer : 1));
      if (landing.time >= Math.max(seconds('stand'), seconds(runStyle))) this.landing = null;
    }
    return { valid: true, clips, gaitPhase: touchdownPhase, climb: null };
  }
}

interface ClipActions { readonly full: THREE.AnimationAction; readonly lower: THREE.AnimationAction; readonly smoothing: number; weight: number }
interface ArmChain { readonly upper: THREE.Object3D; readonly fore: THREE.Object3D; readonly hand: THREE.Object3D }

/** Separately authored native71 poses; the accepted mesh, skin and source gaits are untouched. */
export class NativeJumpAnimation {
  private readonly actions = new Map<string, ClipActions>();
  private readonly memory = new JumpPoseState();
  private readonly arms: readonly ArmChain[];
  private readonly saved = new Map<THREE.Object3D, THREE.Quaternion>();
  private climb: JumpPose['climb'] = null;
  private climbWeight = 0;

  constructor(mixer: THREE.AnimationMixer, root: THREE.Object3D, upperTrack: (track: THREE.KeyframeTrack) => boolean) {
    const find = (name: string) => {
      const node = root.getObjectByName(name) ?? root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
      if (!node) throw new Error(`Finn jump bone ${name} missing`);
      return node;
    };
    for (const [key, definition] of Object.entries(JUMP_POSES.clips)) {
      const tracks = definition.tracks.map(track => {
        const node = find(track.node);
        // GLTFLoader's clips bind by the sanitized node name. Reusing that exact
        // binding is essential: a second UUID alias creates competing PropertyMixers.
        const binding = `${node.name}.${track.path}`;
        return track.path === 'quaternion'
          ? new THREE.QuaternionKeyframeTrack(binding, track.times, track.values)
          : new THREE.VectorKeyframeTrack(binding, track.times, track.values);
      });
      const create = (suffix: string, mask: THREE.KeyframeTrack[]) => {
        const action = mixer.clipAction(new THREE.AnimationClip(`__jump_${key}${suffix}`, 1, mask));
        action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true;
        action.setEffectiveWeight(0).play(); action.paused = true;
        return action;
      };
      // Climbs and the airborne loop blend in more slowly than the phase-continuous jump clips.
      const smoothing = key.startsWith('climb_') ? .06 : key === 'air_loop' ? .12 : .035;
      this.actions.set(key, { full: create('', tracks), lower: create('_lower', tracks.filter(track => !upperTrack(track))), smoothing, weight: 0 });
    }
    this.arms = ['.L', '.R'].map(side => ({ upper: find(`DEF-UpperArm_1${side}`), fore: find(`DEF-Forearm_1${side}`), hand: find(`DEF-Wrist${side}`) }));
  }

  /** Undo the previous frame's grip correction before the mixer samples the next authored pose. */
  restore(): void {
    for (const [bone, quaternion] of this.saved) bone.quaternion.copy(quaternion);
    this.saved.clear();
  }

  /** Returns the jump layer's total weight and, at a running touchdown, the gait phase of the landing foot. */
  update(state: CharacterState, dt: number, upperBodyOverlay: boolean, gaitPhase = 0): { weight: number; gaitPhase: number | null } {
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const pose = this.memory.step(state, dt, gaitPhase);
    let total = 0, climb = 0;
    for (const [key, action] of this.actions) {
      const target = pose.clips.get(key);
      if (target) action.full.time = action.lower.time = target.time;
      const goal = pose.valid ? target?.weight ?? 0 : 0;
      // Exact zero once released, so a finished jump never competes with reactions or gait.
      action.weight = !pose.valid ? 0 : action.weight + (goal - action.weight) * (1 - Math.exp(-dt / action.smoothing));
      if (goal === 0 && action.weight < .004) action.weight = 0;
      total += action.weight;
      if (key.startsWith('climb_')) climb += action.weight;
    }
    const scale = total > 1 ? 1 / total : 1;
    for (const action of this.actions.values()) {
      action.full.setEffectiveWeight(upperBodyOverlay ? 0 : action.weight * scale);
      action.lower.setEffectiveWeight(upperBodyOverlay ? action.weight * scale : 0);
    }
    this.climb = pose.climb;
    this.climbWeight = Math.min(1, climb * scale);
    return { weight: Math.min(1, total), gaitPhase: pose.gaitPhase };
  }

  /** After the mixer: pin the hands to the real edge (two-bone arm IK, authored hand orientation kept). */
  applyGrip(model: THREE.Object3D): void {
    const climb = this.climb;
    const weight = climb ? clamp(climb.grip * this.climbWeight) : 0;
    if (!climb || weight <= 1e-3) return;
    model.updateWorldMatrix(true, true);
    const [ex, ey, ez] = climb.view.edge, [nx, nz] = climb.view.normal;
    const inward = new THREE.Vector3(-nx, 0, -nz), up = new THREE.Vector3(0, 1, 0), left = new THREE.Vector3().crossVectors(up, inward);
    this.arms.forEach((arm, i) => {
      const [lateral, onto, height] = climb.wrists.slice(i * 3, i * 3 + 3) as [number, number, number];
      const target = new THREE.Vector3(ex, ey, ez).addScaledVector(left, lateral).addScaledVector(inward, onto).addScaledVector(up, height);
      for (const bone of [arm.upper, arm.fore, arm.hand]) if (!this.saved.has(bone)) this.saved.set(bone, bone.quaternion.clone());
      solveArm(arm, target, weight);
    });
  }
}

const rotateWorld = (bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) => {
  const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  const delta = new THREE.Quaternion().setFromUnitVectors(from, to);
  bone.quaternion.premultiply(parent.clone().invert().multiply(delta).multiply(parent));
  bone.updateWorldMatrix(false, true);
};

function solveArm(arm: ArmChain, target: THREE.Vector3, weight: number): void {
  const a = arm.upper.getWorldPosition(new THREE.Vector3()), b = arm.fore.getWorldPosition(new THREE.Vector3()), c = arm.hand.getWorldPosition(new THREE.Vector3());
  const handRotation = arm.hand.getWorldQuaternion(new THREE.Quaternion());
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const goal = c.clone().lerp(target, weight);
  const toGoal = goal.clone().sub(a), reach = toGoal.length();
  if (reach < 1e-5 || l1 < 1e-5 || l2 < 1e-5) return;
  const dir = toGoal.divideScalar(reach), d = THREE.MathUtils.clamp(reach, Math.abs(l1 - l2) + 1e-4, (l1 + l2) * .999);
  // Keep the animated elbow's bend plane.
  const pole = b.clone().sub(a);
  pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-10) return;
  pole.normalize();
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const elbow = a.clone().addScaledVector(dir, along).addScaledVector(pole, out);
  rotateWorld(arm.upper, b.clone().sub(a).normalize(), elbow.clone().sub(a).normalize());
  const b2 = arm.fore.getWorldPosition(new THREE.Vector3()), c2 = arm.hand.getWorldPosition(new THREE.Vector3());
  rotateWorld(arm.fore, c2.sub(b2).normalize(), goal.clone().sub(b2).normalize());
  const parent = arm.hand.parent!.getWorldQuaternion(new THREE.Quaternion());
  arm.hand.quaternion.copy(parent.invert().multiply(handRotation));
  arm.hand.updateWorldMatrix(false, true);
}
