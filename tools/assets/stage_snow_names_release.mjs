// Name the player character Snow in a new immutable world: the character GLB's working-title names
// (rename_snow_names.mjs), the attribution lines carrying the same word, and the release's own notices, refreshed from
// the repository. Unchanged files are verified, then hard-linked; the source world and its release pointer never change.
// Usage, from the repo root:
//   node tools/assets/stage_snow_names_release.mjs --base <world> --out <new world> --release <id> --report <json>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateWorldManifest } from '../../packages/world-schema/src/index.ts';
import { renameToSnow, snowRename } from './rename_snow_names.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['base', 'out', 'release', 'report'].map(k => [k, { type: 'string' }])) });
for (const key of ['base', 'out', 'release', 'report']) assert.ok(values[key], `--${key} required`);
assert.match(values.release, /^[a-z0-9][a-z0-9-]{0,95}$/);
const base = path.resolve(values.base), out = path.resolve(values.out);
assert.ok(!fs.existsSync(out) && !fs.existsSync(values.report), 'Use fresh output paths');
assert.ok(out !== base && !out.startsWith(base + path.sep), 'Keep the source world immutable');
const hash = data => createHash('sha256').update(data).digest('hex');
const sourceText = fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'), source = JSON.parse(sourceText);
const indent = /^\{\r?\n( *)"/.exec(sourceText)?.[1].length ?? 0; // keep the source manifest's layout and size
assert.deepEqual(validateWorldManifest(source), []);
const manifest = structuredClone(source), writes = new Map();
const reference = (name, data) => { writes.set(name, data); return { path: name, bytes: data.length, sha256: hash(data) }; };

const player = manifest.assets.find(asset => asset.id === 'character-snow');
const before = fs.readFileSync(path.join(base, player.path));
assert.ok(before.length === player.bytes && hash(before) === player.sha256, 'Player character differs from its manifest');
const { bytes, title, changes } = renameToSnow(before), rename = snowRename(title);
const previous = { path: player.path, bytes: player.bytes, sha256: player.sha256 };
// `optimization` stays: the buffers are still the proved lossless storage of the same source; only names differ.
Object.assign(player, reference(`assets/character-snow.${hash(bytes).slice(0, 16)}.glb`, bytes));
const attribution = manifest.attribution.map(rename);
for (const [published, local] of [['asset-credits.json', 'content/releases/asset-credits.json'],
  ['third-party-notices.md', 'THIRD_PARTY_NOTICES.md'], ['publication-notices.md', 'content/releases/world-notice.md']]) {
  const name = `publication/${published}`;
  assert.ok(manifest.publicationFiles.some(ref => ref.path === name), `${name} missing from the source world`);
  const item = reference(name, fs.readFileSync(new URL(`../../${local}`, import.meta.url)));
  manifest.publicationFiles = manifest.publicationFiles.map(ref => ref.path === name ? item : ref);
}
// The record names hashes and counts only, so the release carries no trace of the old names.
const record = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceRelease: source.worldReleaseId, asset: 'character-snow',
  tool: 'tools/assets/rename_snow_names.mjs', before: previous, after: { path: player.path, bytes: player.bytes, sha256: player.sha256 },
  binChunk: 'byte-identical', renamedStrings: changes.length, renamedAttributionLines: attribution.filter((line, i) => line !== manifest.attribution[i]).length,
  names: changes.map(([, after]) => after) }, null, 1) + '\n');
manifest.publicationFiles = [...manifest.publicationFiles, reference('publication/snow-names.json', record)];
Object.assign(manifest, { worldReleaseId: values.release, builtAt: new Date().toISOString(), attribution });
assert.deepEqual(validateWorldManifest(manifest), []);
const stale = new RegExp(`(?<![a-z])${title}(?![a-z])`, 'i');
const text = (name, data) => name.endsWith('.glb') ? data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8') : data.toString('utf8');
for (const [name, data] of [['manifest.json', Buffer.from(JSON.stringify(manifest))], ...writes]) assert.ok(!stale.test(text(name, data)), `${name} still carries the old name`);

function refs(value, found = new Map()) {
  if (!value || typeof value !== 'object') return found;
  if (typeof value.path === 'string' && typeof value.bytes === 'number' && typeof value.sha256 === 'string') {
    const prior = found.get(value.path);
    if (prior) assert.deepEqual(prior, { path: value.path, bytes: value.bytes, sha256: value.sha256 });
    found.set(value.path, { path: value.path, bytes: value.bytes, sha256: value.sha256 });
  } else for (const child of Object.values(value)) refs(child, found);
  return found;
}
const references = refs(manifest); let retained = 0;
for (const ref of references.values()) {
  assert.ok(ref.path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)), 'Unsafe payload path');
  const target = path.resolve(out, ref.path), original = path.resolve(base, ref.path);
  assert.ok(target.startsWith(out + path.sep) && original.startsWith(base + path.sep));
  const data = writes.get(ref.path) ?? fs.readFileSync(original);
  assert.ok(data.length === ref.bytes && hash(data) === ref.sha256, `${ref.path} differs from its manifest`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (writes.has(ref.path)) fs.writeFileSync(target, data, { flag: 'wx' });
  else { assert.ok(fs.lstatSync(original).isFile()); fs.linkSync(original, target); retained++; }
}
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, indent) + '\n');
fs.writeFileSync(path.join(out, 'manifest.json'), manifestBytes, { flag: 'wx' });
const report = { status: 'STAGED_REQUIRES_RUNTIME_REVIEW', sourceRelease: source.worldReleaseId, worldRelease: manifest.worldReleaseId,
  manifestSha256: hash(manifestBytes), retainedPayloads: retained, writtenPayloads: writes.size, character: { before: previous, after: player },
  renamedStrings: changes.length, worldBytes: manifestBytes.length + [...references.values()].reduce((n, ref) => n + ref.bytes, 0), files: references.size + 1 };
fs.writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 1));
