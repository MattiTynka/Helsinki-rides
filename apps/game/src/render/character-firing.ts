import * as THREE from 'three';

/** Pistol barrel centre, measured from the authored grip origin (Y up, +Z forward). */
export const PISTOL_MUZZLE = new THREE.Vector3(0, .065, .12);

interface Arm {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  wrist: THREE.Object3D;
  target: THREE.Vector3;
  pole: THREE.Vector3;
  rotation: THREE.Quaternion;
}

/** Shot impulses drive the weapon and both wrists together, after the mixer and reticle correction.
 * This retains the authored palm/finger contact instead of adding a kick only to the gun or firing arm.
 */
export class CharacterFiring {
  private position = 0;
  private velocity = 0;
  private readonly arms: Arm[] = [];
  private readonly saved: { bone: THREE.Object3D; rotation: THREE.Quaternion }[] = [];
  private applied = false;
  private readonly model: THREE.Object3D;
  private readonly pistol: THREE.Object3D;
  private readonly pivot = new THREE.Vector3();
  private readonly barrel = new THREE.Vector3();
  private readonly left = new THREE.Vector3();
  private readonly kick = new THREE.Quaternion();
  private readonly gunRotation = new THREE.Quaternion();
  private readonly workRotation = new THREE.Quaternion();
  private readonly parentRotation = new THREE.Quaternion();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private error = 0;

  constructor(model: THREE.Object3D, pistol: THREE.Object3D) {
    this.model = model; this.pistol = pistol;
    const find = (names: readonly string[]) => names.map(name => model.getObjectByName(name)
      ?? model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name))).find(Boolean);
    for (const side of ['R', 'L']) {
      const upper = find([`DEF-UpperArm_1.${side}`, `DEF-Upperarm1.${side}`]);
      const lower = find([`DEF-Forearm_1.${side}`, `DEF-Forearm1.${side}`]);
      const wrist = find([`DEF-Wrist.${side}`, `DEF-Hand.${side}`]);
      if (!upper || !lower || !wrist) continue;
      this.arms.push({ upper, lower, wrist, target: new THREE.Vector3(), pole: new THREE.Vector3(), rotation: new THREE.Quaternion() });
      for (const bone of [upper, lower, wrist]) this.saved.push({ bone, rotation: new THREE.Quaternion() });
    }
    // A partial chain must not separate the support hand from the shooting hand.
    if (this.arms.length !== 2) { this.arms.length = 0; this.saved.length = 0; }
  }

  notifyShot(): void {
    this.position = Math.min(.045, this.position + .006);
    this.velocity = Math.min(1.8, this.velocity + 1.4);
  }

  /** Exact critically damped spring: identical recovery at 30/60/120 Hz, stable after a stalled frame. */
  advance(dt: number, active: boolean): void {
    if (!active) { this.position = 0; this.velocity = 0; return; }
    if (!Number.isFinite(dt) || dt <= 0) return;
    const frequency = 22, c = this.velocity + frequency * this.position, decay = Math.exp(-frequency * dt);
    this.position = (this.position + c * dt) * decay;
    this.velocity = (this.velocity - frequency * c * dt) * decay;
    if (this.position < 1e-6 && Math.abs(this.velocity) < 1e-5) { this.position = 0; this.velocity = 0; }
  }

  restore(): void {
    if (this.applied) for (const { bone, rotation } of this.saved) bone.quaternion.copy(rotation);
    this.applied = false;
  }

  apply(weight: number): void {
    this.restore(); this.error = 0;
    if (this.arms.length !== 2 || this.position <= 0 || weight <= 0) return;
    const recoil = this.position * THREE.MathUtils.clamp(weight, 0, 1);
    for (const entry of this.saved) entry.rotation.copy(entry.bone.quaternion);
    this.applied = true;
    this.model.updateWorldMatrix(true, true);
    this.pistol.getWorldPosition(this.pivot);
    this.pistol.getWorldQuaternion(this.gunRotation);
    this.barrel.set(0, 0, 1).applyQuaternion(this.gunRotation);
    this.left.set(1, 0, 0).applyQuaternion(this.gunRotation);
    this.kick.setFromAxisAngle(this.left, -recoil * 2.2);
    // Cache BOTH targets before moving the gun's parent wrist.
    for (const arm of this.arms) {
      arm.wrist.getWorldPosition(arm.target).sub(this.pivot).applyQuaternion(this.kick)
        .add(this.pivot).addScaledVector(this.barrel, -recoil * .85);
      arm.lower.getWorldPosition(arm.pole);
      arm.wrist.getWorldQuaternion(arm.rotation).premultiply(this.kick);
    }
    for (const arm of this.arms) {
      this.solve(arm);
      this.error = Math.max(this.error, arm.wrist.getWorldPosition(this.c).distanceTo(arm.target));
    }
  }

  snapshot(): { recoil: number; pairedArms: boolean; wristTargetError: number } {
    return { recoil: this.position, pairedArms: this.arms.length === 2, wristTargetError: this.error };
  }

  private rotateWorld(bone: THREE.Object3D, rotation: THREE.Quaternion): void {
    if (!bone.parent) return;
    bone.parent.getWorldQuaternion(this.parentRotation);
    this.workRotation.copy(this.parentRotation).invert().multiply(rotation).multiply(this.parentRotation);
    bone.quaternion.premultiply(this.workRotation);
    bone.updateWorldMatrix(true, true);
  }

  private aim(bone: THREE.Object3D, end: THREE.Vector3, target: THREE.Vector3): void {
    bone.getWorldPosition(this.a);
    this.from.copy(end).sub(this.a).normalize(); this.to.copy(target).sub(this.a).normalize();
    this.kick.setFromUnitVectors(this.from, this.to);
    this.rotateWorld(bone, this.kick);
  }

  private solve(arm: Arm): void {
    arm.upper.getWorldPosition(this.a); arm.lower.getWorldPosition(this.b); arm.wrist.getWorldPosition(this.c);
    const upperLength = this.a.distanceTo(this.b), lowerLength = this.b.distanceTo(this.c);
    if (upperLength < 1e-5 || lowerLength < 1e-5) return;
    this.direction.copy(arm.target).sub(this.a);
    const distance = THREE.MathUtils.clamp(this.direction.length(), Math.abs(upperLength - lowerLength) + 1e-5, (upperLength + lowerLength) * .9999);
    this.direction.normalize();
    const cosine = THREE.MathUtils.clamp((upperLength * upperLength + distance * distance - lowerLength * lowerLength) / (2 * upperLength * distance), -1, 1);
    this.bend.copy(arm.pole).sub(this.a).addScaledVector(this.direction, -this.bend.dot(this.direction));
    if (this.bend.lengthSq() < 1e-8) this.bend.set(0, -1, 0).addScaledVector(this.direction, this.direction.y);
    this.bend.normalize();
    this.elbow.copy(this.a).addScaledVector(this.direction, upperLength * cosine)
      .addScaledVector(this.bend, upperLength * Math.sqrt(1 - cosine * cosine));
    this.aim(arm.upper, this.b, this.elbow);
    arm.wrist.getWorldPosition(this.c);
    this.aim(arm.lower, this.c, arm.target);
    arm.wrist.parent!.getWorldQuaternion(this.parentRotation);
    arm.wrist.quaternion.copy(this.parentRotation.invert().multiply(arm.rotation));
    arm.wrist.updateWorldMatrix(true, true);
  }
}
