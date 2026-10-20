import type { SimulationFileRef } from './types.ts';

/** Above the largest current terrain bundle, with a fixed ceiling independent of manifest claims. */
export const MAX_SIMULATION_PAYLOAD_BYTES = 64 * 1024 * 1024;

export function validateSimulationFileRef(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['simulation payload must be a file reference'];
  const ref = value as Partial<SimulationFileRef>;
  const problems: string[] = [];
  if (typeof ref.path !== 'string' || ref.path.length > 512 || !ref.path.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) problems.push('simulation payload path must be a relative file');
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes! <= 0 || ref.bytes! > MAX_SIMULATION_PAYLOAD_BYTES) problems.push('stored bytes exceed the simulation payload limit');
  if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) problems.push('stored SHA-256 is invalid');
  if (ref.compression === undefined) {
    if (ref.decodedBytes !== undefined || ref.decodedSha256 !== undefined) problems.push('decoded metadata requires compression');
  } else if (ref.compression !== 'gzip') problems.push('unsupported simulation payload compression');
  else {
    if (!Number.isSafeInteger(ref.decodedBytes) || ref.decodedBytes! <= 0 || ref.decodedBytes! > MAX_SIMULATION_PAYLOAD_BYTES) problems.push('decoded bytes exceed the simulation payload limit');
    if (typeof ref.decodedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.decodedSha256)) problems.push('decoded SHA-256 is invalid');
  }
  return problems;
}

async function verifyBytes(bytes: Uint8Array, size: number, digest: string, label: string): Promise<void> {
  if (bytes.byteLength !== size) throw new Error(`${label}: simulation payload byte length mismatch`);
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== digest) throw new Error(`${label}: simulation payload SHA-256 mismatch`);
}

/** Read a decompressed stream into a fixed allocation, cancelling before accepting excess output. */
async function readDecoded(stream: ReadableStream<Uint8Array>, expected: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const bytes = new Uint8Array(expected);
  let offset = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > expected - offset) throw new Error('decoded simulation payload exceeds its declared size');
      bytes.set(result.value, offset);
      offset += result.value.byteLength;
    }
    if (offset !== expected) throw new Error('decoded simulation payload byte length mismatch');
    return bytes;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/** Shared by browser loading and Node replay: compression never changes physics input bytes. */
export async function decodeSimulationPayload(stored: Uint8Array, ref: SimulationFileRef): Promise<Uint8Array> {
  const problems = validateSimulationFileRef(ref);
  if (problems.length) throw new Error(`${ref.path}: ${problems.join('; ')}`);
  await verifyBytes(stored, ref.bytes, ref.sha256, ref.path);
  if (!ref.compression) return stored;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new Uint8Array(stored)); controller.close(); } });
  const decoded = await readDecoded(stream.pipeThrough(new DecompressionStream('gzip')), ref.decodedBytes!);
  await verifyBytes(decoded, ref.decodedBytes!, ref.decodedSha256!, ref.path);
  return decoded;
}
