import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { english, finnish } from '../../../apps/game/src/i18n/catalog.ts';
import { analyzeStartup, apiEntry, apiNearTarget, assembleStartupResult, canonicalWorldFile, checkTargetUrl, clickTargetProblem, driveVerdict, egressSummary, enterPromptShown,
  liveRequestBlock, persistentViewsMoved, playerMoved, shotSummary, transportIsolationRule, worldFileFor, type DriveRecord, type DriveSample, type StartupProbe } from '../lib/startup-smoothness.ts';

// Unless a test paces presentation, every rAF callback presents a frame.
const probe = (over: Partial<StartupProbe> = {}): StartupProbe => ({
  clickAt: 1000, windowEnd: 17000, playEnabledAt: 900, frames: [], presented: over.frames ?? [], ticks: [], programs: [], gl: [], longTasks: [], viewChangedAt: null, audio: [], ...over,
});
const status = (analysis: ReturnType<typeof analyzeStartup>, id: string) => analysis.thresholds.find(t => t.id === id)?.status;
const steady = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

test('a smooth run with the test API passes every threshold', () => {
  const a = analyzeStartup(probe({ frames: steady(0, 17000, 10), ticks: [[995, 0], [1010, 0], [1040, 1], [1050, 2]],
    programs: [[500, 'MeshStandardMaterial', 'USE_MAP']], gl: [[600, 'linkProgram', 30, ''], [1500, 'texImage2D', 4.99, '256x256']] }),
  { modelWaitSeconds: 0, collisionWaitSeconds: 0.25, consoleErrors: 0 });
  assert.equal(a.timeToPlayEnabledMs, 900);
  assert.deepEqual(a.frames.first15s, { samples: 1500, p50Ms: 10, p99Ms: 10, maxMs: 10 });
  assert.equal(a.frames.scriptedWindow.maxMs, 10);
  assert.equal(a.programsBeforePlay, 1);
  assert.deepEqual(a.programsAfterPlay, []);
  assert.deepEqual(a.slowGlCallsAfterPlay, []);
  assert.deepEqual(a.firstMovingTick, { ms: 40, method: 'test-api-tick' });
  for (const id of ['programs-after-play', 'slow-gl-calls', 'max-frame-window', 'first-moving-tick', 'model-wait']) assert.equal(status(a, id), 'PASS', id);
});

test('stutters after Play fail the program, call, frame, tick and model thresholds', () => {
  const frames = [...steady(0, 1000, 10), 1271, ...steady(1281, 17000, 10)];
  const a = analyzeStartup(probe({ frames, ticks: [[990, 0], [1271, 0], [3000, 0], [4460, 1]],
    programs: [[1100, 'car_far', 'USE_COLOR'], [1180, 'character-rain-skin', 'USE_SKINNING,USE_MAP']],
    gl: [[1101, 'getProgramInfoLog', 66.4, ''], [1181, 'getProgramInfoLog', 105, ''], [1200, 'useProgram', 0.7, '']] }),
  { modelWaitSeconds: 3.45, collisionWaitSeconds: 0, consoleErrors: 0 });
  assert.deepEqual(a.programsAfterPlay, [{ t: 100, name: 'car_far', defines: 'USE_COLOR' }, { t: 180, name: 'character-rain-skin', defines: 'USE_SKINNING,USE_MAP' }]);
  assert.deepEqual(a.slowGlCallsAfterPlay.map(c => [c.t, c.name, c.ms]), [[101, 'getProgramInfoLog', 66.4], [181, 'getProgramInfoLog', 105]]);
  assert.equal(a.frames.scriptedWindow.maxMs, 271);
  assert.equal(a.frames.first15s.maxMs, 271);
  assert.deepEqual(a.firstMovingTick, { ms: 3460, method: 'test-api-tick' });
  for (const id of ['programs-after-play', 'slow-gl-calls', 'max-frame-window', 'first-moving-tick', 'model-wait']) assert.equal(status(a, id), 'FAIL', id);
});

test('boundaries: a 50 ms frame passes, a 5 ms call fails, a program 1 ms before Play is not counted but 1 ms after is', () => {
  const frames = [...steady(0, 2000, 10), 2050, ...steady(2060, 17000, 10)];
  const a = analyzeStartup(probe({ frames, programs: [[999, 'before', ''], [1001, 'after', '']], gl: [[1500, 'bufferData', 5, '1024'], [999, 'bufferData', 80, '1024']] }),
    { modelWaitSeconds: 0, collisionWaitSeconds: 0, consoleErrors: 0 });
  assert.equal(a.frames.scriptedWindow.maxMs, 50);
  assert.equal(status(a, 'max-frame-window'), 'PASS');
  assert.deepEqual(a.programsAfterPlay.map(p => p.name), ['after']);
  assert.equal(a.programsBeforePlay, 1);
  assert.deepEqual(a.slowGlCallsAfterPlay.map(c => c.ms), [5]);
  assert.equal(status(a, 'slow-gl-calls'), 'FAIL');
  const b = analyzeStartup(probe({ frames: [...steady(0, 2000, 10), 2050.01, ...steady(2060, 17000, 10)] }), { modelWaitSeconds: 0, collisionWaitSeconds: 0, consoleErrors: 0 });
  assert.equal(status(b, 'max-frame-window'), 'FAIL');
  const tick = (ms: number) => analyzeStartup(probe({ frames: steady(0, 17000, 10), ticks: [[1000, 5], [1000 + ms, 6]] }), { modelWaitSeconds: 0, collisionWaitSeconds: 0, consoleErrors: 0 });
  assert.equal(status(tick(100), 'first-moving-tick'), 'PASS');
  assert.equal(status(tick(101), 'first-moving-tick'), 'FAIL');
});

test('frames after the scripted window do not count against it; the interval spanning the click counts from the click', () => {
  const frames = [...steady(0, 990, 10), 1090, ...steady(1100, 17000, 10), 17500];
  const a = analyzeStartup(probe({ frames }), { modelWaitSeconds: 0, collisionWaitSeconds: 0, consoleErrors: 0 });
  assert.equal(a.frames.scriptedWindow.maxMs, 90);
  assert.equal(a.frames.first15s.maxMs, 90);
  const after = analyzeStartup(probe({ frames: [...steady(0, 17000, 10), 17500] }), { modelWaitSeconds: 0, collisionWaitSeconds: 0, consoleErrors: 0 });
  assert.equal(after.frames.scriptedWindow.maxMs, 10);
});

test('production builds fall back to the first view change and report waits as unavailable', () => {
  const a = analyzeStartup(probe({ frames: steady(0, 17000, 10), viewChangedAt: 1064 }), { modelWaitSeconds: null, collisionWaitSeconds: null, consoleErrors: 0 });
  assert.deepEqual(a.firstMovingTick, { ms: 64, method: 'view-change' });
  assert.equal(a.firstViewChangeMs, 64);
  assert.equal(status(a, 'first-moving-tick'), 'PASS');
  assert.equal(status(a, 'model-wait'), 'N/A');
  assert.equal(a.modelWaitSeconds, null);
});

test('empty probe data fails the frame gate instead of passing vacuously', () => {
  const a = analyzeStartup(probe({ playEnabledAt: null }), { modelWaitSeconds: null, collisionWaitSeconds: null, consoleErrors: 0 });
  assert.equal(a.timeToPlayEnabledMs, null);
  assert.deepEqual(a.frames.first15s, { samples: 0, p50Ms: null, p99Ms: null, maxMs: null });
  assert.equal(status(a, 'max-frame-window'), 'FAIL');
  assert.equal(status(a, 'programs-after-play'), 'PASS');
  assert.equal(status(a, 'slow-gl-calls'), 'PASS');
  assert.deepEqual(a.firstMovingTick, { ms: null, method: 'unavailable' });
  assert.equal(status(a, 'first-moving-tick'), 'N/A');
  assert.throws(() => analyzeStartup(probe({ clickAt: null }), { modelWaitSeconds: null, collisionWaitSeconds: null, consoleErrors: 0 }), /Play click/);
});

test('audio: a context resumed by the Play gesture passes; one left suspended fails', () => {
  const running = analyzeStartup(probe({ frames: steady(0, 17000, 10), audio: [[400, 0, 'suspended'], [1003, 0, 'running']] }), { modelWaitSeconds: 0, collisionWaitSeconds: 0, consoleErrors: 0 });
  assert.deepEqual(running.audio, { contexts: 1, createdBeforePlay: 1, runningAfterPlayMs: 3, finalState: 'running' });
  assert.equal(status(running, 'audio-running'), 'PASS');
  const suspended = analyzeStartup(probe({ frames: steady(0, 17000, 10), audio: [[1002, 0, 'suspended']] }), { modelWaitSeconds: 0, collisionWaitSeconds: 0, consoleErrors: 2 });
  assert.equal(status(suspended, 'audio-running'), 'FAIL');
  assert.equal(status(suspended, 'console-errors'), 'FAIL');
});

test('URL guard: loopback accepted; other hosts refused unless --allow-live', () => {
  assert.equal(checkTargetUrl('http://127.0.0.1:5419/?preset=low', false).hostname, '127.0.0.1');
  assert.equal(checkTargetUrl('http://localhost:4317/Helsinki-rides/', false).pathname, '/Helsinki-rides/');
  assert.throws(() => checkTargetUrl('https://example.org/', false), /--allow-live/);
  assert.equal(checkTargetUrl('https://example.org/', true).href, 'https://example.org/');
  for (const bad of ['http://127.0.0.1.example.org/', 'http://localhost.example.org/', 'http://10.0.0.5/', 'http://[::ffff:7f00:1]/']) assert.throws(() => checkTargetUrl(bad, false), bad);
  for (const bad of ['file:///C:/game/index.html', 'http://user:secret@example.org/', 'not a url', 'javascript:alert(1)']) assert.throws(() => checkTargetUrl(bad, true), bad);
});

test('world requests map only to files inside the local release directory', () => {
  const base = 'https://raw.githubusercontent.com/MattiTynka/Helsinki-rides/b79144e3de2ed9cf1702a5ddc1ad4fa18a4a47c9/world/';
  const dir = path.resolve('local-world');
  const map = (url: string) => worldFileFor(url, base, 'release-1', dir);
  assert.deepEqual(map(`${base}release-1/manifest.json`), { kind: 'file', file: path.join(dir, 'manifest.json') });
  assert.deepEqual(map(`${base}release-1/cells/c-01.lod0.glb`), { kind: 'file', file: path.join(dir, 'cells', 'c-01.lod0.glb') });
  assert.equal(map('http://127.0.0.1:4317/Helsinki-rides/index.html'), null);
  assert.equal(map('https://raw.githubusercontent.com/other/repo/world/release-1/manifest.json'), null);
  for (const escape of [`${base}release-2/manifest.json`, `${base}release-1/`, `${base}release-1/..%2Fsecret`, `${base}release-1/%2e%2e/secret`,
    `${base}release-1/cells/.hidden`, `${base}release-1/C:%5Csecret`, `${base}release-1/manifest.json?x=1`, `${base}release-1/a//b`, `${base}manifest.json`]) {
    assert.deepEqual(map(escape), { kind: 'missing' }, escape);
  }
  assert.throws(() => worldFileFor(`${base}release-1/manifest.json`, base, '../up', dir));
});

const noWaits = { modelWaitSeconds: 0, collisionWaitSeconds: 0, consoleErrors: 0 };

test('an incomplete scenario invalidates every threshold instead of passing', () => {
  const a = analyzeStartup(probe({ frames: steady(0, 17000, 10), ticks: [[995, 0], [1010, 1]] }), noWaits, { scenarioFailures: ['reachedCar', 'enteredCar'] });
  assert.deepEqual(a.scenario, { complete: false, failedStages: ['reachedCar', 'enteredCar'] });
  assert.ok(a.thresholds.length > 0);
  for (const t of a.thresholds) assert.equal(t.status, 'INVALID', t.id);
  assert.deepEqual(analyzeStartup(probe({ frames: steady(0, 17000, 10) }), noWaits, { scenarioFailures: [] }).scenario, { complete: true, failedStages: [] });
});

test('gaps that cross the end of either window count against it', () => {
  const end = analyzeStartup(probe({ frames: [...steady(0, 16900, 10), 17200, 17210] }), noWaits);
  assert.equal(end.frames.scriptedWindow.maxMs, 300);
  assert.equal(end.thresholds.find(t => t.id === 'max-frame-window')!.status, 'FAIL');
  const first15 = analyzeStartup(probe({ frames: [...steady(0, 15950, 10), 16250, ...steady(16260, 17000, 10)] }), noWaits);
  assert.equal(first15.frames.first15s.maxMs, 300);
  const click = analyzeStartup(probe({ frames: [...steady(0, 950, 10), 1300, ...steady(1310, 17000, 10)] }), noWaits);
  assert.equal(click.frames.scriptedWindow.maxMs, 300, 'click to the first presented frame');
  assert.equal(click.frames.first15s.maxMs, 300);
});

test('frame metrics use presented frames: a paced 60 ms presentation gap fails although rAF ran every 10 ms', () => {
  const frames = steady(0, 17000, 10);
  const a = analyzeStartup(probe({ frames, presented: frames.filter(t => t < 2010 || t >= 2050) }), noWaits);
  assert.equal(a.frames.scriptedWindow.maxMs, 50, 'draws at 2000 and 2050');
  assert.equal(a.frames.raf.scriptedWindow.maxMs, 10, 'raw rAF intervals stay a secondary field');
  assert.equal(status(a, 'max-frame-window'), 'PASS');
  const paced = analyzeStartup(probe({ frames, presented: frames.filter(t => t < 2010 || t >= 2060) }), noWaits);
  assert.equal(paced.frames.scriptedWindow.maxMs, 60);
  assert.equal(paced.frames.first15s.maxMs, 60);
  assert.equal(status(paced, 'max-frame-window'), 'FAIL');
  const brief = analyzeStartup(probe({ clickAt: 500, frames: [...steady(0, 990, 10), 1000, 1010, 1060, ...steady(1070, 17000, 10)],
    presented: [...steady(0, 990, 10), 1000, 1060, ...steady(1070, 17000, 10)], windowEnd: 16000 }), noWaits);
  assert.equal(brief.frames.scriptedWindow.maxMs, 60);
  assert.equal(status(brief, 'max-frame-window'), 'FAIL');
});

test('the idle pre-Play presentation gap counts only from the click to the first presented frame after it', () => {
  const frames = steady(0, 17000, 10);
  const idle = [...steady(0, 1000, 250)];
  const quick = analyzeStartup(probe({ clickAt: 1100, windowEnd: 17000, frames, presented: [...idle, ...steady(1130, 17000, 10)] }), noWaits);
  assert.equal(quick.frames.scriptedWindow.maxMs, 30, 'not the 130 ms idle interval 1000-1130');
  assert.equal(quick.frames.coverage.scriptedWindow, true);
  assert.equal(status(quick, 'max-frame-window'), 'PASS');
  const slow = analyzeStartup(probe({ clickAt: 1100, windowEnd: 17000, frames, presented: [...idle, ...steady(1180, 17000, 10)] }), noWaits);
  assert.equal(slow.frames.first15s.maxMs, 80);
  assert.equal(status(slow, 'max-frame-window'), 'FAIL');
  const none = analyzeStartup(probe({ frames, presented: steady(0, 990, 10) }), noWaits);
  assert.equal(none.frames.coverage.scriptedWindow, false, 'no presentation after the click');
  assert.equal(status(none, 'max-frame-window'), 'FAIL');
});

// Drive fixtures (reviews/05-finding-validation.md DECISIVE_TESTS): samples at t = 250i up to the release at T, no pause,
// driving car-1, 49 m, positive HUD speed and a view change every 100 ms unless a case says otherwise.
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
type Clock = (t: number) => number;
const healthy: Clock = t => t, late: Clock = t => Math.min(t, 6000);
const intermittent: Clock = t => t - clamp(t - 2000, 0, 1500) - clamp(t - 6000, 0, 1500);
const apiTick = (clock: Clock, t: number) => Math.round(0.06 * clock(t));
const hudTick = (clock: Clock, t: number) => apiTick(clock, Math.max(0, t - 500));
const sampleTimes = (T: number) => { const times = steady(0, T, 250); if (times.at(-1)! < T) times.push(T); return times; };
type DriveOptions = {
  T?: number; times?: number[]; tick?: (t: number) => number; x?: (t: number) => number; speed?: (t: number) => number | null; views?: number[];
  pauseTransitions?: [number, boolean][]; sample?: (s: DriveSample, i: number) => DriveSample;
};
const drive = (branch: 'test-api' | 'production', o: DriveOptions = {}): DriveRecord => {
  const T = o.T ?? 10000, times = o.times ?? sampleTimes(T);
  const tick = o.tick ?? (t => branch === 'test-api' ? apiTick(healthy, t) : hudTick(healthy, t)), x = o.x ?? (t => 4.9 * t / 1000), speed = o.speed ?? (() => 40);
  return {
    branch, target: 'car-1', T, pauseTransitions: o.pauseTransitions ?? [], viewChangeTimes: o.views ?? steady(50, 9950, 100),
    samples: times.map((t, i) => (o.sample ?? (s => s))({
      t, paused: false,
      ...branch === 'test-api' ? { api: { tick: tick(t), mode: 'driving', inVehicle: 'car-1', car: [x(t), 0.5, 0] } } : {},
      hud: { driving: true, speedKmh: speed(t), tick: branch === 'test-api' ? hudTick(healthy, t) : tick(t) },
    }, i)),
  };
};
const problems = (r: DriveRecord) => driveVerdict(r).problems.join('; ');
const stages = (drove: boolean): [string, boolean][] => [['moved', true], ['reachedCar', true], ['enteredCar', true], ['droveTenSeconds', drove]];
const assemble = (r: DriveRecord) => assembleStartupResult({ url: 'http://127.0.0.1:5419/' }, probe({ frames: steady(0, 17000, 10) }),
  { modelWaitSeconds: null, collisionWaitSeconds: null, consoleErrors: 0 }, stages(driveVerdict(r).ok), null);

test('the six decisive drives: healthy drives are MEASURED, stalled ones INCOMPLETE with every threshold INVALID', () => {
  const rows: [string, DriveRecord, number, number, boolean][] = [
    ['healthy API', drive('test-api'), 600, 250, true],
    ['API stops after 6 s', drive('test-api', { tick: t => apiTick(late, t) }), 360, 4000, false],
    ['API intermittent stalls', drive('test-api', { tick: t => apiTick(intermittent, t) }), 420, 1750, false],
    ['healthy production HUD', drive('production'), 570, 750, true],
    ['production stops after 6 s', drive('production', { tick: t => hudTick(late, t) }), 360, 3500, false],
    ['production intermittent stalls', drive('production', { tick: t => hudTick(intermittent, t) }), 390, 1750, false],
  ];
  for (const [name, record, delta, gap, driven] of rows) {
    const v = driveVerdict(record);
    assert.equal(v.metrics.tickAdvance, delta, name);
    assert.equal(v.metrics.maxAdvanceGapMs, gap, name);
    assert.equal(v.ok, driven, `${name}: ${v.problems.join('; ')}`);
    const { result, exitCode, failures } = assemble(record);
    assert.equal(result.status, driven ? 'MEASURED' : 'INCOMPLETE', name);
    assert.equal(exitCode, driven ? 0 : 2, name);
    assert.deepEqual(failures, driven ? [] : ['droveTenSeconds'], name);
    assert.equal(result.scenario.complete, driven, name);
    for (const t of result.thresholds) if (!driven) assert.equal(t.status, 'INVALID', `${name} ${t.id}`);
  }
});

test('drive boundaries: advance gaps, final progress, a collision stop, displacement and duration', () => {
  assert.equal(driveVerdict(drive('test-api', { tick: t => t === 3250 ? apiTick(healthy, 3000) : apiTick(healthy, t) })).ok, true, 'a 500 ms advance gap passes');
  assert.match(problems(drive('test-api', { tick: t => t === 3250 || t === 3500 ? apiTick(healthy, 3000) : apiTick(healthy, t) })), /750 ms/, 'a 750 ms advance gap fails');
  const flatFinal = driveVerdict(drive('test-api', { tick: t => apiTick(healthy, Math.min(t, 9750)) }));
  assert.equal(flatFinal.metrics.maxAdvanceGapMs, 250);
  assert.deepEqual(flatFinal.problems, ['the simulation tick did not advance in the final sampling interval']);
  const flatSecond = driveVerdict(drive('production', { tick: t => Math.round(0.06 * Math.min(t, 9000)) }));
  assert.equal(flatSecond.metrics.maxAdvanceGapMs, 1000, 'exactly the maximum HUD gap');
  assert.deepEqual(flatSecond.problems, ['the HUD tick did not advance in the final 1000 ms']);
  // A wall stops the car after 6 s at 49 m while the simulation keeps stepping: driven.
  assert.deepEqual(problems(drive('test-api', { x: t => 49 * Math.min(t, 6000) / 6000 })), '');
  assert.deepEqual(problems(drive('production', { speed: t => t < 6000 ? 40 : 0, views: steady(50, 5950, 100) })), '');
  assert.match(problems(drive('test-api', { x: t => 9.99 * t / 10000 })), /9\.99 m/);
  assert.equal(driveVerdict(drive('test-api', { x: t => 10 * t / 10000 })).ok, true, '10 m passes');
  assert.match(problems(drive('test-api', { T: 9999 })), /duration 9999 ms/);
  assert.equal(driveVerdict(drive('test-api', { T: 10000 })).ok, true);
  assert.match(problems(drive('test-api', { T: 10500.01 })), /duration 10500\.01 ms/);
});

test('drive evidence fails closed: sampling gaps, missing readings, falling ticks, unreadable or latched pauses', () => {
  assert.match(problems(drive('test-api', { times: sampleTimes(10000).filter(t => t !== 3250 && t !== 3500) })), /sampling gap 750 ms/);
  assert.match(problems(drive('test-api', { sample: (s, i) => i === 10 ? { ...s, api: null } : s })), /test API reading/, 'the test API was lost: no production fallback');
  assert.match(problems(drive('production', { sample: (s, i) => i === 10 ? { ...s, hud: { ...s.hud!, tick: null } } : s })), /HUD reading/);
  assert.match(problems(drive('production', { speed: t => t === 5000 ? Number.NaN : 40 })), /HUD reading/);
  assert.match(problems(drive('test-api', { tick: t => t === 5000 ? apiTick(healthy, 4500) : apiTick(healthy, t) })), /tick decreased/);
  assert.match(problems(drive('test-api', { sample: (s, i) => i === 7 ? { ...s, paused: null } : s })), /pause state/);
  const latched = drive('test-api', { pauseTransitions: [[125, false], [125, true], [200, true], [200, false]] });
  assert.ok(latched.samples.every(s => s.paused === false));
  assert.match(problems(latched), /paused/);
  assert.equal(assemble(latched).result.status, 'INCOMPLETE', 'a pause shown and dismissed between two polls');
  assert.match(problems(drive('test-api', { sample: (s, i) => i === 20 ? { ...s, api: { ...s.api!, inVehicle: 'car-2' } } : s })), /driving car-1/);
  assert.match(problems(drive('production', { sample: (s, i) => i === 20 ? { ...s, hud: { ...s.hud!, driving: false } } : s })), /driving HUD/);
  assert.match(problems({ ...drive('test-api'), T: null }), /unrecorded/, 'W keydown or keyup not received');
});

test('a drive certifies only with progress: stalled, frozen or paused drives make the scenario incomplete', () => {
  assert.deepEqual(problems(drive('test-api')), '');
  assert.deepEqual(problems(drive('production')), '', 'production evidence: HUD ticks, speed and view changes');
  assert.match(problems(drive('test-api', { x: t => 0.4 * t / 1000 })), /moved 4 m/);
  assert.match(problems(drive('test-api', { tick: () => 0 })), /advanced 0 \(minimum 300\)/, 'a frozen simulation');
  assert.match(problems(drive('test-api', { sample: s => ({ ...s, api: { ...s.api!, car: null } }) })), /car position/);
  assert.match(problems(drive('test-api', { sample: (s, i) => i === 5 ? { ...s, paused: true } : s })), /paused/);
  assert.match(problems(drive('test-api', { sample: s => ({ ...s, paused: null }) })), /pause state/);
  const stalled = drive('production', { speed: t => t < 1000 ? 12 : 0, views: steady(50, 1150, 100) });
  assert.match(problems(stalled), /speed was non-zero for 1000 of 10000 ms/, 'speed stays 0');
  assert.match(problems(drive('production', { times: [] })), /samples/, 'no samples');
  assert.match(problems(drive('production', { views: [100, 4000, 9000] })), /3 rendered view changes/);
  assert.match(problems(drive('production', { views: [...steady(50, 4950, 100), ...steady(6200, 9950, 100)] })), /1250 ms of moving time/);
  const { result } = assemble(stalled);
  assert.equal(result.scenario.complete, false);
  for (const t of result.thresholds) assert.equal(t.status, 'INVALID', t.id);
});

test('other stages bind to evidence: player displacement, persistent draws, the enter prompt and car-1', () => {
  assert.deepEqual(playerMoved([10, 2, 10], [10.2, 2, 10.2]), { displacementM: 0.28, moved: false }, 'stationary player while ticks advance');
  assert.equal(playerMoved([10, 2, 10], [10.5, 2, 10]).moved, true);
  const frame = (n: number, dx: number, prefix = 'p1#') => new Map(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, `${i * 10 + dx},0,0`]));
  assert.equal(persistentViewsMoved(frame(30, 0), frame(30, 1)), true, 'persistent draws moved');
  assert.equal(persistentViewsMoved(frame(30, 0), frame(30, 0)), false, 'nothing moved');
  assert.equal(persistentViewsMoved(frame(30, 0), frame(30, 5, 'p2#')), false, 'disjoint stationary draws (newly streamed) are not movement');
  assert.equal(persistentViewsMoved(frame(10, 0), frame(10, 1)), false, 'too few persistent draws');
  assert.equal(persistentViewsMoved(new Map([...frame(30, 0), ...frame(30, 0, 'p2#')]), new Map([...frame(30, 0), ...frame(30, 1, 'p2#')])), false, 'half moved is not most');
  assert.equal(enterPromptShown(english['interaction.enter'], 'en'), true);
  assert.equal(enterPromptShown(english['touch.promptEnter'], 'en'), true);
  assert.equal(enterPromptShown(finnish['interaction.enter'], 'fi'), true);
  assert.equal(enterPromptShown(english['quality.lowered'], 'en'), false, 'a quality notice is not the enter prompt');
  assert.equal(enterPromptShown(english['interaction.enter'], 'fi'), false, 'only the active locale');
  assert.equal(enterPromptShown(english['interaction.enter'], 'de'), false);
  assert.equal(apiNearTarget({ mode: 'onFoot', nearVehicle: 'car-1' }, 'car-1'), true);
  assert.equal(apiNearTarget({ mode: 'onFoot', nearVehicle: 'car-2' }, 'car-1'), false);
  assert.equal(apiEntry({ mode: 'driving', inVehicle: 'car-2' }, 'car-1'), 'other', 'entering car-2 is not entry into car-1');
  assert.equal(apiEntry({ mode: 'entering', inVehicle: null }, 'car-1'), 'pending');
  assert.equal(apiEntry({ mode: 'driving', inVehicle: 'car-1' }, 'car-1'), 'entered');
});

test('the shot count comes from the HUD magazine and the test API; only an observed shot certifies the stage', () => {
  assert.deepEqual(shotSummary(12, 11, null), { hudShots: 1, apiShots: null, count: 1, exactlyOne: true });
  assert.deepEqual(shotSummary(12, 10, 2), { hudShots: 2, apiShots: 2, count: 2, exactlyOne: false });
  assert.deepEqual(shotSummary(12, 11, 1), { hudShots: 1, apiShots: 1, count: 1, exactlyOne: true });
  assert.deepEqual(shotSummary(12, 12, null), { hudShots: 0, apiShots: null, count: 0, exactlyOne: false });
  assert.deepEqual(shotSummary(null, 11, null), { hudShots: null, apiShots: null, count: null, exactlyOne: false });
  assert.equal(shotSummary(12, 11, 2).count, 2, 'the test API event count wins over the HUD when both exist');
});

test('frame samples that stop early or start after the click fail the frame gate', () => {
  const early = analyzeStartup(probe({ frames: steady(0, 1100, 10) }), noWaits);
  assert.deepEqual(early.frames.coverage, { first15s: false, scriptedWindow: false });
  assert.equal(early.thresholds.find(t => t.id === 'max-frame-window')!.status, 'FAIL');
  const late = analyzeStartup(probe({ frames: steady(1005, 17005, 10) }), noWaits);
  assert.deepEqual(late.frames.coverage, { first15s: false, scriptedWindow: false });
  assert.equal(late.thresholds.find(t => t.id === 'max-frame-window')!.status, 'FAIL');
  const covered = analyzeStartup(probe({ frames: steady(0, 17000, 10) }), noWaits);
  assert.deepEqual(covered.frames.coverage, { first15s: true, scriptedWindow: true });
});

test('egress accounting counts redirect hops and unanswered requests and refuses a local-only claim with pending requests', () => {
  const base = 'https://raw.githubusercontent.com/MattiTynka/Helsinki-rides/b79144e3de2ed9cf1702a5ddc1ad4fa18a4a47c9/world/';
  const local = { url: `${base}release-1/manifest.json`, answered: true, outcome: 'finished' as const, fromServiceWorker: false };
  const cached = { url: `${base}release-1/cells/a.glb`, answered: false, outcome: 'finished' as const, fromServiceWorker: true };
  const loopback = { url: 'http://127.0.0.1:5420/Helsinki-rides/index.html', answered: false, outcome: 'finished' as const, fromServiceWorker: false };
  assert.deepEqual(egressSummary([local, cached, loopback], base, true),
    { isolated: true, observedOffLoopback: 2, answeredLocally: 1, serviceWorkerAnswered: 1, egress: 0, worldEgress: 0, pending: 0, localOnly: true, samples: [] });
  // A loopback response redirected to the world origin is a new hop the route never answered.
  const redirectHop = { url: `${base}release-1/cells/b.glb`, answered: false, outcome: 'finished' as const, fromServiceWorker: false };
  const failed = { url: 'https://example.org/beacon', answered: false, outcome: 'failed' as const, fromServiceWorker: false };
  const leaked = egressSummary([local, redirectHop, failed], base, true);
  assert.equal(leaked.egress, 2);
  assert.equal(leaked.worldEgress, 1);
  assert.equal(leaked.localOnly, false);
  const pending = egressSummary([local, { url: `${base}release-1/cells/c.glb`, answered: false, outcome: 'pending', fromServiceWorker: false }], base, true);
  assert.equal(pending.pending, 1);
  assert.equal(pending.egress, 0);
  assert.equal(pending.localOnly, false);
  assert.equal(egressSummary([{ ...local, outcome: 'pending' }], base, true).localOnly, true, 'a locally answered request still streaming is not egress');
  // A cancelled page request the service worker intercepted: its own fetch for the URL was answered locally.
  const glb = `${base}release-1/cells/d.glb`;
  const worker = { url: glb, answered: true, outcome: 'finished' as const, fromServiceWorker: false, initiator: 'service-worker' as const };
  const cancelled = { url: glb, answered: false, outcome: 'failed' as const, fromServiceWorker: false, initiator: 'page' as const, redirected: false };
  assert.deepEqual([egressSummary([worker, cancelled], base, true).serviceWorkerAnswered, egressSummary([worker, cancelled], base, true).egress], [1, 0]);
  assert.equal(egressSummary([cancelled], base, true).egress, 1, 'without a locally answered worker fetch it counts as egress');
  assert.equal(egressSummary([worker, { ...cancelled, redirected: true }], base, true).egress, 1, 'a redirect hop is never excused');
  assert.equal(egressSummary([{ ...worker, answered: false }, cancelled], base, true).egress, 2, 'the worker fetch itself must have been answered locally');
});

test('without transport isolation a failed page request is never excused and nothing certifies local-only', () => {
  const base = 'https://raw.githubusercontent.com/MattiTynka/Helsinki-rides/b79144e3de2ed9cf1702a5ddc1ad4fa18a4a47c9/world/';
  const glb = `${base}release-1/cells/d.glb`;
  // An earlier worker fetch answered locally and an unrelated later page request for the same URL that failed.
  const worker = { url: glb, answered: true, outcome: 'finished' as const, fromServiceWorker: false, initiator: 'service-worker' as const };
  const unrelated = { url: glb, answered: false, outcome: 'failed' as const, fromServiceWorker: false, initiator: 'page' as const, redirected: false };
  const open = egressSummary([worker, unrelated], base, false);
  assert.deepEqual([open.isolated, open.serviceWorkerAnswered, open.egress, open.worldEgress, open.localOnly], [false, 0, 1, 1, false]);
  const isolated = egressSummary([worker, unrelated], base, true);
  assert.deepEqual([isolated.isolated, isolated.serviceWorkerAnswered, isolated.egress, isolated.localOnly], [true, 1, 0, true]);
  assert.equal(egressSummary([worker], base, false).localOnly, false, 'zero egress without isolation is not a local-only claim');
  const a = analyzeStartup(probe({ frames: steady(0, 17000, 10) }), noWaits, { scenarioFailures: [], egress: egressSummary([worker], base, false) });
  assert.equal(status(a, 'world-local-only'), 'FAIL');
  assert.match(a.thresholds.find(t => t.id === 'world-local-only')!.detail, /isolation/);
  const b = analyzeStartup(probe({ frames: steady(0, 17000, 10) }), noWaits, { scenarioFailures: [], egress: egressSummary([worker], base, true) });
  assert.equal(status(b, 'world-local-only'), 'PASS');
});

test('non-live runs resolve no host but loopback; live runs are not isolated', () => {
  assert.equal(transportIsolationRule(false), 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
  assert.equal(transportIsolationRule(true), null);
});

test('live mode refuses mutating or navigating requests off loopback and only clicks the Play button or the canvas', () => {
  const target = 'https://example.org/game/?preset=standard';
  const block = (url: string, method: string, navigation = false) => liveRequestBlock({ url, method, navigation, targetHref: target });
  assert.equal(block(target, 'GET', true), null);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(block('https://example.org/world/manifest.json', method), null, method);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(block('https://example.org/api', method), 'method', method);
  assert.equal(block('https://example.org/game/?q=1', 'GET', true), 'navigation');
  // A redirect hop is continued without the route, so no request in live mode may carry a mutation, loopback included.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(block('http://127.0.0.1:5420/@vite/client', method), 'method', `loopback ${method}`);
  assert.equal(block('http://127.0.0.1:5420/@vite/client', 'GET'), null);
  const play = { tag: 'BUTTON', id: 'play-button', inPlayButton: true, inForm: false, pointerLockedCanvas: false };
  assert.equal(clickTargetProblem(play, 'play'), null);
  assert.match(clickTargetProblem({ ...play, inForm: true }, 'play')!, /form/);
  assert.match(clickTargetProblem({ ...play, tag: 'DIV', id: 'cover', inPlayButton: false }, 'play')!, /Play button/);
  assert.match(clickTargetProblem(null, 'play')!, /no element/);
  const canvas = { tag: 'CANVAS', id: 'view', inPlayButton: false, inForm: false, pointerLockedCanvas: false };
  assert.equal(clickTargetProblem(canvas, 'canvas'), null);
  assert.equal(clickTargetProblem({ tag: 'DIV', id: 'hud', inPlayButton: false, inForm: false, pointerLockedCanvas: true }, 'canvas'), null);
  assert.match(clickTargetProblem({ ...canvas, id: 'minimap' }, 'canvas')!, /canvas/);
  assert.match(clickTargetProblem({ ...canvas, inForm: true }, 'canvas')!, /form/);
});

test('world files are served only when their real path stays inside the real world root', t => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'startup-smoothness-'));
  try {
    const outside = path.join(temp, 'outside'), world = path.join(temp, 'world'), linkedRoot = path.join(temp, 'root-link');
    mkdirSync(outside); mkdirSync(path.join(world, 'cells'), { recursive: true });
    writeFileSync(path.join(outside, 'secret.json'), '{}');
    writeFileSync(path.join(world, 'manifest.json'), '{}');
    writeFileSync(path.join(world, 'cells', 'a.glb'), 'glb');
    try {
      symlinkSync(outside, path.join(world, 'linked'), 'junction');
      symlinkSync(world, linkedRoot, 'junction');
    } catch (error) { t.skip(`directory links cannot be created here: ${(error as Error).message}`); return; }
    const root = realpathSync.native(linkedRoot);
    assert.equal(root, realpathSync.native(world), 'a junction-backed root resolves to its target');
    assert.equal(canonicalWorldFile(path.join(linkedRoot, 'manifest.json'), root), realpathSync.native(path.join(world, 'manifest.json')));
    assert.equal(canonicalWorldFile(path.join(linkedRoot, 'cells', 'a.glb'), root), realpathSync.native(path.join(world, 'cells', 'a.glb')));
    assert.equal(canonicalWorldFile(path.join(linkedRoot, 'linked', 'secret.json'), root), null, 'nested link escapes the root');
    assert.equal(canonicalWorldFile(path.join(world, 'linked', 'secret.json'), root), null);
    assert.equal(canonicalWorldFile(path.join(linkedRoot, 'missing.json'), root), null);
    assert.equal(canonicalWorldFile(path.join(linkedRoot, 'cells'), root), null, 'directories are not files');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
