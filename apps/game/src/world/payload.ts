import { decodeSimulationPayload, validateSimulationFileRef, type SimulationFileRef } from '@helsinki/world-schema';

/** Verify the pinned file or its pinned decoded representation after HTTP decompression. */
export async function fetchSimulationPayload(url: string, ref: SimulationFileRef): Promise<Uint8Array> {
  const problems = validateSimulationFileRef(ref);
  if (problems.length) throw new Error(`${ref.path}: ${problems.join('; ')}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  if (!response.body) throw new Error(`${url}: simulation payload response has no body`);
  // Static hosts can interpret .gz as Content-Encoding, which Fetch transparently decodes.
  // Other hosts deliver it as a file, or gzip-wrap that file once more. Accept only the two
  // exact manifest-pinned representations, retaining the fixed allocation ceiling for both.
  const canBeHttpDecoded = ref.compression === 'gzip' && (response.headers.get('content-encoding') ?? '')
    .split(',').some(encoding => encoding.trim().toLowerCase() === 'gzip');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(canBeHttpDecoded ? Math.max(ref.bytes, ref.decodedBytes!) : ref.bytes);
  let offset = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > bytes.length - offset) throw new Error(`${ref.path}: simulation payload exceeds its declared size`);
      bytes.set(result.value, offset);
      offset += result.value.byteLength;
    }
    if (!canBeHttpDecoded && offset !== bytes.length) throw new Error(`${ref.path}: stored simulation payload byte length mismatch`);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const payload = bytes.subarray(0, offset);
  try { return await decodeSimulationPayload(payload, ref); }
  catch (error) {
    if (!canBeHttpDecoded) throw error;
    // The browser hides the wire bytes after HTTP decoding. The independent decoded pin
    // proves the exact physics input; the release stager still verifies the stored file.
    return decodeSimulationPayload(payload, { path: ref.path, bytes: ref.decodedBytes!, sha256: ref.decodedSha256! });
  }
}
