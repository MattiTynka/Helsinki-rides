// DOM HUD and canvas minimap (plan section 9): stars, health/armour, weapon, speed, prompts, arrest meter,
// Wasted / Busted screens naming the real destinations, drop-in by address, attribution line.
import type { SimState } from '@helsinki/sim';
import type { GameEvent, GameplayBundle, RoadGraph, WorldManifest } from '@helsinki/world-schema';
import { i18n, placeLabel, type MessageKey } from '../i18n/index.ts';
import type { QualityTier } from '../render/quality-tiers.ts';

export interface FrameStats {
  /** From the real presentation interval (no 10 fps floor). */
  fps: number;
  /** CPU time of a frame (simulation, view sync and render submission). */
  frameMs: number;
  /** Real presentation interval, smoothed. */
  frameIntervalMs: number;
  tier: QualityTier;
  /** Dynamic-resolution scale of the capped drawing-buffer ratio. */
  renderScale: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  tick: number;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const TIER_LABELS: Readonly<Record<QualityTier, MessageKey>> = { standard: 'tier.standard', low: 'tier.low', minimal: 'tier.minimal' };

const INTERACTION_NOTES: Partial<Record<string, MessageKey>> = {
  vehicleEntryBlocked: 'interaction.entryBlocked',
  vehicleExitBlocked: 'interaction.exitBlocked',
  vehicleExitSqueezed: 'interaction.squeezed',
};

function exitPrompt(interaction: SimState['player']['vehicleInteraction']): string {
  switch (interaction?.clip) {
    case 'exitPassenger': return i18n.text('interaction.exitPassenger');
    case 'exitWindshield': return i18n.text('interaction.exitWindshield');
    case 'exitFlipped': return i18n.text('interaction.exitFlipped');
    case 'exitFlippedPassenger': return i18n.text('interaction.exitFlippedPassenger');
    default: return i18n.text('interaction.exiting');
  }
}

type MapShape =
  | { readonly kind: 'line'; readonly colour: string; readonly width: number; readonly points: readonly (readonly number[])[] }
  | { readonly kind: 'anchor'; readonly hospital: boolean; readonly x: number; readonly z: number };

export class Hud {
  touchControls = false;
  private readonly root = el<HTMLDivElement>('hud');
  private readonly stars = el<HTMLDivElement>('stars');
  private readonly wantedNote = el<HTMLDivElement>('wanted-note');
  private readonly health = el<HTMLDivElement>('health');
  private readonly armour = el<HTMLDivElement>('armour');
  private readonly weapon = el<HTMLDivElement>('weapon');
  private readonly speed = el<HTMLDivElement>('speed');
  private readonly prompt = el<HTMLDivElement>('prompt');
  private readonly crosshair = el<HTMLDivElement>('crosshair');
  private readonly arrest = el<HTMLDivElement>('arrest');
  private readonly arrestFill = el<HTMLDivElement>('arrest-fill');
  private readonly stats = el<HTMLDivElement>('stats');
  private readonly screen = el<HTMLDivElement>('screen');
  private readonly screenTitle = el<HTMLDivElement>('screen-title');
  private readonly screenSub = el<HTMLDivElement>('screen-sub');
  private readonly dropin = el<HTMLSelectElement>('dropin');
  private readonly minimap = el<HTMLCanvasElement>('minimap');
  private readonly mapCtx: CanvasRenderingContext2D;
  private readonly area: GameplayBundle['playArea'];
  private readonly scale = 2; // px per metre on the base layer
  /** The base layer is drawn lazily in tiles: the whole city at this scale is a 66 MB canvas. */
  private readonly tileSize = 256;
  /** Each tile also draws this many pixels of its neighbours, so subpixel-positioned tiles overlap without seams. */
  private readonly tileGutter = 1;
  private readonly mapSize: readonly [number, number];
  private readonly tileShapes = new Map<string, MapShape[]>();
  private readonly tiles = new Map<string, HTMLCanvasElement>();
  private lastStars = -1;
  private lastWeapon = '';
  private lastPrompt = '';
  private interactionNote: MessageKey | null = null;
  private interactionNoteUntil = 0;
  private previousTime = 0;
  private statsTimer = 0;
  private readonly worldLoading = document.createElement('div');
  onDropIn: ((label: string) => void) | null = null;

  constructor(visible: boolean, manifest: WorldManifest, gameplay: GameplayBundle, roads: RoadGraph) {
    this.root.classList.toggle('hidden', !visible);
    this.worldLoading.id = 'world-stream-status';
    this.worldLoading.className = 'prompt hidden';
    this.worldLoading.style.position = 'fixed';
    this.worldLoading.style.bottom = '25%';
    this.worldLoading.setAttribute('role', 'status');
    document.body.append(this.worldLoading);
    this.area = gameplay.playArea;
    this.mapCtx = this.minimap.getContext('2d')!;
    this.mapSize = [Math.ceil((this.area.maxX - this.area.minX) * this.scale), Math.ceil((this.area.maxZ - this.area.minZ) * this.scale)];
    this.indexBase(roads, gameplay);
    el<HTMLDivElement>('attribution').textContent = manifest.attribution.join(' · ');
    const labels = [...gameplay.landmarks.map(l => l.label), ...gameplay.addresses.map(a => a.label)];
    for (const l of labels) { const o = document.createElement('option'); o.value = l; o.textContent = placeLabel(l); this.dropin.appendChild(o); }
    i18n.subscribe(() => {
      for (const option of this.dropin.options) if (option.value) option.textContent = placeLabel(option.value);
    });
    this.dropin.addEventListener('change', () => { const v = this.dropin.value; this.dropin.value = ''; this.dropin.blur(); if (v && this.onDropIn) this.onDropIn(v); });
  }

  setWorldLoading(message: string | null): void {
    this.worldLoading.textContent = message ?? '';
    this.worldLoading.classList.toggle('hidden', !message);
  }

  /** Shows `key` in the prompt line for `seconds` of game time. */
  showNotice(key: MessageKey, time: number, seconds = 5): void {
    this.interactionNote = key;
    this.interactionNoteUntil = time + seconds;
  }

  private toMap(x: number, z: number): [number, number] {
    return [(x - this.area.minX) * this.scale, (z - this.area.minZ) * this.scale];
  }

  /** Assign each base-layer shape, in drawing order, to every tile its stroke or marker can touch. */
  private indexBase(roads: RoadGraph, gameplay: GameplayBundle): void {
    const shapes: MapShape[] = [];
    for (const f of roads.footways) shapes.push({ kind: 'line', colour: '#3a4458', width: 2, points: f.points });
    for (const lane of roads.lanes) shapes.push({ kind: 'line', colour: lane.highway === 'service' ? '#6d7891' : '#c9d2e3',
      width: lane.highway === 'service' ? 3 : Math.max(4, lane.width * this.scale), points: lane.points });
    for (const a of gameplay.anchors) shapes.push({ kind: 'anchor', hospital: a.kind === 'hospital', x: a.position[0], z: a.position[1] });
    for (const shape of shapes) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const points = shape.kind === 'line' ? shape.points.map(p => this.toMap(p[0]!, p[2]!)) : [this.toMap(shape.x, shape.z)];
      for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      // Half the stroke plus antialiasing, or the marker's circle and label.
      const pad = (shape.kind === 'line' ? shape.width / 2 + 2 : 12) + this.tileGutter;
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      for (let ty = Math.floor((y0 - pad) / this.tileSize); ty <= Math.floor((y1 + pad) / this.tileSize); ty++) {
        for (let tx = Math.floor((x0 - pad) / this.tileSize); tx <= Math.floor((x1 + pad) / this.tileSize); tx++) {
          const key = `${tx},${ty}`;
          let list = this.tileShapes.get(key);
          if (!list) this.tileShapes.set(key, list = []);
          list.push(shape);
        }
      }
    }
  }

  /** One base-layer tile, drawn on first use with the original full-layer commands, translated. */
  private tile(tx: number, ty: number): HTMLCanvasElement | null {
    const key = `${tx},${ty}`;
    const cached = this.tiles.get(key);
    if (cached) { this.tiles.delete(key); this.tiles.set(key, cached); return cached; }
    const ox = tx * this.tileSize, oy = ty * this.tileSize;
    const width = Math.min(this.tileSize, this.mapSize[0] - ox), height = Math.min(this.tileSize, this.mapSize[1] - oy);
    if (tx < 0 || ty < 0 || width <= 0 || height <= 0) return null;
    const g = this.tileGutter, canvas = document.createElement('canvas');
    canvas.width = width + 2 * g; canvas.height = height + 2 * g;
    const c = canvas.getContext('2d')!;
    c.translate(g - ox, g - oy);
    // The gutter never extends the map beyond the original full layer's edges.
    c.beginPath(); c.rect(0, 0, this.mapSize[0], this.mapSize[1]); c.clip();
    c.fillStyle = '#1c2230';
    c.fillRect(ox - g, oy - g, width + 2 * g, height + 2 * g);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const shape of this.tileShapes.get(key) ?? []) {
      if (shape.kind === 'line') {
        c.strokeStyle = shape.colour;
        c.lineWidth = shape.width;
        c.beginPath();
        shape.points.forEach((p, i) => { const [x, y] = this.toMap(p[0]!, p[2]!); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
        c.stroke();
      } else {
        const [x, y] = this.toMap(shape.x, shape.z);
        c.fillStyle = shape.hospital ? '#ff6b6b' : '#6b9bff';
        c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#fff'; c.font = 'bold 9px sans-serif'; c.fillText(shape.hospital ? 'H' : 'P', x - 3, y + 3);
      }
    }
    this.tiles.set(key, canvas);
    if (this.tiles.size > 24) this.tiles.delete(this.tiles.keys().next().value!);
    return canvas;
  }

  update(state: SimState, stats: FrameStats, dt: number, events: readonly GameEvent[] = state.events): void {
    const p = state.player;
    if (state.time < this.previousTime) this.interactionNoteUntil = 0;
    this.previousTime = state.time;
    if (state.wanted.stars !== this.lastStars) {
      this.lastStars = state.wanted.stars;
      this.stars.innerHTML = Array.from({ length: 5 }, (_, i) => `<span class="${i < state.wanted.stars ? 'on' : 'off'}">★</span>`).join('');
    }
    this.wantedNote.textContent = state.wanted.stars > 0 ? i18n.text(state.wanted.searching ? 'wanted.searching' : 'wanted.spotted') : '';
    this.health.style.width = `${Math.max(0, p.health)}%`;
    this.armour.style.width = `${Math.max(0, p.armour)}%`;
    const w = p.weapon ? i18n.text('weapon.ammo', {
      weapon: p.weapon.id === 'pistol' ? i18n.text('weapon.pistol') : p.weapon.id.toUpperCase(),
      magazine: i18n.number(p.weapon.magazine), reserve: i18n.number(p.weapon.reserve), reloading: p.weapon.reloading ? ' …' : '',
    }) : i18n.text('weapon.fists');
    if (w !== this.lastWeapon) { this.lastWeapon = w; this.weapon.textContent = w; }
    const car = p.inVehicle ? state.vehicles.find(v => v.id === p.inVehicle) : null;
    const damageKeys: Readonly<Record<string, MessageKey>> = { smoking: 'vehicle.smoking', burning: 'vehicle.burning', wrecked: 'vehicle.wrecked' };
    const damageKey = car && Object.hasOwn(damageKeys, car.damage) ? damageKeys[car.damage] : undefined;
    this.speed.textContent = car ? (car.damage === 'intact'
      ? i18n.text('vehicle.speed', { speed: i18n.number(car.speed * 3.6) })
      : i18n.text('vehicle.damagedSpeed', { speed: i18n.number(car.speed * 3.6), damage: damageKey ? i18n.template(damageKey) : car.damage })) : '';
    let prompt = '';
    if (p.mode === 'onFoot' && p.nearVehicle) prompt = i18n.text(this.touchControls ? 'touch.promptEnter' : 'interaction.enter');
    else if (p.mode === 'driving') prompt = car && car.damage === 'wrecked' ? i18n.text(this.touchControls ? 'touch.promptWreck' : 'interaction.leaveWreck') : '';
    else if (p.mode === 'entering') prompt = i18n.text(p.vehicleInteraction?.stage === 'approach' ? 'interaction.approach' : 'interaction.entering');
    else if (p.mode === 'exiting') prompt = exitPrompt(p.vehicleInteraction);
    for (const event of events) {
      const note = this.touchControls && event.type === 'vehicleExitBlocked' ? 'touch.promptExitBlocked' : INTERACTION_NOTES[event.type];
      if (note) { this.interactionNote = note; this.interactionNoteUntil = state.time + 3; }
    }
    if (state.time < this.interactionNoteUntil && this.interactionNote && (p.mode === 'onFoot' || p.mode === 'driving')) prompt = i18n.template(this.interactionNote);
    if (p.recoverProgress > 0 && p.recoverProgress < 1) prompt = i18n.text('interaction.recover', { percent: i18n.number(p.recoverProgress * 100) });
    if (prompt !== this.lastPrompt) { this.lastPrompt = prompt; this.prompt.textContent = prompt; }
    this.crosshair.classList.toggle('hidden', !p.aiming);
    this.arrest.classList.toggle('hidden', state.arrestProgress <= 0);
    this.arrestFill.style.width = `${Math.round(state.arrestProgress * 100)}%`;
    if (state.screen) {
      this.screen.classList.remove('hidden');
      this.screenTitle.textContent = i18n.text(state.screen.kind === 'wasted' ? 'screen.wasted' : 'screen.busted');
      this.screenSub.textContent = i18n.text('screen.destination', { destination: placeLabel(state.screen.destination) });
    } else this.screen.classList.add('hidden');
    this.statsTimer += dt;
    if (this.statsTimer > 0.5) {
      this.statsTimer = 0;
      this.stats.textContent = i18n.text('stats', {
        fps: i18n.number(stats.fps, stats.fps < 10 ? 1 : 0), interval: i18n.number(stats.frameIntervalMs), frameMs: i18n.number(stats.frameMs, 1),
        tier: i18n.template(TIER_LABELS[stats.tier]), scale: i18n.number(stats.renderScale * 100), drawCalls: i18n.number(stats.drawCalls),
        triangles: i18n.number(stats.triangles / 1000), textures: i18n.number(stats.textures), tick: i18n.number(stats.tick),
      });
    }
    this.drawMinimap(state);
  }

  private drawMinimap(state: SimState): void {
    const c = this.mapCtx;
    const size = this.minimap.width;
    const p = state.player;
    const [px, py] = this.toMap(p.position[0], p.position[2]);
    c.save();
    c.clearRect(0, 0, size, size);
    c.beginPath(); c.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2); c.clip();
    const left = px - size / 2, top = py - size / 2;
    for (let ty = Math.floor(top / this.tileSize); ty <= Math.floor((top + size) / this.tileSize); ty++) {
      for (let tx = Math.floor(left / this.tileSize); tx <= Math.floor((left + size) / this.tileSize); tx++) {
        const tile = this.tile(tx, ty);
        if (tile) c.drawImage(tile, tx * this.tileSize - this.tileGutter - left, ty * this.tileSize - this.tileGutter - top);
      }
    }
    const dot = (x: number, z: number, colour: string, r = 4) => { const [mx, my] = this.toMap(x, z); c.fillStyle = colour; c.beginPath(); c.arc(mx - px + size / 2, my - py + size / 2, r, 0, Math.PI * 2); c.fill(); };
    for (const v of state.vehicles) if (v.definition === 'patrol') dot(v.position[0], v.position[2], v.sirenOn ? '#4f7dff' : '#8fa6e8', 4);
    for (const ch of state.characters) if (ch.inVehicle === null && ch.alive) dot(ch.position[0], ch.position[2], '#8fa6e8', 3);
    if (state.wanted.lastSeen && state.wanted.searching) { dot(state.wanted.lastSeen[0], state.wanted.lastSeen[2], 'rgba(255,80,80,0.25)', 20); }
    // Player arrow.
    c.translate(size / 2, size / 2);
    c.rotate(-p.yaw + Math.PI);
    c.fillStyle = '#ffffff';
    c.beginPath(); c.moveTo(0, -8); c.lineTo(5, 6); c.lineTo(-5, 6); c.closePath(); c.fill();
    c.restore();
  }

  setLoading(visible: boolean, text?: string, fraction?: number): void {
    const l = el<HTMLDivElement>('loading');
    l.classList.toggle('hidden', !visible);
    if (text !== undefined) el<HTMLDivElement>('loading-text').textContent = text;
    if (fraction !== undefined) el<HTMLDivElement>('loading-fill').style.width = `${Math.round(fraction * 100)}%`;
  }
}
