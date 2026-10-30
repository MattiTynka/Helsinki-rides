// Startup smoothness after the Play click (docs/startup-stutter-plan-2026-10-30.md, Phase 0): fresh profile, click Play,
// run Snow with real keyboard input to car-1, press F, enter and drive forward 10 s. Page instrumentation records rAF
// timestamps, presented frames (rAF callbacks in which the game canvas #view issued a draw call; frame metrics use these,
// raw rAF intervals are a secondary field), long tasks, every WebGL program link with its SHADER_NAME, WebGL calls of
// 0.5 ms or more and AudioContext states; result.json carries the metrics and a pass/fail per threshold
// (lib/startup-smoothness.ts). Works on review and production builds: window.__HELSINKI_GAME__ is used only when present
// (camera aim, tick, player and car-1 state, model/collision waits).
// Stages (decision D-10): moved needs the player >= 0.5 m from the click position (test API) or, in production, a
// presented frame in which most persistent draws (program + draw index) moved; reachedCar needs nearVehicle car-1 (test
// API) or the active locale's enter prompt; enteredCar needs driving car-1 (test API) or a driving HUD (production
// certifies "entered a vehicle"; targetAssociation records that no vehicle identity is exposed). The drive holds W for
// T = received keydown to keyup on the page clock (10000-10500 ms), samples at the start, every 250 ms and the release,
// and counts only under lib driveVerdict: test API tick/mode/inVehicle/car-1 at every sample (tick advance gap <= 500 ms,
// final interval advanced, >= half the ticks, car-1 >= 10 m), or production #stats tick, speed and timestamped view
// changes (HUD tick gap <= 1000 ms, final second advanced, speed > 0 for half the time, >= 10 view changes, <= 1 s of
// moving time without one); a pause seen in a sample or latched by the page fails it. The scripted window ends at the
// recorded W release.
//   node tools/verify/verify-startup-smoothness.ts --url http://127.0.0.1:5419/ --out ../evidence/NEW_DIR
//     [--preset standard|low] [--wait-before-play <ms>] [--shot] [--warm] [--no-parallel-compile] [--no-autoplay-override]
//     [--world-dir <local release dir> --world-base-url <pinned worldBaseUrl>] [--allow-live]
// --shot fires one shot on foot before running to the car: it aims (right button) until the HUD shows the drawn pistol's
// magazine, then presses the trigger, and the page releases it in the first frame after the HUD
// magazine drops (at most 6 ticks per frame against the 10-tick pistol cooldown); the count is recorded from the HUD and,
// when present, the test API. --warm loads once, waits for the service worker to control the
// page, then measures a second visit in the same profile. --world-dir/--world-base-url fulfil every request under the
// pinned world base from local files (page and service worker; nothing is sent to the world origin). --no-parallel-compile
// hides KHR_parallel_shader_compile. --no-autoplay-override drops Chromium's autoplay flag (the AC-5 audio run).
// Mapped world files are served only when their real path stays inside the real --world-dir. Without --allow-live Chromium
// runs isolated (--host-resolver-rules: no host but localhost and 127.0.0.1 resolves, no proxy), so nothing the route does
// not answer, redirect hops included, can leave the machine; result.json records network.isolation. Every off-loopback
// request the context starts (page, service worker, redirect hops) is accounted once settled; with --world-dir the
// world-local-only threshold passes only under isolation with no request left unanswered or unsettled.
// Non-loopback URLs need --allow-live; the harness then only navigates to the URL, clicks the Play button (never inside a
// form) and sends keyboard/mouse input to the canvas; form submissions, every non-GET/HEAD/OPTIONS request (loopback
// included, so no redirect hop can carry a mutation) and other off-loopback navigations are aborted and listed.
// ANGLE comes from HELSINKI_VERIFY_ANGLE (d3d11 default, vulkan, swiftshader).
// Status and exit code (lib assembleStartupResult): MEASURED (0, also when thresholds fail), INCOMPLETE (2: a scenario stage
// timed out or failed; every threshold is INVALID and the failed stages are named), ERROR (1: startup failed or an input
// target was refused).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page, type Request } from 'playwright';
import { validateReleaseId, validateWorldBaseUrl } from '../../apps/game/src/world/urls.ts';
import { apiEntry, apiNearTarget, assembleStartupResult, canonicalWorldFile, checkTargetUrl, clickTargetProblem, contentTypeFor, DRIVE, driveVerdict, egressSummary,
  enterPromptShown, isLoopbackUrl, liveRequestBlock, persistentViewsMoved, playerMoved, shotSummary, transportIsolationRule, worldFileFor, type ClickTarget, type DriveSample,
  type RequestRecord, type StartupProbe } from './lib/startup-smoothness.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, out: { type: 'string' }, preset: { type: 'string', default: 'standard' }, 'wait-before-play': { type: 'string', default: '0' },
  shot: { type: 'boolean', default: false }, 'allow-live': { type: 'boolean', default: false }, warm: { type: 'boolean', default: false },
  'world-dir': { type: 'string' }, 'world-base-url': { type: 'string' }, 'no-parallel-compile': { type: 'boolean', default: false },
  'no-autoplay-override': { type: 'boolean', default: false },
} });
if (!values.url || !values.out) throw new Error('--url and a new --out directory are required');
const allowLive = values['allow-live'];
const target = checkTargetUrl(values.url, allowLive);
if (values.preset !== 'standard' && values.preset !== 'low') throw new Error('--preset must be standard or low');
target.searchParams.set('preset', values.preset);
const waitBeforePlayMs = Number(values['wait-before-play']);
if (!Number.isInteger(waitBeforePlayMs) || waitBeforePlayMs < 0 || waitBeforePlayMs > 600000) throw new Error('--wait-before-play must be whole milliseconds in [0, 600000]');
const angle = process.env.HELSINKI_VERIFY_ANGLE ?? 'd3d11';
if (!['d3d11', 'vulkan', 'swiftshader'].includes(angle)) throw new Error('HELSINKI_VERIFY_ANGLE must be d3d11, vulkan or swiftshader');
if ((values['world-dir'] === undefined) !== (values['world-base-url'] === undefined)) throw new Error('--world-dir and --world-base-url go together');
let world: { dir: string; base: string; release: string } | null = null;
if (values['world-dir'] && values['world-base-url']) {
  const dir = path.resolve(values['world-dir']);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { worldReleaseId?: unknown };
  world = { dir, base: validateWorldBaseUrl(values['world-base-url']), release: validateReleaseId(manifest.worldReleaseId) };
}
const OUT = values.out;
if (existsSync(OUT)) throw new Error(`${OUT} exists; evidence directories are never overwritten`);
mkdirSync(OUT, { recursive: true });

/** Spawn calibration on the review build (camera yaw -2.094, car-1 bearing -1.789 rad, 0.0022 rad per pixel, yaw falls with +x). */
const SPAWN_TURN_PX = -139;
const CAR = 'car-1', RUN_TIMEOUT_MS = 25000, ENTER_TIMEOUT_MS = 12000, MOVE_TIMEOUT_MS = 20000;

type Api = {
  tick(): number; camera(): { yaw: number; pitch: number }; setCamera(yaw: number, pitch: number): void;
  state(): { player: { mode: string; position: number[]; nearVehicle: string | null; inVehicle: string | null }; vehicles: { id: string; position: number[] }[] };
  deferredModels(): { blockedSeconds: number }; collision(): { blockedSeconds: number };
  streaming(): { coverage: { blockedSeconds: number } } | null; events(since?: number): { type: string }[];
};
type Harness = {
  armed: boolean; blockedSubmits: number;
  drive: { armed: boolean; downAt: number | null; upAt: number | null; viewChangeTimes: number[] };
  pauseTransitions: [number, boolean][];
  shot: { baseline: number | null; releasedAt: number | null };
};
type ProbeWindow = Window & { __startupProbe: StartupProbe & Harness; __HELSINKI_GAME__?: Api };

/** Runs in the page before any game script. */
function instrument(options: { noParallelCompile: boolean; blockSubmits: boolean },
  viewsMoved: (previous: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>) => boolean): void {
  const w = window as unknown as ProbeWindow;
  const P: ProbeWindow['__startupProbe'] = { armed: false, blockedSubmits: 0, clickAt: null, windowEnd: null, playEnabledAt: null, frames: [], presented: [], ticks: [], programs: [], gl: [],
    longTasks: [], viewChangedAt: null, audio: [], drive: { armed: false, downAt: null, upAt: null, viewChangeTimes: [] }, pauseTransitions: [], shot: { baseline: null, releasedAt: null } };
  w.__startupProbe = P;
  // View changes (production moved stage, first view change, drive view changes): each presented #view frame maps one key
  // per draw (program id + draw index within that program) to the modelView translation in force for that program; a
  // frame counts when most draws persisting from the previous presented frame moved (lib persistentViewsMoved).
  const programIds = new WeakMap<object, number>(), modelViewProgram = new WeakMap<object, number>(), programView = new Map<number, Float64Array>();
  let nextProgramId = 0, currentProgram: number | null = null, frameViews = new Map<string, string>(), frameViewsTime: number | null = null;
  let previousFrameViews: Map<string, string> | null = null;
  const drawsPerProgram = new Map<number, number>();
  const programId = (program: object) => { let id = programIds.get(program); if (id === undefined) { id = nextProgramId++; programIds.set(program, id); } return id; };
  const collectingViews = () => P.viewChangedAt === null || P.drive.armed;
  const closeViewFrame = () => {
    if (!collectingViews()) { previousFrameViews = null; frameViews = new Map(); frameViewsTime = null; return; }
    if (frameViewsTime === null) return;
    if (previousFrameViews && viewsMoved(previousFrameViews, frameViews)) {
      if (P.viewChangedAt === null && P.clickAt !== null && frameViewsTime >= P.clickAt) P.viewChangedAt = frameViewsTime;
      if (P.drive.armed) P.drive.viewChangeTimes.push(frameViewsTime);
    }
    previousFrameViews = frameViews; frameViews = new Map(); frameViewsTime = null; drawsPerProgram.clear();
  };
  // Pause latch: every class change of the pause menu records the visibility before it and after the batch.
  new MutationObserver(records => {
    const now = performance.now(), menu = document.getElementById('pause-menu');
    let seen = false;
    for (const r of records) if ((r.target as Element).id === 'pause-menu') { seen = true; P.pauseTransitions.push([now, !/(^|\s)hidden(\s|$)/.test(r.oldValue ?? '')]); }
    if (seen && menu) P.pauseTransitions.push([now, !menu.classList.contains('hidden')]);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  // The drive's W keydown and keyup as the page received them.
  addEventListener('keydown', event => { if (P.drive.armed && event.code === 'KeyW' && !event.repeat && P.drive.downAt === null) P.drive.downAt = event.timeStamp; }, true);
  addEventListener('keyup', event => { if (P.drive.armed && event.code === 'KeyW' && P.drive.downAt !== null && P.drive.upAt === null) P.drive.upAt = event.timeStamp; }, true);
  const magazine = () => { const n = /\d+/.exec(document.getElementById('weapon')?.textContent ?? '')?.[0]; return n === undefined ? null : Number(n); };
  const raf = window.requestAnimationFrame.bind(window);
  // This loop runs first in every frame; the game's callbacks run after it, marked with the frame time.
  let frameTime: number | null = null, lastPresented: number | null = null;
  const loop = (t: number) => {
    P.frames.push(t);
    // One shot: release the trigger before the game steps again once the HUD shows the magazine dropped.
    if (P.shot.baseline !== null && P.shot.releasedAt === null) {
      const n = magazine();
      if (n !== null && n < P.shot.baseline) { dispatchEvent(new MouseEvent('mouseup', { button: 0 })); P.shot.releasedAt = t; }
    }
    const api = w.__HELSINKI_GAME__;
    if (api) P.ticks.push([t, api.tick()]);
    closeViewFrame();
    raf(loop);
  };
  raf(loop);
  window.requestAnimationFrame = callback => raf(t => { frameTime = t; try { callback(t); } finally { frameTime = null; } });
  const play = new MutationObserver(() => {
    const button = document.getElementById('play-button') as HTMLButtonElement | null;
    if (button && !button.disabled) { P.playEnabledAt = performance.now(); play.disconnect(); }
  });
  play.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
  addEventListener('click', event => { if (P.armed && P.clickAt === null) P.clickAt = event.timeStamp; }, true);
  if (options.blockSubmits) addEventListener('submit', event => { event.preventDefault(); P.blockedSubmits++; }, true);
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) P.longTasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch { /* No long-task timing. */ }
  const Audio = window.AudioContext;
  if (Audio) {
    let contexts = 0;
    window.AudioContext = class extends Audio {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args);
        const index = contexts++;
        P.audio.push([performance.now(), index, this.state]);
        this.addEventListener('statechange', () => P.audio.push([performance.now(), index, this.state]));
      }
    };
  }
  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const original = { ...Object.fromEntries(['shaderSource', 'attachShader', 'linkProgram', 'getUniformLocation', 'uniformMatrix4fv', 'getExtension', 'getSupportedExtensions'].map(n => [n, proto[n]!])) };
  const shaderInfo = new WeakMap<object, [string, string]>(), programShaders = new WeakMap<object, [string, string]>();
  const DEFINES = ['USE_SKINNING', 'USE_MAP', 'USE_NORMALMAP', 'USE_COLOR', 'USE_FOG', 'USE_EMISSIVEMAP', 'USE_ALPHATEST', 'USE_ROUGHNESSMAP', 'USE_METALNESSMAP', 'DOUBLE_SIDED',
    'FLAT_SHADED', 'USE_SHADOWMAP', 'OPAQUE', 'USE_INSTANCING', 'USE_MORPHTARGETS', 'USE_BATCHING', 'USE_ENVMAP', 'USE_LIGHTMAP', 'USE_AOMAP', 'USE_TRANSMISSION', 'USE_CLEARCOAT'];
  proto.shaderSource = function (shader, source) {
    const text = String(source);
    const type = /#define SHADER_TYPE (\S+)/.exec(text)?.[1];
    shaderInfo.set(shader as object, [/#define SHADER_NAME ([^\n]*)/.exec(text)?.[1]?.trim() || (type ? `(${type})` : '?'), DEFINES.filter(d => new RegExp(`#define ${d}(?![A-Z_])`).test(text)).join(',')]);
    return original.shaderSource!.call(this, shader, source);
  };
  proto.attachShader = function (program, shader) {
    if (!programShaders.has(program as object)) programShaders.set(program as object, shaderInfo.get(shader as object) ?? ['?', '']);
    return original.attachShader!.call(this, program, shader);
  };
  proto.linkProgram = function (program) {
    const [name, defines] = programShaders.get(program as object) ?? ['?', ''];
    P.programs.push([performance.now(), name, defines]);
    return original.linkProgram!.call(this, program);
  };
  proto.getUniformLocation = function (program, name) {
    const location = original.getUniformLocation!.call(this, program, name);
    if (location && name === 'modelViewMatrix') modelViewProgram.set(location as object, programId(program as object));
    return location;
  };
  // The modelView translation in force per program (three.js skips uploading an unchanged value).
  proto.uniformMatrix4fv = function (location, ...rest) {
    const id = location ? modelViewProgram.get(location as object) : undefined;
    if (id !== undefined) {
      const m = rest[1] as ArrayLike<number>;
      let v = programView.get(id);
      if (!v) { v = new Float64Array(3); programView.set(id, v); }
      v[0] = m[12]!; v[1] = m[13]!; v[2] = m[14]!;
    }
    return original.uniformMatrix4fv!.call(this, location, ...rest);
  };
  const useProgram = proto.useProgram!;
  proto.useProgram = function (program) { currentProgram = program ? programId(program as object) : null; return useProgram.call(this, program); };
  // A frame is presented when a game rAF callback draws on the game canvas.
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
    const draw = proto[name]!;
    proto[name] = function (...a) {
      if (frameTime !== null && (this as unknown as WebGL2RenderingContext).canvas instanceof HTMLCanvasElement
        && ((this as unknown as WebGL2RenderingContext).canvas as HTMLCanvasElement).id === 'view') {
        if (frameTime !== lastPresented) { lastPresented = frameTime; P.presented.push(frameTime); }
        if (currentProgram !== null && frameViews.size < 1000 && collectingViews()) {
          const n = drawsPerProgram.get(currentProgram) ?? 0, v = programView.get(currentProgram);
          drawsPerProgram.set(currentProgram, n + 1);
          frameViews.set(`${currentProgram}#${n}`, v ? `${Math.round(v[0]! * 1000)},${Math.round(v[1]! * 1000)},${Math.round(v[2]! * 1000)}` : '-');
          frameViewsTime = frameTime;
        }
      }
      return draw.apply(this, a);
    };
  }
  if (options.noParallelCompile) {
    proto.getExtension = function (name) { return name === 'KHR_parallel_shader_compile' ? null : original.getExtension!.call(this, name); };
    proto.getSupportedExtensions = function () { return (original.getSupportedExtensions!.call(this) as string[] | null)?.filter(n => n !== 'KHR_parallel_shader_compile') ?? null; };
  }
  for (const name of Object.getOwnPropertyNames(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (name === 'constructor' || typeof descriptor?.value !== 'function') continue;
    const call = descriptor.value as (...a: unknown[]) => unknown;
    proto[name] = function (...a) {
      const start = performance.now(), result = call.apply(this, a), ms = performance.now() - start;
      if (ms >= 0.5) {
        const detail = name.startsWith('tex') || name.startsWith('compressedTex') ? `${a[3]}x${a[4]}` : name === 'bufferData' ? String((a[1] as ArrayBufferView | null)?.byteLength ?? a[1]) : '';
        P.gl.push([start, name, Math.round(ms * 100) / 100, detail]);
      }
      return result;
    };
  }
}

const isolationRule = transportIsolationRule(allowLive);
const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${angle}`, '--enable-unsafe-swiftshader', ...values['no-autoplay-override'] ? [] : ['--autoplay-policy=no-user-gesture-required'],
    ...isolationRule ? [`--host-resolver-rules=${isolationRule}`, '--no-proxy-server'] : []] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.addInitScript({ content: `(${instrument.toString()})(${JSON.stringify({ noParallelCompile: values['no-parallel-compile'], blockSubmits: allowLive })}, ${persistentViewsMoved.toString()});` });
const network = { isolation: { active: isolationRule !== null, rule: isolationRule }, worldServed: 0, worldNotFound: 0, aborted: 0, abortedRequests: [] as string[], blockedSubmits: 0 };
const answered = new WeakSet<Request>();
const tracked = new Map<Request, RequestRecord>(), settling = new Set<Promise<void>>();
const offLoopback = (url: string) => /^https?:/i.test(url) && !isLoopbackUrl(url);
const track = (request: Request) => {
  let record = tracked.get(request);
  if (!record) {
    record = { url: request.url(), answered: false, outcome: 'pending', fromServiceWorker: false, initiator: request.serviceWorker() ? 'service-worker' : 'page',
      redirected: request.redirectedFrom() !== null };
    tracked.set(request, record);
  }
  return record;
};
// Every request the context starts, including service-worker fetches and redirect hops that never reach the route.
context.on('request', request => { if (offLoopback(request.url())) track(request); });
context.on('requestfinished', request => {
  if (!offLoopback(request.url())) return;
  const record = track(request);
  const done: Promise<void> = request.response().then(response => { record.fromServiceWorker = !!response?.fromServiceWorker(); }, () => {})
    .finally(() => { record.outcome = 'finished'; settling.delete(done); });
  settling.add(done);
});
context.on('requestfailed', request => { if (offLoopback(request.url())) track(request).outcome = 'failed'; });
const canonicalRoot = world ? realpathSync.native(world.dir) : null;
if (world || allowLive) {
  await context.route('**/*', async route => {
    const request = route.request(), url = request.url();
    const abort = (reason: string) => {
      answered.add(request); network.aborted++;
      if (network.abortedRequests.length < 50) network.abortedRequests.push(`${reason} ${request.method()} ${url.slice(0, 160)}`);
      return route.abort('blockedbyclient');
    };
    if (allowLive) {
      const blocked = liveRequestBlock({ url, method: request.method(), navigation: request.isNavigationRequest(), targetHref: target.href });
      if (blocked) return abort(blocked);
    }
    const mapped = world && canonicalRoot ? worldFileFor(url, world.base, world.release, world.dir) : null;
    if (mapped) {
      answered.add(request);
      const file = mapped.kind === 'file' ? canonicalWorldFile(mapped.file, canonicalRoot!) : null;
      if (file) { network.worldServed++; return route.fulfill({ path: file, contentType: contentTypeFor(file), headers: { 'access-control-allow-origin': '*' } }); }
      network.worldNotFound++;
      return route.fulfill({ status: 404, body: '', headers: { 'access-control-allow-origin': '*' } });
    }
    if (isLoopbackUrl(url) || allowLive) return route.continue();
    return abort('off-loopback');
  });
}

const page = await context.newPage();
let consoleErrors: string[] = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const probeTime = (key: 'playEnabledAt' | 'viewChangedAt') => page.evaluate(k => (window as unknown as ProbeWindow).__startupProbe[k], key);
const targetAt = (x: number, y: number) => page.evaluate(([px, py]) => {
  const element = document.elementFromPoint(px, py), lock = document.pointerLockElement;
  if (!element) return null;
  const control = element.closest('button, input') as HTMLButtonElement | null;
  return { tag: element.tagName, id: element.id, inPlayButton: !!element.closest('#play-button'), inForm: !!element.closest('form') || !!control?.form,
    pointerLockedCanvas: lock instanceof HTMLCanvasElement && lock.id === 'view' } satisfies ClickTarget;
}, [x, y] as const);
const refuse = (problem: string | null) => { if (problem) throw new Error(`Refusing input: ${problem}`); };

async function loadUntilPlayable(p: Page): Promise<void> {
  await p.goto(target.href, { waitUntil: 'load', timeout: 180000 });
  await p.waitForFunction(() => {
    const button = document.getElementById('play-button') as HTMLButtonElement | null;
    return !!button && !button.disabled || !!window.__HELSINKI_ERROR__;
  }, undefined, { timeout: 300000, polling: 50 });
  if (await p.evaluate(() => !!window.__HELSINKI_ERROR__)) throw new Error('The game reported a startup error');
}

/** Wait until every tracked off-loopback request settled (or the deadline), then summarise; unsettled ones stay pending. */
async function settledEgress() {
  const deadline = Date.now() + 10000;
  while ([...tracked].some(([request, r]) => r.outcome === 'pending' && !answered.has(request)) && Date.now() < deadline) await sleep(100);
  await Promise.allSettled([...settling]);
  return egressSummary([...tracked].map(([request, r]) => ({ ...r, answered: answered.has(request) })), world?.base ?? null, isolationRule !== null);
}

const script: Record<string, unknown> = { carId: CAR };
const failures: string[] = [];
const stages: [string, boolean][] = [];
const stage = (name: string, ok: boolean) => { script[name] = ok; stages.push([name, ok]); if (!ok) failures.push(name); return ok; };
const mark = async (label: string) => { script[label] = await page.evaluate(() => { const P = (window as unknown as ProbeWindow).__startupProbe; return P.clickAt === null ? null : Math.round(performance.now() - P.clickAt); }); };
let firstVisit: Record<string, unknown> | null = null, driveReleasedAt: number | null = null;
try {
  if (values.warm) {
    await loadUntilPlayable(page);
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout: 120000, polling: 250 });
    firstVisit = { playEnabledMs: await probeTime('playEnabledAt'), serviceWorkerControlled: true, consoleErrors: consoleErrors.length };
    consoleErrors = [];
  }
  await loadUntilPlayable(page);
  if (waitBeforePlayMs) await sleep(waitBeforePlayMs);
  const hasApi = await page.evaluate(() => !!(window as unknown as ProbeWindow).__HELSINKI_GAME__);
  script.method = hasApi ? 'test-api (aim by setCamera, car proximity and mode from state)' : `production (aim by a calibrated ${SPAWN_TURN_PX} px pointer-lock turn, car proximity and mode from the #prompt/#speed HUD)`;
  const tick0 = hasApi ? await page.evaluate(() => (window as unknown as ProbeWindow).__HELSINKI_GAME__!.tick()) : 0;
  const playerAt = () => page.evaluate(() => [...(window as unknown as ProbeWindow).__HELSINKI_GAME__!.state().player.position]);
  const atClick = hasApi ? await playerAt() : null;
  const box = await page.locator('#play-button').boundingBox();
  if (!box) throw new Error('The Play button is not visible');
  const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
  refuse(clickTargetProblem(await targetAt(cx, cy), 'play'));
  await page.evaluate(() => { (window as unknown as ProbeWindow).__startupProbe.armed = true; });
  await page.mouse.click(cx, cy);
  script.playClick = [cx, cy];
  await page.keyboard.down('KeyW');
  // Hold W until Snow moves: >= 0.5 m from the click position (test API), or a presented frame in which most persistent
  // draws moved (production). Tick and view-change timing stay separate metrics.
  const moving = async () => {
    if (!hasApi) return (await probeTime('viewChangedAt')) !== null;
    const evidence = playerMoved(atClick!, await playerAt());
    script.movedDisplacementM = evidence.displacementM;
    return evidence.moved;
  };
  const moveStart = performance.now();
  let moved = false;
  while (!(moved = await moving()) && performance.now() - moveStart < MOVE_TIMEOUT_MS) await sleep(25);
  stage('moved', moved); await mark('movingSeenMs');
  if (!failures.length && values.shot) {
    // Aim to draw the pistol until the HUD shows its magazine, then press the trigger; the page releases it in the first
    // frame after the magazine drops (see instrument).
    refuse(clickTargetProblem(await targetAt(cx, cy), 'canvas'));
    const magazine = () => page.evaluate(() => { const n = /\d+/.exec(document.getElementById('weapon')?.textContent ?? '')?.[0]; return n === undefined ? null : Number(n); });
    await page.mouse.down({ button: 'right' });
    const drawStart = Date.now();
    let before = await magazine();
    while (before === null && Date.now() - drawStart < 3000) { await sleep(20); before = await magazine(); }
    await page.mouse.up({ button: 'right' });
    let released = false;
    if (before !== null) {
      await page.evaluate(n => { (window as unknown as ProbeWindow).__startupProbe.shot.baseline = n; }, before);
      await page.mouse.down({ button: 'left' });
      released = await page.waitForFunction(() => (window as unknown as ProbeWindow).__startupProbe.shot.releasedAt !== null, undefined, { timeout: 3000, polling: 20 })
        .then(() => true, () => false);
      await page.mouse.up({ button: 'left' });
    }
    await mark('shotMs');
    await sleep(300);
    const fireEvents = hasApi ? await page.evaluate(t => (window as unknown as ProbeWindow).__HELSINKI_GAME__!.events(t).filter(e => e.type === 'fire').length, tick0) : null;
    const shots = shotSummary(before, await magazine(), fireEvents);
    script.shot = { ...shots, releasedInPage: released, magazineBefore: before };
    stage('shotFired', shots.count !== null && shots.count >= 1);
  }
  const aim = () => page.evaluate(id => {
    const g = (window as unknown as ProbeWindow).__HELSINKI_GAME__!, s = g.state(), car = s.vehicles.find(v => v.id === id), p = s.player.position;
    if (!car) return { player: s.player, distance: null };
    g.setCamera(Math.atan2(car.position[0]! - p[0]!, car.position[2]! - p[2]!), g.camera().pitch);
    return { player: s.player, distance: Math.hypot(car.position[0]! - p[0]!, car.position[2]! - p[2]!) };
  }, CAR);
  const hud = () => page.evaluate(() => ({ prompt: document.getElementById('prompt')?.textContent ?? '', speed: document.getElementById('speed')?.textContent ?? '',
    language: document.documentElement.lang }));
  if (!failures.length) {
    if (!hasApi) await page.mouse.move(cx + SPAWN_TURN_PX, cy, { steps: 10 });
    const runStart = performance.now();
    let atCar = false;
    while (!atCar && performance.now() - runStart < RUN_TIMEOUT_MS) {
      if (hasApi) atCar = apiNearTarget((await aim()).player, CAR);
      else { const h = await hud(); atCar = h.speed === '' && enterPromptShown(h.prompt, h.language); }
      if (!atCar) await sleep(60);
    }
    await page.keyboard.up('KeyW');
    stage('reachedCar', atCar); await mark('atCarMs');
  }
  if (!failures.length) {
    await page.keyboard.press('KeyF');
    const enterStart = performance.now();
    let entry: 'entered' | 'other' | 'pending' = 'pending';
    while (entry === 'pending' && performance.now() - enterStart < ENTER_TIMEOUT_MS) {
      if (hasApi) entry = apiEntry(await page.evaluate(() => (window as unknown as ProbeWindow).__HELSINKI_GAME__!.state().player), CAR);
      else { const h = await hud(); if (h.speed !== '' && h.prompt === '') entry = 'entered'; }
      if (entry === 'pending') await sleep(60);
    }
    if (entry === 'other') script.enteredOtherVehicle = true;
    script.targetAssociation = hasApi ? `test API: player.inVehicle ${CAR}` : 'unverified: production build exposes no vehicle identity';
    script.enteredCertifies = hasApi ? `entered ${CAR}` : 'entered a vehicle';
    stage('enteredCar', entry === 'entered'); await mark('drivingMs');
  }
  if (!failures.length) {
    // D-10 drive: the branch is fixed now; samples at the start, every 250 ms of page time and at the release.
    const branch = hasApi ? 'test-api' as const : 'production' as const;
    const sample = () => page.evaluate(([id, api]) => {
      const P = (window as unknown as ProbeWindow).__startupProbe, g = (window as unknown as ProbeWindow).__HELSINKI_GAME__;
      const t = performance.now() - (P.drive.downAt ?? Number.NaN), menu = document.getElementById('pause-menu');
      const speed = /\d+(?:[.,]\d+)?/.exec(document.getElementById('speed')?.textContent ?? '')?.[0];
      const tick = /(?:tick|askel)\s+(\d+)\s*$/.exec(document.getElementById('stats')?.textContent ?? '')?.[1];
      const prompt = document.getElementById('prompt')?.textContent ?? '';
      const reading: DriveSample = { t, paused: menu ? !menu.classList.contains('hidden') : null,
        hud: { driving: speed !== undefined && prompt === '', speedKmh: speed === undefined ? null : Number(speed.replace(',', '.')), tick: tick === undefined ? null : Number(tick) } };
      if (api) {
        if (!g) reading.api = null;
        else {
          const s = g.state(), car = s.vehicles.find(v => v.id === id);
          reading.api = { tick: g.tick(), mode: s.player.mode, inVehicle: s.player.inVehicle ?? null, car: car ? [...car.position] : null };
        }
      }
      return reading;
    }, [CAR, branch === 'test-api'] as const);
    const received = (key: 'downAt' | 'upAt') => page.waitForFunction(k => (window as unknown as ProbeWindow).__startupProbe.drive[k] !== null, key, { timeout: 2000, polling: 5 })
      .then(() => true, () => false);
    await page.evaluate(() => { (window as unknown as ProbeWindow).__startupProbe.drive = { armed: true, downAt: null, upAt: null, viewChangeTimes: [] }; });
    await page.keyboard.down('KeyW');
    const samples: DriveSample[] = [];
    if (await received('downAt')) {
      for (let due = DRIVE.sampleMs; ; due += DRIVE.sampleMs) {
        const reading = await sample();
        samples.push(reading);
        if (!Number.isFinite(reading.t)) break;
        // Release only once the page clock has passed the minimum hold.
        if (due >= DRIVE.minMs) { await sleep(Math.max(0, DRIVE.minMs - reading.t) + 2); break; }
        await sleep(Math.max(0, due - reading.t));
      }
    }
    await page.keyboard.up('KeyW');
    if (await received('upAt')) samples.push(await sample());
    const recorded = await page.evaluate(() => {
      const d = (window as unknown as ProbeWindow).__startupProbe.drive, P = (window as unknown as ProbeWindow).__startupProbe;
      d.armed = false;
      const from = d.downAt ?? Number.NaN;
      return { downAt: d.downAt, upAt: d.upAt, viewChangeTimes: d.viewChangeTimes.map(t => t - from),
        pauseTransitions: P.pauseTransitions.filter(([t]) => t >= from).map(([t, v]) => [t - from, v] as [number, boolean]) };
    });
    driveReleasedAt = recorded.upAt;
    const T = recorded.downAt !== null && recorded.upAt !== null ? recorded.upAt - recorded.downAt : null;
    const verdict = driveVerdict({ branch, target: CAR, T, samples, pauseTransitions: recorded.pauseTransitions, viewChangeTimes: recorded.viewChangeTimes });
    script.drive = { ...verdict.metrics, problems: verdict.problems, samples: samples.length, pauseTransitions: recorded.pauseTransitions,
      viewChangeTimes: recorded.viewChangeTimes.map(t => Math.round(t)), sampled: samples };
    stage('droveTenSeconds', verdict.ok);
  }
  await page.keyboard.up('KeyW');
  // The scripted window ends at the recorded W release (or now when the drive never ran).
  await page.evaluate(upAt => { const P = (window as unknown as ProbeWindow).__startupProbe; P.windowEnd = upAt ?? performance.now(); }, driveReleasedAt);
  await mark('windowEndMs');
  if (!failures.length) {
    // Frames must cover both window ends: wait for a frame after the window and for click + 15 s.
    const remaining = await page.evaluate(limit => limit - (performance.now() - (window as unknown as ProbeWindow).__startupProbe.clickAt!), 15000);
    if (remaining > 0) await sleep(remaining + 100);
    await page.waitForFunction(() => { const P = (window as unknown as ProbeWindow).__startupProbe; return (P.presented.at(-1) ?? 0) > P.windowEnd!; }, undefined, { timeout: 5000, polling: 50 })
      .catch(() => {});
  }
  const waits = hasApi ? await page.evaluate(() => {
    const g = (window as unknown as ProbeWindow).__HELSINKI_GAME__!;
    return { modelWaitSeconds: g.deferredModels().blockedSeconds, collisionWaitSeconds: g.collision().blockedSeconds, visualWaitSeconds: g.streaming()?.coverage.blockedSeconds ?? null };
  }) : { modelWaitSeconds: null, collisionWaitSeconds: null, visualWaitSeconds: null };
  const { blockedSubmits, ...probe } = await page.evaluate(() => {
    const { armed: _, drive: _d, shot: _s, pauseTransitions: _p, ...rest } = (window as unknown as ProbeWindow).__startupProbe;
    return rest;
  });
  network.blockedSubmits = blockedSubmits;
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info');
    return { renderer: gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown', parallelShaderCompile: !!gl?.getExtension('KHR_parallel_shader_compile') };
  });
  const egress = await settledEgress();
  const { result, exitCode } = assembleStartupResult({
    url: target.href, preset: values.preset, angle, chromium: browser.version(), gpu: gpu.renderer, parallelShaderCompile: gpu.parallelShaderCompile, waitBeforePlayMs, shot: values.shot, warm: values.warm,
    noParallelCompile: values['no-parallel-compile'], autoplayOverride: !values['no-autoplay-override'], testApi: hasApi, allowLive,
    world: world ? { dir: path.relative(process.cwd(), world.dir) || '.', worldBaseUrl: world.base, release: world.release } : null,
    firstVisit, script, network: { ...network, egress, worldRequestsOffLoopback: world ? egress.worldEgress : null }, visualWaitSeconds: waits.visualWaitSeconds, consoleErrors,
  }, probe, { modelWaitSeconds: waits.modelWaitSeconds, collisionWaitSeconds: waits.collisionWaitSeconds, consoleErrors: consoleErrors.length }, stages, world ? egress : null);
  const { status, thresholds } = result;
  writeFileSync(path.join(OUT, 'result.json'), `${JSON.stringify(result, null, 1)}\n`);
  writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(probe));
  console.log(`${status}: time to Play enabled ${result.timeToPlayEnabledMs} ms; first 15 s p50/p99/max ${result.frames.first15s.p50Ms}/${result.frames.first15s.p99Ms}/${result.frames.first15s.maxMs} ms; `
    + `world served locally ${network.worldServed}, sent off loopback ${egress.egress}, unsettled ${egress.pending}, aborted ${network.aborted}, `
    + `isolation ${isolationRule ? 'active' : 'off'}`);
  if (failures.length) console.log(`INCOMPLETE scenario: failed stage(s) ${failures.join(', ')}; no threshold is certified`);
  for (const t of thresholds) console.log(`${t.status} ${t.id} (${t.criterion}): ${t.detail}`);
  process.exitCode = exitCode;
} catch (error) {
  writeFileSync(path.join(OUT, 'result.json'), `${JSON.stringify({ status: 'ERROR', error: String((error as Error).message ?? error).slice(0, 500), script, network, consoleErrors }, null, 1)}\n`);
  process.exitCode = 1;
  console.error(`ERROR ${(error as Error).message}`);
} finally {
  await context.close();
  await browser.close();
}
