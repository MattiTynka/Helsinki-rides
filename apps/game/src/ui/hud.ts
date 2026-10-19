// DOM HUD and canvas minimap (plan section 9): stars, health/armour, weapon, speed, prompts, arrest meter,
// Wasted / Busted screens naming the real destinations, drop-in by address, attribution line.
import type { SimState } from '@helsinki/sim';
import type { GameEvent, GameplayBundle, RoadGraph, WorldManifest } from '@helsinki/world-schema';

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  tick: number;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const INTERACTION_NOTES: Partial<Record<string, string>> = {
  vehicleEntryBlocked: 'The driver’s door is blocked.',
  vehicleExitBlocked: 'The way out got blocked. Press F to try again.',
  vehicleExitSqueezed: 'Squeezed out of the car.',
};

function exitPrompt(interaction: SimState['player']['vehicleInteraction']): string {
  switch (interaction?.clip) {
    case 'exitPassenger': return 'Driver’s door blocked — climbing across…';
    case 'exitWindshield': return 'Doors blocked — kicking out the windshield…';
    case 'exitFlipped': return 'Crawling out…';
    case 'exitFlippedPassenger': return 'Driver’s door blocked — crawling across…';
    default: return 'Getting out…';
  }
}

export class Hud {
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
  private readonly mapLayer: HTMLCanvasElement;
  private readonly area: GameplayBundle['playArea'];
  private readonly scale = 2; // px per metre on the base layer
  private lastStars = -1;
  private lastWeapon = '';
  private lastPrompt = '';
  private interactionNote = '';
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
    this.mapLayer = document.createElement('canvas');
    this.mapLayer.width = Math.ceil((this.area.maxX - this.area.minX) * this.scale);
    this.mapLayer.height = Math.ceil((this.area.maxZ - this.area.minZ) * this.scale);
    this.drawBase(roads, gameplay);
    el<HTMLDivElement>('attribution').textContent = manifest.attribution.join(' · ');
    const labels = [...gameplay.landmarks.map(l => l.label), ...gameplay.addresses.map(a => a.label)];
    for (const l of labels) { const o = document.createElement('option'); o.value = l; o.textContent = l; this.dropin.appendChild(o); }
    this.dropin.addEventListener('change', () => { const v = this.dropin.value; this.dropin.value = ''; this.dropin.blur(); if (v && this.onDropIn) this.onDropIn(v); });
  }

  setWorldLoading(message: string | null): void {
    this.worldLoading.textContent = message ?? '';
    this.worldLoading.classList.toggle('hidden', !message);
  }

  private toMap(x: number, z: number): [number, number] {
    return [(x - this.area.minX) * this.scale, (z - this.area.minZ) * this.scale];
  }

  private drawBase(roads: RoadGraph, gameplay: GameplayBundle): void {
    const c = this.mapLayer.getContext('2d')!;
    c.fillStyle = '#1c2230';
    c.fillRect(0, 0, this.mapLayer.width, this.mapLayer.height);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#3a4458';
    c.lineWidth = 2;
    for (const f of roads.footways) this.polyline(c, f.points);
    for (const lane of roads.lanes) {
      c.strokeStyle = lane.highway === 'service' ? '#6d7891' : '#c9d2e3';
      c.lineWidth = lane.highway === 'service' ? 3 : Math.max(4, lane.width * this.scale);
      this.polyline(c, lane.points);
    }
    for (const a of gameplay.anchors) {
      const [x, y] = this.toMap(a.position[0], a.position[1]);
      c.fillStyle = a.kind === 'hospital' ? '#ff6b6b' : '#6b9bff';
      c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff'; c.font = 'bold 9px sans-serif'; c.fillText(a.kind === 'hospital' ? 'H' : 'P', x - 3, y + 3);
    }
  }

  private polyline(c: CanvasRenderingContext2D, pts: readonly (readonly number[])[]): void {
    c.beginPath();
    pts.forEach((p, i) => { const [x, y] = this.toMap(p[0]!, p[2]!); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
    c.stroke();
  }

  update(state: SimState, stats: FrameStats, dt: number, events: readonly GameEvent[] = state.events): void {
    const p = state.player;
    if (state.time < this.previousTime) this.interactionNoteUntil = 0;
    this.previousTime = state.time;
    if (state.wanted.stars !== this.lastStars) {
      this.lastStars = state.wanted.stars;
      this.stars.innerHTML = Array.from({ length: 5 }, (_, i) => `<span class="${i < state.wanted.stars ? 'on' : 'off'}">★</span>`).join('');
    }
    this.wantedNote.textContent = state.wanted.stars > 0 ? (state.wanted.searching ? 'searching' : 'spotted') : '';
    this.health.style.width = `${Math.max(0, p.health)}%`;
    this.armour.style.width = `${Math.max(0, p.armour)}%`;
    const w = p.weapon ? `${p.weapon.id.toUpperCase()} ${p.weapon.magazine} / ${p.weapon.reserve}${p.weapon.reloading ? ' …' : ''}` : 'FISTS';
    if (w !== this.lastWeapon) { this.lastWeapon = w; this.weapon.textContent = w; }
    const car = p.inVehicle ? state.vehicles.find(v => v.id === p.inVehicle) : null;
    this.speed.textContent = car ? `${Math.round(car.speed * 3.6)} km/h${car.damage !== 'intact' ? ` · ${car.damage}` : ''}` : '';
    let prompt = '';
    if (p.mode === 'onFoot' && p.nearVehicle) prompt = 'F — enter car';
    else if (p.mode === 'driving') prompt = car && car.damage === 'wrecked' ? 'F — leave the wreck' : '';
    else if (p.mode === 'entering') prompt = p.vehicleInteraction?.stage === 'approach' ? 'Walking to the driver’s door…' : 'Getting in…';
    else if (p.mode === 'exiting') prompt = exitPrompt(p.vehicleInteraction);
    for (const event of events) {
      const note = INTERACTION_NOTES[event.type];
      if (note) { this.interactionNote = note; this.interactionNoteUntil = state.time + 3; }
    }
    if (state.time < this.interactionNoteUntil && (p.mode === 'onFoot' || p.mode === 'driving')) prompt = this.interactionNote;
    if (p.recoverProgress > 0 && p.recoverProgress < 1) prompt = `recovering… ${Math.round(p.recoverProgress * 100)}%`;
    if (prompt !== this.lastPrompt) { this.lastPrompt = prompt; this.prompt.textContent = prompt; }
    this.crosshair.classList.toggle('hidden', !p.aiming);
    this.arrest.classList.toggle('hidden', state.arrestProgress <= 0);
    this.arrestFill.style.width = `${Math.round(state.arrestProgress * 100)}%`;
    if (state.screen) {
      this.screen.classList.remove('hidden');
      this.screenTitle.textContent = state.screen.kind === 'wasted' ? 'Wasted' : 'Busted';
      this.screenSub.textContent = state.screen.kind === 'wasted' ? `Taken to ${state.screen.destination}` : `Taken to ${state.screen.destination}`;
    } else this.screen.classList.add('hidden');
    this.statsTimer += dt;
    if (this.statsTimer > 0.5) {
      this.statsTimer = 0;
      this.stats.textContent = `${stats.fps.toFixed(0)} fps  ${stats.frameMs.toFixed(1)} ms\n${stats.drawCalls} calls  ${(stats.triangles / 1000).toFixed(0)}k tris\n${stats.textures} tex  tick ${stats.tick}`;
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
    c.drawImage(this.mapLayer, px - size / 2, py - size / 2, size, size, 0, 0, size, size);
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
