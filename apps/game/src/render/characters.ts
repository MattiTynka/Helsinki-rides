// Character views: skinned hero meshes driven by the sim's clip state (skill: gameplay animation). Locomotion clips
// play in place at a rate matched to the measured speed; the sim owns world displacement.
import * as THREE from 'three';
import type { CharacterState, PlayerState, VehicleState } from '@helsinki/sim';
import type { AssetLibrary, CharacterAsset } from './assets.ts';
import { advanceGaitPhase, isLocomotionClip, locomotionWeights, MOVEMENT_CLIPS, type MovementClip } from './locomotion.ts';
import { NativeCharacterAnimation } from './native-character-animation.ts';
import { CIVILIAN_JUMP_ARMS, hasJumpPose, isJumpClip, NativeJumpAnimation } from './native-jump-animation.ts';
import { CharacterAim } from './character-aim.ts';
import { CharacterFiring, PISTOL_MUZZLE } from './character-firing.ts';
import type { KnockdownPresentation } from './knockdown-presentation.ts';
import { CharacterCollapse } from './character-collapse.ts';
import { PedestrianAnimation, pedestrianGaitPhase } from './pedestrian-animation.ts';
import { NativeVehicleAnimation, type VehiclePoses } from './native-vehicle-animation.ts';
import { SkinnedMeshCuller } from './skinned-culling.ts';
import { AnimationCadence, type CharacterPresentationOptions } from './animation-cadence.ts';
import { createContactShadow, placeContactShadow, type ShadowCaster } from './contact-shadow.ts';

/** A standing person: shoulders across, chest to back, and height. */
const CHARACTER_CASTER: ShadowCaster = { halfWidth: 0.25, halfLength: 0.15, height: 1.75 };

const ONE_SHOT = new Set(['fire', 'hit', 'death']);

export class CharacterView {
  readonly root = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly asset: CharacterAsset;
  readonly actions = new Map<string, THREE.AnimationAction>();
  readonly shadow: THREE.Mesh;
  current: string | null = null;
  pistol: THREE.Object3D | null = null;
  private handSocket: THREE.Object3D | null = null;
  private gaitPhase = 0;
  private transitionSeconds = 0.15;
  private readonly gaitDurations: Partial<Record<MovementClip, number>> = {};
  private readonly nativeAnimation: NativeCharacterAnimation | null;
  private readonly aimCorrection: CharacterAim | null;
  private readonly firing: CharacterFiring | null;
  private readonly muzzleRotation = new THREE.Quaternion();
  private vehicleAnimation: NativeVehicleAnimation | null = null;
  private skinnedCulling: SkinnedMeshCuller | null = null;
  private readonly ownedSkeletons = new Set<THREE.Skeleton>();
  private disposed = false;
  private sampledKnockdown: THREE.AnimationAction | null = null;
  private shotHoldSeconds = 0;
  private readonly collapsePresentation = new CharacterCollapse();
  private readonly pedestrianAnimation: PedestrianAnimation | null;
  /** Civilians' jump and climb poses, carried by their asset; the layer is built at the first jump. */
  private readonly jumpClips = new Map<string, THREE.AnimationClip>();
  private jumpAnimation: NativeJumpAnimation | null = null;
  private gaitInitialized = false;
  private readonly cadence = new AnimationCadence();

  constructor(assets: AssetLibrary, assetId: string, shadowMaterial: THREE.Material) {
    const { root, asset } = assets.cloneCharacter(assetId);
    this.asset = asset;
    this.model = root;
    // SkeletonUtils clones palettes per actor, while geometry/materials remain
    // shared with the asset. Collect before attaching the shared pistol clone.
    root.traverse(node => {
      const mesh = node as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) this.ownedSkeletons.add(mesh.skeleton);
    });
    this.root.add(root);
    this.pedestrianAnimation = asset.id.startsWith('character-civilian-') ? new PedestrianAnimation(root) : null;
    this.mixer = new THREE.AnimationMixer(root);
    this.nativeAnimation = asset.profile ? new NativeCharacterAnimation(this.mixer, root, asset.clips, asset.profile) : null;
    if (this.nativeAnimation) for (const [name, action] of this.nativeAnimation.actions) this.actions.set(name, action);
    else for (const [name, clip] of asset.clips) {
      if (isJumpClip(name)) { this.jumpClips.set(name, clip); continue; }
      const action = this.mixer.clipAction(clip);
      if (ONE_SHOT.has(name)) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
      action.setEffectiveWeight(0);
      if (isLocomotionClip(name)) {
        action.play();
        if (name !== 'idle') {
          this.gaitDurations[name] = clip.duration;
          // The shared gait clock samples all movement clips at the same normalized foot phase.
          action.paused = true;
        }
      }
      this.actions.set(name, action);
    }
    this.handSocket = root.getObjectByName('SOCKET_HAND_R') ?? null;
    const p = assets.clonePistol();
    if (p && this.handSocket) { this.handSocket.add(p); p.visible = false; this.pistol = p; }
    this.aimCorrection = this.nativeAnimation && this.pistol ? new CharacterAim(root, this.pistol, asset.profile!.upperBodyRoot) : null;
    this.firing = this.nativeAnimation && this.pistol ? new CharacterFiring(root, this.pistol) : null;
    this.shadow = createContactShadow(shadowMaterial);
    this.root.add(this.shadow);
    this.play('idle', 0);
  }

  play(name: string, fade = 0.15): void {
    if (this.nativeAnimation) { this.nativeAnimation.play(name, fade); this.current = this.nativeAnimation.current; return; }
    const resolved = this.actions.has(name) ? name : 'idle';
    if (this.current === resolved) return;
    const next = this.actions.get(resolved);
    if (!next) return;
    // Gait changes never reset a foot cycle. Full-body reactions restart only on state entry; a held death
    // remains clamped, and an interrupted one-shot can safely be entered again later. Returning from a shot
    // to a still-running aim loop keeps the held pose instead of restarting it.
    if (!isLocomotionClip(resolved) && !(resolved === 'aim' && this.current === 'fire' && next.isRunning())) next.reset().play();
    this.current = resolved;
    this.transitionSeconds = fade;
    if (fade <= 0) {
      for (const [key, action] of this.actions) action.setEffectiveWeight(key === resolved ? 1 : 0);
    }
  }

  update(state: CharacterState & { readonly knockdown?: KnockdownPresentation | null }, dt: number, armed: boolean, interaction: PlayerState['vehicleInteraction'] = null, vehicle?: VehicleState, poses?: VehiclePoses, presentation?: CharacterPresentationOptions): void {
    // Root placement remains smooth at presentation rate even when distant skeleton poses are sampled.
    this.root.visible = state.inVehicle === null;
    this.root.position.set(state.position[0], state.position[1], state.position[2]);
    this.root.rotation.set(0, state.yaw, 0);
    this.placeShadow(state, false);
    const camera = presentation?.cameraPosition;
    const distance = camera ? Math.hypot(state.position[0] - camera.x, state.position[1] - camera.y, state.position[2] - camera.z) : 0;
    const urgent = !state.alive || armed || this.shotHoldSeconds > 0 || !!state.knockdown || !!interaction
      || !state.grounded || !isLocomotionClip(state.clip);
    const sampledDt = this.cadence.sample(dt, presentation?.mobile === true, distance,
      `${state.clip}/${state.alive}/${state.aiming}/${state.inVehicle}/${state.jumpPhase}`, urgent);
    if (sampledDt === null) return;
    dt = sampledDt;
    this.pedestrianAnimation?.restore();
    if (this.pedestrianAnimation && !this.gaitInitialized) {
      this.gaitInitialized = true;
      this.gaitPhase = pedestrianGaitPhase(state.id);
      const idle = this.actions.get(this.asset.profile?.states.idle ?? 'idle');
      if (idle) idle.time = this.gaitPhase * idle.getClip().duration;
    }
    if (this.sampledKnockdown) { this.sampledKnockdown.paused = false; this.sampledKnockdown = null; }
    const death = this.actions.get(this.asset.profile?.states.death ?? 'death');
    const collapse = this.collapsePresentation.update(state, dt, death?.getClip().duration ?? 1.4);
    const canPresentWeapon = state.alive && state.inVehicle === null && !interaction && collapse === null
      && state.clip !== 'hit' && state.clip !== 'death' && state.clip !== 'arrested'
      && (!('weapon' in state) || state.weapon !== null);
    this.shotHoldSeconds = canPresentWeapon ? Math.max(0, this.shotHoldSeconds - (Number.isFinite(dt) ? Math.max(0, dt) : 0)) : 0;
    const presentingWeapon = canPresentWeapon && (armed || this.shotHoldSeconds > 0);
    this.firing?.restore();
    this.firing?.advance(dt, presentingWeapon);
    this.aimCorrection?.restore();
    this.vehicleAnimation?.restore();
    this.jumpAnimation?.restore();
    // The car layer owns the whole body. Keep a standing base ready underneath it so
    // releasing the exit fades into standing rather than the obsolete embedded drive pose.
    const ownsVehiclePose = this.asset.profile?.id === 'snow-native-v1' && interaction !== null && interaction.stage !== 'approach';
    const aimsOverGait = presentingWeapon && (state.aiming || this.shotHoldSeconds > 0) && isLocomotionClip(state.clip);
    const animationState: CharacterState = !state.alive ? { ...state, clip: 'death', speed: 0, jumpPhase: 'grounded' }
      : ownsVehiclePose ? { ...state, clip: 'idle', speed: 0, jumpPhase: 'grounded' } : aimsOverGait ? { ...state, clip: 'aim' } : state;
    this.play(animationState.clip, animationState.clip === 'death' ? 0.1 : 0.15);
    if (this.nativeAnimation) {
      this.nativeAnimation.update(animationState, dt, collapse);
      if (ownsVehiclePose && !this.vehicleAnimation) this.vehicleAnimation = new NativeVehicleAnimation(this.model);
      const seated = this.vehicleAnimation?.apply(this.root, ownsVehiclePose ? interaction : null, vehicle, dt, poses) ?? false;
      this.placeShadow(state, seated);
      if (this.pistol) this.pistol.visible = presentingWeapon;
      this.pedestrianAnimation?.apply(animationState, dt, collapse !== null);
      return;
    }
    const locomotion = this.current !== null && isLocomotionClip(this.current);
    const targets: Record<string, number> = locomotion ? locomotionWeights(state.speed) : { [this.current ?? 'idle']: 1 };
    // Retain the standing fallback for an incomplete asset instead of leaving an unweighted skeleton.
    for (const name of Object.keys(targets)) {
      if (!this.actions.has(name)) targets.idle = (targets.idle ?? 0) + targets[name]!;
    }
    // A presented collapse owns the whole skeleton, as a death does: the jump layer lets go of every pose and its grip at once.
    const jumpState = collapse === null ? animationState : { ...animationState, alive: false };
    if (!this.jumpAnimation && this.jumpClips.size && hasJumpPose(jumpState))
      this.jumpAnimation = new NativeJumpAnimation(this.mixer, this.model, () => false, { clips: this.jumpClips, arms: CIVILIAN_JUMP_ARMS });
    const jump = this.jumpAnimation?.update(jumpState, dt, false, this.gaitPhase);
    const jumpWeight = jump?.weight ?? 0;
    if (jump?.gaitPhase !== null && jump?.gaitPhase !== undefined) this.gaitPhase = jump.gaitPhase;
    for (const name of Object.keys(targets)) targets[name]! *= 1 - jumpWeight;
    const blend = this.transitionSeconds > 0 ? 1 - Math.exp(-Math.max(0, dt) * 4 / this.transitionSeconds) : 1;
    for (const [name, action] of this.actions) {
      const weight = action.getEffectiveWeight();
      action.setEffectiveWeight(weight + ((targets[name] ?? 0) - weight) * blend);
    }
    if (locomotion) {
      const weights = { walk: 0, run: 0, sprint: 0 };
      for (const name of MOVEMENT_CLIPS) weights[name] = this.actions.get(name)?.getEffectiveWeight() ?? 0;
      this.gaitPhase = advanceGaitPhase(this.gaitPhase, state.speed, dt, weights, this.gaitDurations);
    }
    for (const name of MOVEMENT_CLIPS) {
      const action = this.actions.get(name);
      if (action) action.time = this.gaitPhase * action.getClip().duration;
    }
    if (this.pistol) this.pistol.visible = presentingWeapon;
    this.mixer.update(dt);
    this.jumpAnimation?.applyGrip(this.model);
    if (collapse !== null) {
      const death = this.actions.get('death');
      if (death) {
        for (const action of this.actions.values()) action.setEffectiveWeight(action === death ? 1 : 0);
        death.enabled = true; death.paused = true; death.time = death.getClip().duration * collapse;
        this.sampledKnockdown = death; this.mixer.update(0);
      }
    }
    this.pedestrianAnimation?.apply(animationState, dt, collapse !== null, jumpWeight);
  }

  /** Called after all animation, aiming and vehicle layers, before the renderer tests visibility. */
  prepareForRender(): void {
    if (!this.root.visible) return;
    this.skinnedCulling ??= new SkinnedMeshCuller(this.model);
    this.root.updateWorldMatrix(true, false);
    this.root.updateMatrixWorld(true);
    this.skinnedCulling.update();
  }

  /** The contact shadow stays on the supporting surface below the rendered body while the capsule is airborne. */
  private placeShadow(state: CharacterState, seated: boolean): void {
    const groundDistance = Math.max(0, state.groundDistance ?? 0), p = this.root.position;
    placeContactShadow(this.shadow, CHARACTER_CASTER, p.x, p.z, state.position[1] - groundDistance, state.yaw, groundDistance);
    if (state.groundDistance === null || seated) this.shadow.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.skinnedCulling?.dispose();
    this.skinnedCulling = null;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    for (const skeleton of this.ownedSkeletons) skeleton.dispose();
    this.ownedSkeletons.clear();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }

  /** World position of the rendered hips, which the car layer moves away from the hidden capsule. */
  bodyFocus(): THREE.Vector3 | null {
    const hips = this.model.getObjectByName('DEF-Hips');
    if (!hips) return null;
    this.root.updateWorldMatrix(true, true);
    return hips.getWorldPosition(new THREE.Vector3());
  }

  aimAt(target: THREE.Vector3): void {
    if (!this.pistol?.visible) return;
    const states = this.asset.profile?.states;
    const weight = (this.actions.get(states?.aim ?? 'aim')?.getEffectiveWeight() ?? 0) + (this.actions.get(states?.fire ?? 'fire')?.getEffectiveWeight() ?? 0);
    this.aimCorrection?.apply(target, Math.min(1, weight));
    this.firing?.apply(Math.min(1, weight));
  }

  /** Called once for an actual simulation shot, never from a held fire animation state. */
  notifyShot(): void {
    if (!this.pistol) return;
    // A render can combine a fire tick and the following moving/lost-sight tick. Retain the short
    // physical follow-through even when that last state no longer contains the one-tick fire clip.
    this.shotHoldSeconds = .18;
    this.firing?.notifyShot();
  }

  /** Explicit holster boundary, even if the next fixed tick draws again before a frame is rendered. */
  cancelShot(): void {
    this.shotHoldSeconds = 0;
    this.firing?.restore();
    this.firing?.advance(0, false);
  }

  isPresentingShot(): boolean { return this.shotHoldSeconds > 0; }

  shootingPresentation(): ReturnType<CharacterFiring['snapshot']> | null { return this.firing?.snapshot() ?? null; }

  /** Resolve after aim/recoil: tracer and warm light start at the visible barrel, not the hitscan eye. */
  muzzlePose(position: THREE.Vector3, direction: THREE.Vector3): boolean {
    if (!this.root.visible || !this.pistol?.visible) return false;
    this.pistol.updateWorldMatrix(true, false);
    position.copy(PISTOL_MUZZLE); this.pistol.localToWorld(position);
    direction.set(0, 0, 1).applyQuaternion(this.pistol.getWorldQuaternion(this.muzzleRotation)).normalize();
    return true;
  }
}
