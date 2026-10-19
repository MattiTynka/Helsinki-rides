import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { WorldManifest } from '@helsinki/world-schema';
import { loadWorldData, resolveRelease } from '../src/world/loader.ts';
import { basisDecoderUrl, createWorldDeployment, selectedRelease, validateManifestPaths, validatePayloadPath, validateReleaseId, validateWorldBaseUrl, verifyManifestHash, worldReleaseUrl, worldRootUrl } from '../src/world/urls.ts';

const release = 'senate-20261019-08b1f804';
const digest = 'a'.repeat(64);
const local = createWorldDeployment({ appBase: '/', pages: false });
const pages = createWorldDeployment({ appBase: '/Helsinki-rides/', pages: true });
const pinned = createWorldDeployment({ appBase: '/Helsinki-rides/', pages: true, worldBaseUrl: 'https://assets.example.org/world/', release, manifestSha256: digest });

test('development and Pages URLs retain their application base', () => {
  assert.equal(worldRootUrl(local), '/world/');
  assert.equal(worldReleaseUrl(local, release), `/world/${release}/`);
  assert.equal(basisDecoderUrl(local), '/basis/');
  assert.equal(worldRootUrl(pages), '/Helsinki-rides/world/');
  assert.equal(basisDecoderUrl(pages), '/Helsinki-rides/basis/');
  assert.equal(worldReleaseUrl(pinned, release), `https://assets.example.org/world/${release}/`);
  assert.equal(validateWorldBaseUrl('https://assets.example.org/world'), 'https://assets.example.org/world/');
  assert.equal(validateWorldBaseUrl('https://assets.example.org'), 'https://assets.example.org/');
});

test('pinned deployment ignores URL release overrides and refuses mixed content releases', () => {
  assert.equal(selectedRelease(pinned, '../../escape'), release);
  assert.equal(selectedRelease(local, release), release);
  assert.equal(selectedRelease(local, null), null);
  assert.throws(() => selectedRelease(local, '../../escape'), /Invalid world release/);
  assert.throws(() => worldReleaseUrl(pinned, 'another-release'), /pinned world release/);
});

test('publishing requires a complete explicit world pin and valid SHA-256', () => {
  for (const input of [{ worldBaseUrl: 'https://assets.example.org/world/' }, { release }, { manifestSha256: digest }]) {
    assert.throws(() => createWorldDeployment({ appBase: '/Helsinki-rides/', pages: true, ...input }), /together before publishing/);
  }
  assert.throws(() => createWorldDeployment({ appBase: '/Helsinki-rides/', pages: true, requirePinned: true }), /before publishing/);
  assert.throws(() => createWorldDeployment({ appBase: '/Helsinki-rides/', pages: true, worldBaseUrl: 'https://assets.example.org/', release, manifestSha256: 'bad' }), /SHA-256/);
  assert.throws(() => createWorldDeployment({ appBase: '//elsewhere/', pages: true }), /Application base/);
});

test('reject traversal, absolute, encoded and ambiguous manifest payload paths', () => {
  for (const value of ['', '/', '../x', 'a/../x', 'a/./x', '/outside', '//outside/x', 'https://outside/x', 'data:abc', 'a\\x', 'a%2fb', 'a/%2e%2e/x', 'a?x', 'a#x', 'a//x', 'a/']) {
    assert.throws(() => validatePayloadPath(value), /World payload paths/, value);
  }
  for (const value of ['cells/cell_-14_1.collision.abcd.hcol', 'assets/snow.abc.glb', 'terrain.abc.bin']) assert.equal(validatePayloadPath(value), value);
  for (const value of ['../release', '/release', '//outside', 'https:abc', 'release?x', 'release%2fx', 'release.id']) assert.throws(() => validateReleaseId(value), /Invalid world release/);
});

test('cross-origin world roots require a public HTTPS directory with no credentials or escapes', () => {
  for (const value of ['http://assets.example.org/', 'https://localhost/', 'https://127.0.0.1/', 'https://10.1.2.3/', 'https://[::1]/', 'https://bucket.local/', 'https://a.internal/', 'https://user:password@assets.example.org/', 'https://assets.example.org:8443/', 'https://assets.example.org/a/../b/', 'https://assets.example.org/%2e%2e/', 'https://assets.example.org/a?token=secret', 'https://assets.example.org/a#hash', 'https://assets.example.org/a\\b', ' https://assets.example.org/']) {
    assert.throws(() => validateWorldBaseUrl(value), undefined, value);
  }
});

test('manifest integrity is checked against the exact downloaded bytes', async () => {
  const bytes = new TextEncoder().encode('{"manifest":true}\n');
  const expected = createHash('sha256').update(bytes).digest('hex');
  await verifyManifestHash(bytes, expected);
  await verifyManifestHash(bytes, null);
  await assert.rejects(verifyManifestHash(bytes, digest), /integrity check failed/);
});

function manifestFixture(count = 18): WorldManifest {
  const ref = (path: string) => ({ path, bytes: 1, sha256: digest });
  const visual = (path: string) => ({ ...ref(path), triangles: 1, drawCalls: 1, atlases: 0, textureBytesEstimate: 0 });
  return {
    schemaVersion: 2, worldReleaseId: release, status: 'PILOT', builtAt: '2026-10-19T00:00:00.000Z',
    coordinateFrame: { crs: 'EPSG:3879', heightDatum: 'N2000', runtimeAxes: 'X-east,Y-up,Z-south', units: 'meter' },
    origin: { id: 'test', originProjected: [0, 0, 0] }, cellSize: 128, boundsRuntimeXZ: [0, 0, 128, 128],
    cells: Array.from({ length: count }, (_, i) => ({
      id: `cell_${i}`, cx: i, cz: 0, boundsXZ: [i * 128, 0, (i + 1) * 128, 128],
      collision: { ...ref(`cells/cell_${i}.hcol`), triangles: 1 },
      visual: { lod0: visual(`cells/cell_${i}.glb`), lod1: visual(`cells/cell_${i}.lod1.glb`), lod2: visual(`cells/cell_${i}.lod2.glb`) },
      buildingIds: [], buildings: [], sourceTiles: [],
    })),
    terrain: { ...ref('terrain.bin'), x0: 0, z0: 0, resolution: 1, nx: 2, nz: 2 },
    roads: ref('roads.json'), gameplay: ref('gameplay.json'), assets: [{ ...ref('assets/hero.glb'), id: 'hero', kind: 'character' }],
    simulation: { engine: 'test', version: '1', tickHz: 60 },
    sources: [{ id: 'test', title: 'test', url: 'https://example.org/', license: 'test', attribution: 'test' }],
    attribution: ['test'], lighting: 'lit-facades',
  };
}

test('validate every deferred visual and hero path before any payload loads', () => {
  const good = manifestFixture(1);
  validateManifestPaths(good);
  const clone = (): WorldManifest => structuredClone(good);
  const badHero = clone(); Object.assign(badHero.assets[0]!, { path: '//outside/hero.glb' });
  const badDistant = clone(); Object.assign(badDistant.cells[0]!.visual.lod2!, { path: '../outside.glb' });
  const badCollision = clone(); Object.assign(badCollision.cells[0]!.collision, { path: 'https://outside/collision.hcol' });
  const badScenery = { ...clone(), scenery: { path: 'a%2fb', bytes: 1, sha256: digest } };
  for (const bad of [badHero, badDistant, badCollision, badScenery]) assert.throws(() => validateManifestPaths(bad), /World payload paths/);
});

test('release resolution preserves the current pointer in dev and refuses unconfigured Pages before networking', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async input => { urls.push(String(input)); return Response.json({ release }); }) as typeof fetch;
  try {
    assert.equal(await resolveRelease(null, local), release);
    assert.deepEqual(urls, ['/world/current.json']);
    assert.equal(await resolveRelease('../../ignored', pinned), release);
    await assert.rejects(resolveRelease(null, pages), /City assets are not configured/);
    assert.equal(urls.length, 1);
  } finally { globalThis.fetch = original; }
});

test('startup limits collision requests to six and returns manifest order after out-of-order downloads', async () => {
  const manifest = manifestFixture();
  const gameplay = {
    schemaVersion: 2, player: { spawn: { position: [0, 0] } }, playArea: { minX: 0, maxX: 128, minZ: 0, maxZ: 128 },
    vehicleDefinitions: [], vehicles: [], anchors: [{ kind: 'hospital', destinationName: 'hospital' }, { kind: 'police', destinationName: 'police' }],
    weapons: [{ id: 'pistol' }], wanted: { starThresholds: [1, 2, 3, 4, 5], unitCaps: [1, 2, 3, 4, 5] },
    police: { patrolSpawns: [{ position: [0, 0] }, { position: [1, 1] }] },
  };
  let active = 0, peak = 0;
  const completed: number[] = [];
  const ticks: number[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async input => {
    const url = String(input);
    if (url.endsWith('manifest.json')) return Response.json(manifest);
    if (url.endsWith('gameplay.json')) return Response.json(gameplay);
    if (url.endsWith('roads.json')) return Response.json({ lanes: [] });
    const match = /cell_(\d+)\.hcol$/.exec(url);
    if (!match) return new Response(new Uint8Array([0]));
    const index = Number(match[1]);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, (6 - index % 6) * 3));
    active--; completed.push(index);
    return new Response(new Uint8Array([index]));
  }) as typeof fetch;
  try {
    const data = await loadWorldData(release, done => ticks.push(done), local);
    assert.equal(peak, 6);
    assert.equal(active, 0);
    assert.equal(completed.length, 18);
    assert.notDeepEqual(completed, Array.from({ length: 18 }, (_, i) => i));
    assert.deepEqual([...data.collision.keys()], manifest.cells.map(cell => cell.id));
    assert.deepEqual([...data.collision.values()].map(bytes => bytes[0]), Array.from({ length: 18 }, (_, i) => i));
    assert.equal(ticks.at(-1), 21);
  } finally { globalThis.fetch = original; }
});

test('a pinned manifest mismatch stops startup before referenced files are requested', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json(manifestFixture()); }) as typeof fetch;
  try {
    await assert.rejects(loadWorldData(release, () => {}, pinned), /integrity check failed/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});
