// Ground baseline from the city terrain model (plan sections 3 and 4.1; decision 0005): the "2021_terrain" layer of
// the city's 3D map, mirrored by fetch_terrain.ts, sampled linearly on a 1 m grid over the play area. The model is
// bare earth, so it is used as delivered: no filtering, no fill, no offset. Output is an HTER heightfield in the
// runtime frame (heights relative to the origin height) plus a JSON report and a preview.
//   node tools/world/build_terrain.ts --tiles data/raw/helsinki-terrain/senate-district --ledger data/raw/helsinki-terrain/ledger.json \
//     --origin content/helsinki/world-origin.json --config content/helsinki/cells.json --out data/work/m0/terrain
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { encodeTerrain } from '../../packages/world-schema/src/index.ts';
import { loadTerrainSnapshot } from './lib/quantized-mesh.ts';

const { values } = parseArgs({ options: {
  tiles: { type: 'string' }, ledger: { type: 'string' }, origin: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' },
  resolution: { type: 'string', default: '1' },
} });
for (const k of ['tiles', 'ledger', 'origin', 'config', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`);
if (existsSync(values.out!)) throw new Error(`${values.out} exists; the build writes into a new directory`);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const origin = JSON.parse(readFileSync(values.origin!, 'utf8'));
const [E0, N0, H0] = origin.originProjected as [number, number, number];
const area = JSON.parse(readFileSync(values.config!, 'utf8')).playArea as { minX: number; maxX: number; minZ: number; maxZ: number };
const res = Number(values.resolution);
const indexBytes = new Uint8Array(readFileSync(path.join(values.tiles!, 'tiles.json')));
const ledger = JSON.parse(readFileSync(values.ledger!, 'utf8'));
const snapshotName = path.basename(values.tiles!);
const snapshot = ledger.snapshots?.[snapshotName];
if (!snapshot || snapshot.sha256 !== sha256(indexBytes)) throw new Error(`${values.tiles} is not the snapshot recorded as "${snapshotName}" in ${values.ledger}`);
const terrainModel = loadTerrainSnapshot(values.tiles!, sha256);

// Runtime grid: x east from minX, z south from minZ; the projected point of (x, z) is (E0 + x, N0 - z).
const nx = Math.round((area.maxX - area.minX) / res) + 1, nz = Math.round((area.maxZ - area.minZ) / res) + 1;
const heights = new Float32Array(nx * nz);
let missing = 0;
for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
  const h = terrainModel.heightAtEN(E0 + area.minX + ix * res, N0 - (area.minZ + iz * res));
  if (h === null) { missing++; continue; }
  heights[iz * nx + ix] = h - H0;
}
if (missing) throw new Error(`${missing} grid points fall outside the terrain snapshot; fetch a larger box`);
const terrain = { x0: area.minX, z0: area.minZ, resolution: res, nx, nz, heights };
mkdirSync(values.out!, { recursive: true });
const bytes = encodeTerrain(terrain);
writeFileSync(path.join(values.out!, 'terrain.bin'), bytes);
let min = Infinity, max = -Infinity;
for (const v of heights) { if (v < min) min = v; if (v > max) max = v; }
const doc = {
  schemaVersion: 1, kind: 'terrain-heightfield', originId: origin.id, frame: 'runtime: X east, Y up, Z south; heights relative to the origin height',
  file: 'terrain.bin', bytes: bytes.byteLength, sha256: sha256(bytes),
  x0: area.minX, z0: area.minZ, resolution: res, nx, nz,
  source: { ledger: ledger.source.id, snapshot: snapshotName, snapshotSha256: snapshot.sha256, layerVersion: snapshot.layerVersion, zoom: terrainModel.zoom,
    tiles: terrainModel.tiles, vertices: terrainModel.vertices, triangles: terrainModel.triangles },
  method: 'city terrain model sampled linearly inside its quantized-mesh triangles at every grid point; heights as delivered (N2000) minus the origin height',
  stats: { min, max },
};
writeFileSync(path.join(values.out!, 'terrain.json'), JSON.stringify(doc, null, 1) + '\n');
// Preview: grey = height (min..max), north up, 2 px per metre.
const sharp = (await import('sharp')).default;
const px = new Uint8Array(nx * nz);
for (let k = 0; k < px.length; k++) px[k] = Math.round(255 * (heights[k]! - min) / Math.max(1e-6, max - min));
await sharp(Buffer.from(px.buffer), { raw: { width: nx, height: nz, channels: 1 } }).resize(nx * 2, nz * 2, { kernel: 'nearest' }).png().toFile(path.join(values.out!, 'terrain-preview.png'));
console.log(JSON.stringify({ ...doc.stats, nx, nz, tiles: terrainModel.tiles }));
