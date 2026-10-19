import * as THREE from 'three';

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
interface Influence {
  readonly index: number;
  readonly bone: THREE.Bone;
  readonly inverse: THREE.Matrix4;
  readonly sphere: THREE.Sphere;
}
interface SkinCache {
  readonly geometry: THREE.BufferGeometry;
  readonly skeleton: THREE.Skeleton;
  readonly attributes: readonly { name: string; attribute: Attribute; revision: number }[];
  readonly bind: THREE.Matrix4;
  readonly influences: readonly Influence[];
  readonly weightError: number;
  readonly maxWeightSum: number;
  readonly positionMagnitude: number;
}
interface MeshState {
  readonly mesh: THREE.SkinnedMesh;
  readonly cache: SkinCache | null;
  readonly sphere: THREE.Sphere;
  readonly previousSphere: THREE.SkinnedMesh['boundingSphere'];
  readonly previousCulling: boolean;
}

// A four-influence Float32 shader performs matrix products, weighted additions
// and bind transforms. Bound their roundoff using absolute intermediate values,
// including translations which may cancel in the final mesh-local position.
const FLOAT_UNIT = 2 ** -24;
const FLOAT_GAMMA = 128 * FLOAT_UNIT / (1 - 128 * FLOAT_UNIT);
const WEIGHT_TOLERANCE = 1e-5;
const revision = (attribute: Attribute): number => 'data' in attribute ? attribute.data.version : attribute.version;
const magnitude = (point: THREE.Vector3): number => Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
function affine(matrix: THREE.Matrix4): boolean {
  const e = matrix.elements;
  return e.every(Number.isFinite) && e[3] === 0 && e[7] === 0 && e[11] === 0 && Math.abs(e[15]! - 1) < 64 * Number.EPSILON;
}
function absoluteTransformBound(matrix: THREE.Matrix4, input: number): number {
  const e = matrix.elements;
  return Math.max(...[0, 1, 2].map(row => input * (Math.abs(e[row]!) + Math.abs(e[row + 4]!) + Math.abs(e[row + 8]!)) + Math.abs(e[row + 12]!)));
}
/** sqrt(||A^T A||_infinity) bounds the largest singular value, including shear. */
function stretch(matrix: THREE.Matrix4): number {
  const e = matrix.elements;
  const a = e[0]! ** 2 + e[1]! ** 2 + e[2]! ** 2;
  const b = e[4]! ** 2 + e[5]! ** 2 + e[6]! ** 2;
  const c = e[8]! ** 2 + e[9]! ** 2 + e[10]! ** 2;
  const ab = Math.abs(e[0]! * e[4]! + e[1]! * e[5]! + e[2]! * e[6]!);
  const ac = Math.abs(e[0]! * e[8]! + e[1]! * e[9]! + e[2]! * e[10]!);
  const bc = Math.abs(e[4]! * e[8]! + e[5]! * e[9]! + e[6]! * e[10]!);
  return Math.sqrt(Math.max(a + ab + ac, b + ab + bc, c + ac + bc)) * (1 + 32 * Number.EPSILON);
}
function cacheSkin(mesh: THREE.SkinnedMesh): SkinCache | null {
  const geometry = mesh.geometry, skeleton = mesh.skeleton;
  const position = geometry.getAttribute('position'), indices = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
  if (!skeleton || !position || !indices || !weights || !position.count || position.itemSize !== 3 || indices.itemSize !== 4 || weights.itemSize !== 4 || indices.count !== position.count || weights.count !== position.count || !affine(mesh.bindMatrix)) return null;
  if (mesh.getVertexPosition !== THREE.SkinnedMesh.prototype.getVertexPosition) return null;
  const material = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (material.some(m => (m as THREE.ShaderMaterial).isShaderMaterial || (m as THREE.MeshStandardMaterial).displacementMap)) return null;
  const spheres = new Map<number, Influence>(), transforms = new Map<number, THREE.Matrix4>();
  const point = new THREE.Vector3(), transformedPoint = new THREE.Vector3(), index = new THREE.Vector4(), weight = new THREE.Vector4();
  let weightError = 0, maxWeightSum = 0, positionMagnitude = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    point.fromBufferAttribute(position, vertex);
    if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
    positionMagnitude = Math.max(positionMagnitude, magnitude(point));
    index.set(indices.getX(vertex), indices.getY(vertex), indices.getZ(vertex), indices.getW(vertex));
    weight.set(weights.getX(vertex), weights.getY(vertex), weights.getZ(vertex), weights.getW(vertex));
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = weight.getComponent(k);
      if (!Number.isFinite(w) || w < 0) return null;
      sum += w;
      if (!w) continue;
      const boneIndex = index.getComponent(k), bone = skeleton.bones[boneIndex], inverse = skeleton.boneInverses[boneIndex];
      if (!Number.isSafeInteger(boneIndex) || !bone || !inverse || !affine(inverse)) return null;
      let influence = spheres.get(boneIndex);
      if (!influence) {
        influence = { index: boneIndex, bone, inverse: inverse.clone(), sphere: new THREE.Sphere().makeEmpty() };
        spheres.set(boneIndex, influence);
        transforms.set(boneIndex, new THREE.Matrix4().multiplyMatrices(inverse, mesh.bindMatrix));
      }
      // Do not normalize or otherwise rewrite the source weights/vertices.
      influence.sphere.expandByPoint(transformedPoint.fromBufferAttribute(position, vertex).applyMatrix4(transforms.get(boneIndex)!));
    }
    const error = Math.abs(sum - 1);
    if (error > WEIGHT_TOLERANCE) return null;
    weightError = Math.max(weightError, error); maxWeightSum = Math.max(maxWeightSum, sum);
  }
  return {
    geometry, skeleton, bind: mesh.bindMatrix.clone(), influences: [...spheres.values()], weightError, maxWeightSum, positionMagnitude,
    attributes: ['position', 'skinIndex', 'skinWeight'].map(name => { const attribute = geometry.getAttribute(name); return { name, attribute, revision: revision(attribute) }; }),
  };
}
function unchanged(mesh: THREE.SkinnedMesh, cache: SkinCache): boolean {
  return mesh.geometry === cache.geometry && mesh.skeleton === cache.skeleton && mesh.bindMatrix.equals(cache.bind)
    && cache.attributes.every(a => mesh.geometry.getAttribute(a.name) === a.attribute && revision(a.attribute) === a.revision)
    && cache.influences.every(i => mesh.skeleton.bones[i.index] === i.bone && !!mesh.skeleton.boneInverses[i.index]?.equals(i.inverse));
}

/**
 * Posed per-mesh bounds, independent of the camera and of visibility state.
 * Call after all procedural/animation layers and updateMatrixWorld(true).
 * Geometry, weights, bind matrices and bone matrices are read only. Immutable
 * source versions are cached once; changed/unsupported sources remain rendered.
 */
export class SkinnedMeshCuller {
  private readonly states: MeshState[] = [];
  private readonly transform = new THREE.Matrix4();
  private readonly boneTransform = new THREE.Matrix4();
  private readonly transformed = new THREE.Sphere();
  private readonly translation = new THREE.Vector3();

  constructor(root: THREE.Object3D) {
    root.traverse(object => {
      const mesh = object as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) this.states.push({ mesh, cache: cacheSkin(mesh), sphere: new THREE.Sphere(), previousSphere: mesh.boundingSphere, previousCulling: mesh.frustumCulled });
    });
  }

  update(): void {
    for (const state of this.states) {
      const { mesh, cache, sphere } = state;
      // Rendering is the safe fallback: never reuse stale bind-pose bounds.
      mesh.frustumCulled = false;
      if (!cache || !unchanged(mesh, cache) || !affine(mesh.matrixWorld) || !affine(mesh.bindMatrixInverse)
        || !cache.influences.every(i => affine(i.bone.matrixWorld))) continue;
      const meshScale = mesh.matrixWorld.getMaxScaleOnAxis(), worldScale = stretch(mesh.matrixWorld);
      if (!(meshScale > 0) || !Number.isFinite(worldScale)) continue;
      mesh.boundingSphere = sphere;
      let roundoffMagnitude = 0;
      const hasMorphPositions = !!mesh.geometry.morphAttributes.position?.length;
      if (hasMorphPositions) {
        if (mesh.morphTargetInfluences?.some(w => !Number.isFinite(w))) continue;
        // Morph targets are not bounded by the cached base-position influences.
        mesh.computeBoundingSphere();
        roundoffMagnitude = magnitude(sphere.center) + sphere.radius;
      } else {
        sphere.makeEmpty();
        const inputBound = absoluteTransformBound(mesh.bindMatrix, cache.positionMagnitude);
        let skinBound = 0;
        for (const influence of cache.influences) {
          this.transform.multiplyMatrices(mesh.bindMatrixInverse, influence.bone.matrixWorld);
          this.transformed.copy(influence.sphere);
          this.transformed.center.applyMatrix4(this.transform);
          this.transformed.radius *= stretch(this.transform);
          sphere.union(this.transformed);
          this.boneTransform.multiplyMatrices(influence.bone.matrixWorld, influence.inverse);
          skinBound = Math.max(skinBound, absoluteTransformBound(this.boneTransform, inputBound));
        }
        // If weights sum to S ~= 1, actual skinning is S*C + (1-S)*bindInverse.translation.
        // This padding contains that deviation without changing the original weights.
        this.translation.setFromMatrixPosition(mesh.bindMatrixInverse);
        sphere.radius += cache.weightError * (sphere.center.distanceTo(this.translation) + sphere.radius);
        roundoffMagnitude = absoluteTransformBound(mesh.bindMatrixInverse, skinBound * cache.maxWeightSum);
      }
      if (![sphere.radius, sphere.center.x, sphere.center.y, sphere.center.z, roundoffMagnitude].every(Number.isFinite) || sphere.radius < 0) continue;
      sphere.radius += Math.sqrt(3) * FLOAT_GAMMA * (1 + roundoffMagnitude);
      // Three applies max-column scale to mesh.boundingSphere. Compensate when
      // a nonuniform ancestor plus rotation makes matrixWorld contain shear.
      sphere.radius *= Math.max(1, worldScale / meshScale);
      if (Number.isFinite(sphere.radius)) mesh.frustumCulled = true;
    }
  }

  dispose(): void {
    for (const state of this.states) {
      state.mesh.boundingSphere = state.previousSphere;
      state.mesh.frustumCulled = state.previousCulling;
    }
    this.states.length = 0;
  }
}
