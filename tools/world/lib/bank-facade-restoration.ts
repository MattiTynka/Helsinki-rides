import { readFileSync } from 'node:fs';
import type { FacadeRestorationEvidence, FacadeRestorationModule, FacadeSourceImage, FacadeSources } from './facade-restoration-types.ts';

type Point = readonly [number, number];
interface Triangle { xy: readonly Point[]; uv: readonly Point[] }
interface Chart { id: string; page: number; pngSha256: string; triangles: Triangle[] }
const charts = (JSON.parse(readFileSync(new URL('../../../content/helsinki/facade-restorations/bank.json', import.meta.url), 'utf8')) as { charts: Chart[] }).charts;
const chart = (id: number) => {
  const found = charts.find(c => c.id.startsWith(`bank-${id}-`));
  if (!found) throw new Error(`Bank facade chart ${id} missing`);
  return found;
};
function barycentric(p: Point, vertices: readonly Point[]): number[] | null {
  const [a, b, c] = vertices as [Point, Point, Point];
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) return null;
  const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  return wa >= -1e-6 && wb >= -1e-6 && wa + wb <= 1 + 1e-6 ? [wa, wb, 1 - wa - wb] : null;
}
const interpolate = (points: readonly Point[], weights: number[]): Point => [0, 1].map(k => weights.reduce((s, w, i) => s + w * points[i]![k]!, 0)) as unknown as Point;
function sample(image: FacadeSourceImage, uv: Point): number[] {
  const x = Math.max(0, Math.min(image.width - 1, uv[0] * image.width - .5));
  const y = Math.max(0, Math.min(image.height - 1, uv[1] * image.height - .5));
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  return [0, 1, 2].map(k => {
    const get = (dx: number, dy: number) => image.data[(Math.min(y0 + dy, image.height - 1) * image.width + Math.min(x0 + dx, image.width - 1)) * 4 + k]!;
    return get(0, 0) * (1 - tx) * (1 - ty) + get(1, 0) * tx * (1 - ty) + get(0, 1) * (1 - tx) * ty + get(1, 1) * tx * ty;
  });
}
function sampleChart(c: Chart, sources: FacadeSources, u: number, v: number): number[] {
  const p: Point = [Math.max(.0001, Math.min(.9999, u)), Math.max(.0001, Math.min(.9999, v))];
  for (const triangle of c.triangles) {
    const weights = barycentric(p, triangle.xy);
    if (weights) return sample(sources.get(c.page)!, interpolate(triangle.uv, weights));
  }
  throw new Error(`Bank donor outside its actual wall triangles: ${c.id} ${p}`);
}
function graniteCourse(sources: FacadeSources, u: number, v: number, wallWidth: number, wallHeight: number): number[] {
  // Author straight, staggered granite courses at metre scale. Only the face's stone grain comes
  // from a clean block on this building; repeating its photographed angled joints made chevrons.
  const x = u * wallWidth, y = v * wallHeight, courseHeight = .58, blockWidth = 1.45;
  const row = Math.floor(y / courseHeight), fy = y / courseHeight - row;
  const shiftedX = x / blockWidth + (row % 2) * .5, column = Math.floor(shiftedX), fx = shiftedX - column;
  const grain = sampleChart(chart(5), sources, .56 + fx * .045, .068 + fy * .020);
  const shade = ((column * 17 + row * 11) % 7 - 3) * 1.2;
  // Integrate the narrow joint over a source-sized texel footprint. Point sampling produced
  // black dashes when the facade was resampled into its atlas.
  const coverage = (distance: number) => Math.max(0, Math.min(.06, .012 - distance) - Math.max(-.06, -.012 - distance)) / .12;
  const horizontal = coverage(Math.min(fy, 1 - fy) * courseHeight);
  const vertical = coverage(Math.min(fx, 1 - fx) * blockWidth);
  const joint = 1 - (1 - horizontal) * (1 - vertical);
  return grain.map(c => c * (1 - .34 * joint) + shade);
}
function northShade(sources: FacadeSources): number[] {
  const ratios = [0, 1, 2].map(() => [] as number[]);
  for (const u of [.15, .4, .5, .6, .8]) for (const v of [.78, .81, .84]) {
    const north = sampleChart(chart(11), sources, u, v), south = sampleChart(chart(12), sources, u, v);
    for (let channel = 0; channel < 3; channel++) ratios[channel]!.push(north[channel]! / Math.max(1, south[channel]!));
  }
  return ratios.map(values => {
    values.sort((a, b) => a - b); const gain = values[Math.floor(values.length / 2)]!;
    if (gain < .15 || gain > 1.2) throw new Error('Bank north illumination anchors are invalid');
    return gain;
  });
}
function paint(c: Chart, rgba: Uint8Array, width: number, height: number, decide: (u: number, v: number) => number[] | null): number {
  const changed = new Set<number>();
  for (const triangle of c.triangles) {
    const xs = triangle.uv.map(p => p[0] * width), ys = triangle.uv.map(p => p[1] * height);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(height, Math.ceil(Math.max(...ys))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(width, Math.ceil(Math.max(...xs))); x++) {
        const weights = barycentric([(x + .5) / width, (y + .5) / height], triangle.uv);
        if (!weights || weights.some(weight => weight < 0)) continue;
        const [u, v] = interpolate(triangle.xy, weights), rgb = decide(u, v);
        if (!rgb) continue;
        const i = y * width + x;
        for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.round(Math.max(0, Math.min(255, rgb[k]!)));
        changed.add(i);
      }
    }
  }
  return changed.size;
}

/** Reviewed building-specific bay repetitions; no green detector, arbitrary plaster fill or geometry change. */
export const bankRestoration: FacadeRestorationModule = {
  id: 'bank-of-finland-licensed-bay-reconstruction',
  targetPages: [29, 30, 31, 33, 34],
  sourcePages: [29, 30, 31, 33, 34],
  apply(page, rgba, width, height, sources) {
    if (![29, 30, 31, 33, 34].includes(page)) return [];
    if (rgba.length !== width * height * 4 || width < 128 || height < 64) throw new Error('Bank facade dimensions invalid');
    for (const id of [0, 1, 7, 2, 27]) {
      const c = chart(id), source = sources.get(c.page);
      if (!source || source.pngSha256 !== c.pngSha256) throw new Error(`Bank master ${c.page} changed; review the authored mapping`);
      const expectedHeight = c.page === 33 ? 256 : c.page === 34 ? 512 : 1024;
      if (source.width !== 1024 || source.height !== expectedHeight || source.data.length !== 1024 * expectedHeight * 4) throw new Error(`Bank master ${c.page} dimensions invalid`);
    }
    const result: FacadeRestorationEvidence[] = [];
    const shaded = (color: number[], gain: number[]) => color.map((value, channel) => value * gain[channel]!);
    const shade = northShade(sources);
    if (page === 29) {
      const north = chart(2);
      const count = paint(north, rgba, width, height, (u, v) => {
        if (v < .235) return shaded(graniteCourse(sources, u, v, 17.8275, 17.38), shade);
        if (u < .2 && v < .59) return sampleChart(north, sources, .62 + (u - .07), v);
        return null;
      });
      const wallCount = paint(chart(21), rgba, width, height, (u, v) => graniteCourse(sources, u, v, 15.7503, 4.571));
      result.push({ id: 'bank-north-lower-bay-and-south-retaining-face', page, changedTexels: count + wallCount,
        limits: 'A matching clear north bay repairs the single obscured lower window. The low south face uses authored granite courses after leafless Street View confirmed stone retaining masonry. Separate railing geometry is not reconstructed.' });
    }
    if (page === 33) {
      const c = chart(0);
      // The intact northern bays establish the 38-bay grid, including all four upper window rows and
      // the taller dark ground-floor band. Use three complete bays so frames cross patch boundaries.
      const period = .02607, start = .028, donorWidth = 3 * period;
      const count = paint(c, rgba, width, height, (u, v) => {
        const phase = ((u - start) % donorWidth + donorWidth) % donorWidth;
        return sampleChart(c, sources, start + phase, Math.max(.08, Math.min(.988, v)));
      });
      result.push({ id: 'bank-modern-west-38-bays', page, changedTexels: count, period, donor: [start, start + donorWidth],
        limits: 'Reconstructed occluded window grid and matching cornice profile from three intact bays of the same west wall. Four upper rows and ground-floor proportions retained; repeated glazing and lighting are approximate.' });
    }
    if (page === 30) {
      const c = chart(1), period = .147, donorCenter = .645;
      const count = paint(c, rgba, width, height, (u, v) => {
        if (v > .865) return null;
        if (v < .22) return graniteCourse(sources, u, v, 25.2755, 18.576);
        // The seven window axes include a unique central entrance: keep its full opening in place.
        if (u > .426 && u < .571 && v < .49) return u < .5 ? sampleChart(c, sources, 1 - u, v) : null;
        if (u > .571 && u < .865 && v > .12) return null;
        const bay = Math.round((u - .058) / period), center = .058 + bay * period;
        return sampleChart(c, sources, donorCenter + (u - center), v);
      });
      result.push({ id: 'bank-east-seven-window-axes', page, changedTexels: count, period, donorCenter,
        limits: 'Same-elevation complete arched window bays replace photographed poplars. The central entrance and original roof/cornice remain; low granite courses are authored using same-building stone grain. Repeated shadows and glazing represent reconstructed obscured detail.' });
    }
    if (page === 31) {
      const c = chart(7);
      const count = paint(c, rgba, width, height, (u, v) => {
        if (v > .58) return null;
        // The corner blocks are blind above a single ground opening. Mirror that matching opposite
        // block, retaining its actual opening, stone courses and lower vent instead of inventing bays.
        let donorU = u < .2 ? 1 - u : u;
        if (donorU < .90) donorU = .974 + (donorU % .018);
        if (v < .10) return graniteCourse(sources, u, v, 39.004, 17.731);
        return sampleChart(c, sources, donorU, v);
      });
      result.push({ id: 'bank-east-corner-blocks', page, changedTexels: count,
        limits: 'Matching opposite corner-block masonry and ground opening reconstruct the obscured block. Upper blind niches remain original; lowest photographed planting strip uses authored granite courses and same-building stone grain.' });
      let returns = 0;
      for (const [id, metres, heightMetres] of [[11, 7.33465, 17.803], [12, 7.39729, 18.233]]) {
        const c = chart(id!), gain = id === 11 ? shade : [1, 1, 1];
        returns += paint(c, rgba, width, height, (u, v) => {
          if (v > (id === 11 ? .78 : .49)) return null;
          const worldHeight = 4.12708 + v * heightMetres!;
          if (worldHeight < 8.21) return shaded(graniteCourse(sources, u, v, metres!, heightMetres!), gain);
          if (worldHeight > 13.0) {
            const color = shaded(sampleChart(chart(12), sources, u, (worldHeight - 4.12708) / 18.233), gain);
            if (id === 11 && v > .74) {
              const original = sampleChart(c, sources, u, v), blend = (.78 - v) / .04;
              return color.map((value, channel) => value * blend + original[channel]! * (1 - blend));
            }
            return color;
          }
          const center = u < .47 ? .27 : .67;
          const color = sampleChart(chart(1), sources, .645 + (u - center) * metres! / 25.2755, (worldHeight - 4.12708) / 18.576);
          return shaded(color, gain);
        });
      }
      returns += paint(chart(37), rgba, width, height, (u, v) => graniteCourse(sources, u, v, 6.9673, 4.571));
      returns += paint(chart(29), rgba, width, height, (u, v) => v < .224 ? graniteCourse(sources, u, v, 3.0216, 18.233) : null);
      result.push({ id: 'bank-two-window-north-south-returns', page, changedTexels: returns, northIllumination: shade,
        limits: 'Two real arched axes on each return preserve original centres. Clean matching upper return and lower main-wall bays supply obscured detail, with north shade fitted to intact plaster. Low retaining face uses same-building granite grain.' });
    }
    if (page === 34) {
      const target = chart(27), donor = chart(26);
      const count = paint(target, rgba, width, height, (u, v) => {
        if (v >= .62) return null;
        // The two narrow returns flank the same north block and have no openings.
        // Preserve the target's real upper cast shadow; the clean opposite return supplies
        // its obscured lower masonry at the identical physical floor/band heights.
        const color = sampleChart(donor, sources, .08 + u * .76, v);
        const blend = Math.max(0, Math.min(1, (.62 - v) / .04));
        const original = sampleChart(target, sources, u, v);
        return color.map((value, channel) => value * blend + original[channel]! * (1 - blend));
      });
      result.push({ id: 'bank-north-block-narrow-blank-return', page, changedTexels: count,
        limits: 'Native oblique review exposed a separate 2.88m return. Clean matching opposite-return masonry reconstructs its lower62%; real upper shadow/cornice retained, no openings invented.' });
    }
    return result;
  }
};
