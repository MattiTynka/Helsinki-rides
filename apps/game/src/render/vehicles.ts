// Vehicle views: the car body follows the chassis body, wheels follow the raycast controller's hubs, doors swing
// during entry/exit, the steering wheel turns, and lamps light up (contract: content/assets/vehicle-lumi-gt.contract.json).
// Beyond the preset's detail range a car draws as its merged far level (3 to 4 draw calls instead of about 35).
import * as THREE from 'three';
import type { VehicleState } from '@helsinki/sim';
import type { VehicleDefinition } from '@helsinki/world-schema';
import type { AssetLibrary } from './assets.ts';
import { createContactShadow, placeContactShadow, type ShadowCaster } from './contact-shadow.ts';

const scratch = new THREE.Vector3(), scratchCentre = new THREE.Vector3();

interface DoorNode { node: THREE.Object3D; openDeg: number; sign: number; rest: THREE.Quaternion }

export class VehicleView {
  readonly id: string;
  readonly root = new THREE.Group();
  readonly lod = new THREE.LOD();
  readonly wheels: THREE.Object3D[] = [];
  readonly doors: DoorNode[] = [];
  readonly steering: { node: THREE.Object3D; rest: THREE.Quaternion; lockDeg: number } | null;
  readonly lightbar: THREE.Mesh | null;
  readonly windshield: THREE.Object3D | null;
  readonly lampHead: THREE.MeshStandardMaterial[] = [];
  readonly lampTail: THREE.MeshStandardMaterial[] = [];
  readonly lampBlue: THREE.MeshStandardMaterial[] = [];
  readonly shadow: THREE.Mesh;
  private readonly caster: ShadowCaster;
  /** Height of the ground the shadow lies on, once known. */
  private groundY: number | null = null;
  /** Opening 0..1 per door node, set from the interaction clock. */
  readonly doorOpen: Record<string, number> = { DOOR_FL: 0, DOOR_FR: 0 };
  private readonly def: VehicleDefinition;
  private readonly ownedLampMaterials = new Set<THREE.Material>();
  private disposed = false;

  constructor(assets: AssetLibrary, id: string, def: VehicleDefinition, shadowMaterial: THREE.Material, detailRange: number) {
    this.id = id;
    this.def = def;
    const detail = assets.cloneVehicle(def.assetId);
    for (const w of def.wheels) {
      const node = detail.getObjectByName(w.socket);
      if (node) this.wheels.push(node);
    }
    for (const name of ['DOOR_FL', 'DOOR_FR']) {
      const node = detail.getObjectByName(name);
      if (!node) continue;
      const ex = node.userData as { openDeg?: number; openSign?: number };
      this.doors.push({ node, openDeg: ex.openDeg ?? 65, sign: ex.openSign ?? (name === 'DOOR_FL' ? -1 : 1), rest: node.quaternion.clone() });
    }
    const sw = detail.getObjectByName('STEERING_WHEEL');
    this.steering = sw ? { node: sw, rest: sw.quaternion.clone(), lockDeg: (sw.userData as { lockDeg?: number }).lockDeg ?? 450 } : null;
    this.lightbar = (detail.getObjectByName('LIGHTBAR_MESH') as THREE.Mesh | undefined) ?? null;
    this.windshield = detail.getObjectByName('WINDSHIELD') ?? null;
    detail.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        // cloneVehicle owns only the per-instance lamp materials; even their
        // colour textures and all near/far geometry belong to AssetLibrary.
        if (mat.name.startsWith('car_lamp')) this.ownedLampMaterials.add(mat);
        const s = mat as THREE.MeshStandardMaterial;
        if (s.name === 'car_lamp_head') this.lampHead.push(s);
        else if (s.name === 'car_lamp_tail') this.lampTail.push(s);
        else if (s.name === 'car_lamp_blue') this.lampBlue.push(s);
      }
    });
    for (const m of [...this.lampHead, ...this.lampTail, ...this.lampBlue]) { m.emissive = new THREE.Color(m.name === 'car_lamp_blue' ? 0x2040ff : m.name === 'car_lamp_tail' ? 0xff2020 : 0xfff4d0); m.emissiveIntensity = 0; }
    // The far level shares this instance's lamp materials, so lights and the siren flash at any distance.
    const parts = assets.vehicles.get(def.assetId)!.far;
    const far = new THREE.Group();
    far.add(new THREE.Mesh(parts.body, assets.farMaterial));
    for (const [name, geometry] of parts.lamps) {
      const material = (name === 'car_lamp_blue' ? this.lampBlue : name === 'car_lamp_tail' ? this.lampTail : this.lampHead)[0];
      if (material) far.add(new THREE.Mesh(geometry, material));
    }
    this.lod.addLevel(detail, 0);
    this.lod.addLevel(far, detailRange, 0.1);
    this.root.add(this.lod);
    this.shadow = createContactShadow(shadowMaterial);
    this.root.add(this.shadow);
    const he = def.collider.halfExtents;
    this.caster = { halfWidth: he[0], halfLength: he[2], height: def.collider.centre[1] + he[1] };
  }

  /** A detail-tier change: this car switches to its merged far mesh beyond `range` metres from the camera. */
  setDetailRange(range: number): void {
    const far = this.lod.levels[1];
    if (far && Number.isFinite(range) && range > 0) far.distance = range;
  }

  update(state: VehicleState, time: number, doorTargets: Readonly<Record<string, number>>, dt: number): void {
    this.root.position.set(state.position[0], state.position[1], state.position[2]);
    this.root.quaternion.set(state.rotation[0], state.rotation[1], state.rotation[2], state.rotation[3]);
    state.wheels.forEach((w, i) => {
      const node = this.wheels[i];
      if (!node) return;
      node.position.set(w.position[0], w.position[1], w.position[2]);
      node.rotation.set(w.rotation, w.steer, 0, 'YXZ');
    });
    const q = new THREE.Quaternion();
    for (const d of this.doors) {
      const open = this.doorOpen[d.node.name] = THREE.MathUtils.clamp(doorTargets[d.node.name] ?? 0, 0, 1);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(d.openDeg) * d.sign * open);
      d.node.quaternion.copy(d.rest).multiply(q);
    }
    if (this.steering) {
      const maxAngle = THREE.MathUtils.degToRad(this.def.steering.maxAngleDeg);
      const turns = state.steerAngle / maxAngle * THREE.MathUtils.degToRad(this.steering.lockDeg);
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -turns);
      this.steering.node.quaternion.copy(this.steering.rest).multiply(q);
    }
    const head = state.lightsOn ? 2.2 : 0;
    for (const m of this.lampHead) m.emissiveIntensity = head;
    const braking = state.throttle < 0 && state.forwardSpeed > 0.5;
    for (const m of this.lampTail) m.emissiveIntensity = state.lightsOn ? (braking ? 3 : 0.9) : braking ? 2.5 : 0;
    const flash = state.sirenOn ? (Math.floor(time * 6) % 2 === 0 ? 6 : 0.5) : 0;
    for (const m of this.lampBlue) m.emissiveIntensity = flash;
    if (this.windshield) this.windshield.visible = !state.windshieldBroken;
    this.placeShadow(state);
  }

  /**
   * The ground under the car is where its touching tyres meet it; in the air it stays at the last ground seen until
   * the body sinks below that (landing lower down, or coming to rest on its roof or side).
   */
  private placeShadow(state: VehicleState): void {
    const q = this.root.quaternion, p = this.root.position, c = this.def.collider.centre, he = this.def.collider.halfExtents;
    // World height of the chassis box's lowest corner: centre minus the vertical reach of each half extent.
    const reach = Math.abs(scratch.set(he[0], 0, 0).applyQuaternion(q).y) + Math.abs(scratch.set(0, he[1], 0).applyQuaternion(q).y)
      + Math.abs(scratch.set(0, 0, he[2]).applyQuaternion(q).y);
    const centre = scratchCentre.set(c[0], c[1], c[2]).applyQuaternion(q).add(p);
    let bodyBottom = centre.y - reach;
    let contactY = 0, contacts = 0;
    for (const w of state.wheels) {
      const tyre = scratch.set(w.position[0], w.position[1], w.position[2]).applyQuaternion(q).y + p.y - this.def.wheelRadius;
      bodyBottom = Math.min(bodyBottom, tyre);
      if (w.contact) { contactY += tyre; contacts++; }
    }
    if (contacts > 0) this.groundY = contactY / contacts;
    else if (this.groundY === null || bodyBottom < this.groundY) this.groundY = bodyBottom;
    const forward = scratch.set(0, 0, 1).applyQuaternion(q);
    placeContactShadow(this.shadow, this.caster, centre.x, centre.z, this.groundY, Math.atan2(forward.x, forward.z), bodyBottom - this.groundY);
    if (state.position[1] <= -20) this.shadow.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
    for (const material of this.ownedLampMaterials) material.dispose();
    this.ownedLampMaterials.clear();
    this.root.removeFromParent();
  }
}
