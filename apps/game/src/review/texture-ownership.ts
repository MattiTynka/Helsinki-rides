// Review-only renderer ownership census; imported only by the excluded production test adapter.
import * as THREE from 'three';

export interface TexturePropertiesReader {
  has(object: object): boolean;
  get(object: object): unknown;
}
export interface TextureOwnershipSnapshot {
  materialTextureHandles: number;
  boneTextureHandles: number;
  logicalTextureHandles: number;
  uniformTextureHandles: number;
  unuploadedTextureHandles: number;
  allocatedTextureHandles: number;
  ownedGpuTextures: number;
  rendererTextures: number;
  unaccountedGpuTextures: number;
  /** Only allocations with measured formats; unmeasuredGpuTextures must be zero before accepting this bound. */
  ownedGpuBytes: number;
  ownedGpuMiB: number;
  unmeasuredGpuTextures: number;
  unmeasuredTextureIds: number[];
  sharedHandleSavings: number;
  sharedBytesSaved: number;
  sharedAllocations: { textureIds: number[]; sourceIds: number[]; gpuBytes: number; savedBytes: number }[];
  uniformAllocations: { uniforms: string[]; width: number; height: number; format: number; type: number; bytes: number | null }[];
}

/** Known runtime formats only. Unknown storage fails the census instead of silently counting zero bytes. */
export function textureStorageBytes(texture: THREE.Texture): number | null {
  if ((texture as THREE.CompressedTexture).isCompressedTexture) {
    const mips = (texture as THREE.CompressedTexture).mipmaps;
    if (!mips.length || mips.some(mip => !('data' in mip) || !ArrayBuffer.isView(mip.data))) return null;
    return mips.reduce((sum, mip) => sum + (mip as { data: ArrayBufferView }).data.byteLength, 0);
  }
  // An explicit internal format can allocate a different scalar width from the upload type.
  // Current scene images/palettes use the renderer's default sized format; reject overrides.
  if (texture.internalFormat !== null) return null;
  const image = texture.image as { width?: number; height?: number; depth?: number; data?: ArrayBufferView } | undefined;
  const width = image?.width, height = image?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !(width! > 0) || !(height! > 0) || (image?.depth ?? 1) !== 1) return null;
  const channels = texture.format === THREE.RGBAFormat ? 4 : texture.format === THREE.RGFormat ? 2 : texture.format === THREE.RedFormat ? 1 : null;
  const componentBytes = texture.type === THREE.UnsignedByteType || texture.type === THREE.ByteType ? 1
    : texture.type === THREE.HalfFloatType || texture.type === THREE.UnsignedShortType || texture.type === THREE.ShortType ? 2
      : texture.type === THREE.FloatType || texture.type === THREE.UnsignedIntType || texture.type === THREE.IntType ? 4 : null;
  if (channels === null || componentBytes === null || texture.mipmaps.length) return null;
  const bytesPerPixel = channels * componentBytes;
  // Data textures include the actual palette's scalar type: RGBA32F is sixteen bytes per texel.
  if (image?.data && image.data.byteLength !== width! * height! * bytesPerPixel) return null;
  let bytes = 0, w = width!, h = height!;
  for (;;) {
    bytes += w * h * bytesPerPixel;
    if (!texture.generateMipmaps || (w === 1 && h === 1)) return bytes;
    w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
  }
}

/** Traverse even hidden live owners. GL handles are identity keys only and never leave this function. */
export function inspectTextureOwnership(root: THREE.Object3D, properties: TexturePropertiesReader, rendererTextures: number): TextureOwnershipSnapshot {
  const materialTextures = new Set<THREE.Texture>(), boneTextures = new Set<THREE.Texture>();
  const uniformTextures = new Map<THREE.Texture, Set<string>>(), materials = new Set<THREE.Material>();
  const existingProperties = (object: object): Record<string, unknown> | undefined => {
    const value = properties.has(object) ? properties.get(object) : undefined;
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  };
  const texture = (value: unknown): value is THREE.Texture => !!value && typeof value === 'object' && (value as THREE.Texture).isTexture === true;
  root.traverse(node => {
    const mesh = node as THREE.Mesh, material = mesh.material;
    if (material) for (const m of Array.isArray(material) ? material : [material]) {
      if (materials.has(m)) continue;
      materials.add(m);
      for (const value of Object.values(m)) if (texture(value)) materialTextures.add(value);
      // Three's compiled PBR uniforms own the shared DFG_LUT (RG16F); it is not a material map.
      // Read existing properties only: get() alone would create entries for never-rendered owners.
      const uniforms = existingProperties(m)?.uniforms;
      if (uniforms && typeof uniforms === 'object') for (const [name, uniform] of Object.entries(uniforms)) {
        const value = (uniform as { value?: unknown } | null)?.value;
        for (const item of Array.isArray(value) ? value : [value]) if (texture(item)) {
          const names = uniformTextures.get(item) ?? new Set<string>(); names.add(name); uniformTextures.set(item, names);
        }
      }
    }
    const bone = (node as THREE.SkinnedMesh).isSkinnedMesh ? (node as THREE.SkinnedMesh).skeleton?.boneTexture : null;
    if (bone) boneTextures.add(bone);
  });
  const logical = new Set([...materialTextures, ...boneTextures]);
  const owned = new Set([...logical, ...uniformTextures.keys()]);
  const allocations = new Map<object, { textures: THREE.Texture[]; bytes: number | null }>();
  let unuploaded = 0, allocatedHandles = 0;
  for (const t of owned) {
    const handle = existingProperties(t)?.__webglTexture;
    if (!handle || typeof handle !== 'object') { unuploaded++; continue; }
    allocatedHandles++;
    const bytes = textureStorageBytes(t), previous = allocations.get(handle);
    if (previous) {
      previous.textures.push(t);
      if (previous.bytes !== bytes) previous.bytes = null; // Aliases must describe identical allocated storage.
    } else allocations.set(handle, { textures: [t], bytes });
  }
  let ownedGpuBytes = 0, unmeasured = 0, saved = 0;
  const unmeasuredTextureIds: number[] = [], sharedAllocations: TextureOwnershipSnapshot['sharedAllocations'] = [];
  for (const { textures, bytes } of allocations.values()) {
    if (bytes === null) { unmeasured++; unmeasuredTextureIds.push(...textures.map(t => t.id)); continue; }
    ownedGpuBytes += bytes;
    if (textures.length > 1) {
      const savedBytes = bytes * (textures.length - 1); saved += savedBytes;
      sharedAllocations.push({ textureIds: textures.map(t => t.id), sourceIds: [...new Set(textures.map(t => t.source.id))], gpuBytes: bytes, savedBytes });
    }
  }
  return {
    materialTextureHandles: materialTextures.size, boneTextureHandles: boneTextures.size, logicalTextureHandles: owned.size,
    uniformTextureHandles: [...uniformTextures.keys()].filter(t => !logical.has(t)).length,
    unuploadedTextureHandles: unuploaded, allocatedTextureHandles: allocatedHandles, ownedGpuTextures: allocations.size,
    rendererTextures, unaccountedGpuTextures: rendererTextures - allocations.size, ownedGpuBytes, ownedGpuMiB: ownedGpuBytes / 2 ** 20,
    unmeasuredGpuTextures: unmeasured, unmeasuredTextureIds,
    sharedHandleSavings: allocatedHandles - allocations.size, sharedBytesSaved: saved, sharedAllocations,
    uniformAllocations: [...uniformTextures].filter(([t]) => !logical.has(t)).map(([t, names]) => {
      const image = t.image as { width?: number; height?: number } | undefined;
      return { uniforms: [...names].sort(), width: image?.width ?? 0, height: image?.height ?? 0, format: t.format, type: t.type, bytes: textureStorageBytes(t) };
    }),
  };
}
