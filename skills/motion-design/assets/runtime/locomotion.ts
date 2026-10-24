import * as THREE from 'three';

/**
 * Runtime half of the motion-design pipeline for three.js (r150+): blends the in-place locomotion loops
 * listed in <char>.clips.json (make_manifest.py) by travel direction and speed, on one shared gait phase,
 * plus the procedural arm-swing widening used for running. Extracted from the Snow game's character controller.
 *
 * Contract with the exporter: every loop starts at the left-foot strike and holds exactly one gait cycle,
 * so normalised time is the same phase in every clip. The controller owns world translation (clips are in place).
 */
export type Dir = 'forward' | 'back' | 'left' | 'right';
export interface ClipMeta { name: string; loop: boolean; speed: number; dir?: Dir }

interface Loop { meta: ClipMeta; action: THREE.AnimationAction; duration: number }

export class Locomotion {
  readonly weights: Record<string, number> = {};
  private readonly loops: Loop[] = [];
  private idle?: THREE.AnimationAction;
  private phase = 0;

  constructor(mixer: THREE.AnimationMixer, clips: THREE.AnimationClip[], manifest: ClipMeta[]) {
    const byName = new Map(clips.map((c) => [c.name, c]));
    for (const meta of manifest) {
      const clip = byName.get(meta.name);
      if (!clip) continue;
      const action = mixer.clipAction(clip);
      action.play();
      action.setEffectiveWeight(0);
      if (meta.speed > 0) {
        action.setEffectiveTimeScale(0); // time is driven by the shared gait phase
        this.loops.push({ meta, action, duration: clip.duration });
      } else if (meta.name === 'idle') {
        this.idle = action;
      }
    }
    this.loops.sort((a, b) => a.meta.speed - b.meta.speed);
  }

  /** Speed of a named clip (m/s), e.g. to ramp procedural layers between walk and run. */
  speedOf(name: string, fallback: number): number {
    return this.loops.find((l) => l.meta.name === name)?.meta.speed ?? fallback;
  }

  /**
   * Set clip weights and times for this step; call before mixer.update(dt).
   * `local` is the planar velocity in the character frame: x = character left, y = forward (m/s).
   */
  update(dt: number, local: THREE.Vector2): void {
    for (const k of Object.keys(this.weights)) this.weights[k] = 0;
    const speed = local.length();
    const dirW: Record<Dir, number> = { forward: 0, back: 0, left: 0, right: 0 };
    if (speed > 1e-3) {
      const c = local.y / speed, s = local.x / speed;
      dirW.forward = Math.max(0, c); dirW.back = Math.max(0, -c);
      dirW.left = Math.max(0, s); dirW.right = Math.max(0, -s);
    } else dirW.forward = 1;
    const weights = new Map<Loop, number>();
    let missing = 0;
    for (const dir of Object.keys(dirW) as Dir[]) {
      const w = dirW[dir];
      if (w <= 0) continue;
      const set = this.loops.filter((l) => (l.meta.dir ?? 'forward') === dir);
      if (!set.length) { missing += w; continue; }
      bracket(set, speed, w, weights);
    }
    if (missing > 0) bracket(this.loops.filter((l) => (l.meta.dir ?? 'forward') === 'forward'), speed, missing, weights);

    let dur = 0, clipSpeed = 0, total = 0;
    for (const [l, w] of weights) { dur += w * l.duration; clipSpeed += w * l.meta.speed; total += w; }
    const minSpeed = this.loops.length ? this.loops[0].meta.speed : 1;
    const idleW = this.idle ? 1 - THREE.MathUtils.smoothstep(speed, 0.05, minSpeed * 0.55) : 0;
    if (total > 0 && dur > 0) {
      // playback rate follows the actual speed so planted feet do not skate between clip speeds
      const rate = clipSpeed > 0 ? THREE.MathUtils.clamp(speed / clipSpeed, 0.35, 1.6) : 1;
      this.phase = (this.phase + (dt / (dur / total)) * rate) % 1;
    }
    for (const l of this.loops) {
      const w = (weights.get(l) ?? 0) / Math.max(total, 1e-6) * (1 - idleW);
      l.action.setEffectiveWeight(w);
      l.action.time = this.phase * l.duration;
      this.weights[l.meta.name] = w;
    }
    if (this.idle) { this.idle.setEffectiveWeight(idleW); this.weights.idle = idleW; }
  }
}

/** Split weight w between the two clips whose speeds bracket `speed` (clamped at the ends). */
function bracket(set: Loop[], speed: number, w: number, out: Map<Loop, number>): void {
  if (speed <= set[0].meta.speed || set.length === 1) { out.set(set[0], (out.get(set[0]) ?? 0) + w); return; }
  for (let i = 0; i < set.length - 1; i++) {
    const a = set[i], b = set[i + 1];
    if (speed <= b.meta.speed) {
      const t = (speed - a.meta.speed) / (b.meta.speed - a.meta.speed);
      out.set(a, (out.get(a) ?? 0) + w * (1 - t));
      out.set(b, (out.get(b) ?? 0) + w * t);
      return;
    }
  }
  const last = set[set.length - 1];
  out.set(last, (out.get(last) ?? 0) + w);
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/** Pre-multiply a world-space rotation onto a bone, keeping its parent unchanged. */
export function rotateBoneWorld(bone: THREE.Object3D, worldRot: THREE.Quaternion): void {
  bone.parent!.getWorldQuaternion(_q);
  _q2.copy(_q).invert().multiply(worldRot).multiply(_q);
  bone.quaternion.premultiply(_q2);
  bone.updateMatrixWorld(true);
}

export interface ArmChain { upper: THREE.Object3D; lower: THREE.Object3D }

/**
 * Widen each upper arm's fore-aft swing by `extra` (0.35 = 35 % more) about the two arms' mean angle.
 * The arms swing in antiphase, so their mean is the cycle centre with no lag or state.
 * Call after mixer.update(); ramp `extra` with speed, e.g. extra = 0.35 * smoothstep(speed, walk, run),
 * and fade it out when the arms are driven by IK (weapon, interaction).
 * `fwd`/`right` are the character's world forward and right axes.
 */
export function widenArmSwing(L: ArmChain, R: ArmChain, fwd: THREE.Vector3, right: THREE.Vector3, extra: number): void {
  if (extra < 1e-3) return;
  const swing = (c: ArmChain) => {
    const d = c.lower.getWorldPosition(new THREE.Vector3()).sub(c.upper.getWorldPosition(new THREE.Vector3()));
    return Math.atan2(d.dot(fwd), -d.y); // 0 = hanging, + = forward
  };
  const aL = swing(L), aR = swing(R), mid = (aL + aR) / 2;
  // + about the character's right = upper arm swings forward
  rotateBoneWorld(L.upper, new THREE.Quaternion().setFromAxisAngle(right, (aL - mid) * extra));
  rotateBoneWorld(R.upper, new THREE.Quaternion().setFromAxisAngle(right, (aR - mid) * extra));
}
