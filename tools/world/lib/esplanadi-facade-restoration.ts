// Three observed Esplanadi elevations. Original wall triangles bound every texture write.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FacadeRestorationModule, FacadeSources, FacadeExternalSources } from './facade-restoration-types.ts';

type Point = readonly [number, number];
type Vec3 = readonly [number, number, number];
interface Triangle { xyz: Vec3[]; uv: Point[] }
interface Chart { page: number; tris: Triangle[] }
interface Building { name: string; id: string; charts: Chart[] }
const root = 'content/assets/facades/esplanadi/';
export const ESPLANADI_MAPPING_SHA = 'ad472dde0e78697c218440513eafa783e2e387626635730720668a0e137a3853';
export const CATANI_PHOTO_SHA = 'ec4314fbe12857b8794836bd99ddccb3767d0eb36fd757a7595baadd64a5c4b0';
const mappingBytes = readFileSync(new URL('../../../content/assets/facades/esplanadi/wall-mapping.json', import.meta.url));
if (createHash('sha256').update(mappingBytes).digest('hex') !== ESPLANADI_MAPPING_SHA) throw new Error('Esplanadi wall mapping changed; review source correspondence');
export const esplanadiMapping = JSON.parse(mappingBytes.toString()) as { buildings: Building[]; masters: { page: number; width: number; height: number; pngSha256: string }[] };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
function barycentric(p: Point, v: readonly Point[]): number[] | null {
  const [a, b, c] = v as [Point, Point, Point];
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) return null;
  const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  return wa >= -1e-6 && wb >= -1e-6 && wa + wb <= 1 + 1e-6 ? [wa, wb, 1 - wa - wb] : null;
}
function sample(image: {width: number; height: number; data: Uint8Array}, x: number, y: number): number[] {
  x = clamp(x, 0, image.width - 1); y = clamp(y, 0, image.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  return [0, 1, 2].map(ch => {
    const at = (xx: number, yy: number) => image.data[(Math.min(image.height - 1, yy) * image.width + Math.min(image.width - 1, xx)) * 4 + ch]!;
    return at(x0, y0) * (1 - tx) * (1 - ty) + at(x0 + 1, y0) * tx * (1 - ty) + at(x0, y0 + 1) * (1 - tx) * ty + at(x0 + 1, y0 + 1) * tx * ty;
  });
}
function native(building: Building, sources: FacadeSources, east: number, height: number): number[] {
  for (const c of building.charts) for (const t of c.tris) {
    const weights = barycentric([east, height], t.xyz.map(p => [p[0], p[2]]));
    if (!weights) continue;
    const uv = [0, 1].map(k => weights.reduce((sum, w, i) => sum + w * t.uv[i]![k]!, 0));
    const image = sources.get(c.page)!;
    return sample(image, uv[0]! * image.width - .5, uv[1]! * image.height - .5);
  }
  throw new Error(`Esplanadi donor outside exact wall: ${building.name}, ${east}, ${height}`);
}

function quadPoint(p: readonly Point[], u: number, v: number): Point {
  return [0,1].map(k=>p[0]![k]!*(1-u)*(1-v)+p[1]![k]!*u*(1-v)+p[2]![k]!*u*v+p[3]![k]!*(1-u)*v) as unknown as Point;
}
export function cataniPixel(east: number, height: number, externals: FacadeExternalSources): number[] {
  const image = externals.get('esplanadi-catani-valtonen')!;
  const u = clamp((east + 328.0910034) / 30.0130005, .001, .999), v = clamp((height + 4.20992136) / 24.43, 0, 1);
  if (v < .245) {
    // Five rectangular ground openings are confirmed by both the museum photo and the 2017
    // leafless view. Author the foreground-obscured plinth and frames from this building's stone
    // and glass; leave the unique middle opening as a two-leaf entrance, not a repeated display.
    const bay = Math.min(4, Math.floor(u * 5)), phase = u * 5 - bay;
    const opening = phase > .15 && phase < .85 && v > .025 && v < .219;
    if (opening) {
      const glass = sample(image, (480 + (phase-.15)/.70*58)*image.width/900, (972 + (1-(v-.025)/.194)*135)*image.height/1200);
      const frame = Math.min(phase-.15,.85-phase)<.014 || (bay===2 && Math.abs(phase-.5)<.012) || (bay!==2 && Math.abs(v-.064)<.005);
      if (frame) return [44,40,32];
      return glass.map(c=>c*(bay===2?.73:1));
    }
    const stone = sample(image,(615+(phase*17)%18)*image.width/900,(1000+(v*47)%5)*image.height/1200);
    const course=(height+4.21)/.57, joint=clamp((.09-Math.abs(course-Math.round(course))*.57)/.09,0,1);
    return stone.map(c=>c*(1-.40*joint));
  }
  // Ten upper window axes over five ground openings are visible in the leafless front reference.
  // A clean complete middle axis supplies their homologous ornament, avoiding flags at both ends.
  const phase = u*10%1;
  const [x,y] = v < .442
    ? quadPoint([[258,920],[308,911],[314,782],[263,799]],phase,(v-.245)/(.442-.245))
    : quadPoint([[410,732],[493,699],[488,185],[411,249]],phase,(v-.442)/(1-.442));
  return sample(image, x * image.width / 900, y * image.height / 1200);
}

export function esplanadiPixel(building: Building, east: number, height: number, sources: FacadeSources, externals: FacadeExternalSources): number[] | null {
  if (building.name === 'Pohjoisesplanadi_31') return height <= 20.225 ? cataniPixel(east, height, externals) : null;
  if (building.name === 'Pohjoisesplanadi_33') {
    // Retain the narrow central entrance. Matching western glass/stone bays supply the two
    // obscured eastern shopfronts; clear upper architecture anchors the existing shaded end.
    let donorEast: number | null = null;
    if (east > -335.446 && height < 3.9) donorEast = -358.234 + (east + 335.446) / 7.355 * 7.278;
    if (east > -341.227 && east < -335.499 && height < 3.9) donorEast = -350.943 + (east + 341.227) / 5.728 * 5.804;
    if (donorEast !== null) {
      const gain = east > -335.446 ? [.53,.55,.58] : [.94,.94,.94];
      return native(building,sources,donorEast,height).map((v,k)=>v*gain[k]!);
    }
    return null;
  }
  // Gronqvist/Pohjoisesplanadi35: nine arched shopfront bays, both end balconies and a central
  // passage. Keep the structural arches; separate foreground crowns/cast street pixels below them.
  const first = -415.34, pitch = 4.96, bay = clamp(Math.round((east - first) / pitch),0,8);
  if (height > 6.8) return null;
  const delta = east - (first + pitch * bay);
  if (height < 1.05) {
    const isGlass = Math.abs(delta)<1.72 && height> (bay===4?-4.35:-3.8);
    if(isGlass) {
      const glass=native(building,sources,-380.6+delta*.12,.3+height*.08);
      const frame = Math.abs(delta)<.045 || Math.abs(delta)>1.65 || (bay!==4 && Math.abs(height+2.1)<.035);
      return frame ? [47,43,35] : glass;
    }
    // Clean rusticated stone pier, retaining horizontal courses at the original metre scale.
    const stone=native(building,sources,-383.35,.42);
    const course=(height+4.4)/.55,joint=clamp((.09-Math.abs(course-Math.round(course))*.55)/.09,0,1);
    return stone.map(c=>c*(1-.28*joint));
  }
  const limits = [1.2, 6.8, 6.8, 6.8, -100, -100, -100, -100, 3.8];
  if (height > limits[bay]!) return null;
  const donor = 6;
  return native(building, sources, first + pitch * donor + delta, height);
}

export const esplanadiRestoration: FacadeRestorationModule = {
  id: 'esplanadi-31-33-35-source-bound', targetPages: [677,697,698,699,701], sourcePages: [677,697,698,699,701],
  supportFiles: [{file:root+'wall-mapping.json',sha256:ESPLANADI_MAPPING_SHA}],
  externalSources: [{id:'esplanadi-catani-valtonen',file:root+'catani-valtonen.jpg',sha256:CATANI_PHOTO_SHA}],
  apply(page, rgba, width, height, sources, externals) {
    if (!this.targetPages.includes(page)) return [];
    for (const m of esplanadiMapping.masters) {
      const source = sources.get(m.page);
      if (!source || source.pngSha256 !== m.pngSha256 || source.width !== m.width || source.height !== m.height || source.data.length !== source.width*source.height*4) throw new Error(`Esplanadi master ${m.page} changed; review mapping`);
    }
    if (!externals || externals.get('esplanadi-catani-valtonen')?.sha256 !== CATANI_PHOTO_SHA) throw new Error('Esplanadi Catani photograph missing or changed');
    const photo = externals.get('esplanadi-catani-valtonen')!;
    if(photo.width!==900||photo.height!==1200||photo.data.length!==900*1200*4) throw new Error('Esplanadi Catani photograph dimensions invalid');
    if (rgba.length !== width * height * 4 || width < 128 || height < 128) throw new Error('Esplanadi target dimensions invalid');
    const evidence = [];
    for (const b of esplanadiMapping.buildings) {
      const changed = new Set<number>();
      for (const c of b.charts.filter(c => c.page === page)) for (const t of c.tris) {
        const xs = t.uv.map(p => p[0]*width), ys = t.uv.map(p => p[1]*height);
        for (let y=Math.max(0,Math.floor(Math.min(...ys))); y<Math.min(height,Math.ceil(Math.max(...ys))); y++) for (let x=Math.max(0,Math.floor(Math.min(...xs))); x<Math.min(width,Math.ceil(Math.max(...xs))); x++) {
          const weights = barycentric([(x+.5)/width,(y+.5)/height], t.uv);
          if (!weights || weights.some(w=>w<0)) continue;
          const east = weights.reduce((s,w,i)=>s+w*t.xyz[i]![0],0), z = weights.reduce((s,w,i)=>s+w*t.xyz[i]![2],0);
          const rgb = esplanadiPixel(b,east,z,sources,externals); if (!rgb) continue;
          const offset=(y*width+x)*4;
          for(let k=0;k<3;k++) rgba[offset+k]=Math.round(clamp(rgb[k]!,0,255));
          changed.add(offset/4);
        }
      }
      if (changed.size) evidence.push({id:b.id,page,changedTexels:changed.size,limits:'Exact street wall charts only; photographs reconstruct occluded architecture, not surveyed hidden pixels. Roof, ground geometry and other charts preserved. Google Maps unavailable; official museum and building-control references used.'});
    }
    return evidence;
  },
};
