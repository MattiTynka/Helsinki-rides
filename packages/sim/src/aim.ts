import type { AimRay } from './commands.ts';
import { normalize, type V3 } from './math.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';

/** Resolve the reticle against the world first; a separate weapon ray must still check cover from the shooter. */
export function resolveAimTarget(world: StaticWorld, eye: V3, fallbackDirection: V3, aimRay: AimRay | undefined, range: number, excludeBody?: RAPIER.RigidBody): V3 {
  const fallback: V3 = [eye[0] + fallbackDirection[0] * range, eye[1] + fallbackDirection[1] * range, eye[2] + fallbackDirection[2] * range];
  if (!aimRay) return fallback;
  const { origin: o, direction } = aimRay;
  const separation = Math.hypot(o[0] - eye[0], o[1] - eye[1], o[2] - eye[2]);
  const magnitude = Math.hypot(...direction);
  if (![...o, ...direction].every(Number.isFinite) || separation > 6 || magnitude < .5 || magnitude > 1.5) return fallback;
  const d = normalize([...direction]);
  const ray = new RAPIER.Ray({ x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] });
  const maxDistance = range + separation;
  const hit = world.physics.castRay(ray, maxDistance, true, undefined, groups(GROUP.bullet, GROUP.static | GROUP.vehicle | GROUP.character), undefined, excludeBody);
  const distance = hit?.timeOfImpact ?? maxDistance;
  const toTarget: V3 = [o[0] + d[0] * distance - eye[0], o[1] + d[1] * distance - eye[1], o[2] + d[2] * distance - eye[2]];
  // A wall between the camera and the player cannot make the gun shoot backwards.
  if (toTarget[0] * d[0] + toTarget[1] * d[1] + toTarget[2] * d[2] < .05) return [eye[0] + d[0] * range, eye[1] + d[1] * range, eye[2] + d[2] * range];
  return [eye[0] + toTarget[0], eye[1] + toTarget[1], eye[2] + toTarget[2]];
}

export function resolveAimDirection(world: StaticWorld, eye: V3, fallbackDirection: V3, aimRay: AimRay | undefined, range: number, excludeBody?: RAPIER.RigidBody): V3 {
  const target = resolveAimTarget(world, eye, fallbackDirection, aimRay, range, excludeBody);
  return normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
}
