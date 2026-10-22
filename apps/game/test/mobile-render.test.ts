import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticPreset, FRAME_RATE_STORAGE_KEY, PRESET_STORAGE_KEY, readConfig } from '../src/config.ts';
import { isTouchFirstDevice, type DeviceCapabilities } from '../src/device.ts';
import { AdaptiveResolution, drawingPixelRatio, FramePacer } from '../src/render/frame-pacing.ts';
import { AnimationCadence } from '../src/render/animation-cadence.ts';

const desktop: DeviceCapabilities = { maxTouchPoints: 0, primaryCoarse: false, primaryFine: true, primaryHover: true, anyFine: true, deviceMemory: 16, hardwareConcurrency: 8 };
const phone: DeviceCapabilities = { maxTouchPoints: 5, primaryCoarse: true, primaryFine: false, primaryHover: false, anyFine: false };

test('mobile Auto chooses Low without memory/core APIs and ignores screen size and user-agent guesses', () => {
  assert.equal(automaticPreset(phone), 'low');
  assert.equal(automaticPreset({ ...phone, deviceMemory: 16, hardwareConcurrency: 12 }), 'low');
  assert.equal(automaticPreset(desktop), 'standard');
  assert.equal(isTouchFirstDevice({ ...desktop, maxTouchPoints: 10 }), false, 'hybrid laptop primary mouse remains desktop');
  assert.equal(isTouchFirstDevice({ ...phone, anyFine: true }), true, 'optional tablet mouse does not defeat coarse primary');
  assert.equal(isTouchFirstDevice({ ...phone, primaryCoarse: false }), true, 'unknown primary-pointer API plus touch-only hardware stays conservative');
  assert.equal(automaticPreset({ ...desktop, deviceMemory: 4 }), 'low');
  assert.equal(automaticPreset({ ...desktop, hardwareConcurrency: 4 }), 'low');
  assert.equal(automaticPreset({ ...desktop, deviceMemory: 0, hardwareConcurrency: 0 }), 'standard', 'invalid hints are not literal zero resources');
});

test('URL and saved quality/frame-rate choices override mobile Auto while profile stays mobile', () => {
  const keys = ['navigator', 'matchMedia', 'location', 'localStorage', '__REVIEW_BUILD__', '__WORLD_DEPLOYMENT__'];
  const old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = new Map<string, string>();
  const location = { search: '' };
  const set = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    set('navigator', { maxTouchPoints: 5 });
    set('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
    set('location', location); set('localStorage', { getItem: (key: string) => values.get(key) ?? null });
    set('__REVIEW_BUILD__', false); set('__WORLD_DEPLOYMENT__', { appBase: '/', pages: false, release: null, worldBaseUrl: null, manifestSha256: null });
    let config = readConfig();
    assert.equal(config.preset, 'low'); assert.equal(config.mobile, true); assert.equal(config.targetFrameRate, 30);
    assert.equal(config.initialRenderScale, .8); assert.equal(config.maxRenderPixels, 921600); assert.equal(config.textureBudgetMb, 128);
    values.set(PRESET_STORAGE_KEY, 'standard'); values.set(FRAME_RATE_STORAGE_KEY, '60');
    config = readConfig();
    assert.equal(config.preset, 'standard'); assert.equal(config.presetSource, 'saved'); assert.equal(config.mobile, true); assert.equal(config.targetFrameRate, 60);
    location.search = '?preset=low&fps=30'; config = readConfig();
    assert.equal(config.preset, 'low'); assert.equal(config.presetSource, 'url'); assert.equal(config.targetFrameRate, 30);
    location.search = '?preset=invalid&fps=999'; assert.equal(readConfig().targetFrameRate, 60);
    location.search = '?review=1'; config = readConfig();
    assert.equal(config.preset, 'standard'); assert.equal(config.mobile, false); assert.equal(config.targetFrameRate, undefined);
    location.search = ''; values.clear();
    set('navigator', { maxTouchPoints: 10, hardwareConcurrency: 8, deviceMemory: 16 });
    set('matchMedia', (query: string) => ({ matches: ['(pointer: fine)', '(hover: hover)', '(any-pointer: fine)'].includes(query) }));
    config = readConfig();
    assert.equal(config.mobile, false); assert.equal(config.preset, 'standard'); assert.equal(config.targetFrameRate, undefined, 'desktop is uncapped unless explicitly selected');
    values.set(FRAME_RATE_STORAGE_KEY, '60'); assert.equal(readConfig().targetFrameRate, 60);
    location.search = '?review=1&mobile=1'; config = readConfig();
    assert.equal(config.review, true); assert.equal(config.mobile, true); assert.equal(config.preset, 'low');
    assert.equal(config.targetFrameRate, 30); assert.equal(config.textureBudgetMb, 128); assert.equal(config.initialRenderScale, .8);
    location.search = '?review=1&mobile=1&preset=standard&fps=60'; config = readConfig();
    assert.equal(config.preset, 'standard'); assert.equal(config.targetFrameRate, 60); assert.equal(config.mobile, true);
    location.search = '?mobile=1'; values.clear(); config = readConfig();
    assert.equal(config.mobile, true); assert.equal(config.preset, 'low'); assert.equal(config.review, false);
  } finally {
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('30FPS presentation pacing covers 60/90/120Hz, rounded timestamps and resets without simulation-time loss', () => {
  for (const refresh of [60, 90, 120]) {
    const pacer = new FramePacer(30), due: number[] = [];
    for (let frame = 0; frame <= refresh * 10; frame++) {
      const now = Math.round(frame * 1000 / refresh * 10) / 10;
      if (pacer.shouldRender(now)) due.push(now);
    }
    assert.equal(due[0], 0); assert.equal(due.length, 301);
    assert.ok(Math.abs(due.reduce((elapsed, now, i) => elapsed + (i ? now - due[i - 1]! : 0), 0) - 10000) < .01);
    assert.equal(pacer.shouldRender(20000), true, 'resume draws immediately without accumulated catchup renders');
    assert.equal(pacer.shouldRender(20001), false);
    pacer.reset(); assert.equal(pacer.shouldRender(20002), true);
    assert.equal(pacer.shouldRender(0), true, 'restarted timestamp clock is valid');
  }
  const unpaced = new FramePacer(); assert.equal(unpaced.shouldRender(0), true); assert.equal(unpaced.shouldRender(1), true);
});

test('intentional 30FPS and CPU stalls do not lower resolution; sustained slow GPU does and mobile ceiling holds', () => {
  const mobile = new AdaptiveResolution({ targetFrameRate: 30, initialRenderScale: .8 });
  for (let i = 0; i < 900; i++) mobile.update(1 / 30, 5);
  assert.equal(mobile.scale, .8);
  for (let i = 0; i < 120; i++) mobile.update(1 / 20, 40);
  assert.equal(mobile.scale, .8, 'CPU pressure is not a resolution signal');
  for (let i = 0; i < 40; i++) mobile.update(1 / 20, 5);
  assert.ok(mobile.scale < .8);
  mobile.update(10, 0);
  for (let i = 0; i < 1200; i++) mobile.update(1 / 30, 5);
  assert.equal(mobile.scale, .8, 'recovery never exceeds conservative initial mobile setting');
  mobile.setTargetFrameRate(60);
  for (let i = 0; i < 120; i++) mobile.update(1 / 30, 5);
  assert.ok(mobile.scale < .8, 'switching target updates the thresholds');
});

test('rendering pixels are capped for tablets independently of display DPR and orientation', () => {
  for (const [width, height] of [[2732, 2048], [2048, 2732], [844, 390]]) {
    const ratio = drawingPixelRatio(width!, height!, 1, .8, 921600);
    assert.ok(width! * height! * ratio ** 2 <= 921600 + .001); assert.ok(ratio <= .8);
  }
  assert.equal(drawingPixelRatio(800, 600, 1.5, 1), 1.5);
});

test('distant animation accumulates all skipped time and immediately samples reaction/state/near transitions', () => {
  const cadence = new AnimationCadence();
  let elapsed = 0, samples = 0;
  for (let frame = 0; frame < 60; frame++) {
    const sample = cadence.sample(1 / 60, true, 80, 'walk', false);
    if (sample !== null) { elapsed += sample; samples++; }
  }
  const flush = cadence.sample(0, true, 80, 'walk', false)!;
  assert.ok(Math.abs(elapsed + flush - 1) < 1e-12); assert.ok(samples <= 11 && samples >= 10);
  cadence.sample(1 / 60, true, 80, 'walk', false);
  assert.ok(cadence.sample(1 / 60, true, 80, 'death', true)! >= 1 / 60);
  assert.notEqual(cadence.sample(1 / 60, true, 80, 'death', true), null);
  assert.notEqual(cadence.sample(1 / 60, true, 80, 'walk', false), null);
  assert.notEqual(cadence.sample(1 / 60, true, 10, 'walk', false), null);
  assert.notEqual(cadence.sample(1 / 60, false, 80, 'walk', false), null);
});
