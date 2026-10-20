// Runtime configuration from the URL: release, preset, lighting A/B, seed and review mode (plan section 15).
import { runtimeDeployment, selectedRelease } from './world/urls.ts';
import type { CollisionMode } from './world/loader.ts';
declare const __REVIEW_BUILD__: boolean;

export type Preset = 'low' | 'standard';
export type Lighting = 'lit' | 'unlit';

/** The player's saved graphics choice; absent means automatic. */
export const PRESET_STORAGE_KEY = 'helsinki-rides:preset';

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

/** Low on devices that report at most 4 GB of memory or at most four logical cores. */
export function automaticPreset(): Preset {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency;
  return (memory !== undefined && memory <= 4) || (cores > 0 && cores <= 4) ? 'low' : 'standard';
}

export function readConfig(): GameConfig {
  const q = new URLSearchParams(location.search);
  const review = __REVIEW_BUILD__ || q.get('review') === '1';
  const requested = q.get('preset'), saved = review ? null : savedPreset();
  // Review fixtures keep the historical default instead of depending on the test machine.
  const preset: Preset = isPreset(requested) ? requested : saved ?? (review ? 'standard' : automaticPreset());
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
    dynamicResolution: !review && q.get('dynres') !== '0',
    vehicleDetailRange: preset === 'low' ? 30 : 60,
    collision: q.get('collision') === 'all' ? 'all' : 'streamed',
  };
}
