// Weak-GPU measurement (AC-10): true presentation intervals, renderer counters, texture memory and formats, the
// transcode support set, the resident cell set and the detail tier per preset and spot, on SwiftShader (the software
// weak-GPU proxy) or a real GPU through ANGLE (d3d11, vulkan). One Chromium at a time; loopback servers only.
//
//   node tools/verify/probe-weak-gpu.mjs --url http://127.0.0.1:5329/Helsinki-rides/ --out build/perf/run-a
//     [--angle swiftshader|d3d11|vulkan] [--scenario fixed|adaptive] [--presets standard,low] [--spots "Senate Square,Esplanadi"]
//     [--seconds 5] [--size 1280x720] [--query mipdrop=1] [--label candidate] [--compare build/perf/run-b/result.json]
//
// fixed:    ?review=1&preset=<p>&audio=0&dynres=0, every spot in one page; after settling the probe samples every
//           requestAnimationFrame tick for --seconds together with presentation().frameTime, the time of the game's
//           last presented frame. A tick at which frameTime changed is a presentation; the reported frame figures
//           (presentedFrames, presentationMedianMs, presentationP90Ms) are the intervals between those frameTimes, so
//           paced runs (--query fps=30, mobile=1) count the frames the game drew, not the display's rAF ticks. The raw
//           tick cadence is kept as rafTicks, rafTickMedianMs and rafTickP90Ms. Then it records stats(),
//           textureMemory(), textureFormats(), transcode(), residentCells() and the tier. A shell whose review API
//           has no presentation() with a numeric frameTime fails the run at once instead of hanging.
// adaptive: ?review=1&preset=<p>&audio=0&dynres=1, one fresh page per spot; plays for --seconds (default 40) and records
//           the render scale, tier and the game's own frame interval at every rAF tick, the first tier change and the
//           contiguous time the scale sat at the game's configured floor (config().resolutionFloor) before it. A
//           shell whose stats() lacks numeric resolutionScale and frameIntervalMs fails the run at once.
// Shells without the newer review calls (textureFormats, residentCells) are measured the same way: a WebGL upload hook
// counts allocated formats in both, and the rendered cells are recorded next to the resident sets.
// --compare <result.json> writes comparison.json: per preset and spot, whether the resident sets are identical (true or
// false only when both sides report complete residentCells(); otherwise null, "residency unproven"), texture MiB and
// frame-interval changes with the measure of each side, and both format histograms (tools/verify/lib/weak-gpu-analysis.mjs).
// Results of the older probe hold rAF ticks (frames, rafMedianMs); they equal presentations only when the run's
// measured URL (runs[i].url) did not pace the game (fps=30|60 or mobile=1, the game's own rule). Paced or URL-less older
// runs are reported as not comparable; the comparison says which measure each side provides.
// Every failure (setup, incompatible shell, measurement) closes the browser, sets result.failed, writes result.json
// and exits 1.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { analyseAdaptive, closeOnFailure, compareRuns, describeRow, measuredUrl, sampleAdaptive, sampleFrames, summariseFrames, usableMedian }
  from './lib/weak-gpu-analysis.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, out: { type: 'string' }, angle: { type: 'string', default: 'swiftshader' },
  scenario: { type: 'string', default: 'fixed' }, presets: { type: 'string' }, spots: { type: 'string' },
  seconds: { type: 'string' }, size: { type: 'string', default: '1280x720' }, query: { type: 'string', default: '' },
  label: { type: 'string', default: '' }, compare: { type: 'string' },
} });
assert.ok(values.url && values.out, '--url and --out are required');
const target = new URL(values.url);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.protocol === 'http:', 'only loopback http servers are measured');
assert.ok(['swiftshader', 'd3d11', 'vulkan'].includes(values.angle), '--angle must be swiftshader, d3d11 or vulkan');
assert.ok(['fixed', 'adaptive'].includes(values.scenario), '--scenario must be fixed or adaptive');
const adaptive = values.scenario === 'adaptive';
const presets = (values.presets ?? (adaptive ? 'standard' : 'standard,low')).split(',');
assert.ok(presets.every(p => ['standard', 'low', 'auto'].includes(p)), '--presets: standard, low or auto (review-only estimate)');
const spots = (values.spots ?? (adaptive ? 'Senate Square' : 'Senate Square,Kluuvi / Aleksanterinkatu,Esplanadi')).split(',').map(s => s.trim()).filter(Boolean);
const seconds = Number(values.seconds ?? (adaptive ? 40 : 5));
assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 600, '--seconds must be between 0 and 600');
const [width, height] = values.size.split('x').map(Number);
assert.ok(width >= 320 && height >= 240, '--size WIDTHxHEIGHT');
const extra = new URLSearchParams(values.query);
for (const key of ['review', 'preset', 'audio', 'dynres']) assert.ok(!extra.has(key), `--query must not set ${key}`);
const out = path.resolve(values.out);
assert.ok(!existsSync(out), `--out ${out} already exists: measurements go to a fresh directory`);
const baseline = values.compare ? JSON.parse(await readFile(values.compare, 'utf8')) : null;
await mkdir(out, { recursive: false });

const pageUrl = preset => measuredUrl(target, { review: '1', preset, audio: '0', dynres: adaptive ? '1' : '0' }, values.query);

/** A launched Chromium with the game ready; any failure after the launch closes the browser and rethrows. */
async function openPage(url) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${values.angle}`, '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  return closeOnFailure(browser, () => preparePage(browser, url));
}

async function preparePage(browser, url) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    // Allocated texture formats (texStorage2D: compressed and uncompressed), identical for every shell under test.
    const uploads = {};
    window.__PROBE_UPLOADS__ = uploads;
    const storage = WebGL2RenderingContext.prototype.texStorage2D;
    WebGL2RenderingContext.prototype.texStorage2D = function (target, levels, format, ...rest) {
      uploads[format] = (uploads[format] ?? 0) + 1;
      return storage.call(this, target, levels, format, ...rest);
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__HELSINKI_GAME__?.ready === true || !!window.__HELSINKI_ERROR__, null, { timeout: 600000 });
  const failure = await page.evaluate(() => window.__HELSINKI_ERROR__ ?? null);
  if (failure) throw new Error(`game failed to start: ${failure}`);
  const session = await page.evaluate(() => {
    const api = window.__HELSINKI_GAME__, gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return { renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null, release: api.release,
      config: api.config?.() ?? null, transcode: api.transcode?.() ?? null };
  });
  return { browser, page, errors, readySeconds: +((Date.now() - t0) / 1000).toFixed(1), session };
}

const call = (page, name, arg) => page.evaluate(([n, a]) => window.__HELSINKI_GAME__[n](a), [name, arg]);

async function settleAt(page, label) {
  await call(page, 'pause');
  await call(page, 'dropIn', label);
  await call(page, 'awaitVisuals');
  await page.evaluate(() => window.__HELSINKI_GAME__.setCamera(Math.PI * 0.75, -0.1));
}

/** The complete resident set where the shell reports it, and in every shell the cells that rendered last frame. */
function census(page) {
  return page.evaluate(() => {
    const api = window.__HELSINKI_GAME__, stats = api.stats(), memory = api.textureMemory();
    const rendered = api.renderBreakdown().groups.map(g => g.id).filter(id => /^(detail|coarse):/.test(id)).sort();
    const streaming = api.streaming?.() ?? null;
    return {
      tier: stats.tier ?? null, resolutionScale: stats.resolutionScale, drawCalls: stats.drawCalls, triangles: stats.triangles, cells: stats.cells,
      textureMemory: { mib: +memory.mib.toFixed(2), textures: memory.textures,
        byClass: memory.byClass ? Object.fromEntries(Object.entries(memory.byClass).map(([k, v]) => [k, +v.toFixed(2)])) : null },
      textureFormats: api.textureFormats?.() ?? null, uploads: { ...window.__PROBE_UPLOADS__ },
      residentCells: api.residentCells?.() ?? null, renderedCells: rendered,
      pending: streaming ? { detail: streaming.detail.pendingCells, fallback: streaming.fallback.pendingCells, missing: streaming.coverage.missingCells.length } : null,
      cityMaterials: api.cityMaterials?.() ?? null,
    };
  });
}

/**
 * Every requestAnimationFrame tick for `ms`: its timestamp and presentation().frameTime, the `now` of the game's last
 * Game.frame() call (lib sampleFrames, run in the page). The game's FramePacer skips ticks under fps or mobile pacing,
 * so ticks are not presentations; summariseFrames() selects the ticks at which frameTime changed. The sampler rejects
 * on a shell without a numeric presentation().frameTime and on any exception during sampling.
 */
const frameSamples = (page, ms) => page.evaluate(sampleFrames, ms);

async function fixedRun(preset) {
  const url = pageUrl(preset), opened = await openPage(url), rows = [];
  try {
    // An incompatible shell fails here, before minutes of settling, with the sampler's own check.
    await frameSamples(opened.page, 0);
    for (const label of spots) {
      await settleAt(opened.page, label);
      await call(opened.page, 'resume');
      await opened.page.waitForTimeout(2500);
      const frames = summariseFrames(await frameSamples(opened.page, seconds * 1000));
      await call(opened.page, 'pause');
      await call(opened.page, 'awaitVisuals');
      rows.push({ label, ...frames, ...(await census(opened.page)) });
      const row = rows.at(-1);
      console.log(`${preset} ${label}: ${row.presentedFrames} presentations, median ${row.presentationMedianMs} ms, p90 ${row.presentationP90Ms} ms; `
        + `${row.rafTicks} rAF ticks, median ${row.rafTickMedianMs} ms; tier ${row.tier}, ${row.textureMemory.mib} MiB`
        + (usableMedian(row.presentationMedianMs) ? '' : ' [INSUFFICIENT: fewer than two presentations in the window; not comparable]'));
    }
  } finally { await opened.browser.close(); }
  return { preset, url, readySeconds: opened.readySeconds, ...opened.session, spots: rows, errors: opened.errors.slice(0, 20) };
}

async function adaptiveRun(preset) {
  const runs = [];
  for (const label of spots) {
    const url = pageUrl(preset), opened = await openPage(url);
    try {
      // An incompatible shell fails here, before settling, with the sampler's own check.
      await opened.page.evaluate(sampleAdaptive, 0);
      await settleAt(opened.page, label);
      const before = await census(opened.page);
      await call(opened.page, 'resume');
      // Every rAF tick after the game's own frame callback: its time, render scale, tier and the game's frame interval
      // (lib sampleAdaptive, run in the page; it rejects on any exception or non-numeric reading).
      const frames = await opened.page.evaluate(sampleAdaptive, seconds * 1000);
      await call(opened.page, 'pause');
      await call(opened.page, 'awaitVisuals');
      const after = await census(opened.page);
      // The floor is the game's configuration, read once per run, never the lowest scale observed.
      const analysis = analyseAdaptive(frames, { resolutionFloor: opened.session.config?.resolutionFloor ?? null, startTier: before.tier });
      runs.push({ label, url, readySeconds: opened.readySeconds, ...opened.session, ...analysis, before, after, frames, errors: opened.errors.slice(0, 20) });
      const { startTier, firstChange, resolutionFloor, floorReachedAtSeconds, secondsAtFloorBeforeChange } = analysis;
      console.log(`${preset} ${label}: ${startTier} -> ${firstChange ? `${firstChange.tier} at ${firstChange.atSeconds} s` : 'no change'}, floor ${resolutionFloor ?? 'unknown'} `
        + `${floorReachedAtSeconds === null ? 'never reached' : `reached at ${floorReachedAtSeconds} s`}, ${secondsAtFloorBeforeChange ?? '-'} s at the floor before the change`);
    } finally { await opened.browser.close(); }
  }
  return { preset, spots: runs };
}

const result = { tool: 'probe-weak-gpu', label: values.label, angle: values.angle, scenario: values.scenario, size: `${width}x${height}`,
  seconds, query: values.query, startedAt: new Date().toISOString(), runs: [] };
try {
  for (const preset of presets) result.runs.push(adaptive ? await adaptiveRun(preset) : await fixedRun(preset));
} catch (error) {
  result.failed = String(error?.stack ?? error);
} finally {
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
}
console.table(result.runs.flatMap(run => (run.spots ?? []).map(s => adaptive
  ? { preset: run.preset, spot: s.label, start: s.startTier, change: s.firstChange ? `${s.firstChange.tier} @ ${s.firstChange.atSeconds} s` : '-', floor: s.resolutionFloor, floorAtS: s.floorReachedAtSeconds, atFloorS: s.secondsAtFloorBeforeChange, errors: s.errors.length }
  : { preset: run.preset, spot: s.label, presented: s.presentedFrames, medianMs: s.presentationMedianMs, p90Ms: s.presentationP90Ms, rafTicks: s.rafTicks, tickMs: s.rafTickMedianMs, tier: s.tier, drawCalls: s.drawCalls, triangles: s.triangles, textureMiB: s.textureMemory.mib, errors: run.errors.length })));
if (baseline && !result.failed) {
  const comparison = compareRuns(result, baseline);
  await writeFile(path.join(out, 'comparison.json'), JSON.stringify(comparison, null, 1));
  for (const row of comparison.rows) console.log(describeRow(row));
}
console.log(`wrote ${path.join(out, 'result.json')}${result.failed ? ' (FAILED)' : ''}`);
if (result.failed) process.exitCode = 1;
