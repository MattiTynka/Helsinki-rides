import * as THREE from 'three';

function resources(roots: readonly THREE.Object3D[]): { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material>; textures: Set<THREE.Texture> } {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  for (const root of roots) root.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
    }
  });
  return { geometries, materials, textures };
}

/** Device-transcoded mip bytes, including textures held by invisible actors or an incoming detached cell. */
export function textureBytesOf(roots: readonly THREE.Object3D[]): number {
  let bytes = 0;
  for (const texture of resources(roots).textures) {
    const compressed = texture as THREE.CompressedTexture;
    if (compressed.isCompressedTexture && compressed.mipmaps.length) {
      bytes += compressed.mipmaps.reduce((sum, mip) => sum + (mip as { data: ArrayBufferView }).data.byteLength, 0);
    } else {
      const image = texture.image as { width?: number; height?: number } | undefined;
      bytes += (image?.width ?? 0) * (image?.height ?? 0) * 4 * (texture.generateMipmaps ? 4 / 3 : 1);
    }
  }
  return bytes;
}

/** Unique textures owned by one parsed cell, also used by its bounded upload preparation. */
export function cellTextures(root: THREE.Object3D): readonly THREE.Texture[] { return [...resources([root]).textures]; }

export function geometryBytesOf(root: THREE.Object3D): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const geometry of resources([root]).geometries) {
    for (const attribute of [...Object.values(geometry.attributes), ...(geometry.index ? [geometry.index] : [])]) {
      const array = (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (attribute as THREE.InterleavedBufferAttribute).data.array : (attribute as THREE.BufferAttribute).array;
      buffers.add(array.buffer);
    }
  }
  return [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
}

/** Each parsed cell GLB owns its resources. Never call this on actor clones, which share the asset library. */
export function disposeCellResources(root: THREE.Object3D): void {
  root.removeFromParent();
  const owned = resources([root]);
  for (const geometry of owned.geometries) geometry.dispose();
  for (const material of owned.materials) material.dispose();
  const bitmaps = new Set<ImageBitmap>();
  for (const texture of owned.textures) {
    texture.dispose();
    // Texture.dispose releases GPU storage but Three.js deliberately leaves ImageBitmap.close
    // to the owner. A single bitmap can back several maps/materials inside this independent GLB.
    const image: unknown = texture.source?.data ?? texture.image;
    for (const source of Array.isArray(image) ? image : [image]) {
      if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) bitmaps.add(source);
    }
  }
  for (const bitmap of bitmaps) bitmap.close();
  root.clear();
}
