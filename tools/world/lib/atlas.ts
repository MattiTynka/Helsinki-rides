// Texture atlasing for a cell (plan section 4.1 step 6): every source texture used by the cell's buildings is
// resampled to its texel cap, optionally graded, shelf-packed into as few 4096² atlases as needed with 16 px gutters,
// and the placement is returned so UVs can be remapped. Masters are PNG files written by convert_city_model.ts or
// images generated in the build (photo bakes).
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { RgbaImage } from './gltf.ts';

export interface AtlasInput {
  readonly id: string;
  /** PNG master on disk, or `image` for a texture generated in the build. */
  readonly file?: string;
  readonly image?: RgbaImage;
  readonly width: number;
  readonly height: number;
  /** Longest-side cap in pixels after resampling. */
  readonly cap: number;
}

export interface Placement {
  readonly atlas: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface AtlasResult {
  readonly atlases: RgbaImage[];
  readonly placements: Map<string, Placement>;
  readonly fillRatio: number[];
}

const GUTTER = 16;

/** Applied to each resampled input before packing (the facade grade), with the input's id. */
export type Prepare = (rgba: Uint8Array, width: number, height: number, id: string) => Promise<Uint8Array>;

export async function buildAtlases(inputs: readonly AtlasInput[], maxSize = 4096, prepare?: Prepare): Promise<AtlasResult> {
  // Resample each input to its cap (power-of-two friendly but not required) and keep raw RGBA.
  const items: { id: string; w: number; h: number; data: Uint8Array }[] = [];
  for (const input of inputs) {
    const scale = Math.min(1, input.cap / Math.max(input.width, input.height));
    const w = Math.max(4, Math.round(input.width * scale)), h = Math.max(4, Math.round(input.height * scale));
    let rgba: Uint8Array;
    if (input.image && w === input.image.width && h === input.image.height) rgba = input.image.data;
    else {
      const src = input.image ? sharp(input.image.data, { raw: { width: input.image.width, height: input.image.height, channels: 4 } })
        : sharp(readFileSync(input.file!));
      const { data } = await src.resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    items.push({ id: input.id, w, h, data: prepare ? await prepare(rgba, w, h, input.id) : rgba });
  }
  // Shelf packing: tallest first, rows of decreasing height.
  items.sort((a, b) => b.h - a.h || b.w - a.w);
  interface Shelf { y: number; height: number; x: number }
  interface Atlas { shelves: Shelf[]; nextY: number; data: Uint8Array; used: number }
  const atlases: Atlas[] = [];
  const placements = new Map<string, Placement>();
  const newAtlas = (): Atlas => { const a = { shelves: [], nextY: GUTTER, data: new Uint8Array(maxSize * maxSize * 4), used: 0 }; atlases.push(a); return a; };
  for (const it of items) {
    if (it.w + 2 * GUTTER > maxSize || it.h + 2 * GUTTER > maxSize) throw new Error(`${it.id}: ${it.w}x${it.h} does not fit a ${maxSize} atlas`);
    let placed = false;
    for (let ai = 0; ai < atlases.length && !placed; ai++) {
      const a = atlases[ai]!;
      for (const s of a.shelves) {
        if (it.h <= s.height && s.x + it.w + GUTTER <= maxSize) {
          place(a, ai, s.x, s.y, it);
          s.x += it.w + GUTTER;
          placed = true;
          break;
        }
      }
      if (!placed && a.nextY + it.h + GUTTER <= maxSize) {
        const s: Shelf = { y: a.nextY, height: it.h, x: GUTTER };
        a.shelves.push(s);
        a.nextY += it.h + GUTTER;
        place(a, ai, s.x, s.y, it);
        s.x += it.w + GUTTER;
        placed = true;
      }
    }
    if (!placed) {
      const a = newAtlas();
      const ai = atlases.length - 1;
      const s: Shelf = { y: a.nextY, height: it.h, x: GUTTER };
      a.shelves.push(s);
      a.nextY += it.h + GUTTER;
      place(a, ai, s.x, s.y, it);
      s.x += it.w + GUTTER;
    }
  }
  function place(a: Atlas, ai: number, x: number, y: number, it: { id: string; w: number; h: number; data: Uint8Array }) {
    for (let row = 0; row < it.h; row++) a.data.set(it.data.subarray(row * it.w * 4, (row + 1) * it.w * 4), ((y + row) * maxSize + x) * 4);
    // Gutter bleed: repeat edge texels so mip levels do not pull in neighbours.
    for (let g = 1; g <= GUTTER / 2; g++) {
      for (let row = 0; row < it.h; row++) {
        const left = ((y + row) * maxSize + x) * 4, right = ((y + row) * maxSize + x + it.w - 1) * 4;
        a.data.copyWithin(left - g * 4, left, left + 4);
        a.data.copyWithin(right + g * 4, right, right + 4);
      }
      const top = (y * maxSize + x - GUTTER / 2) * 4, bottom = ((y + it.h - 1) * maxSize + x - GUTTER / 2) * 4, span = (it.w + GUTTER) * 4;
      a.data.copyWithin(top - g * maxSize * 4, top, top + span);
      a.data.copyWithin(bottom + g * maxSize * 4, bottom, bottom + span);
    }
    a.used += it.w * it.h;
    placements.set(it.id, { atlas: ai, x, y, w: it.w, h: it.h });
  }
  // Trim each atlas to the smallest multiple of 128 rows that holds its shelves (KTX2 and WebGL2 accept
  // non-power-of-two sizes; block compression needs multiples of 4).
  const out: RgbaImage[] = [];
  const fillRatio: number[] = [];
  for (const a of atlases) {
    const height = Math.min(maxSize, Math.max(128, Math.ceil(a.nextY / 128) * 128));
    out.push({ width: maxSize, height, data: a.data.subarray(0, maxSize * height * 4) });
    fillRatio.push(a.used / (maxSize * height));
  }
  return { atlases: out, placements, fillRatio };
}

/** Remap a UV in [0,1]² of a source texture into its atlas placement (atlas size w×h). */
export function remapUv(p: Placement, atlasW: number, atlasH: number, u: number, v: number): [number, number] {
  const uu = Math.min(1, Math.max(0, u)), vv = Math.min(1, Math.max(0, v));
  return [(p.x + uu * p.w) / atlasW, (p.y + vv * p.h) / atlasH];
}
