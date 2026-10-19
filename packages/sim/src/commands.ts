// Tick-stamped input commands (plan section 2, simulation loop). One command per tick, encoded as small
// integers so a session trace can be replayed byte-for-byte in Node.
export const TICK_HZ = 60;
export const TICK_SECONDS = 1 / TICK_HZ;

export const Button = {
  sprint: 1,
  interact: 2,
  fire: 4,
  aim: 8,
  handbrake: 16,
  horn: 32,
  reload: 64,
  recover: 128,
  /** A distinct press; held/repeated key events must not produce repeated jumps. */
  jump: 256,
} as const;

export interface AimRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

export interface Command {
  /** Movement on foot (x right, z forward) in [-1, 1]; throttle/steer in the car come from the same axes. */
  readonly moveX: number;
  readonly moveZ: number;
  /** Camera yaw in radians: on foot, movement is relative to it and aiming follows it. */
  readonly yaw: number;
  readonly pitch: number;
  readonly buttons: number;
  /** Actual centre-of-screen camera ray, including shoulder offset and camera collision. */
  readonly aimRay?: AimRay;
}

export const NEUTRAL: Command = { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };

/** Existing five fields, optionally followed by camera origin (mm) and direction (millionths). */
export type EncodedCommand = [number, number, number, number, number, [number, number, number, number, number, number]?];

export function encodeCommand(c: Command): EncodedCommand {
  const result: EncodedCommand = [Math.round(c.moveX * 1024), Math.round(c.moveZ * 1024), Math.round(c.yaw * 10000), Math.round(c.pitch * 10000), c.buttons];
  if (c.aimRay) {
    const { origin: o, direction: d } = c.aimRay;
    result.push([Math.round(o[0] * 1000), Math.round(o[1] * 1000), Math.round(o[2] * 1000), Math.round(d[0] * 1e6), Math.round(d[1] * 1e6), Math.round(d[2] * 1e6)]);
  }
  return result;
}

export function decodeCommand(e: EncodedCommand): Command {
  const result: Command = { moveX: e[0] / 1024, moveZ: e[1] / 1024, yaw: e[2] / 10000, pitch: e[3] / 10000, buttons: e[4] };
  const ray = e[5];
  return ray ? { ...result, aimRay: { origin: [ray[0] / 1000, ray[1] / 1000, ray[2] / 1000], direction: [ray[3] / 1e6, ray[4] / 1e6, ray[5] / 1e6] } } : result;
}

export const has = (buttons: number, b: number): boolean => (buttons & b) !== 0;
