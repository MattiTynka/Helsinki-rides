// Digital keyboard follower for verification journeys. It observes the same car state
// visible to the player; it never changes physics, places the car or injects analog input.
export const KEYBOARD_DRIVE_WHEELBASE = 2.665;
export const keyboardDriveLookahead = (speed: number) => 4 + Math.max(0, speed) * .5;
/** Travel heading away from an adjacent car; reversing swaps the body's left/right travel sides. */
export function keyboardClearanceCourse(heading: number, direction: 1 | -1, adjacentSide: number): number {
  return heading + (direction < 0 ? Math.PI : 0) - direction * Math.sign(adjacentSide) * .7;
}
export function keyboardDriveControl(input: {
  headingError: number; lookahead: number; forwardSpeed: number; steerAngle: number;
  yawRate: number; maxSpeed: number; distanceToGoal: number;
}) {
  const { headingError, lookahead, forwardSpeed, steerAngle, yawRate, maxSpeed, distanceToGoal } = input;
  // Pure-pursuit curvature gives a small wheel target on almost straight streets.
  // Holding full A/D until the body faces the target made the rate-limited wheels
  // overshoot, producing alternating swerves even on a straight 3 m lane.
  const targetAngle = Math.max(-.55, Math.min(.55,
    Math.atan2(2 * KEYBOARD_DRIVE_WHEELBASE * Math.sin(headingError), Math.max(2, lookahead)) - yawRate * .1));
  const steer = targetAngle > .015 && steerAngle < targetAngle ? 1
    : targetAngle < -.015 && steerAngle > targetAngle ? -1 : 0;
  const behind = Math.abs(headingError) > 1.5 && forwardSpeed > 5;
  const curvatureSpeed = Math.sqrt(2.5 * Math.max(2, lookahead) / Math.max(.05, 2 * Math.abs(Math.sin(headingError))));
  const desiredSpeed = Math.min(maxSpeed, curvatureSpeed, Math.max(2.4, distanceToGoal / 1.5));
  return { steer: behind ? 0 : steer, throttle: behind || forwardSpeed > desiredSpeed + .6 ? -1
    : forwardSpeed < desiredSpeed ? 1 : 0, desiredSpeed, targetAngle };
}
