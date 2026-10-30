// Runtime configuration from the URL: release, preset, lighting A/B, seed and review mode (plan section 15).
import { runtimeDeployment, selectedRelease } from './world/urls.ts';
import type { CollisionMode } from './world/loader.ts';
import { detectDeviceCapabilities, detectGpuClass, isTouchFirstDevice, prefersLowGraphics, type DeviceCapabilities, type GpuClass } from './device.ts';
import { presetTier, tierParameters, type QualityTier } from './render/quality-tiers.ts';
declare const __REVIEW_BUILD__: boolean;

export type Preset = 'low' | 'standard';
export type Lighting = 'lit' | 'unlit';

/** The player's saved graphics choice; absent means automatic. */
export const PRESET_STORAGE_KEY = 'helsinki-rides:preset';
export const FRAME_RATE_STORAGE_KEY = 'helsinki-rides:frame-rate';
/** The detail tier the quality governor settled on below the automatic preset (`low` or `minimal`), for the next visit. */
export const AUTO_TIER_STORAGE_KEY = 'helsinki-rides:auto-tier';
export type RememberedTier = 'low' | 'minimal';

export interface GameConfig {
  readonly release: string | null;
  readonly preset: Preset;
  /** Where the preset came from: `?preset=`, the saved choice, or the automatic choice (remembered tier or estimate). */
  readonly presetSource: 'url' | 'saved' | 'auto';
  /** The detail tier this session starts at: the preset's own, or the lower tier remembered from the last visit. */
  readonly startTier: QualityTier;
  /** The automatic tier remembered from the last visit (null: none, or overridden by a URL or saved preset). */
  readonly rememberedTier: RememberedTier | null;
  /** Diagnostics: the GPU class and renderer string the automatic estimate used (`unknown`/null when it did not run). */
  readonly gpuClass?: GpuClass;
  readonly renderer?: string | null;
  readonly lighting: Lighting | null;
  readonly seed: number;
  readonly review: boolean;
  readonly hud: boolean;
  readonly audio: boolean;
  readonly pixelRatioCap: number;
  /** Touch-first hardware starts conservatively even when memory/core APIs are unavailable. Independent of touch UI. */
  readonly mobile?: boolean;
  readonly targetFrameRate?: 30 | 60;
  readonly initialRenderScale?: number;
  /** Lowest dynamic-resolution scale: 0.6 on touch-first hardware, 0.5 on desktops. */
  readonly minRenderScale?: number;
  /** Drawing-buffer ceiling: 1280x720 on touch-first hardware, otherwise the start tier's (2560x1440 / 1600x900). */
  readonly maxRenderPixels?: number;
  /** Includes persistent characters, vehicles and scenery as well as streamed city textures. */
  readonly textureBudgetMb?: number;
  /**
   * Lower the render resolution, then the detail tier, while frames are GPU-bound (`?dynres=0` turns both off; review
   * builds need `?dynres=1`).
   */
  readonly dynamicResolution: boolean;
  /** Cars farther than this from the camera draw as one merged mesh plus lamps (plan section 12 draw-call caps). */
  readonly vehicleDetailRange: number;
  /** `?collision=all` loads every collision cell at startup instead of streaming them. */
  readonly collision: CollisionMode;
  /** Squares the release lacks are built from kartta.hel.fi as the player nears them; `?live=0` turns this off. */
  readonly live: boolean;
  /** `?mipdrop=0|1`: measurement override of the detail tier's texture mip drop (null: the tier decides). */
  readonly mipDrop: 0 | 1 | null;
}

const isPreset = (value: string | null): value is Preset => value === 'low' || value === 'standard';

export function savedPreset(): Preset | null {
  try { const value = localStorage.getItem(PRESET_STORAGE_KEY); return isPreset(value) ? value : null; } catch { return null; }
}

export function savedFrameRate(): 30 | 60 | null {
  try { const value = localStorage.getItem(FRAME_RATE_STORAGE_KEY); return value === '30' ? 30 : value === '60' ? 60 : null; } catch { return null; }
}

export function savedAutoTier(): RememberedTier | null {
  try { const value = localStorage.getItem(AUTO_TIER_STORAGE_KEY); return value === 'low' || value === 'minimal' ? value : null; } catch { return null; }
}

/** Set once the player picks a graphics option on this page; the reload's pagehide must not undo that choice. */
let graphicsChoiceMade = false;

/** Storage failures only lose the memory for the next visit. Never after a graphics choice on this page. */
export function rememberAutoTier(tier: RememberedTier): void {
  if (graphicsChoiceMade) return;
  try { localStorage.setItem(AUTO_TIER_STORAGE_KEY, tier); } catch { /* Private mode: the next visit estimates again. */ }
}

export function forgetAutoTier(): void {
  try { localStorage.removeItem(AUTO_TIER_STORAGE_KEY); } catch { /* Nothing was stored. */ }
}

/**
 * The player's graphics choice (loading screen or pause menu): saves the preset, or clears it for Automatic, and
 * forgets the remembered automatic tier either way. False when storage is unavailable.
 */
export function storeGraphicsChoice(choice: Preset | 'auto'): boolean {
  graphicsChoiceMade = true;
  try {
    if (choice === 'auto') localStorage.removeItem(PRESET_STORAGE_KEY); else localStorage.setItem(PRESET_STORAGE_KEY, choice);
    localStorage.removeItem(AUTO_TIER_STORAGE_KEY);
    return true;
  } catch { return false; }
}

/** Applies a graphics choice for the next page load and reloads (the preset is fixed per load). */
export function applyGraphicsChoice(choice: Preset | 'auto'): void {
  if (storeGraphicsChoice(choice)) { location.reload(); return; }
  // Storage unavailable (private mode): carry the choice in the address instead.
  const url = new URL(location.href);
  if (choice === 'auto') url.searchParams.delete('preset'); else url.searchParams.set('preset', choice);
  location.assign(url);
}

export function automaticPreset(device: DeviceCapabilities = detectDeviceCapabilities()): Preset { return prefersLowGraphics(device) ? 'low' : 'standard'; }

export function readConfig(): GameConfig {
  const q = new URLSearchParams(location.search);
  const review = __REVIEW_BUILD__ || q.get('review') === '1';
  // Explicit opt-in also enables reproducible mobile-budget review on a desktop without changing touch controls.
  const device = detectDeviceCapabilities(), mobile = q.get('mobile') === '1' || (!review && isTouchFirstDevice(device));
  const requested = q.get('preset'), saved = review ? null : savedPreset();
  // Precedence: URL > saved preset > remembered automatic tier > device estimate. Review builds never remember.
  const remembered = review || isPreset(requested) || saved ? null : savedAutoTier();
  const requestedRate = q.get('fps'), frameRate = requestedRate === '30' ? 30 : requestedRate === '60' ? 60 : review ? null : savedFrameRate();
  // Review fixtures keep the historical default instead of depending on the test machine; `?preset=auto` (review only)
  // runs the same estimate as a production visit without a saved choice. Elsewhere `auto` is just a missing parameter.
  const estimate = !isPreset(requested) && !saved && !remembered && (!review || requested === 'auto');
  const gpu = estimate ? detectGpuClass() : { class: 'unknown' as const, renderer: null };
  // A remembered tier (low or minimal) starts on the Low preset: its LOD level, transcode and MSAA are preset-bound.
  const preset: Preset = isPreset(requested) ? requested : saved ?? (remembered || mobile ? 'low' : estimate ? automaticPreset({ ...device, gpuClass: gpu.class, renderer: gpu.renderer }) : 'standard');
  const startTier: QualityTier = remembered ?? presetTier(preset);
  const tier = tierParameters(startTier, mobile);
  return {
    release: selectedRelease(runtimeDeployment(), q.get('release')),
    preset,
    presetSource: isPreset(requested) ? 'url' : saved ? 'saved' : 'auto',
    startTier,
    rememberedTier: remembered,
    gpuClass: gpu.class,
    renderer: gpu.renderer,
    lighting: q.get('lighting') === 'unlit' ? 'unlit' : q.get('lighting') === 'lit' ? 'lit' : null,
    seed: Number(q.get('seed') ?? 2026) >>> 0,
    review,
    hud: q.get('hud') !== '0',
    audio: q.get('audio') !== '0' && !review,
    pixelRatioCap: preset === 'low' ? 1 : 1.5,
    mobile,
    ...(frameRate !== null || mobile ? { targetFrameRate: frameRate ?? 30 } : {}),
    initialRenderScale: mobile && preset === 'low' ? .8 : 1,
    minRenderScale: mobile ? .6 : .5,
    maxRenderPixels: tier.maxRenderPixels,
    ...(mobile ? { textureBudgetMb: preset === 'low' ? 128 : 192 } : {}),
    dynamicResolution: q.get('dynres') === '1' || (!review && q.get('dynres') !== '0'),
    vehicleDetailRange: tier.vehicleDetailRange,
    collision: q.get('collision') === 'all' ? 'all' : 'streamed',
    live: q.get('live') !== '0',
    mipDrop: q.get('mipdrop') === '1' ? 1 : q.get('mipdrop') === '0' ? 0 : null,
  };
}
