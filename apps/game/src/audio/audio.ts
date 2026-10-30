// Synthesised audio (no sample files): engine hum, two-tone siren, gunshots, horn and crash thumps. Built suspended
// before Play where the browser allows it; starts on the first user gesture, as browsers require.
import type { GameEvent, SimState } from '@helsinki/sim';

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engine: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private siren: { osc: OscillatorNode; gain: GainNode } | null = null;
  private noise: AudioBuffer | null = null;
  enabled: boolean;

  constructor(enabled: boolean) { this.enabled = enabled; }

  /**
   * Build the context and its graph ahead of Play, so the Play gesture only resumes it: constructing an AudioContext
   * costs ~90 ms of main thread. Chrome and Firefox log an autoplay warning for a context made before any user activation,
   * so without one yet this waits for the first activating input (a press precedes its click) and builds it there.
   */
  prepare(): void {
    if (!this.enabled || this.ctx || typeof AudioContext === 'undefined') return;
    const nav = navigator as Navigator & { userActivation?: UserActivation; getAutoplayPolicy?: (type: string) => string };
    const activation = nav.userActivation;
    const build = (): void => {
      if (this.ctx) return;
      // A context made after an activation would start playing: hold it until Play resumes it.
      try { void this.build().suspend().catch(() => {}); } catch { /* start() creates it lazily instead. */ }
    };
    if (activation?.hasBeenActive || nav.getAutoplayPolicy?.('audiocontext') === 'allowed') { build(); return; }
    if (!activation) return;
    const events = ['pointerdown', 'pointerup', 'mousedown', 'keydown', 'touchend'];
    const early = (): void => {
      if (!activation.hasBeenActive) return;
      for (const type of events) window.removeEventListener(type, early, true);
      if (this.enabled) build();
    };
    for (const type of events) window.addEventListener(type, early, { capture: true, passive: true });
  }

  /** Call from a user gesture. */
  start(): void {
    if (!this.enabled) return;
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(error => console.warn('Audio could not resume', error));
      return;
    }
    const ctx = this.build();
    if (ctx.state === 'suspended') void ctx.resume();
  }

  private build(): AudioContext {
    const ctx = new AudioContext();
    try {
      const master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 50;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(master);
      osc.start();
      const sOsc = ctx.createOscillator();
      sOsc.type = 'triangle';
      const sGain = ctx.createGain();
      sGain.gain.value = 0;
      sOsc.connect(sGain).connect(master);
      sOsc.start();
      const len = ctx.sampleRate * 0.5;
      const noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.ctx = ctx; this.master = master; this.engine = { osc, gain, filter }; this.siren = { osc: sOsc, gain: sGain }; this.noise = noise;
    } catch (error) {
      void ctx.close().catch(() => {});
      throw error;
    }
    return ctx;
  }

  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend().catch(error => console.warn('Audio could not pause', error));
  }

  private burst(duration: number, volume: number, cutoff: number): void {
    if (!this.ctx || !this.noise || !this.master) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration);
  }

  private tone(freq: number, duration: number, volume: number, type: OscillatorType = 'square'): void {
    if (!this.ctx || !this.master) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + duration);
  }

  update(state: SimState, events: readonly GameEvent[], time: number): void {
    if (!this.ctx || !this.engine || !this.siren) return;
    const p = state.player;
    const car = p.inVehicle ? state.vehicles.find(v => v.id === p.inVehicle) : null;
    const t = this.ctx.currentTime;
    if (car && (p.mode === 'driving' || p.mode === 'exiting')) {
      const rpm = 45 + car.speed * 6 + Math.max(0, car.throttle) * 25;
      this.engine.osc.frequency.setTargetAtTime(rpm, t, 0.05);
      this.engine.filter.frequency.setTargetAtTime(300 + car.speed * 40, t, 0.05);
      this.engine.gain.gain.setTargetAtTime(0.1 + Math.abs(car.throttle) * 0.06, t, 0.05);
    } else this.engine.gain.gain.setTargetAtTime(0, t, 0.1);
    // Siren: loudest nearby patrol car, two-tone sweep.
    let nearest = Infinity;
    for (const v of state.vehicles) if (v.sirenOn) nearest = Math.min(nearest, Math.hypot(v.position[0] - p.position[0], v.position[2] - p.position[2]));
    if (Number.isFinite(nearest)) {
      const vol = Math.min(0.25, 12 / Math.max(8, nearest));
      const phase = (time % 1.2) / 1.2;
      this.siren.osc.frequency.setTargetAtTime(phase < 0.5 ? 650 : 900, t, 0.02);
      this.siren.gain.gain.setTargetAtTime(vol, t, 0.1);
    } else this.siren.gain.gain.setTargetAtTime(0, t, 0.1);
    for (const e of events) {
      if (e.type === 'fire') this.burst(0.12, 0.6, 2500);
      else if (e.type === 'policeFire') this.burst(0.12, 0.25, 1800);
      else if (e.type === 'horn') this.tone(420, 0.35, 0.2);
      else if (e.type === 'crash' || e.type === 'ram' || e.type === 'ramPolice') this.burst(0.3, 0.5, 500);
      else if (e.type === 'windshieldBreak') this.burst(0.45, 0.45, 9000);
      else if (e.type === 'wanted' && (e.value ?? 0) > 0) this.tone(880, 0.15, 0.15, 'sine');
      else if (e.type === 'wasted') this.tone(110, 1.2, 0.3, 'sawtooth');
      else if (e.type === 'busted') this.tone(220, 0.6, 0.25, 'triangle');
    }
  }
}
