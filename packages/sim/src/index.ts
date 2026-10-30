export * from './commands.ts';
export * from './math.ts';
export * from './world.ts';
export * from './collision-residency.ts';
export * from './live-grid.ts';
export * from './vehicle.ts';
export * from './character.ts';
export * from './wanted.ts';
export * from './weapons.ts';
export * from './aim.ts';
export * from './police.ts';
export * from './pedestrians.ts';
export * from './simulation.ts';
export * from './vehicle-interaction.ts';
export type { GameEvent, GameplayBundle, VehicleDefinition, WeaponDefinition, RoadGraph, TerrainGrid, WorldManifest } from '@helsinki/world-schema';

import { RAPIER } from './world.ts';

/** Initialise the WASM physics module; must resolve before any StaticWorld is created. */
export async function initPhysics(): Promise<void> {
  await RAPIER.init();
}
