// Detail-tier governor (AC-4). The resolution governor reacts first; only when frames stay GPU-bound with the render
// scale already at its floor does this lower the detail tier one step (standard -> low -> minimal). Promotion back
// needs a long run of fast frames at the full render scale and never exceeds the preset's own tier. Pure: the caller
// feeds rendered frames (never paused, stalled, world-loading or hidden ones) and injects the clock.
import type { QualityTier } from './quality-tiers.ts';

/** Highest detail first. */
export const TIER_ORDER: readonly QualityTier[] = Object.freeze(['standard', 'low', 'minimal'] as const);
export const tierRank = (tier: QualityTier): number => TIER_ORDER.indexOf(tier);

/** Frames up to this long are evidence about rendering cost; longer gaps are stalls and are ignored. */
const MAX_MEASURED_INTERVAL_MS = 1000;
/** Slow seconds at the resolution floor before a demotion. */
const DEMOTE_AFTER_SECONDS = 3;
/** No further demotion for this long after a tier change. */
const COOLDOWN_MS = 60_000;
/** Fast seconds at the resolution ceiling before a promotion. */
const PROMOTE_AFTER_SECONDS = 60;

export interface QualityGovernorOptions {
  /** The preset's own tier: promotion never goes above it. */
  readonly presetTier: QualityTier;
  /** Presentation target interval (16.7 ms at 60 FPS, 33.3 ms at 30 FPS pacing). */
  readonly targetMs: number;
  /** Starting tier when it is below the preset's (a remembered automatic tier). */
  readonly tier?: QualityTier;
  /** Milliseconds; only differences are used. */
  readonly now?: () => number;
}

export interface GovernorFrame {
  readonly intervalMs: number;
  readonly cpuMs: number;
  readonly renderScale: number;
  /** The resolution governor's scale is at its floor / ceiling. */
  readonly atFloor: boolean;
  readonly atCeiling: boolean;
}

export type TierChange = 'demote' | 'promote';

export class QualityGovernor {
  readonly presetTier: QualityTier;
  private current: QualityTier;
  private targetMs: number;
  private slowSeconds = 0;
  private fastSeconds = 0;
  private cooldownUntil = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(options: QualityGovernorOptions) {
    this.presetTier = options.presetTier;
    const start = options.tier ?? options.presetTier;
    this.current = tierRank(start) < tierRank(options.presetTier) ? options.presetTier : start;
    this.targetMs = Number.isFinite(options.targetMs) && options.targetMs > 0 ? options.targetMs : 1000 / 60;
    this.now = options.now ?? (() => performance.now());
  }

  get tier(): QualityTier { return this.current; }

  /** 30 FPS pacing is judged against its own 33.3 ms target; earlier evidence no longer applies. */
  setTargetFrameRate(rate: 30 | 60): void {
    this.targetMs = 1000 / rate; this.slowSeconds = 0; this.fastSeconds = 0;
  }

  /** One rendered frame; returns the tier change it caused, if any (`tier` is then already the new tier). */
  feed(frame: GovernorFrame): TierChange | null {
    const { intervalMs, cpuMs } = frame;
    if (!(intervalMs > 0) || intervalMs > MAX_MEASURED_INTERVAL_MS || !Number.isFinite(cpuMs) || cpuMs < 0) return null;
    const seconds = intervalMs / 1000;
    // GPU-bound: slow presentation while the CPU part stays short. A CPU-bound frame only clamps catch-up (AC-8).
    const slow = intervalMs > this.targetMs * 1.32 && cpuMs < intervalMs * .6;
    const fast = intervalMs <= this.targetMs * 1.08;
    const qualifies = slow && frame.atFloor;
    // The run is capped at the demotion threshold, so only the most recent 3 s of evidence count: slow seconds banked
    // during a cooldown cannot outlast a later stretch of CPU-bound or in-between frames.
    if (!frame.atFloor) this.slowSeconds = 0;
    else if (slow) this.slowSeconds = Math.min(DEMOTE_AFTER_SECONDS, this.slowSeconds + seconds);
    else if (fast) this.slowSeconds = 0;
    else this.slowSeconds = Math.max(0, this.slowSeconds - seconds);
    this.fastSeconds = fast && frame.atCeiling ? this.fastSeconds + seconds : 0;
    const rank = tierRank(this.current);
    // Only a frame that itself qualifies (GPU-bound, slow, at the floor) may emit a demotion.
    if (qualifies && this.slowSeconds >= DEMOTE_AFTER_SECONDS && rank < TIER_ORDER.length - 1 && this.now() >= this.cooldownUntil) {
      return this.change(TIER_ORDER[rank + 1]!, 'demote');
    }
    if (this.fastSeconds >= PROMOTE_AFTER_SECONDS && rank > tierRank(this.presetTier)) return this.change(TIER_ORDER[rank - 1]!, 'promote');
    return null;
  }

  private change(tier: QualityTier, kind: TierChange): TierChange {
    this.current = tier;
    this.slowSeconds = 0; this.fastSeconds = 0;
    this.cooldownUntil = this.now() + COOLDOWN_MS;
    return kind;
  }
}
