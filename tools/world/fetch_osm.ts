// Snapshot OpenStreetMap data for a projected bounding box through the OSM API 0.6 `map` call (every node,
// way and relation in the box, with all nodes of the ways that cross it), stored unchanged with a ledger
// entry. The road graph is derived from it offline (build_roads.ts); the game never calls OSM.
//   node tools/world/fetch_osm.ts --bbox EMIN NMIN EMAX NMAX --margin 40 --name senate-district --out data/raw/osm
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gk25ToGeodetic } from '../../packages/world-schema/src/index.ts';

const API = 'https://api.openstreetmap.org/api/0.6/map.json';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  bbox: { type: 'string', multiple: false }, margin: { type: 'string', default: '40' }, name: { type: 'string' }, out: { type: 'string' },
} });
// --bbox takes four numbers: accept them as the option value plus positionals.
const bbox = [values.bbox, ...positionals].map(Number);
if (bbox.length !== 4 || !bbox.every(Number.isFinite) || !values.name || !values.out) throw new Error('--bbox EMIN NMIN EMAX NMAX, --name and --out are required');
const [emin, nmin, emax, nmax] = bbox as [number, number, number, number];
const margin = Number(values.margin);
const corners = [[emin - margin, nmin - margin], [emax + margin, nmin - margin], [emin - margin, nmax + margin], [emax + margin, nmax + margin]]
  .map(([e, n]) => gk25ToGeodetic(e!, n!));
const r7 = (v: number) => Math.round(v * 1e7) / 1e7;
const [minLat, maxLat] = [r7(Math.min(...corners.map(c => c[0]))), r7(Math.max(...corners.map(c => c[0])))];
const [minLon, maxLon] = [r7(Math.min(...corners.map(c => c[1]))), r7(Math.max(...corners.map(c => c[1])))];
const url = `${API}?bbox=${minLon},${minLat},${maxLon},${maxLat}`;

const response = await fetch(url, { headers: { 'User-Agent': 'helsinki-game-world-pipeline/0.1 (offline road graph build)', Accept: 'application/json' } });
if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
const body = Buffer.from(await response.arrayBuffer());
const data = JSON.parse(body.toString('utf8'));
if (data.version !== '0.6' || !String(data.license).includes('odbl')) throw new Error(`unexpected response: version ${data.version}, licence ${data.license}`);
const counts: Record<string, number> = {};
let newest = '';
for (const el of data.elements) {
  counts[el.type] = (counts[el.type] ?? 0) + 1;
  if (typeof el.timestamp === 'string' && el.timestamp > newest) newest = el.timestamp;
}

const out = values.out;
mkdirSync(out, { recursive: true });
const file = `${values.name}.json`;
writeFileSync(path.join(out, file), body);
const ledgerPath = path.join(out, 'ledger.json');
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { schemaVersion: 1, snapshots: {} };
ledger.snapshots[values.name] = {
  path: file, url, retrievedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), bytes: body.length,
  sha256: createHash('sha256').update(body).digest('hex'), elements: counts, newestElementEdit: newest,
  bboxLatLon: [minLat, minLon, maxLat, maxLon], bboxEN: [emin, nmin, emax, nmax], marginMeters: margin,
  generator: data.generator,
};
ledger.source = {
  id: 'osm', title: 'OpenStreetMap (API 0.6 map snapshot)', url: 'https://www.openstreetmap.org/',
  license: 'ODbL 1.0', licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  attribution: 'Road data © OpenStreetMap contributors, ODbL 1.0',
};
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({ file: path.join(out, file), bytes: body.length, elements: counts, newestElementEdit: newest }));
