import * as THREE from 'three';
import type { CharacterView } from './characters.ts';

export interface CharacterPoseSnapshot {
  assetId: string; profileId: string | null; visible: boolean; current: string | null;
  bones: Record<string, number[]>; localQuaternions: Record<string, number[]>;
  bounds: { min: number[]; max: number[] };
  actions: { name: string; time: number; weight: number; duration: number }[];
  meshes: { name: string; vertexCount: number; materialNames: string[] }[];
  materials: { name: string; mapName: string | null; mapWidth: number; mapHeight: number }[];
  /** World-space muzzle origin and direction, for comparison with the simulated shot. */
  pistol: { visible: boolean; socketName: string | null; position: number[]; direction: number[] } | null;
  screen: { head: number[] | null; chest: number[] | null; centre: number[] };
}

/** Expensive evaluated-skin inspection is opt-in; ordinary frames never scan the vertices. */
export function inspectCharacter(view: CharacterView, camera: THREE.Camera): CharacterPoseSnapshot {
  view.root.updateWorldMatrix(true, true);
  const inverse = view.root.matrixWorld.clone().invert();
  const bones: Record<string, number[]> = {}, localQuaternions: Record<string, number[]> = {};
  const meshes: CharacterPoseSnapshot['meshes'] = [], materials = new Set<THREE.MeshStandardMaterial>();
  const point = new THREE.Vector3(), bounds = new THREE.Box3();
  view.model.traverse(node => {
    if ((node as THREE.Bone).isBone) {
      bones[node.name] = node.getWorldPosition(point).applyMatrix4(inverse).toArray();
      localQuaternions[node.name] = node.quaternion.toArray();
    }
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.visible) return;
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
    mats.forEach(material => materials.add(material));
    mesh.skeleton.update();
    const count = mesh.geometry.getAttribute('position').count;
    meshes.push({ name: mesh.name, vertexCount: count, materialNames: mats.map(material => material.name) });
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      bounds.expandByPoint(point);
    }
  });
  const projectedBone = (name: string) => {
    const node = view.model.getObjectByName(name);
    return node ? node.getWorldPosition(new THREE.Vector3()).project(camera).toArray() : null;
  };
  const pistol = view.pistol;
  const direction = pistol ? new THREE.Vector3(0, 0, 1).applyQuaternion(pistol.getWorldQuaternion(new THREE.Quaternion())) : null;
  return {
    assetId: view.asset.id, profileId: view.asset.profile?.id ?? null, visible: view.root.visible, current: view.current,
    bones, localQuaternions, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    actions: [...view.actions].map(([name, action]) => ({ name, time: action.time, weight: action.getEffectiveWeight(), duration: action.getClip().duration })),
    meshes, materials: [...materials].map(material => {
      const map = material.map, image = map?.image as { width?: number; height?: number } | undefined;
      return { name: material.name, mapName: map?.name ?? null, mapWidth: image?.width ?? 0, mapHeight: image?.height ?? 0 };
    }),
    pistol: pistol && direction ? { visible: pistol.visible, socketName: pistol.parent?.name ?? null,
      position: pistol.localToWorld(new THREE.Vector3(0, 0, .14)).toArray(), direction: direction.toArray() } : null,
    screen: { head: projectedBone('DEF-Head'), chest: projectedBone(view.asset.profile?.upperBodyRoot ?? 'Spine'),
      centre: bounds.getCenter(new THREE.Vector3()).applyMatrix4(view.root.matrixWorld).project(camera).toArray() },
  };
}
