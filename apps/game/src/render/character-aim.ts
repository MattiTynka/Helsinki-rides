import * as THREE from 'three';

/** A common upper-body correction keeps the authored two-hand grip intact and leaves the planted legs alone. */
export class CharacterAim {
  private readonly spine: THREE.Object3D | undefined;
  private saved: THREE.Quaternion | null = null;
  private readonly model: THREE.Object3D;
  private readonly pistol: THREE.Object3D;

  constructor(model: THREE.Object3D, pistol: THREE.Object3D, upperBodyRoot = 'DEF-Spine') {
    this.model = model; this.pistol = pistol;
    this.spine = model.getObjectByName(upperBodyRoot) ?? model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(upperBodyRoot));
  }

  /** Undo only our last frame's additive pose before the mixer samples the next authored pose. */
  restore(): void {
    if (this.spine && this.saved) this.spine.quaternion.copy(this.saved);
    this.saved = null;
  }

  apply(target: THREE.Vector3, weight: number): void {
    const spine = this.spine;
    if (!spine?.parent || weight <= 0) return;
    this.restore();
    this.saved = spine.quaternion.clone();
    this.model.updateWorldMatrix(true, true);
    const modelRotation = this.model.getWorldQuaternion(new THREE.Quaternion());
    const muzzle = this.pistol.localToWorld(new THREE.Vector3(0, 0, .14));
    const distance = target.distanceTo(muzzle);
    if (distance < .05) return;
    const localDirection = target.clone().sub(muzzle).normalize().applyQuaternion(modelRotation.clone().invert());
    // Do not twist the torso backwards while the player is still turning after a sudden camera movement.
    const yaw = THREE.MathUtils.clamp(Math.atan2(localDirection.x, localDirection.z), -.7, .7);
    const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(localDirection.y, -1, 1)), -.8, .8);
    const desiredPoint = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).applyQuaternion(modelRotation).multiplyScalar(distance).add(muzzle);
    const parentRotation = spine.parent.getWorldQuaternion(new THREE.Quaternion());
    const parentInverse = parentRotation.clone().invert();
    // Rotating the spine also translates the muzzle, so converge the point constraint again after each turn.
    for (let i = 0; i < 12; i++) {
      spine.updateWorldMatrix(true, true);
      const origin = this.pistol.localToWorld(new THREE.Vector3(0, 0, .14));
      const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(this.pistol.getWorldQuaternion(new THREE.Quaternion()));
      const desired = desiredPoint.clone().sub(origin).normalize();
      if (direction.dot(desired) > 1 - 1e-12) break;
      const delta = new THREE.Quaternion().setFromUnitVectors(direction, desired);
      const localDelta = parentInverse.clone().multiply(delta).multiply(parentRotation);
      spine.quaternion.premultiply(localDelta);
    }
    spine.quaternion.slerpQuaternions(this.saved, spine.quaternion.clone(), THREE.MathUtils.clamp(weight, 0, 1));
    spine.updateWorldMatrix(true, true);
  }
}
