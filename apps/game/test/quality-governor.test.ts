import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QualityGovernor, tierRank, type GovernorFrame } from '../src/render/quality-governor.ts';
import { AdaptiveResolution } from '../src/render/frame-pacing.ts';

/** A fake clock advanced by the fed intervals, as rendered frames advance real time. */
function harness(options: Partial<ConstructorParameters<typeof QualityGovernor>[0]> = {}) {
  let clock = 0;
  const governor = new QualityGovernor({ presetTier: 'standard', targetMs: 1000 / 60, now: () => clock, ...options });
  const changes: { at: number; change: string; tier: string }[] = [];
  const run = (seconds: number, frame: Partial<GovernorFrame> & { intervalMs: number }) => {
    const full: GovernorFrame = { cpuMs: 2, renderScale: .5, atFloor: true, atCeiling: false, ...frame };
    for (let t = 0; t < seconds * 1000 - 1e-6; t += frame.intervalMs) {
      clock += frame.intervalMs;
      const change = governor.feed(full);
      if (change) changes.push({ at: clock, change, tier: governor.tier });
    }
  };
  return { governor, changes, run, advance: (ms: number) => { clock += ms; }, clock: () => clock };
}

const SLOW = { intervalMs: 50, cpuMs: 5 } as const;
const FAST = { intervalMs: 1000 / 60, cpuMs: 4, renderScale: 1, atFloor: false, atCeiling: true } as const;

test('sustained GPU-bound slowness at the resolution floor demotes one tier after 3 s, then waits 60 s', () => {
  const h = harness();
  h.run(2.9, SLOW);
  assert.equal(h.changes.length, 0, 'under 3 s is not enough');
  h.run(.2, SLOW);
  assert.deepEqual(h.changes.map(c => [c.change, c.tier]), [['demote', 'low']]);
  assert.ok(Math.abs(h.changes[0]!.at - 3000) <= 50, `demoted at ${h.changes[0]!.at} ms`);
  h.run(59, SLOW);
  assert.equal(h.changes.length, 1, 'cooldown: no second demotion within 60 s');
  h.run(3, SLOW);
  assert.deepEqual(h.changes.map(c => c.tier), ['low', 'minimal']);
  h.run(120, SLOW);
  assert.equal(h.governor.tier, 'minimal', 'never below minimal');
  assert.equal(h.changes.length, 2);
});

test('slowness above the resolution floor, CPU-bound frames and stalls never demote', () => {
  const notAtFloor = harness();
  notAtFloor.run(30, { ...SLOW, atFloor: false, renderScale: .8 });
  assert.equal(notAtFloor.changes.length, 0, 'the resolution governor reacts first');
  const cpuBound = harness();
  cpuBound.run(30, { intervalMs: 50, cpuMs: 30 });
  assert.equal(cpuBound.changes.length, 0, 'a CPU share of 60 % or more clamps catch-up instead');
  const stalls = harness();
  stalls.run(30, { intervalMs: 1500, cpuMs: 5 });
  assert.equal(stalls.changes.length, 0, 'intervals over 1000 ms are ignored');
  for (const intervalMs of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY]) assert.equal(stalls.governor.feed({ intervalMs, cpuMs: 1, renderScale: .5, atFloor: true, atCeiling: false }), null);
  assert.equal(stalls.governor.feed({ intervalMs: 50, cpuMs: Number.NaN, renderScale: .5, atFloor: true, atCeiling: false }), null);
});

test('only a frame that itself is GPU-bound, slow and at the floor can demote, whatever evidence has accumulated', () => {
  // WG-GOVERNOR-CPU-DEMOTION-01: 500 ms frames demote at 3 s; 40 s GPU-bound during the cooldown; then 20 s at 80 % CPU.
  const GPU = { intervalMs: 500, cpuMs: 50 } as const, CPU = { intervalMs: 500, cpuMs: 400 } as const;
  const h = harness();
  h.run(3, GPU);
  assert.deepEqual(h.changes.map(c => [c.at, c.tier]), [[3000, 'low']]);
  h.run(40, GPU); h.run(20, CPU);
  assert.equal(h.clock(), 63_000, 'the last CPU-bound frame lands exactly at cooldown expiry');
  h.run(10, CPU);
  assert.equal(h.governor.tier, 'low', 'CPU-bound frames at and after cooldown expiry never demote');
  h.run(2.5, GPU);
  assert.equal(h.governor.tier, 'low', 'evidence from before 20 s of CPU-bound frames does not count again');
  h.run(.5, GPU);
  assert.deepEqual(h.changes.map(c => [c.at, c.tier]), [[3000, 'low'], [76_000, 'minimal']], 'a fresh 3 s GPU-bound run demotes');

  const mixed = harness();
  mixed.run(2.5, GPU);
  for (const frame of [CPU, { intervalMs: 16, cpuMs: 2 }, { ...GPU, atFloor: false }]) assert.equal(mixed.governor.feed({ cpuMs: 0, renderScale: .5, atFloor: true, atCeiling: false, ...frame }), null);
  assert.equal(mixed.governor.tier, 'standard');
});

test('hysteresis: fast frames reset the slow run, and leaving the floor restarts it', () => {
  const h = harness();
  for (let i = 0; i < 10; i++) { h.run(2.5, SLOW); h.run(.1, { ...FAST, atFloor: true, atCeiling: false, renderScale: .5 }); }
  assert.equal(h.changes.length, 0, 'interrupted slowness never adds up to 3 s');
  h.run(2.5, SLOW); h.run(.1, { ...SLOW, atFloor: false }); h.run(2.5, SLOW);
  assert.equal(h.changes.length, 0, 'the 3 s must be spent at the floor');
  h.run(.1, { ...FAST, atFloor: true, atCeiling: false, renderScale: .5 });
  // Between "fast" and "slow" (here 20 ms at a 16.7 ms target) the run decays instead of resetting.
  h.run(2, SLOW); h.run(.5, { intervalMs: 20, cpuMs: 2 }); h.run(1.4, SLOW);
  assert.equal(h.changes.length, 0);
  h.run(.2, SLOW);
  assert.equal(h.governor.tier, 'low');
});

test('30 FPS pacing is judged against 33.3 ms: steady 33 ms frames never demote', () => {
  const h = harness({ targetMs: 1000 / 30 });
  h.run(120, { intervalMs: 33, cpuMs: 3 });
  assert.equal(h.changes.length, 0);
  const switched = harness();
  switched.run(2.5, SLOW);
  switched.governor.setTargetFrameRate(30);
  switched.run(120, { intervalMs: 33.4, cpuMs: 3 });
  assert.equal(switched.changes.length, 0, 'changing the target resets the slow run and the 33 ms cadence is on target');
  switched.run(3.1, { intervalMs: 50, cpuMs: 3 });
  assert.equal(switched.governor.tier, 'low', '50 ms frames are slow at 30 FPS too');
});

test('promotion needs 60 s of fast frames at the resolution ceiling and never exceeds the preset tier', () => {
  const h = harness();
  h.run(3.1, SLOW);
  assert.equal(h.governor.tier, 'low');
  h.run(59, FAST);
  assert.equal(h.governor.tier, 'low');
  h.run(1.1, FAST);
  assert.deepEqual(h.changes.map(c => [c.change, c.tier]), [['demote', 'low'], ['promote', 'standard']]);
  h.run(300, FAST);
  assert.equal(h.governor.tier, 'standard', 'never above the preset tier');
  const belowCeiling = harness();
  belowCeiling.run(3.1, SLOW);
  for (let i = 0; i < 4; i++) { belowCeiling.run(50, FAST); belowCeiling.run(.1, { ...FAST, atCeiling: false, renderScale: .9 }); }
  assert.equal(belowCeiling.governor.tier, 'low', 'the scale must stay at its ceiling for the whole period');
  const lowPreset = harness({ presetTier: 'low' });
  lowPreset.run(300, FAST);
  assert.equal(lowPreset.governor.tier, 'low');
  const remembered = harness({ presetTier: 'low', tier: 'minimal' });
  assert.equal(remembered.governor.tier, 'minimal', 'a remembered tier starts below the preset');
  remembered.run(60.1, FAST);
  assert.equal(remembered.governor.tier, 'low');
  remembered.run(300, FAST);
  assert.equal(remembered.governor.tier, 'low');
  assert.equal(harness({ presetTier: 'low', tier: 'standard' }).governor.tier, 'low', 'a start above the preset is clamped');
  assert.deepEqual(['standard', 'low', 'minimal'].map(t => tierRank(t as 'standard')), [0, 1, 2]);
});

test('the resolution governor reports its floor and ceiling', () => {
  const resolution = new AdaptiveResolution({ minRenderScale: .5 });
  assert.equal(resolution.atCeiling, true); assert.equal(resolution.atFloor, false);
  for (let i = 0; i < 200 && !resolution.atFloor; i++) resolution.update(.05, 2);
  assert.equal(resolution.scale, .5); assert.equal(resolution.atFloor, true); assert.equal(resolution.atCeiling, false);
  const fixed = new AdaptiveResolution({ minRenderScale: .8, initialRenderScale: .8 });
  assert.equal(fixed.atFloor, true); assert.equal(fixed.atCeiling, true);
  assert.equal(resolution.minScale, .5, 'the configured floor');
  assert.equal(new AdaptiveResolution().minScale, .6, 'default floor');
  assert.equal(new AdaptiveResolution({ minRenderScale: .05 }).minScale, .1, 'clamped like the scale itself');
  assert.equal(new AdaptiveResolution({ minRenderScale: Number.NaN }).minScale, .6);
});
