// DOM HUD and canvas minimap (plan section 9): stars, health/armour, weapon, speed, prompts, arrest meter,
// Wasted / Busted screens naming the real destinations, drop-in by address, attribution line.
import type { SimState } from '@helsinki/sim';
import { sampleTerrain, type TerrainGrid, type GameEvent, type GameplayBundle, type RoadGraph, type RoadIndex, type WorldManifest } from '@helsinki/world-schema';
import { resolveDropInTarget } from '../world/drop-in.ts';
import { i18n, placeLabel, type MessageKey } from '../i18n/index.ts';
import type { QualityTier } from '../render/quality-tiers.ts';
import { flightText } from './flight-text.ts';
import { compassHeading, LiveMinimap, MAP_CELL_METRES, mapYaw, type MapSource } from './minimap.ts';

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
  | { readonly kind: 'polygon'; readonly colour: string; readonly points: readonly (readonly number[])[] }
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
  private readonly compass = el<HTMLDivElement>('compass');
  private readonly compassNeedle = el<HTMLSpanElement>('compass-needle');
  private readonly compassHeading = el<HTMLSpanElement>('compass-heading');
  private readonly liveMap = new LiveMinimap();
  private mapSource: MapSource | null = null;
  private readonly mapCtx: CanvasRenderingContext2D;
  private readonly area: GameplayBundle['playArea'];
  private readonly terrain: TerrainGrid | undefined;
  private readonly scale = 2; // px per metre on the base layer
  /** The base layer is drawn lazily in tiles: the whole city at this scale is a 66 MB canvas. */
  private readonly tileSize = 256;
  /** Each tile also draws this many pixels of its neighbours, so subpixel-positioned tiles overlap without seams. */
  private readonly tileGutter = 1;
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

  constructor(visible: boolean, manifest: WorldManifest, gameplay: GameplayBundle, roads: RoadIndex, terrain?: TerrainGrid) {
    this.root.classList.toggle('hidden', !visible);
    this.worldLoading.id = 'world-stream-status';
    this.worldLoading.className = 'prompt hidden';
    this.worldLoading.style.position = 'fixed';
    this.worldLoading.style.bottom = '25%';
    this.worldLoading.setAttribute('role', 'status');
    document.body.append(this.worldLoading);
    this.area = gameplay.playArea;
    this.terrain = terrain;
    this.mapCtx = this.minimap.getContext('2d')!;
    this.indexBase(roads.graph, gameplay, manifest);
    this.minimap.setAttribute('role', 'img');
    this.minimap.setAttribute('aria-label', flightText('mapDescription'));
    el<HTMLDivElement>('attribution').textContent = manifest.attribution.join(' · ');
    const labels = [...gameplay.landmarks, ...gameplay.addresses]
      .filter(a => resolveDropInTarget(gameplay, roads, ...a.position) !== null).map(a => a.label);
    for (const l of labels) { const o = document.createElement('option'); o.value = l; o.textContent = placeLabel(l); this.dropin.appendChild(o); }
    const airports = document.createElement('optgroup');
    airports.label = flightText('airports');
    const malmi = document.createElement('option');
    malmi.value = 'malmi-airfield'; malmi.textContent = flightText('malmi'); malmi.dataset['place'] = '1';
    airports.append(malmi);
    this.dropin.insertBefore(airports, this.dropin.children[1] ?? null);
    i18n.subscribe(() => {
      this.minimap.setAttribute('aria-label', flightText('mapDescription'));
      airports.label = flightText('airports');
      malmi.textContent = flightText('malmi');
      for (const option of this.dropin.options) if (option.value && !option.dataset['place']) option.textContent = placeLabel(option.value);
    });
    this.dropin.addEventListener('change', () => { const v = this.dropin.value; this.dropin.value = ''; this.dropin.blur(); if (v && this.onDropIn) this.onDropIn(v); });
  }

  /** Reads existing streamed/cached data only; the HUD never starts network requests. */
  setMapSource(provider: MapSource): void { this.mapSource = provider; }

  /** More drop-in places after the release's own, one group per district; names are proper names, not translated. */
  addDropInGroups(groups: readonly { label: string; options: readonly { value: string; text: string }[] }[]): void {
    for (const group of groups) {
      const g = document.createElement('optgroup');
      g.label = group.label;
      for (const { value, text } of group.options) {
        const o = document.createElement('option');
        o.value = value; o.textContent = text; o.dataset['place'] = '1';
        g.appendChild(o);
      }
      this.dropin.appendChild(g);
    }
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
  private indexBase(roads: RoadGraph, gameplay: GameplayBundle, manifest: WorldManifest): void {
    const shapes: MapShape[] = [];
    for (const cell of manifest.cells) for (const b of cell.buildings) {
      const { min, max } = b.boundsRuntime;
      shapes.push({ kind: 'polygon', colour: '#777783', points: [[min[0], 0, min[2]], [max[0], 0, min[2]], [max[0], 0, max[2]], [min[0], 0, max[2]]] });
    }
    for (const f of roads.footways) shapes.push({ kind: 'line', colour: '#3a4458', width: 2, points: f.points });
    for (const lane of roads.lanes) shapes.push({ kind: 'line', colour: lane.highway === 'service' ? '#6d7891' : '#c9d2e3',
      width: lane.highway === 'service' ? 3 : Math.max(4, lane.width * this.scale), points: lane.points });
    for (const a of gameplay.anchors) shapes.push({ kind: 'anchor', hospital: a.kind === 'hospital', x: a.position[0], z: a.position[1] });
    for (const shape of shapes) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const points = shape.kind !== 'anchor' ? shape.points.map(p => this.toMap(p[0]!, p[2]!)) : [this.toMap(shape.x, shape.z)];
      for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      // Half the stroke plus antialiasing, or the marker's circle and label.
      const pad = (shape.kind === 'line' ? shape.width / 2 + 2 : shape.kind === 'anchor' ? 12 : 2) + this.tileGutter;
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
    const width = this.tileSize, height = this.tileSize;
    const g = this.tileGutter, canvas = document.createElement('canvas');
    canvas.width = width + 2 * g; canvas.height = height + 2 * g;
    const c = canvas.getContext('2d')!;
    c.translate(g - ox, g - oy);
    c.fillStyle = '#1c2230';
    c.fillRect(ox - g, oy - g, width + 2 * g, height + 2 * g);
    // Unknown coverage is visibly hatched, rather than presented as an empty city or invented coastline.
    c.strokeStyle = '#303848'; c.lineWidth = 1;
    for (let x = ox - height; x < ox + width; x += 20) {
      c.beginPath(); c.moveTo(x, oy - g); c.lineTo(x + height + 2 * g, oy + height + g); c.stroke();
    }
    if (this.terrain) {
      const t = this.terrain;
      const maxX = t.x0 + (t.nx - 1) * t.resolution, maxZ = t.z0 + (t.nz - 1) * t.resolution;
      for (let y = oy - g; y < oy + height + g; y += 16) for (let x = ox - g; x < ox + width + g; x += 16) {
        const wx = x / this.scale + this.area.minX, wz = y / this.scale + this.area.minZ;
        const x0 = Math.max(wx, t.x0), z0 = Math.max(wz, t.z0), x1 = Math.min(wx + 8, maxX), z1 = Math.min(wz + 8, maxZ);
        if (x0 >= x1 || z0 >= z1) continue;
        const h = sampleTerrain(t, (x0 + x1) / 2, (z0 + z1) / 2);
        if (!Number.isFinite(h)) continue;
        const tone = Math.round(Math.max(40, Math.min(80, 48 + h * 0.5)));
        c.fillStyle = `rgb(${tone},${tone + 6},${tone + 3})`;
        const [mx, my] = this.toMap(x0, z0);
        c.fillRect(mx, my, (x1 - x0) * this.scale + 0.2, (z1 - z0) * this.scale + 0.2);
      }
    }
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const shape of this.tileShapes.get(key) ?? []) {
      if (shape.kind === 'line') {
        c.strokeStyle = shape.colour;
        c.lineWidth = shape.width;
        c.beginPath();
        shape.points.forEach((p, i) => { const [x, y] = this.toMap(p[0]!, p[2]!); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
        c.stroke();
      } else if (shape.kind === 'polygon') {
        c.fillStyle = shape.colour; c.beginPath();
        shape.points.forEach((p, i) => { const [x, y] = this.toMap(p[0]!, p[2]!); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
        c.closePath(); c.fill();
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
    const aircraft = p.aircraftId ? state.aircraft.find(a => a.id === p.aircraftId) : null;
    if (aircraft) this.speed.textContent = `${flightText(aircraft.kind)} | ${i18n.number(aircraft.speed * 3.6)} km/h | ${i18n.number(aircraft.position[1] + 7.5)} m${aircraft.damage !== 'intact' ? ` | ${flightText(aircraft.damage)}` : ''}`;
    let prompt = '';
    if (p.mode === 'onFoot' && p.nearAircraft) prompt = this.touchControls ? i18n.text('touch.enter') : flightText('enter');
    else if (aircraft?.crashed) prompt = [flightText('crashed'), this.touchControls ? flightText('touchRecover') : flightText('recover'),
      aircraft.grounded && aircraft.speed < 2 && Math.abs(aircraft.verticalSpeed) <= 0.2 && Math.hypot(...aircraft.angularVelocity) <= 0.3 ? (this.touchControls ? i18n.text('touch.exit') : flightText('exit')) : flightText('waitStop')].join(' | ');
    else if (aircraft) prompt = [this.touchControls ? flightText('touchControls') : flightText('controls'),
      aircraft.blocked ? flightText('blocked') : aircraft.grounded && aircraft.speed < 2 ? (this.touchControls ? i18n.text('touch.exit') : flightText('exit')) : flightText('airborne')].join(' | ');
    else if (p.mode === 'onFoot' && p.nearVehicle) prompt = i18n.text(this.touchControls ? 'touch.promptEnter' : 'interaction.enter');
    else if (p.mode === 'driving') prompt = car && car.damage === 'wrecked' ? i18n.text(this.touchControls ? 'touch.promptWreck' : 'interaction.leaveWreck') : '';
    else if (p.mode === 'entering') {
      const stage = p.vehicleInteraction?.stage;
      prompt = i18n.text(stage === 'approach' ? 'interaction.approach' : stage === 'push' ? 'interaction.pushing' : stage === 'shove' ? 'interaction.shoving' : 'interaction.entering');
    }
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
    const yaw = mapYaw(state), heading = compassHeading(yaw);
    this.compassHeading.textContent = `${heading.cardinal} ${String(heading.degrees).padStart(3, '0')}°`;
    this.compassNeedle.style.transform = `rotate(${heading.degrees}deg)`;
    this.compass.setAttribute('aria-label', `${flightText('heading')}: ${heading.cardinal}, ${heading.degrees}°`);
    const [px, py] = this.toMap(p.position[0], p.position[2]);
    // Air travel covers a 150 m radius. Ground travel retains its close street view.
    const zoom = p.aircraftId ? size / (300 * this.scale) : 1;
    const viewSize = size / zoom;
    c.save();
    c.clearRect(0, 0, size, size);
    c.beginPath(); c.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2); c.clip();
    c.scale(zoom, zoom);
    const left = px - viewSize / 2, top = py - viewSize / 2;
    for (let ty = Math.floor(top / this.tileSize); ty <= Math.floor((top + viewSize) / this.tileSize); ty++) {
      for (let tx = Math.floor(left / this.tileSize); tx <= Math.floor((left + viewSize) / this.tileSize); tx++) {
        const tile = this.tile(tx, ty);
        if (tile) c.drawImage(tile, tx * this.tileSize - this.tileGutter - left, ty * this.tileSize - this.tileGutter - top);
      }
    }
    if (this.mapSource) {
      const radius = viewSize / (2 * this.scale), x = p.position[0], z = p.position[2];
      for (let cz = Math.floor((z - radius) / MAP_CELL_METRES); cz <= Math.floor((z + radius) / MAP_CELL_METRES); cz++) {
        for (let cx = Math.floor((x - radius) / MAP_CELL_METRES); cx <= Math.floor((x + radius) / MAP_CELL_METRES); cx++) {
          const canvas = this.liveMap.cell(cx, cz, this.mapSource(cx, cz));
          if (!canvas) continue;
          const [mx, my] = this.toMap(cx * MAP_CELL_METRES, cz * MAP_CELL_METRES);
          c.drawImage(canvas, mx - left, my - top);
        }
      }
    }
    const dot = (x: number, z: number, colour: string, r = 4) => { const [mx, my] = this.toMap(x, z); c.fillStyle = colour; c.beginPath(); c.arc(mx - left, my - top, r / zoom, 0, Math.PI * 2); c.fill(); };
    for (const a of state.aircraft ?? []) dot(a.position[0], a.position[2], '#8fe9ef', 5);
    for (const v of state.vehicles) if (v.definition === 'patrol') dot(v.position[0], v.position[2], v.sirenOn ? '#4f7dff' : '#8fa6e8', 4);
    for (const ch of state.characters) if (ch.inVehicle === null && ch.alive) dot(ch.position[0], ch.position[2], '#8fa6e8', 3);
    if (state.wanted.lastSeen && state.wanted.searching) { dot(state.wanted.lastSeen[0], state.wanted.lastSeen[2], 'rgba(255,80,80,0.25)', 20); }
    // Player arrow.
    c.translate(viewSize / 2, viewSize / 2);
    c.scale(1 / zoom, 1 / zoom);
    c.rotate(-yaw + Math.PI);
    c.fillStyle = '#ffffff';
    c.beginPath(); c.moveTo(0, -8); c.lineTo(5, 6); c.lineTo(-5, 6); c.closePath(); c.fill();
    c.restore();
    c.save(); c.fillStyle = '#fff'; c.font = 'bold 12px sans-serif'; c.textAlign = 'center';
    c.strokeStyle = '#17202e'; c.lineWidth = 3;
    for (const [label, x, y] of [['N', size / 2, 15], ['E', size - 12, size / 2 + 4], ['S', size / 2, size - 6], ['W', 12, size / 2 + 4]] as const) {
      c.strokeText(label, x, y); c.fillText(label, x, y);
    }
    c.restore();
  }

  setLoading(visible: boolean, text?: string, fraction?: number): void {
    const l = el<HTMLDivElement>('loading');
    l.classList.toggle('hidden', !visible);
    if (text !== undefined) el<HTMLDivElement>('loading-text').textContent = text;
    if (fraction !== undefined) el<HTMLDivElement>('loading-fill').style.width = `${Math.round(fraction * 100)}%`;
  }
}
