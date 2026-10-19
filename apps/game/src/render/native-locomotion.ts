// Asset-declared locomotion. The source extractor aligned these loops to one left strike;
// no rig names or unverified clip-phase assumptions are inferred from the player asset ID.
export type GaitDirection = 'forward' | 'backward' | 'left' | 'right';
export interface NativeMovementClip { readonly clip: string; readonly movementSpeed: number; readonly direction: GaitDirection }
export type NativeState = 'idle' | 'aim' | 'fire' | 'hit' | 'death' | 'drive' | 'arrested';
export interface NativeCharacterProfile {
  readonly schemaVersion: 1;
  readonly id: 'finn-native-v1' | 'rain-native-v1';
  readonly phaseGroup: 'left-strike';
  readonly upperBodyRoot: string;
  readonly locomotion: readonly NativeMovementClip[];
  readonly states: Readonly<Record<NativeState, string>>;
}
const DIRECTIONS: readonly GaitDirection[] = ['forward', 'backward', 'left', 'right'];
const STATES: readonly NativeState[] = ['idle', 'aim', 'fire', 'hit', 'death', 'drive', 'arrested'];
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const name = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100;

/** Missing metadata retains the legacy animation path; declared metadata fails closed. */
export function parseCharacterProfile(value: unknown, availableClips: ReadonlySet<string>): NativeCharacterProfile | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || value.schemaVersion !== 1 || (value.id !== 'finn-native-v1' && value.id !== 'rain-native-v1') || value.phaseGroup !== 'left-strike' || !name(value.upperBodyRoot)) throw new Error('Unsupported characterProfile metadata');
  if (!Array.isArray(value.locomotion) || value.locomotion.length < 4 || value.locomotion.length > 16 || !object(value.states)) throw new Error('Malformed characterProfile clips');
  const movements: NativeMovementClip[] = [];
  const names = new Set<string>();
  for (const entry of value.locomotion) {
    if (!object(entry) || !name(entry.clip) || !availableClips.has(entry.clip) || names.has(entry.clip) || typeof entry.movementSpeed !== 'number' || !Number.isFinite(entry.movementSpeed) || entry.movementSpeed <= 0 || entry.movementSpeed > 20 || !DIRECTIONS.includes(entry.direction as GaitDirection)) throw new Error('Invalid native movement clip metadata');
    movements.push({ clip: entry.clip, movementSpeed: entry.movementSpeed, direction: entry.direction as GaitDirection });
    names.add(entry.clip);
  }
  if (DIRECTIONS.some(direction => !movements.some(clip => clip.direction === direction))) throw new Error('Native characterProfile lacks a movement direction');
  const states = {} as Record<NativeState, string>;
  for (const key of STATES) {
    const clip = value.states[key];
    if (!name(clip) || !availableClips.has(clip) || names.has(clip)) throw new Error(`Native characterProfile lacks state ${key}`);
    states[key] = clip; names.add(clip);
  }
  return { schemaVersion: 1, id: value.id, phaseGroup: 'left-strike', upperBodyRoot: value.upperBodyRoot, locomotion: movements, states };
}

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** +X is character-left and +Z is forward. Diagonals blend their two source directions. */
export function nativeLocomotionWeights(profile: NativeCharacterProfile, speed: number, localX: number, localZ: number): Record<string, number> {
  speed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  if (!Number.isFinite(localX) || !Number.isFinite(localZ)) { localX = 0; localZ = 1; }
  const denominator = Math.abs(localX) + Math.abs(localZ);
  if (denominator < 1e-8) { localX = 0; localZ = 1; }
  const total = Math.abs(localX) + Math.abs(localZ);
  const directionWeights = { forward: Math.max(0, localZ) / total, backward: Math.max(0, -localZ) / total, left: Math.max(0, localX) / total, right: Math.max(0, -localX) / total };
  const moving = smooth(.03, .35, speed);
  const weights: Record<string, number> = { [profile.states.idle]: 1 - moving };
  for (const direction of DIRECTIONS) {
    const weight = directionWeights[direction] * moving;
    if (weight === 0) continue;
    const clips = profile.locomotion.filter(clip => clip.direction === direction).toSorted((a, b) => a.movementSpeed - b.movementSpeed);
    if (speed <= clips[0]!.movementSpeed) { weights[clips[0]!.clip] = weight; continue; }
    const upper = clips.findIndex(clip => speed < clip.movementSpeed);
    if (upper === -1) { weights[clips.at(-1)!.clip] = weight; continue; }
    const a = clips[upper - 1]!, b = clips[upper]!, blend = smooth(a.movementSpeed, b.movementSpeed, speed);
    weights[a.clip] = weight * (1 - blend); weights[b.clip] = weight * blend;
  }
  return weights;
}

/** Distance-based clock uses actual loaded durations and each source clip's authored speed. */
export function advanceNativeGaitPhase(phase: number, speed: number, dt: number, profile: NativeCharacterProfile, weights: Readonly<Record<string, number>>, durations: ReadonlyMap<string, number>): number {
  if (!(speed > 0) || !Number.isFinite(speed) || !(dt > 0) || !Number.isFinite(dt)) return phase;
  let stride = 0, movementWeight = 0;
  for (const entry of profile.locomotion) {
    const weight = weights[entry.clip] ?? 0, seconds = durations.get(entry.clip);
    if (weight > 0 && seconds && seconds > 0) { stride += weight * seconds * entry.movementSpeed; movementWeight += weight; }
  }
  return stride > 0 ? (phase + speed * dt * movementWeight / stride) % 1 : phase;
}

/** Inverse of the renderer's Y rotation; no simulation heading/input changes. */
export function localTravelDirection(dx: number, dz: number, yaw: number): readonly [number, number] {
  return [Math.cos(yaw) * dx - Math.sin(yaw) * dz, Math.sin(yaw) * dx + Math.cos(yaw) * dz];
}
