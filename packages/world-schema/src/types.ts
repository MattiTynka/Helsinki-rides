// Interfaces to stabilise early (plan section 15): WorldManifest, CellDescriptor, BuildingRecord, RoadGraph,
// GroundQuery, Entity, WantedState, GameEvent, Save. Everything here is plain JSON-serialisable data; the sim and
// the renderer share these types but never share objects.
import type { Vec2, Vec3 } from './coordinates.ts';

export interface FileRef {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Storage encoding for simulation bytes. Digests/bytes on FileRef always identify the stored file. */
export interface SimulationFileRef extends FileRef {
  readonly compression?: 'gzip';
  /** Required with compression; decoding must reproduce these original simulation bytes exactly. */
  readonly decodedBytes?: number;
  readonly decodedSha256?: string;
}

/** A shared KTX2 texture without its top mip level; every remaining level is byte-identical to `source`'s. */
export interface ReducedTextureRef extends FileRef {
  readonly source: string;
}

export interface SourceRecord {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly license: string;
  readonly attribution: string;
  readonly retrievedAt?: string;
  readonly snapshot?: string;
  readonly sha256?: string;
}

export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched';
export type ColliderKind = 'prism' | 'citymodel' | 'none';
export type TextureStatus = 'textured' | 'flat-colour' | 'photo-bake';

export interface BuildingRecord {
  /** LoD2 feature id (the stream's `id`, e.g. BID_...). */
  readonly id: string;
  readonly registerId: string | null;
  readonly vtj: string | null;
  readonly address: string | null;
  readonly storeys: number | null;
  readonly match: MatchStatus;
  readonly matchOffsetMeters: number | null;
  readonly collider: ColliderKind;
  readonly texture: TextureStatus;
  readonly triangles: number;
  /** Runtime-frame bounds. */
  readonly boundsRuntime: { readonly min: Vec3; readonly max: Vec3 };
  readonly cell: string;
  readonly landmark: string | null;
}

export interface VisualLod extends FileRef {
  readonly triangles: number;
  readonly drawCalls: number;
  readonly atlases: number;
  readonly textureBytesEstimate: number;
}

export interface CellDescriptor {
  readonly id: string;
  readonly cx: number;
  readonly cz: number;
  /** Runtime XZ bounds [x0, z0, x1, z1], half-open. */
  readonly boundsXZ: [number, number, number, number];
  readonly visual: { readonly lod0: VisualLod; readonly lod1?: VisualLod; readonly lod2?: VisualLod };
  readonly collision: SimulationFileRef & {
    readonly triangles: number;
    /** XZ extent [x0, z0, x1, z1] of every collider in the bundle; a building can reach far past `boundsXZ`. */
    readonly boundsXZ?: readonly [number, number, number, number];
  };
  readonly buildingIds: readonly string[];
  readonly buildings: readonly BuildingRecord[];
  readonly sourceTiles: readonly string[];
}

export interface WorldManifest {
  readonly schemaVersion: 2;
  readonly worldReleaseId: string;
  readonly status: 'PILOT' | 'PROOF';
  readonly builtAt: string;
  readonly coordinateFrame: {
    readonly crs: 'EPSG:3879';
    readonly heightDatum: 'N2000';
    readonly runtimeAxes: 'X-east,Y-up,Z-south';
    readonly units: 'meter';
  };
  readonly origin: { readonly id: string; readonly originProjected: Vec3 };
  readonly cellSize: number;
  readonly boundsRuntimeXZ: [number, number, number, number];
  readonly cells: readonly CellDescriptor[];
  readonly terrain: SimulationFileRef & { readonly x0: number; readonly z0: number; readonly resolution: number; readonly nx: number; readonly nz: number };
  readonly roads: SimulationFileRef;
  readonly gameplay: FileRef;
  readonly assets: readonly (FileRef & {
    readonly id: string; readonly kind: 'character' | 'vehicle' | 'prop' | 'scenery';
    /** Exact decoded accessor/animation preservation, proved by the offline actor compressor. */
    readonly optimization?: { readonly lossless: true; readonly sourceSha256: string; readonly semanticSha256: string };
  })[];
  /** Content-addressed images referenced by cell GLBs; loaded only when a cell needs them. */
  readonly sharedTextures?: readonly FileRef[];
  /** Low-preset copies of large shared KTX2 textures at half resolution, used in place of their `source`. */
  readonly sharedTexturesM1?: readonly ReducedTextureRef[];
  /** Instanced scenery (trees; decision 0006): a SceneryDocument whose instances name nodes of `scenery` assets. */
  readonly scenery?: FileRef;
  readonly simulation: { readonly engine: string; readonly version: string; readonly tickHz: number };
  readonly sources: readonly SourceRecord[];
  readonly attribution: readonly string[];
  readonly lighting: 'unlit-facades' | 'lit-facades';
}

// ---- instanced scenery ----

export interface SceneryInstance {
  readonly id: string;
  /** A `scenery` asset id in the manifest, and the name of one of its nodes. */
  readonly asset: string;
  readonly node: string;
  /** Runtime frame; the node's origin (a trunk base) goes here. */
  readonly position: Vec3;
  /** About +Y, radians. */
  readonly yaw: number;
  readonly scale: Vec3;
}

export interface SceneryDocument {
  readonly schemaVersion: 1;
  readonly originId: string;
  readonly frame: string;
  /** The asset builds the instances were sized for. */
  readonly assets: readonly { readonly id: string; readonly sha256: string }[];
  readonly instances: readonly SceneryInstance[];
}

// ---- road graph ----

export type RoadNodeKind = 'junction' | 'joint' | 'boundary' | 'end';

export interface RoadNode {
  readonly id: string;
  readonly position: Vec3;
  readonly kind: RoadNodeKind;
}

export interface RoadLane {
  readonly id: string;
  readonly wayId: number;
  readonly name: string | null;
  readonly highway: string;
  readonly surface: string;
  /** metres per second */
  readonly speedLimit: number;
  readonly width: number;
  readonly from: string;
  readonly to: string;
  /** Runtime-frame polyline from `from` to `to`. */
  readonly points: readonly Vec3[];
  readonly length: number;
  /** Lane index from the centre line (0 = nearest the centre) and the lane count in this direction. */
  readonly index: number;
  readonly count: number;
}

export interface RoadConnector {
  readonly id: string;
  readonly node: string;
  readonly from: string;
  readonly to: string;
  readonly turn: 'left' | 'straight' | 'right' | 'u-turn';
  readonly points: readonly Vec3[];
  readonly length: number;
}

export interface RoadGraph {
  readonly schemaVersion: 2;
  readonly originId: string;
  readonly source: { readonly id: string; readonly sha256: string; readonly attribution: string; readonly license: string };
  readonly nodes: readonly RoadNode[];
  readonly lanes: readonly RoadLane[];
  readonly connectors: readonly RoadConnector[];
  /** Parking lanes and areas where parked cars may spawn (runtime frame polylines / polygons). */
  readonly parking: readonly { readonly id: string; readonly kind: 'lane' | 'area'; readonly points: readonly Vec3[]; readonly heading: number | null }[];
  /** Footway polylines for later pedestrian work (M3); kept so the minimap can draw them. */
  readonly footways: readonly { readonly id: string; readonly points: readonly Vec3[] }[];
}

// ---- gameplay content (baked from content/helsinki) ----

export interface WheelDefinition {
  readonly socket: string;
  /** Asset-local position (+X left, +Y up, +Z forward). */
  readonly position: Vec3;
  readonly steer: boolean;
  readonly drive: boolean;
  readonly handbrake: boolean;
}

/** Car-local (+X driver's side, +Y up, +Z forward); the passenger side mirrors X. */
export interface VehicleInteractionDefinition {
  /** Snow's clip set for this cabin: `content/assets/snow-vehicle-poses-<poses>.json`. */
  readonly poses: string;
  /** Feet where the driver entry starts and the driver exit ends. */
  readonly stage: Vec3;
  /** Feet in front of the car after the windshield exit. */
  readonly windshieldStage: Vec3;
  /** Car on its roof: X and Z where Snow stands after crawling out of the driver's door. */
  readonly flippedStage: Vec2;
  /** Upper points the driver's door and Snow sweep on the way out; each must be clear. */
  readonly doorSweep: readonly Vec3[];
  /** Points over the bonnet the windshield exit slides along. */
  readonly bonnetPath: readonly Vec3[];
}

export interface VehicleDefinition {
  readonly id: string;
  readonly label: string;
  readonly assetId: string;
  readonly role: 'civilian' | 'patrol' | 'tactical';
  readonly massKg: number;
  readonly centreOfMass: Vec3;
  /** Chassis box (asset frame). `skid` is an optional lower box kept within the wheelbase so the body box can sit
   *  high enough that its front edge clears kerbs and ramps the wheels are climbing. */
  readonly collider: { readonly halfExtents: Vec3; readonly centre: Vec3; readonly skid?: { readonly halfExtents: Vec3; readonly centre: Vec3 } };
  readonly wheelRadius: number;
  readonly wheelWidth: number;
  readonly wheels: readonly WheelDefinition[];
  readonly suspension: { readonly restLength: number; readonly stiffness: number; readonly damping: number; readonly compression: number; readonly maxTravel: number };
  readonly tyres: { readonly frictionSlip: number; readonly sideFriction: number };
  readonly engine: { readonly maxForceN: number; readonly reverseForceN: number; readonly topSpeedMs: number; readonly topSpeedReverseMs: number };
  readonly brakes: { readonly forceN: number; readonly handbrakeN: number };
  readonly steering: { readonly maxAngleDeg: number; readonly highSpeedAngleDeg: number; readonly rateDegPerS: number };
  readonly aero: { readonly dragCoefficient: number; readonly downforce: number };
  readonly seat: { readonly driver: Vec3; readonly exits: readonly Vec3[]; readonly entryRadius: number };
  /** Snow's ways in and out fitted to this car's cabin; absent, the car uses the Lumi GT's. */
  readonly interaction?: VehicleInteractionDefinition;
  readonly cameraChase: Vec3;
  readonly health: number;
  readonly damage: { readonly smokeBelow: number; readonly fireBelow: number; readonly explodeAfterSeconds: number };
}

export interface VehicleSpawn {
  readonly id: string;
  readonly definition: string;
  readonly position: Vec2;
  readonly headingDeg: number;
  readonly occupied: boolean;
}

export interface Anchor {
  readonly id: string;
  readonly kind: 'hospital' | 'police';
  readonly label: string;
  readonly placeholder: boolean;
  /** Name of the real destination shown on the Wasted / Busted screen. */
  readonly destinationName: string;
  readonly position: Vec2;
  readonly headingDeg: number;
}

export interface WeaponDefinition {
  readonly id: string;
  readonly label: string;
  readonly damage: number;
  readonly headshotMultiplier: number;
  readonly rangeMeters: number;
  readonly spreadDeg: number;
  readonly recoilDeg: number;
  readonly roundsPerMinute: number;
  readonly magazine: number;
  readonly reloadSeconds: number;
  readonly automatic: boolean;
}

export interface WantedTuning {
  readonly starWeights: Readonly<Record<string, number>>;
  readonly starThresholds: readonly number[];
  readonly decaySeconds: readonly number[];
  readonly unitCaps: readonly number[];
  readonly witnessReportSeconds: [number, number];
  readonly arrest: { readonly footRadius: number; readonly footSeconds: number; readonly boxedSeconds: number };
  readonly searchRadius: number;
}

export interface AddressEntry {
  readonly label: string;
  readonly position: Vec2;
  readonly headingDeg: number;
}

export interface GameplayBundle {
  /** Optional population; only appearances whose character assets ship in this immutable world. */
  readonly civilianVariants?: readonly ('rain-black' | 'rain-white' | 'snow-black' | 'agent47')[];
  readonly schemaVersion: 2;
  readonly originId: string;
  readonly killHeight: number;
  readonly playArea: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
  /** Qualified XZ coverage, independent of collider/height/layer validity. Absent in legacy worlds. */
  readonly supportedArea?: SupportedArea;
  readonly player: { readonly spawn: { readonly position: Vec2; readonly headingDeg: number }; readonly health: number; readonly armour: number };
  readonly vehicleDefinitions: readonly VehicleDefinition[];
  readonly vehicles: readonly VehicleSpawn[];
  readonly anchors: readonly Anchor[];
  readonly weapons: readonly WeaponDefinition[];
  readonly wanted: WantedTuning;
  readonly police: { readonly spawnMinDistance: number; readonly initialPatrols: number; readonly patrolSpawns: readonly { readonly position: Vec2; readonly headingDeg: number }[] };
  readonly addresses: readonly AddressEntry[];
  readonly landmarks: readonly AddressEntry[];
  readonly district: { readonly name: string; readonly boundary: readonly Vec2[] };
  readonly playerStart: { readonly weapons: readonly { readonly id: string; readonly reserve: number }[] };
}

export interface SupportedArea {
  readonly schemaVersion: 1;
  /** Normalized disjoint components. Rings close implicitly; adjacent regions must be merged. */
  readonly regions: readonly { readonly id: string; readonly outer: readonly Vec2[]; readonly holes?: readonly (readonly Vec2[])[] }[];
}

// ---- events and saves ----

export interface GameEvent {
  readonly tick: number;
  readonly type: string;
  readonly detail?: string;
  readonly value?: number;
}

export interface SaveRecord {
  readonly format: 'helsinki-save';
  readonly version: 1;
  readonly savedAt: string;
  readonly money: number;
  readonly preferences: { readonly chaseNear: boolean };
}
