// Facade grade for aerial photo textures (decision 0003): the oblique flights add a bluish haze veil that lifts the
// shadows and greys the plaster colours. One global veil per channel (measured over every LoD2 master, black chart
// padding excluded) is subtracted and the range stretched back to 0..255, an optional gamma lifts the midtones (the
// flights left plaster in shade dull and olive; decision 0005), saturation is restored around Rec. 601 luma, and the
// resampled texture gets a light unsharp mask. Values are sRGB 8-bit; alpha is left alone.
import sharp from 'sharp';

export interface FacadeGrade {
  /** Per-channel veil subtracted from R, G and B (8-bit sRGB). */
  readonly veil: readonly [number, number, number];
  /** Midtone lift after the veil is removed, on 0..1 sRGB values (out = in^gamma); absent means 1. */
  readonly gamma?: number;
  readonly saturation: number;
  /** Unsharp-mask radius in pixels after resampling; 0 disables it. */
  readonly sharpenSigma: number;
}

/** Remove the veil and restore saturation in place on RGBA data; near-black chart padding stays black. */
export function removeVeil(rgba: Uint8Array, grade: FacadeGrade): void {
  const [vr, vg, vb] = grade.veil, s = grade.saturation, gamma = grade.gamma ?? 1;
  const kr = 255 / (255 - vr), kg = 255 / (255 - vg), kb = 255 / (255 - vb);
  const lift = (v: number) => (gamma === 1 || v <= 0 ? v : 255 * (v / 255) ** gamma);
  for (let i = 0; i < rgba.length; i += 4) {
    if (Math.max(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!) < 6) continue;
    const r = lift((rgba[i]! - vr) * kr), g = lift((rgba[i + 1]! - vg) * kg), b = lift((rgba[i + 2]! - vb) * kb);
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    rgba[i] = Math.max(0, Math.min(255, Math.round(l + (r - l) * s)));
    rgba[i + 1] = Math.max(0, Math.min(255, Math.round(l + (g - l) * s)));
    rgba[i + 2] = Math.max(0, Math.min(255, Math.round(l + (b - l) * s)));
  }
}

/** Grade a resampled RGBA texture: veil removal and saturation, then the unsharp mask. */
export async function gradeFacade(rgba: Uint8Array, width: number, height: number, grade: FacadeGrade): Promise<Uint8Array> {
  const out = Uint8Array.from(rgba);
  removeVeil(out, grade);
  if (grade.sharpenSigma <= 0) return out;
  const { data } = await sharp(out, { raw: { width, height, channels: 4 } }).sharpen({ sigma: grade.sharpenSigma, m1: 0.6, m2: 2 })
    .raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
