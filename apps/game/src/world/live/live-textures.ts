// Live city textures (docs/live-kartta-cells-plan-2026-10-30.md, section 5): one GPU texture per LoD2 tile image,
// shared by every live square and view that uses it and disposed when the last holder releases it. The images are
// transcoded by the game's own KTX2 loader (its worker pool and device formats). Cell disposal leaves textures flagged
// `userData.liveShared` to this cache (render/cell-resources.ts).
import * as THREE from 'three';
import type { OwnedKtx2Loader } from '../owned-ktx2-loader.ts';
import type { LiveTextureBytes } from './contract.ts';

/** One holder's claim on a shared texture; `release` is idempotent. */
export interface LiveTextureLease {
  readonly key: string;
  readonly texture: Promise<THREE.CompressedTexture>;
  release(): void;
}

interface Entry {
  readonly key: string;
  refs: number;
  texture: THREE.CompressedTexture | null;
  readonly promise: Promise<THREE.CompressedTexture>;
}

export class LiveTextures {
  private readonly entries = new Map<string, Entry>();
  private readonly ktx2: OwnedKtx2Loader;
  private disposed = false;

  constructor(ktx2: OwnedKtx2Loader) { this.ktx2 = ktx2; }

  /** Textures currently held or transcoding. */
  get size(): number { return this.entries.size; }

  acquire(image: LiveTextureBytes): LiveTextureLease {
    if (this.disposed) {
      const texture = Promise.reject(new Error('Live textures are disposed'));
      texture.catch(() => {});
      return { key: image.key, texture, release: () => {} };
    }
    let entry = this.entries.get(image.key);
    if (!entry) { entry = this.load(image); this.entries.set(image.key, entry); }
    entry.refs++;
    const held = entry;
    let released = false;
    return { key: image.key, texture: held.promise, release: () => { if (!released) { released = true; this.release(held); } } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) { entry.texture?.dispose(); entry.texture = null; }
    this.entries.clear();
  }

  private load(image: LiveTextureBytes): Entry {
    let entry!: Entry; // assigned below, before either callback can run
    const promise = this.transcode(image.bytes).then(texture => {
      configure(texture, image.key);
      // Every holder may have left while the worker ran; nobody can draw this texture then.
      if (this.disposed || entry.refs === 0 || this.entries.get(entry.key) !== entry) {
        texture.dispose();
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        return texture;
      }
      entry.texture = texture;
      return texture;
    }, (error: unknown) => {
      // A later acquire transcodes again.
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      throw error;
    });
    promise.catch(() => {});
    entry = { key: image.key, refs: 0, texture: null, promise };
    return entry;
  }

  private release(entry: Entry): void {
    if (--entry.refs > 0 || !entry.texture) return; // A pending transcode decides on arrival.
    entry.texture.dispose();
    entry.texture = null;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }

  /**
   * The source hands each image's bytes over (already copied out of its worker). The transcoder worker takes ownership
   * of the buffer, and KTX2Loader caches its task by the buffer's identity, so a later acquire of the very same buffer
   * gets a fresh handle of the same transcode. The tiles are ETC1S (BasisLZ): the loader's Zstandard mip drop never applies.
   */
  private transcode(bytes: ArrayBuffer): Promise<THREE.CompressedTexture> {
    return new Promise((resolve, reject) => {
      try { this.ktx2.parse(bytes, resolve, reject); } catch (error) { reject(error); }
    });
  }
}

/**
 * glTF conventions as GLTFLoader applies them to the release's facade textures: no flip (UVs are top-left), sRGB base
 * colour and repeat wrapping. The minification filter stays the transcoder's: the tiles carry a single level, which a
 * mipmapped filter would leave incomplete on the GPU.
 */
function configure(texture: THREE.CompressedTexture, key: string): void {
  texture.name = `live:${key}`;
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = texture.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.userData['liveShared'] = true;
  texture.needsUpdate = true;
}
