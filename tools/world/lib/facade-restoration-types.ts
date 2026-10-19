/** Native, ungraded licensed PNG master, decoded once by the shared authoring pipeline. */
export interface FacadeSourceImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Hash of the PNG bytes, not of its decoded pixels or the city's original image encoding. */
  readonly pngSha256: string;
}
export type FacadeSources = ReadonlyMap<number, FacadeSourceImage>;
export interface FacadeExternalSourceInput {
  readonly id: string;
  readonly file: string;
  /** Exact original file bytes; external photographs may be JPEG or PNG. */
  readonly sha256: string;
}
export interface FacadeExternalSourceImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly sha256: string;
}
export type FacadeExternalSources = ReadonlyMap<string, FacadeExternalSourceImage>;
export interface FacadeRestorationEvidence {
  readonly id: string;
  readonly page: number;
  readonly changedTexels: number;
  readonly limits: string;
  readonly [key: string]: unknown;
}
export interface FacadeRestorationModule {
  readonly id: string;
  /** Pages modified by this module. Other pages must be left untouched. */
  readonly targetPages: readonly number[];
  /** All raw masters needed, including target masters. apply must verify their pinned PNG hashes. */
  readonly sourcePages: readonly number[];
  /** Licensed external photographs, decoded once by the shared authoring loader. */
  readonly externalSources?: readonly FacadeExternalSourceInput[];
  /** Source-specific chart catalogues or other static inputs, checked before authoring. */
  readonly supportFiles?: readonly { readonly file: string; readonly sha256: string }[];
  /** Target rgba is resampled but ungraded. Sources always remain immutable at native resolution. */
  readonly apply: (page: number, rgba: Uint8Array, width: number, height: number, sources: FacadeSources, externalSources?: FacadeExternalSources) => FacadeRestorationEvidence[];
}
