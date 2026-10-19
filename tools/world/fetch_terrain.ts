// Snapshot the City of Helsinki terrain model (layer "2021_terrain", "Maastomalli", of the city's 3D map at
// kartta.hel.fi/3d; quantized-mesh 1.0 in the geographic TMS scheme) for a projected bounding box: every tile of one
// zoom level that meets the box, stored unchanged with a tile index and a ledger entry. tools/world/build_terrain.ts
// reads them.
//   node tools/world/fetch_terrain.ts --bbox EMIN NMIN EMAX NMAX --name senate-district --out data/raw/helsinki-terrain [--zoom 18]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gk25ToGeodetic } from '../../packages/world-schema/src/index.ts';
import { tileRange } from './lib/quantized-mesh.ts';

/** Layer "2021_terrain" of the city's VC Map configuration (kartta.hel.fi/3d/app.config.json, module c4f95e20-...). */
const LAYER = 'https://kartta.hel.fi/3d/datasource-data/4383570b-33a3-4a9f-ae16-93373aff5ffa/';
const USER_AGENT = 'helsinki-game-world-pipeline/0.1 (offline terrain snapshot)';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  bbox: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' }, layer: { type: 'string', default: LAYER }, zoom: { type: 'string' },
} });
const bbox = [values.bbox, ...positionals].map(Number);
if (bbox.length !== 4 || !bbox.every(Number.isFinite) || !values.name || !values.out) throw new Error('--bbox EMIN NMIN EMAX NMAX, --name and --out are required');
const [emin, nmin, emax, nmax] = bbox as [number, number, number, number];
const corners = [[emin, nmin], [emax, nmin], [emin, nmax], [emax, nmax]].map(([e, n]) => gk25ToGeodetic(e!, n!));
const south = Math.min(...corners.map(c => c[0])), north = Math.max(...corners.map(c => c[0]));
const west = Math.min(...corners.map(c => c[1])), east = Math.max(...corners.map(c => c[1]));

async function get(url: string): Promise<Buffer> {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.quantized-mesh;extensions=octvertexnormals,application/octet-stream;q=0.9,*/*;q=0.01' } });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    last = `HTTP ${response.status}`;
    if (response.status < 500) break;
  }
  throw new Error(`${url}: ${last}`);
}

const layerBody = await get(new URL('layer.json', values.layer).href);
const layer = JSON.parse(layerBody.toString('utf8')) as { format: string; scheme: string; projection: string; version: string; tiles: string[]; maxzoom: number; extensions?: string[];
  available: { startX: number; startY: number; endX: number; endY: number }[][] };
if (layer.format !== 'quantized-mesh-1.0' || layer.scheme !== 'tms' || layer.projection !== 'EPSG:4326') throw new Error(`unexpected terrain layer: ${layer.format} ${layer.scheme} ${layer.projection}`);
const zoom = values.zoom ? Number(values.zoom) : layer.maxzoom;
const range = tileRange(zoom, south, west, north, east);
const available = layer.available[zoom] ?? [];
const out = path.join(values.out, values.name);
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'layer.json'), layerBody);
interface Saved { file: string; url: string; z: number; x: number; y: number; bytes: number; sha256: string }
const saved: Saved[] = [];
for (let x = range.x0; x <= range.x1; x++) for (let y = range.y0; y <= range.y1; y++) {
  if (!available.some(a => x >= a.startX && x <= a.endX && y >= a.startY && y <= a.endY)) throw new Error(`tile ${zoom}/${x}/${y} is not available in the layer; choose a lower --zoom`);
  const url = new URL(layer.tiles[0]!.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{version}', layer.version), values.layer).href;
  const body = await get(url);
  const file = `${zoom}_${x}_${y}.terrain`;
  writeFileSync(path.join(out, file), body);
  saved.push({ file, url, z: zoom, x, y, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
}

const index = { schemaVersion: 1, layer: values.layer, layerName: '2021_terrain', version: layer.version, extensions: layer.extensions ?? [], zoom, bboxEN: bbox,
  layerJsonSha256: createHash('sha256').update(layerBody).digest('hex'), tiles: saved };
const indexBody = Buffer.from(JSON.stringify(index, null, 1) + '\n');
writeFileSync(path.join(out, 'tiles.json'), indexBody);
const ledgerPath = path.join(values.out, 'ledger.json');
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { schemaVersion: 1, snapshots: {} };
ledger.snapshots[values.name] = {
  path: `${values.name}/tiles.json`, url: values.layer, layerVersion: layer.version, zoom, retrievedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  tiles: saved.length, bytes: saved.reduce((s, t) => s + t.bytes, 0), sha256: createHash('sha256').update(indexBody).digest('hex'), bboxEN: bbox,
};
ledger.source = {
  id: 'helsinki-terrain-2021', title: 'City of Helsinki terrain model 2021 (quantized-mesh, layer 2021_terrain "Maastomalli")',
  url: 'https://kartta.hel.fi/3d/', license: 'CC BY 4.0 (plan v3 sections 1 and 18: confirmed by the city for the LoD2, terrain, tree and mesh layers of its 3D map stream)',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Terrain: Helsinki terrain model 2021 © City of Helsinki, CC BY 4.0',
};
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({ zoom, tiles: saved.length, bytes: ledger.snapshots[values.name].bytes, version: layer.version }));
