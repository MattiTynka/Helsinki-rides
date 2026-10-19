// Vehicle views: the car body follows the chassis body, wheels follow the raycast controller's hubs, doors swing
// during entry/exit, the steering wheel turns, and lamps light up (contract: content/assets/vehicle-lumi-gt.contract.json).
// Beyond the preset's detail range a car draws as its merged far level (3 to 4 draw calls instead of about 35).
import * as THREE from 'three';
import type { VehicleState } from '@helsinki/sim';
import type { VehicleDefinition } from '@helsinki/world-schema';
import type { AssetLibrary } from './assets.ts';

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
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(def.collider.halfExtents[0] * 2.2, def.collider.halfExtents[2] * 2.1), shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.03;
    this.shadow.renderOrder = -1;
    this.root.add(this.shadow);
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
    this.shadow.visible = state.position[1] > -20;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shadow.geometry.dispose();
    for (const material of this.ownedLampMaterials) material.dispose();
    this.ownedLampMaterials.clear();
    this.root.removeFromParent();
  }
}
