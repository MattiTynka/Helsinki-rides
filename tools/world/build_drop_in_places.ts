// Drop-in places beyond the release's own addresses: every Helsinki district (kaupunginosa) and sub-district (osa-alue)
// with streets in the playable area, and every named street there that the release's addresses do not name. A street's
// point is on its own carriageway, on land in a static or base-map square, nearest the middle of the street; a
// district's point is its street point nearest the district's centre. Written as `places.json` beside the base map
// (apps/game/src/world/live/places.ts), which the game adds to the drop-in menu, grouped by district.
//   node tools/world/build_drop_in_places.ts --world ../work/navigation-v1/world --out ../work/basemap-v1/basemap
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { validateWorldManifest, type GameplayBundle, type WorldManifest } from '../../packages/world-schema/src/index.ts';
import { LIVE_REGION_XZ, LiveGrid } from '../../packages/sim/src/live-grid.ts';
import { LIVE_GROUND_QUADS, LIVE_GROUND_STEP, LIVE_SOURCES, type GeoJsonFeatureCollection, type Origin } from '../../apps/game/src/world/live/contract.ts';
import { contains, featurePolygons } from '../../apps/game/src/world/live/convert/collision-cell.ts';
import { blockKey, blockOf, decodeBaseBlock, type BaseMapIndex } from '../../apps/game/src/world/live/convert/base-map.ts';
import { PLACES_FORMAT, type DropInPlaces } from '../../apps/game/src/world/live/places.ts';

const { values } = parseArgs({ options: { world: { type: 'string' }, out: { type: 'string' } } });
if (!values.world || !values.out) throw new Error('--world and --out are required');
const Q = LIVE_GROUND_QUADS, STEP = LIVE_GROUND_STEP, SQUARE = Q * STEP;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const manifest = JSON.parse(fs.readFileSync(path.join(values.world, 'manifest.json'), 'utf8')) as WorldManifest;
if (validateWorldManifest(manifest).length) throw new Error(`manifest is invalid: ${validateWorldManifest(manifest).join('; ')}`);
const gameplayRef = manifest.gameplay as unknown as { path: string };
const gameplay = JSON.parse(fs.readFileSync(path.join(values.world, ...gameplayRef.path.split('/')), 'utf8')) as GameplayBundle;
const origin = manifest.origin.originProjected as unknown as Origin, [E0, N0] = origin;
const grid = new LiveGrid(manifest.cells.map(c => c.id), LIVE_REGION_XZ);
// Streets the release's addresses already name ("Albertinkatu 33").
const addressed = new Set(gameplay.addresses.map(a => a.label.replace(/\s+\d.*$/, '')));

// Land in a square the game has: a release cell, or a base-map square that is land there.
const index = JSON.parse(fs.readFileSync(path.join(values.out, 'index.json'), 'utf8')) as BaseMapIndex;
const blocks = new Map<string, ReturnType<typeof decodeBaseBlock>>();
function onLand(x: number, z: number): boolean {
  const cx = Math.floor(x / SQUARE), cz = Math.floor(z / SQUARE);
  if (grid.isStatic(cx, cz)) return true;
  if (!grid.isLive(cx, cz)) return false;
  const key = blockKey(...blockOf(cx, cz)), ref = index.blocks[key];
  if (!ref) return false;
  if (!blocks.has(key)) blocks.set(key, decodeBaseBlock(new Uint8Array(gunzipSync(fs.readFileSync(path.join(values.out!, ref.file))))));
  const s = blocks.get(key)!.find(q => q.cx === cx && q.cz === cz);
  if (!s || s.kind !== 'land' || !s.quads) return false;
  const ix = Math.min(Q - 1, Math.floor((x - cx * SQUARE) / STEP)), iz = Math.min(Q - 1, Math.floor((z - cz * SQUARE) / STEP));
  return s.quads[iz * Q + ix]! >= 0;
}

async function wfs(layer: string, cql: string | null, bbox: number[] | null, properties: string): Promise<GeoJsonFeatureCollection> {
  let url = `${LIVE_SOURCES.wfs}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer)}&srsName=EPSG%3A3879`
    + `&outputFormat=application%2Fjson&count=100000&propertyName=${encodeURIComponent(properties)}`;
  const filter = [cql, bbox && `BBOX(geom,${bbox.join(',')},'EPSG:3879')`].filter(Boolean).map(f => `(${f})`).join(' AND ');
  if (filter) url += `&CQL_FILTER=${encodeURIComponent(filter)}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json() as GeoJsonFeatureCollection & { numberMatched?: number };
      if (typeof value.numberMatched === 'number' && value.numberMatched > value.features.length) throw new Error(`${layer}: ${value.numberMatched} matched, ${value.features.length} returned`);
      return value;
    } catch (error) {
      if (attempt >= 2) throw error;
      log(`${layer}: ${(error as Error).message}, retrying`);
    }
  }
}

type Area = { name: string; rings: number[][][]; box: [number, number, number, number]; centre: [number, number] };
const titleCase = (s: string) => s.toLocaleLowerCase('fi').replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toLocaleUpperCase('fi'));
function areas(collection: GeoJsonFeatureCollection, upper: boolean): Area[] {
  return collection.features.map(f => {
    const rings = featurePolygons(f, origin);
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    let ax = 0, az = 0, area = 0;
    for (const polygon of rings) for (const [k, r] of polygon.entries()) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        box[0] = Math.min(box[0], r[i]!); box[1] = Math.min(box[1], r[i + 1]!); box[2] = Math.max(box[2], r[i]!); box[3] = Math.max(box[3], r[i + 1]!);
        // Area centroid; holes (rings after the first) subtract through their opposite winding.
        const cross = r[j]! * r[i + 1]! - r[i]! * r[j + 1]!;
        area += cross; ax += (r[j]! + r[i]!) * cross; az += (r[j + 1]! + r[i + 1]!) * cross;
        void k;
      }
    }
    const name = String(f.properties?.['nimi_fi'] ?? '');
    return { name: upper ? titleCase(name) : name, rings, box, centre: [ax / (3 * area), az / (3 * area)] as [number, number] };
  }).filter(a => a.name && Number.isFinite(a.centre[0]));
}
const inArea = (a: Area, x: number, z: number) => x >= a.box[0] && x <= a.box[2] && z >= a.box[1] && z <= a.box[3] && a.rings.some(r => contains(r, x, z));

// ---- districts ----
const props = 'nimi_fi,geom';
const [kaupunginosat, osaAlueet] = await Promise.all([
  wfs('avoindata:Kaupunginosajako', null, null, props), wfs('avoindata:Piirijako_osaalue', null, null, props),
]);
const districts = areas(kaupunginosat, true), subDistricts = areas(osaAlueet, false);
log(`${districts.length} districts, ${subDistricts.length} sub-districts`);

// ---- streets: carriageways in 4096 m tiles of the region and the release ----
const ids = manifest.cells.map(c => grid.parse(c.id)!).filter(Boolean);
const x0 = Math.min(LIVE_REGION_XZ[0], ...ids.map(c => c[0] * SQUARE)), x1 = Math.max(LIVE_REGION_XZ[2], ...ids.map(c => (c[0] + 1) * SQUARE));
const z0 = Math.min(LIVE_REGION_XZ[1], ...ids.map(c => c[1] * SQUARE)), z1 = Math.max(LIVE_REGION_XZ[3], ...ids.map(c => (c[1] + 1) * SQUARE));
const parts = new Map<string, { id: string; rings: number[][]; box: [number, number, number, number] }[]>();
const seen = new Set<string>();
for (let tz = z0; tz < z1; tz += 4096) for (let tx = x0; tx < x1; tx += 4096) {
  const bbox = [E0 + tx, N0 - Math.min(tz + 4096, z1), E0 + Math.min(tx + 4096, x1), N0 - tz];
  const tile = await wfs(LIVE_SOURCES.streetParts, "paatyyppi='Ajorata' AND alatyyppi='Ajorata'", bbox, 'tietopalvelu_id,alueen_nimi,geom');
  for (const f of tile.features) {
    const id = String(f.properties?.['tietopalvelu_id'] ?? f.id), name = String(f.properties?.['alueen_nimi'] ?? '').trim();
    if (!name || seen.has(id)) continue;
    seen.add(id);
    for (const rings of featurePolygons(f, origin)) {
      const r = rings[0]!, box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < r.length; i += 2) { box[0] = Math.min(box[0], r[i]!); box[1] = Math.min(box[1], r[i + 1]!); box[2] = Math.max(box[2], r[i]!); box[3] = Math.max(box[3], r[i + 1]!); }
      (parts.get(name) ?? parts.set(name, []).get(name)!).push({ id, rings, box });
    }
  }
  log(`tile ${tx},${tz}: ${tile.features.length} carriageway parts, ${parts.size} streets so far`);
}

// A street's point: on its carriageway (2 m grid, odd coordinates like the ground quads), on land the game has,
// nearest the middle of all its parts.
const streets: { name: string; position: [number, number] }[] = [];
for (const [name, list] of parts) {
  let mx = 0, mz = 0;
  for (const p of list) { mx += (p.box[0] + p.box[2]) / 2; mz += (p.box[1] + p.box[3]) / 2; }
  mx /= list.length; mz /= list.length;
  let best: [number, number] | null = null, bestD = Infinity;
  for (const p of list) {
    for (let z = Math.floor(p.box[1] / 2) * 2 + 1; z < p.box[3]; z += 2) for (let x = Math.floor(p.box[0] / 2) * 2 + 1; x < p.box[2]; x += 2) {
      const d = (x - mx) ** 2 + (z - mz) ** 2;
      if (d >= bestD || !contains(p.rings, x, z) || !onLand(x, z)) continue;
      best = [x, z]; bestD = d;
    }
  }
  if (best) streets.push({ name, position: best });
}
log(`${streets.length} streets with a point in the playable area`);

// ---- grouping ----
const out: DropInPlaces = { format: PLACES_FORMAT, districts: [] };
const nearest = (list: { position: [number, number] }[], [cx, cz]: [number, number]) =>
  list.reduce((a, b) => (b.position[0] - cx) ** 2 + (b.position[1] - cz) ** 2 < (a.position[0] - cx) ** 2 + (a.position[1] - cz) ** 2 ? b : a);
for (const d of districts) {
  const inside = streets.filter(s => inArea(d, ...s.position));
  if (!inside.length) continue;
  const subs = subDistricts.filter(a => a.name.toLocaleLowerCase('fi') !== d.name.toLocaleLowerCase('fi') && inArea(d, ...a.centre))
    .map(a => ({ a, inside: inside.filter(s => inArea(a, ...s.position)) })).filter(s => s.inside.length)
    .map(({ a, inside }) => ({ name: a.name, position: nearest(inside, a.centre).position }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fi'));
  out.districts.push({
    name: d.name, position: nearest(inside, d.centre).position, areas: subs,
    streets: inside.filter(s => !addressed.has(s.name)).sort((a, b) => a.name.localeCompare(b.name, 'fi')),
  });
}
out.districts.sort((a, b) => a.name.localeCompare(b.name, 'fi'));
fs.writeFileSync(path.join(values.out, 'places.json'), `${JSON.stringify(out)}\n`);
log(`places.json: ${out.districts.length} districts, ${out.districts.reduce((n, d) => n + d.areas.length, 0)} sub-districts, `
  + `${out.districts.reduce((n, d) => n + d.streets.length, 0)} streets`);
