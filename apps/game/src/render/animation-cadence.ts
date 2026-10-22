/** Sample distant routine poses less often while advancing their authored clock by all elapsed time. */
export class AnimationCadence {
  private elapsed = 0;
  private previousKey: string | null = null;

  sample(dt: number, mobile: boolean, distance: number, key: string, urgent: boolean): number | null {
    const seconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.elapsed += seconds;
    const changed = key !== this.previousKey;
    this.previousKey = key;
    const interval = !mobile || distance < 30 ? 0 : distance < 65 ? 1 / 15 : 1 / 10;
    if (!changed && !urgent && seconds > 0 && this.elapsed + 1e-9 < interval) return null;
    const elapsed = this.elapsed; this.elapsed = 0; return elapsed;
  }
}

export interface CharacterPresentationOptions {
  readonly mobile?: boolean;
  readonly cameraPosition?: { readonly x: number; readonly y: number; readonly z: number };
}
