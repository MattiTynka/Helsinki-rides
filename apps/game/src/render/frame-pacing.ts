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
}

/** Timing thresholds use presentation cadence, including deliberate 30FPS pacing. No single stall is a GPU signal. */
export class AdaptiveResolution {
  scale: number;
  private readonly ceiling: number;
  private slowSeconds = 0;
  private fastSeconds = 0;
  private raiseCooldown = 0;
  private targetMs: number;

  constructor(options: ResolutionOptions = {}) {
    this.ceiling = Math.max(.6, Math.min(1, options.initialRenderScale ?? 1));
    this.scale = this.ceiling;
    this.targetMs = 1000 / (options.targetFrameRate === 30 ? 30 : 60);
  }

  setTargetFrameRate(rate: 30 | 60): void {
    this.targetMs = 1000 / rate; this.slowSeconds = 0; this.fastSeconds = 0;
  }

  update(intervalSeconds: number, cpuMs: number): boolean {
    const interval = intervalSeconds * 1000;
    if (!(interval > 0) || interval > 100 || !Number.isFinite(cpuMs) || cpuMs < 0) return false;
    this.raiseCooldown = Math.max(0, this.raiseCooldown - intervalSeconds);
    if (interval > this.targetMs * 1.32 && cpuMs < interval * .6) { this.slowSeconds += intervalSeconds; this.fastSeconds = 0; }
    else if (interval <= this.targetMs * 1.08) { this.fastSeconds += intervalSeconds; this.slowSeconds = 0; }
    else { this.slowSeconds = Math.max(0, this.slowSeconds - intervalSeconds); this.fastSeconds = 0; }
    let next = this.scale;
    if (this.slowSeconds > 1.5 && this.scale > .6) { next = Math.max(.6, this.scale - .15); this.raiseCooldown = 20; }
    else if (this.fastSeconds > 4 && this.raiseCooldown === 0 && this.scale < this.ceiling) next = Math.min(this.ceiling, this.scale + .1);
    if (next === this.scale) return false;
    this.scale = next; this.slowSeconds = 0; this.fastSeconds = 0; return true;
  }
}

/** Drawing-buffer ceiling also bounds large tablets; HTML controls retain their native display resolution. */
export function drawingPixelRatio(width: number, height: number, cappedRatio: number, scale: number, maxPixels = Number.POSITIVE_INFINITY): number {
  const area = Math.max(1, width) * Math.max(1, height);
  const ceiling = maxPixels > 0 ? Math.sqrt(maxPixels / area) : Number.POSITIVE_INFINITY;
  return Math.max(.1, Math.min(cappedRatio * scale, ceiling));
}
