// Dev/test adapter exposed as window.__HELSINKI_GAME__ for the Playwright harnesses (tools/verify). Everything here
// is read-only inspection or scripted input; it never bypasses the simulation.
import { COLLISION_RESIDENCY, type Command, type EncodedCommand, type GameEvent, type SimState } from '@helsinki/sim';
import type { Game } from './game.ts';
import type { GameConfig, Lighting } from './config.ts';
import type { GpuClass } from './device.ts';
import type { QualityTier } from './render/quality-tiers.ts';
import type { KTX2LoaderWorkerConfig } from 'three/addons/loaders/KTX2Loader.js';
import * as THREE from 'three';
import { inspectCharacter, type CharacterPoseSnapshot } from './render/character-inspection.ts';
import type { CellStreamStats } from './world/cell-streaming.ts';
import type { CollisionStreamStats } from './world/collision-stream.ts';
import type { ShootingEffectsSnapshot } from './render/effects.ts';
import { inspectTextureOwnership, type TextureOwnershipSnapshot } from './review/texture-ownership.ts';

export interface PresentationSnapshot {
  frameTime: number;
  tick: number;
  alpha: number;
  time: number;
  player: { position: number[]; yaw: number; visible: boolean };
  vehicles: { id: string; position: number[]; rotation: number[] }[];
  camera: { position: number[]; quaternion: number[]; direction: number[]; viewProjection: number[] };
  muzzle: { position: number[]; direction: number[]; screen: number[] } | null;
  aimTarget: { position: number[]; screen: number[] } | null;
  shots: { origin: number[]; end: number[]; screenOrigin: number[]; screenEnd: number[] }[];
}

export interface HelsinkiTestApi {
  readonly version: 2;
  readonly release: string;
  ready: boolean;
  state(): SimState;
  tick(): number;
  /** `fps` and `frameIntervalMs` come from the real presentation interval; `frameMs` is the CPU part of a frame. */
  stats(): { fps: number; frameMs: number; frameIntervalMs: number; drawCalls: number; triangles: number; textures: number; geometries: number; cells: number; tick: number;
    resolutionScale: number; tier: QualityTier; gpuClass: GpuClass };
  /** Session configuration relevant to quality: the preset and where it came from, the GPU estimate, adaptation. */
  config(): { preset: GameConfig['preset']; presetSource: GameConfig['presetSource']; tier: QualityTier; startTier: QualityTier;
    rememberedTier: GameConfig['rememberedTier']; gpuClass: GpuClass; renderer: string | null; dynamicResolution: boolean; mobile: boolean;
    /** The mip drop applied to textures loaded from now on, and the `?mipdrop` override (null: none). */
    mipDrop: 0 | 1; mipDropOverride: GameConfig['mipDrop'];
    /** The resolution governor's configured floor (the scale it never goes below). */
    resolutionFloor: number };
  /** Compressed formats the KTX2 transcoder may target this session. */
  transcode(): KTX2LoaderWorkerConfig;
  /** Read-only transforms from the actual displayed frame; useful for frame pacing and reticle checks. */
  presentation(): PresentationSnapshot;
  /** Read-only car-local joint/skin measurements of the displayed driver, evaluated only when requested. */
  vehiclePose(): { visible: boolean; vehicleId: string; bones: Record<string, number[]>; bounds: { min: number[]; max: number[] }; doors: Record<string, number[]> } | null;
  characterPose(id: string): CharacterPoseSnapshot | null;
  /** Read-only state of the pooled muzzle lights and tracers from real simulation shots. */
  shootingEffects(): ShootingEffectsSnapshot;
  events(sinceTick?: number): GameEvent[];
  /** Hold a command (merged over neutral) until cleared; the real input is ignored meanwhile. */
  setCommand(c: Partial<Command> | null): void;
  /**
   * Advance n ticks immediately with the held (or given) command and render once. Returns a promise instead when a
   * tick has to wait for streamed collision to download.
   */
  step(n: number, c?: Partial<Command>): SimState | Promise<SimState>;
  pause(): void;
  resume(): void;
  render(): void;
  /** Completes synchronously unless the destination's streamed collision must be downloaded first. */
  teleport(x: number, z: number, headingDeg?: number): void | Promise<void>;
  dropIn(label: string): void | Promise<void>;
  camera(): { yaw: number; pitch: number };
  setCamera(yaw: number, pitch: number): void;
  setLighting(l: Lighting): void;
  /**
   * GPU texture bytes of every texture in the scene (transcoded mip data, or RGBA8 with mips for images); `byClass`
   * splits them by KTX2 supercompression (`other`: untagged or uncompressed KTX2) and image textures.
   */
  textureMemory(): TextureMemory;
  /** Uploaded compressed formats (WebGL format constant to texture count) and the number of image textures. */
  textureFormats(): TextureFormats;
  /** Unique material types of the resident city: detail cells, coarse cells and instanced scenery. */
  cityMaterials(): CityMaterials;
  /** Review-only live material/palette/uniform ownership, deduplicated by actual renderer allocation. */
  textureOwnership(): TextureOwnershipSnapshot;
  streaming(): { detail: CellStreamStats; fallback: CellStreamStats; scenery: { residentCells: number; residentInstances: number; totalInstances: number };
    coverage: { blocked: boolean; blockedFrames: number; blockedSeconds: number; missingCells: string[] };
    persistentTextureMiB: number; totalTextureBudgetMiB: number } | null;
  /** Sorted ids of the cells resident in the detail and fallback streams (null without streaming). */
  residentCells(): { detail: string[]; fallback: string[] } | null;
  awaitVisuals(): Promise<void>;
  /** Collision residency: the rules a recording replays under (null: every cell resident), resident cells and bytes. */
  collision(): { residency: string | null; resident: number; blocked: boolean; blockedFrames: number; blockedSeconds: number; missingCells: string[]; stream: CollisionStreamStats | null };
  /** Officer and patrol models load after startup; ticks wait while police near the player have none. */
  deferredModels(): { blocked: boolean; blockedFrames: number; blockedSeconds: number; failed: boolean; ready: boolean };
  renderBreakdown(): { triangles: number; drawCalls: number; groups: { id: string; triangles: number; drawCalls: number }[] };
  start(): void;
  hash(): string;
  /** Encoded command per tick since the session began, for offline replay. */
  commands(): EncodedCommand[];
  seed(): number;
  /** Per-tick state digests (review builds only). */
  trace(): string[];
  /** Fresh simulation with the same seed, no page reload. */
  reset(): void;
}

declare global {
  interface Window { __HELSINKI_GAME__?: HelsinkiTestApi; __HELSINKI_ERROR__?: string }
}

export function installTestApi(game: Game, onStart: () => void): HelsinkiTestApi {
  const api: HelsinkiTestApi = {
    version: 2,
    release: game.data.release,
    ready: true,
    state: () => game.state,
    tick: () => game.sim.tick,
    stats: () => ({ ...game.stats, cells: game.scene.cells.size, resolutionScale: game.scene.resolutionScale, gpuClass: game.config.gpuClass ?? 'unknown' }),
    config: () => ({ preset: game.config.preset, presetSource: game.config.presetSource, tier: game.stats.tier, startTier: game.config.startTier,
      rememberedTier: game.config.rememberedTier, gpuClass: game.config.gpuClass ?? 'unknown',
      renderer: game.config.renderer ?? null, dynamicResolution: game.config.dynamicResolution, mobile: game.config.mobile === true,
      mipDrop: game.loader.mipDrop, mipDropOverride: game.config.mipDrop, resolutionFloor: game.scene.resolutionFloor }),
    transcode: () => game.loader.transcodeConfig(),
    presentation: () => presentation(game),
    vehiclePose: () => vehiclePose(game),
    characterPose: id => {
      const view = id === 'player' ? game.playerView : game.characterViews.get(id);
      return view ? inspectCharacter(view, game.scene.camera) : null;
    },
    shootingEffects: () => game.effects.snapshot(),
    events: (sinceTick = 0) => game.eventLog.filter(e => e.tick > sinceTick),
    setCommand: c => game.setScripted(c),
    step: (n, c) => {
      if (c) game.setScripted(c);
      const finish = (): SimState => { game.syncViews(n / 60); game.render(); return game.state; };
      let left = n - game.stepTicks(n);
      if (left === 0) return finish();
      return (async () => {
        while (left > 0) { await game.collisionLoaded(); await game.actorModelsLoaded(); left -= game.stepTicks(left); }
        return finish();
      })();
    },
    pause: () => { game.paused = true; },
    resume: () => { game.paused = false; },
    render: () => { game.syncViews(0); game.render(); },
    teleport: (x, z, h = 0) => game.teleport(x, z, h),
    dropIn: label => game.dropIn(label),
    camera: () => ({ yaw: game.cameraRig.yaw, pitch: game.cameraRig.pitch }),
    setCamera: (yaw, pitch) => { game.cameraRig.yaw = yaw; game.cameraRig.pitch = pitch; },
    setLighting: l => game.setLighting(l),
    textureMemory: () => textureMemory(game.scene.scene),
    textureFormats: () => textureFormats(game.scene.scene),
    cityMaterials: () => cityMaterials([...game.scene.cells.values()].map(cell => cell.group), [...game.scene.fallbackCells.values()].map(cell => cell.group),
      game.scene.scene.getObjectByName('scenery') ?? null),
    textureOwnership: () => inspectTextureOwnership(game.scene.scene, game.scene.renderer.properties, game.scene.renderer.info.memory.textures),
    streaming: () => game.streaming ? { detail: game.streaming.detail.stats(), fallback: game.streaming.fallback.stats(), scenery: game.scene.sceneryStats(),
      coverage: { ...game.visualLoading, missingCells: game.missingVisualCells() },
      persistentTextureMiB: game.streaming.persistentTextureBytes / 2 ** 20, totalTextureBudgetMiB: game.streaming.totalTextureBudgetBytes / 2 ** 20 } : null,
    residentCells: () => game.streaming ? { detail: game.streaming.detail.residentIds().sort(), fallback: game.streaming.fallback.residentIds().sort() } : null,
    awaitVisuals: () => game.awaitVisuals(),
    collision: () => ({ residency: game.world.streamed ? COLLISION_RESIDENCY : null, resident: game.world.residentCells().length,
      blocked: game.collisionLoading.blocked, blockedFrames: game.collisionLoading.blockedFrames, blockedSeconds: game.collisionLoading.blockedSeconds,
      missingCells: game.collisionLoading.missingCells.slice(), stream: game.collision?.stats() ?? null }),
    deferredModels: () => ({ ...game.modelLoading, ready: game.actorModelsReady() }),
    renderBreakdown: () => renderBreakdown(game),
    start: onStart,
    hash: () => game.sim.hash(),
    commands: () => game.commandLog.slice(),
    seed: () => game.config.seed,
    trace: () => game.traceLog.slice(),
    reset: () => game.resetSimulation(),
  };
  window.__HELSINKI_GAME__ = api;
  return api;
}

/** Count actual submitted primitives, including instancing and double-sided passes, on one inspected frame. */
function renderBreakdown(game: Game): ReturnType<HelsinkiTestApi['renderBreakdown']> {
  const roots = new Map<THREE.Object3D, string>();
  for (const [id, cell] of game.scene.cells) roots.set(cell.group, `detail:${id}`);
  for (const [id, cell] of game.scene.fallbackCells) roots.set(cell.group, `coarse:${id}`);
  for (const node of game.scene.scene.getObjectByName('scenery')?.children ?? []) roots.set(node, node.name);
  roots.set(game.playerView.root, 'player');
  for (const [id, view] of game.characterViews) roots.set(view.root, `character:${id}`);
  for (const [id, view] of game.vehicleViews) roots.set(view.root, `vehicle:${id}`);
  const groups = new Map<string, { id: string; triangles: number; drawCalls: number }>();
  const restore: (() => void)[] = [];
  game.scene.scene.traverse(node => {
    if (!(node as THREE.Mesh).isMesh) return;
    let owner: THREE.Object3D | null = node;
    while (owner && !roots.has(owner)) owner = owner.parent;
    const id = owner ? roots.get(owner)! : 'other';
    const before = node.onBeforeRender, after = node.onAfterRender;
    let triangles = 0, calls = 0;
    node.onBeforeRender = (...args) => {
      before.apply(node, args);
      triangles = game.scene.renderer.info.render.triangles;
      calls = game.scene.renderer.info.render.calls;
    };
    node.onAfterRender = (...args) => {
      const entry = groups.get(id) ?? { id, triangles: 0, drawCalls: 0 };
      entry.triangles += game.scene.renderer.info.render.triangles - triangles;
      entry.drawCalls += game.scene.renderer.info.render.calls - calls;
      groups.set(id, entry);
      after.apply(node, args);
    };
    restore.push(() => { node.onBeforeRender = before; node.onAfterRender = after; });
  });
  try {
    game.render();
    return { triangles: game.stats.triangles, drawCalls: game.stats.drawCalls, groups: [...groups.values()].sort((a, b) => b.triangles - a.triangles) };
  } finally { for (const reset of restore) reset(); }
}

function vehiclePose(game: Game): ReturnType<HelsinkiTestApi['vehiclePose']> {
  const interaction = game.presentationState.player.vehicleInteraction;
  const car = interaction ? game.vehicleViews.get(interaction.vehicleId) : null;
  if (!car || !interaction) return null;
  car.root.updateWorldMatrix(true, true);
  game.playerView.root.updateWorldMatrix(true, true);
  const inverse = car.root.matrixWorld.clone().invert();
  const bones: Record<string, number[]> = {}, doors: Record<string, number[]> = {};
  const point = new THREE.Vector3(), bounds = new THREE.Box3();
  game.playerView.model.traverse(node => {
    if ((node as THREE.Bone).isBone) bones[node.name] = node.getWorldPosition(point).applyMatrix4(inverse).toArray();
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.visible) return;
    mesh.skeleton.update();
    const count = mesh.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      bounds.expandByPoint(point);
    }
  });
  for (const door of car.doors) doors[door.node.name] = door.node.quaternion.toArray();
  return { visible: game.playerView.root.visible, vehicleId: interaction.vehicleId, bones, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, doors };
}

function presentation(game: Game): PresentationSnapshot {
  const camera = game.scene.camera;
  const position = new THREE.Vector3();
  let muzzle: PresentationSnapshot['muzzle'] = null;
  const direction = new THREE.Vector3();
  if (game.playerView.muzzlePose(position, direction)) {
    muzzle = { position: position.toArray(), direction: direction.toArray(), screen: position.clone().project(camera).toArray() };
  }
  return {
    frameTime: game.presentationFrameTime, tick: game.state.tick, alpha: game.presentationAlpha, time: game.presentationState.time,
    player: { position: game.playerView.root.position.toArray(), yaw: game.playerView.root.rotation.y, visible: game.playerView.root.visible },
    vehicles: [...game.vehicleViews].map(([id, view]) => ({ id, position: view.root.position.toArray(), rotation: view.root.quaternion.toArray() })),
    camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), direction: camera.getWorldDirection(new THREE.Vector3()).toArray(), viewProjection: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray() },
    muzzle,
    aimTarget: game.presentationAimTarget ? { position: game.presentationAimTarget.toArray(), screen: game.presentationAimTarget.clone().project(camera).toArray() } : null,
    shots: game.state.shots.filter(s => s.shooter === 'player').map(s => ({ origin: [...s.origin], end: [...s.end], screenOrigin: new THREE.Vector3(...s.origin).project(camera).toArray(), screenEnd: new THREE.Vector3(...s.end).project(camera).toArray() })),
  };
}

type TextureLike = {
  isTexture: true; isCompressedTexture?: boolean; format: number; generateMipmaps: boolean; userData?: { ktx2?: { supercompression?: string } };
  mipmaps?: { data: ArrayBufferView; width: number; height: number }[]; image?: { width?: number; height?: number } | null;
};

export interface TextureMemory {
  textures: number; mib: number; duplicateMiB: number;
  byClass: { zstd: number; basislz: number; image: number; other: number };
}
export interface TextureFormats { compressed: Record<number, number>; image: number }
export interface CityMaterials { detail: Record<string, number>; coarse: Record<string, number>; scenery: Record<string, number> }

/** Unique materials below each set of roots, counted by `material.type`. */
export function cityMaterials(detail: readonly THREE.Object3D[], coarse: readonly THREE.Object3D[], scenery: THREE.Object3D | null): CityMaterials {
  const census = (roots: readonly THREE.Object3D[]): Record<string, number> => {
    const materials = new Set<THREE.Material>();
    for (const root of roots) root.traverse(o => {
      const material = (o as THREE.Mesh).material;
      if (material) for (const m of Array.isArray(material) ? material : [material]) materials.add(m);
    });
    const types: Record<string, number> = {};
    for (const m of materials) types[m.type] = (types[m.type] ?? 0) + 1;
    return types;
  };
  return { detail: census(detail), coarse: census(coarse), scenery: census(scenery ? [scenery] : []) };
}

/** Unique textures reachable from the materials below `root`. */
function sceneTextures(root: THREE.Object3D): Set<TextureLike> {
  const textures = new Set<TextureLike>();
  root.traverse(o => {
    const material = (o as unknown as { material?: object | object[] }).material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const v of Object.values(m)) if (v && (v as TextureLike).isTexture) textures.add(v as TextureLike);
    }
  });
  return textures;
}

/**
 * The KTX2 loader tag decides the class whatever the GPU representation (a raw KTX2 container parses to a DataTexture);
 * untagged textures are images unless compressed.
 */
function textureClass(t: TextureLike): keyof TextureMemory['byClass'] {
  const tag = t.userData?.ktx2;
  if (tag) return tag.supercompression === 'zstd' || tag.supercompression === 'basislz' ? tag.supercompression : 'other';
  return t.isCompressedTexture ? 'other' : 'image';
}

/** Unique textures reachable from scene materials; byte-identical compressed payloads are reported as duplicates. */
export function textureMemory(root: THREE.Object3D): TextureMemory {
  const textures = sceneTextures(root);
  let bytes = 0;
  let duplicate = 0;
  const byClass = { zstd: 0, basislz: 0, image: 0, other: 0 };
  const contents = new Set<string>();
  for (const t of textures) {
    const mips = t.isCompressedTexture ? t.mipmaps ?? [] : [];
    if (mips.length) {
      const b = mips.reduce((a, m) => a + m.data.byteLength, 0);
      const d = new Uint8Array(mips[0]!.data.buffer, mips[0]!.data.byteOffset, mips[0]!.data.byteLength);
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 61) h = Math.imul(h ^ d[i]!, 16777619);
      const key = `${t.format}:${mips[0]!.width}x${mips[0]!.height}:${b}:${h >>> 0}`;
      if (contents.has(key)) duplicate += b; else contents.add(key);
      bytes += b;
      byClass[textureClass(t)] += b;
    } else {
      const b = (t.image?.width ?? 0) * (t.image?.height ?? 0) * 4 * (t.generateMipmaps ? 4 / 3 : 1);
      bytes += b;
      byClass[textureClass(t)] += b;
    }
  }
  const mib = (value: number) => value / 2 ** 20;
  return { textures: textures.size, mib: mib(bytes), duplicateMiB: mib(duplicate),
    byClass: { zstd: mib(byClass.zstd), basislz: mib(byClass.basislz), image: mib(byClass.image), other: mib(byClass.other) } };
}

/** Histogram of the textures `textureMemory` visits: compressed ones by WebGL format constant, the rest as images. */
export function textureFormats(root: THREE.Object3D): TextureFormats {
  const compressed: Record<number, number> = {};
  let image = 0;
  for (const t of sceneTextures(root)) {
    if (t.isCompressedTexture && t.mipmaps?.length) compressed[t.format] = (compressed[t.format] ?? 0) + 1;
    else image++;
  }
  return { compressed, image };
}
