// The game: fixed-step simulation driven by input commands, views synchronised from the sim state every frame
// (plan section 2 and 15). Nothing in here is simulation logic.
import * as THREE from 'three';
import { CIVILIAN_VARIANTS, civilianVariant, type Shot } from '@helsinki/sim';
import { initPhysics, Simulation, StaticWorld, TICK_SECONDS, NEUTRAL, Button, headingToYaw, encodeCommand, decodeCommand, resolveAimTarget, groundBelowBundle, type Command, type EncodedCommand, type GameEvent, type SimState, type V3 } from '@helsinki/sim';
import { parseCollisionBundle } from '@helsinki/world-schema';
import type { GameConfig, Lighting } from './config.ts';
import { GameAudio } from './audio/audio.ts';
import { Input } from './input/input.ts';
import { AssetLibrary } from './render/assets.ts';
import { ChaseCamera } from './render/camera.ts';
import { CharacterView } from './render/characters.ts';
import { Effects } from './render/effects.ts';
import { CityScene, type CellView } from './render/scene.ts';
import { textureBytesOf } from './render/cell-resources.ts';
import { VehicleView } from './render/vehicles.ts';
import { vehicleDoorOpen, vehiclePoses } from './render/native-vehicle-animation.ts';
import { interpolateState } from './render/interpolation.ts';
import { Hud, type FrameStats } from './ui/hud.ts';
import { GlbLoader, loadWorldData, mark, resolveRelease, type Progress, type WorldData } from './world/loader.ts';
import { CollisionStream } from './world/collision-stream.ts';
import { CellVisualStream, missingVisualCoverage, type StreamFocus } from './world/cell-streaming.ts';
import { i18n } from './i18n/index.ts';
import { FramePacer } from './render/frame-pacing.ts';

const MAX_STEPS_PER_FRAME = 5;
/** Officer and patrol-car models load after startup; patrols begin at least 150 m from the player. */
const DEFERRED_ASSETS = new Set(['character-rain', 'vehicle-patrol', 'vehicle-patrol-far-low', ...CIVILIAN_VARIANTS.map(variant => `character-civilian-${variant}`)]);
/** Police this close to the player can see Finn (90 m) or be shot at (120 m): ticks wait until they have a model. */
const DEFERRED_MODEL_RANGE = 128;
const characterAsset = (id: string): string => {
  const civilian = civilianVariant(id);
  return civilian ? `character-civilian-${civilian}` : id.startsWith('police') ? 'character-rain' : 'character-snow';
};
declare const __CAPTURE_REPLAY__: boolean;

export interface WorldVisualStreaming {
  readonly detail: CellVisualStream<CellView>;
  readonly fallback: CellVisualStream<CellView>;
  persistentTextureBytes: number;
  readonly totalTextureBudgetBytes: number;
  readonly fallbackTextureBudgetBytes: number;
}

function persistentRoots(assets: AssetLibrary): THREE.Object3D[] {
  return [...assets.characters.values()].map(a => a.scene)
    .concat([...assets.vehicles.values()].map(a => a.scene), [...assets.scenery.values()], assets.pistol ? [assets.pistol] : []);
}

export class Game {
  readonly data: WorldData;
  world: StaticWorld;
  sim: Simulation;
  readonly scene: CityScene;
  readonly loader: GlbLoader;
  readonly assets: AssetLibrary;
  readonly streaming: WorldVisualStreaming | null;
  /** Streamed collision bytes; null when every cell was loaded at startup (`?collision=all`). */
  readonly collision: CollisionStream | null;
  readonly cameraRig: ChaseCamera;
  readonly input: Input;
  readonly hud: Hud;
  readonly audio: GameAudio;
  readonly effects = new Effects();
  readonly config: GameConfig;
  readonly characterViews = new Map<string, CharacterView>();
  readonly vehicleViews = new Map<string, VehicleView>();
  readonly playerView: CharacterView;
  readonly shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
  state: SimState;
  private previousState: SimState;
  presentationState: SimState;
  presentationAlpha = 1;
  presentationFrameTime = 0;
  presentationAimTarget: THREE.Vector3 | null = null;
  /** Events of the most recent frame (all ticks stepped in it). */
  frameEvents: GameEvent[] = [];
  readonly eventLog: GameEvent[] = [];
  /** Every command stepped, encoded, so a session can be replayed in Node (plan section 2). */
  readonly commandLog: EncodedCommand[] = [];
  /** Replay history is a review-build capability; ordinary play retains no per-tick diagnostics. */
  readonly captureReplay: boolean;
  /** State digest per tick (review builds), to locate the first tick where a replay diverges. */
  readonly traceLog: string[] = [];
  scripted: Command | null = null;
  paused = false;
  /** Presentation pacing does not alter the fixed simulation timestep or command encoding. */
  targetFrameRate: 30 | 60;
  private framePacer: FramePacer;
  onStateChange: ((state: SimState) => void) | null = null;
  timeScale = 1;
  private accumulator = 0;
  private lastNow = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  readonly stats: FrameStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, textures: 0, geometries: 0, tick: 0 };
  private frameStart = 0;
  private running = false;
  /** Actual shots across every fixed tick, consumed once by presentation (including low-FPS frames). */
  private readonly pendingShots: Shot[] = [];
  private readonly resolveMuzzle = (shooter: string, position: THREE.Vector3, direction: THREE.Vector3): boolean =>
    (shooter === 'player' ? this.playerView : this.characterViews.get(shooter))?.muzzlePose(position, direction) ?? false;
  readonly visualLoading = { blocked: false, blockedFrames: 0, blockedSeconds: 0, missingCells: [] as string[] };
  /** Ticks wait while the next step's collision cells (or a drop-in destination's) are still downloading. */
  readonly collisionLoading = { blocked: false, blockedFrames: 0, blockedSeconds: 0, missingCells: [] as string[], teleporting: false };
  /** Ticks wait while police near the player have no model yet; `failed` while a failed load waits to be retried. */
  readonly modelLoading = { blocked: false, blockedFrames: 0, blockedSeconds: 0, failed: false };
  /** Why the last `stepTicks` stopped early. */
  private stepBlock: 'collision' | 'models' | null = null;

  private constructor(config: GameConfig, data: WorldData, world: StaticWorld, scene: CityScene, loader: GlbLoader, assets: AssetLibrary, canvas: HTMLCanvasElement, streaming: WorldVisualStreaming | null, collision: CollisionStream | null) {
    this.config = config;
    this.targetFrameRate = config.targetFrameRate ?? 60;
    this.framePacer = new FramePacer(config.targetFrameRate ?? 0);
    this.captureReplay = __CAPTURE_REPLAY__;
    this.data = data;
    this.world = world;
    this.scene = scene;
    this.loader = loader;
    this.assets = assets;
    this.streaming = streaming;
    this.collision = collision;
    this.sim = new Simulation(world, { seed: config.seed });
    this.cameraRig = new ChaseCamera(scene.camera);
    this.input = new Input(canvas, config.review);
    this.hud = new Hud(config.hud && !config.review, data.manifest, data.gameplay, data.roads);
    this.hud.onDropIn = label => { void this.dropIn(label)?.catch(error => {
      console.error('Drop-in failed', error);
      this.hud.showNotice('dropin.failed', this.state.time);
    }); };
    this.audio = new GameAudio(config.audio);
    this.scene.scene.add(this.effects.group);
    this.playerView = new CharacterView(assets, 'character-snow', this.shadowMaterial);
    this.scene.scene.add(this.playerView.root);
    this.state = this.sim.state();
    this.previousState = this.state;
    this.presentationState = this.state;
    this.cameraRig.reset(this.sim.player.yaw);
    this.syncViews(0);
  }

  static async create(canvas: HTMLCanvasElement, config: GameConfig, progress: Progress): Promise<Game> {
    const release = await resolveRelease(config.release);
    const assets = new AssetLibrary();
    let scene!: CityScene, loader!: GlbLoader;
    let assetResult: Promise<{ ok: true } | { ok: false; error: unknown }> = Promise.resolve({ ok: true });
    mark('helsinki:create');
    const dataReady = loadWorldData(release, progress, undefined, (manifest, base) => {
      const lighting: Lighting = config.lighting ?? (manifest.lighting === 'unlit-facades' ? 'unlit' : 'lit');
      scene = new CityScene(canvas, config.preset, lighting, config.pixelRatioCap, {
        targetFrameRate: config.targetFrameRate, initialRenderScale: config.initialRenderScale, maxRenderPixels: config.maxRenderPixels,
      });
      loader = new GlbLoader(scene.renderer, { maxConcurrentDecode: config.mobile ? 1 : 2 });
      if (config.preset === 'low') loader.useReducedTextures(manifest);
      // Observe failures immediately, then propagate them at the joined startup boundary.
      assetResult = assets.load(loader, base, manifest, config.preset === 'low', asset => !DEFERRED_ASSETS.has(asset.id), { concurrency: config.mobile ? 1 : 2 }).then(
        () => ({ ok: true as const }), error => ({ ok: false as const, error }));
    }, config.collision);
    const [data] = await Promise.all([dataReady, initPhysics().then(() => mark('helsinki:physics-ready'))]);
    const collision = data.collisionCells ? new CollisionStream(data.base, data.manifest.cells, data.collisionCells, data.collision) : null;
    const world = Game.buildWorld(data, collision);
    const loaded = await assetResult;
    if (!loaded.ok) throw loaded.error;
    mark('helsinki:assets-ready');
    progress(1, 1, 'hero assets');
    const hasFallbacks = data.manifest.cells.every(cell => !!cell.visual.lod2);
    if (data.scenery) scene.addScenery(data.scenery, assets.scenery, data.manifest.cellSize, hasFallbacks);
    let streaming: WorldVisualStreaming | null = null;
    if (hasFallbacks) {
      const persistentTextureBytes = textureBytesOf(persistentRoots(assets));
      const totalTextureBudgetBytes = (config.textureBudgetMb ?? (config.preset === 'low' ? 160 : 320)) * 2 ** 20;
      const fallbackBudget = 4 * 2 ** 20;
      const backend = (lod: 'lod0' | 'lod1' | 'lod2') => ({
        load: (cell: typeof data.manifest.cells[number], signal: AbortSignal) => scene.loadCell(loader, data.base, cell, lod, signal),
        prepare: (_cell: typeof data.manifest.cells[number], view: CellView, signal: AbortSignal) => scene.prepareCell(view, signal),
        show: (_cell: typeof data.manifest.cells[number], view: CellView) => scene.showCell(view),
        dispose: (_cell: typeof data.manifest.cells[number], view: CellView) => scene.disposeCell(view),
      });
      const low = config.preset === 'low';
      const mobile = config.mobile && low;
      const detail = new CellVisualStream(data.manifest.cells, backend(low ? 'lod1' : 'lod0'), {
        textureBudgetBytes: totalTextureBudgetBytes - persistentTextureBytes - fallbackBudget,
        geometryBudgetBytes: (mobile ? 64 : low ? 96 : 160) * 2 ** 20,
        radius: mobile ? 140 : low ? 170 : 230, lookaheadSeconds: 3, maxLookahead: 180, concurrency: mobile ? 1 : 2, maxCells: mobile ? 12 : low ? 16 : 28,
        level: low ? 'lod1' : 'lod0',
      });
      const fallback = new CellVisualStream(data.manifest.cells, backend('lod2'), {
        textureBudgetBytes: fallbackBudget, radius: mobile ? 240 : low ? 300 : 420, lookaheadSeconds: 3, maxLookahead: 180,
        geometryBudgetBytes: (mobile ? 48 : low ? 64 : 96) * 2 ** 20,
        concurrency: mobile ? 1 : 2, level: 'lod2', maxCells: mobile ? 20 : low ? 28 : 42,
      });
      streaming = { detail, fallback, persistentTextureBytes, totalTextureBudgetBytes, fallbackTextureBudgetBytes: fallbackBudget };
      // The fog terminates within the coarse residency ring; outside geometry is not kept hidden in memory.
      scene.scene.fog = new THREE.Fog(0x9fb8d4, mobile ? 130 : low ? 160 : 240, mobile ? 240 : low ? 300 : 420);
      // Fully fogged geometry contributes no visible pixels. Clip it instead of still drawing every
      // parked car and landmark in the expanded world behind the opaque end of the fog.
      scene.camera.far = mobile ? 240 : low ? 300 : 420;
      scene.camera.updateProjectionMatrix();
      const [x, z] = data.gameplay.player.spawn.position;
      const focus = { x, z, velocityX: 0, velocityZ: 0 };
      fallback.update(focus);
      detail.update(focus);
      // Wait for the playable neighbourhood. Outer-ring work continues inside the same budgets.
      await Promise.all([fallback.settleNear(mobile ? 100 : 150), detail.settleNear(mobile ? 72 : 100)]);
      if (fallback.stats().errors.length) throw new Error(`Initial city fallback load failed: ${fallback.stats().errors.join('; ')}`);
      progress(1, 2, 'nearby streets');
      if (detail.stats().errors.length) throw new Error(`Initial city detail load failed: ${detail.stats().errors.join('; ')}`);
      progress(2, 2, 'nearby buildings');
    } else {
      // Historical pilot releases have no independently usable coarse surface. Their fifteen cells fit
      // the original resident budget; an expanded release must supply a complete coarse tier.
      if (data.manifest.cells.length > 20) throw new Error('Expanded worlds require a lod2 fallback for every cell');
      let done = 0;
      for (const cell of data.manifest.cells) {
        await scene.addCell(loader, data.base, cell);
        progress(++done, data.manifest.cells.length, `cell ${cell.id}`);
      }
    }
    mark('helsinki:visuals-ready');
    const game = new Game(config, data, world, scene, loader, assets, canvas, streaming, collision);
    mark('helsinki:playable');
    game.loadDeferredAssets();
    return game;
  }

  /**
   * Officer and patrol models arrive after startup; their textures then come out of the city's texture budget. A failed
   * load is retried after 2, 4, 8, 16 and then every 30 seconds.
   */
  private loadDeferredAssets(attempt = 0): void {
    this.assets.loadDeferred().then(() => {
      this.modelLoading.failed = false;
      mark('helsinki:deferred-assets-ready');
      const streaming = this.streaming;
      if (!streaming) return;
      streaming.persistentTextureBytes = textureBytesOf(persistentRoots(this.assets));
      streaming.detail.setTextureBudget(streaming.totalTextureBudgetBytes - streaming.persistentTextureBytes - streaming.fallbackTextureBudgetBytes);
    }, error => {
      console.error('Police models failed to load; retrying', error);
      this.modelLoading.failed = true;
      setTimeout(() => this.loadDeferredAssets(attempt + 1), 1000 * Math.min(30, 2 ** (attempt + 1)));
    });
  }

  /**
   * Collision world from the release data. Streamed: the simulation inserts cells as it moves, exactly as an offline
   * replay with the same residency rules does. Otherwise every cell in manifest order, so collider handles match.
   */
  static buildWorld(data: WorldData, collision: CollisionStream | null): StaticWorld {
    const world = new StaticWorld(data.terrain, data.roads, data.gameplay);
    if (collision && data.collisionCells) world.enableStreaming(data.collisionCells, id => collision.get(id));
    else for (const c of data.manifest.cells) world.addCell(c.id, data.collision.get(c.id)!);
    return world;
  }

  /** Start a fresh simulation (same seed) without reloading the page or the GPU assets. */
  resetSimulation(seed = this.config.seed): void {
    this.input.reset();
    this.pendingShots.length = 0;
    this.effects.reset();
    for (const v of this.vehicleViews.values()) v.dispose();
    this.vehicleViews.clear();
    for (const c of this.characterViews.values()) c.dispose();
    this.characterViews.clear();
    this.world = Game.buildWorld(this.data, this.collision);
    this.sim = new Simulation(this.world, { seed });
    this.commandLog.length = 0;
    this.traceLog.length = 0;
    this.eventLog.length = 0;
    this.frameEvents = [];
    this.accumulator = 0;
    this.timeScale = 1;
    this.scripted = null;
    this.state = this.sim.state();
    this.previousState = this.state;
    this.presentationState = this.state;
    this.cameraRig.reset(this.sim.player.yaw);
    this.syncViews(0);
    this.onStateChange?.(this.state);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.input.setActive(!paused);
    this.accumulator = 0;
    this.lastNow = performance.now();
    this.framePacer.reset();
  }

  setFrameRate(rate: 30 | 60): void {
    this.targetFrameRate = rate;
    this.framePacer = new FramePacer(rate);
    this.scene.setTargetFrameRate(rate);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      // Input events keep their queues between presentations; a 30 Hz frame steps two 60 Hz commands.
      // Paused production scenes need only occasional refreshes while downloads finish.
      if ((!this.paused || this.config.review || now - this.lastNow >= 250) && this.framePacer.shouldRender(now)) this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    addEventListener('resize', () => this.scene.resize());
  }

  stop(): void { this.running = false; }

  private currentCommand(): Command {
    if (this.scripted) return this.scripted;
    const driving = this.state.player.mode === 'driving' || this.state.player.mode === 'exiting';
    const command = this.input.command(this.cameraRig.yaw, this.cameraRig.pitch, driving);
    return !driving && (command.buttons & (Button.aim | Button.fire)) !== 0 ? { ...command, aimRay: this.cameraRig.aimRay() } : command;
  }

  /**
   * Advance the simulation by whole ticks; returns the ticks stepped, fewer when collision is still downloading or police
   * near the player are still without a model.
   */
  stepTicks(n: number, command?: Command): number {
    this.stepBlock = null;
    for (let i = 0; i < n; i++) {
      if (this.collision && !this.collisionReady()) { this.stepBlock = 'collision'; return i; }
      if (!this.actorModelsReady()) { this.stepBlock = 'models'; return i; }
      // Quantise through the encoding so the browser and a Node replay step bit-identical commands.
      const encoded = encodeCommand(command ?? this.currentCommand());
      if (this.captureReplay) this.commandLog.push(encoded);
      const c = decodeCommand(encoded);
      this.previousState = this.state;
      const events = this.sim.step(c);
      this.state = this.sim.state();
      if (this.previousState.player.mode !== this.state.player.mode || this.previousState.player.alive !== this.state.player.alive
        || events.some(event => event.type === 'respawn' || event.type === 'recover')) this.input?.reset();
      this.onStateChange?.(this.state);
      if (events.some(event => event.type === 'holster')) {
        // A slow frame can include fire -> holster -> redraw. Cancel at the event boundary rather
        // than checking only its final weapon state, so redraw cannot resurrect the old impulse.
        for (let i = this.pendingShots.length - 1; i >= 0; i--) if (this.pendingShots[i]!.shooter === 'player') this.pendingShots.splice(i, 1);
        this.playerView.cancelShot();
        this.effects.cancelShooter('player');
      }
      this.pendingShots.push(...this.state.shots);
      if (this.pendingShots.length > 64) this.pendingShots.splice(0, this.pendingShots.length - 64);
      if (events.some(e => e.type === 'respawn' || e.type === 'recover')) this.previousState = this.state;
      if (this.captureReplay && this.config.review && this.traceLog.length < 20000) this.traceLog.push(this.sim.digest());
      for (const e of events) {
        this.frameEvents.push(e);
        if (this.captureReplay) { this.eventLog.push(e); if (this.eventLog.length > 5000) this.eventLog.shift(); }
      }
      this.handleEvents(events);
    }
    return n;
  }

  /** Whether the next step's collision cells are available; requests the missing ones. */
  collisionReady(): boolean {
    if (!this.collision || this.collisionLoading.teleporting) return !this.collisionLoading.teleporting;
    const missing = this.world.unavailable(this.sim.residencyPlan());
    this.collisionLoading.missingCells = missing;
    if (!missing.length) return true;
    this.collision.request(missing);
    return false;
  }

  /** Resolves when the next step can run (inspection harnesses that step many ticks at once). */
  async collisionLoaded(): Promise<void> {
    while (this.collision && !this.collisionReady()) {
      if (this.collisionLoading.missingCells.length) await this.collision.ensure(this.collisionLoading.missingCells);
      else await new Promise(resolve => setTimeout(resolve, 16));
    }
  }

  /**
   * Whether every police car and officer near the player has its model. Their models load after startup; stepping
   * without them would let unseen police drive into, arrest or shoot at Finn.
   */
  actorModelsReady(): boolean {
    const [px, , pz] = this.sim.playerPosition;
    const near = (p: readonly number[]): boolean => Math.hypot(p[0]! - px, p[2]! - pz) <= DEFERRED_MODEL_RANGE;
    for (const v of this.state.vehicles) {
      const id = this.sim.definition(v.definition).assetId;
      if (DEFERRED_ASSETS.has(id) && !this.assets.hasVehicle(id) && near(v.position)) return false;
    }
    for (const c of this.state.characters) {
      const id = characterAsset(c.id);
      // Seated officers retain their boarding position; their current location follows the vehicle.
      const position = c.inVehicle ? this.state.vehicles.find(v => v.id === c.inVehicle)?.position ?? c.position : c.position;
      if (DEFERRED_ASSETS.has(id) && !this.assets.hasCharacter(id) && near(position)) return false;
    }
    return true;
  }

  /** Resolves when `actorModelsReady` (inspection harnesses); a failed load is retried every second. */
  async actorModelsLoaded(): Promise<void> {
    while (!this.actorModelsReady()) await this.assets.loadDeferred().catch(() => new Promise(resolve => setTimeout(resolve, 1000)));
  }

  private modelsWaitingMessage(): string | null {
    return this.modelLoading.blocked ? i18n.text(this.modelLoading.failed ? 'world.policeFailed' : 'world.police') : null;
  }

  private handleEvents(events: readonly GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'respawn') this.cameraRig.reset(this.sim.player.yaw);
      if (e.type === 'wasted') this.timeScale = 0.3;
      if (e.type === 'respawn' || e.type === 'busted') this.timeScale = 1;
    }
  }

  frame(now: number): void {
    this.frameStart = performance.now();
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    this.frameEvents = [];
    const missingCells = this.missingVisualCells();
    const blocked = missingCells.length > 0;
    this.visualLoading.blocked = blocked;
    this.visualLoading.missingCells = missingCells;
    if (blocked && !this.paused) { this.visualLoading.blockedFrames++; this.visualLoading.blockedSeconds += dt; }
    if (blocked) this.accumulator = 0;
    let stepBlocked = false;
    if (!this.paused && !blocked) {
      // Mouse look.
      const [dx, dy] = this.input.takeLook();
      const [gx, gy] = this.input.gamepadLook(dt);
      if (this.cameraRig.inCar) this.cameraRig.mouseOffsetInCar(dx + gx); else this.cameraRig.look(dx + gx, dy + gy);
      if (this.sim.screen && this.sim.screen.ticks < this.sim.options.screenTicks - 120) this.timeScale = 1;
      this.accumulator += dt * this.timeScale;
      let steps = 0;
      while (this.accumulator >= TICK_SECONDS && steps < MAX_STEPS_PER_FRAME) {
        if (this.stepTicks(1) === 0) { stepBlocked = true; this.accumulator = 0; break; }
        this.accumulator -= TICK_SECONDS; steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    }
    // A failed tick clears the accumulator; retain its wait on render frames before another tick is due.
    const canWait = !this.paused && !blocked;
    const collisionBlocked = canWait && (stepBlocked ? this.stepBlock === 'collision' : this.collisionLoading.blocked && !this.collisionReady());
    const modelBlocked = canWait && !collisionBlocked && (stepBlocked ? this.stepBlock === 'models' : this.modelLoading.blocked && !this.actorModelsReady());
    this.collisionLoading.blocked = collisionBlocked;
    if (collisionBlocked) { this.collisionLoading.blockedFrames++; this.collisionLoading.blockedSeconds += dt; }
    this.modelLoading.blocked = modelBlocked;
    if (modelBlocked) { this.modelLoading.blockedFrames++; this.modelLoading.blockedSeconds += dt; }
    const stalled = blocked || collisionBlocked || modelBlocked;
    if (stalled) this.accumulator = 0;
    // A stalled touch must not queue shots or a camera swing to execute after the street arrives.
    if (stalled) this.input?.touch?.reset();
    this.presentationAlpha = this.paused || stalled ? 1 : this.accumulator / TICK_SECONDS;
    this.presentationFrameTime = now;
    const presentation = this.paused || stalled ? this.state : interpolateState(this.previousState, this.state, this.presentationAlpha);
    this.syncViews(dt, this.paused || stalled ? 0 : dt * this.timeScale, presentation);
    this.render();
    const ms = performance.now() - this.frameStart;
    if (this.config.dynamicResolution && !this.paused && !stalled) this.scene.adaptResolution(dt, ms);
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) { this.stats.fps = this.fpsFrames / this.fpsAcc; this.fpsAcc = 0; this.fpsFrames = 0; }
    this.stats.frameMs = this.stats.frameMs * 0.9 + ms * 0.1;
  }

  render(): void {
    const info = this.scene.renderer.info;
    this.playerView.prepareForRender();
    for (const view of this.characterViews.values()) view.prepareForRender();
    this.scene.prepareSceneryForRender();
    this.scene.renderer.render(this.scene.scene, this.scene.camera);
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.textures = info.memory.textures;
    this.stats.geometries = info.memory.geometries;
    this.stats.tick = this.sim.tick;
  }

  syncViews(dt: number, characterDt = dt, state = this.state): void {
    this.presentationState = state;
    this.onStateChange?.(this.state);
    const p = state.player;
    const shots = this.pendingShots.splice(0);
    // Vehicles.
    const seen = new Set<string>();
    for (const v of state.vehicles) {
      seen.add(v.id);
      let view = this.vehicleViews.get(v.id);
      if (!view && !this.assets.hasVehicle(this.sim.definition(v.definition).assetId)) continue;
      if (!view) { view = new VehicleView(this.assets, v.id, this.sim.definition(v.definition), this.shadowMaterial, this.config.vehicleDetailRange); this.vehicleViews.set(v.id, view); this.scene.scene.add(view.root); }
      const interaction = p.vehicleInteraction?.vehicleId === v.id ? p.vehicleInteraction : null;
      const poses = vehiclePoses(this.sim.definition(v.definition));
      view.update(v, state.time, { DOOR_FL: vehicleDoorOpen(interaction, 'DOOR_FL', poses), DOOR_FR: vehicleDoorOpen(interaction, 'DOOR_FR', poses) }, dt);
    }
    for (const [id, view] of this.vehicleViews) if (!seen.has(id)) { view.dispose(); this.vehicleViews.delete(id); }
    // NPCs: independent skeletons share the four civilian/officer source assets.
    seen.clear();
    for (const c of state.characters) {
      seen.add(c.id);
      let view = this.characterViews.get(c.id);
      const assetId = characterAsset(c.id);
      if (!view && !this.assets.hasCharacter(assetId)) continue;
      if (!view) { view = new CharacterView(this.assets, assetId, this.shadowMaterial); this.characterViews.set(c.id, view); this.scene.scene.add(view.root); }
      for (const shot of shots) if (shot.shooter === c.id) view.notifyShot();
      view.update(c, characterDt, c.aiming || c.clip === 'aim' || c.clip === 'fire', null, undefined, undefined,
        { mobile: this.config.mobile, cameraPosition: this.scene.camera.position });
      if (c.aiming || c.clip === 'aim' || c.clip === 'fire' || view.isPresentingShot()) {
        // Match the police simulation's torso target, including when Finn is above street level.
        view.aimAt(new THREE.Vector3(p.position[0], p.position[1] + 1.2, p.position[2]));
      }
    }
    for (const [id, view] of this.characterViews) if (!seen.has(id)) { view.dispose(); this.characterViews.delete(id); }
    // Player.
    const playerVehicle = state.vehicles.find(v => v.id === p.inVehicle);
    const interactionVehicle = state.vehicles.find(v => v.id === p.vehicleInteraction?.vehicleId);
    for (const shot of shots) if (shot.shooter === 'player') this.playerView.notifyShot();
    this.playerView.update(p, characterDt, p.weapon !== null && (p.aiming || p.clip === 'fire'), p.vehicleInteraction, interactionVehicle,
      interactionVehicle ? vehiclePoses(this.sim.definition(interactionVehicle.definition)) : undefined);
    if (p.inVehicle && !playerVehicle) this.playerView.root.visible = true;
    // A stale presentation reference must not stop the frame loop before rendering.
    const cameraVehicle = playerVehicle ?? interactionVehicle;
    const cameraDef = cameraVehicle ? this.sim.definition(cameraVehicle.definition) : null;
    // While Finn is posed by the car layer, frame his rendered body and the seat he is heading for or leaving.
    let chaseTarget: THREE.Vector3 | null = null, focus: THREE.Vector3 | null = null, groundY: number | null = null;
    if (cameraVehicle && cameraDef && p.vehicleInteraction && p.vehicleInteraction.stage !== 'approach') {
      const [x, y, z, w] = cameraVehicle.rotation;
      const q = new THREE.Quaternion(x, y, z, w), origin = new THREE.Vector3(...cameraVehicle.position);
      chaseTarget = new THREE.Vector3(...cameraDef.seat.driver).applyQuaternion(q).add(origin);
      chaseTarget.y -= 0.45;
      focus = this.playerView.bodyFocus();
      // The ground Finn gets in from and out onto: under the wheels, or the roof plane of a car on its roof.
      const upsideDown = new THREE.Vector3(0, 1, 0).applyQuaternion(q).y < 0;
      groundY = new THREE.Vector3(0, upsideDown ? cameraDef.collider.centre[1] + cameraDef.collider.halfExtents[1] : 0, 0).applyQuaternion(q).add(origin).y;
    }
    this.cameraRig.update(state, this.world, cameraDef?.cameraChase ?? null, dt, chaseTarget, focus, groundY);
    if (this.streaming || this.collision) {
      const currentVehicle = this.state.vehicles.find(v => v.id === p.inVehicle);
      const current = currentVehicle?.position ?? this.state.player.position;
      const previousVehicle = this.previousState.vehicles.find(v => v.id === p.inVehicle);
      const previous = previousVehicle?.position ?? this.previousState.player.position;
      const velocityX = (current[0] - previous[0]) / TICK_SECONDS, velocityZ = (current[2] - previous[2]) / TICK_SECONDS;
      this.collision?.update(this.sim.collisionSources(), [velocityX, velocityZ]);
      const collisionWaiting = this.collisionLoading.blocked || this.collisionLoading.teleporting;
      const modelsWaiting = this.modelsWaitingMessage();
      if (this.streaming) {
        const position = playerVehicle?.position ?? p.position;
        const focus: StreamFocus = { x: position[0], z: position[2], velocityX, velocityZ };
        this.streaming.fallback.update(focus);
        this.streaming.detail.update(focus);
        const failed = this.streaming.fallback.hasErrors() || this.streaming.detail.hasErrors();
        this.hud.setWorldLoading(this.visualLoading.blocked || collisionWaiting
          ? i18n.text(failed ? 'world.streetsFailed' : 'world.streets')
          : modelsWaiting ?? (failed ? i18n.text('world.buildingsFailed') : null));
      } else this.hud.setWorldLoading(collisionWaiting ? i18n.text('world.streets') : modelsWaiting);
    } else this.hud.setWorldLoading(this.modelsWaitingMessage());
    this.presentationAimTarget = null;
    if (p.weapon && (p.aiming || p.clip === 'fire' || this.playerView.isPresentingShot())) {
      const ray = this.cameraRig.aimRay();
      const target = resolveAimTarget(this.world, [p.position[0], p.position[1] + 1.62, p.position[2]], [...ray.direction], ray, this.sim.inventory.weapon?.def.rangeMeters ?? 120, this.sim.player.body);
      this.presentationAimTarget = new THREE.Vector3(...target);
      this.playerView.aimAt(this.presentationAimTarget);
    }
    this.effects.update(characterDt, this.resolveMuzzle);
    this.effects.addShots(shots, this.resolveMuzzle);
    this.hud.update(state, this.stats, dt, this.frameEvents);
    this.audio.update(state, this.frameEvents, state.time);
  }

  // ---- drop-in and scripting ----

  dropIn(label: string): void | Promise<void> {
    const g = this.data.gameplay;
    const entry = g.landmarks.find(l => l.label === label) ?? g.addresses.find(a => a.label === label);
    if (!entry) return;
    return this.teleport(entry.position[0], entry.position[1], entry.headingDeg);
  }

  /**
   * Put the player (on foot) at the nearest road point to XZ, facing `headingDeg`. With streamed collision whose
   * destination bytes are not cached yet, this completes asynchronously and ticks wait meanwhile.
   */
  teleport(x: number, z: number, headingDeg = 0): void | Promise<void> {
    if (this.sim.mode !== 'onFoot' || this.collisionLoading.teleporting) return;
    this.input.reset();
    const lane = this.world.roads.nearestLane(x, z, undefined, 80);
    const tx = lane ? lane.point[0] : x, tz = lane ? lane.point[2] : z;
    const collision = this.collision;
    if (!collision) { this.placePlayer(this.sim.groundPoint(tx, tz), x, z, headingDeg); return; }
    const missing = (): string[] => [...new Set(this.world.unavailable(this.sim.dropInPlan(tx, tz)).concat(this.world.cellsAt(tx, tz).filter(id => !collision.get(id))))];
    const finish = (): void => {
      if (this.sim.mode !== 'onFoot') return;
      this.placePlayer(this.dropInGround(collision, tx, tz), x, z, headingDeg);
    };
    if (!missing().length) { finish(); return; }
    this.collisionLoading.teleporting = true;
    this.onStateChange?.(this.state);
    return (async () => {
      try { for (let m = missing(); m.length; m = missing()) await collision.ensure(m); }
      finally { this.collisionLoading.teleporting = false; this.onStateChange?.(this.state); }
      finish();
    })();
  }

  /** Ground under a drop-in destination whose collision may not be registered with Rapier yet. */
  private dropInGround(collision: CollisionStream, x: number, z: number): V3 {
    if (this.world.queryable(x, z)) return this.sim.groundPoint(x, z);
    // Mirror the Rapier probe: the highest surface below terrain + 30 m, including the fallback heightfield.
    const top = this.world.groundHeight(x, z) + 30;
    let y = this.world.groundHeight(x, z) - 0.4;
    for (const id of this.world.cellsAt(x, z)) {
      const h = groundBelowBundle(parseCollisionBundle(collision.get(id)!), x, top, z, 80);
      if (h !== null) y = Math.max(y, h);
    }
    return [x, y, z];
  }

  private placePlayer(g: V3, x: number, z: number, headingDeg: number): void {
    this.sim.dropIn(g, headingToYaw(headingDeg));
    // Not a command: logged here so a replay knows a teleport happened after this tick.
    if (this.captureReplay) this.eventLog.push({ tick: this.sim.tick, type: 'dropIn', detail: `${x},${z},${headingDeg}` });
    this.cameraRig.reset(this.sim.player.yaw);
    this.state = this.sim.state();
    this.previousState = this.state;
    this.presentationState = this.state;
    if (this.streaming) {
      const position = this.state.player.position;
      const focus = { x: position[0], z: position[2], velocityX: 0, velocityZ: 0 };
      this.streaming.fallback.update(focus);
      this.streaming.detail.update(focus);
    }
  }

  /** Inspection fixtures may wait for the requested destination; this never advances or moves the simulation. */
  async awaitVisuals(): Promise<void> {
    if (!this.streaming) return;
    await this.streaming.fallback.settle();
    await this.streaming.detail.settle();
  }

  missingVisualCells(): string[] {
    if (!this.streaming) return [];
    const p = this.state.player, car = this.state.vehicles.find(vehicle => vehicle.id === p.inVehicle);
    const position = car?.position ?? p.position;
    const area = this.data.gameplay.playArea;
    if (!p.alive || p.mode === 'wasted' || p.mode === 'busted' || !position.every(Number.isFinite) || position[1] < this.data.gameplay.killHeight ||
      position[0] < area.minX || position[0] > area.maxX || position[2] < area.minZ || position[2] > area.maxZ) return [];
    // At the fastest supported speed the next five 60Hz ticks cover under five metres. Twelve metres
    // includes the whole car and a margin before its front can enter an unseen cell during this frame.
    return missingVisualCoverage(this.data.manifest.cells, position[0], position[2], 12, this.scene.cells, this.scene.fallbackCells);
  }

  setScripted(command: Partial<Command> | null): void {
    this.scripted = command ? { ...NEUTRAL, ...command } : null;
  }

  setLighting(l: Lighting): void { this.scene.setLighting(l); }
}
