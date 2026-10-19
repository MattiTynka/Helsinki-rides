// The game: fixed-step simulation driven by input commands, views synchronised from the sim state every frame
// (plan section 2 and 15). Nothing in here is simulation logic.
import * as THREE from 'three';
import { initPhysics, Simulation, StaticWorld, TICK_SECONDS, NEUTRAL, Button, headingToYaw, encodeCommand, decodeCommand, resolveAimTarget, type Command, type EncodedCommand, type GameEvent, type SimState } from '@helsinki/sim';
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
import { GlbLoader, loadWorldData, resolveRelease, type Progress, type WorldData } from './world/loader.ts';
import { CellVisualStream, missingVisualCoverage, type StreamFocus } from './world/cell-streaming.ts';

const MAX_STEPS_PER_FRAME = 5;
declare const __CAPTURE_REPLAY__: boolean;

export interface WorldVisualStreaming {
  readonly detail: CellVisualStream<CellView>;
  readonly fallback: CellVisualStream<CellView>;
  readonly persistentTextureBytes: number;
  readonly totalTextureBudgetBytes: number;
}

export class Game {
  readonly data: WorldData;
  world: StaticWorld;
  sim: Simulation;
  readonly scene: CityScene;
  readonly loader: GlbLoader;
  readonly assets: AssetLibrary;
  readonly streaming: WorldVisualStreaming | null;
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
  timeScale = 1;
  private accumulator = 0;
  private lastNow = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  readonly stats: FrameStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, textures: 0, geometries: 0, tick: 0 };
  private frameStart = 0;
  private running = false;
  readonly visualLoading = { blocked: false, blockedFrames: 0, blockedSeconds: 0, missingCells: [] as string[] };

  private constructor(config: GameConfig, data: WorldData, world: StaticWorld, scene: CityScene, loader: GlbLoader, assets: AssetLibrary, canvas: HTMLCanvasElement, streaming: WorldVisualStreaming | null) {
    this.config = config;
    this.captureReplay = __CAPTURE_REPLAY__;
    this.data = data;
    this.world = world;
    this.scene = scene;
    this.loader = loader;
    this.assets = assets;
    this.streaming = streaming;
    this.sim = new Simulation(world, { seed: config.seed });
    this.cameraRig = new ChaseCamera(scene.camera);
    this.input = new Input(canvas, config.review);
    this.hud = new Hud(config.hud && !config.review, data.manifest, data.gameplay, data.roads);
    this.hud.onDropIn = label => this.dropIn(label);
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
    const [data] = await Promise.all([loadWorldData(release, progress), initPhysics()]);
    const lighting: Lighting = config.lighting ?? (data.manifest.lighting === 'unlit-facades' ? 'unlit' : 'lit');
    const scene = new CityScene(canvas, config.preset, lighting, config.pixelRatioCap);
    const loader = new GlbLoader(scene.renderer);
    const world = Game.buildWorld(data);
    const assets = new AssetLibrary();
    await assets.load(loader, data.base, data.manifest, config.preset === 'low');
    progress(1, 1, 'hero assets');
    const hasFallbacks = data.manifest.cells.every(cell => !!cell.visual.lod2);
    if (data.scenery) scene.addScenery(data.scenery, assets.scenery, data.manifest.cellSize, hasFallbacks);
    let streaming: WorldVisualStreaming | null = null;
    if (hasFallbacks) {
      const persistentRoots = [...assets.characters.values()].map(a => a.scene)
        .concat([...assets.vehicles.values()].map(a => a.scene), [...assets.scenery.values()], assets.pistol ? [assets.pistol] : []);
      const persistentTextureBytes = textureBytesOf(persistentRoots);
      const totalTextureBudgetBytes = (config.preset === 'low' ? 160 : 320) * 2 ** 20;
      const fallbackBudget = 4 * 2 ** 20;
      const backend = (lod: 'lod0' | 'lod1' | 'lod2') => ({
        load: (cell: typeof data.manifest.cells[number], signal: AbortSignal) => scene.loadCell(loader, data.base, cell, lod, signal),
        show: (_cell: typeof data.manifest.cells[number], view: CellView) => scene.showCell(view),
        dispose: (_cell: typeof data.manifest.cells[number], view: CellView) => scene.disposeCell(view),
      });
      const low = config.preset === 'low';
      const detail = new CellVisualStream(data.manifest.cells, backend(low ? 'lod1' : 'lod0'), {
        textureBudgetBytes: totalTextureBudgetBytes - persistentTextureBytes - fallbackBudget,
        geometryBudgetBytes: (low ? 96 : 160) * 2 ** 20,
        radius: low ? 170 : 230, lookaheadSeconds: 3, maxLookahead: 180, concurrency: 2, maxCells: low ? 16 : 28,
        level: low ? 'lod1' : 'lod0',
      });
      const fallback = new CellVisualStream(data.manifest.cells, backend('lod2'), {
        textureBudgetBytes: fallbackBudget, radius: low ? 300 : 420, lookaheadSeconds: 3, maxLookahead: 180,
        geometryBudgetBytes: (low ? 64 : 96) * 2 ** 20,
        concurrency: 2, level: 'lod2', maxCells: low ? 28 : 42,
      });
      streaming = { detail, fallback, persistentTextureBytes, totalTextureBudgetBytes };
      // The fog terminates within the coarse residency ring; outside geometry is not kept hidden in memory.
      scene.scene.fog = new THREE.Fog(0x9fb8d4, low ? 160 : 240, low ? 300 : 420);
      // Fully fogged geometry contributes no visible pixels. Clip it instead of still drawing every
      // parked car and landmark in the expanded world behind the opaque end of the fog.
      scene.camera.far = low ? 300 : 420;
      scene.camera.updateProjectionMatrix();
      const [x, z] = data.gameplay.player.spawn.position;
      const focus = { x, z, velocityX: 0, velocityZ: 0 };
      fallback.update(focus);
      await fallback.settle();
      if (fallback.stats().errors.length) throw new Error(`Initial city fallback load failed: ${fallback.stats().errors.join('; ')}`);
      progress(1, 2, 'nearby streets');
      detail.update(focus);
      await detail.settle();
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
    return new Game(config, data, world, scene, loader, assets, canvas, streaming);
  }

  /** Collision world from the release data; manifest order so collider handles match an offline replay. */
  static buildWorld(data: WorldData): StaticWorld {
    const world = StaticWorld.fromBytes(data.terrain, data.roads, data.gameplay);
    for (const c of data.manifest.cells) world.addCell(c.id, data.collision.get(c.id)!);
    return world;
  }

  /** Start a fresh simulation (same seed) without reloading the page or the GPU assets. */
  resetSimulation(seed = this.config.seed): void {
    for (const v of this.vehicleViews.values()) v.dispose();
    this.vehicleViews.clear();
    for (const c of this.characterViews.values()) c.dispose();
    this.characterViews.clear();
    this.world = Game.buildWorld(this.data);
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
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    const loop = (now: number) => { if (!this.running) return; this.frame(now); requestAnimationFrame(loop); };
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

  /** Advance the simulation by whole ticks. */
  stepTicks(n: number, command?: Command): void {
    for (let i = 0; i < n; i++) {
      // Quantise through the encoding so the browser and a Node replay step bit-identical commands.
      const encoded = encodeCommand(command ?? this.currentCommand());
      if (this.captureReplay) this.commandLog.push(encoded);
      const c = decodeCommand(encoded);
      this.previousState = this.state;
      const events = this.sim.step(c);
      this.state = this.sim.state();
      if (events.some(e => e.type === 'respawn' || e.type === 'recover')) this.previousState = this.state;
      if (this.captureReplay && this.config.review && this.traceLog.length < 20000) this.traceLog.push(this.sim.digest());
      for (const e of events) {
        this.frameEvents.push(e);
        if (this.captureReplay) { this.eventLog.push(e); if (this.eventLog.length > 5000) this.eventLog.shift(); }
      }
      this.handleEvents(events);
    }
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
    if (!this.paused && !blocked) {
      // Mouse look.
      const [dx, dy] = this.input.takeLook();
      const [gx, gy] = this.input.gamepadLook();
      if (this.cameraRig.inCar) this.cameraRig.mouseOffsetInCar(dx + gx); else this.cameraRig.look(dx + gx, dy + gy);
      if (this.sim.screen && this.sim.screen.ticks < this.sim.options.screenTicks - 120) this.timeScale = 1;
      this.accumulator += dt * this.timeScale;
      let steps = 0;
      while (this.accumulator >= TICK_SECONDS && steps < MAX_STEPS_PER_FRAME) { this.stepTicks(1); this.accumulator -= TICK_SECONDS; steps++; }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    }
    this.presentationAlpha = this.paused || blocked ? 1 : this.accumulator / TICK_SECONDS;
    this.presentationFrameTime = now;
    const presentation = this.paused || blocked ? this.state : interpolateState(this.previousState, this.state, this.presentationAlpha);
    this.syncViews(dt, this.paused || blocked ? 0 : dt * this.timeScale, presentation);
    this.render();
    const ms = performance.now() - this.frameStart;
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) { this.stats.fps = this.fpsFrames / this.fpsAcc; this.fpsAcc = 0; this.fpsFrames = 0; }
    this.stats.frameMs = this.stats.frameMs * 0.9 + ms * 0.1;
  }

  render(): void {
    const info = this.scene.renderer.info;
    if (this.config.preset === 'low') {
      this.playerView.prepareForRender();
      for (const view of this.characterViews.values()) view.prepareForRender();
    }
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
    const p = state.player;
    // Vehicles.
    const seen = new Set<string>();
    for (const v of state.vehicles) {
      seen.add(v.id);
      let view = this.vehicleViews.get(v.id);
      if (!view) { view = new VehicleView(this.assets, v.id, this.sim.definition(v.definition), this.shadowMaterial, this.config.vehicleDetailRange); this.vehicleViews.set(v.id, view); this.scene.scene.add(view.root); }
      const interaction = p.vehicleInteraction?.vehicleId === v.id ? p.vehicleInteraction : null;
      const poses = vehiclePoses(this.sim.definition(v.definition));
      view.update(v, state.time, { DOOR_FL: vehicleDoorOpen(interaction, 'DOOR_FL', poses), DOOR_FR: vehicleDoorOpen(interaction, 'DOOR_FR', poses) }, dt);
    }
    for (const [id, view] of this.vehicleViews) if (!seen.has(id)) { view.dispose(); this.vehicleViews.delete(id); }
    // NPCs (officers).
    seen.clear();
    for (const c of state.characters) {
      seen.add(c.id);
      let view = this.characterViews.get(c.id);
      if (!view) { view = new CharacterView(this.assets, c.id.startsWith('police') ? 'character-rain' : 'character-snow', this.shadowMaterial); this.characterViews.set(c.id, view); this.scene.scene.add(view.root); }
      view.update(c, characterDt, c.clip === 'aim' || c.clip === 'fire');
      if (c.clip === 'aim' || c.clip === 'fire') {
        // Match the police simulation's torso target, including when Finn is above street level.
        view.aimAt(new THREE.Vector3(p.position[0], p.position[1] + 1.2, p.position[2]));
      }
    }
    for (const [id, view] of this.characterViews) if (!seen.has(id)) { view.dispose(); this.characterViews.delete(id); }
    // Player.
    const playerVehicle = state.vehicles.find(v => v.id === p.inVehicle);
    const interactionVehicle = state.vehicles.find(v => v.id === p.vehicleInteraction?.vehicleId);
    this.playerView.update(p, characterDt, p.weapon !== null && (p.aiming || p.clip === 'fire'), p.vehicleInteraction, interactionVehicle,
      interactionVehicle ? vehiclePoses(this.sim.definition(interactionVehicle.definition)) : undefined);
    if (p.inVehicle && !playerVehicle) this.playerView.root.visible = true;
    this.effects.addShots(state.shots);
    this.effects.update(dt);
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
    if (this.streaming) {
      const position = playerVehicle?.position ?? p.position;
      const currentVehicle = this.state.vehicles.find(v => v.id === p.inVehicle);
      const current = currentVehicle?.position ?? this.state.player.position;
      const previousVehicle = this.previousState.vehicles.find(v => v.id === p.inVehicle);
      const previous = previousVehicle?.position ?? this.previousState.player.position;
      const focus: StreamFocus = { x: position[0], z: position[2],
        velocityX: (current[0] - previous[0]) / TICK_SECONDS, velocityZ: (current[2] - previous[2]) / TICK_SECONDS };
      this.streaming.fallback.update(focus);
      this.streaming.detail.update(focus);
      const failed = this.streaming.fallback.stats().errors.length + this.streaming.detail.stats().errors.length > 0;
      this.hud.setWorldLoading(this.visualLoading.blocked
        ? failed ? 'Could not load nearby streets. Retrying…' : 'Loading nearby streets…'
        : failed ? 'Some nearby buildings could not load. Retrying…' : null);
    }
    this.presentationAimTarget = null;
    if (p.weapon && (p.aiming || p.clip === 'fire')) {
      const ray = this.cameraRig.aimRay();
      const target = resolveAimTarget(this.world, [p.position[0], p.position[1] + 1.62, p.position[2]], [...ray.direction], ray, this.sim.inventory.weapon?.def.rangeMeters ?? 120, this.sim.player.body);
      this.presentationAimTarget = new THREE.Vector3(...target);
      this.playerView.aimAt(this.presentationAimTarget);
    }
    this.hud.update(state, this.stats, dt, this.frameEvents);
    this.audio.update(state, this.frameEvents, state.time);
  }

  // ---- drop-in and scripting ----

  dropIn(label: string): void {
    const g = this.data.gameplay;
    const entry = g.landmarks.find(l => l.label === label) ?? g.addresses.find(a => a.label === label);
    if (!entry) return;
    this.teleport(entry.position[0], entry.position[1], entry.headingDeg);
  }

  /** Put the player (on foot) at the nearest road point to XZ, facing `headingDeg`. */
  teleport(x: number, z: number, headingDeg = 0): void {
    if (this.sim.mode !== 'onFoot') return;
    const lane = this.world.roads.nearestLane(x, z, undefined, 80);
    const target = lane ? [lane.point[0], lane.point[2]] : [x, z];
    const g = this.sim.groundPoint(target[0]!, target[1]!);
    this.sim.player.teleport(g, headingToYaw(headingDeg));
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
