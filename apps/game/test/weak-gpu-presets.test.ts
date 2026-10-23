import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_TIER_STORAGE_KEY, automaticPreset, PRESET_STORAGE_KEY, readConfig, rememberAutoTier, savedAutoTier, storeGraphicsChoice } from '../src/config.ts';
import { classifyRenderer, detectGpuClass, prefersLowGraphics, type DeviceCapabilities } from '../src/device.ts';
import { MOBILE_TIER_OVERRIDES, QUALITY_TIERS, presetTier, tierFor, tierParameters } from '../src/render/quality-tiers.ts';

const desktop: DeviceCapabilities = { maxTouchPoints: 0, primaryCoarse: false, primaryFine: true, primaryHover: true, anyFine: true, deviceMemory: 16, hardwareConcurrency: 8 };

test('renderer strings classify integrated, software, mobile and discrete GPUs case-insensitively', () => {
  const table: [string | null, ReturnType<typeof classifyRenderer>][] = [
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['Intel(R) Iris(R) Xe Graphics', 'integrated'],
    ['Mesa Intel(R) HD Graphics 520 (SKL GT2)', 'integrated'],
    // Integrated Xe-LPG/Xe2 parts (Meteor, Lunar and Arrow Lake) also say "Arc"; only a discrete model name is discrete.
    ['ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['Intel(R) Arc(TM) Graphics', 'integrated'],
    ['Intel(R) Arc(TM) 140V Graphics', 'integrated'],
    ['Intel(R) Arc(TM) 130V Graphics', 'integrated'],
    ['Intel(R) Arc(TM) 140T Graphics', 'integrated'],
    ['ANGLE (Intel, Intel(R) Arc(TM) 140V GPU (16GB) (0x000064A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['Intel(R) Arc(TM) A380 Graphics', 'discrete'],
    ['Intel(R) Arc(TM) A580 Graphics', 'discrete'],
    ['Intel(R) Arc(TM) A370M Graphics', 'discrete'],
    ['Intel(R) Arc(TM) B570 Graphics', 'discrete'],
    ['Intel(R) Arc(TM) Pro B60', 'discrete'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
    ['Intel(R) Arc(TM) A770 Graphics', 'discrete'],
    ['Intel(R) Arc(TM) A770M Graphics', 'discrete'],
    ['Intel(R) Arc(TM) Pro A60 Graphics', 'discrete'],
    ['Intel(R) Arc(TM) B580 Graphics', 'discrete'],
    ['Intel Arc Pro B60', 'discrete'],
    ['Intel Arc Graphics', 'integrated'],
    ['Intel(R) Iris(R) Xe Graphics (0x00009A49)', 'integrated'],
    ['Mesa software', 'software'],
    ['softpipe', 'software'],
    ['Mesa/X.org', 'software'],
    ['Mesa/X.org, llvmpipe (LLVM 17.0.6, 256 bits)', 'software'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['AMD Radeon(TM) Vega 8 Graphics', 'integrated'],
    ['Vega 8', 'integrated'],
    ['AMD Radeon 780M Graphics', 'integrated'],
    ['AMD Radeon RX 6700 XT', 'discrete'],
    ['AMD Radeon RX Vega 56', 'discrete'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Ti (0x00002482) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'software'],
    ['Google SwiftShader', 'software'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'software'],
    ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'software'],
    ['Mali-G78', 'mobile'],
    ['Adreno (TM) 650', 'mobile'],
    ['PowerVR Rogue GE8320', 'mobile'],
    ['Apple GPU', 'mobile'],
    ['Apple A15 GPU', 'mobile'],
    ['INTEL(R) UHD GRAPHICS 630', 'integrated'],
    ['swiftshader', 'software'],
    [null, 'unknown'], ['', 'unknown'], ['   ', 'unknown'], ['Mozilla', 'unknown'], ['WebKit WebGL', 'unknown'], ['Apple M1', 'unknown'],
  ];
  for (const [renderer, expected] of table) assert.equal(classifyRenderer(renderer), expected, String(renderer));
  assert.equal(classifyRenderer(`${'x'.repeat(10000)} SwiftShader`), 'unknown', 'only a bounded prefix is inspected');
  assert.equal(classifyRenderer(42 as unknown as string), 'unknown', 'non-string input is unknown');
});

test('weak GPU classes select Low; discrete and unknown keep the memory/core rules', () => {
  for (const gpuClass of ['integrated', 'software', 'mobile'] as const) assert.equal(prefersLowGraphics({ ...desktop, gpuClass }), true, gpuClass);
  for (const gpuClass of ['discrete', 'unknown', undefined] as const) {
    assert.equal(prefersLowGraphics({ ...desktop, gpuClass }), false, String(gpuClass));
    assert.equal(prefersLowGraphics({ ...desktop, gpuClass, deviceMemory: 4 }), true, `${gpuClass} keeps the memory rule`);
    assert.equal(prefersLowGraphics({ ...desktop, gpuClass, hardwareConcurrency: 4 }), true, `${gpuClass} keeps the core rule`);
  }
  assert.equal(automaticPreset({ ...desktop, gpuClass: 'integrated', renderer: 'Intel(R) UHD Graphics 620' }), 'low');
  // Regression (WG-GPU-CLASSIFIER-01): Arc variants are discrete on a 16 GB / eight-core desktop; Mesa software is weak.
  const classified = (renderer: string): DeviceCapabilities => ({ ...desktop, gpuClass: classifyRenderer(renderer), renderer });
  for (const renderer of ['Intel(R) Arc(TM) A770M Graphics', 'Intel(R) Arc(TM) Pro A60 Graphics']) {
    assert.equal(prefersLowGraphics(classified(renderer)), false, renderer);
    assert.equal(automaticPreset(classified(renderer)), 'standard', renderer);
  }
  assert.equal(prefersLowGraphics(classified('Mesa software')), true);
  assert.equal(automaticPreset(classified('Mesa software')), 'low');
  // Safari also reports the generic "Apple GPU" on Macs; only touch hardware treats it as a phone/tablet GPU.
  assert.equal(automaticPreset({ ...desktop, gpuClass: 'mobile', renderer: 'Apple GPU' }), 'standard');
  assert.equal(automaticPreset({ ...desktop, maxTouchPoints: 5, gpuClass: 'mobile', renderer: 'Apple GPU' }), 'low');
});

interface FakeGl { contexts: string[]; options: unknown[]; lost: number }
function fakeDocument(renderer: string | null, opts: { webgl2?: boolean; extension?: boolean; throws?: boolean } = {}): { document: unknown; seen: FakeGl } {
  const seen: FakeGl = { contexts: [], options: [], lost: 0 };
  const gl = {
    RENDERER: 0x1f01,
    getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? (opts.extension === false ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 })
      : name === 'WEBGL_lose_context' ? { loseContext: () => { seen.lost++; } } : null,
    getParameter: (parameter: number) => parameter === 0x9246 ? renderer : parameter === 0x1f01 ? 'WebKit WebGL' : null,
  };
  const canvas = { width: 300, height: 150, getContext: (type: string, options: unknown) => {
    if (opts.throws) throw new Error('blocked');
    seen.contexts.push(type); seen.options.push(options);
    return type === 'webgl2' && opts.webgl2 === false ? null : gl;
  } };
  return { document: { createElement: (tag: string) => { assert.equal(tag, 'canvas'); return canvas; } }, seen };
}

function withGlobals<T>(values: Record<string, unknown>, run: () => T): T {
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try { return run(); } finally {
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test('GPU detection uses a throwaway high-performance context, loses it and never throws', () => {
  let fake = fakeDocument('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)');
  assert.deepEqual(withGlobals({ document: fake.document }, detectGpuClass), { class: 'integrated', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' });
  assert.deepEqual(fake.seen.contexts, ['webgl2']); assert.equal(fake.seen.lost, 1);
  assert.equal((fake.seen.options[0] as { powerPreference?: string }).powerPreference, 'high-performance', 'probe the GPU the game renderer will use');
  fake = fakeDocument('Mali-G78', { webgl2: false });
  assert.deepEqual(withGlobals({ document: fake.document }, detectGpuClass), { class: 'mobile', renderer: 'Mali-G78' });
  assert.deepEqual(fake.seen.contexts, ['webgl2', 'webgl'], 'WebGL1 is tried when WebGL2 is unavailable');
  fake = fakeDocument('NVIDIA GeForce GTX 1060', { extension: false });
  assert.deepEqual(withGlobals({ document: fake.document }, detectGpuClass), { class: 'unknown', renderer: 'WebKit WebGL' }, 'masked renderer stays unknown');
  fake = fakeDocument('x'.repeat(5000));
  assert.equal(withGlobals({ document: fake.document }, detectGpuClass).renderer!.length, 256, 'recorded renderer is bounded');
  assert.deepEqual(withGlobals({ document: fakeDocument(null, { throws: true }).document }, detectGpuClass), { class: 'unknown', renderer: null });
  assert.deepEqual(withGlobals({ document: undefined }, detectGpuClass), { class: 'unknown', renderer: null });
  fake = fakeDocument(null);
  assert.deepEqual(withGlobals({ document: fake.document }, detectGpuClass), { class: 'unknown', renderer: null });
});

function configHarness(renderer: string | null) {
  const values = new Map<string, string>();
  const location = { search: '' };
  const fake = fakeDocument(renderer);
  const globals = {
    navigator: { maxTouchPoints: 0, hardwareConcurrency: 8, deviceMemory: 16 },
    matchMedia: (query: string) => ({ matches: ['(pointer: fine)', '(hover: hover)', '(any-pointer: fine)'].includes(query) }),
    location, localStorage: { getItem: (key: string) => values.get(key) ?? null }, document: fake.document,
    __REVIEW_BUILD__: false, __WORLD_DEPLOYMENT__: { appBase: '/', pages: false, release: null, worldBaseUrl: null, manifestSha256: null },
  };
  return { values, fake, read: (search: string) => { location.search = search; return withGlobals(globals, readConfig); } };
}

test('production Automatic consults the GPU; URL and saved presets still win', () => {
  const intel = configHarness('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)');
  let config = intel.read('');
  assert.equal(config.preset, 'low'); assert.equal(config.presetSource, 'auto'); assert.equal(config.gpuClass, 'integrated');
  assert.match(config.renderer!, /UHD Graphics 620/);
  config = intel.read('?preset=auto');
  assert.equal(config.preset, 'low'); assert.equal(config.presetSource, 'auto', '?preset=auto outside review is a missing parameter');
  config = intel.read('?preset=standard');
  assert.equal(config.preset, 'standard'); assert.equal(config.presetSource, 'url');
  intel.values.set(PRESET_STORAGE_KEY, 'standard');
  config = intel.read('');
  assert.equal(config.preset, 'standard'); assert.equal(config.presetSource, 'saved');
  const nvidia = configHarness('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)');
  config = nvidia.read('');
  assert.equal(config.preset, 'standard'); assert.equal(config.gpuClass, 'discrete');
});

test('review builds keep Standard without classification unless ?preset=auto asks for it', () => {
  const software = configHarness('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)');
  let config = software.read('?review=1');
  assert.equal(config.preset, 'standard'); assert.equal(config.gpuClass, 'unknown'); assert.equal(config.renderer, null);
  assert.deepEqual(software.fake.seen.contexts, [], 'no throwaway context in a default review run');
  software.values.set(PRESET_STORAGE_KEY, 'low');
  config = software.read('?review=1&preset=auto');
  assert.equal(config.preset, 'low', 'review ignores the saved choice and classifies'); assert.equal(config.presetSource, 'auto');
  assert.equal(config.gpuClass, 'software');
  config = software.read('?review=1&preset=standard');
  assert.equal(config.preset, 'standard'); assert.equal(config.presetSource, 'url');
  const nvidia = configHarness('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)');
  config = nvidia.read('?review=1&preset=auto');
  assert.equal(config.preset, 'standard'); assert.equal(config.gpuClass, 'discrete');
  config = nvidia.read('?review=1&preset=AUTO');
  assert.equal(config.preset, 'standard'); assert.equal(config.gpuClass, 'unknown', 'only the exact enum value is accepted');
});

test('?mipdrop=0|1 overrides the tier mip drop for measurement; anything else is ignored', () => {
  const h = configHarness('NVIDIA GeForce RTX 3070 Ti');
  assert.equal(h.read('').mipDrop, null, 'no override: the tier decides');
  assert.equal(h.read('?mipdrop=1').mipDrop, 1);
  assert.equal(h.read('?review=1&preset=low&mipdrop=1').mipDrop, 1);
  assert.equal(h.read('?mipdrop=0').mipDrop, 0);
  for (const value of ['2', 'yes', '', ' 1', '01', 'true']) assert.equal(h.read(`?mipdrop=${encodeURIComponent(value)}`).mipDrop, null, value);
});

test('dynamic resolution is opt-in for review and opt-out in production; desktop caps and floors follow the preset', () => {
  const h = configHarness('NVIDIA GeForce RTX 3070 Ti');
  assert.equal(h.read('?review=1').dynamicResolution, false);
  assert.equal(h.read('?review=1&dynres=1').dynamicResolution, true);
  assert.equal(h.read('?review=1&dynres=yes').dynamicResolution, false);
  assert.equal(h.read('').dynamicResolution, true);
  assert.equal(h.read('?dynres=0').dynamicResolution, false);
  let config = h.read('?preset=standard');
  assert.equal(config.maxRenderPixels, 3686400); assert.equal(config.minRenderScale, .5); assert.equal(config.pixelRatioCap, 1.5);
  assert.equal(config.vehicleDetailRange, 60);
  config = h.read('?preset=low');
  assert.equal(config.maxRenderPixels, 1440000); assert.equal(config.pixelRatioCap, 1); assert.equal(config.vehicleDetailRange, 30);
  config = h.read('?review=1&mobile=1');
  assert.equal(config.maxRenderPixels, 921600); assert.equal(config.minRenderScale, .6);
  config = h.read('?review=1&mobile=1&preset=standard');
  assert.equal(config.maxRenderPixels, 921600, 'every mobile preset keeps the 1280x720 ceiling');
});

test('tier table reproduces the Standard, Low and mobile numbers and is immutable', () => {
  assert.equal(presetTier('standard'), 'standard'); assert.equal(presetTier('low'), 'low');
  assert.deepEqual(tierFor('standard'), {
    detail: { radius: 230, maxCells: 28, geometryBudgetMiB: 160 }, fallback: { radius: 420, maxCells: 42, geometryBudgetMiB: 96 },
    settle: { fallback: 150, detail: 100 }, fog: { near: 240, far: 420 }, cameraFar: 420, foliageLodScale: 1, vehicleDetailRange: 60,
    materialClass: 'standard', mipDrop: 0, maxRenderPixels: 3686400,
  });
  assert.deepEqual(tierFor('low'), {
    detail: { radius: 170, maxCells: 16, geometryBudgetMiB: 96 }, fallback: { radius: 300, maxCells: 28, geometryBudgetMiB: 64 },
    settle: { fallback: 150, detail: 100 }, fog: { near: 160, far: 300 }, cameraFar: 300, foliageLodScale: 1, vehicleDetailRange: 30,
    materialClass: 'lambert', mipDrop: 0, maxRenderPixels: 1440000,
  });
  assert.deepEqual(tierFor('low', true), {
    detail: { radius: 140, maxCells: 12, geometryBudgetMiB: 64 }, fallback: { radius: 240, maxCells: 20, geometryBudgetMiB: 48 },
    settle: { fallback: 100, detail: 72 }, fog: { near: 130, far: 240 }, cameraFar: 240, foliageLodScale: 1, vehicleDetailRange: 30,
    materialClass: 'lambert', mipDrop: 0, maxRenderPixels: 921600,
  });
  assert.deepEqual(tierFor('standard', true), { ...QUALITY_TIERS.standard, maxRenderPixels: 921600 }, 'mobile Standard keeps desktop streaming, as before');
  assert.deepEqual(QUALITY_TIERS.minimal, {
    detail: { radius: 110, maxCells: 10, geometryBudgetMiB: 64 }, fallback: { radius: 220, maxCells: 20, geometryBudgetMiB: 48 },
    settle: { fallback: 150, detail: 100 }, fog: { near: 110, far: 220 }, cameraFar: 220, foliageLodScale: .6, vehicleDetailRange: 30,
    materialClass: 'lambert', mipDrop: 1, maxRenderPixels: 1440000,
  });
  assert.equal(tierParameters('minimal', true).detail.radius, 110, 'mobile overrides never widen the minimal tier');
  assert.equal(tierParameters('minimal', true).maxRenderPixels, 921600);
  for (const value of [QUALITY_TIERS, QUALITY_TIERS.low, QUALITY_TIERS.low.detail, MOBILE_TIER_OVERRIDES, tierFor('low', true), tierFor('low', true).fog]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { (QUALITY_TIERS.low.detail as { radius: number }).radius = 1; }, TypeError);
});

test('remembered automatic tier: URL > saved preset > remembered tier > estimate; malformed values and review builds ignore it', () => {
  const h = configHarness('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)');
  let config = h.read('');
  assert.deepEqual([config.preset, config.presetSource, config.startTier, config.rememberedTier], ['standard', 'auto', 'standard', null]);
  h.values.set(AUTO_TIER_STORAGE_KEY, 'low');
  const probes = h.fake.seen.contexts.length;
  config = h.read('');
  assert.deepEqual([config.preset, config.presetSource, config.startTier, config.rememberedTier], ['low', 'auto', 'low', 'low']);
  assert.equal(h.fake.seen.contexts.length, probes, 'a remembered tier replaces the device estimate');
  assert.equal(config.maxRenderPixels, 1440000); assert.equal(config.vehicleDetailRange, 30); assert.equal(config.pixelRatioCap, 1);
  h.values.set(AUTO_TIER_STORAGE_KEY, 'minimal');
  config = h.read('');
  assert.deepEqual([config.preset, config.startTier, config.rememberedTier], ['low', 'minimal', 'minimal']);
  assert.equal(config.maxRenderPixels, tierParameters('minimal').maxRenderPixels); assert.equal(config.vehicleDetailRange, 30);
  h.values.set(PRESET_STORAGE_KEY, 'standard');
  config = h.read('');
  assert.deepEqual([config.preset, config.presetSource, config.startTier, config.rememberedTier], ['standard', 'saved', 'standard', null], 'a saved preset wins');
  h.values.delete(PRESET_STORAGE_KEY);
  config = h.read('?preset=standard');
  assert.deepEqual([config.preset, config.presetSource, config.startTier, config.rememberedTier], ['standard', 'url', 'standard', null], 'the URL wins');
  config = h.read('?preset=low');
  assert.deepEqual([config.preset, config.startTier], ['low', 'low']);
  for (const review of ['?review=1', '?review=1&preset=auto']) {
    config = h.read(review);
    assert.deepEqual([config.preset, config.startTier, config.rememberedTier], ['standard', 'standard', null], `${review} ignores it`);
  }
  for (const malformed of ['', 'standard', 'MINIMAL', 'low ', '__proto__', 'medium', '1']) {
    h.values.set(AUTO_TIER_STORAGE_KEY, malformed);
    config = h.read('');
    assert.deepEqual([config.preset, config.startTier, config.rememberedTier], ['standard', 'standard', null], JSON.stringify(malformed));
  }
});

test('the remembered tier reaches touch-first starts, and unavailable storage is ignored', () => {
  const values = new Map<string, string>([[AUTO_TIER_STORAGE_KEY, 'minimal']]);
  const globals = (storage: unknown) => ({
    navigator: { maxTouchPoints: 5, hardwareConcurrency: 8, deviceMemory: 8 },
    matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
    location: { search: '' }, localStorage: storage, document: fakeDocument('Adreno (TM) 650').document,
    __REVIEW_BUILD__: false, __WORLD_DEPLOYMENT__: { appBase: '/', pages: false, release: null, worldBaseUrl: null, manifestSha256: null },
  });
  let config = withGlobals(globals({ getItem: (key: string) => values.get(key) ?? null }), readConfig);
  assert.deepEqual([config.mobile, config.preset, config.startTier], [true, 'low', 'minimal']);
  assert.equal(config.maxRenderPixels, 921600);
  config = withGlobals(globals({ getItem: () => { throw new Error('blocked'); } }), readConfig);
  assert.deepEqual([config.preset, config.startTier, config.rememberedTier], ['low', 'low', null]);
  assert.equal(savedAutoTier(), null, 'no storage at all is ignored');
});

test('choosing a graphics preset stores it (or clears it for Automatic) and always forgets the remembered tier', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
  withGlobals({ localStorage: storage }, () => {
    for (const choice of ['low', 'standard', 'auto'] as const) {
      values.set(AUTO_TIER_STORAGE_KEY, 'minimal'); values.set(PRESET_STORAGE_KEY, 'low');
      assert.equal(storeGraphicsChoice(choice), true);
      assert.equal(values.has(AUTO_TIER_STORAGE_KEY), false, choice);
      assert.equal(values.get(PRESET_STORAGE_KEY), choice === 'auto' ? undefined : choice);
    }
  });
  withGlobals({ localStorage: { setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('quota'); } } }, () => {
    assert.equal(storeGraphicsChoice('low'), false, 'the caller falls back to the address');
  });
});

test('after a graphics choice on this page, the reload pagehide cannot write the remembered tier back', () => {
  const values = new Map<string, string>([[AUTO_TIER_STORAGE_KEY, 'minimal']]);
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
  withGlobals({ localStorage: storage }, () => {
    assert.equal(storeGraphicsChoice('low'), true);
    rememberAutoTier('minimal');
    assert.equal(values.has(AUTO_TIER_STORAGE_KEY), false, 'the explicit choice stays in force');
  });
});
