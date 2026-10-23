import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FramePacer } from '../../../apps/game/src/render/frame-pacing.ts';
import { analyseAdaptive, closeOnFailure, compareRuns, describeRow, measuredUrl, presentationIntervals, sampleAdaptive, sampleFrames, summariseFrames,
  urlPacing } from '../lib/weak-gpu-analysis.mjs';

/** One fixed-scenario spot measurement as probe-weak-gpu.mjs records it. */
function spot(label, residentCells, renderedCells = ['detail:c_p00_p00'], mib = 40) {
  return { label, rafMedianMs: 100, residentCells, renderedCells, textureMemory: { mib, textures: 10, byClass: null }, uploads: {}, textureFormats: null };
}
const run = (label, runs) => ({ label, runs });
const cells = (detail, fallback = ['c_p02_p00']) => ({ detail, fallback });

test('complete identical resident sets on both sides are proven identical', () => {
  const a = run('candidate', [{ preset: 'low', spots: [spot('Senate Square', cells(['c_m01_p00', 'c_p00_p00']), ['detail:c_p00_p00'], 44.36)] }]);
  const b = run('base', [{ preset: 'low', spots: [spot('Senate Square', cells(['c_m01_p00', 'c_p00_p00']), ['detail:c_p00_p00'], 73.08)] }]);
  const [row] = compareRuns(a, b).rows;
  assert.equal(row.residentSource, 'residentCells');
  assert.equal(row.residencyProven, true);
  assert.equal(row.residentIdentical, true);
  assert.deepEqual(row.residentDifferences, {});
  assert.deepEqual(row.textureMiB, { here: 44.36, baseline: 73.08, changePercent: -39.3 });
  assert.match(describeRow(row), /resident sets identical \(residentCells\)/);
});

test('complete differing resident sets are reported as different, with the exact difference per stream', () => {
  const a = run('candidate', [{ preset: 'low', spots: [spot('Esplanadi', cells(['c_p00_p00', 'c_p01_p00'], ['c_p02_p00', 'c_p03_p00']))] }]);
  const b = run('base', [{ preset: 'low', spots: [spot('Esplanadi', cells(['c_m01_p00', 'c_p00_p00'], ['c_p02_p00', 'c_p03_p00']))] }]);
  const [row] = compareRuns(a, b).rows;
  assert.equal(row.residencyProven, true);
  assert.equal(row.residentIdentical, false);
  assert.deepEqual(row.residentDifferences, { detail: { onlyHere: ['c_p01_p00'], onlyBaseline: ['c_m01_p00'] } });
  assert.match(describeRow(row), /resident sets DIFFER \(residentCells\): .*c_p01_p00.*c_m01_p00/);
});

test('without complete resident sets on either side residency is unknown, whatever the rendered cells show', () => {
  for (const [here, there] of [[cells(['c_p00_p00']), null], [null, cells(['c_p00_p00'])], [null, null]]) {
    const a = run('candidate', [{ preset: 'low', spots: [spot('Senate Square', here)] }]);
    const b = run('base', [{ preset: 'low', spots: [spot('Senate Square', there)] }]);
    const [row] = compareRuns(a, b).rows;
    assert.equal(row.residentIdentical, null, 'unknown, not identical');
    assert.equal(row.residencyProven, false);
    assert.equal(row.residentSource, 'renderedCells', 'names what was compared instead');
    assert.equal(row.renderedIdentical, true);
    const line = describeRow(row);
    assert.match(line, /residency unproven/); assert.match(line, /renderedCells/);
    assert.doesNotMatch(line, /resident sets identical/);
  }
});

test('spots and presets present on only one side become explicit rows', () => {
  const a = run('candidate', [
    { preset: 'standard', spots: [spot('Senate Square', cells(['a'])), spot('Kluuvi / Aleksanterinkatu', cells(['b']))] },
    { preset: 'low', spots: [spot('Senate Square', cells(['a']))] },
  ]);
  const b = run('base', [{ preset: 'standard', spots: [spot('Senate Square', cells(['a'])), spot('Esplanadi', cells(['c']))] }]);
  const rows = compareRuns(a, b).rows.map(r => [r.preset, r.label, r.missingInBaseline === true, r.missingHere === true, r.residentIdentical ?? null]);
  assert.deepEqual(rows, [
    ['standard', 'Senate Square', false, false, true],
    ['standard', 'Kluuvi / Aleksanterinkatu', true, false, null],
    ['low', 'Senate Square', true, false, null],
    ['standard', 'Esplanadi', false, true, null],
  ]);
  const missing = compareRuns(a, b).rows.find(r => r.missingHere);
  assert.match(describeRow(missing), /only in the baseline run/);
  assert.match(describeRow(compareRuns(a, b).rows[1]), /not in the baseline run/);
});

const frame = (t, scale, tier = 'standard') => ({ t, scale, tier, intervalMs: 500 });

test('an adaptive series that never reaches the configured floor reports no floor arrival and no floor time', () => {
  const frames = [frame(-.002, 1), frame(1, 1), frame(2, 1), frame(40, 1)];
  const result = analyseAdaptive(frames, { resolutionFloor: .5 });
  assert.equal(result.floorReachedAtSeconds, null, 'scale 1 is not the 0.5 floor, even though it is the lowest observed');
  assert.equal(result.secondsAtFloorBeforeChange, null);
  assert.equal(result.firstChange, null);
  assert.equal(result.lowestScale, 1);
  assert.deepEqual(result.tiers, ['standard']);
});

test('the time at the floor is the contiguous run immediately before the first tier change', () => {
  const frames = [frame(0, 1), frame(3.8, .8), frame(6.7, .6), frame(9.9, .5), frame(10.4, .5), frame(12, .5), frame(15, .5, 'low'), frame(16, .5, 'low')];
  const result = analyseAdaptive(frames, { resolutionFloor: .5 });
  assert.equal(result.floorReachedAtSeconds, 9.9);
  assert.deepEqual(result.firstChange, { atSeconds: 15, tier: 'low' });
  assert.equal(result.secondsAtFloorBeforeChange, 5.1);
  // Leaving the floor restarts the run: only the last stretch counts.
  const interrupted = [frame(0, .5), frame(2, .5), frame(3, .6), frame(4, .5), frame(6, .5), frame(7.5, .5, 'low')];
  const again = analyseAdaptive(interrupted, { resolutionFloor: .5 });
  assert.equal(again.floorReachedAtSeconds, 0);
  assert.equal(again.secondsAtFloorBeforeChange, 3.5);
  // A change while above the floor: the floor was reached earlier, but no floor time precedes the change.
  const above = analyseAdaptive([frame(0, .5), frame(1, .6), frame(2, .6, 'low')], { resolutionFloor: .5 });
  assert.equal(above.secondsAtFloorBeforeChange, 0);
  // A floating-point floor (0.6000000000000001) still counts as the 0.6 phone floor.
  assert.equal(analyseAdaptive([frame(0, .6000000000000001), frame(1, .6000000000000001, 'minimal')], { resolutionFloor: .6 }).floorReachedAtSeconds, 0);
});

/** rAF samples as the probe takes them: on each tick the game's loop runs first and presents when its FramePacer allows. */
function drive(stamps, pacer) {
  let frameTime = 0;
  return stamps.map(now => {
    if (pacer.shouldRender(now)) frameTime = now;
    return { now, frameTime };
  });
}
const clock = (hz, seconds, start = 1000) => Array.from({ length: Math.round(hz * seconds) + 1 }, (_, k) => start + (k * 1000) / hz);

test('a 30 FPS paced run on a 60 Hz display counts game presentations, not rAF ticks', () => {
  const summary = summariseFrames(drive(clock(60, 10), new FramePacer(30)));
  assert.equal(summary.rafTicks, 600);
  assert.equal(summary.rafTickMedianMs, 16.7, 'what the old rAF-only computation reported as the frame interval');
  assert.ok(Math.abs(summary.presentedFrames - 300) <= 1, `${summary.presentedFrames} presentations`);
  assert.equal(summary.presentationMedianMs, 33.3);
  assert.equal(summary.presentationP90Ms, 33.3);
});

test('an uncapped run presents on every tick: the presentation intervals are the rAF intervals', () => {
  const stamps = clock(144, 10).map((t, k) => t + ((k * 7) % 5) / 10);
  const samples = drive(stamps, new FramePacer(0));
  const frames = presentationIntervals(samples);
  assert.equal(frames.presentationIntervals.length, 1440);
  assert.deepEqual(frames.presentationIntervals, frames.rafTickIntervals);
  const summary = summariseFrames(samples);
  assert.equal(summary.presentedFrames, summary.rafTicks);
  assert.equal(summary.presentationMedianMs, summary.rafTickMedianMs);
  assert.equal(summary.presentationP90Ms, summary.rafTickP90Ms);
});

test('ticks on which the game did not present (paused, blocked) are not presentations', () => {
  const presented = new Set([0, 1, 5, 6, 10]);
  let frameTime = 0;
  const samples = Array.from({ length: 11 }, (_, k) => {
    const now = 100 + k * 10;
    if (presented.has(k)) frameTime = now;
    return { now, frameTime };
  });
  const frames = presentationIntervals(samples);
  assert.deepEqual(frames.presentationTimes, [100, 110, 150, 160, 200]);
  assert.deepEqual(frames.presentationIntervals, [10, 40, 10, 40]);
  assert.deepEqual(summariseFrames(samples), { presentedFrames: 4, presentationMedianMs: 40, presentationP90Ms: 40, rafTicks: 10, rafTickMedianMs: 10, rafTickP90Ms: 10 });
  // A presentation from before the window does not open it: the first interval starts at the first presentation seen.
  const late = [{ now: 100, frameTime: 50 }, { now: 110, frameTime: 50 }, { now: 120, frameTime: 120 }, { now: 130, frameTime: 130 }];
  assert.deepEqual(presentationIntervals(late).presentationIntervals, [10]);
});

test('a window without any presentation reports zero presentations and no interval', () => {
  const stale = Array.from({ length: 6 }, (_, k) => ({ now: 100 + k * 10, frameTime: 50 }));
  assert.deepEqual(summariseFrames(stale), { presentedFrames: 0, presentationMedianMs: null, presentationP90Ms: null, rafTicks: 5, rafTickMedianMs: 10, rafTickP90Ms: 10 });
  assert.deepEqual(summariseFrames([]), { presentedFrames: 0, presentationMedianMs: null, presentationP90Ms: null, rafTicks: 0, rafTickMedianMs: null, rafTickP90Ms: null });
});

/** A spot as the corrected probe records it: presentations, with the raw rAF cadence under its own names. */
const presentedSpot = (label, medianMs) => ({ ...spot(label, cells(['c_p00_p00'])), rafMedianMs: undefined,
  presentedFrames: 300, presentationMedianMs: medianMs, presentationP90Ms: medianMs, rafTicks: 1400, rafTickMedianMs: 7, rafTickP90Ms: 7 });

const BASE = 'http://127.0.0.1:5331/Helsinki-rides/';
const FIXED_LOW = { review: '1', preset: 'low', audio: '0', dynres: '0' };
/** An older-probe result in the shape of c4-d3d11-fixed-candidate: rAF ticks as rafMedianMs, the measured URL per run. */
const legacy = (url, rafMedianMs = 100, query = '') => ({ label: 'base', tool: 'probe-weak-gpu', scenario: 'fixed', query,
  runs: [{ preset: 'low', ...(url === undefined ? {} : { url }), spots: [{ ...spot('Senate Square', cells(['c_p00_p00'])), frames: 50, rafMedianMs, rafP90Ms: rafMedianMs }] }] });
const presented = (medianMs, url = measuredUrl(BASE, FIXED_LOW, '')) => ({ label: 'candidate', tool: 'probe-weak-gpu', scenario: 'fixed', query: '',
  runs: [{ preset: 'low', url, spots: [presentedSpot('Senate Square', medianMs)] }] });

test('the measured URL applies --query over --url with the last value winning, as the page sees it', () => {
  assert.equal(measuredUrl(`${BASE}?fps=30`, FIXED_LOW, ''), `${BASE}?fps=30&review=1&preset=low&audio=0&dynres=0`);
  // searchParams.set() collapses duplicates, so get() on the written URL returns the value the page saw.
  assert.deepEqual(new URL(measuredUrl(BASE, FIXED_LOW, 'fps=invalid&fps=30')).searchParams.getAll('fps'), ['30']);
  assert.deepEqual(new URL(measuredUrl(`${BASE}?fps=60`, FIXED_LOW, 'fps=30')).searchParams.getAll('fps'), ['30']);
});

test('a recorded run is paced exactly when its effective URL paces the game', () => {
  assert.equal(urlPacing(measuredUrl(`${BASE}?fps=30`, FIXED_LOW, '')), 'paced', '--url carrying fps=30 with an empty --query');
  assert.equal(urlPacing(measuredUrl(BASE, FIXED_LOW, 'fps=invalid&fps=30')), 'paced', 'last --query value wins');
  assert.equal(urlPacing(measuredUrl(`${BASE}?mobile=1`, FIXED_LOW, '')), 'paced', 'mobile=1 through --url defaults to 30 FPS');
  assert.equal(urlPacing(measuredUrl(BASE, FIXED_LOW, 'fps=60')), 'paced');
  assert.equal(urlPacing(measuredUrl(BASE, FIXED_LOW, 'fps=invalid')), 'uncapped', 'the game ignores other fps values');
  assert.equal(urlPacing(measuredUrl(BASE, FIXED_LOW, 'mobile=0&fps=45')), 'uncapped');
  assert.equal(urlPacing(measuredUrl(BASE, FIXED_LOW, 'mipdrop=1')), 'uncapped');
  assert.equal(urlPacing(undefined), null);
  assert.equal(urlPacing('not a url'), null);
});

test('an older uncapped result (the c-, c4- and c5- shape) compares against presentations', () => {
  const older = legacy(`${BASE}?review=1&preset=low&audio=0&dynres=0`);
  const [row] = compareRuns(presented(80), older).rows;
  assert.deepEqual(row.frameIntervalMs, { here: 80, baseline: 100, measureHere: 'presentations', measureBaseline: 'rafTicks-uncapped', changePercent: -20,
    insufficientHere: false, insufficientBaseline: false });
  assert.equal(row.rafMedianMs, undefined, 'the rAF cadence is never reported as the frame interval');
  assert.match(describeRow(row), /median 100 ms \(older probe: rAF ticks of an uncapped run, each tick a presentation\) -> 80 ms \(presentations\) \(-20 %\)/);
  assert.equal(compareRuns(presented(80), legacy(`${BASE}?review=1&preset=low&audio=0&dynres=0&mipdrop=1`, 100, 'mipdrop=1')).rows[0].frameIntervalMs.measureBaseline, 'rafTicks-uncapped');
  assert.equal(compareRuns(presented(80), legacy(measuredUrl(BASE, FIXED_LOW, 'fps=invalid'), 100, 'fps=invalid')).rows[0].frameIntervalMs.changePercent, -20);
});

test('an older paced result is not comparable, however the pacing reached the page', () => {
  for (const [name, url, query] of [
    ['--url carrying fps=30, empty --query', measuredUrl(`${BASE}?fps=30`, FIXED_LOW, ''), ''],
    ['--query fps=invalid&fps=30', measuredUrl(BASE, FIXED_LOW, 'fps=invalid&fps=30'), 'fps=invalid&fps=30'],
    ['mobile=1 through --url', measuredUrl(`${BASE}?mobile=1`, FIXED_LOW, ''), ''],
  ]) {
    const [row] = compareRuns(presented(33.3), legacy(url, 16.7, query)).rows;
    assert.equal(row.frameIntervalMs.measureBaseline, 'rafTicks-paced', name);
    assert.equal(row.frameIntervalMs.changePercent, null, name);
    assert.match(describeRow(row), /rAF ticks of a paced run, not presentations\) -> 33\.3 ms \(presentations\) \(not comparable\)/, name);
  }
});

test('an older result without a measured URL has an unknown measure and is not comparable', () => {
  const [row] = compareRuns(presented(80), legacy(undefined)).rows;
  assert.equal(row.frameIntervalMs.measureBaseline, 'rafTicks-unknown');
  assert.equal(row.frameIntervalMs.changePercent, null);
  assert.match(describeRow(row), /rAF ticks of a run without a readable URL, pacing unknown\) -> 80 ms \(presentations\) \(not comparable\)/);
});

test('presentation-based results compare whatever the pacing', () => {
  const paced = measuredUrl(BASE, FIXED_LOW, 'mobile=1&fps=30');
  const [row] = compareRuns(presented(36.6, paced), presented(33.3, paced)).rows;
  assert.deepEqual(row.frameIntervalMs, { here: 36.6, baseline: 33.3, measureHere: 'presentations', measureBaseline: 'presentations', changePercent: 9.9,
    insufficientHere: false, insufficientBaseline: false });
  assert.match(describeRow(row), /presentation median 33\.3 -> 36\.6 ms \(9\.9 %\)/);
});

/** A new-probe result whose Senate Square window is `frames` (summariseFrames output), e.g. a window too short to measure. */
const windowed = frames => ({ label: 'short', tool: 'probe-weak-gpu', scenario: 'fixed', query: '',
  runs: [{ preset: 'low', url: measuredUrl(BASE, FIXED_LOW, ''), spots: [{ ...spot('Senate Square', cells(['c_p00_p00'])), rafMedianMs: undefined, ...frames }] }] });
const UNCAPPED_LEGACY_URL = `${BASE}?review=1&preset=low&audio=0&dynres=0`;

test('a window without a measurable median is never compared as a change, whichever side it is on', () => {
  const empty = summariseFrames([]);
  const oneTick = summariseFrames([{ now: 100, frameTime: 100 }]);
  assert.deepEqual([oneTick.presentedFrames, oneTick.presentationMedianMs, oneTick.rafTicks], [0, null, 0]);
  const numericChange = / -?\d+(\.\d+)? %\)$/;
  for (const [name, frames] of [['empty window', empty], ['one-tick window', oneTick]]) {
    for (const [baseName, base, measure] of [['presentation baseline', presented(33.3), 'presentations'], ['older uncapped baseline', legacy(UNCAPPED_LEGACY_URL, 16.7), 'rafTicks-uncapped']]) {
      const [row] = compareRuns(windowed(frames), base).rows;
      assert.equal(row.frameIntervalMs.measureBaseline, measure, `${name} vs ${baseName}`);
      assert.equal(row.frameIntervalMs.changePercent, null, `${name} vs ${baseName}`);
      assert.equal(row.frameIntervalMs.insufficientHere, true);
      assert.equal(row.frameIntervalMs.insufficientBaseline, false);
      assert.match(describeRow(row), /not comparable: insufficient measurement here\)$/, `${name} vs ${baseName}`);
      assert.doesNotMatch(describeRow(row), numericChange);
    }
    // The other direction: the unmeasurable window is the baseline of a normal run.
    const [reverse] = compareRuns(presented(33.3), windowed(frames)).rows;
    assert.equal(reverse.frameIntervalMs.changePercent, null, `normal vs ${name}`);
    assert.equal(reverse.frameIntervalMs.insufficientBaseline, true);
    assert.equal(reverse.frameIntervalMs.insufficientHere, false);
    assert.match(describeRow(reverse), /not comparable: insufficient measurement in the baseline\)$/);
    assert.doesNotMatch(describeRow(reverse), numericChange);
    // Both sides unmeasurable.
    const [both] = compareRuns(windowed(frames), windowed(frames)).rows;
    assert.equal(both.frameIntervalMs.changePercent, null);
    assert.match(describeRow(both), /not comparable: insufficient measurement on both sides\)$/);
  }
  // An older result with a null rAF median is equally unmeasurable, as a baseline and as the current side.
  const [legacyNull] = compareRuns(presented(33.3), legacy(UNCAPPED_LEGACY_URL, null)).rows;
  assert.equal(legacyNull.frameIntervalMs.measureBaseline, 'rafTicks-uncapped');
  assert.equal(legacyNull.frameIntervalMs.changePercent, null);
  assert.equal(legacyNull.frameIntervalMs.insufficientBaseline, true);
  assert.match(describeRow(legacyNull), /not comparable: insufficient measurement in the baseline\)$/);
  const [legacyHere] = compareRuns(legacy(UNCAPPED_LEGACY_URL, null), presented(33.3)).rows;
  assert.equal(legacyHere.frameIntervalMs.changePercent, null);
  assert.equal(legacyHere.frameIntervalMs.insufficientHere, true);
  // Zero is not a usable median either.
  assert.equal(compareRuns(presented(0), presented(33.3)).rows[0].frameIntervalMs.changePercent, null);
  // A normal window still compares as before.
  const [normal] = compareRuns(presented(36.6), presented(33.3)).rows;
  assert.equal(normal.frameIntervalMs.changePercent, 9.9);
  assert.match(describeRow(normal), /presentation median 33\.3 -> 36\.6 ms \(9\.9 %\)$/);
});

/** Page globals for sampleFrames(): a controlled clock, a requestAnimationFrame that ticks every 16 ms, and the API. */
async function inPage(api, body) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let clock = 0, scheduled = 0;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true });
  globalThis.window = { __HELSINKI_GAME__: api };
  globalThis.requestAnimationFrame = callback => { scheduled++; setImmediate(() => { clock += 16; callback(clock); }); };
  try { return await body(() => scheduled, () => clock); } finally {
    Object.defineProperty(globalThis, 'performance', saved);
    delete globalThis.window;
    delete globalThis.requestAnimationFrame;
  }
}

test('the in-page sampler rejects at once on a shell without presentation()', async () => {
  await inPage({ ready: true, stats: () => ({}) }, async scheduled => {
    await assert.rejects(sampleFrames(100), /presentation\(\)/);
    assert.equal(scheduled(), 0, 'no tick was requested');
  });
  await inPage({ ready: true, presentation: () => ({ tick: 3 }) }, async scheduled => {
    await assert.rejects(sampleFrames(100), /frameTime/);
    assert.equal(scheduled(), 0);
  });
  await inPage(undefined, async () => { await assert.rejects(sampleFrames(100), /presentation\(\)/); });
});

test('an exception inside the sampling loop rejects instead of leaving the promise pending', async () => {
  let calls = 0;
  const api = { presentation: () => { calls++; if (calls === 4) throw new TypeError('lost'); return { frameTime: 1 }; } };
  // Call 1 is the compatibility check; calls 2, 3 and 4 are ticks 1, 2 and 3.
  await inPage(api, async () => { await assert.rejects(sampleFrames(1000), /lost/); });
});

test('a compatible shell resolves with one sample per tick', async () => {
  let presentedAt = 0;
  const api = { presentation: () => ({ frameTime: presentedAt }) };
  await inPage(api, async (scheduled, clock) => {
    const wrapped = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = callback => wrapped(now => { presentedAt = clock() ; callback(now); });
    const samples = await sampleFrames(100);
    assert.deepEqual(samples.map(s => s.now), [16, 32, 48, 64, 80, 96, 112]);
    assert.deepEqual(samples.map(s => s.frameTime), [16, 32, 48, 64, 80, 96, 112]);
    assert.equal(scheduled(), 7);
  });
});

test('the adaptive sampler rejects at once on a shell without usable stats()', async () => {
  await inPage(undefined, async scheduled => {
    await assert.rejects(sampleAdaptive(100), /stats\(\)/);
    assert.equal(scheduled(), 0, 'no tick was requested');
  });
  await inPage({ ready: true, presentation: () => ({ frameTime: 1 }) }, async scheduled => {
    await assert.rejects(sampleAdaptive(100), /stats\(\)/);
    assert.equal(scheduled(), 0);
  });
  await inPage({ stats: () => ({ resolutionScale: '1', tier: 'standard', frameIntervalMs: 16 }) }, async scheduled => {
    await assert.rejects(sampleAdaptive(100), /resolutionScale/);
    assert.equal(scheduled(), 0);
  });
  await inPage({ stats: () => ({ resolutionScale: 1, tier: 'standard' }) }, async scheduled => {
    await assert.rejects(sampleAdaptive(100), /frameIntervalMs/);
    assert.equal(scheduled(), 0);
  });
  await inPage({ stats: () => { throw new TypeError('no renderer'); } }, async scheduled => {
    await assert.rejects(sampleAdaptive(100), /no renderer/);
    assert.equal(scheduled(), 0);
  });
});

test('an exception inside the adaptive sampling loop rejects instead of leaving the promise pending', async () => {
  let calls = 0;
  const api = { stats: () => { calls++; if (calls === 4) throw new TypeError('lost'); return { resolutionScale: 1, tier: 'standard', frameIntervalMs: 16 }; } };
  // Call 1 is the compatibility check; calls 2, 3 and 4 are ticks 1, 2 and 3.
  await inPage(api, async () => { await assert.rejects(sampleAdaptive(1000), /lost/); });
});

test('a compatible shell gives the adaptive samples in the shape analyseAdaptive reads', async () => {
  const api = { stats: () => ({ resolutionScale: .8, tier: 'standard', frameIntervalMs: 16.66 }) };
  await inPage(api, async scheduled => {
    const samples = await sampleAdaptive(100);
    assert.deepEqual(samples, [16, 32, 48, 64, 80, 96, 112].map(ms => ({ t: ms / 1000, scale: .8, tier: 'standard', intervalMs: 16.7 })));
    assert.equal(scheduled(), 7);
    assert.equal(analyseAdaptive(samples, { resolutionFloor: .5 }).lowestScale, .8);
  });
  await inPage({ stats: () => ({ resolutionScale: 1, frameIntervalMs: 20 }) }, async () => {
    assert.equal((await sampleAdaptive(10))[0].tier, null, 'a shell without tiers records null');
  });
});

test('the in-page sampler uses only page globals, so Playwright can serialise it', () => {
  for (const sampler of [sampleFrames, sampleAdaptive]) {
    const source = sampler.toString();
    assert.match(source, new RegExp(`^function ${sampler.name}\\(duration\\)`));
    for (const name of ['summariseFrames', 'presentationIntervals', 'analyseAdaptive', 'import', 'require']) assert.ok(!source.includes(name), `${sampler.name}: ${name}`);
  }
});

test('a setup failure after launch closes the browser and rethrows the original error', async () => {
  let closed = 0;
  const browser = { close: async () => { closed++; } };
  const failure = new Error('page.goto: net::ERR_CONNECTION_REFUSED');
  await assert.rejects(closeOnFailure(browser, async () => { throw failure; }), error => error === failure);
  assert.equal(closed, 1);
  const gone = { close: async () => { throw new Error('browser already closed'); } };
  await assert.rejects(closeOnFailure(gone, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(await closeOnFailure(browser, async () => ({ ready: true })), { ready: true });
  assert.equal(closed, 1, 'a successful setup leaves the browser open for the caller');
});

test('without a configured floor (a shell that does not report one) floor figures are unknown', () => {
  const result = analyseAdaptive([frame(0, .5), frame(4, .5, 'low')], { resolutionFloor: null });
  assert.equal(result.resolutionFloor, null);
  assert.equal(result.floorReachedAtSeconds, null);
  assert.equal(result.secondsAtFloorBeforeChange, null);
  assert.deepEqual(result.firstChange, { atSeconds: 4, tier: 'low' });
});
