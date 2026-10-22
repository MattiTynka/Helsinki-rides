import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../../../apps/game/src/game.ts';
import { GameAudio } from '../../../apps/game/src/audio/audio.ts';
import { Button, NEUTRAL, type Command, type SimState } from '../../../packages/sim/src/index.ts';

test('pause and resume discard catch-up time and require fresh input', () => {
  const active: boolean[] = [];
  let resets = 0;
  const context = { paused: false, accumulator: 10, lastNow: 0,
    input: { setActive: (enabled: boolean) => active.push(enabled) }, framePacer: { reset: () => resets++ } };
  Game.prototype.setPaused.call(context as unknown as Game, true);
  assert.equal(context.paused, true); assert.equal(context.accumulator, 0); assert.ok(context.lastNow > 0);
  context.accumulator = 5;
  Game.prototype.setPaused.call(context as unknown as Game, false);
  assert.equal(context.paused, false); assert.equal(context.accumulator, 0);
  assert.deepEqual(active, [false, true]); assert.equal(resets, 2);
});

test('a car entry transition clears held and queued actions before another tick in the same frame', () => {
  const commands: Command[] = [];
  let held = Button.interact | Button.jump, tick = 0, notifications = 0;
  const snapshot = () => ({ tick, time: tick / 60, player: { mode: tick ? 'entering' : 'onFoot', alive: true }, shots: [] }) as unknown as SimState;
  const context = {
    collision: null, actorModelsReady: () => true, captureReplay: false, config: { review: false },
    stepBlock: null, state: snapshot(), previousState: snapshot(), pendingShots: [], frameEvents: [],
    currentCommand: () => ({ ...NEUTRAL, buttons: held }), input: { reset: () => { held = 0; } },
    sim: { step: (command: Command) => { commands.push(command); tick++; return []; }, state: snapshot },
    handleEvents: () => {}, onStateChange: () => notifications++,
  };
  assert.equal(Game.prototype.stepTicks.call(context as unknown as Game, 2), 2);
  assert.equal(commands[0]!.buttons, Button.interact | Button.jump);
  assert.equal(commands[1]!.buttons, 0, 'the second fixed tick cannot reuse an entry gesture');
  assert.equal(notifications, 2);
});

test('returning to a suspended audio context resumes the same context from the next gesture', async () => {
  let resumes = 0, suspends = 0;
  const context = { enabled: true, ctx: { state: 'suspended', resume: async () => { resumes++; }, suspend: async () => { suspends++; } } };
  GameAudio.prototype.start.call(context as unknown as GameAudio);
  await Promise.resolve();
  assert.equal(resumes, 1);
  context.ctx.state = 'running';
  GameAudio.prototype.start.call(context as unknown as GameAudio);
  assert.equal(resumes, 1);
  GameAudio.prototype.suspend.call(context as unknown as GameAudio);
  await Promise.resolve();
  assert.equal(suspends, 1);
  context.enabled = false;
  GameAudio.prototype.start.call(context as unknown as GameAudio);
  assert.equal(resumes, 1);
});
