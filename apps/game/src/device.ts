/** Input capabilities are independent of viewport size and the selected graphics quality. */
export interface DeviceCapabilities {
  readonly maxTouchPoints: number;
  readonly primaryCoarse: boolean;
  readonly primaryFine: boolean;
  readonly primaryHover: boolean;
  readonly anyFine: boolean;
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
  /** From the WebGL renderer string, when the automatic estimate looked at it (`detectGpuClass`). */
  readonly gpuClass?: GpuClass;
  readonly renderer?: string | null;
}

export type GpuClass = 'integrated' | 'software' | 'mobile' | 'discrete' | 'unknown';

/** Renderer strings are untrusted and only ever classified; longer strings are cut to this many characters. */
const RENDERER_LIMIT = 256;
/**
 * First match wins, so the exceptions (software renderers, discrete Intel Arc models, AMD RX cards) precede the broad
 * rules. Intel's integrated Xe-LPG/Xe2 GPUs also report "Arc" (bare "Arc(TM) Graphics", or 1xxV/1xxT models), so only
 * a discrete model name counts: A3xx/A5xx/A7xx (optionally M), B5xx/B7xx, or an Arc Pro model.
 */
const RENDERER_CLASSES: readonly (readonly [RegExp, GpuClass])[] = [
  [/swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|\bmesa\b.*\bsoftware\b|mesa\/x\.org/, 'software'],
  [/\bmali\b|adreno|powervr|apple gpu|\bapple a\d+\b/, 'mobile'],
  [/intel.*\barc\b(\(tm\))?\s+(pro\b|a[357]\d{2}m?\b|b[57]\d{2}\b)/, 'discrete'],
  [/intel/, 'integrated'],
  [/\brx\b|radeon pro|firepro/, 'discrete'],
  [/radeon(\(tm\))? graphics|\bvega \d{1,2}\b|radeon(\(tm\))? \d{3}m\b/, 'integrated'],
  [/radeon|\bamd\b|nvidia|geforce|quadro/, 'discrete'],
];

/** Classifies a WebGL unmasked renderer string; generic or blocked strings (and desktop Apple silicon) are `unknown`. */
export function classifyRenderer(unmasked: string | null): GpuClass {
  if (typeof unmasked !== 'string') return 'unknown';
  const text = unmasked.slice(0, RENDERER_LIMIT).toLowerCase();
  return RENDERER_CLASSES.find(([pattern]) => pattern.test(text))?.[1] ?? 'unknown';
}

/**
 * Reads the renderer string from a throwaway context that is lost again immediately. It asks for the high-performance
 * GPU, as the game renderer does, so a dual-GPU laptop reports the GPU the game will actually use. Never throws.
 */
export function detectGpuClass(): { class: GpuClass; renderer: string | null } {
  const unknown = { class: 'unknown' as const, renderer: null };
  try {
    if (typeof document === 'undefined' || !document) return unknown;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const attributes: WebGLContextAttributes = { powerPreference: 'high-performance', antialias: false, depth: false, stencil: false };
    const gl = (canvas.getContext('webgl2', attributes) ?? canvas.getContext('webgl', attributes)) as WebGLRenderingContext | null;
    if (!gl) return unknown;
    try {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const value: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      const renderer = typeof value === 'string' && value.trim() ? value.slice(0, RENDERER_LIMIT) : null;
      return { class: classifyRenderer(renderer), renderer };
    } finally { gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  } catch { return unknown; }
}

export function detectDeviceCapabilities(): DeviceCapabilities {
  const matches = (query: string): boolean => typeof matchMedia === 'function' && matchMedia(query).matches;
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { deviceMemory?: number };
  return {
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    primaryCoarse: matches('(pointer: coarse)'), primaryFine: matches('(pointer: fine)'),
    primaryHover: matches('(hover: hover)'), anyFine: matches('(any-pointer: fine)'),
    ...(nav?.deviceMemory !== undefined ? { deviceMemory: nav.deviceMemory } : {}),
    ...(nav?.hardwareConcurrency !== undefined ? { hardwareConcurrency: nav.hardwareConcurrency } : {}),
  };
}

/** A touchscreen laptop with a primary mouse remains a desktop; an attached tablet mouse does not raise quality. */
export function isTouchFirstDevice(device: DeviceCapabilities = detectDeviceCapabilities()): boolean {
  return device.primaryCoarse || (device.maxTouchPoints > 0 && !device.primaryFine && !device.primaryHover && !device.anyFine);
}

/** Safari reports this generic string on Macs as well as on iPhones and iPads. */
const GENERIC_APPLE_GPU = /^apple gpu$/i;

/**
 * Deliberately conservative before loading: phones do not need memory/core APIs to select Low, and integrated,
 * software and mobile GPUs select it whatever their memory and core counts. Discrete and unknown GPUs keep the
 * memory/core rules. A generic "Apple GPU" counts as mobile only on touch hardware (desktop Safari reports it too).
 */
export function prefersLowGraphics(device: DeviceCapabilities = detectDeviceCapabilities()): boolean {
  const gpu = device.gpuClass;
  const mobileGpu = gpu === 'mobile' && (device.maxTouchPoints > 0 || !GENERIC_APPLE_GPU.test(device.renderer?.trim() ?? ''));
  return isTouchFirstDevice(device) || gpu === 'integrated' || gpu === 'software' || mobileGpu
    || (Number.isFinite(device.deviceMemory) && device.deviceMemory! > 0 && device.deviceMemory! <= 4)
    || (Number.isFinite(device.hardwareConcurrency) && device.hardwareConcurrency! > 0 && device.hardwareConcurrency! <= 4);
}
