import * as THREE from 'three';
import type { CharacterState } from '@helsinki/sim';
import { advanceNativeGaitPhase, localTravelDirection, nativeLocomotionWeights, type NativeCharacterProfile } from './native-locomotion.ts';
import { hasJumpPose, NativeJumpAnimation } from './native-jump-animation.ts';

const GAIT_STATES = new Set(['idle', 'walk', 'run', 'sprint']);
const OVERLAY_STATES = new Set(['aim', 'fire']);
const ONE_SHOT = new Set(['fire', 'hit', 'death']);

/** Native hierarchies and supplied clips remain intact; only runtime track masks are derived. */
export class NativeCharacterAnimation {
  readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly lowerActions = new Map<string, THREE.AnimationAction>();
  private readonly durations = new Map<string, number>();
  private readonly movementNames: Set<string>;
  private previousPosition: readonly number[] | null = null;
  private travelDirection: readonly [number, number] = [0, 1];
  private phase = 0;
  private fadeSeconds = .15;
  private readonly mixer: THREE.AnimationMixer;
  private readonly profile: NativeCharacterProfile;
  private jumpAnimation: NativeJumpAnimation | null = null;
  private readonly root: THREE.Object3D;
  private readonly upperTrack: (track: THREE.KeyframeTrack) => boolean;
  private sampledKnockdown: THREE.AnimationAction | null = null;
  current: string | null = null;

  constructor(mixer: THREE.AnimationMixer, root: THREE.Object3D, clips: ReadonlyMap<string, THREE.AnimationClip>, profile: NativeCharacterProfile) {
    this.mixer = mixer;
    this.root = root;
    this.profile = profile;
    this.movementNames = new Set(profile.locomotion.map(entry => entry.clip));
    const upperRoot = root.getObjectByName(profile.upperBodyRoot) ?? root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(profile.upperBodyRoot));
    if (!upperRoot) throw new Error(`Native upper-body root ${profile.upperBodyRoot} missing`);
    const upperNodes = new Set<string>();
    upperRoot.traverse(node => { upperNodes.add(node.name); upperNodes.add(node.uuid); });
    const upperTrack = (track: THREE.KeyframeTrack) => {
      const binding = THREE.PropertyBinding.parseTrackName(track.name);
      return upperNodes.has(binding.nodeName ?? '') || (binding.objectName === 'bones' && upperNodes.has(String(binding.objectIndex)));
    };
    this.upperTrack = upperTrack;
    for (const [name, original] of clips) {
      if (!(original.duration > 0) || !Number.isFinite(original.duration)) throw new Error(`Native clip ${name} has invalid duration`);
      let clip = original;
      if (name === profile.states.aim || name === profile.states.fire) {
        const tracks = original.tracks.filter(upperTrack);
        if (!tracks.length) throw new Error(`Native overlay ${name} has no upper-body tracks`);
        clip = new THREE.AnimationClip(`__upper_${name}`, original.duration, tracks);
      }
      const action = mixer.clipAction(clip);
      const state = Object.entries(profile.states).find(([, clipName]) => clipName === name)?.[0];
      if (state && ONE_SHOT.has(state)) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
      action.setEffectiveWeight(0);
      if (this.movementNames.has(name) || name === profile.states.idle) {
        action.play();
        action.paused = this.movementNames.has(name);
        const tracks = original.tracks.filter(track => !upperTrack(track));
        if (!tracks.length) throw new Error(`Native base ${name} has no lower-body tracks`);
        const lower = mixer.clipAction(new THREE.AnimationClip(`__lower_${name}`, original.duration, tracks));
        lower.setEffectiveWeight(0).play(); lower.paused = action.paused;
        this.lowerActions.set(name, lower);
      }
      this.durations.set(name, original.duration);
      this.actions.set(name, action);
    }
  }

  play(state: string, fade: number): void {
    if (this.current === state) return;
    if (!GAIT_STATES.has(state)) {
      // The same action must be scheduled here and weighted below. Entering fire directly from gait
      // must start the aim pose even if the player never held the aim button beforehand.
      const name = this.profile.states[(state === 'fire' ? 'aim' : state) as keyof typeof this.profile.states];
      const action = name ? this.actions.get(name) : undefined;
      if (!action) throw new Error(`Unsupported native character state ${state}`);
      action.reset().play();
    }
    this.current = state;
    this.fadeSeconds = fade;
    if (fade <= 0) {
      const initial = this.profile.states.idle;
      for (const [name, action] of this.actions) action.setEffectiveWeight(state === 'idle' && name === initial ? 1 : 0);
      for (const action of this.lowerActions.values()) action.setEffectiveWeight(0);
    }
  }

  update(state: CharacterState, dt: number, knockdown: number | null = null): void {
    if (this.sampledKnockdown) { this.sampledKnockdown.paused = false; this.sampledKnockdown = null; }
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.jumpAnimation?.restore();
    if (this.previousPosition && state.inVehicle === null) {
      const dx = state.position[0] - this.previousPosition[0]!, dz = state.position[2] - this.previousPosition[2]!;
      const distance = Math.hypot(dx, dz);
      // Render frames may repeat one fixed-step position. Keep the most recent meaningful direction.
      if (distance > 1e-5 && distance <= Math.max(1, state.speed * dt * 4)) this.travelDirection = localTravelDirection(dx, dz, state.yaw);
      else if (distance > Math.max(1, state.speed * dt * 4)) this.travelDirection = [0, 1];
    }
    this.previousPosition = [...state.position];
    if (state.speed <= .03) this.travelDirection = [0, 1];
    const gait = GAIT_STATES.has(this.current ?? ''), overlay = OVERLAY_STATES.has(this.current ?? '');
    if (this.profile.id === 'snow-native-v1' && !this.jumpAnimation && hasJumpPose(state)) this.jumpAnimation = new NativeJumpAnimation(this.mixer, this.root, this.upperTrack);
    const jump = this.jumpAnimation?.update(state, dt, overlay, this.phase);
    const jumpWeight = jump?.weight ?? 0;
    // A running landing continues the stride from the foot that touched down.
    this.phase = jump?.gaitPhase ?? this.phase;
    const base = gait || overlay ? nativeLocomotionWeights(this.profile, state.speed, ...this.travelDirection) : {};
    const targets: Record<string, number> = {};
    // Shots have an event-driven spring layered after targeting. Keep the authored two-hand aim
    // underneath it, so a held fire state neither freezes an old kick nor doubles its recoil.
    if (!gait) targets[this.profile.states[(this.current === 'fire' ? 'aim' : this.current) as keyof typeof this.profile.states]] = 1;
    if (gait) for (const [name, weight] of Object.entries(base)) targets[name] = weight * (1 - jumpWeight);
    const blend = this.fadeSeconds > 0 ? 1 - Math.exp(-dt * 4 / this.fadeSeconds) : 1;
    for (const [name, action] of this.actions) action.setEffectiveWeight(action.getEffectiveWeight() + ((targets[name] ?? 0) - action.getEffectiveWeight()) * blend);
    for (const [name, action] of this.lowerActions) action.setEffectiveWeight(action.getEffectiveWeight() + ((overlay ? (base[name] ?? 0) * (1 - jumpWeight) : 0) - action.getEffectiveWeight()) * blend);
    if (gait || overlay) {
      const weights: Record<string, number> = {};
      for (const name of this.movementNames) weights[name] = (this.actions.get(name)?.getEffectiveWeight() ?? 0) + (this.lowerActions.get(name)?.getEffectiveWeight() ?? 0);
      this.phase = advanceNativeGaitPhase(this.phase, state.speed, dt, this.profile, weights, this.durations);
    }
    for (const name of this.movementNames) {
      const time = this.phase * this.durations.get(name)!;
      this.actions.get(name)!.time = time;
      this.lowerActions.get(name)!.time = time;
    }
    this.mixer.update(dt);
    this.jumpAnimation?.applyGrip(this.root);
    if (knockdown !== null) {
      const death = this.actions.get(this.profile.states.death)!;
      for (const action of this.actions.values()) action.setEffectiveWeight(action === death ? 1 : 0);
      for (const action of this.lowerActions.values()) action.setEffectiveWeight(0);
      death.enabled = true; death.paused = true; death.time = death.getClip().duration * knockdown;
      this.sampledKnockdown = death; this.mixer.update(0);
    }
  }
}
