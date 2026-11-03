import { parseCollisionBundle } from '@helsinki/world-schema';
import type { SimState } from '@helsinki/sim';
import type { LiveGroundVisual } from '../world/live/contract.ts';

export interface MapCellData { readonly ground?: LiveGroundVisual; readonly hcol?: Uint8Array }
export type MapSource = (cx: number, cz: number) => MapCellData | null;
export const MAP_CELL_METRES = 128;
export const MAP_SCALE = 2;

/** Actor heading, independent of the orbit camera. Runtime forward is +Z, with X east and Z south. */
export function mapYaw(state: SimState): number {
  const p = state.player;
  const aircraft = p.aircraftId ? state.aircraft.find(a => a.id === p.aircraftId) : undefined;
  if (aircraft) return aircraft.yaw;
  const car = p.inVehicle ? state.vehicles.find(v => v.id === p.inVehicle) : undefined;
  if (car) {
    const [x, y, z, w] = car.rotation;
    return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
  }
  return p.yaw;
}

export function compassHeading(yaw: number): { degrees: number; cardinal: string } {
  const degrees = ((Math.round(180 - (Number.isFinite(yaw) ? yaw : Math.PI) * 180 / Math.PI) % 360) + 360) % 360;
  return { degrees, cardinal: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8]! };
}

const SURFACE_COLOURS = { road: '#c9d2e3', walk: '#727e91', green: '#405c4c', yard: '#545749' };

interface CachedCell extends MapCellData { readonly canvas: HTMLCanvasElement | null }

/** A second, world-aligned layer. Missing data never poisons the cache with a permanent blank tile. */
export class LiveMinimap {
  private readonly cells = new Map<string, CachedCell>();
  private readonly createCanvas: () => HTMLCanvasElement;
  constructor(createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')) { this.createCanvas = createCanvas; }

  cell(cx: number, cz: number, data: MapCellData | null): HTMLCanvasElement | null {
    const key = `${cx},${cz}`, cached = this.cells.get(key);
    const ground = data?.ground ?? cached?.ground, hcol = data?.hcol ?? cached?.hcol;
    if (cached && ground === cached.ground && hcol === cached.hcol) {
      this.cells.delete(key); this.cells.set(key, cached);
      return cached.canvas;
    }
    if (!ground && !hcol) return null;
    const bundle = hcol ? parseCollisionBundle(hcol) : null;
    const buildings = bundle?.colliders.filter(c => c.group === 'buildings' || c.group === 'citymodel' || c.group === 'landmarks') ?? [];
    const colliderGround = bundle?.colliders.filter(c => c.group === 'ground' && c.indices.length > 0) ?? [];
    // Immutable collision bytes with no map surfaces need decoding only once. Late data changes identity.
    if (!ground && buildings.length === 0 && colliderGround.length === 0) return this.remember(key, { canvas: null, ground, hcol });
    const canvas = this.createCanvas();
    canvas.width = canvas.height = MAP_CELL_METRES * MAP_SCALE;
    const context = canvas.getContext('2d')!;
    const triangles = (positions: Float32Array, indices: Uint32Array, colour: string, tags?: Uint16Array, tag?: number): void => {
      context.fillStyle = colour; context.beginPath();
      for (let i = 0; i < indices.length; i += 3) {
        if (tags && tags[i / 3] !== tag) continue;
        const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
        // Vertical walls project to zero area; omit them while retaining roofs and footprint holes.
        const ax = positions[a]!, az = positions[a + 2]!, bx = positions[b]!, bz = positions[b + 2]!, dx = positions[c]!, dz = positions[c + 2]!;
        if (Math.abs((bx - ax) * (dz - az) - (bz - az) * (dx - ax)) < 1e-8) continue;
        context.moveTo((ax - cx * MAP_CELL_METRES) * MAP_SCALE, (az - cz * MAP_CELL_METRES) * MAP_SCALE);
        context.lineTo((bx - cx * MAP_CELL_METRES) * MAP_SCALE, (bz - cz * MAP_CELL_METRES) * MAP_SCALE);
        context.lineTo((dx - cx * MAP_CELL_METRES) * MAP_SCALE, (dz - cz * MAP_CELL_METRES) * MAP_SCALE);
        // fill() closes each moveTo-delimited triangle; explicit closePath rescans the growing native path.
      }
      context.fill();
    };
    if (ground?.water) triangles(ground.water.positions, ground.water.indices, '#274f70');
    if (ground) for (const group of ground.classes) triangles(ground.positions, group.indices, SURFACE_COLOURS[group.surface]);
    else for (const collider of colliderGround) {
      // Ground visuals may have left their own LRU before this visit; immutable HCOL keeps the same surface tags.
      const colours: Readonly<Record<string, string>> = { 'road:asphalt': SURFACE_COLOURS.road, 'raised:slabs': SURFACE_COLOURS.walk, 'raised:grass': SURFACE_COLOURS.green, 'raised:yard': SURFACE_COLOURS.yard };
      for (const tag of new Set(collider.triangleTags)) triangles(collider.positions, collider.indices, colours[bundle!.header.surfaceTags[tag]!] ?? '#48544e', collider.triangleTags, tag);
    }
    for (const building of buildings) triangles(building.positions, building.indices, '#94929c');
    return this.remember(key, { canvas, ground, hcol });
  }

  private remember(key: string, cell: CachedCell): HTMLCanvasElement | null {
    this.cells.delete(key); this.cells.set(key, cell);
    if (this.cells.size > 24) this.cells.delete(this.cells.keys().next().value!);
    return cell.canvas;
  }
}
