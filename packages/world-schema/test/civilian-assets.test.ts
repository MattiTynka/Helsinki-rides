import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCivilianAssets } from '../src/validate.ts';
import type { WorldManifest } from '../src/types.ts';

test('civilian configuration rejects missing and non-character models before simulation starts', () => {
  const asset = { id: 'character-civilian-agent47', kind: 'character', path: 'assets/agent.glb', bytes: 1, sha256: 'a'.repeat(64) } as WorldManifest['assets'][number];
  assert.deepEqual(validateCivilianAssets(undefined, []), []);
  assert.deepEqual(validateCivilianAssets([], []), []);
  assert.equal(validateCivilianAssets(['agent47'], []).length, 1);
  assert.equal(validateCivilianAssets(['agent47'], [{ ...asset, kind: 'vehicle' }]).length, 1);
  assert.deepEqual(validateCivilianAssets(['agent47'], [asset]), []);
  assert.equal(validateCivilianAssets(['agent47', 'snow-black'], [asset]).length, 1);
});
