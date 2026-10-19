import * as THREE from 'three';

interface Bucket { readonly indices: number[]; readonly bounds: THREE.Box3 }
interface Plan { readonly mesh: THREE.Mesh; readonly buckets: ReadonlyMap<string, Bucket> }
const BATCH_METRES = 64;

function eligible(mesh: THREE.Mesh): boolean {
  const geometry = mesh.geometry, position = geometry.getAttribute('position'), material = mesh.material;
  const count = geometry.index?.count ?? position?.count ?? 0;
  return !(mesh as THREE.SkinnedMesh).isSkinnedMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh
    && !(mesh as THREE.BatchedMesh).isBatchedMesh && !(geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry
    && !!mesh.parent && !!position && position.itemSize === 3 && count > 0 && count % 3 === 0
    && !geometry.indirect && !geometry.index?.normalized && mesh.count === 1
    && !geometry.groups.length && !Object.values(geometry.morphAttributes).some(targets => targets.length)
    && geometry.drawRange.start === 0 && (geometry.drawRange.count === Infinity || geometry.drawRange.count === count)
    && !Array.isArray(material) && !material.transparent && !(material as THREE.ShaderMaterial).isShaderMaterial
    && !(material as THREE.MeshStandardMaterial).displacementMap && !mesh.animations.length
    && !mesh.customDepthMaterial && !mesh.customDistanceMaterial
    && mesh.onBeforeRender === THREE.Object3D.prototype.onBeforeRender && mesh.onAfterRender === THREE.Object3D.prototype.onAfterRender
    && material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile && material.onBeforeRender === THREE.Material.prototype.onBeforeRender
    && mesh.getVertexPosition === THREE.Mesh.prototype.getVertexPosition;
}

function plan(mesh: THREE.Mesh): Plan | null {
  if (!eligible(mesh) || !mesh.matrixWorld.elements.every(Number.isFinite)) return null;
  const matrix = mesh.matrixWorld.elements;
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) return null;
  const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index, count = index?.count ?? position.count;
  const buckets = new Map<string, Bucket>(), local = new THREE.Vector3(), world = new THREE.Vector3();
  for (let start = 0; start < count; start += 3) {
    const ids: number[] = []; let x = 0, z = 0;
    for (let k = 0; k < 3; k++) {
      const id = index ? index.getX(start + k) : start + k;
      if (!Number.isSafeInteger(id) || id < 0 || id >= position.count) return null;
      local.fromBufferAttribute(position, id);
      if (![local.x, local.y, local.z].every(Number.isFinite)) return null;
      world.copy(local).applyMatrix4(mesh.matrixWorld);
      if (![world.x, world.y, world.z].every(Number.isFinite)) return null;
      x += world.x / 3; z += world.z / 3; ids.push(id);
    }
    const key = `${Math.floor(x / BATCH_METRES)},${Math.floor(z / BATCH_METRES)}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { indices: [], bounds: new THREE.Box3() }; buckets.set(key, bucket); }
    for (const id of ids) { bucket.indices.push(id); bucket.bounds.expandByPoint(local.fromBufferAttribute(position, id)); }
  }
  return buckets.size > 1 ? { mesh, buckets } : null;
}

/** Accurate subset bounds: BufferGeometry.computeBoundingSphere scans all shared
 * positions, including vertices which this batch never references. */
function subsetGeometry(source: THREE.BufferGeometry, bucket: Bucket, matrixWorld: THREE.Matrix4): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.name = source.name; geometry.userData = source.userData;
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
  const sourceIndex = source.index;
  const array = sourceIndex?.array instanceof Uint32Array || !sourceIndex && source.getAttribute('position').count > 65535
    ? new Uint32Array(bucket.indices) : new Uint16Array(bucket.indices);
  const index = new THREE.BufferAttribute(array, 1);
  if (sourceIndex) index.setUsage(sourceIndex.usage);
  geometry.setIndex(index);
  geometry.boundingBox = bucket.bounds.clone();
  const center = bucket.bounds.getCenter(new THREE.Vector3()), worldCenter = center.clone().applyMatrix4(matrixWorld), point = new THREE.Vector3();
  let localSquaredRadius = 0, worldSquaredRadius = 0;
  for (const id of bucket.indices) {
    point.fromBufferAttribute(source.getAttribute('position'), id);
    localSquaredRadius = Math.max(localSquaredRadius, center.distanceToSquared(point));
    point.applyMatrix4(matrixWorld); worldSquaredRadius = Math.max(worldSquaredRadius, worldCenter.distanceToSquared(point));
  }
  // Three transforms spheres using max-column scale, which is insufficient for
  // sheared parent transforms. Ensure that exact world referenced vertices fit
  // that renderer sphere as well as the ordinary mesh-local sphere.
  const scale = matrixWorld.getMaxScaleOnAxis();
  const radius = Math.max(Math.sqrt(localSquaredRadius), scale > 0 ? Math.sqrt(worldSquaredRadius) / scale : 0);
  geometry.boundingSphere = new THREE.Sphere(center, radius + 1e-5 * (1 + center.length() + radius));
  return geometry;
}

/** Partition newly parsed, cell-owned static coarse geometry before GPU upload.
 * Every triangle survives once, without changing winding, attributes, materials
 * or node transforms. No threshold, source asset or resident-cell policy changes.
 */
export function partitionCoarseCell(root: THREE.Object3D): { meshes: number; batches: number } {
  root.updateWorldMatrix(true, true);
  const plans: Plan[] = [];
  root.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.isMesh) { const prepared = plan(mesh); if (prepared) plans.push(prepared); } });
  const retired = new Set<THREE.BufferGeometry>(); let batches = 0;
  // Children first: replacing a parent must retain any already-partitioned child.
  for (const { mesh, buckets } of plans.reverse()) {
    const parent = mesh.parent!;
    const originalIndex = parent.children.indexOf(mesh), wrapper = new THREE.Group().copy(mesh, false);
    const source = mesh.geometry;
    for (const child of [...mesh.children]) wrapper.add(child);
    for (const [key, bucket] of buckets) {
      const geometry = subsetGeometry(source, bucket, mesh.matrixWorld), batch = new THREE.Mesh(geometry, mesh.material);
      batch.name = `${mesh.name}:coarse:${key}`;
      batch.layers.mask = mesh.layers.mask; batch.renderOrder = mesh.renderOrder;
      batch.castShadow = mesh.castShadow; batch.receiveShadow = mesh.receiveShadow;
      batch.onBeforeRender = mesh.onBeforeRender; batch.onAfterRender = mesh.onAfterRender;
      wrapper.add(batch); batches++;
    }
    parent.remove(mesh); parent.add(wrapper);
    parent.children.splice(parent.children.indexOf(wrapper), 1); parent.children.splice(originalIndex, 0, wrapper);
    retired.add(source);
  }
  // A geometry may be shared by multiple parsed nodes, including a skipped one.
  // Transfer its buffers only when no original live mesh still needs the wrapper.
  root.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.isMesh) retired.delete(mesh.geometry); });
  for (const geometry of retired) {
    geometry.setIndex(null);
    for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
    // This wrapper was never uploaded. Detaching references before dispose also
    // prevents any listener from deleting buffers now owned by the live subsets.
    geometry.dispose();
  }
  root.updateWorldMatrix(true, true);
  return { meshes: plans.length, batches };
}
