// Shared shapes of the live city cells (docs/live-kartta-cells-plan-2026-10-30.md). A live cell is a 128 m grid square
// the release manifest lacks (LiveGrid in @helsinki/sim). A worker builds two payloads per square from the City of
// Helsinki's own 3D map services: HCOL v2 collision bytes (terrain, footprint prisms, water holes) with a ground mesh,
// and building meshes cut from the textured LoD2 3D Tiles. Collision never depends on the visual payload.

/** Only these City of Helsinki endpoints are fetched. Never the 2017 reality mesh (owner rule: LoD2-only buildings). */
export const LIVE_SOURCES = {
  lod2Tileset: 'https://kartta.hel.fi/3d/datasource-data/e5e7158a-52df-45a1-9be0-1be8f2828abd/tileset.json',
  terrainLayer: 'https://kartta.hel.fi/3d/datasource-data/4383570b-33a3-4a9f-ae16-93373aff5ffa/',
  wfs: 'https://kartta.hel.fi/ws/geoserver/avoindata/wfs',
  wms: 'https://kartta.hel.fi/ws/geoserver/avoindata/wms',
  footprints: 'avoindata:Rakennukset_alue_rekisteritiedot',
  streetParts: 'avoindata:YLRE_Katu_ja_viherosat_kaikki_alue',
  /** Rendered by WMS as a transparent PNG mask: the sea polygon is one 6.5 MB WFS feature. */
  water: ['avoindata:Maavesi_merialue', 'avoindata:Maavesi_muut_vesialueet'],
} as const;

/** Terrain zoom level (geographic TMS, quantized-mesh 1.0): about 38 m × 76 m per tile at Helsinki. */
export const LIVE_TERRAIN_ZOOM = 18;
/** Metres between ground lattice points, and points per square side (128 / 2 + 1). */
export const LIVE_GROUND_STEP = 2;
export const LIVE_GROUND_N = 65;
/** Ground quads per side; the water mask has one value per quad. */
export const LIVE_GROUND_QUADS = 64;
/**
 * Id of the HCOL ground collider. Its positions are exactly the N × N lattice in row-major order (iz * N + ix,
 * x = cx * 128 + ix * STEP, z = cz * 128 + iz * STEP), so StaticWorld.groundHeight can sample it directly.
 */
export const LIVE_GROUND_COLLIDER_ID = 'live-ground';

/** EPSG:3879 easting, northing and N2000 height of the runtime origin (manifest `origin.originProjected`). */
export type Origin = readonly [number, number, number];

/** Ground classes from the street and green parts register; also the ground's HCOL surface tags. */
export type LiveSurface = 'road' | 'walk' | 'green' | 'yard';
export const LIVE_SURFACE_TAGS: Readonly<Record<LiveSurface, string>> = {
  road: 'road:asphalt', walk: 'raised:slabs', green: 'raised:grass', yard: 'raised:yard',
};

export interface GeoJsonFeature {
  readonly id?: string | number;
  readonly geometry: { readonly type: 'Polygon'; readonly coordinates: number[][][] } | { readonly type: 'MultiPolygon'; readonly coordinates: number[][][][] } | null;
  readonly properties: Readonly<Record<string, unknown>> | null;
}
export interface GeoJsonFeatureCollection { readonly type: 'FeatureCollection'; readonly features: readonly GeoJsonFeature[] }

/** One decoded quantized-mesh tile and its TMS address. */
export interface TerrainTileAddress { readonly z: number; readonly x: number; readonly y: number }

/** Ground surfaces in HCOL tag order; where register polygons overlap, the lower index wins. */
export const LIVE_SURFACE_ORDER: readonly LiveSurface[] = ['road', 'walk', 'green', 'yard'];
/** Ground quad values (QUADS × QUADS, row-major) besides a LIVE_SURFACE_ORDER index: water, and a hole (no terrain data,
 *  or ground a bridge deck covers). */
export const QUAD_WATER = -2;
export const QUAD_HOLE = -1;

/** Ground mesh of one square, runtime frame. Water and hole quads are in no class. */
export interface LiveGroundVisual {
  /** N × N lattice, row-major as the collider, then bridge deck vertices and their slab edges (base map squares). */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly classes: readonly { readonly surface: LiveSurface; readonly indices: Uint32Array }[];
  /** Flat water quads at sea level (N2000 0 m) where the mask says water; null when the square has none. */
  readonly water: { readonly positions: Float32Array; readonly indices: Uint32Array } | null;
}

export interface CollisionCellInput {
  readonly id: string;
  readonly cx: number;
  readonly cz: number;
  /** Manifest `origin.id`, written into the HCOL header. */
  readonly originId: string;
  readonly origin: Origin;
  /** Runtime Y per lattice point (N2000 height minus origin height); NaN where the terrain has no data. */
  readonly heights: Float32Array;
  /** QUADS × QUADS, row-major iz * QUADS + ix (iz grows southward, +Z); 1 = water. Null: no water layer data. */
  readonly waterMask: Uint8Array | null;
  readonly footprints: GeoJsonFeatureCollection;
  readonly streetParts: GeoJsonFeatureCollection;
  /** Register ids (VTJ_PRT) of buildings the release already has; such footprints are skipped. */
  readonly staticVtj: ReadonlySet<string>;
  /** Squares the release covers; footprints whose centroid lies in one are skipped. */
  readonly isStaticSquare: (cx: number, cz: number) => boolean;
}

/** A building collider: footprint polygons (outer ring, then holes; runtime XZ pairs) extruded from `base` to `top`. */
export interface LivePrism {
  readonly ref: string | null;
  readonly base: number;
  readonly top: number;
  readonly polygons: readonly (readonly (readonly number[])[])[];
}

/**
 * Bridge decks over one square on the ground quad grid. Each bridge is one plane, runtime Y = a + bx · x + bz · z, so
 * squares sharing a bridge compute bit-identical heights on their common edge.
 */
export interface LiveDeck {
  /** [a, bx, bz] per bridge plane. */
  readonly planes: Float64Array;
  /** QUADS × QUADS: 0 for no deck, else the plane index + 1. */
  readonly quads: Uint8Array;
  /** QUADS × QUADS: the LIVE_SURFACE_ORDER index of each deck quad. */
  readonly surfaces: Uint8Array;
}

/**
 * One square of the static base map (hybrid live cells: static ground and bridges, live LoD2 buildings). Everything
 * the square's collision needs, prepared offline by tools/world/build_base_map.ts. 'water' squares are open sea and
 * 'void' squares lie outside the terrain layer; neither has ground.
 */
export interface BaseSquare {
  readonly cx: number;
  readonly cz: number;
  readonly kind: 'land' | 'water' | 'void';
  /** N × N runtime Y in centimetre steps; NaN without terrain data. Null unless land. */
  readonly heights: Float32Array | null;
  /** QUADS × QUADS: QUAD_WATER, QUAD_HOLE or a LIVE_SURFACE_ORDER index. Null unless land. */
  readonly quads: Int8Array | null;
  readonly prisms: readonly LivePrism[];
  readonly deck: LiveDeck | null;
}

export interface CollisionCellOutput {
  readonly hcol: Uint8Array;
  /** Null for a square without ground or water (outside the terrain layer). */
  readonly ground: LiveGroundVisual | null;
  readonly buildings: number;
}

/** A building part of one live square: non-indexed triangles in the runtime frame. */
export interface LiveBuildingPart {
  /** Texture key (`<tile url>#<image index>`) or null for a colour-only material. */
  readonly texture: string | null;
  /** Linear base colour factor (glTF baseColorFactor RGB). */
  readonly color: readonly [number, number, number];
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** glTF UVs unchanged (top-left origin; textures are not flipped). Null for colour-only parts. */
  readonly uvs: Float32Array | null;
}

/** KTX2 (Basis ETC1S) image bytes from a tile, shared by every square that uses them. */
export interface LiveTextureBytes {
  readonly key: string;
  readonly bytes: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  /** This square's triangles using the texture divided by the tile's: its fair share of the texture's GPU bytes. */
  readonly share: number;
}

/** Fixed per visual backend: coarse retains every triangle but omits UVs and texture payloads. */
export type LiveVisualKind = 'detail' | 'coarse';

export interface LiveVisualResult {
  readonly id: string;
  readonly maxGeometricError: number;
  readonly parts: readonly LiveBuildingPart[];
  readonly textures: readonly LiveTextureBytes[];
  readonly triangles: number;
}

export interface LiveCollisionResult {
  readonly id: string;
  /** Decoded HCOL v2 bytes; an empty bundle when the sources stayed unavailable. */
  readonly hcol: Uint8Array;
  readonly ground: LiveGroundVisual | null;
  readonly empty: boolean;
}

export interface LiveCellSourceInit {
  readonly origin: Origin;
  readonly originId: string;
  readonly staticCellIds: readonly string[];
  /** Manifest building ids (`BID_<uuid>`, the LoD2 feature `id`) and register ids, never duplicated live. */
  readonly staticBuildingIds: readonly string[];
  readonly staticVtj: readonly string[];
  /** Directory URL of the release's static base map (`basemap/`); squares it covers build without the network. */
  readonly baseMapUrl?: string | null;
}

export interface LiveSourceStats {
  readonly collisionBuilt: number;
  readonly collisionEmpty: number;
  readonly collisionCached: number;
  readonly visualBuilt: number;
  readonly pending: number;
  readonly requests: number;
  readonly downloadedMiB: number;
  readonly errors: readonly string[];
}

/** Recorded with a review replay: the exact live collision bytes each inserted live cell used (base64). */
export interface LiveRecordingData {
  readonly version: string;
  readonly cells: Readonly<Record<string, string>>;
}
