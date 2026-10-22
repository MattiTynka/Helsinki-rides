// Runtime configuration from the URL: release, preset, lighting A/B, seed and review mode (plan section 15).
import { runtimeDeployment, selectedRelease } from './world/urls.ts';
import type { CollisionMode } from './world/loader.ts';
import { detectDeviceCapabilities, isTouchFirstDevice, prefersLowGraphics, type DeviceCapabilities } from './device.ts';
declare const __REVIEW_BUILD__: boolean;

export type Preset = 'low' | 'standard';
export type Lighting = 'lit' | 'unlit';

/** The player's saved graphics choice; absent means automatic. */
export const PRESET_STORAGE_KEY = 'helsinki-rides:preset';
export const FRAME_RATE_STORAGE_KEY = 'helsinki-rides:frame-rate';

export interface GameConfig {
  readonly release: string | null;
  readonly preset: Preset;
  /** Where the preset came from: `?preset=`, the saved choice, or the automatic device estimate. */
  readonly presetSource: 'url' | 'saved' | 'auto';
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
  readonly maxRenderPixels?: number;
  /** Includes persistent characters, vehicles and scenery as well as streamed city textures. */
  readonly textureBudgetMb?: number;
  /** Lower the render resolution while frames are GPU-bound (off in review builds and with `?dynres=0`). */
  readonly dynamicResolution: boolean;
  /** Cars farther than this from the camera draw as one merged mesh plus lamps (plan section 12 draw-call caps). */
  readonly vehicleDetailRange: number;
  /** `?collision=all` loads every collision cell at startup instead of streaming them. */
  readonly collision: CollisionMode;
}

const isPreset = (value: string | null): value is Preset => value === 'low' || value === 'standard';

export function savedPreset(): Preset | null {
  try { const value = localStorage.getItem(PRESET_STORAGE_KEY); return isPreset(value) ? value : null; } catch { return null; }
}

export function savedFrameRate(): 30 | 60 | null {
  try { const value = localStorage.getItem(FRAME_RATE_STORAGE_KEY); return value === '30' ? 30 : value === '60' ? 60 : null; } catch { return null; }
}

export function automaticPreset(device: DeviceCapabilities = detectDeviceCapabilities()): Preset { return prefersLowGraphics(device) ? 'low' : 'standard'; }

export function readConfig(): GameConfig {
  const q = new URLSearchParams(location.search);
  const review = __REVIEW_BUILD__ || q.get('review') === '1';
  // Explicit opt-in also enables reproducible mobile-budget review on a desktop without changing touch controls.
  const device = detectDeviceCapabilities(), mobile = q.get('mobile') === '1' || (!review && isTouchFirstDevice(device));
  const requested = q.get('preset'), saved = review ? null : savedPreset();
  const requestedRate = q.get('fps'), frameRate = requestedRate === '30' ? 30 : requestedRate === '60' ? 60 : review ? null : savedFrameRate();
  // Review fixtures keep the historical default instead of depending on the test machine.
  const preset: Preset = isPreset(requested) ? requested : saved ?? (mobile ? 'low' : review ? 'standard' : automaticPreset(device));
  return {
    release: selectedRelease(runtimeDeployment(), q.get('release')),
    preset,
    presetSource: isPreset(requested) ? 'url' : saved ? 'saved' : 'auto',
    lighting: q.get('lighting') === 'unlit' ? 'unlit' : q.get('lighting') === 'lit' ? 'lit' : null,
    seed: Number(q.get('seed') ?? 2026) >>> 0,
    review,
    hud: q.get('hud') !== '0',
    audio: q.get('audio') !== '0' && !review,
    pixelRatioCap: preset === 'low' ? 1 : 1.5,
    mobile,
    ...(frameRate !== null || mobile ? { targetFrameRate: frameRate ?? 30 } : {}),
    initialRenderScale: mobile && preset === 'low' ? .8 : 1,
    ...(mobile ? { maxRenderPixels: 1280 * 720, textureBudgetMb: preset === 'low' ? 128 : 192 } : {}),
    dynamicResolution: !review && q.get('dynres') !== '0',
    vehicleDetailRange: preset === 'low' ? 30 : 60,
    collision: q.get('collision') === 'all' ? 'all' : 'streamed',
  };
}
