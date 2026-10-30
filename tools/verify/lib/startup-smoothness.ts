// Pure parts of the startup-smoothness harness (verify-startup-smoothness.ts): the metric analysis of the in-page probe,
// the target URL guard and the mapping of pinned world URLs onto a local release directory.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { validatePayloadPath, validateReleaseId, validateWorldBaseUrl } from '../../../apps/game/src/world/urls.ts';
import { catalogs } from '../../../apps/game/src/i18n/catalog.ts';
import { TICK_HZ } from '../../../packages/sim/src/commands.ts';

/** Raw in-page record; every time is `performance.now()` of the measured document. */
export interface StartupProbe {
  clickAt: number | null;
  /** End of the scripted window (the 10 s drive released). */
  windowEnd: number | null;
  playEnabledAt: number | null;
  /** requestAnimationFrame timestamps (every callback, presented or not). */
  frames: number[];
  /** rAF timestamps in which the game canvas `#view` issued at least one draw call (presented frames). */
  presented: number[];
  /** [frame time, simulation tick] while the review test API exists. */
  ticks: [number, number][];
  /** [link time, SHADER_NAME, defines] per linkProgram. */
  programs: [number, string, string][];
  /** [start, WebGL method, duration ms, detail] for calls of 0.5 ms or more. */
  gl: [number, string, number, string][];
  longTasks: [number, number][];
  /** First rendered frame after the click in which most object modelView translations differ from the previous rendered frame. */
  viewChangedAt: number | null;
  /** [time, AudioContext index in creation order, state] at construction and on every state change. */
  audio: [number, number, string][];
}

export interface StartupWaits { modelWaitSeconds: number | null; collisionWaitSeconds: number | null; consoleErrors: number }
/** INVALID: the scenario did not complete, so the run cannot certify anything. */
export type ThresholdStatus = 'PASS' | 'FAIL' | 'N/A' | 'INVALID';
/** Stages of the scripted run that failed (empty: complete); with --world-dir, the settled egress accounting. */
export interface StartupRun { scenarioFailures: readonly string[]; egress?: EgressSummary | null }
export interface Threshold { id: string; criterion: string; status: ThresholdStatus; detail: string }

export const LIMITS = { slowCallMs: 5, maxFrameMs: 50, firstMovingTickMs: 100, first15sMs: 15000 } as const;

const percentile = (sorted: readonly number[], p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Presented-frame intervals overlapping (from, to). The interval spanning `from` counts only from `from` to the first
 * presented frame after it (the paused pre-Play loop presents every 250 ms by design); the one spanning `to` counts whole.
 * Covered: the rAF sampler ran by `from` and a frame was presented at or after `to`.
 */
function presentedIntervals(raf: readonly number[], presented: readonly number[], from: number, to: number): { values: number[]; covered: boolean } {
  const sorted = [...presented].sort((a, b) => a - b), values: number[] = [];
  let previous = -Infinity;
  for (const t of sorted) { if (t > from && previous < to) values.push(round(t - Math.max(previous, from))); previous = t; }
  const sampledFrom = raf.reduce((min, t) => Math.min(min, t), Infinity) <= from;
  return { values: values.sort((a, b) => a - b), covered: sampledFrom && sorted.length > 0 && sorted.at(-1)! >= to };
}

/** Raw rAF intervals overlapping (from, to), including those spanning either boundary, and whether samples cover both boundaries. */
function intervals(frames: readonly number[], from: number, to: number): { values: number[]; covered: boolean } {
  const sorted = [...frames].sort((a, b) => a - b), values: number[] = [];
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! > from && sorted[i - 1]! < to) values.push(round(sorted[i]! - sorted[i - 1]!));
  return { values: values.sort((a, b) => a - b), covered: sorted.length > 1 && sorted[0]! <= from && sorted.at(-1)! >= to };
}

function audioSummary(audio: StartupProbe['audio'], click: number, end: number) {
  const byContext = new Map<number, [number, string][]>();
  for (const [t, index, state] of [...audio].sort((a, b) => a[0] - b[0])) if (t <= end) byContext.set(index, [...byContext.get(index) ?? [], [t, state]]);
  let runningAfterPlayMs: number | null = null, finalState: string | null = null, createdBeforePlay = 0, lastCreated = -Infinity;
  for (const entries of byContext.values()) {
    if (entries[0]![0] < click) createdBeforePlay++;
    if (entries[0]![0] >= lastCreated) { lastCreated = entries[0]![0]; finalState = entries.at(-1)![1]; }
    const atClick = entries.filter(([t]) => t < click).at(-1)?.[1];
    const resumed = entries.find(([t, s]) => t >= click && s === 'running');
    const ms = atClick === 'running' ? 0 : resumed ? round(resumed[0] - click) : null;
    if (ms !== null) runningAfterPlayMs = runningAfterPlayMs === null ? ms : Math.min(runningAfterPlayMs, ms);
  }
  return { contexts: byContext.size, createdBeforePlay, runningAfterPlayMs, finalState };
}

/** Metrics after the Play click and the pass/fail of each AC-2..AC-6 threshold. */
export function analyzeStartup(probe: StartupProbe, waits: StartupWaits, run: StartupRun = { scenarioFailures: [] }) {
  if (probe.clickAt === null) throw new Error('The Play click was not recorded');
  const click = probe.clickAt, end = probe.windowEnd ?? Infinity;
  const inWindow = (t: number) => t >= click && t <= end;
  const first15Window = presentedIntervals(probe.frames, probe.presented, click, click + LIMITS.first15sMs);
  const scriptedWindow = presentedIntervals(probe.frames, probe.presented, click, end);
  const first15 = first15Window.values, scripted = scriptedWindow.values;
  const rafFirst15 = intervals(probe.frames, click, click + LIMITS.first15sMs).values, rafScripted = intervals(probe.frames, click, end).values;
  const programsAfterPlay = probe.programs.filter(([t]) => inWindow(t)).sort((a, b) => a[0] - b[0]).map(([t, name, defines]) => ({ t: round(t - click), name, defines }));
  const slowGlCallsAfterPlay = probe.gl.filter(([t, , ms]) => inWindow(t) && ms >= LIMITS.slowCallMs).sort((a, b) => a[0] - b[0])
    .map(([t, name, ms, detail]) => ({ t: round(t - click), name, ms, detail }));
  const tickAtClick = probe.ticks.filter(([t]) => t <= click).at(-1)?.[1] ?? probe.ticks[0]?.[1];
  const moved = tickAtClick === undefined ? undefined : probe.ticks.find(([t, tick]) => t > click && tick > tickAtClick);
  const firstViewChangeMs = probe.viewChangedAt !== null && probe.viewChangedAt >= click ? round(probe.viewChangedAt - click) : null;
  const firstMovingTick: { ms: number | null; method: 'test-api-tick' | 'view-change' | 'unavailable' } = probe.ticks.length
    ? { ms: moved ? round(moved[0] - click) : null, method: 'test-api-tick' }
    : firstViewChangeMs !== null ? { ms: firstViewChangeMs, method: 'view-change' } : { ms: null, method: 'unavailable' };
  const audio = audioSummary(probe.audio, click, end);
  const maxWindow = scripted.at(-1) ?? null;
  const thresholds: Threshold[] = [];
  const add = (id: string, criterion: string, status: ThresholdStatus, detail: string) => thresholds.push({ id, criterion, status, detail });
  add('programs-after-play', 'AC-2', programsAfterPlay.length === 0 ? 'PASS' : 'FAIL',
    `${programsAfterPlay.length} programs linked in the scripted window${programsAfterPlay.length ? `: ${programsAfterPlay.map(p => `${p.name} +${p.t} ms`).join(', ')}` : ''}`);
  add('slow-gl-calls', 'AC-2', slowGlCallsAfterPlay.length === 0 ? 'PASS' : 'FAIL',
    `${slowGlCallsAfterPlay.length} WebGL calls >= ${LIMITS.slowCallMs} ms${slowGlCallsAfterPlay.length ? `, worst ${Math.max(...slowGlCallsAfterPlay.map(c => c.ms))} ms` : ''}`);
  const covered = scriptedWindow.covered && first15Window.covered;
  add('max-frame-window', 'AC-6', covered && maxWindow !== null && maxWindow <= LIMITS.maxFrameMs ? 'PASS' : 'FAIL',
    `${maxWindow === null ? 'no presented frame intervals in the scripted window' : `max presented frame interval ${maxWindow} ms (limit ${LIMITS.maxFrameMs} ms)`}`
    + `${covered ? '' : '; presented frames do not cover the scripted window and the first 15 s'}`);
  add('first-moving-tick', 'AC-5', firstMovingTick.method === 'unavailable' ? 'N/A' : firstMovingTick.ms !== null && firstMovingTick.ms <= LIMITS.firstMovingTickMs ? 'PASS' : 'FAIL',
    firstMovingTick.method === 'unavailable' ? 'no tick or view-change signal' : `${firstMovingTick.ms ?? 'never'} ms by ${firstMovingTick.method} (limit ${LIMITS.firstMovingTickMs} ms)`);
  add('model-wait', 'AC-4', waits.modelWaitSeconds === null ? 'N/A' : waits.modelWaitSeconds === 0 ? 'PASS' : 'FAIL',
    waits.modelWaitSeconds === null ? 'test API absent' : `simulation blocked ${round(waits.modelWaitSeconds)} s on deferred models`);
  add('audio-running', 'AC-5', audio.runningAfterPlayMs !== null ? 'PASS' : 'FAIL',
    audio.contexts ? `AudioContext ${audio.finalState}${audio.runningAfterPlayMs !== null ? `, running ${audio.runningAfterPlayMs} ms after Play` : ''}` : 'no AudioContext created');
  add('console-errors', 'AC-5', waits.consoleErrors === 0 ? 'PASS' : 'FAIL', `${waits.consoleErrors} console errors`);
  if (run.egress) add('world-local-only', 'AC-1', run.egress.localOnly ? 'PASS' : 'FAIL',
    `${run.egress.isolated ? 'transport isolation active' : 'no transport isolation'}; ${run.egress.answeredLocally} answered locally, `
    + `${run.egress.egress} sent off loopback (${run.egress.worldEgress} world), ${run.egress.pending} unsettled`);
  if (run.scenarioFailures.length) for (const t of thresholds) { t.status = 'INVALID'; t.detail = `scenario incomplete (${run.scenarioFailures.join(', ')}); ${t.detail}`; }
  return {
    timeToPlayEnabledMs: probe.playEnabledAt === null ? null : round(probe.playEnabledAt),
    scenario: { complete: run.scenarioFailures.length === 0, failedStages: [...run.scenarioFailures] },
    frames: {
      basis: 'presented frames (rAF callbacks with a draw call on #view)',
      presentedAfterPlay: probe.presented.filter(t => inWindow(t)).length,
      coverage: { first15s: first15Window.covered, scriptedWindow: scriptedWindow.covered },
      first15s: { samples: first15.length, p50Ms: percentile(first15, 0.5), p99Ms: percentile(first15, 0.99), maxMs: first15.at(-1) ?? null },
      scriptedWindow: { samples: scripted.length, p99Ms: percentile(scripted, 0.99), maxMs: maxWindow, ms: probe.windowEnd === null ? null : round(probe.windowEnd - click) },
      raf: {
        first15s: { samples: rafFirst15.length, p50Ms: percentile(rafFirst15, 0.5), p99Ms: percentile(rafFirst15, 0.99), maxMs: rafFirst15.at(-1) ?? null },
        scriptedWindow: { samples: rafScripted.length, p99Ms: percentile(rafScripted, 0.99), maxMs: rafScripted.at(-1) ?? null },
      },
    },
    programsBeforePlay: probe.programs.filter(([t]) => t < click).length,
    programsAfterPlay, slowGlCallsAfterPlay,
    longTasksAfterPlay: probe.longTasks.filter(([t]) => inWindow(t)).map(([t, ms]) => ({ t: round(t - click), ms: round(ms) })),
    firstMovingTick, firstViewChangeMs,
    modelWaitSeconds: waits.modelWaitSeconds, collisionWaitSeconds: waits.collisionWaitSeconds,
    audio, thresholds,
  };
}

/**
 * Closed acceptance definition of the drive stage (decision D-10, reviews/05-finding-validation.md). Times are page
 * `performance.now()` ms after the received W keydown; T is keydown to keyup.
 */
export const DRIVE = {
  minMs: 10000, maxMs: 10500, sampleMs: 250, maxSampleGapMs: 500,
  apiMaxAdvanceGapMs: 500, hudMaxAdvanceGapMs: 1000, hudFinalWindowMs: 1000, minTickShare: 0.5,
  minDisplacementM: 10, minMovingShare: 0.5, minViewChanges: 10, maxMovingWithoutViewMs: 1000,
} as const;

/** Test API reading at one drive sample. */
export interface ApiDriveReading { tick: number; mode: string; inVehicle: string | null; car: readonly number[] | null }
/** HUD reading at one drive sample: a speed and an empty prompt (driving), the speed and the `#stats` tick. */
export interface HudDriveReading { driving: boolean; speedKmh: number | null; tick: number | null }
export interface DriveSample {
  t: number;
  /** Pause menu visible; null when it could not be read. */
  paused: boolean | null;
  /** Test-API branch only; null when the API reading was lost. */
  api?: ApiDriveReading | null;
  hud: HudDriveReading | null;
}
export interface DriveRecord {
  /** Chosen once at the drive start; losing the API later never falls back to the production branch. */
  branch: 'test-api' | 'production';
  target: string;
  /** Received W keydown to keyup; null when either was not received. */
  T: number | null;
  /** Start, every 250 ms and the release, strictly increasing. */
  samples: readonly DriveSample[];
  /** Pause-menu visibility latched in the page on every class change: [t, visible]. */
  pauseTransitions: readonly (readonly [number, boolean])[];
  /** Presented #view frames in which most persistent draws moved. */
  viewChangeTimes: readonly number[];
}

/** Largest gap in [0, ...times where the counter advanced, T]; `decreased` when the counter ever fell. */
export function maxAdvanceGap(times: readonly number[], counter: readonly number[], T: number): { gapMs: number; decreased: boolean } {
  const points = [0];
  let decreased = false;
  for (let i = 1; i < counter.length; i++) {
    if (counter[i]! < counter[i - 1]!) decreased = true;
    else if (counter[i]! > counter[i - 1]!) points.push(Math.min(Math.max(times[i]!, 0), T));
  }
  points.push(T);
  let gapMs = 0;
  for (let i = 1; i < points.length; i++) gapMs = Math.max(gapMs, points[i]! - points[i - 1]!);
  return { gapMs: round(gapMs), decreased };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Whether the drive progressed under D-10; every failed predicate is named. */
export function driveVerdict(r: DriveRecord) {
  const problems: string[] = [];
  const T = finite(r.T) ? r.T : null;
  const metrics: Record<string, number | boolean | string | null> = { branch: r.branch, T };
  if (T === null || T < DRIVE.minMs || T > DRIVE.maxMs) problems.push(`drive duration ${T ?? 'unrecorded'} ms is outside ${DRIVE.minMs}-${DRIVE.maxMs} ms`);
  const end = T ?? 0, s = r.samples, times = s.map(x => x.t);
  if (!s.length || !times.every(finite)) problems.push('drive samples or their timestamps are missing');
  else {
    let gap = times[0]!, increasing = true;
    for (let i = 1; i < times.length; i++) { if (times[i]! <= times[i - 1]!) increasing = false; gap = Math.max(gap, times[i]! - times[i - 1]!); }
    metrics.maxSampleGapMs = round(gap);
    if (!increasing) problems.push('drive sample timestamps do not strictly increase');
    if (times[0]! < 0 || gap > DRIVE.maxSampleGapMs) problems.push(`drive sampling gap ${round(gap)} ms exceeds ${DRIVE.maxSampleGapMs} ms`);
    if (times.at(-1)! < end) problems.push('no drive sample at the release');
  }
  const pauseLatched = r.pauseTransitions.some(([t, visible]) => visible && t >= 0 && t <= end);
  metrics.pauseSeen = s.some(x => x.paused === true) || pauseLatched;
  if (s.some(x => x.paused === null)) problems.push('the pause state could not be read');
  if (metrics.pauseSeen) problems.push('the session was paused during the drive');
  const minTicks = Math.ceil(DRIVE.minTickShare * TICK_HZ * end / 1000);
  metrics.minTicks = minTicks;
  const counterChecks = (ticks: number[], maxGap: number, label: string) => {
    const { gapMs, decreased } = maxAdvanceGap(times, ticks, end);
    metrics.maxAdvanceGapMs = gapMs;
    metrics.tickAdvance = ticks.at(-1)! - ticks[0]!;
    if (decreased) problems.push(`the ${label} tick decreased`);
    if (gapMs > maxGap) problems.push(`the ${label} tick did not advance for ${gapMs} ms (maximum ${maxGap} ms)`);
    if (ticks.at(-1)! - ticks[0]! < minTicks) problems.push(`the ${label} tick advanced ${ticks.at(-1)! - ticks[0]!} (minimum ${minTicks})`);
  };
  if (r.branch === 'test-api') {
    const api = s.map(x => x.api);
    if (!api.length || api.some(a => !a || !finite(a.tick) || !a.car || a.car.length < 3 || !a.car.every(finite))) problems.push('a test API reading (tick or car position) is missing');
    else {
      const readings = api as ApiDriveReading[];
      if (readings.some(a => a.mode !== 'driving' || a.inVehicle !== r.target)) problems.push(`a sample does not show the player driving ${r.target}`);
      const ticks = readings.map(a => a.tick);
      counterChecks(ticks, DRIVE.apiMaxAdvanceGapMs, 'simulation');
      metrics.finalIntervalAdvance = ticks.length > 1 ? ticks.at(-1)! - ticks.at(-2)! : null;
      if (ticks.length < 2 || ticks.at(-1)! <= ticks.at(-2)!) problems.push('the simulation tick did not advance in the final sampling interval');
      const a = readings[0]!.car!, b = readings.at(-1)!.car!;
      const displacement = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
      metrics.displacementM = round(displacement);
      if (displacement < DRIVE.minDisplacementM) problems.push(`${r.target} moved ${round(displacement)} m (minimum ${DRIVE.minDisplacementM} m)`);
    }
  } else {
    const hud = s.map(x => x.hud);
    if (!hud.length || hud.some(h => !h || !finite(h.tick) || !finite(h.speedKmh))) problems.push('a HUD reading (speed or #stats tick) is missing');
    else {
      const readings = hud as HudDriveReading[];
      if (readings.some(h => !h.driving)) problems.push('a sample does not show a driving HUD');
      const ticks = readings.map(h => h.tick!);
      counterChecks(ticks, DRIVE.hudMaxAdvanceGapMs, 'HUD');
      const from = times.findIndex(t => t >= end - DRIVE.hudFinalWindowMs);
      metrics.finalWindowAdvance = from < 0 ? null : ticks.at(-1)! - ticks[from]!;
      if (from < 0 || ticks.at(-1)! <= ticks[from]!) problems.push(`the HUD tick did not advance in the final ${DRIVE.hudFinalWindowMs} ms`);
      // Each speed reading holds until the next reading.
      const moving: [number, number][] = [];
      let movingMs = 0;
      for (let i = 0; i + 1 < readings.length; i++) if (readings[i]!.speedKmh! > 0) { moving.push([times[i]!, times[i + 1]!]); movingMs += times[i + 1]! - times[i]!; }
      const sampledMs = times.at(-1)! - times[0]!;
      metrics.movingShare = sampledMs > 0 ? round(movingMs / sampledMs) : null;
      if (sampledMs <= 0 || movingMs < DRIVE.minMovingShare * sampledMs) problems.push(`the HUD speed was non-zero for ${round(movingMs)} of ${round(sampledMs)} ms`);
      const views = r.viewChangeTimes.filter(t => t >= 0 && t <= end).sort((x, y) => x - y);
      metrics.viewChanges = views.length;
      if (views.length < DRIVE.minViewChanges) problems.push(`${views.length} rendered view changes (minimum ${DRIVE.minViewChanges})`);
      const bounds = [0, ...views, end];
      let worst = 0;
      for (let i = 1; i < bounds.length; i++) {
        let overlap = 0;
        for (const [a, b] of moving) overlap += Math.max(0, Math.min(b, bounds[i]!) - Math.max(a, bounds[i - 1]!));
        worst = Math.max(worst, overlap);
      }
      metrics.maxMovingWithoutViewMs = round(worst);
      if (worst > DRIVE.maxMovingWithoutViewMs) problems.push(`the view did not change for ${round(worst)} ms of moving time (maximum ${DRIVE.maxMovingWithoutViewMs} ms)`);
    }
  }
  return { ok: problems.length === 0, problems, metrics };
}

/** `moved` with the test API: the player's horizontal displacement from the position at the click (a tick advance is not movement). */
export function playerMoved(atClick: readonly number[], now: readonly number[]) {
  const displacementM = Math.hypot(now[0]! - atClick[0]!, now[2]! - atClick[2]!);
  return { displacementM: round(displacementM), moved: Number.isFinite(displacementM) && displacementM >= 0.5 };
}

/**
 * In-page view-change test (passed into the init script as source, so it stays self-contained): keys are one draw each
 * (program and its draw index within the frame), values its modelView translation. Most of at least 20 draws present in
 * both consecutive presented frames must have moved; newly streamed or disjoint draws never count.
 */
export function persistentViewsMoved(previous: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): boolean {
  let persistent = 0, moved = 0;
  for (const [key, value] of current) {
    const before = previous.get(key);
    if (before === undefined) continue;
    persistent++;
    if (before !== value) moved++;
  }
  return persistent >= 20 && moved > persistent / 2;
}

/** Production `reachedCar`: only the localized enter prompt of the page's active locale (en or fi) counts. */
export function enterPromptShown(prompt: string, language: string): boolean {
  const catalog = language === 'en' || language === 'fi' ? catalogs[language] : null;
  return !!catalog && (prompt === catalog['interaction.enter'] || prompt === catalog['touch.promptEnter']);
}

/** Test API proximity and entry, bound to the target vehicle; entering another car is `other`. */
export const apiNearTarget = (player: { mode: string; nearVehicle: string | null }, target: string) => player.mode === 'onFoot' && player.nearVehicle === target;
export function apiEntry(player: { mode: string; inVehicle: string | null }, target: string): 'entered' | 'other' | 'pending' {
  if (player.mode === 'driving' && player.inVehicle === target) return 'entered';
  return player.inVehicle !== null && player.inVehicle !== target ? 'other' : 'pending';
}

/** Shots observed for the single-shot stage: the test API fire events when present, else the HUD magazine drop. */
export function shotSummary(magazineBefore: number | null, magazineAfter: number | null, apiFireEvents: number | null) {
  const hudShots = magazineBefore === null || magazineAfter === null ? null : magazineBefore - magazineAfter;
  const count = apiFireEvents ?? hudShots;
  return { hudShots, apiShots: apiFireEvents, count, exactlyOne: count === 1 };
}

/**
 * The result.json assembly the harness uses: stages in scenario order; any failed stage makes the run INCOMPLETE (exit 2)
 * with every threshold INVALID, else MEASURED (exit 0, also when thresholds fail).
 */
export function assembleStartupResult<M extends Record<string, unknown>>(meta: M, probe: StartupProbe, waits: StartupWaits,
  stages: readonly (readonly [string, boolean])[], egress: EgressSummary | null) {
  const failures = stages.filter(([, ok]) => !ok).map(([name]) => name);
  const analysis = analyzeStartup(probe, waits, { scenarioFailures: failures, egress });
  const status: 'MEASURED' | 'INCOMPLETE' = failures.length ? 'INCOMPLETE' : 'MEASURED';
  return { result: { status, ...meta, ...analysis }, exitCode: failures.length ? 2 : 0, failures };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
export const isLoopbackUrl = (url: string | URL) => { try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; } };
const isOffLoopback = (url: string) => /^https?:/i.test(url) && !isLoopbackUrl(url);

/**
 * Chromium host-resolver rule for runs without --allow-live: no host but loopback resolves, so nothing the route does not
 * answer (redirect hops included) can leave the machine. Live runs are not isolated (null).
 */
export function transportIsolationRule(allowLive: boolean): string | null {
  return allowLive ? null : 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';
}

/** One request started in the browser context (page or service worker), as the harness saw it settle. */
export interface RequestRecord {
  url: string; answered: boolean; outcome: 'pending' | 'finished' | 'failed'; fromServiceWorker: boolean;
  initiator?: 'page' | 'service-worker'; redirected?: boolean;
}
export interface EgressSummary {
  isolated: boolean; observedOffLoopback: number; answeredLocally: number; serviceWorkerAnswered: number; egress: number; worldEgress: number; pending: number;
  localOnly: boolean; samples: string[];
}

/**
 * Off-loopback requests the harness did not fulfil or abort itself left the machine, including redirect hops the route
 * never saw. Excepted are page requests the service worker answered: finished from it, or, only under transport isolation
 * (a failed request then provably never left the machine), a cancelled page request that was not a redirect hop and whose
 * URL the route answered for the worker's own fetch. Unsettled requests are unknown, so they also refuse the local-only
 * claim, which also needs isolation.
 */
export function egressSummary(records: readonly RequestRecord[], worldBaseUrl: string | null, isolated: boolean): EgressSummary {
  const out: EgressSummary = { isolated, observedOffLoopback: 0, answeredLocally: 0, serviceWorkerAnswered: 0, egress: 0, worldEgress: 0, pending: 0, localOnly: true, samples: [] };
  const workerAnswered = new Set(records.filter(r => r.answered && r.initiator === 'service-worker').map(r => r.url));
  for (const r of records) {
    if (!isOffLoopback(r.url)) continue;
    out.observedOffLoopback++;
    if (r.answered) { out.answeredLocally++; continue; }
    if ((r.outcome === 'finished' && r.fromServiceWorker)
      || (isolated && r.outcome === 'failed' && r.initiator === 'page' && !r.redirected && workerAnswered.has(r.url))) { out.serviceWorkerAnswered++; continue; }
    if (r.outcome === 'pending') out.pending++;
    else { out.egress++; if (worldBaseUrl && r.url.startsWith(worldBaseUrl)) out.worldEgress++; }
    if (out.samples.length < 20) out.samples.push(`${r.outcome} ${r.initiator ?? '?'}${r.redirected ? ' redirect' : ''} ${r.url.slice(0, 200)}`);
  }
  out.localOnly = isolated && out.egress === 0 && out.pending === 0;
  return out;
}

/**
 * `--allow-live` is read-only: only GET/HEAD/OPTIONS on any host, loopback included (Playwright continues redirect hops
 * without the route, so a loopback POST answered by a 307 would reach the remote host), and the only off-loopback
 * navigation is the target page itself. Returns why a request must be aborted, or null.
 */
export function liveRequestBlock(r: { url: string; method: string; navigation: boolean; targetHref: string }): 'method' | 'navigation' | null {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method.toUpperCase())) return 'method';
  if (!isOffLoopback(r.url)) return null;
  return r.navigation && r.url !== r.targetHref ? 'navigation' : null;
}

/** The element under a click point, described in the page. */
export interface ClickTarget { tag: string; id: string; inPlayButton: boolean; inForm: boolean; pointerLockedCanvas: boolean }

/** Input goes only to the game's Play button (never inside a form) or the game canvas `#view`; returns the problem, or null. */
export function clickTargetProblem(target: ClickTarget | null, expected: 'play' | 'canvas'): string | null {
  if (!target) return 'no element at the click point';
  if (target.inForm) return 'the click target is inside a form';
  if (expected === 'play') return target.inPlayButton ? null : `the click target is not the Play button (${target.tag}#${target.id})`;
  return target.pointerLockedCanvas || (target.tag === 'CANVAS' && target.id === 'view') ? null : `the click target is not the game canvas (${target.tag}#${target.id})`;
}

/** AC-SEC-1: loopback servers only, unless `--allow-live`; never credentials or non-HTTP schemes. */
export function checkTargetUrl(value: string, allowLive: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('--url must be an absolute http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must be an http(s) URL');
  if (url.username || url.password) throw new Error('--url must not carry credentials');
  if (!LOOPBACK.has(url.hostname) && !allowLive) throw new Error('Only loopback URLs (127.0.0.1, localhost) are measured unless --allow-live is given');
  return url;
}

/**
 * Local file for a request under the pinned world base: `null` when the URL is not a world request, `missing` when it is
 * one but does not name a file inside `<worldBase><release>/` (answered 404 locally, never sent to the network).
 */
export function worldFileFor(requestUrl: string, worldBaseUrl: string, release: string, worldDir: string): { kind: 'file'; file: string } | { kind: 'missing' } | null {
  const base = validateWorldBaseUrl(worldBaseUrl), releaseBase = `${base}${validateReleaseId(release)}/`;
  if (!requestUrl.startsWith(base)) return null;
  if (!requestUrl.startsWith(releaseBase)) return { kind: 'missing' };
  let relative: string;
  try { relative = validatePayloadPath(requestUrl.slice(releaseBase.length)); } catch { return { kind: 'missing' }; }
  const root = path.resolve(worldDir), file = path.resolve(root, ...relative.split('/'));
  return file.startsWith(`${root}${path.sep}`) ? { kind: 'file', file } : { kind: 'missing' };
}

/** The real path of a mapped world file when it is a regular file inside the canonical (realpath) world root, else null. */
export function canonicalWorldFile(file: string, canonicalRoot: string): string | null {
  let real: string;
  try { real = realpathSync.native(file); } catch { return null; }
  if (!real.startsWith(`${canonicalRoot}${path.sep}`)) return null;
  try { return statSync(real).isFile() ? real : null; } catch { return null; }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.wasm': 'application/wasm', '.js': 'text/javascript', '.txt': 'text/plain',
};
export const contentTypeFor = (file: string) => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
