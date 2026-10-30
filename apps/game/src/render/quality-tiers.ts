// Detail tiers (decision 0023): one table for the streaming ranges, fog, far plane, foliage and vehicle detail, city
// material class, texture mip drop and drawing-buffer ceiling. A preset selects its starting tier. The detail stream's
// LOD level, the requested texture tier (`full`/`m1`), the compact transcode preference, MSAA and the pixel-ratio cap
// are fixed for the session by the preset itself and are therefore not tier parameters.
import type { Preset } from '../config.ts';

export type QualityTier = 'standard' | 'low' | 'minimal';
/** `standard`: MeshStandardMaterial (flattened PBR); `lambert`: MeshLambertMaterial with the same maps and baked rule. */
export type MaterialClass = 'standard' | 'lambert';

export interface StreamRange {
  readonly radius: number;
  readonly maxCells: number;
  readonly geometryBudgetMiB: number;
}

export interface TierParameters {
  readonly detail: StreamRange;
  readonly fallback: StreamRange;
  /** Startup waits until both streams are resident within these radii of the spawn. */
  readonly settle: { readonly fallback: number; readonly detail: number };
  readonly fog: { readonly near: number; readonly far: number };
  readonly cameraFar: number;
  /** Multiplies the foliage LOD switch distances (1 keeps the authored distances). */
  readonly foliageLodScale: number;
  /** Cars farther than this from the camera draw as one merged mesh plus lamps. */
  readonly vehicleDetailRange: number;
  readonly materialClass: MaterialClass;
  /** Top KTX2 mip levels stripped before transcoding. */
  readonly mipDrop: 0 | 1;
  /** Desktop drawing-buffer ceiling in pixels. */
  readonly maxRenderPixels: number;
}

const freeze = <T extends object>(value: T): Readonly<T> => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child as object);
  return Object.freeze(value);
};

export const QUALITY_TIERS: Readonly<Record<QualityTier, TierParameters>> = freeze({
  standard: {
    detail: { radius: 230, maxCells: 28, geometryBudgetMiB: 160 }, fallback: { radius: 420, maxCells: 42, geometryBudgetMiB: 96 },
    settle: { fallback: 150, detail: 100 }, fog: { near: 240, far: 420 }, cameraFar: 420,
    foliageLodScale: 1, vehicleDetailRange: 60, materialClass: 'standard', mipDrop: 0, maxRenderPixels: 2560 * 1440,
  },
  low: {
    detail: { radius: 170, maxCells: 16, geometryBudgetMiB: 96 }, fallback: { radius: 300, maxCells: 28, geometryBudgetMiB: 64 },
    settle: { fallback: 150, detail: 100 }, fog: { near: 160, far: 300 }, cameraFar: 300,
    foliageLodScale: 0.8, vehicleDetailRange: 30, materialClass: 'lambert', mipDrop: 0, maxRenderPixels: 1600 * 900,
  },
  // The fallback ring (220 m, 20 cells) still covers every cell within the 12 m visual-coverage margin.
  minimal: {
    detail: { radius: 110, maxCells: 10, geometryBudgetMiB: 64 }, fallback: { radius: 220, maxCells: 20, geometryBudgetMiB: 48 },
    settle: { fallback: 150, detail: 100 }, fog: { near: 110, far: 220 }, cameraFar: 220,
    foliageLodScale: 0.6, vehicleDetailRange: 30, materialClass: 'lambert', mipDrop: 1, maxRenderPixels: 1600 * 900,
  },
});

/** Touch-first hardware on the low tier streams a smaller neighbourhood; every mobile tier renders at most 1280×720. */
export const MOBILE_TIER_OVERRIDES = freeze({
  detail: { radius: 140, maxCells: 12, geometryBudgetMiB: 64 }, fallback: { radius: 240, maxCells: 20, geometryBudgetMiB: 48 },
  settle: { fallback: 100, detail: 72 }, fog: { near: 130, far: 240 }, cameraFar: 240, maxRenderPixels: 1280 * 720,
} as const);

export function presetTier(preset: Preset): QualityTier { return preset === 'low' ? 'low' : 'standard'; }

/** Resolved parameters of a tier. Mobile: the smaller streaming ranges apply on the low tier only, the pixel ceiling always. */
export function tierParameters(tier: QualityTier, mobile = false): TierParameters {
  const base = QUALITY_TIERS[tier];
  if (!mobile) return base;
  const maxRenderPixels = Math.min(base.maxRenderPixels, MOBILE_TIER_OVERRIDES.maxRenderPixels);
  return freeze(tier === 'low' ? { ...base, ...MOBILE_TIER_OVERRIDES, maxRenderPixels } : { ...base, maxRenderPixels });
}

export function tierFor(preset: Preset, mobile = false): TierParameters { return tierParameters(presetTier(preset), mobile); }
