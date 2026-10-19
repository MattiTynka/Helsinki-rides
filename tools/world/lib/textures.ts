// Seeded procedural ground textures (original content) so the baked cells carry no third-party surface imagery.
import type { RgbaImage } from './gltf.ts';
import type { Finish } from './ground.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise with a few octaves, tileable over [0, size). */
function noiseField(size: number, seed: number, octaves: number): Float32Array {
  const out = new Float32Array(size * size);
  const rnd = mulberry32(seed);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = 4 << o;
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * cells, fy = y / size * cells;
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const g = (gx: number, gy: number) => grid[((gy % cells) + cells) % cells * cells + ((gx % cells) + cells) % cells]!;
      const v = (g(ix, iy) * (1 - sx) + g(ix + 1, iy) * sx) * (1 - sy) + (g(ix, iy + 1) * (1 - sx) + g(ix + 1, iy + 1) * sx) * sy;
      out[y * size + x] = out[y * size + x]! + v * amp;
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
}

export function groundTexture(finish: Finish, size: number): RgbaImage {
  const data = new Uint8Array(size * size * 4);
  const seed = 20261016 + finish.length * 7919;
  const n1 = noiseField(size, seed, 5), n2 = noiseField(size, seed + 17, 3);
  const rnd = mulberry32(seed + 3);
  const base: Record<Finish, [number, number, number]> = {
    asphalt: [62, 62, 64], setts: [118, 112, 104], cobble: [124, 116, 104], slabs: [150, 146, 138], gravel: [140, 128, 108], grass: [78, 108, 52], yard: [96, 92, 86],
  };
  const [br, bg, bb] = base[finish];
  // Stone grids per 2 m tile: setts (nupukivi) 12 => 17 cm, cobble (noppakivi, small cube setts) 20 => 10 cm, both
  // in running-bond rows with rounded edges; slabs 3 per tile. Stone tints and the large-scale shade stay within about
  // 12 % either way so the paving reads as one surface from a distance (the earlier 20 % read as patchwork).
  const cellsPerTile = finish === 'setts' ? 12 : finish === 'slabs' ? 3 : finish === 'cobble' ? 20 : 0;
  const stones = finish === 'setts' || finish === 'cobble';
  const jointDark = stones ? 0.5 : finish === 'slabs' ? 0.55 : 1;
  const stoneTint = new Float32Array(cellsPerTile ? cellsPerTile * cellsPerTile : 1);
  for (let i = 0; i < stoneTint.length; i++) stoneTint[i] = 0.88 + rnd() * 0.24;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = y * size + x;
    let shade = 0.9 + n1[k]! * 0.2;
    if (cellsPerTile) {
      const fy = y / size * cellsPerTile, cy = Math.floor(fy);
      const fx = x / size * cellsPerTile + (stones && cy % 2 ? 0.5 : 0), cx = Math.floor(fx);
      const tint = stoneTint[((cy % cellsPerTile + cellsPerTile) % cellsPerTile) * cellsPerTile + ((cx % cellsPerTile + cellsPerTile) % cellsPerTile)]!;
      shade *= tint;
      const ex = Math.min(fx - cx, 1 - (fx - cx)), ey = Math.min(fy - cy, 1 - (fy - cy));
      const edge = Math.min(ex, ey);
      const joint = finish === 'slabs' ? 0.025 : 0.08;
      if (edge < joint) shade *= jointDark + (1 - jointDark) * (edge / joint);
      else if (stones) shade *= 0.9 + 0.1 * Math.min(1, (edge - joint) / 0.2);
    }
    if (finish === 'grass') shade *= 0.85 + n2[k]! * 0.3;
    data[k * 4] = Math.max(0, Math.min(255, br * shade));
    data[k * 4 + 1] = Math.max(0, Math.min(255, bg * shade));
    data[k * 4 + 2] = Math.max(0, Math.min(255, bb * shade));
    data[k * 4 + 3] = 255;
  }
  return { width: size, height: size, data };
}
