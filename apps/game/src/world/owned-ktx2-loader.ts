import type {CompressedTexture} from 'three';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';
import {dropTopMips, readKtx2Layout} from '@helsinki/world-schema';

export type Ktx2Supercompression = 'zstd' | 'basislz' | 'none';

/** KTX2 file identifier and the header offset of `supercompressionScheme` (KTX 2.0 specification, section 3). */
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const SUPERCOMPRESSION_OFFSET = 44;
const SCHEMES: Readonly<Record<number, Ktx2Supercompression>> = {0: 'none', 1: 'basislz', 2: 'zstd'};

/** The container's supercompression scheme, or null for anything that is not a readable KTX2 header with a known scheme. */
export function ktx2Supercompression(buffer: ArrayBuffer): Ktx2Supercompression | null {
  if (buffer.byteLength < SUPERCOMPRESSION_OFFSET + 4) return null;
  const view = new DataView(buffer);
  if (KTX2_IDENTIFIER.some((byte, i) => view.getUint8(i) !== byte)) return null;
  return SCHEMES[view.getUint32(SUPERCOMPRESSION_OFFSET, true)] ?? null;
}

/** Mip drops leave at least this many pixels on the longer side; smaller textures keep every level. */
const MIP_DROP_MIN_SIZE = 64;

interface Prepared { readonly buffer: ArrayBuffer; readonly supercompression: Ktx2Supercompression | null; readonly mipDropped: 0 | 1 }

/**
 * Per input buffer: what was handed to the vendor loader. The transcoder worker takes ownership of those bytes, and
 * KTX2Loader's task cache is keyed by buffer identity, so every later parse of the same input (concurrent GLB parses
 * of one fetched buffer, cache hits) must hand on the very same buffer. The first parse decides the mip drop.
 */
const prepared = new WeakMap<ArrayBuffer, Prepared>();

/**
 * Zstandard levels are independent, so the top `n` can be cut without re-encoding (`dropTopMips`). Anything else
 * (BasisLZ, too few levels, a result under 64 px, an unexpected layout) keeps the original bytes, silently.
 */
function prepare(buffer: ArrayBuffer, mipDrop: 0 | 1): Prepared {
  const supercompression = ktx2Supercompression(buffer);
  if (mipDrop > 0 && supercompression === 'zstd') {
    try {
      const bytes = new Uint8Array(buffer), layout = readKtx2Layout(bytes);
      const size = Math.max(layout.width >> mipDrop, layout.height >> mipDrop);
      if (layout.levelCount >= mipDrop + 1 && size >= MIP_DROP_MIN_SIZE) {
        const stripped = dropTopMips(bytes, mipDrop);
        return {buffer: stripped.buffer as ArrayBuffer, supercompression, mipDropped: mipDrop};
      }
    } catch { /* Not the packed single-image layout: transcode the original. */ }
  }
  return {buffer, supercompression, mipDropped: 0};
}

/** Concurrent URL requests can share KTX2Loader's cached Texture object. Each
 * parsed GLB needs its own handle so its sampler settings and disposal cannot
 * affect another cell. Clones retain immutable Source/mip data, allowing Three
 * to reference-count matching GPU allocations across these independent handles.
 * Each handle records its container's supercompression and whether its top
 * mip level was dropped in `userData.ktx2` for the review texture census
 * (Zstandard levels can be dropped, BasisLZ cannot). */
export class OwnedKtx2Loader extends KTX2Loader {
  private mipDrop: 0 | 1 = 0;

  /** Minimal tier: transcode Zstandard textures without their largest mip level (applies to later parses). */
  setMipDrop(n: 0 | 1): this {
    this.mipDrop = n === 1 ? 1 : 0;
    return this;
  }

  get mipDropCount(): 0 | 1 { return this.mipDrop; }

  /**
   * Prefer 4 bpp transcode targets: when S3TC or ETC2 is available, BC7 and ASTC (8 bpp) are not used, so UASTC
   * textures occupy half the GPU memory at some loss of quality. Workers copy the configuration when they are created,
   * so this applies only before the first load; returns whether the configuration changed.
   */
  preferCompactTranscode(): boolean {
    const config = this.workerConfig as typeof this.workerConfig | null;
    if (!config || this.transcoderPending || !(config.dxtSupported || config.etc2Supported)) return false;
    config.bptcSupported = false;
    config.astcSupported = false;
    config.astcHDRSupported = false;
    return true;
  }

  override parse(buffer: ArrayBuffer, onLoad?: (texture: CompressedTexture) => void, onError?: (error: unknown) => void): void {
    let input = prepared.get(buffer);
    if (!input) { input = prepare(buffer, this.mipDrop); prepared.set(buffer, input); }
    const {supercompression, mipDropped} = input;
    const own = (texture: CompressedTexture): CompressedTexture => {
      const handle = texture.clone();
      if (supercompression) handle.userData['ktx2'] = {supercompression, mipDropped};
      return handle;
    };
    super.parse(input.buffer, onLoad ? texture => onLoad(own(texture)) : undefined, onError);
  }
}
