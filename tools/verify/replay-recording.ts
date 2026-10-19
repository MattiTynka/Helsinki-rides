// Replay an input recording written by play-journey.ts on a fresh Node simulation and compare the final state hash.
// A recording is the seed plus the encoded command stream of one run; the world comes from the release it names.
//   node tools/verify/replay-recording.ts --release apps/game/public/world/<id> --recording data/evidence/<dir>/run-01-recording.json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { decodeCommand, initPhysics, Simulation, StaticWorld, type EncodedCommand } from '../../packages/sim/src/index.ts';
import type { WorldManifest } from '../../packages/world-schema/src/index.ts';

const { values } = parseArgs({ options: { release: { type: 'string' }, recording: { type: 'string' } } });
if (!values.release || !values.recording) throw new Error('--release and --recording are required');

const manifest = JSON.parse(readFileSync(path.join(values.release, 'manifest.json'), 'utf8')) as WorldManifest;
const rec = JSON.parse(readFileSync(values.recording, 'utf8')) as { release: string; seed: number; ending: string; ticks: number; hash: string; commands: EncodedCommand[] };
if (rec.release !== manifest.worldReleaseId) throw new Error(`recording is from ${rec.release}, --release is ${manifest.worldReleaseId}`);

await initPhysics();
const world = StaticWorld.fromBytes(
  new Uint8Array(readFileSync(path.join(values.release, manifest.terrain.path))),
  JSON.parse(readFileSync(path.join(values.release, manifest.roads.path), 'utf8')),
  JSON.parse(readFileSync(path.join(values.release, manifest.gameplay.path), 'utf8')),
);
for (const c of manifest.cells) world.addCell(c.id, new Uint8Array(readFileSync(path.join(values.release, c.collision.path))));
const sim = new Simulation(world, { seed: rec.seed });
const t0 = performance.now();
for (const c of rec.commands) sim.step(decodeCommand(c));
const hash = sim.hash();
const ok = hash === rec.hash && sim.tick === rec.ticks;
console.log(`${ok ? 'PASS' : 'FAIL'} replay: ${rec.ticks} ticks (${rec.ending}) in ${((performance.now() - t0) / 1000).toFixed(1)} s, recorded ${rec.hash}, replayed ${hash}, final mode ${sim.mode}, stars ${sim.wanted.stars}`);
process.exit(ok ? 0 : 1);
