import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { decodeRoadGraph, decodeSimulationPayload, validateSimulationFileRef, type CellDescriptor, type GameplayBundle, type RoadGraph, type SimulationFileRef } from '../../../packages/world-schema/src/index.ts';
import { COLLISION_RESIDENCY, collisionCellRefs, StaticWorld } from '../../../packages/sim/src/index.ts';

/** The same decoding and integrity contract as browser startup, before deterministic replay construction. */
export async function readSimulationPayload(releaseDirectory: string, ref: SimulationFileRef): Promise<Uint8Array> {
  const problems = validateSimulationFileRef(ref);
  if (problems.length) throw new Error(`${ref.path}: ${problems.join('; ')}`);
  const file = path.join(releaseDirectory, ref.path);
  if (statSync(file).size !== ref.bytes) throw new Error(`${ref.path}: stored simulation payload byte length mismatch`);
  return decodeSimulationPayload(new Uint8Array(readFileSync(file)), ref);
}

/** Roads share the browser's exact integrity, transport and logical parser. */
export async function readRoadGraph(releaseDirectory:string,ref:SimulationFileRef):Promise<RoadGraph>{return decodeRoadGraph(await readSimulationPayload(releaseDirectory,ref));}

/**
 * The collision world a recording replays in: the browser's streamed residency (the recording names its rules), or
 * every cell in manifest order for recordings made before collision streaming.
 */
export function replayWorld(terrain: Uint8Array, roads: RoadGraph, gameplay: GameplayBundle, cells: readonly CellDescriptor[],
  collision: ReadonlyMap<string, Uint8Array>, residency: string | null | undefined): StaticWorld {
  const world = StaticWorld.fromBytes(terrain, roads, gameplay);
  if (residency === COLLISION_RESIDENCY) {
    const extents = collisionCellRefs(cells);
    if (!extents) throw new Error('This world records no collision extents, so it cannot replay a streamed recording');
    world.enableStreaming(extents, id => collision.get(id));
  } else if (residency === null || residency === undefined) for (const c of cells) world.addCell(c.id, collision.get(c.id)!);
  else throw new Error(`Unknown collision residency rules ${residency}`);
  return world;
}
