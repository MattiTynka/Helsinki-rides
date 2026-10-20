import type {CompressedTexture} from 'three';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';

/** Concurrent URL requests can share KTX2Loader's cached Texture object. Each
 * parsed GLB needs its own handle so its sampler settings and disposal cannot
 * affect another cell. Clones retain immutable Source/mip data, allowing Three
 * to reference-count matching GPU allocations across these independent handles. */
export class OwnedKtx2Loader extends KTX2Loader {
  override parse(buffer: ArrayBuffer, onLoad?: (texture: CompressedTexture) => void, onError?: (error: unknown) => void): void {
    super.parse(buffer, onLoad ? texture => onLoad(texture.clone()) : undefined, onError);
  }
}
