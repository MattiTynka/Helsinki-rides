// Bake the gameplay bundle: hand-authored content plus addresses from the city building register, parked-car spawns
// from the road graph's parking slots, and heights/validation against the terrain.
//   node tools/world/build_gameplay.ts --content content/helsinki/gameplay.json --origin content/helsinki/world-origin.json \
//     --register data/raw/helsinki-building-register/senate-district.geojson --roads data/work/m0/roads/roads.json \
//     --terrain data/work/m0/terrain/terrain.bin --out data/work/m0/gameplay
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseTerrain, sampleTerrain, validateGameplayBundle, type AddressEntry, type GameplayBundle, type RoadGraph, type VehicleSpawn } from '../../packages/world-schema/src/index.ts';
import { centroid, loadGeoJsonPolygons } from './lib/geometry.ts';

const { values } = parseArgs({ options: { content: { type: 'string' }, origin: { type: 'string' }, register: { type: 'string' }, roads: { type: 'string' }, terrain: { type: 'string' }, out: { type: 'string' } } });
for (const k of ['content', 'origin', 'register', 'roads', 'terrain', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`);
if (existsSync(values.out!)) throw new Error(`${values.out} exists; the build writes into a new directory`);
const content = JSON.parse(readFileSync(values.content!, 'utf8'));
const origin = JSON.parse(readFileSync(values.origin!, 'utf8'));
const [E0, N0] = origin.originProjected as [number, number, number];
const roads = JSON.parse(readFileSync(values.roads!, 'utf8')) as RoadGraph;
const terrain = parseTerrain(new Uint8Array(readFileSync(values.terrain!)));
const area = content.playArea as { minX: number; maxX: number; minZ: number; maxZ: number };
const inArea = (x: number, z: number) => x >= area.minX + 2 && x <= area.maxX - 2 && z >= area.minZ + 2 && z <= area.maxZ - 2;

// Addresses: street + number from the register, one entry per building, positioned at the footprint centroid
// (the drop-in moves the player to the nearest road point in the runtime).
const footprints = loadGeoJsonPolygons(values.register!, E0, N0, (p, i) => String(p['vtj_prt'] ?? p['id'] ?? i));
const addresses: AddressEntry[] = [];
const seen = new Set<string>();
for (const f of footprints) {
  const street = String(f.properties['katunimi_suomi'] ?? '').trim(), number = String(f.properties['osoitenumero'] ?? '').trim();
  if (!street) continue;
  const label = `${street} ${number}`.trim();
  const c = centroid(f.rings[0]!);
  const x = Math.round(c[0] * 10) / 10, z = Math.round(-c[1] * 10) / 10;
  if (!inArea(x, z) || seen.has(label)) continue;
  seen.add(label);
  addresses.push({ label, position: [x, z], headingDeg: 0 });
}
addresses.sort((a, b) => a.label.localeCompare(b.label, 'fi'));

// Parked cars from parking slots, away from the player spawn and from each other.
const spawn = content.player.spawn.position as [number, number];
const vehicles: VehicleSpawn[] = [...content.vehicles];
const parked = content.parkedFromParkingSlots as { definition: string; max: number; minDistanceFromSpawn: number } | undefined;
if (parked) {
  let n = 0;
  const slots = roads.parking.flatMap(p => p.points.map(pt => ({ pt, heading: p.heading ?? 0 })));
  for (const s of slots) {
    if (n >= parked.max) break;
    if (Math.hypot(s.pt[0] - spawn[0], s.pt[2] - spawn[1]) < parked.minDistanceFromSpawn) continue;
    if (vehicles.some(v => Math.hypot(v.position[0] - s.pt[0], v.position[1] - s.pt[2]) < 5.5)) continue;
    if (!inArea(s.pt[0], s.pt[2])) continue;
    vehicles.push({ id: `parked-${++n}`, definition: parked.definition, position: [Math.round(s.pt[0] * 100) / 100, Math.round(s.pt[2] * 100) / 100], headingDeg: Math.round(s.heading), occupied: false });
  }
}

const bundle: GameplayBundle = {
  schemaVersion: 2, originId: origin.id, killHeight: content.killHeight, playArea: area,
  player: content.player, vehicleDefinitions: content.vehicleDefinitions, vehicles, anchors: content.anchors, weapons: content.weapons,
  wanted: content.wanted, police: content.police, addresses, landmarks: content.landmarks, district: content.district, playerStart: content.playerStart,
};
const extra = {};
const problems = validateGameplayBundle(bundle);
for (const v of vehicles) if (!inArea(v.position[0], v.position[1])) problems.push(`vehicle ${v.id} outside the play area`);
for (const a of bundle.anchors) if (!inArea(a.position[0], a.position[1])) problems.push(`anchor ${a.id} outside the play area`);
if (problems.length) throw new Error(problems.join('\n'));
// Heights for the report only: everything spawns on the ground via the sim's ray casts.
const heights = { playerSpawn: sampleTerrain(terrain, spawn[0], spawn[1]), vehicles: vehicles.map(v => ({ id: v.id, y: Math.round(sampleTerrain(terrain, v.position[0], v.position[1]) * 100) / 100 })) };
mkdirSync(values.out!, { recursive: true });
const json = JSON.stringify({ ...bundle, ...extra });
writeFileSync(path.join(values.out!, 'gameplay.json'), json);
const report = { bytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex'), addresses: addresses.length, vehicles: vehicles.length, parkedAdded: vehicles.length - content.vehicles.length, heights };
writeFileSync(path.join(values.out!, 'gameplay-report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ addresses: addresses.length, vehicles: vehicles.length, playerSpawnHeight: Math.round(heights.playerSpawn * 100) / 100 }));
