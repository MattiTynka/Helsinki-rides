import * as THREE from 'three';
import { sceneryLodLevel, type SceneryLodLevel } from './scenery-lod.ts';

/** Static scenery keeps its source matrices; only its cell-owned draw buffer is compacted. */
export class SceneryInstanceCuller {
  private readonly mesh: THREE.InstancedMesh;
  private readonly sourceCount: number;
  private sourceMatrices: Float32Array | null;
  private previousIndices: Uint32Array | null;
  private nextIndices: Uint32Array | null;
  private readonly worldSpheres: THREE.Sphere[] = [];
  private readonly lodLevel: SceneryLodLevel | undefined;
  private lodStates: Uint8Array | null;

  constructor(mesh: THREE.InstancedMesh, lodLevel?: SceneryLodLevel) {
    this.mesh = mesh;
    this.sourceCount = mesh.count;
    this.sourceMatrices = new Float32Array(mesh.instanceMatrix.array.slice(0, mesh.count * 16));
    this.previousIndices = new Uint32Array(mesh.count);
    this.nextIndices = new Uint32Array(mesh.count);
    this.lodLevel = lodLevel;
    this.lodStates = lodLevel === undefined ? null : new Uint8Array(mesh.count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (!mesh.count) return;

    // Do not write bounding data into the shared template geometry. Match Three's
    // vertex sphere when one has not already been calculated by the aggregate.
    const sphere = mesh.geometry.boundingSphere?.clone() ?? new THREE.Sphere();
    if (!mesh.geometry.boundingSphere) {
      const positions = mesh.geometry.getAttribute('position');
      if (!positions || !positions.count) throw new Error('Scenery culling requires nonempty static geometry');
      const point = new THREE.Vector3(), bounds = new THREE.Box3();
      for (let i = 0; i < positions.count; i++) bounds.expandByPoint(point.fromBufferAttribute(positions, i));
      bounds.getCenter(sphere.center);
      let squaredRadius = 0;
      for (let i = 0; i < positions.count; i++) squaredRadius = Math.max(squaredRadius, sphere.center.distanceToSquared(point.fromBufferAttribute(positions, i)));
      sphere.radius = Math.sqrt(squaredRadius);
    }
    mesh.updateWorldMatrix(true, false);
    const instance = new THREE.Matrix4(), world = new THREE.Matrix4(), aggregate = mesh.boundingSphere ? null : new THREE.Sphere().makeEmpty();
    for (let i = 0; i < mesh.count; i++) {
      instance.fromArray(this.sourceMatrices, i * 16);
      world.multiplyMatrices(mesh.matrixWorld, instance);
      const transformed = sphere.clone(); transformed.center.applyMatrix4(world);
      // Nonuniform parent/instance scales can compose into shear. A Gram-matrix
      // row bound contains that transform; orthogonal TRS columns keep max scale.
      const e = world.elements, a = e[0]! ** 2 + e[1]! ** 2 + e[2]! ** 2, b = e[4]! ** 2 + e[5]! ** 2 + e[6]! ** 2, c = e[8]! ** 2 + e[9]! ** 2 + e[10]! ** 2;
      const ab = Math.abs(e[0]! * e[4]! + e[1]! * e[5]! + e[2]! * e[6]!), ac = Math.abs(e[0]! * e[8]! + e[1]! * e[9]! + e[2]! * e[10]!), bc = Math.abs(e[4]! * e[8]! + e[5]! * e[9]! + e[6]! * e[10]!);
      transformed.radius *= Math.sqrt(Math.max(a + ab + ac, b + ab + bc, c + ac + bc));
      this.worldSpheres.push(transformed);
      if (aggregate) aggregate.union(sphere.clone().applyMatrix4(instance));
      this.previousIndices[i] = i;
    }
    if (aggregate) mesh.boundingSphere = aggregate;
  }

  /** No frame allocations; stationary views do not rewrite or upload instance matrices. */
  update(frustum: THREE.Frustum, cameraPosition?: THREE.Vector3): boolean {
    const source = this.sourceMatrices, previous = this.previousIndices, next = this.nextIndices;
    if (!source || !previous || !next) throw new Error('Scenery culling cache is disposed');
    if (this.lodLevel !== undefined && (!cameraPosition || !this.lodStates)) throw new Error('Scenery distance LOD requires its final camera position');
    let count = 0, changed = false;
    for (let i = 0; i < this.sourceCount; i++) {
      const sphere = this.worldSpheres[i]!;
      if (this.lodLevel !== undefined) {
        const level = sceneryLodLevel(Math.max(0, sphere.center.distanceTo(cameraPosition!) - sphere.radius), this.lodStates![i]! as SceneryLodLevel);
        this.lodStates![i] = level;
        if (level !== this.lodLevel) continue;
      }
      if (!frustum.intersectsSphere(sphere)) continue;
      next[count] = i;
      if (previous[count] !== i) changed = true;
      count++;
    }
    if (count !== this.mesh.count) changed = true;
    if (!changed) return false;
    const destination = this.mesh.instanceMatrix.array;
    for (let i = 0; i < count; i++) {
      const sourceOffset = next[i]! * 16, destinationOffset = i * 16;
      for (let k = 0; k < 16; k++) destination[destinationOffset + k] = source[sourceOffset + k]!;
      previous[i] = next[i]!;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    // The original aggregate bound stays conservative for every visible subset.
    return true;
  }

  restore(): void {
    const source = this.sourceMatrices, previous = this.previousIndices;
    if (!source || !previous) throw new Error('Scenery culling cache is disposed');
    let changed = this.mesh.count !== this.sourceCount;
    for (let i = 0; i < this.sourceCount && !changed; i++) if (previous[i] !== i) changed = true;
    if (!changed) return;
    this.mesh.instanceMatrix.array.set(source);
    this.mesh.count = this.sourceCount;
    for (let i = 0; i < this.sourceCount; i++) previous[i] = i;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Instance buffers belong to the scene; template geometry/material disposal stays with AssetLibrary. */
  dispose(): void {
    this.sourceMatrices = null;
    this.previousIndices = null;
    this.nextIndices = null;
    this.lodStates = null;
    this.worldSpheres.length = 0;
  }
}
