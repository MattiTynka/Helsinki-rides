// Selects the content tiles of the city's textured LoD2 tileset (3D Tiles 1.1) for one geodetic box, walking it as
// tools/world/fetch_city_model.ts does: region culling, column-major tile transforms accumulated from the root, and
// external tileset JSONs followed with that transform. REPLACE refinement stops at the first content whose geometric
// error is small enough, or at a leaf. Fetching is injected, so the walk runs in the live-cell worker or in Node.
import { IDENTITY, multiply4, type GeodeticBox } from './projection.ts';

export interface SelectedTile { url: string; transform: number[]; geometricError: number; region: number[] }

interface Tile {
  boundingVolume?: { region?: number[] };
  geometricError?: number;
  transform?: number[];
  content?: { uri?: string; url?: string };
  children?: Tile[];
}
interface Tileset { asset?: { version?: string }; root: Tile }

function asTileset(value: unknown, url: string): Tileset {
  const root = typeof value === 'object' && value !== null ? (value as { root?: unknown }).root : undefined;
  if (typeof root !== 'object' || root === null) throw new Error(`${url}: not a 3D Tiles tileset`);
  return value as Tileset;
}

/**
 * Content tiles (GLB) meeting `box`, in URL order. A tile's content is taken when its geometric error is at most
 * `maxGeometricError` or it has no children; otherwise its children replace it. Relative URIs resolve against the
 * tileset JSON that holds them; a level's children are walked in parallel.
 */
export async function selectTiles(
  rootUrl: string, box: GeodeticBox, maxGeometricError: number, fetchJson: (url: string) => Promise<unknown>,
): Promise<SelectedTile[]> {
  const tileset = asTileset(await fetchJson(rootUrl), rootUrl);
  if (tileset.asset?.version !== '1.1') throw new Error(`${rootUrl}: unexpected 3D Tiles version ${tileset.asset?.version}`);
  const selected: SelectedTile[] = [];
  const walk = async (tile: Tile, base: string, parent: readonly number[]): Promise<void> => {
    const region = tile.boundingVolume?.region;
    if (!region || region.length < 4) throw new Error(`${base}: only region bounding volumes are expected in this tileset`);
    const [west, south, east, north] = region as [number, number, number, number];
    if (east < box.west || west > box.east || north < box.south || south > box.north) return;
    const transform = tile.transform ? multiply4(parent, tile.transform) : parent;
    const uri = tile.content?.uri ?? tile.content?.url;
    const children = tile.children ?? [];
    if (uri) {
      const url = new URL(uri, base).href;
      if (url.split('?')[0]!.endsWith('.json')) {
        await walk(asTileset(await fetchJson(url), url).root, url, transform);
        return;
      }
      const geometricError = tile.geometricError ?? Infinity;
      if (geometricError <= maxGeometricError || children.length === 0) {
        selected.push({ url, transform: [...transform], geometricError, region: [...region] });
        return;
      }
    }
    await Promise.all(children.map(child => walk(child, base, transform)));
  };
  await walk(tileset.root, rootUrl, IDENTITY);
  return selected.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}
