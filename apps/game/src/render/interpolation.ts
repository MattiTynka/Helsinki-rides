import type { CharacterState, PlayerState, Quat, SimState, V3, VehicleState } from '@helsinki/sim';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const angle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const vector = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function quaternion(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  let wa = 1 - t, wb = t;
  if (dot < .9995) {
    const theta = Math.acos(dot), sine = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / sine; wb = Math.sin(t * theta) / sine;
  }
  const q: Quat = [a[0] * wa + b[0] * wb * sign, a[1] * wa + b[1] * wb * sign, a[2] * wa + b[2] * wb * sign, a[3] * wa + b[3] * wb * sign];
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function character<T extends CharacterState>(before: T | undefined, after: T, t: number): T {
  if (!before || before.alive !== after.alive || before.inVehicle !== after.inVehicle || distance(before.position, after.position) > 2) return after;
  return { ...after, position: vector(before.position, after.position, t), yaw: angle(before.yaw, after.yaw, t), speed: lerp(before.speed, after.speed, t),
    verticalSpeed: lerp(before.verticalSpeed, after.verticalSpeed, t),
    deathElapsed: before.deathElapsed !== undefined && after.deathElapsed !== undefined ? lerp(before.deathElapsed, after.deathElapsed, t) : after.deathElapsed,
    groundDistance: before.groundDistance !== null && after.groundDistance !== null ? lerp(before.groundDistance, after.groundDistance, t) : after.groundDistance,
    jumpPhaseTime: before.jumpPhase === after.jumpPhase && before.jumpKind === after.jumpKind ? lerp(before.jumpPhaseTime, after.jumpPhaseTime, t) : after.jumpPhaseTime,
  };
}

function vehicle(before: VehicleState | undefined, after: VehicleState, t: number): VehicleState {
  if (!before || before.definition !== after.definition || distance(before.position, after.position) > 5) return after;
  return {
    ...after, position: vector(before.position, after.position, t), rotation: quaternion(before.rotation, after.rotation, t),
    steerAngle: lerp(before.steerAngle, after.steerAngle, t), speed: lerp(before.speed, after.speed, t), forwardSpeed: lerp(before.forwardSpeed, after.forwardSpeed, t),
    wheels: after.wheels.map((wheel, i) => {
      const previous = before.wheels[i];
      return previous ? { ...wheel, position: vector(previous.position, wheel.position, t), rotation: angle(previous.rotation, wheel.rotation, t), steer: lerp(previous.steer, wheel.steer, t) } : wheel;
    }),
  };
}

/** One-tick-delayed presentation only. State, collision, commands and replay remain authoritative at 60 Hz. */
export function interpolateState(before: SimState, after: SimState, fraction: number): SimState {
  if (after.tick !== before.tick + 1 || before.player.mode !== after.player.mode || before.player.inVehicle !== after.player.inVehicle || distance(before.player.position, after.player.position) > 5) return after;
  const t = Math.max(0, Math.min(1, fraction));
  const previousVehicles = new Map(before.vehicles.map(v => [v.id, v]));
  const previousCharacters = new Map(before.characters.map(c => [c.id, c]));
  const previousInteraction = before.player.vehicleInteraction, interaction = after.player.vehicleInteraction;
  const player: PlayerState = { ...character(before.player, after.player, t), pitch: lerp(before.player.pitch, after.player.pitch, t),
    vehicleInteraction: interaction && previousInteraction?.vehicleId === interaction.vehicleId && previousInteraction.stage === interaction.stage && previousInteraction.clip === interaction.clip
      ? { ...interaction, progress: lerp(previousInteraction.progress, interaction.progress, t) } : interaction,
  };
  return { ...after, time: lerp(before.time, after.time, t), player,
    vehicles: after.vehicles.map(v => vehicle(previousVehicles.get(v.id), v, t)),
    characters: after.characters.map(c => character(previousCharacters.get(c.id), c, t)),
  };
}
