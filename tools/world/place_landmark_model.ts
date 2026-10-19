// Placement of an authored landmark model (binary STL, Z up, arbitrary units) on its city building (decision 0005):
// centred on the register footprint and turned to its edge directions, scaled per axis to the footprint's extent
// and to the LoD2 building's top above the lowest terrain along the footprint, with wall and roof colours from the
// LoD2 building's own textures (area-weighted luminance bands, put through the facade grade). Writes placement.json for
// tools/blender/build_landmark_model.py.
//   node tools/world/place_landmark_model.ts --model models/Helsinki-cathedral-lowpoly.stl --vtj 103027179C \
//     --city-model data/work/m0/citymodel-v2 --register data/raw/helsinki-building-register/senate-district.geojson \
//     --terrain data/work/m0/terrain-v2 --origin content/helsinki/world-origin.json --config content/helsinki/cells.json \
//     --out data/work/m0/cathedral/placement.json
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { parseTerrain, sampleTerrain } from '../../packages/world-schema/src/index.ts';
import { loadGeoJsonPolygons } from './lib/geometry.ts';
import { removeVeil, type FacadeGrade } from './lib/grade.ts';

const { values } = parseArgs({ options: {
  model: { type: 'string' }, vtj: { type: 'string' }, 'city-model': { type: 'string' }, register: { type: 'string' }, terrain: { type: 'string' },
  origin: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' },
} });
for (const k of ['model', 'vtj', 'city-model', 'register', 'terrain', 'origin', 'config', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`);
if (existsSync(values.out!)) throw new Error(`${values.out} exists`);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const origin = JSON.parse(readFileSync(values.origin!, 'utf8'));
const [E0, N0] = origin.originProjected as [number, number, number];
const config = JSON.parse(readFileSync(values.config!, 'utf8'));

// ---- model: binary STL ----
const stl = readFileSync(values.model!);
const count = stl.readUInt32LE(80);
if (stl.length !== 84 + count * 50) throw new Error(`${values.model} is not a binary STL`);
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
const verts: [number, number, number][] = [];
for (let t = 0; t < count; t++) for (let k = 0; k < 3; k++) {
  const o = 84 + t * 50 + 12 + k * 12;
  const v: [number, number, number] = [stl.readFloatLE(o), stl.readFloatLE(o + 4), stl.readFloatLE(o + 8)];
  verts.push(v);
  for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, v[i]!); hi[i] = Math.max(hi[i]!, v[i]!); }
}
// Plan extent above the base plate (the bottom 1.5 units), which overhangs the walls.
const above = verts.filter(v => v[2] >= lo[2]! + 1.5);
const mx0 = Math.min(...above.map(v => v[0])), mx1 = Math.max(...above.map(v => v[0])), my0 = Math.min(...above.map(v => v[1])), my1 = Math.max(...above.map(v => v[1]));

// ---- register footprint: centre, edge direction, extent ----
const fp = loadGeoJsonPolygons(values.register!, E0, N0, (p, i) => String(p['vtj_prt'] ?? i)).find(f => f.id === values.vtj);
if (!fp) throw new Error(`${values.vtj} is not in ${values.register}`);
const ring = fp.rings[0]!;
let c4 = 0, s4 = 0;
for (let i = 0; i < ring.length; i++) {
  const a = ring[i]!, b = ring[(i + 1) % ring.length]!, len = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  c4 += len * Math.cos(4 * ang); s4 += len * Math.sin(4 * ang);
}
const theta = Math.atan2(s4, c4) / 4; // edge direction modulo 90°, in (-45°, 45°]
const ux = Math.cos(theta), uy = Math.sin(theta);
const us = ring.map(p => p[0] * ux + p[1] * uy), vs = ring.map(p => -p[0] * uy + p[1] * ux);
const fu0 = Math.min(...us), fu1 = Math.max(...us), fv0 = Math.min(...vs), fv1 = Math.max(...vs);
const cu = (fu0 + fu1) / 2, cv = (fv0 + fv1) / 2;
const centre: [number, number] = [cu * ux - cv * uy, cu * uy + cv * ux];

// ---- heights: lowest terrain along the footprint, LoD2 top ----
const terrain = parseTerrain(new Uint8Array(readFileSync(path.join(values.terrain!, 'terrain.bin'))));
let base = Infinity;
for (let i = 0; i < ring.length; i++) {
  const a = ring[i]!, b = ring[(i + 1) % ring.length]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
  for (let k = 0; k < n; k++) { const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n; base = Math.min(base, sampleTerrain(terrain, x, -y)); }
}
const cityDir = values['city-model']!;
const city = JSON.parse(readFileSync(path.join(cityDir, 'city-model.json'), 'utf8'));
if (city.originId !== origin.id) throw new Error(`city model origin ${city.originId} is not ${origin.id}`);
const building = city.buildings.find((b: { vtj: string | null }) => b.vtj === values.vtj);
if (!building) throw new Error(`${values.vtj} is not in the city model`);
const top = building.boundsENU.max[2] as number;

// ---- colours: area-weighted luminance bands of the LoD2 building's wall and roof texels, then the facade grade. The
// walls take the lit plaster (80th to 90th percentile), since the photos' shadowed porticos would grey a median and the
// bake adds its own shading; the roofs take the middle band (40th to 60th percentile). ----
const cityBin = readFileSync(path.join(cityDir, city.binary.file));
const f32 = (o: { offset: number; bytes: number }) => new Float32Array(cityBin.buffer.slice(cityBin.byteOffset + o.offset, cityBin.byteOffset + o.offset + o.bytes));
const u32 = (o: { offset: number; bytes: number }) => new Uint32Array(cityBin.buffer.slice(cityBin.byteOffset + o.offset, cityBin.byteOffset + o.offset + o.bytes));
const texels = { wall: [[], [], []] as number[][], roof: [[], [], []] as number[][] };
for (const p of building.parts) {
  if (p.texture === null) continue;
  const { data, info } = await sharp(path.join(cityDir, city.textures[p.texture].file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const P = f32(p.positions), U = f32(p.uvs), I = u32(p.indices);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]!, b = I[t + 1]!, d = I[t + 2]!;
    const ax = P[b * 3]! - P[a * 3]!, ay = P[b * 3 + 1]! - P[a * 3 + 1]!, az = P[b * 3 + 2]! - P[a * 3 + 2]!, bx = P[d * 3]! - P[a * 3]!, by = P[d * 3 + 1]! - P[a * 3 + 1]!, bz = P[d * 3 + 2]! - P[a * 3 + 2]!;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const up = nz / len, cls = up >= 0.3 ? 'roof' : up > -0.3 ? 'wall' : null;
    if (!cls) continue;
    const n = Math.max(1, Math.round(len / 2 * 16));
    for (let k = 0; k < n; k++) {
      let r1 = ((k + 0.5) * 0.7548776662) % 1, r2 = ((k + 0.5) * 0.5698402910) % 1;
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const uu = U[a * 2]! + (U[b * 2]! - U[a * 2]!) * r1 + (U[d * 2]! - U[a * 2]!) * r2, vv = U[a * 2 + 1]! + (U[b * 2 + 1]! - U[a * 2 + 1]!) * r1 + (U[d * 2 + 1]! - U[a * 2 + 1]!) * r2;
      const x = Math.min(info.width - 1, Math.max(0, Math.floor(uu * info.width))), y = Math.min(info.height - 1, Math.max(0, Math.floor((1 - vv) * info.height)));
      const o = (y * info.width + x) * 4;
      if (Math.max(data[o]!, data[o + 1]!, data[o + 2]!) < 6) continue; // chart padding
      for (let ch = 0; ch < 3; ch++) texels[cls][ch]!.push(data[o + ch]!);
    }
  }
}
/** Mean colour of the texels whose Rec. 601 luma lies between two percentiles. */
const band = (ch: number[][], p0: number, p1: number): number[] => {
  const order = ch[0]!.map((_, i) => i).sort((a, b) => (0.299 * ch[0]![a]! + 0.587 * ch[1]![a]! + 0.114 * ch[2]![a]!) - (0.299 * ch[0]![b]! + 0.587 * ch[1]![b]! + 0.114 * ch[2]![b]!));
  const pick = order.slice(Math.floor(order.length * p0), Math.max(Math.floor(order.length * p0) + 1, Math.floor(order.length * p1)));
  return [0, 1, 2].map(c => Math.round(pick.reduce((s, i) => s + ch[c]![i]!, 0) / pick.length));
};
const graded = (rgb: number[]): [number, number, number] => {
  const px = Uint8Array.from([...rgb, 255]);
  removeVeil(px, config.facadeGrade as FacadeGrade);
  return [px[0]!, px[1]!, px[2]!];
};
const wallRaw = band(texels.wall, 0.8, 0.9), roofRaw = band(texels.roof, 0.4, 0.6);

const placement = {
  schemaVersion: 1, originId: origin.id, frame: 'working: X east, Y north, Z up, metres from the origin',
  model: { file: values.model, sha256: sha256(stl), triangles: count, bounds: { min: lo, max: hi }, planAbovePlate: { x: [mx0, mx1], y: [my0, my1] } },
  building: { vtj: values.vtj, id: building.id, footprintVertices: ring.length, footprintExtent: [fu1 - fu0, fv1 - fv0], top, base },
  // Model point (mcx, mcy, zmin) maps to (centre, base); then scale per model axis, then turn by rotationDeg about Z.
  transform: {
    modelPivot: [(mx0 + mx1) / 2, (my0 + my1) / 2, lo[2]!], scale: [(fu1 - fu0) / (mx1 - mx0), (fv1 - fv0) / (my1 - my0), (top - base) / (hi[2]! - lo[2]!)],
    rotationDeg: theta * 180 / Math.PI, translation: [centre[0], centre[1], base],
  },
  colours: { method: 'LoD2 building texels at 16 samples per m2 (chart padding excluded), walls |nZ| < 0.3 as the mean of the 80th to 90th luma percentile, roofs nZ >= 0.3 as the mean of the 40th to 60th, then the facade grade (removeVeil)',
    wallRaw, roofRaw, wall: graded(wallRaw), roof: graded(roofRaw), samples: { wall: texels.wall[0]!.length, roof: texels.roof[0]!.length } },
};
mkdirSync(path.dirname(values.out!), { recursive: true });
writeFileSync(values.out!, JSON.stringify(placement, null, 1) + '\n');
console.log(JSON.stringify({ transform: placement.transform, colours: { wall: placement.colours.wall, roof: placement.colours.roof }, base, top }));
