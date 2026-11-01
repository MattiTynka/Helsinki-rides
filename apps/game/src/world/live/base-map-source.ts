// Worker-side reader of the release's static base map (convert/base-map.ts): `basemap/index.json`, then gzip blocks of
// 8 × 8 squares checked against their SHA-256. A square is covered when its block is listed; the worker then builds its
// collision and ground from the block alone, with no request to kartta.hel.fi. A missing or mismatched base map
// leaves every square to the live sources.
import type { BaseSquare } from './contract.ts';
import {
  BASE_BLOCK, BASE_MAP_FORMAT, BLOCK_FILE, blockKey, blockOf, decodeBaseBlock, staticCellsText, type BaseMapIndex,
} from './convert/base-map.ts';
import { errorMessage, Lru, SharedRuns } from './live-net.ts';

/** After a failed index lookup, squares use the live sources for this long before the base map is tried again. */
const RETRY_MS = 30_000;

async function hex(bytes: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class BaseMapSource {
  private readonly url: string;
  private readonly staticCellIds: readonly string[];
  private readonly originId: string;
  private readonly note: (message: string) => void;
  private index: Promise<BaseMapIndex | null> | null = null;
  private failedAt = -Infinity;
  private readonly blocks = new Lru<ReadonlyMap<string, BaseSquare>>(32);
  private readonly runs = new SharedRuns<ReadonlyMap<string, BaseSquare>>();
  squares = 0;

  constructor(url: string, originId: string, staticCellIds: readonly string[], note: (message: string) => void) {
    this.url = url.endsWith('/') ? url : `${url}/`;
    this.originId = originId;
    this.staticCellIds = staticCellIds;
    this.note = note;
  }

  /** The square from the base map; null when the base map does not cover it (or is unavailable). Rejects on a bad block. */
  async square(cx: number, cz: number, signal: AbortSignal): Promise<BaseSquare | null> {
    const index = await this.lookup();
    if (!index) return null;
    const [bx, bz] = blockOf(cx, cz), key = blockKey(bx, bz), ref = index.blocks[key];
    if (!ref) return null;
    let block = this.blocks.get(key);
    if (!block) {
      block = await this.runs.run(key, signal, async () => {
        if (!BLOCK_FILE.test(ref.file)) throw new Error(`base map: bad block file ${ref.file}`);
        const response = await fetch(`${this.url}${ref.file}`);
        if (!response.ok) throw new Error(`base map ${ref.file}: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== ref.bytes || (await hex(bytes)) !== ref.sha256) throw new Error(`base map ${ref.file}: bytes differ from the index`);
        const squares = new Map<string, BaseSquare>();
        for (const s of decodeBaseBlock(await gunzip(bytes))) squares.set(`${s.cx},${s.cz}`, s);
        this.blocks.set(key, squares);
        return squares;
      });
    }
    const square = block.get(`${cx},${cz}`) ?? null;
    if (square) this.squares++;
    return square;
  }

  private lookup(): Promise<BaseMapIndex | null> {
    if (this.index) return this.index;
    if (performance.now() - this.failedAt < RETRY_MS) return Promise.resolve(null);
    const run = (async (): Promise<BaseMapIndex | null> => {
      const response = await fetch(`${this.url}index.json`);
      // No base map published with this release: every square stays live.
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`base map index: HTTP ${response.status}`);
      const index = await response.json() as BaseMapIndex;
      if (index.format !== BASE_MAP_FORMAT || index.blockSquares !== BASE_BLOCK || !index.blocks || typeof index.blocks !== 'object') {
        this.note(`base map index: format ${String(index.format)} not supported`);
        return null;
      }
      if (index.originId !== this.originId || index.staticCellsSha256 !== await hex(staticCellsText(this.staticCellIds))) {
        this.note('base map index: built for other release cells; squares stay live');
        return null;
      }
      return index;
    })();
    this.index = run;
    run.catch((error: unknown) => {
      if (this.index === run) this.index = null;
      this.failedAt = performance.now();
      this.note(errorMessage(error));
    });
    return run.catch(() => null);
  }
}
