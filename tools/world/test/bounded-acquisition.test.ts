import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {acquireGeography, permittedAcquisitionUrl, validateAcquisitionJob, validateWfsResponse, missingOsmReferences, retryAcquisitionFileOperation, wfsFeatureIdentity, nextOsmClosureTarget} from '../lib/bounded-acquisition.ts';
import type {AcquisitionJob, AcquisitionSource} from '../lib/acquisition-job.ts';
import {sourceSha256} from '../lib/source-files.ts';

const source: AcquisitionSource = {id: 'fixture', title: 'Fixture source', url: 'https://kartta.hel.fi/3d/', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Fixture', crs: 'EPSG:3879', heightDatum: 'N2000', units: 'meter', axisOrder: 'E,N,H'};
const bboxEN: [number, number, number, number] = [25495000, 6672000, 25495100, 6672100];
const tileUrl = 'https://kartta.hel.fi/3d/datasource-data/fixture/tile.glb';
const job = (): AcquisitionJob => ({schemaVersion: 1, snapshot: 'fixture', bboxEN, budgetBytes: 1024 * 1024, maxPayloadBytes: 1024, retries: 0,
  layers: [{id: 'lod2', kind: 'tiles', source, vintage: 'fixture-v1', indexMetadata: {tileset: 'https://kartta.hel.fi/3d/datasource-data/fixture/tileset.json', tilesetVersion: 'v1'}, tiles: [{file: 'tile.glb', url: tileUrl}]}]});
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-acquisition-'));
const request = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;

test('Windows file-lock replacement retries are bounded and preserve non-lock errors', () => {
  let attempts = 0; const waits: number[] = [];
  retryAcquisitionFileOperation(() => {if (++attempts < 4) throw Object.assign(new Error('locked'), {code: attempts === 1 ? 'EPERM' : 'EBUSY'});}, wait => waits.push(wait));
  assert.equal(attempts, 4); assert.deepEqual(waits, [10, 20, 40]);
  attempts = 0; assert.throws(() => retryAcquisitionFileOperation(() => {attempts++; throw Object.assign(new Error('disk full'), {code: 'ENOSPC'});}, () => assert.fail('Unexpected wait')), /disk full/); assert.equal(attempts, 1);
  attempts = 0; assert.throws(() => retryAcquisitionFileOperation(() => {attempts++; throw Object.assign(new Error('locked forever'), {code: 'EPERM'});}, () => {}), /locked forever/); assert.equal(attempts, 9);
});

test('fixed URL allowlist rejects redirects, credentials, private hosts and encoded traversal', () => {
  assert.equal(permittedAcquisitionUrl(tileUrl), tileUrl);
  for (const url of ['http://kartta.hel.fi/3d/datasource-data/x', 'https://127.0.0.1/x', 'https://kartta.hel.fi:444/3d/datasource-data/x',
    tileUrl.replace('//', '//' + ['user', 'secret'].join(':') + '@'), 'https://kartta.hel.fi.evil.test/3d/datasource-data/x',
    'https://kartta.hel.fi/3d/datasource-data/x%2fy', 'https://api.openstreetmap.org/api/0.6/changesets.json']) assert.throws(() => permittedAcquisitionUrl(url));
});

test('fresh acquisition, exact resume, source drift and job binding', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true})); let calls = 0;
  const fetcher = request((_url, init) => {calls++; assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); return new Response('glTFfixture');});
  const first = await acquireGeography({job: job(), out, fetcher}); assert.equal(first.payloads, 1); assert.equal(first.chargedNetworkBytes, 11);
  const ledger = JSON.parse(fs.readFileSync(path.join(out, 'lod2/ledger.json'), 'utf8')); assert.equal(ledger.snapshots.fixture.tilesetVersion, 'v1');
  assert.equal(ledger.snapshots.fixture.path, 'fixture/tiles.json');
  assert.deepEqual(await acquireGeography({job: job(), out, resume: true, fetcher}), first); assert.equal(calls, 1);
  await assert.rejects(() => acquireGeography({job: job(), out, fetcher}), /explicit --resume/);
  const changed = job(); changed.budgetBytes++; await assert.rejects(() => acquireGeography({job: changed, out, resume: true, fetcher}), /Resume job differs/);
  fs.writeFileSync(path.join(out, 'lod2/fixture/tile.glb'), 'glTFchanged');
  await assert.rejects(() => acquireGeography({job: job(), out, resume: true, fetcher}), /SHA-256/);
});

test('verified cross-volume-compatible cache reuse spends no network bytes', async t => {
  const root = temporary(), cacheRoot = path.join(root, 'cache'), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true})); fs.mkdirSync(cacheRoot);
  const bytes = Buffer.from('glTFcache'); fs.writeFileSync(path.join(cacheRoot, 'tile.glb'), bytes); const selection = job();
  assert.equal(selection.layers[0]!.kind, 'tiles'); if (selection.layers[0]!.kind !== 'tiles') throw new Error();
  selection.layers[0]!.tiles[0]!.cache = {root: cacheRoot, path: 'tile.glb', bytes: bytes.length, sha256: sourceSha256(bytes)};
  const result = await acquireGeography({job: selection, out, fetcher: request(() => {throw new Error('Unexpected network');})});
  assert.equal(result.chargedNetworkBytes, 0); assert.equal(result.downloadedPayloads, 0);
  fs.writeFileSync(path.join(out, 'lod2/fixture/tile.glb'), 'changed'); assert.deepEqual(fs.readFileSync(path.join(cacheRoot, 'tile.glb')), bytes, 'Output must not mutate cached source through hardlinks');
});

test('post-download journal failure retains its reservation and never refunds twice', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const originalRename = fs.renameSync; let injected = false, calls = 0;
  const replacement = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (!injected && String(from).endsWith('acquisition-progress.next.json')) {
      const next = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (next.chargedNetworkBytes === 11 && next.payloads.length === 0) {injected = true; throw Object.assign(new Error('injected settlement write failure'), {code: 'EIO'});}
    }
    return originalRename(from, to);
  });
  const fetcher = request(() => {calls++; return new Response('glTFfixture');});
  await assert.rejects(() => acquireGeography({job: job(), out, fetcher}), /injected settlement write failure/);
  replacement.mock.restore(); assert.equal(injected, true); assert.equal(calls, 1);
  const committed = JSON.parse(fs.readFileSync(path.join(out, 'acquisition-progress.json'), 'utf8'));
  assert.equal(committed.chargedNetworkBytes, 1024); assert.equal(committed.payloads.length, 0);
  const result = await acquireGeography({job: job(), out, resume: true, fetcher});
  assert.equal(calls, 2); assert.equal(result.chargedNetworkBytes, 1035, 'Uncertain prior reservation stays charged across resume');
});

test('body and whole-job network caps survive a resumable partial failure', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const selection = job(); selection.budgetBytes = 12; selection.maxPayloadBytes = 8;
  await assert.rejects(() => acquireGeography({job: selection, out, fetcher: request(() => new Response('glTF123456789'))}), /byte cap/);
  const progress = JSON.parse(fs.readFileSync(path.join(out, 'acquisition-progress.json'), 'utf8')); assert.equal(progress.chargedNetworkBytes, 13); assert.equal(progress.payloads.length, 0);
  await assert.rejects(() => acquireGeography({job: selection, out, resume: true, fetcher: request(() => assert.fail('Exhausted journal must reject before network'))}), /budget exhausted/);
  const final = JSON.parse(fs.readFileSync(path.join(out, 'acquisition-progress.json'), 'utf8')); assert.equal(final.chargedNetworkBytes, 13);
  let called = false; await assert.rejects(() => acquireGeography({job: selection, out, resume: true, fetcher: request(() => {called = true; return new Response('x');})}), /budget exhausted/); assert.equal(called, false);
});

test('a crash reservation remains charged on resume and unknown fields fail closed', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true})); const selection = job();
  await assert.rejects(() => acquireGeography({job: selection, out, fetcher: request(() => new Response('no', {status: 404}))}), /HTTP 404/);
  const progressPath = path.join(out, 'acquisition-progress.json'), progress = JSON.parse(fs.readFileSync(progressPath, 'utf8')); progress.chargedNetworkBytes = selection.budgetBytes; fs.writeFileSync(progressPath, JSON.stringify(progress));
  await assert.rejects(() => acquireGeography({job: selection, out, resume: true, fetcher: request(() => new Response('glTF'))}), /budget exhausted/);
  assert.throws(() => validateAcquisitionJob({...selection, arbitraryEndpoint: 'https://evil.test'}), /unexpected fields/);
});

test('tile concurrency is bounded and a failed worker settles all started writes before resume', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const selection = job(); selection.concurrency = 3; const layer = selection.layers[0]!; if (layer.kind !== 'tiles') throw new Error();
  layer.tiles = Array.from({length: 7}, (_, i) => ({file: `tile${i}.glb`, url: tileUrl.replace('tile.glb', `tile${i}.glb`), bytes: 8}));
  let active = 0, maximum = 0, shouldFail = true; const calls = new Map<string, number>();
  const fetcher = request(async url => {
    calls.set(url, (calls.get(url) ?? 0) + 1); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, url.endsWith('tile1.glb') ? 5 : 15)); active--;
    return shouldFail && url.endsWith('tile1.glb') ? new Response('not available', {status: 404}) : new Response('glTF1234');
  });
  await assert.rejects(() => acquireGeography({job: selection, out, fetcher}), /HTTP 404/);
  assert.equal(active, 0); assert.equal(maximum, 3);
  const progress = JSON.parse(fs.readFileSync(path.join(out, 'acquisition-progress.json'), 'utf8')); assert.equal(progress.payloads.length, 2);
  assert.equal(progress.chargedNetworkBytes, 16); shouldFail = false;
  const result = await acquireGeography({job: selection, out, resume: true, fetcher}); assert.equal(result.payloads, 7); assert.equal(result.chargedNetworkBytes, 56);
  assert.equal(calls.get(layer.tiles[0]!.url), 1); assert.equal(calls.get(layer.tiles[2]!.url), 1); assert.equal(calls.get(layer.tiles[1]!.url), 2);
  assert.ok(maximum <= 3);
});

test('concurrent reservations wait for settlement instead of falsely exhausting an otherwise adequate budget', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const selection = job(); selection.concurrency = 3; selection.maxPayloadBytes = 16; selection.budgetBytes = 24;
  const layer = selection.layers[0]!; if (layer.kind !== 'tiles') throw new Error(); layer.tiles = [0, 1, 2].map(i => ({file: `tile${i}.glb`, url: tileUrl.replace('tile.glb', `tile${i}.glb`)}));
  const result = await acquireGeography({job: selection, out, fetcher: request(async () => {await new Promise(resolve => setTimeout(resolve, 5)); return new Response('glTF1234');})});
  assert.equal(result.chargedNetworkBytes, 24); assert.equal(result.payloads, 3);
});

const feature = (height: number) => ({type: 'Feature', properties: {vtj_prt: 'building', height}, geometry: {type: 'Polygon', coordinates: [[[25495000, 6672000], [25495001, 6672000], [25495000, 6672001], [25495000, 6672000]]]}});
const collection = (features: unknown[]) => ({type: 'FeatureCollection', crs: {type: 'name', properties: {name: 'urn:ogc:def:crs:EPSG::3879'}}, features});
test('WFS truncation, unknown counts and axis-order drift are rejected', () => {
  validateWfsResponse(collection([feature(1)]), 5);
  assert.throws(() => validateWfsResponse(collection([feature(1)]), 1), /truncated/);
  assert.throws(() => validateWfsResponse({...collection([feature(1)]), numberMatched: 2}, 5), /Incomplete/);
  assert.throws(() => validateWfsResponse({...collection([]), totalFeatures: 'unknown'}, 5), /Incomplete/);
  const invalid = feature(1); invalid.geometry.coordinates[0]![0] = [24.9, 60.1]; assert.throws(() => validateWfsResponse(collection([invalid]), 5), /axis order/);
  validateWfsResponse({...collection([]), crs: null, totalFeatures: 0, numberMatched: 0, numberReturned: 0}, 5);
  assert.throws(() => validateWfsResponse({...collection([feature(1)]), crs: null}, 5), /CRS drift/);
  assert.throws(() => validateWfsResponse({...collection([]), crs: {properties: {name: 'EPSG:4326'}}}, 5), /CRS drift/);
});

test('accepted WFS features are retained and conflicting observations become witnesses', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const old = Buffer.from(JSON.stringify(collection([feature(1)]))); fs.writeFileSync(path.join(root, 'old.geojson'), old);
  const selection = job(); selection.maxPayloadBytes = 4096; selection.layers = [{id: 'buildings', kind: 'wfs', source, vintage: 'today', typeName: 'avoindata:Rakennukset_alue_rekisteritiedot', stableKey: 'vtj_prt', maxFeatures: 5000,
    partitions: [{id: 'one', bboxEN}], accepted: {root, path: 'old.geojson', bytes: old.length, sha256: sourceSha256(old)}}];
  await acquireGeography({job: selection, out, fetcher: request(() => Response.json(collection([feature(2)])))});
  const output = JSON.parse(fs.readFileSync(path.join(out, 'buildings/fixture.geojson'), 'utf8')); assert.deepEqual(output.features, [feature(1)]);
  const conflicts = JSON.parse(fs.readFileSync(path.join(out, 'buildings/conflicts.json'), 'utf8')); assert.equal(conflicts.conflicts.length, 1); assert.equal(conflicts.conflicts[0].policy, 'ACCEPTED_FEATURE_RETAINED');
});

test('missing VTJ uses explicit source feature or geometry identity without changing the original', () => {
  const f = {...feature(1), id: 'Rakennukset_alue_rekisteritiedot.1212', properties: {vtj_prt: null}};
  const original = structuredClone(f); assert.deepEqual(wfsFeatureIdentity(f, 'vtj_prt'), {key: 'feature:Rakennukset_alue_rekisteritiedot.1212', strategy: 'feature-id'}); assert.deepEqual(f, original);
  const geometryOnly = {geometry: f.geometry, properties: {vtj_prt: ''}};
  assert.deepEqual(wfsFeatureIdentity(geometryOnly, 'vtj_prt'), {key: 'geometry:' + sourceSha256(JSON.stringify(f.geometry)), strategy: 'geometry-sha256'});
});

test('accepted multiple polygons sharing a stable key remain an exact ordered prefix', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const before = [feature(1), feature(2)], old = Buffer.from(JSON.stringify(collection(before))); fs.writeFileSync(path.join(root, 'old.geojson'), old);
  const selection = job(); selection.maxPayloadBytes = 4096; selection.layers = [{id: 'buildings', kind: 'wfs', source, vintage: 'today', typeName: 'avoindata:Rakennukset_alue_rekisteritiedot', stableKey: 'vtj_prt', maxFeatures: 5000,
    partitions: [{id: 'one', bboxEN}], accepted: {root, path: 'old.geojson', bytes: old.length, sha256: sourceSha256(old)}}];
  await acquireGeography({job: selection, out, fetcher: request(() => Response.json(collection([feature(2)])))});
  const output = JSON.parse(fs.readFileSync(path.join(out, 'buildings/fixture.geojson'), 'utf8')); assert.deepEqual(output.features, before);
  const conflicts = JSON.parse(fs.readFileSync(path.join(out, 'buildings/conflicts.json'), 'utf8')); assert.equal(conflicts.conflicts.length, 0);
});

const osm = (elements: unknown[]) => ({version: '0.6', license: 'https://opendatacommons.org/licenses/odbl/1-0/', elements});
test('OSM closure includes nested relation members and way nodes, with a hard request limit', async t => {
  const root = temporary(); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const elements = [{type: 'relation', id: 10, members: [{type: 'way', ref: 20, role: 'outer'}]}];
  assert.deepEqual(missingOsmReferences(elements), ['way/20']);
  const selection = job(); selection.maxPayloadBytes = 4096; selection.layers = [{id: 'osm', kind: 'osm', source: {...source, license: 'ODbL 1.0'}, vintage: 'today', partitions: [{id: 'one', bboxEN}], maxClosureRequests: 1}];
  const fetcher = request(url => url.includes('map.json') ? Response.json(osm(elements)) : Response.json(osm([{type: 'way', id: 20, nodes: [30, 31]}, {type: 'node', id: 30, lat: 60.1, lon: 24.9}, {type: 'node', id: 31, lat: 60.1, lon: 24.91}])));
  await acquireGeography({job: selection, out: path.join(root, 'complete'), fetcher});
  const output = JSON.parse(fs.readFileSync(path.join(root, 'complete/osm/fixture.json'), 'utf8')); assert.equal(output.elements.length, 4); assert.deepEqual(missingOsmReferences(output.elements), []);
  if (selection.layers[0]!.kind !== 'osm') throw new Error(); selection.layers[0]!.maxClosureRequests = 0;
  await assert.rejects(() => acquireGeography({job: selection, out: path.join(root, 'incomplete'), fetcher}), /closure incomplete/);
  assert.equal(fs.existsSync(path.join(root, 'incomplete/acquisition-report.json')), false);
});

test('OSM closure prefers full relation/way responses before individual member nodes', () => {
  const relation = {type: 'relation', id: 1, members: [{type: 'way', ref: 2}, {type: 'node', ref: 3}]};
  assert.equal(nextOsmClosureTarget([relation], new Set()), 'relation/1');
  assert.equal(nextOsmClosureTarget([relation], new Set(['relation/1'])), 'way/2');
  const way = {type: 'way', id: 2, nodes: [3, 4]}; assert.equal(nextOsmClosureTarget([way], new Set()), 'way/2');
});

test('OSM closure target budget persists across resume and explicit consumer review adds only its bound supplement', async t => {
  const root = temporary(), out = path.join(root, 'out'); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const route = {type: 'relation', id: 10, tags: {type: 'route'}, members: [{type: 'node', ref: 100, role: ''}, {type: 'node', ref: 101, role: ''}]};
  const restriction = {type: 'relation', id: 20, tags: {type: 'restriction'}, members: [{type: 'way', ref: 300, role: 'from'}]};
  const selection = job(); selection.maxPayloadBytes = 4096; selection.layers = [{id: 'osm', kind: 'osm', source: {...source, license: 'ODbL 1.0'}, vintage: 'today', partitions: [{id: 'one', bboxEN}], maxClosureRequests: 1}];
  const calls: string[] = [], fetcher = request(url => {
    calls.push(url);
    if (url.includes('map.json')) return Response.json(osm([route, restriction]));
    if (url.includes('relation/10/')) return Response.json(osm([route, {type: 'node', id: 100, lat: 60.1, lon: 24.9}]));
    if (url.includes('relation/20/')) return Response.json(osm([restriction, {type: 'way', id: 300, nodes: [1, 2]}, {type: 'node', id: 1, lat: 60.1, lon: 24.9}, {type: 'node', id: 2, lat: 60.1, lon: 24.91}]));
    throw new Error('Unexpected closure target');
  });
  await assert.rejects(() => acquireGeography({job: selection, out, fetcher}), /closure incomplete/); assert.equal(calls.length, 2);
  await assert.rejects(() => acquireGeography({job: selection, out, resume: true, fetcher}), /closure incomplete/); assert.equal(calls.length, 2, 'Resume may not spend a fresh original request budget');
  const progress = fs.readFileSync(path.join(out, 'acquisition-progress.json')), consumer = path.join(root, 'consumer.ts'); fs.writeFileSync(consumer, '// bounded native consumer fixture');
  const review = {schemaVersion: 1, kind: 'reviewed-osm-consumer-closure', sourceJobSha256: sourceSha256(JSON.stringify(selection)), baseProgressSha256: sourceSha256(progress), layer: 'osm', maxAdditionalClosureRequests: 1,
    consumers: [{file: consumer, sha256: sourceSha256(fs.readFileSync(consumer))}], excludedRelations: [{id: 10, type: 'route', sourceSha256: sourceSha256(JSON.stringify(route)), reason: 'Global transit aggregation is not consumed by the geometry fixture; raw response retained'}]};
  await acquireGeography({job: selection, out, resume: true, fetcher, osmReview: review}); assert.equal(calls.length, 3);
  const ledger = JSON.parse(fs.readFileSync(path.join(out, 'osm/ledger.json'), 'utf8')); assert.equal(ledger.snapshots.fixture.closureRequests, 2); assert.equal(ledger.snapshots.fixture.originalMaxClosureRequests, 1); assert.equal(ledger.snapshots.fixture.supplementalMaxClosureRequests, 1);
  assert.equal(ledger.snapshots.fixture.closureScope, 'reviewed-native-consumers-not-global-osm'); assert.deepEqual(ledger.snapshots.fixture.excludedRelations, [10]);
  assert.ok(fs.existsSync(path.join(out, 'osm/parts/one.json')));
  await assert.rejects(() => acquireGeography({job: selection, out, resume: true, fetcher}), /bound OSM consumer review/);
  await acquireGeography({job: selection, out, resume: true, fetcher, osmReview: review}); assert.equal(calls.length, 3);
});
