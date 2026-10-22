import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../../../apps/game/src/game.ts';
import { decodeCommand, encodeCommand } from '../../../packages/sim/src/commands.ts';

function fixture(captureReplay: boolean) {
  let tick = 0, digests = 0;
  const commands: unknown[] = [];
  const game = {
    captureReplay, config: { review: true }, commandLog: [], traceLog: [], eventLog: [], frameEvents: [],
    state: { tick: 0, player: { mode: 'onFoot', alive: true } }, previousState: { tick: 0, player: { mode: 'onFoot', alive: true } }, pendingShots: [],
    sim: {
      step(command: unknown) { commands.push(command); tick++; return [{ tick, type: 'fixture' }]; },
      state() { return { tick, shots: [], player: { mode: 'onFoot', alive: true } }; },
      digest() { digests++; return `tick-${tick}`; },
    },
    handleEvents() {},
    actorModelsReady: () => true,
  };
  return { game: game as unknown as Game, commands, digests: () => digests };
}

test('long ordinary play keeps no command, event or digest history even with the review query flag', () => {
  const { game, commands, digests } = fixture(false);
  const command = { moveX: .123456, moveZ: .654321, yaw: .246813, pitch: .314159, buttons: 0 };
  Game.prototype.stepTicks.call(game, 36000, command);
  assert.equal(commands.length, 36000);
  assert.equal(game.commandLog.length, 0);
  assert.equal(game.eventLog.length, 0);
  assert.equal(game.traceLog.length, 0);
  assert.equal(digests(), 0);
  assert.deepEqual(commands[0], decodeCommand(encodeCommand(command)), 'normal command quantization remains exact');
  assert.equal(game.frameEvents.length, 36000, 'current-frame events still reach gameplay presentation');
});

test('review recordings retain exact quantized commands and bounded event/digest diagnostics', () => {
  const { game, digests } = fixture(true);
  const command = { moveX: .123456, moveZ: .654321, yaw: .246813, pitch: .314159, buttons: 0 };
  Game.prototype.stepTicks.call(game, 20020, command);
  assert.equal(game.commandLog.length, 20020);
  assert.deepEqual(game.commandLog[0], encodeCommand(command));
  assert.equal(game.eventLog.length, 5000);
  assert.equal(game.traceLog.length, 20000);
  assert.equal(digests(), 20000);
});
