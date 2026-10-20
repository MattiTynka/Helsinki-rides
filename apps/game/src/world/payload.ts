import { decodeSimulationPayload, validateSimulationFileRef, type SimulationFileRef } from '@helsinki/world-schema';

/** Bound download allocation as well as decompression. Stored file hashes remain independent of transport. */
export async function fetchSimulationPayload(url: string, ref: SimulationFileRef): Promise<Uint8Array> {
  const problems = validateSimulationFileRef(ref);
  if (problems.length) throw new Error(`${ref.path}: ${problems.join('; ')}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  if (!response.body) throw new Error(`${url}: simulation payload response has no body`);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(ref.bytes);
  let offset = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > bytes.length - offset) throw new Error(`${ref.path}: stored simulation payload exceeds its declared size`);
      bytes.set(result.value, offset);
      offset += result.value.byteLength;
    }
    if (offset !== bytes.length) throw new Error(`${ref.path}: stored simulation payload byte length mismatch`);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return decodeSimulationPayload(bytes, ref);
}
