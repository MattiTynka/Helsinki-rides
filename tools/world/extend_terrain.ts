// Preserve the whole accepted heightfield while adding source-derived terrain outside its rectangle.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { encodeTerrain, parseTerrain } from '../../packages/world-schema/src/index.ts';
import { extendTerrainPreservingBase } from './lib/terrain-extension.ts';

const { values } = parseArgs({ options: Object.fromEntries(['base', 'expanded', 'origin', 'out'].map(key => [key, { type: 'string' as const }])) });
for (const key of ['base', 'expanded', 'origin', 'out']) assert.ok(values[key], `--${key} required`);
const out = values.out!; assert.ok(!existsSync(out), 'Use a fresh output directory');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const baseBytes = readFileSync(values.base!), expandedBytes = readFileSync(values.expanded!);
const { terrain, audit } = extendTerrainPreservingBase(parseTerrain(baseBytes), parseTerrain(expandedBytes));
const bytes = encodeTerrain(terrain), origin = JSON.parse(readFileSync(values.origin!, 'utf8'));
const report = { schemaVersion: 1, kind: 'terrain-heightfield', originId: origin.id,
  frame: 'runtime: X east, Y up, Z south; heights relative to the origin height', file: 'terrain.bin', bytes: bytes.byteLength, sha256: sha(bytes),
  x0: terrain.x0, z0: terrain.z0, resolution: terrain.resolution, nx: terrain.nx, nz: terrain.nz,
  inputs: { base: { path: values.base, sha256: sha(baseBytes) }, expanded: { path: values.expanded, sha256: sha(expandedBytes) } }, ...audit };
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'terrain.bin'), bytes, { flag: 'wx' });
writeFileSync(path.join(out, 'terrain.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
