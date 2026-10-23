// Pure analysis for tools/verify/probe-weak-gpu.mjs: selecting game presentations among requestAnimationFrame samples,
// comparing two fixed-scenario runs and reading an adaptive run's frame series. No browser, no clock;
// tools/verify/test/weak-gpu-analysis.test.mjs covers it.

const setDiff = (a, b) => ({ onlyHere: a.filter(x => !b.includes(x)), onlyBaseline: b.filter(x => !a.includes(x)) });
const differences = sets => Object.fromEntries(sets.map(([k, a, b]) => [k, setDiff(a, b)]).filter(([, d]) => d.onlyHere.length || d.onlyBaseline.length));
const change = (now, then) => (then ? +(((now - then) / then) * 100).toFixed(1) : null);
const complete = cells => !!cells && Array.isArray(cells.detail) && Array.isArray(cells.fallback);
const gaps = times => times.slice(1).map((t, i) => t - times[i]);

/**
 * A frame-interval median that measures something: a finite positive number. A window with fewer than two
 * presentations (too short a --seconds, or a stalled game) has a null median and is an insufficient measurement.
 */
export const usableMedian = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Nearest-rank percentile of a list of milliseconds, rounded to 0.1 ms; null for an empty list. */
export function percentile(list, q) {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1) : null;
}

/**
 * Game presentations among requestAnimationFrame samples `{ now, frameTime }`: the rAF timestamp and the game's
 * `presentation().frameTime`, the `now` of its last `Game.frame()` call. A sample whose frameTime differs from the
 * previous sample's is a presentation stamped with that frameTime; the first sample counts only when the game presented
 * on that very tick (frameTime === now), so a presentation from before the window never opens it. A paced run
 * (`?fps=30|60`, `?mobile=1`) skips ticks, so it presents less often than rAF ticks; an uncapped run presents on every
 * tick, and then the presentation intervals are exactly the rAF intervals.
 */
export function presentationIntervals(samples) {
  const presentationTimes = [];
  samples.forEach((sample, i) => {
    const time = sample.frameTime;
    if (!Number.isFinite(time)) return;
    if (i === 0 ? time === sample.now : time !== samples[i - 1].frameTime) presentationTimes.push(time);
  });
  return { presentationTimes, presentationIntervals: gaps(presentationTimes), rafTickIntervals: gaps(samples.map(s => s.now)) };
}

/**
 * The fixed scenario's frame figures: presented frames (intervals between consecutive presentations) with their median
 * and p90, and, under their own names, the raw rAF tick cadence. Before this split the probe reported the rAF ticks as
 * `frames` / `rafMedianMs` / `rafP90Ms`.
 */
export function summariseFrames(samples) {
  const { presentationIntervals: presented, rafTickIntervals: ticks } = presentationIntervals(samples);
  return { presentedFrames: presented.length, presentationMedianMs: percentile(presented, .5), presentationP90Ms: percentile(presented, .9),
    rafTicks: ticks.length, rafTickMedianMs: percentile(ticks, .5), rafTickP90Ms: percentile(ticks, .9) };
}

const MEASURES = {
  presentations: 'presentations',
  'rafTicks-uncapped': 'older probe: rAF ticks of an uncapped run, each tick a presentation',
  'rafTicks-paced': 'older probe: rAF ticks of a paced run, not presentations',
  'rafTicks-unknown': 'older probe: rAF ticks of a run without a readable URL, pacing unknown',
};

/**
 * The URL the probe loads: `--url` with its own parameters kept, then the probe's fixed parameters and the `--query`
 * pairs applied with `searchParams.set()`, so the last value of a repeated key wins. `set()` also collapses duplicates,
 * so `searchParams.get()` on the written URL returns the value the page saw.
 */
export function measuredUrl(base, fixed, query) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(fixed)) url.searchParams.set(key, value);
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
  return url.href;
}

/**
 * Whether a measured URL paced the game, by the game's own rule (apps/game/src/config.ts): an `fps` of exactly 30 or 60,
 * or `mobile=1`, which defaults to 30 FPS; any other `fps` is ignored. The game reads `URLSearchParams.get()`, so this
 * does too. 'paced', 'uncapped', or null when the URL is missing or unparsable.
 */
export function urlPacing(href) {
  let params;
  try { params = new URL(href).searchParams; } catch { return null; }
  return params.get('mobile') === '1' || ['30', '60'].includes(params.get('fps')) ? 'paced' : 'uncapped';
}

/**
 * The frame-interval measure a fixed-scenario spot provides: game presentations, or in results of the older probe the
 * rAF ticks (`rafMedianMs`). Those equal presentations only when the run's effective measured URL (`run.url`, written
 * after the probe applied --url and --query) did not pace the game. Never `result.query`: --url can carry pacing too.
 */
export function frameMeasure(run, spot) {
  if (spot.presentationMedianMs !== undefined) return { measure: 'presentations', medianMs: spot.presentationMedianMs };
  if (spot.rafMedianMs === undefined) return null;
  const pacing = urlPacing(spot.url ?? run.url);
  return { measure: pacing === null ? 'rafTicks-unknown' : `rafTicks-${pacing}`, medianMs: spot.rafMedianMs };
}

/**
 * One row per preset and spot of either run. Residency is proven only when both sides report complete resident sets
 * (`residentCells()`): then `residentIdentical` is true or false and `residentDifferences` lists each stream's
 * difference. Otherwise `residentIdentical` is null, `residencyProven` false, and the rendered cells are compared
 * instead (`renderedIdentical`, informational: equal visible subsets do not establish equal residency). Spots or presets
 * measured on one side only are explicit `missingInBaseline` / `missingHere` rows. `frameIntervalMs` names the measure of
 * each side (`frameMeasure`); an older run's rAF ticks are compared only when its URL shows it was not paced, otherwise
 * the change is null.
 */
export function compareRuns(current, previous) {
  const rows = [];
  for (const run of current.runs) {
    const other = previous.runs.find(r => r.preset === run.preset);
    for (const spot of run.spots ?? []) {
      const base = other?.spots?.find(s => s.label === spot.label);
      if (!base) { rows.push({ preset: run.preset, label: spot.label, missingInBaseline: true }); continue; }
      const now = spot.after ?? spot, then = base.after ?? base;
      const proven = complete(now.residentCells) && complete(then.residentCells);
      const residency = proven
        ? (diff => ({ residentSource: 'residentCells', residencyProven: true, residentIdentical: Object.keys(diff).length === 0, residentDifferences: diff }))(
          differences(['detail', 'fallback'].map(k => [k, now.residentCells[k], then.residentCells[k]])))
        : (diff => ({ residentSource: 'renderedCells', residencyProven: false, residentIdentical: null,
          renderedIdentical: Object.keys(diff).length === 0, renderedDifferences: diff }))(differences([['rendered', now.renderedCells ?? [], then.renderedCells ?? []]]));
      rows.push({ preset: run.preset, label: spot.label, ...residency,
        textureMiB: { here: now.textureMemory.mib, baseline: then.textureMemory.mib, changePercent: change(now.textureMemory.mib, then.textureMemory.mib) },
        byClass: { here: now.textureMemory.byClass, baseline: then.textureMemory.byClass },
        uploads: { here: now.uploads, baseline: then.uploads }, textureFormats: { here: now.textureFormats, baseline: then.textureFormats },
        ...frameIntervalRow(frameMeasure(run, spot), frameMeasure(other, base)) });
    }
  }
  for (const base of previous.runs) {
    const mine = current.runs.find(r => r.preset === base.preset);
    for (const spot of base.spots ?? []) {
      if (!mine?.spots?.some(s => s.label === spot.label)) rows.push({ preset: base.preset, label: spot.label, missingHere: true });
    }
  }
  return { here: current.label, baseline: previous.label, transcode: { here: current.runs[0]?.transcode ?? null, baseline: previous.runs[0]?.transcode ?? null }, rows };
}

function frameIntervalRow(here, baseline) {
  if (!here || !baseline) return {};
  const comparable = [here, baseline].every(m => m.measure === 'presentations' || m.measure === 'rafTicks-uncapped');
  // A change needs a usable median on both sides: an insufficient measurement never reads as a 100 % improvement.
  const insufficientHere = !usableMedian(here.medianMs), insufficientBaseline = !usableMedian(baseline.medianMs);
  return { frameIntervalMs: { here: here.medianMs, baseline: baseline.medianMs, measureHere: here.measure, measureBaseline: baseline.measure,
    changePercent: comparable && !insufficientHere && !insufficientBaseline ? change(here.medianMs, baseline.medianMs) : null,
    insufficientHere, insufficientBaseline } };
}

function describeFrames(f) {
  const insufficient = f.insufficientHere && f.insufficientBaseline ? 'on both sides' : f.insufficientHere ? 'here' : f.insufficientBaseline ? 'in the baseline' : null;
  const changeText = insufficient ? `not comparable: insufficient measurement ${insufficient}` : f.changePercent === null ? 'not comparable' : `${f.changePercent} %`;
  if (insufficient) {
    const value = v => (usableMedian(v) ? `${v} ms` : `unavailable (${v})`);
    return `; median ${value(f.baseline)} (${MEASURES[f.measureBaseline]}) -> ${value(f.here)} (${MEASURES[f.measureHere]}) (${changeText})`;
  }
  if (f.measureHere === 'presentations' && f.measureBaseline === 'presentations') return `; presentation median ${f.baseline} -> ${f.here} ms (${changeText})`;
  return `; median ${f.baseline} ms (${MEASURES[f.measureBaseline]}) -> ${f.here} ms (${MEASURES[f.measureHere]}) (${changeText})`;
}

/** The console line for one comparison row: "identical" only for proven complete resident sets. */
export function describeRow(row) {
  if (row.missingInBaseline) return `${row.preset} ${row.label}: not in the baseline run`;
  if (row.missingHere) return `${row.preset} ${row.label}: only in the baseline run`;
  const sets = !row.residencyProven
    ? `residency unproven (no complete residentCells on both sides; compared renderedCells instead: ${row.renderedIdentical ? 'same rendered cells' : `rendered cells differ ${JSON.stringify(row.renderedDifferences)}`})`
    : row.residentIdentical ? `resident sets identical (${row.residentSource})` : `resident sets DIFFER (${row.residentSource}): ${JSON.stringify(row.residentDifferences)}`;
  return `${row.preset} ${row.label}: ${sets}; texture ${row.textureMiB.baseline} -> ${row.textureMiB.here} MiB (${row.textureMiB.changePercent} %)`
    + (row.frameIntervalMs ? describeFrames(row.frameIntervalMs) : '');
}

/**
 * The fixed scenario's in-page sampler, passed to `page.evaluate(sampleFrames, ms)`. Playwright serialises it by its
 * source, so it may use only page globals (`window.__HELSINKI_GAME__`, `performance`, `requestAnimationFrame`).
 * Before the first tick it checks that the review API's `presentation()` returns a numeric `frameTime` and rejects
 * otherwise; it then records `{ now, frameTime }` at every rAF tick for `duration` ms, and any exception in a tick
 * rejects the promise instead of leaving it pending.
 */
export function sampleFrames(duration) {
  return new Promise((resolve, reject) => {
    const api = window.__HELSINKI_GAME__;
    if (typeof api?.presentation !== 'function') {
      reject(new Error('incompatible review shell: window.__HELSINKI_GAME__.presentation() is missing'));
      return;
    }
    try {
      const probe = api.presentation();
      if (typeof probe?.frameTime !== 'number' || !Number.isFinite(probe.frameTime)) throw new Error(`incompatible review shell: presentation().frameTime is ${probe?.frameTime}`);
    } catch (error) { reject(error); return; }
    const samples = [], start = performance.now();
    const loop = now => {
      try {
        samples.push({ now, frameTime: api.presentation().frameTime });
        if (now - start < duration) requestAnimationFrame(loop); else resolve(samples);
      } catch (error) { reject(error); }
    };
    requestAnimationFrame(loop);
  });
}

/**
 * The adaptive scenario's in-page sampler, passed to `page.evaluate(sampleAdaptive, ms)`; like `sampleFrames` it may use
 * only page globals. Before the first tick it checks that the review API's `stats()` returns finite numeric
 * `resolutionScale` and `frameIntervalMs` and rejects otherwise; it then records `{ t, scale, tier, intervalMs }` at every
 * rAF tick for `duration` ms (`t` in seconds from the start, `intervalMs` the game's own frame interval), and any
 * exception or non-numeric reading in a tick rejects the promise instead of leaving it pending.
 */
export function sampleAdaptive(duration) {
  return new Promise((resolve, reject) => {
    const api = window.__HELSINKI_GAME__;
    if (typeof api?.stats !== 'function') {
      reject(new Error('incompatible review shell: window.__HELSINKI_GAME__.stats() is missing'));
      return;
    }
    const read = () => {
      const stats = api.stats();
      for (const key of ['resolutionScale', 'frameIntervalMs']) {
        if (typeof stats?.[key] !== 'number' || !Number.isFinite(stats[key])) throw new Error(`incompatible review shell: stats().${key} is ${stats?.[key]}`);
      }
      return stats;
    };
    try { read(); } catch (error) { reject(error); return; }
    const samples = [], start = performance.now();
    const loop = now => {
      try {
        const stats = read();
        samples.push({ t: +((now - start) / 1000).toFixed(3), scale: stats.resolutionScale, tier: stats.tier ?? null, intervalMs: +stats.frameIntervalMs.toFixed(1) });
        if (now - start < duration) requestAnimationFrame(loop); else resolve(samples);
      } catch (error) { reject(error); }
    };
    requestAnimationFrame(loop);
  });
}

/** Runs `setup` for a launched browser; on any failure closes the browser and rethrows the original error. */
export async function closeOnFailure(browser, setup) {
  try { return await setup(); } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/**
 * An adaptive run's per-frame series `{t, scale, tier}` against the game's configured resolution floor
 * (`config().resolutionFloor`). A frame is at the floor when `scale <= resolutionFloor + 1e-9`. `floorReachedAtSeconds`
 * is the first such frame (null if none, or if the floor is unknown); `secondsAtFloorBeforeChange` is the contiguous
 * time at the floor immediately before the first tier change (null without a change or without floor arrival).
 */
export function analyseAdaptive(frames, { resolutionFloor = null, startTier: fallbackTier = null } = {}) {
  const floor = Number.isFinite(resolutionFloor) ? resolutionFloor : null;
  const startTier = frames[0]?.tier ?? fallbackTier;
  const changeIndex = frames.findIndex(f => f.tier !== startTier), first = changeIndex >= 0 ? frames[changeIndex] : null;
  const atFloor = f => floor !== null && f.scale <= floor + 1e-9;
  const floorFrame = frames.find(atFloor) ?? null;
  let secondsAtFloorBeforeChange = null;
  if (first && floorFrame && floorFrame.t <= first.t) {
    let start = changeIndex;
    while (start > 0 && atFloor(frames[start - 1])) start--;
    secondsAtFloorBeforeChange = start < changeIndex ? +(first.t - frames[start].t).toFixed(3) : 0;
  }
  return { resolutionFloor: floor, startTier, firstChange: first && { atSeconds: first.t, tier: first.tier },
    lowestScale: frames.length ? Math.min(...frames.map(f => f.scale)) : null,
    floorReachedAtSeconds: floorFrame?.t ?? null, secondsAtFloorBeforeChange, tiers: [...new Set(frames.map(f => f.tier))] };
}
