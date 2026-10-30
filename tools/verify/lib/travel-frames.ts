import type { Page } from 'playwright';

interface TravelFrames {
  active: boolean;
  intervals: number[];
  movingIntervals: number[];
  overflow: number;
  error: string | null;
  worstMoving: { milliseconds: number; tick: number; position: number[] } | null;
}
declare global { interface Window { __travelFrames?: TravelFrames } }

/** Observe actual presented frames, including paced/skipped rAF ticks, without driving the simulation. */
export async function beginTravelFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__travelFrames?.active) throw new Error('Travel frame collector already active');
    const collector: TravelFrames = window.__travelFrames = {
      active: true, intervals: [], movingIntervals: [], overflow: 0, error: null, worstMoving: null,
    };
    let previousTime: number | null = null, previousPosition: number[] | null = null;
    const frame = () => {
      if (!collector.active) return;
      try {
        const presented = window.__HELSINKI_GAME__!.presentation();
        if (!Number.isFinite(presented.frameTime)) throw new Error('Missing native presentation frame time');
        if (previousTime !== null && presented.frameTime > previousTime) {
          const milliseconds = presented.frameTime - previousTime;
          if (collector.intervals.length < 1_000_000) {
            collector.intervals.push(milliseconds);
            const position = presented.player.position;
            if (previousPosition && Math.hypot(position[0]! - previousPosition[0]!, position[2]! - previousPosition[2]!) > 1e-4) {
              collector.movingIntervals.push(milliseconds);
              if (!collector.worstMoving || milliseconds > collector.worstMoving.milliseconds) {
                collector.worstMoving = { milliseconds, tick: presented.tick, position: [...position] };
              }
            }
          } else collector.overflow++;
        }
        if (previousTime === null || presented.frameTime > previousTime) {
          previousTime = presented.frameTime; previousPosition = [...presented.player.position];
        }
        requestAnimationFrame(frame);
      } catch (error) { collector.error = String(error); collector.active = false; }
    };
    requestAnimationFrame(frame);
  });
}

export function summarizeTravelIntervals(intervals: readonly number[]) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
  return { samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maximumMs: sorted.at(-1) ?? null };
}

export async function finishTravelFrames(page: Page) {
  const data = await page.evaluate(() => {
    const collector = window.__travelFrames;
    if (!collector) throw new Error('Travel frame collector missing');
    collector.active = false;
    return collector;
  });
  return { status: !data.error && !data.overflow && data.intervals.length > 0 ? 'CAPTURED' : 'INCOMPLETE',
    semantics: 'Exact nearest-rank percentiles of changes in native presentation().frameTime; unchanged paced rAF ticks excluded. Moving means XZ displacement over 0.1 mm between presentations. This is diagnostic evidence, not a replacement for the native FPS gate.',
    all: summarizeTravelIntervals(data.intervals), moving: summarizeTravelIntervals(data.movingIntervals),
    worstMoving: data.worstMoving, overflow: data.overflow, error: data.error,
    rawPresentationIntervalsMs: data.intervals, rawMovingPresentationIntervalsMs: data.movingIntervals };
}
