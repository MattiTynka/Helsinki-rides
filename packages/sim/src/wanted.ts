// Wanted system (plan section 8): crimes carry star weights, heat decays on per-level timers once the police lose
// sight, and the search state keeps the last known position rather than the player's true one.
import type { GameEvent, WantedTuning } from '@helsinki/world-schema';
import type { V3 } from './math.ts';

export type Crime = 'takeCar' | 'ram' | 'ramPolice' | 'hitPedestrian' | 'drawWeapon' | 'fire' | 'shootAtPolice' | 'kill' | 'killOfficer';

export interface WantedSnapshot {
  readonly stars: number;
  readonly heat: number;
  readonly seen: boolean;
  readonly searching: boolean;
  readonly lastSeen: V3 | null;
  readonly decayTicks: number;
}

export class WantedState {
  readonly tuning: WantedTuning;
  stars = 0;
  heat = 0;
  /** true while any officer has line of sight */
  seen = false;
  lastSeen: V3 | null = null;
  lastSeenTick = -1;
  /** ticks since sight was lost; -1 while seen */
  hiddenTicks = -1;
  /** per-star decay countdown in ticks, running only while hidden */
  decayTicks = 0;
  /** pending witness reports: tick at which they land */
  private readonly pending: { crime: Crime; weight: number; at: number }[] = [];

  constructor(tuning: WantedTuning) { this.tuning = tuning; }

  /** Report a crime. `witnessed` = police saw it (immediate) vs civilian report (3-6 s delay). */
  report(crime: Crime, tick: number, witnessedByPolice: boolean, delayTicks: number, events: GameEvent[]): void {
    const weight = this.tuning.starWeights[crime] ?? 0;
    if (weight <= 0) return;
    if (witnessedByPolice) this.apply(crime, weight, tick, events);
    else this.pending.push({ crime, weight, at: tick + delayTicks });
  }

  private apply(crime: Crime, weight: number, tick: number, events: GameEvent[]): void {
    const before = this.stars;
    this.heat = Math.min(this.heat + weight, this.tuning.starThresholds[this.tuning.starThresholds.length - 1]! + 2);
    let stars = 0;
    for (let i = 0; i < this.tuning.starThresholds.length; i++) if (this.heat >= this.tuning.starThresholds[i]!) stars = i + 1;
    this.stars = Math.max(this.stars, stars);
    this.decayTicks = this.decayFor(this.stars);
    events.push({ tick, type: 'crime', detail: crime, value: weight });
    if (this.stars !== before) events.push({ tick, type: 'wanted', detail: `${before}>${this.stars}`, value: this.stars });
  }

  private decayFor(stars: number): number {
    return Math.round((this.tuning.decaySeconds[Math.max(0, stars - 1)] ?? 20) * 60);
  }

  /** Called every tick with whether the police currently see the player and where. */
  step(tick: number, seen: boolean, position: V3, events: GameEvent[]): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.at <= tick) { this.apply(p.crime, p.weight, tick, events); this.pending.splice(i, 1); }
    }
    if (this.stars === 0) { this.seen = false; this.hiddenTicks = -1; this.lastSeen = null; this.heat = Math.max(0, this.heat - 0.002); return; }
    if (seen) {
      if (!this.seen) events.push({ tick, type: 'spotted' });
      this.seen = true;
      this.lastSeen = [position[0], position[1], position[2]];
      this.lastSeenTick = tick;
      this.hiddenTicks = -1;
      this.decayTicks = this.decayFor(this.stars);
    } else {
      if (this.seen) events.push({ tick, type: 'lostSight' });
      this.seen = false;
      this.hiddenTicks = this.hiddenTicks < 0 ? 0 : this.hiddenTicks + 1;
      if (this.decayTicks > 0) this.decayTicks--;
      if (this.decayTicks === 0) {
        // One star drops per expired timer.
        this.stars--;
        this.heat = this.stars > 0 ? this.tuning.starThresholds[this.stars - 1]! : 0;
        events.push({ tick, type: 'wanted', detail: `decay>${this.stars}`, value: this.stars });
        this.decayTicks = this.stars > 0 ? this.decayFor(this.stars) : 0;
        if (this.stars === 0) events.push({ tick, type: 'evaded' });
      }
    }
  }

  clear(): void {
    this.stars = 0; this.heat = 0; this.seen = false; this.lastSeen = null; this.hiddenTicks = -1; this.decayTicks = 0; this.pending.length = 0;
  }

  get searching(): boolean { return this.stars > 0 && !this.seen; }

  snapshot(): WantedSnapshot {
    return { stars: this.stars, heat: Math.round(this.heat * 100) / 100, seen: this.seen, searching: this.searching, lastSeen: this.lastSeen, decayTicks: this.decayTicks };
  }
}
