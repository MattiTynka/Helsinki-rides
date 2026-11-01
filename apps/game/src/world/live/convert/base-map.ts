// Static base map (hybrid live cells): live squares keep streaming their LoD2 buildings from kartta.hel.fi/3d, but their
// ground, water, street classes, building collision and bridge decks come from files published with the release,
// written by tools/world/build_base_map.ts. The map is cut into blocks of BASE_BLOCK × BASE_BLOCK squares; a block file
// is a gzip stream of the binary layout below, and `basemap/index.json` lists the blocks with their SHA-256. Pure and
// browser-safe; the worker and the Node tool share it.
//
// Block layout, little-endian: 'HBM1', u16 version, u16 square count, then per square
//   i16 cx, i16 cz, u8 kind (0 land, 1 water, 2 void), u8 flags (bit 0: deck);
//   land: u16 × N² heights as cm + 32768 (0 = no data), each stored as the difference from the previous value mod 2¹⁶;
//         u8 × Q² quads + 2; u16 prism count, per prism: u16 ref length (0xffff = none) and UTF-8 ref, f32 base, f32 top,
//         u16 polygons, per polygon u16 rings, per ring u16 points and f32 × 2 XZ per point;
//   deck: u16 planes, f64 × 3 per plane, u8 × Q² plane + 1, u8 × Q² surface.
import { LIVE_GROUND_N, LIVE_GROUND_QUADS, type BaseSquare, type LiveDeck, type LivePrism } from '../contract.ts';

export const BASE_MAP_FORMAT = 'basemap-1';
/** Squares per block side. */
export const BASE_BLOCK = 8;
const MAGIC = 'HBM1', VERSION = 1;
const N = LIVE_GROUND_N, Q = LIVE_GROUND_QUADS;
const KINDS: readonly BaseSquare['kind'][] = ['land', 'water', 'void'];
const NO_REF = 0xffff;

/** `basemap/index.json`. */
export interface BaseMapIndex {
  readonly format: string;
  readonly originId: string;
  /** SHA-256 (hex) of the release's sorted static cell ids joined by '\n': the base map's edges match only that set. */
  readonly staticCellsSha256: string;
  readonly blockSquares: number;
  /** By block key (`blockKey`). */
  readonly blocks: Readonly<Record<string, BaseMapBlockRef>>;
  readonly sources: Readonly<Record<string, string>>;
}

export interface BaseMapBlockRef {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly squares: number;
  /** For the builder: digest of the bridge decks the block was built with (absent without decks). */
  readonly decks?: string;
}

export const blockOf = (cx: number, cz: number): [number, number] => [Math.floor(cx / BASE_BLOCK), Math.floor(cz / BASE_BLOCK)];

const signed = (v: number): string => `${v < 0 ? 'm' : 'p'}${String(Math.abs(v)).padStart(2, '0')}`;
export const blockKey = (bx: number, bz: number): string => `b_${signed(bx)}_${signed(bz)}`;
export const BLOCK_FILE = /^b_[mp]\d{2,}_[mp]\d{2,}\.bin$/;

/** The text whose SHA-256 is `staticCellsSha256`. */
export function staticCellsText(ids: Iterable<string>): string {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n');
}

/** Runtime Y rounded to the centimetre steps a block stores (NaN stays NaN). */
export function quantizeHeight(h: number): number {
  return Number.isNaN(h) ? NaN : Math.fround(Math.round(h * 100) / 100);
}

class Writer {
  private bytes = new Uint8Array(1 << 16);
  private view = new DataView(this.bytes.buffer);
  length = 0;

  private room(n: number): void {
    if (this.length + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.room(1); this.view.setUint8(this.length, v); this.length += 1; }
  u16(v: number): void { this.room(2); this.view.setUint16(this.length, v, true); this.length += 2; }
  i16(v: number): void { this.room(2); this.view.setInt16(this.length, v, true); this.length += 2; }
  u32(v: number): void { this.room(4); this.view.setUint32(this.length, v, true); this.length += 4; }
  f32(v: number): void { this.room(4); this.view.setFloat32(this.length, v, true); this.length += 4; }
  f64(v: number): void { this.room(8); this.view.setFloat64(this.length, v, true); this.length += 8; }
  raw(b: Uint8Array): void { this.room(b.length); this.bytes.set(b, this.length); this.length += b.length; }
  done(): Uint8Array { return this.bytes.slice(0, this.length); }
}

class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private o = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): number {
    if (this.o + n > this.bytes.length) throw new Error('base map block is truncated');
    const at = this.o;
    this.o += n;
    return at;
  }
  u8(): number { return this.view.getUint8(this.need(1)); }
  u16(): number { return this.view.getUint16(this.need(2), true); }
  i16(): number { return this.view.getInt16(this.need(2), true); }
  f32(): number { return this.view.getFloat32(this.need(4), true); }
  f64(): number { return this.view.getFloat64(this.need(8), true); }
  raw(n: number): Uint8Array { const at = this.need(n); return this.bytes.slice(at, at + n); }
  get ended(): boolean { return this.o === this.bytes.length; }
}

const encoder = new TextEncoder(), decoder = new TextDecoder();

export function encodeBaseBlock(squares: readonly BaseSquare[]): Uint8Array {
  const w = new Writer();
  w.raw(encoder.encode(MAGIC));
  w.u16(VERSION);
  w.u16(squares.length);
  for (const s of squares) {
    const kind = KINDS.indexOf(s.kind);
    if (kind < 0) throw new Error(`square ${s.cx},${s.cz}: kind ${s.kind}`);
    const land = s.kind === 'land';
    w.i16(s.cx); w.i16(s.cz); w.u8(kind); w.u8(land && s.deck ? 1 : 0);
    if (!land) continue;
    if (!s.heights || s.heights.length !== N * N || !s.quads || s.quads.length !== Q * Q) throw new Error(`square ${s.cx},${s.cz}: land without its lattice`);
    let previous = 0;
    for (let i = 0; i < N * N; i++) {
      const h = s.heights[i]!;
      const cm = Number.isNaN(h) ? -32768 : Math.round(h * 100);
      if (!Number.isNaN(h) && (cm < -32767 || cm > 32767)) throw new Error(`square ${s.cx},${s.cz}: height ${h} out of range`);
      const v = cm + 32768;
      w.u16((v - previous) & 0xffff);
      previous = v;
    }
    for (let q = 0; q < Q * Q; q++) w.u8(s.quads[q]! + 2);
    w.u16(s.prisms.length);
    for (const p of s.prisms) {
      if (p.ref === null) w.u16(NO_REF);
      else { const ref = encoder.encode(p.ref); w.u16(ref.length); w.raw(ref); }
      w.f32(p.base); w.f32(p.top);
      w.u16(p.polygons.length);
      for (const rings of p.polygons) {
        w.u16(rings.length);
        for (const r of rings) {
          w.u16(r.length / 2);
          for (const v of r) w.f32(v);
        }
      }
    }
    if (s.deck) {
      const planes = s.deck.planes.length / 3;
      w.u16(planes);
      for (const v of s.deck.planes) w.f64(v);
      w.raw(s.deck.quads);
      w.raw(s.deck.surfaces);
    }
  }
  return w.done();
}

export function decodeBaseBlock(bytes: Uint8Array): BaseSquare[] {
  const r = new Reader(bytes);
  if (decoder.decode(r.raw(4)) !== MAGIC) throw new Error('not a base map block');
  const version = r.u16();
  if (version !== VERSION) throw new Error(`base map block version ${version}`);
  const count = r.u16(), out: BaseSquare[] = [];
  for (let k = 0; k < count; k++) {
    const cx = r.i16(), cz = r.i16(), kind = KINDS[r.u8()], flags = r.u8();
    if (!kind) throw new Error('base map block: unknown square kind');
    if (kind !== 'land') { out.push({ cx, cz, kind, heights: null, quads: null, prisms: [], deck: null }); continue; }
    const heights = new Float32Array(N * N);
    let v = 0;
    for (let i = 0; i < N * N; i++) {
      v = (v + r.u16()) & 0xffff;
      heights[i] = v === 0 ? NaN : (v - 32768) / 100;
    }
    const quads = new Int8Array(Q * Q);
    for (let q = 0; q < Q * Q; q++) quads[q] = r.u8() - 2;
    const prisms: LivePrism[] = [];
    for (let p = r.u16(); p > 0; p--) {
      const length = r.u16(), ref = length === NO_REF ? null : decoder.decode(r.raw(length));
      const base = r.f32(), top = r.f32(), polygons: number[][][] = [];
      for (let g = r.u16(); g > 0; g--) {
        const rings: number[][] = [];
        for (let n = r.u16(); n > 0; n--) {
          const points = r.u16(), ring: number[] = new Array(points * 2);
          for (let i = 0; i < points * 2; i++) ring[i] = r.f32();
          rings.push(ring);
        }
        polygons.push(rings);
      }
      prisms.push({ ref, base, top, polygons });
    }
    let deck: LiveDeck | null = null;
    if (flags & 1) {
      const planes = new Float64Array(r.u16() * 3);
      for (let i = 0; i < planes.length; i++) planes[i] = r.f64();
      deck = { planes, quads: r.raw(Q * Q), surfaces: r.raw(Q * Q) };
    }
    out.push({ cx, cz, kind, heights, quads, prisms, deck });
  }
  if (!r.ended) throw new Error('base map block has trailing bytes');
  return out;
}
