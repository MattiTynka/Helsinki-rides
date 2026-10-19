// Runtime configuration from the URL: release, preset, lighting A/B, seed and review mode (plan section 15).
import { runtimeDeployment, selectedRelease } from './world/urls.ts';
declare const __REVIEW_BUILD__: boolean;

export type Preset = 'low' | 'standard';
export type Lighting = 'lit' | 'unlit';

export interface GameConfig {
  readonly release: string | null;
  readonly preset: Preset;
  readonly lighting: Lighting | null;
  readonly seed: number;
  readonly review: boolean;
  readonly hud: boolean;
  readonly audio: boolean;
  readonly pixelRatioCap: number;
  /** Cars farther than this from the camera draw as one merged mesh plus lamps (plan section 12 draw-call caps). */
  readonly vehicleDetailRange: number;
}

export function readConfig(): GameConfig {
  const q = new URLSearchParams(location.search);
  const preset: Preset = q.get('preset') === 'low' ? 'low' : 'standard';
  const review = __REVIEW_BUILD__ || q.get('review') === '1';
  return {
    release: selectedRelease(runtimeDeployment(), q.get('release')),
    preset,
    lighting: q.get('lighting') === 'unlit' ? 'unlit' : q.get('lighting') === 'lit' ? 'lit' : null,
    seed: Number(q.get('seed') ?? 2026) >>> 0,
    review,
    hud: q.get('hud') !== '0',
    audio: q.get('audio') !== '0' && !review,
    pixelRatioCap: preset === 'low' ? 1 : 1.5,
    vehicleDetailRange: preset === 'low' ? 30 : 60,
  };
}
