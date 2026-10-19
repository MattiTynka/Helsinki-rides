export const MOVEMENT_CLIPS = ['walk', 'run', 'sprint'] as const;
export type MovementClip = typeof MOVEMENT_CLIPS[number];
export type LocomotionClip = 'idle' | MovementClip;
export type LocomotionWeights = Record<LocomotionClip, number>;

// Metres per second at the authored clips' natural playback rate (character.contract.json).
export const LOCOMOTION_SPEED: Record<MovementClip, number> = { walk: 1.4, run: 3.6, sprint: 6.0 };

export function isLocomotionClip(name: string): name is LocomotionClip {
  return name === 'idle' || name === 'walk' || name === 'run' || name === 'sprint';
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** Adjacent, phase-aligned gaits blend continuously, including at the sim's discrete clip thresholds. */
export function locomotionWeights(speed: number): LocomotionWeights {
  speed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  const weights: LocomotionWeights = { idle: 0, walk: 0, run: 0, sprint: 0 };
  if (speed < LOCOMOTION_SPEED.walk) {
    // A small collision-induced shuffle should settle into a standing pose rather than marching in place.
    weights.walk = smoothstep(0.03, 0.35, speed);
    weights.idle = 1 - weights.walk;
  } else if (speed < LOCOMOTION_SPEED.run) {
    weights.run = smoothstep(LOCOMOTION_SPEED.walk, LOCOMOTION_SPEED.run, speed);
    weights.walk = 1 - weights.run;
  } else {
    weights.sprint = smoothstep(LOCOMOTION_SPEED.run, LOCOMOTION_SPEED.sprint, speed);
    weights.run = 1 - weights.sprint;
  }
  return weights;
}

/**
 * One shared cycle keeps both feet in phase while weights change. Its distance is the weighted authored
 * stride length, so a collision slowdown slows the feet immediately; no minimum playback rate is imposed.
 * Durations come from the loaded clips rather than an assumed export frame count.
 */
export function advanceGaitPhase(
  phase: number,
  speed: number,
  dt: number,
  weights: Pick<LocomotionWeights, MovementClip>,
  durations: Readonly<Partial<Record<MovementClip, number>>>,
): number {
  if (!(speed > 0) || !Number.isFinite(speed) || !(dt > 0) || !Number.isFinite(dt)) return phase;
  let movementWeight = 0;
  let strideLength = 0;
  for (const name of MOVEMENT_CLIPS) {
    const duration = durations[name];
    if (duration && duration > 0 && weights[name] > 0) {
      movementWeight += weights[name];
      strideLength += weights[name] * LOCOMOTION_SPEED[name] * duration;
    }
  }
  if (strideLength === 0) return phase;
  return (phase + speed * dt * movementWeight / strideLength) % 1;
}
