// Shared Playwright plumbing for the browser harnesses: Chromium with the GPU flags that make WebGL2 work headless
// on this machine, console capture, and a typed bridge to window.__HELSINKI_GAME__ (apps/game/src/testapi.ts).
import { chromium, type Browser, type Page } from 'playwright';
import type { Command, GameEvent, SimState } from '../../../packages/sim/src/index.ts';
import {createLoadedResponseCapture} from './loaded-responses.ts';

export interface BrowserSession {
  readonly browser: Browser;
  readonly page: Page;
  readonly consoleErrors: string[];
  readonly consoleLines: string[];
  /** SHA-256 of the unique original HTTP200 script/manifest response; never refetches. */
  loadedResponseSha256(url: string): Promise<string>;
  close(): Promise<void>;
}

export async function openGame(url: string, opts: { headful?: boolean; width?: number; height?: number; timeoutMs?: number; videoDir?: string } = {}): Promise<BrowserSession> {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('only loopback servers are verified');
  // Explicit diagnostic override only. Preserve the established D3D11 default and record
  // Vulkan runs separately when Windows display/VSync scheduling stalls the harness;
  // SwiftShader is the software renderer used as the weak-GPU proxy.
  const angle = process.env.HELSINKI_VERIFY_ANGLE ?? 'd3d11';
  if (!['d3d11', 'vulkan', 'swiftshader'].includes(angle)) throw new Error('HELSINKI_VERIFY_ANGLE must be d3d11, vulkan or swiftshader');
  const browser = await chromium.launch({
    channel: 'chromium', headless: !opts.headful,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${angle}`, '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  console.log(`[verification-browser] Chromium ${browser.version()}, ANGLE ${angle}, headful=${!!opts.headful}`);
  const viewport = { width: opts.width ?? 1280, height: opts.height ?? 720 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
    ...(opts.videoDir ? { recordVideo: { dir: opts.videoDir, size: viewport } } : {}),
  });
  // Resource timing keeps 250 entries by default; the unbundled dev server issues more, and transfer sums need all.
  await context.addInitScript(() => performance.setResourceTimingBufferSize(100000));
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const consoleLines: string[] = [];
  const loadedResponses = createLoadedResponseCapture({onError: error => consoleErrors.push(`loaded response capture: ${error.message}`)});
  page.on('response', response => loadedResponses.observe(response));
  page.on('console', m => { const line = `[${m.type()}] ${m.text()}`; consoleLines.push(line); if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as { __HELSINKI_GAME__?: { ready: boolean }; __HELSINKI_ERROR__?: string }).__HELSINKI_GAME__?.ready === true || !!(window as unknown as { __HELSINKI_ERROR__?: string }).__HELSINKI_ERROR__, undefined, { timeout: opts.timeoutMs ?? 120000 });
  const err = await page.evaluate(() => (window as unknown as { __HELSINKI_ERROR__?: string }).__HELSINKI_ERROR__ ?? null);
  if (err) { await browser.close(); throw new Error(`game failed to start: ${err}`); }
  return { browser, page, consoleErrors, consoleLines, loadedResponseSha256: url => loadedResponses.sha256(url), close: async () => { await context.close(); await browser.close(); } };
}

type Api = {
  state(): SimState; tick(): number; stats(): Record<string, number>; events(since?: number): GameEvent[];
  setCommand(c: Partial<Command> | null): void; step(n: number, c?: Partial<Command>): SimState; pause(): void; resume(): void; render(): void;
  teleport(x: number, z: number, h?: number): void; dropIn(l: string): void; camera(): { yaw: number; pitch: number }; setCamera(y: number, p: number): void;
  setLighting(l: 'lit' | 'unlit'): void; start(): void; hash(): string; release: string;
  awaitVisuals(): Promise<void>;
};
type W = Window & { __HELSINKI_GAME__: Api };

// Each function body runs inside the page, so the window lookup is inlined (no closures over Node-side helpers).
export const game = {
  state: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.state()),
  stats: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.stats()),
  events: (p: Page, since: number) => p.evaluate(s => (window as unknown as W).__HELSINKI_GAME__.events(s), since),
  step: (p: Page, n: number, c?: Partial<Command>) => p.evaluate(([n, c]) => (window as unknown as W).__HELSINKI_GAME__.step(n, c ?? undefined), [n, c ?? null] as const),
  setCommand: (p: Page, c: Partial<Command> | null) => p.evaluate(c => (window as unknown as W).__HELSINKI_GAME__.setCommand(c), c),
  pause: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.pause()),
  resume: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.resume()),
  start: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.start()),
  teleport: (p: Page, x: number, z: number, h = 0) => p.evaluate(([x, z, h]) => (window as unknown as W).__HELSINKI_GAME__.teleport(x, z, h), [x, z, h] as const),
  dropIn: (p: Page, label: string) => p.evaluate(l => (window as unknown as W).__HELSINKI_GAME__.dropIn(l), label),
  camera: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.camera()),
  setCamera: (p: Page, yaw: number, pitch: number) => p.evaluate(([y, pt]) => (window as unknown as W).__HELSINKI_GAME__.setCamera(y, pt), [yaw, pitch] as const),
  setLighting: (p: Page, l: 'lit' | 'unlit') => p.evaluate(l => (window as unknown as W).__HELSINKI_GAME__.setLighting(l), l),
  hash: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.hash()),
  release: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.release),
  awaitVisuals: (p: Page) => p.evaluate(() => (window as unknown as W).__HELSINKI_GAME__.awaitVisuals()),
};
