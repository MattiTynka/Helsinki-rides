export interface KnockdownPresentation {
  readonly elapsed: number;
  readonly fallSeconds: number;
  readonly holdSeconds: number;
  readonly riseSeconds: number;
}

/** Sample one authored collapse forward, hold it, then reverse into its standing pose. */
export function knockdownProgress(knockdown: KnockdownPresentation | null | undefined, alive: boolean): number | null {
  if (!alive || !knockdown) return null;
  const { elapsed, fallSeconds, holdSeconds, riseSeconds } = knockdown;
  if (![elapsed, fallSeconds, holdSeconds, riseSeconds].every(Number.isFinite)
    || fallSeconds <= 0 || holdSeconds < 0 || riseSeconds <= 0) return null;
  if (elapsed <= fallSeconds) return Math.max(0, elapsed / fallSeconds);
  return 1 - Math.min(1, Math.max(0, (elapsed - fallSeconds - holdSeconds) / riseSeconds));
}
