// Snapshot a City of Helsinki tree layer (3D Tiles 1.1 of CityGML SolitaryVegetationObjects, served by the city's 3D
// map at kartta.hel.fi/3d) for a projected bounding box: walk the tileset from its root, follow external tilesets,
// and keep the finest content of every tile whose bounding volume (region, or sphere under the accumulated tile
// transform) meets the box. Contents are stored unchanged with their accumulated transforms and a ledger entry per
// layer; tools/world/build_trees.ts reads them. The game never requests kartta.hel.fi (plan rule 18.3).
//   node tools/world/fetch_trees.ts --layer street --bbox EMIN NMIN EMAX NMAX --name senate-district --out data/raw/helsinki-trees
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gk25ToGeodetic } from '../../packages/world-schema/src/index.ts';

/** Layers of the city's VC Map configuration (kartta.hel.fi/3d/app.config.json, module c4f95e20-...). */
const LAYERS = {
  street: { name: 'Katu_ja_puistopuut', title: 'Katu- ja puistopuut (street and park trees, the public tree register)',
    tileset: 'https://kartta.hel.fi/3d/datasource-data/7afdc4b9-9a23-4a6f-a1ae-cf71495a731e/tileset.json' },
  plot: { name: 'Tontti_ja_metsapuut', title: 'Tontti- ja metsäpuut (plot and forest trees)',
    tileset: 'https://kartta.hel.fi/3d/datasource-data/561e9651-878a-45a6-99e3-e4e4704d8001/tileset.json' },
} as const;
const USER_AGENT = 'helsinki-game-world-pipeline/0.1 (offline tree snapshot)';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  layer: { type: 'string' }, bbox: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' },
} });
const layer = LAYERS[values.layer as keyof typeof LAYERS];
const bbox = [values.bbox, ...positionals].map(Number);
if (!layer || bbox.length !== 4 || !bbox.every(Number.isFinite) || !values.name || !values.out) throw new Error(`--layer ${Object.keys(LAYERS).join('|')}, --bbox EMIN NMIN EMAX NMAX, --name and --out are required`);
const [emin, nmin, emax, nmax] = bbox as [number, number, number, number];
const D = Math.PI / 180;
const corners = [[emin, nmin], [emax, nmin], [emin, nmax], [emax, nmax]].map(([e, n]) => gk25ToGeodetic(e!, n!));
const box = {
  south: Math.min(...corners.map(c => c[0])) * D, north: Math.max(...corners.map(c => c[0])) * D,
  west: Math.min(...corners.map(c => c[1])) * D, east: Math.max(...corners.map(c => c[1])) * D,
};
// The box as a sphere in ECEF (GRS80), for tiles bounded by spheres: centre at mid-box, 50 m above the ellipsoid.
const [clat, clon] = gk25ToGeodetic((emin + emax) / 2, (nmin + nmax) / 2);
const ecef = (latDeg: number, lonDeg: number, h: number): [number, number, number] => {
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), la = latDeg * D, lo = lonDeg * D, n = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
  return [(n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - e2) + h) * Math.sin(la)];
};
const boxCentre = ecef(clat, clon, 50), boxRadius = Math.hypot(emax - emin, nmax - nmin) / 2 + 150;

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

/** `transform` is the tile's own accumulated transform, which its bounding sphere is given in. */
function meetsBox(tile: Tile, transform: Matrix): boolean {
  const { region, sphere } = tile.boundingVolume;
  if (region) {
    const [west, south, east, north] = region as [number, number, number, number];
    return !(east < box.west || west > box.east || north < box.south || south > box.north);
  }
  if (sphere) {
    const [x, y, z, r] = sphere as [number, number, number, number];
    const scale = Math.max(Math.hypot(transform[0]!, transform[1]!, transform[2]!), Math.hypot(transform[4]!, transform[5]!, transform[6]!), Math.hypot(transform[8]!, transform[9]!, transform[10]!));
    const c = [transform[0]! * x + transform[4]! * y + transform[8]! * z + transform[12]!, transform[1]! * x + transform[5]! * y + transform[9]! * z + transform[13]!, transform[2]! * x + transform[6]! * y + transform[10]! * z + transform[14]!];
    return Math.hypot(c[0]! - boxCentre[0], c[1]! - boxCentre[1], c[2]! - boxCentre[2]) <= r * scale + boxRadius;
  }
  throw new Error('box bounding volumes are not expected in the tree tilesets');
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

const out = path.join(values.out, values.layer!, values.name);
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });
interface Saved { file: string; url: string; bytes: number; sha256: string; geometricError: number; transform: Matrix }
const saved: Saved[] = [];

async function walk(tile: Tile, base: string, parent: Matrix): Promise<void> {
  const transform = tile.transform ? multiply(parent, tile.transform) : parent;
  if (!meetsBox(tile, transform)) return;
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
      if (body.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${url}: tile content is not a GLB`);
      const file = `${String(saved.length).padStart(4, '0')}_${path.basename(url.split('?')[0]!)}`;
      writeFileSync(path.join(out, file), body);
      saved.push({ file, url, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), geometricError: tile.geometricError, transform });
    }
  }
  for (const child of children) await walk(child, base, transform);
}

const root = JSON.parse((await get(layer.tileset)).toString('utf8'));
if (root.asset?.version !== '1.1') throw new Error(`unexpected 3D Tiles version ${root.asset?.version}`);
const tilesetVersion = root.asset.tilesetVersion ?? null;
await walk(root.root, layer.tileset, IDENTITY);
if (!saved.length) throw new Error('no tile content meets the box');

const index = { schemaVersion: 1, layer: layer.name, tileset: layer.tileset, tilesetVersion, bboxEN: bbox, tiles: saved };
const indexBody = Buffer.from(JSON.stringify(index, null, 1) + '\n');
writeFileSync(path.join(out, 'tiles.json'), indexBody);
const ledgerPath = path.join(values.out, values.layer!, 'ledger.json');
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { schemaVersion: 1, snapshots: {} };
ledger.snapshots[values.name] = {
  path: `${values.name}/tiles.json`, url: layer.tileset, tilesetVersion, retrievedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  tiles: saved.length, bytes: saved.reduce((s, t) => s + t.bytes, 0), sha256: createHash('sha256').update(indexBody).digest('hex'), bboxEN: bbox,
};
ledger.source = {
  id: `helsinki-trees-${values.layer}`, title: `City of Helsinki 3D city model, tree layer ${layer.name}: ${layer.title}`,
  url: 'https://kartta.hel.fi/3d/', layer: layer.name,
  license: 'CC BY 4.0 (plan v3 sections 1 and 18: confirmed by the city for the LoD2, terrain, tree and mesh layers of its 3D map stream)',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Trees: Helsinki 3D city model tree layers © City of Helsinki, CC BY 4.0',
  use: 'positions, heights, crown and trunk sizes and genus only; the tree meshes in the tiles are not used (own models)',
};
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({ layer: layer.name, tiles: saved.length, bytes: ledger.snapshots[values.name].bytes, tilesetVersion }));
