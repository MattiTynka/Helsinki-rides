// GLB assembly for baked cells and props: glTF-Transform documents with KHR_texture_basisu (KTX2 textures encoded in
// Node by ktx2-encoder), EXT_meshopt_compression (meshoptimizer) and KHR_materials_unlit where the lighting decision
// asks for it. Positions are runtime-frame metres; one mesh primitive per material keeps draw calls at one per
// atlas per cell (plan section 4.1 step 6).
import { createHash } from 'node:crypto';
import { Document, NodeIO, type Material, type Scene, type Texture } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMaterialsUnlit, KHRTextureBasisu, ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { reorder, quantize, dedup } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { declareQuantizedAttributes } from './glb-quantization.ts';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface MeshData {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals?: Float32Array;
  readonly uvs?: Float32Array;
  readonly indices: Uint32Array;
  readonly materialName: string;
  readonly extras?: Record<string, unknown>;
}

export interface MaterialSpec {
  readonly name: string;
  readonly baseColor?: [number, number, number, number];
  readonly texture?: RgbaImage;
  readonly textureKind?: 'facade' | 'roof' | 'photo' | 'generic';
  readonly unlit: boolean;
  readonly roughness?: number;
  readonly metallic?: number;
  readonly doubleSided?: boolean;
  /** glTF material extras; `bakedLighting: true` marks photo textures that already carry the flight's light. */
  readonly extras?: Record<string, unknown>;
}

type KtxModule = { encodeToKTX2: (buffer: Uint8Array, options: Record<string, unknown>) => Promise<Uint8Array> };
let ktx: Promise<KtxModule> | null = null;
function ktxModule(): Promise<KtxModule> {
  // The package's exports map only offers an "import" condition, so resolve it as an ES module import.
  if (!ktx) ktx = import('ktx2-encoder') as unknown as Promise<KtxModule>;
  return ktx;
}

/** Encode an sRGB RGBA image to KTX2 with a full mip chain: UASTC for facades (crisp), ETC1S for roofs and photo bakes. */
export async function encodeKtx2(img: RgbaImage, kind: MaterialSpec['textureKind'] = 'generic'): Promise<Uint8Array> {
  const mod = await ktxModule();
  const uastc = kind === 'facade';
  const silence = process.stdout.write.bind(process.stdout);
  // The Basis encoder logs every slice to stdout; keep the build log readable.
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await mod.encodeToKTX2(img.data, {
      isUASTC: uastc, generateMipmap: true, isPerceptual: true, isSetKTX2SRGBTransferFunc: true,
      needSupercompression: uastc, qualityLevel: 160, compressionLevel: 2, uastcLDRQualityLevel: 1,
      imageDecoder: async () => ({ width: img.width, height: img.height, data: img.data }),
    });
  } finally {
    process.stdout.write = silence;
  }
}

export class GlbBuilder {
  readonly doc = new Document();
  readonly name: string;
  private readonly materials = new Map<string, Material>();
  private readonly scene: Scene;
  private readonly unlitExt: KHRMaterialsUnlit;
  private readonly basisExt: KHRTextureBasisu;
  readonly stats = { triangles: 0, primitives: 0, textureBytes: 0, textureTexels: 0, residentBytes: 0 };
  /** sha256 -> estimated GPU bytes, so textures shared between cells (ground tiles, palette) count once per scene. */
  readonly textureHashes = new Map<string, number>();

  constructor(name: string) {
    this.name = name;
    this.scene = this.doc.createScene(name);
    this.doc.createBuffer('bin');
    this.unlitExt = this.doc.createExtension(KHRMaterialsUnlit);
    this.basisExt = this.doc.createExtension(KHRTextureBasisu).setRequired(true);
  }

  async material(spec: MaterialSpec): Promise<Material> {
    const existing = this.materials.get(spec.name);
    if (existing) return existing;
    const m = this.doc.createMaterial(spec.name)
      .setBaseColorFactor(spec.baseColor ?? [1, 1, 1, 1])
      .setRoughnessFactor(spec.roughness ?? 0.9)
      .setMetallicFactor(spec.metallic ?? 0)
      .setDoubleSided(spec.doubleSided ?? false);
    if (spec.unlit) m.setExtension('KHR_materials_unlit', this.unlitExt.createUnlit());
    if (spec.extras) m.setExtras(spec.extras as Record<string, never>);
    if (spec.texture) {
      const bytes = await encodeKtx2(spec.texture, spec.textureKind);
      const tex: Texture = this.doc.createTexture(spec.name).setImage(bytes).setMimeType('image/ktx2');
      m.setBaseColorTexture(tex);
      this.stats.textureBytes += bytes.byteLength;
      this.stats.textureTexels += spec.texture.width * spec.texture.height;
      // UASTC transcodes to BC7/ASTC (1 byte per texel), ETC1S to BC1/ETC1 (0.5); mip chains add a third.
      const perTexel = spec.textureKind === 'facade' ? 1 : 0.5;
      const resident = Math.round(spec.texture.width * spec.texture.height * perTexel * 1.333);
      this.stats.residentBytes += resident;
      this.textureHashes.set(createHash('sha256').update(bytes).digest('hex'), resident);
    }
    this.materials.set(spec.name, m);
    return m;
  }

  async addMesh(data: MeshData, spec: MaterialSpec): Promise<void> {
    if (data.indices.length === 0) return;
    const material = await this.material(spec);
    // glTF-Transform wants arrays over a plain ArrayBuffer; ours are (SharedArrayBuffer-free) views.
    const arr = <T extends Float32Array | Uint32Array>(a: T): T extends Float32Array ? Float32Array<ArrayBuffer> : Uint32Array<ArrayBuffer> => a as unknown as T extends Float32Array ? Float32Array<ArrayBuffer> : Uint32Array<ArrayBuffer>;
    const pos = this.doc.createAccessor().setType('VEC3').setArray(arr(data.positions)).setBuffer(this.doc.getRoot().listBuffers()[0]!);
    const prim = this.doc.createPrimitive().setAttribute('POSITION', pos).setMaterial(material)
      .setIndices(this.doc.createAccessor().setType('SCALAR').setArray(arr(data.indices)).setBuffer(this.doc.getRoot().listBuffers()[0]!));
    if (data.normals) prim.setAttribute('NORMAL', this.doc.createAccessor().setType('VEC3').setArray(arr(data.normals)).setBuffer(this.doc.getRoot().listBuffers()[0]!));
    if (data.uvs) prim.setAttribute('TEXCOORD_0', this.doc.createAccessor().setType('VEC2').setArray(arr(data.uvs)).setBuffer(this.doc.getRoot().listBuffers()[0]!));
    const mesh = this.doc.createMesh(data.name).addPrimitive(prim);
    const node = this.doc.createNode(data.name).setMesh(mesh);
    if (data.extras) node.setExtras(data.extras as Record<string, never>);
    this.scene.addChild(node);
    this.stats.triangles += data.indices.length / 3;
    this.stats.primitives++;
  }

  addEmpty(name: string, translation: [number, number, number], extras?: Record<string, unknown>): void {
    const node = this.doc.createNode(name).setTranslation(translation);
    if (extras) node.setExtras(extras as Record<string, never>);
    this.scene.addChild(node);
  }

  /** Quantise, reorder and meshopt-compress, then serialise to GLB bytes. */
  async toGlb(copyright: string, extras?: Record<string, unknown>, positionEncoding: 'quantized' | 'exact' = 'quantized'): Promise<Uint8Array> {
    this.doc.getRoot().getAsset().copyright = copyright;
    this.doc.getRoot().getAsset().generator = 'helsinki-open-world cell builder';
    if (extras) this.doc.getRoot().setExtras(extras as Record<string, never>);
    await MeshoptEncoder.ready;
    // Ground crosses material and cell boundaries. Independent quantization volumes move identical shared
    // vertices apart, opening visible cracks; preserve its Float32 coordinates through meshopt compression.
    const pattern = positionEncoding === 'exact' ? /^(?!POSITION$)/ : /.*/;
    await this.doc.transform(dedup({ propertyTypes: ['Accessor'] }), reorder({ encoder: MeshoptEncoder }), quantize({ pattern, quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
    this.doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
    return declareQuantizedAttributes(await io.writeBinary(this.doc));
  }
}

/** Flat-shaded normals from triangle geometry (positions are unshared per triangle after `unshare`). */
export function flatNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const i of [a, b, c]) { n[i] = n[i]! + nx; n[i + 1] = n[i + 1]! + ny; n[i + 2] = n[i + 2]! + nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
    n[i] = n[i]! / len; n[i + 1] = n[i + 1]! / len; n[i + 2] = n[i + 2]! / len;
  }
  return n;
}
