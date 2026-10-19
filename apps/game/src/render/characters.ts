// Character views: skinned hero meshes driven by the sim's clip state (skill: gameplay animation). Locomotion clips
// play in place at a rate matched to the measured speed; the sim owns world displacement.
import * as THREE from 'three';
import type { CharacterState, PlayerState, VehicleState } from '@helsinki/sim';
import type { AssetLibrary, CharacterAsset } from './assets.ts';
import { advanceGaitPhase, isLocomotionClip, locomotionWeights, MOVEMENT_CLIPS, type MovementClip } from './locomotion.ts';
import { NativeCharacterAnimation } from './native-character-animation.ts';
import { CharacterAim } from './character-aim.ts';
import { NativeVehicleAnimation, type VehiclePoses } from './native-vehicle-animation.ts';
import { SkinnedMeshCuller } from './skinned-culling.ts';

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
  private vehicleAnimation: NativeVehicleAnimation | null = null;
  private skinnedCulling: SkinnedMeshCuller | null = null;

  constructor(assets: AssetLibrary, assetId: string, shadowMaterial: THREE.Material) {
    const { root, asset } = assets.cloneCharacter(assetId);
    this.asset = asset;
    this.model = root;
    this.root.add(root);
    this.mixer = new THREE.AnimationMixer(root);
    this.nativeAnimation = asset.profile ? new NativeCharacterAnimation(this.mixer, root, asset.clips, asset.profile) : null;
    if (this.nativeAnimation) for (const [name, action] of this.nativeAnimation.actions) this.actions.set(name, action);
    else for (const [name, clip] of asset.clips) {
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
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.shadow.renderOrder = -1;
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
    // remains clamped, and an interrupted one-shot can safely be entered again later.
    if (!isLocomotionClip(resolved)) next.reset().play();
    this.current = resolved;
    this.transitionSeconds = fade;
    if (fade <= 0) {
      for (const [key, action] of this.actions) action.setEffectiveWeight(key === resolved ? 1 : 0);
    }
  }

  update(state: CharacterState, dt: number, armed: boolean, interaction: PlayerState['vehicleInteraction'] = null, vehicle?: VehicleState, poses?: VehiclePoses): void {
    this.aimCorrection?.restore();
    this.vehicleAnimation?.restore();
    this.root.visible = state.inVehicle === null;
    this.root.position.set(state.position[0], state.position[1], state.position[2]);
    this.root.rotation.set(0, state.yaw, 0);
    // Keep the contact shadow on the supporting surface while the capsule is airborne.
    const groundDistance = state.groundDistance;
    this.shadow.visible = groundDistance !== null && (groundDistance ?? 0) < 5;
    this.shadow.position.y = .02 - Math.max(0, groundDistance ?? 0);
    this.shadow.scale.setScalar(1 / (1 + Math.max(0, groundDistance ?? 0) * .12));
    // The car layer owns the whole body. Keep a standing base ready underneath it so
    // releasing the exit fades into standing rather than the obsolete embedded drive pose.
    const ownsVehiclePose = this.asset.profile?.id === 'finn-native-v1' && interaction !== null && interaction.stage !== 'approach';
    const animationState: CharacterState = ownsVehiclePose
      ? { ...state, clip: 'idle', speed: 0, jumpPhase: 'grounded' } : state;
    this.play(animationState.clip, animationState.clip === 'death' ? 0.1 : 0.15);
    if (this.nativeAnimation) {
      this.nativeAnimation.update(animationState, dt);
      if (ownsVehiclePose && !this.vehicleAnimation) this.vehicleAnimation = new NativeVehicleAnimation(this.model);
      const seated = this.vehicleAnimation?.apply(this.root, ownsVehiclePose ? interaction : null, vehicle, dt, poses) ?? false;
      if (seated) this.shadow.visible = false;
      if (this.pistol) this.pistol.visible = armed && state.alive && !interaction;
      return;
    }
    const locomotion = this.current !== null && isLocomotionClip(this.current);
    const targets: Record<string, number> = locomotion ? locomotionWeights(state.speed) : { [this.current ?? 'idle']: 1 };
    // Retain the standing fallback for an incomplete asset instead of leaving an unweighted skeleton.
    for (const name of Object.keys(targets)) {
      if (!this.actions.has(name)) targets.idle = (targets.idle ?? 0) + targets[name]!;
    }
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
    if (this.pistol) this.pistol.visible = armed && state.alive;
    this.mixer.update(dt);
  }

  /** Called after all animation, aiming and vehicle layers, before the renderer tests visibility. */
  prepareForRender(): void {
    this.skinnedCulling ??= new SkinnedMeshCuller(this.model);
    this.root.updateWorldMatrix(true, false);
    this.root.updateMatrixWorld(true);
    this.skinnedCulling.update();
  }

  dispose(): void {
    this.skinnedCulling?.dispose();
    this.mixer.stopAllAction();
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
  }
}
