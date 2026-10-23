/** Presentation only: the caller still advances fixed simulation ticks using the entire elapsed interval. */
export class FramePacer {
  private next = Number.NaN;
  private previous = Number.NaN;
  private readonly interval: number;

  constructor(targetFrameRate = 0) { this.interval = Number.isFinite(targetFrameRate) && targetFrameRate > 0 ? 1000 / targetFrameRate : 0; }

  shouldRender(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) return false;
    if (this.interval === 0) return true;
    if (!Number.isFinite(this.next) || nowMs < this.previous || nowMs - this.previous > 250) {
      this.next = nowMs + this.interval; this.previous = nowMs; return true;
    }
    this.previous = nowMs;
    // Half a millisecond accommodates rAF timestamp rounding without turning a 60Hz screen into 20FPS.
    if (nowMs + .5 < this.next) return false;
    this.next += Math.max(1, Math.floor((nowMs - this.next + .5) / this.interval) + 1) * this.interval;
    return true;
  }

  reset(): void { this.next = Number.NaN; this.previous = Number.NaN; }
}

export interface ResolutionOptions {
  readonly targetFrameRate?: number;
  readonly initialRenderScale?: number;
  readonly maxRenderPixels?: number;
  /** Lowest scale the governor may reach (default 0.6). */
  readonly minRenderScale?: number;
}

/** Frames up to this long are evidence about rendering cost; longer gaps (tab switches, loading hitches) are stalls. */
const MAX_MEASURED_INTERVAL_MS = 1000;

/**
 * Timing thresholds use presentation cadence, including deliberate 30FPS pacing. No single stall is a GPU signal.
 * Frames at least twice the target interval lower the scale in larger steps, so a device far below the target reaches
 * the floor in seconds rather than tens of seconds.
 */
export class AdaptiveResolution {
  scale: number;
  private readonly floor: number;
  private readonly ceiling: number;
  private slowSeconds = 0;
  private fastSeconds = 0;
  private raiseCooldown = 0;
  private targetMs: number;

  constructor(options: ResolutionOptions = {}) {
    const floor = options.minRenderScale ?? .6;
    this.floor = Number.isFinite(floor) ? Math.max(.1, Math.min(1, floor)) : .6;
    this.ceiling = Math.max(this.floor, Math.min(1, options.initialRenderScale ?? 1));
    this.scale = this.ceiling;
    this.targetMs = 1000 / (options.targetFrameRate === 30 ? 30 : 60);
  }

  setTargetFrameRate(rate: 30 | 60): void {
    this.targetMs = 1000 / rate; this.slowSeconds = 0; this.fastSeconds = 0;
  }

  /** The configured lowest scale (0.5 on desktops, 0.6 on phones), whatever the current scale. */
  get minScale(): number { return this.floor; }

  /** The scale cannot go lower: the next relief for slow frames is a lower detail tier (QualityGovernor). */
  get atFloor(): boolean { return this.scale <= this.floor; }

  /** Full resolution for this session: promotion evidence for the detail tier. */
  get atCeiling(): boolean { return this.scale >= this.ceiling; }

  update(intervalSeconds: number, cpuMs: number): boolean {
    const interval = intervalSeconds * 1000;
    if (!(interval > 0) || interval > MAX_MEASURED_INTERVAL_MS || !Number.isFinite(cpuMs) || cpuMs < 0) return false;
    this.raiseCooldown = Math.max(0, this.raiseCooldown - intervalSeconds);
    if (interval > this.targetMs * 1.32 && cpuMs < interval * .6) { this.slowSeconds += intervalSeconds; this.fastSeconds = 0; }
    else if (interval <= this.targetMs * 1.08) { this.fastSeconds += intervalSeconds; this.slowSeconds = 0; }
    else { this.slowSeconds = Math.max(0, this.slowSeconds - intervalSeconds); this.fastSeconds = 0; }
    let next = this.scale;
    if (this.slowSeconds > 1.5 && this.scale > this.floor) {
      next = Math.max(this.floor, this.scale - (interval >= this.targetMs * 2 ? .2 : .15)); this.raiseCooldown = 20;
    }
    else if (this.fastSeconds > 4 && this.raiseCooldown === 0 && this.scale < this.ceiling) next = Math.min(this.ceiling, this.scale + .1);
    if (next === this.scale) return false;
    this.scale = next; this.slowSeconds = 0; this.fastSeconds = 0; return true;
  }
}

/**
 * Drawing-buffer ceiling also bounds large tablets and desktop displays; HTML controls retain their native display
 * resolution. The render scale applies to the effective (capped) ratio, so lowering it always renders fewer pixels.
 */
export function drawingPixelRatio(width: number, height: number, cappedRatio: number, scale: number, maxPixels = Number.POSITIVE_INFINITY): number {
  const area = Math.max(1, width) * Math.max(1, height);
  const ceiling = maxPixels > 0 ? Math.sqrt(maxPixels / area) : Number.POSITIVE_INFINITY;
  return Math.max(.1, Math.min(cappedRatio, ceiling) * scale);
}

/** Maximum simulation ticks per rendered frame: catching up on a frame that was itself CPU-bound only slows the next. */
export function catchUpSteps(previousIntervalMs: number, previousCpuMs: number, targetMs: number): 3 | 5 {
  return previousIntervalMs > targetMs * 1.5 && previousCpuMs >= previousIntervalMs * .6 ? 3 : 5;
}
