import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { decodeSimulationPayload, validateSimulationFileRef, type SimulationFileRef } from '../../../packages/world-schema/src/index.ts';

/** The same decoding and integrity contract as browser startup, before deterministic replay construction. */
export async function readSimulationPayload(releaseDirectory: string, ref: SimulationFileRef): Promise<Uint8Array> {
  const problems = validateSimulationFileRef(ref);
  if (problems.length) throw new Error(`${ref.path}: ${problems.join('; ')}`);
  const file = path.join(releaseDirectory, ref.path);
  if (statSync(file).size !== ref.bytes) throw new Error(`${ref.path}: stored simulation payload byte length mismatch`);
  return decodeSimulationPayload(new Uint8Array(readFileSync(file)), ref);
}
