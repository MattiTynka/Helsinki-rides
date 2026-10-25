// Third-person camera: orbit on foot (over-the-shoulder while aiming), chase behind the car (plan section 5).
// Camera yaw is the sim's command yaw; the camera never pierces the city because it is pulled in along a ray cast
// against the collision world. Getting in and out blends the two rigs on the interaction clock.
import * as THREE from 'three';
import type { AimRay, PlayerState, SimState, StaticWorld } from '@helsinki/sim';
import { GROUP, groups, RAPIER, wrapAngle } from '@helsinki/sim';

const smooth = (x: number): number => { const t = THREE.MathUtils.clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/** How far the camera is into the car rig: it hands over late in the entry and early in the exit. */
export function carCameraWeight(p: PlayerState): number {
  const interaction = p.vehicleInteraction;
  if (p.mode === 'driving') return 1;
  if (!interaction) return 0;
  if (interaction.stage === 'enter') return smooth((interaction.progress - 0.55) / 0.45);
  if (interaction.stage === 'exit') return 1 - smooth(interaction.progress / 0.6);
  return interaction.stage === 'seated' ? 1 : 0;
}

export class ChaseCamera {
  yaw = 0;
  pitch = -0.12;
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private initialised = false;
  private carYawOffset = 0;
  /** 0 on foot, 1 in the chase rig; damped so an interrupted entry eases back instead of cutting. */
  carBlend = 0;
  readonly camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera) { this.camera = camera; }

  /** Mouse / stick look input in radians. */
  look(dYaw: number, dPitch: number): void {
    this.yaw -= dYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dPitch, -1.1, 0.9);
  }

  /** Snap behind the player (after spawns and teleports). */
  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = -0.12;
    this.initialised = false;
    this.carYawOffset = 0;
    this.carBlend = 0;
  }

  /** Mouse look steers the chase offset once the camera is mostly in the car rig. */
  get inCar(): boolean { return this.carBlend > 0.5; }

  /** The rendered centre ray, not the nominal yaw: damping, shoulder offset and wall pull-in all affect it. */
  aimRay(): AimRay {
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    return { origin: this.camera.position.toArray(), direction: direction.toArray() };
  }

  /**
   * `chaseTarget` is the seat the chase rig frames (the player's own position while driving); `focus` is Snow's
   * rendered hips while the car layer poses him, so the on-foot rig follows the body rather than the hidden capsule,
   * and `groundY` the ground under the car, which stands in for the capsule's height for the same reason.
   */
  update(state: SimState, world: StaticWorld, chaseOffset: readonly [number, number, number] | null, dt: number,
    chaseTarget: THREE.Vector3 | null = null, focus: THREE.Vector3 | null = null, groundY: number | null = null): void {
    const p = state.player;
    const v = state.vehicles.find(x => x.id === (p.inVehicle ?? p.vehicleInteraction?.vehicleId));
    const weight = chaseOffset && v ? carCameraWeight(p) : 0;
    this.carBlend = this.initialised ? THREE.MathUtils.damp(this.carBlend, weight, 8, dt) : weight;
    if (Math.abs(this.carBlend - weight) < 1e-3) this.carBlend = weight;
    const w = this.carBlend;
    const carYaw = v ? yawOf(v.rotation) : p.yaw;
    if (w > 0) {
      // The camera trails the car's heading; mouse input adds a temporary offset that relaxes back.
      this.carYawOffset = THREE.MathUtils.damp(this.carYawOffset, 0, 1.5, dt);
      if (w >= 1) this.yaw = carYaw + this.carYawOffset;
    } else this.carYawOffset = 0;
    // Both rigs share one heading, so the blend swings round behind Snow instead of cutting through the car.
    const yaw = this.yaw + wrapAngle(carYaw + this.carYawOffset - this.yaw) * w;
    const aiming = p.aiming && w === 0;
    const dist = aiming ? 1.9 : 3.4;
    const side = aiming ? 0.55 : 0.25;
    const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const r = new THREE.Vector3(f.z, 0, -f.x).multiplyScalar(-side);
    const footX = focus?.x ?? p.position[0], footZ = focus?.z ?? p.position[2];
    this.target.set(footX + r.x, (groundY ?? p.position[1]) + (aiming ? 1.55 : 1.45), footZ + r.z);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const desired = this.target.clone().add(new THREE.Vector3(-f.x * cp * dist, -sp * dist, -f.z * cp * dist));
    const onFootLook = this.target.clone().add(new THREE.Vector3(f.x * cp, sp, f.z * cp).multiplyScalar(8));
    let look = onFootLook;
    if (w > 0 && chaseOffset) {
      const seat = chaseTarget ?? new THREE.Vector3(...p.position);
      const back = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(chaseOffset[2]);
      const chaseLook = new THREE.Vector3(seat.x, seat.y + 1.1, seat.z);
      const chase = new THREE.Vector3(seat.x + back.x, seat.y + chaseOffset[1] + Math.sin(-this.pitch) * 3, seat.z + back.z);
      desired.lerp(chase, w);
      this.target.lerp(chaseLook, w);
      look = onFootLook.lerp(chaseLook, w);
    }
    // Pull the camera in front of static geometry.
    const dir = desired.clone().sub(this.target);
    const len = dir.length();
    if (len > 0.01) {
      const ray = new RAPIER.Ray({ x: this.target.x, y: this.target.y, z: this.target.z }, { x: dir.x / len, y: dir.y / len, z: dir.z / len });
      const hit = world.physics.castRay(ray, len + 0.3, true, undefined, groups(GROUP.bullet, GROUP.static));
      if (hit) desired.copy(this.target).addScaledVector(dir.normalize(), Math.max(0.4, hit.timeOfImpact - 0.3));
    }
    if (!this.initialised) { this.pos.copy(desired); this.initialised = true; }
    else this.pos.lerp(desired, 1 - Math.exp(-dt * THREE.MathUtils.lerp(18, 10, w)));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(look);
  }

  mouseOffsetInCar(dYaw: number): void { this.carYawOffset -= dYaw; }
}

export function yawOf(q: readonly [number, number, number, number]): number {
  const [x, y, z, w] = q;
  const fx = 2 * (x * z + w * y), fz = 1 - 2 * (x * x + y * y);
  return Math.atan2(fx, fz);
}
