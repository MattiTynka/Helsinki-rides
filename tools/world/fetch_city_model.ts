// Snapshot the City of Helsinki textured LoD2 building model (3D Tiles 1.1, served by the city's 3D map at
// kartta.hel.fi/3d) for a projected bounding box: walk the tileset from its root, follow external tilesets,
// and keep the finest content of every tile whose bounding region meets the box. Contents are stored unchanged
// with their accumulated tile transforms and a ledger entry; tools/world/convert_city_model.ts reads them.
//   node tools/world/fetch_city_model.ts --bbox EMIN NMIN EMAX NMAX --name senate-district --out data/raw/helsinki-lod2
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gk25ToGeodetic } from '../../packages/world-schema/src/index.ts';

/** Layer "Rakennukset_LOD2_tekstuureilla" of the city's VC Map configuration (kartta.hel.fi/3d/app.config.json). */
const TILESET = 'https://kartta.hel.fi/3d/datasource-data/e5e7158a-52df-45a1-9be0-1be8f2828abd/tileset.json';
const USER_AGENT = 'helsinki-game-world-pipeline/0.1 (offline city model snapshot)';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  bbox: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' }, tileset: { type: 'string', default: TILESET },
} });
const bbox = [values.bbox, ...positionals].map(Number);
if (bbox.length !== 4 || !bbox.every(Number.isFinite) || !values.name || !values.out) throw new Error('--bbox EMIN NMIN EMAX NMAX, --name and --out are required');
const [emin, nmin, emax, nmax] = bbox as [number, number, number, number];
const D = Math.PI / 180;
const corners = [[emin, nmin], [emax, nmin], [emin, nmax], [emax, nmax]].map(([e, n]) => gk25ToGeodetic(e!, n!));
const box = {
  south: Math.min(...corners.map(c => c[0])) * D, north: Math.max(...corners.map(c => c[0])) * D,
  west: Math.min(...corners.map(c => c[1])) * D, east: Math.max(...corners.map(c => c[1])) * D,
};

type Matrix = number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Column-major 4x4 product a * b. */
function multiply(a: Matrix, b: Matrix): Matrix {
  const r = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row]! += a[k * 4 + row]! * b[c * 4 + k]!;
  return r;
}

interface Tile {
  boundingVolume: { region?: number[]; box?: number[]; sphere?: number[] };
  geometricError: number;
  transform?: Matrix;
  content?: { uri?: string; url?: string };
  children?: Tile[];
}

function meetsBox(tile: Tile): boolean {
  const region = tile.boundingVolume.region;
  if (!region) throw new Error('only region bounding volumes are expected in this tileset');
  const [west, south, east, north] = region as [number, number, number, number];
  return !(east < box.west || west > box.east || north < box.south || south > box.north);
}

async function get(url: string): Promise<Buffer> {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    last = `HTTP ${response.status}`;
    if (response.status < 500) break;
  }
  throw new Error(`${url}: ${last}`);
}

const out = path.join(values.out, values.name);
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });
interface Saved { file: string; url: string; bytes: number; sha256: string; geometricError: number; transform: Matrix }
const saved: Saved[] = [];
let tilesetVersion: string | null = null;

async function walk(tile: Tile, base: string, parent: Matrix): Promise<void> {
  if (!meetsBox(tile)) return;
  const transform = tile.transform ? multiply(parent, tile.transform) : parent;
  const uri = tile.content?.uri ?? tile.content?.url;
  const children = tile.children ?? [];
  if (uri) {
    const url = new URL(uri, base).href;
    if (url.split('?')[0]!.endsWith('.json')) {
      const sub = JSON.parse((await get(url)).toString('utf8'));
      await walk(sub.root, url, transform);
      return;
    }
    // REPLACE refinement: only the finest level is kept, so a tile with children defers to them.
    if (children.length === 0) {
      const body = await get(url);
      const file = `${String(saved.length).padStart(4, '0')}_${path.basename(url.split('?')[0]!)}`;
      writeFileSync(path.join(out, file), body);
      saved.push({ file, url, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'),
        geometricError: tile.geometricError, transform });
    }
  }
  for (const child of children) await walk(child, base, transform);
}

const root = JSON.parse((await get(values.tileset!)).toString('utf8'));
if (root.asset?.version !== '1.1') throw new Error(`unexpected 3D Tiles version ${root.asset?.version}`);
tilesetVersion = root.asset.tilesetVersion ?? null;
await walk(root.root, values.tileset!, IDENTITY);
if (!saved.length) throw new Error('no tile content meets the box');

const index = { schemaVersion: 1, tileset: values.tileset, tilesetVersion, bboxEN: bbox, tiles: saved };
const indexBody = Buffer.from(JSON.stringify(index, null, 1) + '\n');
writeFileSync(path.join(out, 'tiles.json'), indexBody);
const ledgerPath = path.join(values.out, 'ledger.json');
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { schemaVersion: 1, snapshots: {} };
ledger.snapshots[values.name] = {
  path: `${values.name}/tiles.json`, url: values.tileset, tilesetVersion, retrievedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  tiles: saved.length, bytes: saved.reduce((s, t) => s + t.bytes, 0), sha256: createHash('sha256').update(indexBody).digest('hex'),
  bboxEN: bbox,
};
ledger.source = {
  id: 'helsinki-lod2-textured', title: 'City of Helsinki 3D city information model, textured LoD2 buildings (3D Tiles, layer Rakennukset_LOD2_tekstuureilla)',
  url: 'https://kartta.hel.fi/3d/', license: 'CC BY 4.0 (stated for the city information model on hel.fi/3d; the 3D Tiles service is the city\'s own distribution of it)',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Buildings: Helsinki 3D city model © City of Helsinki, CC BY 4.0',
  heights: 'N2000 heights stored as ellipsoidal heights (checked against the 2017 mesh ground and the Cathedral height)',
};
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({ tiles: saved.length, bytes: ledger.snapshots[values.name].bytes, tilesetVersion }));
