// Name a character GLB after Snow. The supplied export named its rig, meshes, materials and images after a working
// title, the first word of its rig's name ("<title>_game_rig"); every JSON string holding that word gets "snow" in
// the same case. Only those strings change: JSON structure, numbers and the BIN chunk stay byte-identical.
// Usage, from the repo root:
//   node tools/assets/rename_snow_names.mjs --in <character.glb> --out <renamed.glb>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function sameExceptNames(before, after, rename, at = '') {
  if (typeof before === 'string') return assert.equal(after, rename(before), `${at}: unexpected change`);
  if (before === null || typeof before !== 'object') return assert.deepEqual(after, before, `${at}: changed`);
  assert.deepEqual(Object.keys(after), Object.keys(before), `${at}: keys changed`);
  for (const key of Object.keys(before)) sameExceptNames(before[key], after[key], rename, `${at}/${key}`);
}

/** Replaces `title` as a word of its own (never a longer word that merely starts or ends with it) by Snow, same case. */
export function snowRename(title) {
  const word = new RegExp(`(?<![a-z])${title}(?![a-z])`, 'gi');
  return value => value.replace(word, found => found === found.toUpperCase() ? 'SNOW' : found[0] === found[0].toUpperCase() ? 'Snow' : 'snow');
}

/** The GLB with its working-title names changed to Snow's, and each changed string as [before, after]. */
export function renameToSnow(bytes) {
  bytes = Buffer.from(bytes);
  assert.ok(bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2, 'Not a glTF 2.0 binary');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'The first chunk must be JSON');
  const text = bytes.subarray(20, 20 + jsonLength).toString('utf8'), tail = bytes.subarray(20 + jsonLength);
  const json = JSON.parse(text), title = json.skins?.[0]?.name?.match(/^([A-Za-z]+)_game_rig$/)?.[1];
  assert.ok(title, 'Expected a "<title>_game_rig" skin');
  assert.notEqual(title.toLowerCase(), 'snow', 'Already named after Snow');
  const rename = snowRename(title), changes = new Map();
  const renamed = text.replace(/"(?:[^"\\]|\\.)*"/g, literal => {
    const before = JSON.parse(literal), after = rename(before);
    if (after === before) return literal;
    changes.set(before, after);
    return JSON.stringify(after);
  });
  sameExceptNames(json, JSON.parse(renamed), rename);
  const chunk = Buffer.from(renamed.trimEnd()), padded = (chunk.length + 3) & ~3;
  const out = Buffer.alloc(20 + padded + tail.length, 0x20);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded, 12); out.writeUInt32LE(0x4e4f534a, 16); chunk.copy(out, 20); tail.copy(out, 20 + padded);
  assert.ok(Buffer.from(out.subarray(20 + padded)).equals(Buffer.from(tail)), 'BIN chunk changed');
  return { bytes: out, title, changes: [...changes] };
}

async function main() {
  const { values } = parseArgs({ options: { in: { type: 'string' }, out: { type: 'string' } } });
  assert.ok(values.in && values.out, '--in and --out required');
  const input = readFileSync(values.in), { bytes, title, changes } = renameToSnow(input);
  const { validateBytes } = await import('gltf-validator');
  const validation = await validateBytes(new Uint8Array(bytes), { maxIssues: 100 });
  assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
  writeFileSync(values.out, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ in: { file: values.in, bytes: input.length, sha256: sha(input) }, out: { file: values.out, bytes: bytes.length, sha256: sha(bytes) },
    title, binChunk: 'byte-identical', renamedStrings: changes.length, changes, validation: { errors: 0, warnings: validation.issues.numWarnings } }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
