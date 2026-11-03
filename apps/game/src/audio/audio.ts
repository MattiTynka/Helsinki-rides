// Synthesised audio (no sample files): engine hum, two-tone siren, gunshots, horn and crash thumps. Built suspended
// before Play where the browser allows it; starts on the first user gesture, as browsers require.
import type { GameEvent, SimState } from '@helsinki/sim';

export type AudioStartStatus = 'running' | 'disabled' | 'unavailable' | 'timeout';

export class GameAudio {
  private ctx: AudioContext | null = null;
  private starting: Promise<AudioStartStatus> | null = null;
  private master: GainNode | null = null;
  private engine: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private siren: { osc: OscillatorNode; gain: GainNode } | null = null;
  private noise: AudioBuffer | null = null;
  enabled: boolean;

  constructor(enabled: boolean) { this.enabled = enabled; }

  /** Build and suspend audio during loading; a fresh visitor's Play gesture only resumes the prepared graph. */
  async prepare(): Promise<void> {
    if (!this.enabled || this.ctx || typeof AudioContext === 'undefined') return;
    // Autoplay policy may keep a new context suspended. It does not require postponing graph construction.
    // Wait for suspension before enabling Play so an earlier suspend cannot race the user's resume.
    try { await this.build().suspend(); } catch { /* Browsers that require activation retry construction in start(). */ }
  }

  /** Invoke in the gesture; callers can keep gameplay paused while the audio device starts. */
  start(): Promise<AudioStartStatus> {
    if (!this.enabled) return Promise.resolve('disabled');
    if (this.starting) return this.starting;
    let ctx: AudioContext, resumed: Promise<void>;
    try {
      ctx = this.ctx && this.ctx.state !== 'closed' ? this.ctx : this.build();
      if (ctx.state === 'running') return Promise.resolve('running');
      resumed = ctx.resume();
    } catch {
      console.warn('Audio is unavailable; continuing without sound');
      return Promise.resolve('unavailable');
    }
    const pending = new Promise<AudioStartStatus>(resolve => {
      let settled = false;
      const finish = (status: AudioStartStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(status);
      };
      // A denied or unavailable device must not hold the game on its loading screen indefinitely.
      const timeout = setTimeout(() => {
        console.warn('Audio startup timed out; continuing without sound');
        finish('timeout');
      }, 1000);
      resumed.then(() => finish(ctx.state === 'running' ? 'running' : 'unavailable'), () => {
        if (!settled) console.warn('Audio is unavailable; continuing without sound');
        finish('unavailable');
      });
    });
    this.starting = pending;
    void pending.then(() => { if (this.starting === pending) this.starting = null; });
    return pending;
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
    // A timed-out resume can still finish later. Queue suspension even if the context reports suspended,
    // and let a later gesture issue a new resume after it.
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.suspend().catch(() => console.warn('Audio could not pause'));
    }
    this.starting = null;
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
      else if (e.type === 'crash' || e.type === 'aircraftCrash' || e.type === 'ram' || e.type === 'ramPolice') this.burst(0.3, 0.5, 500);
      else if (e.type === 'windshieldBreak') this.burst(0.45, 0.45, 9000);
      else if (e.type === 'wanted' && (e.value ?? 0) > 0) this.tone(880, 0.15, 0.15, 'sine');
      else if (e.type === 'wasted') this.tone(110, 1.2, 0.3, 'sawtooth');
      else if (e.type === 'busted') this.tone(220, 0.6, 0.25, 'triangle');
    }
  }
}
