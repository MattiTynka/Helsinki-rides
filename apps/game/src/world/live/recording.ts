// The live collision bytes a session inserted, saved with a review recording so its Node replay
// (tools/verify/replay-recording.ts) inserts byte-identical live cells even after the city republishes its data.
import { LIVE_VERSION } from '@helsinki/sim';
import type { LiveRecordingData } from './contract.ts';

/** Bytes per btoa call: a multiple of 3, so the chunks' base64 concatenates without padding in between. */
const ENCODE_CHUNK = 3 * 8192;
/** Characters per atob call: a multiple of 4. */
const DECODE_CHUNK = 4 * 8192;

export class LiveRecording {
  private readonly cells = new Map<string, Uint8Array>();

  /** The first bytes recorded per cell win; they are copied, so later reuse of the buffer cannot change them. */
  record(id: string, bytes: Uint8Array): void {
    if (!this.cells.has(id)) this.cells.set(id, bytes.slice());
  }

  get size(): number { return this.cells.size; }

  export(): LiveRecordingData {
    const cells: Record<string, string> = {};
    for (const id of [...this.cells.keys()].sort()) cells[id] = toBase64(this.cells.get(id)!);
    return { version: LIVE_VERSION, cells };
  }
}

/** Recorded live cell bytes by id; the caller checks `data.version`. */
export function decodeLiveRecording(data: LiveRecordingData): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const id of Object.keys(data.cells).sort()) out.set(id, fromBase64(data.cells[id]!));
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    const chunk = bytes.subarray(i, i + ENCODE_CHUNK);
    let binary = '';
    for (let j = 0; j < chunk.length; j += 1024) binary += String.fromCharCode(...chunk.subarray(j, j + 1024));
    out += btoa(binary);
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; i < text.length; i += DECODE_CHUNK) {
    const binary = atob(text.slice(i, i + DECODE_CHUNK));
    parts.push(binary);
    length += binary.length;
  }
  const out = new Uint8Array(length);
  let o = 0;
  for (const binary of parts) for (let j = 0; j < binary.length; j++) out[o++] = binary.charCodeAt(j);
  return out;
}
