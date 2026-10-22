import type { CharacterState } from '@helsinki/sim';
import { knockdownProgress, type KnockdownPresentation } from './knockdown-presentation.ts';

/** Surviving knockdowns can recover; a fatal collapse only advances toward its held final pose. */
export class CharacterCollapse {
  private previous = 0;
  private dead = false;
  private deathStart = 0;
  private fallbackElapsed = 0;

  update(state: Pick<CharacterState, 'alive' | 'deathElapsed'> & { readonly knockdown?: KnockdownPresentation | null }, dt: number, duration: number): number | null {
    if (state.alive) {
      this.dead = false;
      this.fallbackElapsed = 0;
      const progress = knockdownProgress(state.knockdown, true);
      this.previous = progress ?? 0;
      return progress;
    }
    if (!this.dead) { this.dead = true; this.deathStart = this.previous; }
    this.fallbackElapsed += Number.isFinite(dt) ? Math.max(0, dt) : 0;
    // Authoritative age also places a newly visible or recreated corpse directly on the floor.
    const elapsed = state.deathElapsed !== undefined && Number.isFinite(state.deathElapsed)
      ? Math.max(0, state.deathElapsed) : this.fallbackElapsed;
    const progress = duration > 0 && Number.isFinite(duration) ? this.deathStart + elapsed / duration : 1;
    this.previous = Math.max(this.previous, Math.min(1, progress));
    return this.previous;
  }
}
