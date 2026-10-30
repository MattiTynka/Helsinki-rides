import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {gk25ToGeodetic} from '../../../packages/world-schema/src/index.ts';
import {readSourceFile, sourceFile, sourceSha256} from './source-files.ts';
import type {AcquisitionJob, AcquisitionLayer, AcquisitionPartition, AcquisitionSource, CachedSource, SelectedPayload, ProjectedBounds, OsmClosureReview} from './acquisition-job.ts';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const OSM = 'https://api.openstreetmap.org/api/0.6/';
const WFS = 'https://kartta.hel.fi/ws/geoserver/avoindata/wfs';

/** Redirects are forbidden too: a trusted starting URL may not redirect into an untrusted network. */
export function permittedAcquisitionUrl(value: string): string {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443'), 'Unsafe acquisition URL');
  const municipal = url.hostname === 'kartta.hel.fi' && (url.pathname.startsWith('/3d/datasource-data/') || url.pathname === '/ws/geoserver/avoindata/wfs');
  const osm = url.hostname === 'api.openstreetmap.org' && /^\/api\/0\.6\/(?:map\.json|(?:node\/\d+|(?:way|relation)\/\d+\/full)\.json)$/.test(url.pathname);
  assert.ok(municipal || osm, 'Outside fixed municipal/OSM source allowlist');
  assert.ok(!/%(?:2e|2f|5c)/i.test(url.pathname), 'Encoded path separators are forbidden');
  return url.href;
}

function exactKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.ok(Object.keys(value).every(key => allowed.includes(key)), `${label} has unexpected fields`);
}
function boundedInteger(value: unknown, min: number, max: number, label: string) {
  assert.ok(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, `${label} outside bounds`);
}
function text(value: unknown, label: string) {assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 2048, `${label} is required`);}
function bounds(value: unknown): asserts value is ProjectedBounds {
  assert.ok(Array.isArray(value) && value.length === 4 && value.every(Number.isFinite), 'Invalid projected bbox');
  const [x0, y0, x1, y1] = value as number[];
  assert.ok(x0! >= 25400000 && x1! <= 25600000 && y0! >= 6600000 && y1! <= 6800000 && x0! < x1! && y0! < y1!, 'Expected bounded Helsinki EPSG:3879 axis order');
  assert.ok((x1! - x0!) * (y1! - y0!) <= 100_000_000, 'Acquisition bbox exceeds 100 square kilometres');
}
function source(value: unknown): asserts value is AcquisitionSource {
  const keys = ['id', 'title', 'url', 'license', 'licenseUrl', 'attribution', 'crs', 'heightDatum', 'units', 'axisOrder'];
  exactKeys(value, keys, 'source'); for (const key of keys) text(value[key], `source.${key}`);
  for (const key of ['url', 'licenseUrl']) assert.equal(new URL(String(value[key])).protocol, 'https:', 'Source provenance URL must be HTTPS');
}
function cache(value: unknown): asserts value is CachedSource {
  exactKeys(value, ['root', 'path', 'bytes', 'sha256'], 'cache'); text(value.root, 'cache.root'); text(value.path, 'cache.path');
  boundedInteger(value.bytes, 1, 1024 ** 3, 'cache bytes'); assert.match(String(value.sha256), SHA);
}
function payload(value: unknown): asserts value is SelectedPayload {
  exactKeys(value, ['file', 'url', 'bytes', 'sha256', 'cache', 'transform', 'geometricError', 'z', 'x', 'y'], 'payload');
  text(value.file, 'payload.file'); assert.ok(String(value.file).split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)), 'Unsafe selected payload filename');
  text(value.url, 'payload.url'); permittedAcquisitionUrl(String(value.url));
  if (value.bytes !== undefined) boundedInteger(value.bytes, 1, 1024 ** 3, 'payload bytes');
  if (value.sha256 !== undefined) assert.match(String(value.sha256), SHA);
  if (value.cache !== undefined) cache(value.cache);
  if (value.transform !== undefined) assert.ok(Array.isArray(value.transform) && value.transform.length === 16 && value.transform.every(Number.isFinite), 'Invalid tile transform');
  if (value.geometricError !== undefined) assert.ok(typeof value.geometricError === 'number' && Number.isFinite(value.geometricError) && value.geometricError >= 0);
  for (const key of ['z', 'x', 'y']) if (value[key] !== undefined) boundedInteger(value[key], 0, 2 ** 30, 'tile coordinate');
}
function partitions(values: unknown, bbox: ProjectedBounds): asserts values is AcquisitionPartition[] {
  assert.ok(Array.isArray(values) && values.length > 0 && values.length <= 256, 'Bounded source partitions required');
  const ids = new Set<string>();
  for (const entry of values) {
    exactKeys(entry, ['id', 'bboxEN'], 'partition'); assert.match(String(entry.id), NAME); assert.ok(!ids.has(String(entry.id))); ids.add(String(entry.id)); bounds(entry.bboxEN);
    const b = entry.bboxEN; assert.ok(b[0] >= bbox[0] && b[1] >= bbox[1] && b[2] <= bbox[2] && b[3] <= bbox[3], 'Partition outside job acquisition bbox');
  }
}

export function validateAcquisitionJob(value: unknown): AcquisitionJob {
  exactKeys(value, ['schemaVersion', 'snapshot', 'bboxEN', 'budgetBytes', 'maxPayloadBytes', 'timeoutMs', 'retries', 'concurrency', 'layers'], 'job');
  assert.equal(value.schemaVersion, 1); assert.match(String(value.snapshot), NAME); bounds(value.bboxEN);
  boundedInteger(value.budgetBytes, 1, 5 * 1024 ** 3, 'network budget'); boundedInteger(value.maxPayloadBytes, 1, 1024 ** 3, 'payload cap');
  assert.ok(Number(value.maxPayloadBytes) <= Number(value.budgetBytes));
  if (value.timeoutMs !== undefined) boundedInteger(value.timeoutMs, 100, 120000, 'timeout');
  if (value.retries !== undefined) boundedInteger(value.retries, 0, 3, 'retries');
  if (value.concurrency !== undefined) boundedInteger(value.concurrency, 1, 5, 'concurrency');
  assert.ok(Array.isArray(value.layers) && value.layers.length > 0 && value.layers.length <= 32);
  const ids = new Set<string>();
  for (const layer of value.layers) {
    const common = ['id', 'kind', 'source', 'vintage'];
    assert.ok(layer && typeof layer === 'object'); assert.match(String(layer.id), NAME); assert.ok(!ids.has(layer.id), 'Duplicate layer ID'); ids.add(layer.id);
    source(layer.source); text(layer.vintage, 'source vintage');
    if (layer.kind === 'tiles') {
      exactKeys(layer, [...common, 'indexMetadata', 'tiles', 'metadata'], 'tile layer');
      assert.ok(layer.indexMetadata && typeof layer.indexMetadata === 'object' && !Array.isArray(layer.indexMetadata));
      const reserved = ['schemaVersion', 'tiles', 'bboxEN']; assert.ok(!Object.keys(layer.indexMetadata).some(key => reserved.includes(key)), 'Reserved index metadata fields');
      assert.ok(Array.isArray(layer.tiles) && layer.tiles.length > 0 && layer.tiles.length <= 20000);
      assert.ok(layer.metadata === undefined || Array.isArray(layer.metadata) && layer.metadata.length <= 1000);
      const names = new Set(['tiles.json']);
      for (const selected of [...layer.tiles, ...(layer.metadata as SelectedPayload[] | undefined ?? [])]) {
        payload(selected); assert.ok(!names.has(selected.file), 'Duplicate selected filename'); names.add(selected.file);
        if (selected.bytes !== undefined) assert.ok(selected.bytes <= Number(value.maxPayloadBytes), 'Selected payload exceeds cap');
      }
    } else if (layer.kind === 'wfs') {
      exactKeys(layer, [...common, 'typeName', 'stableKey', 'maxFeatures', 'partitions', 'accepted'], 'WFS layer');
      assert.ok(['avoindata:Rakennukset_alue_rekisteritiedot', 'avoindata:YLRE_Katu_ja_viherosat_kaikki_alue'].includes(String(layer.typeName)), 'WFS type is not approved');
      assert.match(String(layer.stableKey), /^[A-Za-z_][A-Za-z0-9_]{0,79}$/); boundedInteger(layer.maxFeatures, 1, 5000, 'WFS feature cap');
      partitions(layer.partitions, value.bboxEN); if (layer.accepted !== undefined) cache(layer.accepted);
    } else if (layer.kind === 'osm') {
      exactKeys(layer, [...common, 'partitions', 'maxClosureRequests', 'accepted'], 'OSM layer');
      partitions(layer.partitions, value.bboxEN); boundedInteger(layer.maxClosureRequests, 0, 1000, 'OSM closure request cap');
      if (layer.accepted !== undefined) cache(layer.accepted);
    } else throw new Error('Unknown acquisition layer kind');
  }
  return value as unknown as AcquisitionJob;
}

interface AcquiredPayload {path: string; url: string; bytes: number; sha256: string; retrievedAt: string; reused?: CachedSource}
interface Progress {schemaVersion: 1; jobSha256: string; chargedNetworkBytes: number; payloads: AcquiredPayload[]; complete: boolean;
  closureTargets?: Record<string, string[]>; osmReview?: {sha256: string; layer: string; additionalClosureRequests: number; history: string[]}}
type Fetcher = typeof fetch;

/** Antivirus/indexer readers can briefly deny Windows atomic replacement. Keep the old journal intact. */
export function retryAcquisitionFileOperation(operation: () => void, wait: (milliseconds: number) => void = milliseconds => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}): void {
  for (let attempt = 0; ; attempt++) {
    try {operation(); return;} catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || attempt >= 8) throw error;
      wait(Math.min(10 * 2 ** attempt, 250));
    }
  }
}

class AcquisitionStore {
  readonly root: string; readonly job: AcquisitionJob; readonly progress: Progress; readonly fetcher: Fetcher;
  readonly openedProgressSha256: string;
  private activeReservations = 0;
  private reservationWaiters: (() => void)[] = [];
  constructor(root: string, job: AcquisitionJob, jobSha256: string, resume: boolean, fetcher: Fetcher) {
    this.root = path.resolve(root); this.job = job; this.fetcher = fetcher;
    if (fs.existsSync(this.root)) {
      assert.ok(resume, 'Acquisition destination exists; explicit --resume required');
      const bytes = fs.readFileSync(sourceFile(this.root, 'acquisition-progress.json')); this.openedProgressSha256 = sourceSha256(bytes);
      this.progress = JSON.parse(bytes.toString('utf8'));
      assert.equal(this.progress.schemaVersion, 1); assert.equal(this.progress.jobSha256, jobSha256, 'Resume job differs');
      boundedInteger(this.progress.chargedNetworkBytes, 0, Number.MAX_SAFE_INTEGER, 'resumed network bytes');
      assert.ok(this.progress.chargedNetworkBytes <= job.budgetBytes, 'Total acquisition network budget exhausted by observed response bytes');
      assert.ok(Array.isArray(this.progress.payloads));
      for (const ref of this.progress.payloads) {permittedAcquisitionUrl(ref.url); readSourceFile(this.root, ref);}
    } else {
      assert.ok(!resume, 'Cannot resume missing acquisition directory'); fs.mkdirSync(this.root, {recursive: true});
      this.progress = {schemaVersion: 1, jobSha256, chargedNetworkBytes: 0, payloads: [], complete: false}; this.save();
      this.openedProgressSha256 = sourceSha256(fs.readFileSync(sourceFile(this.root, 'acquisition-progress.json')));
      this.json('acquisition-job.json', job);
    }
  }
  save() {
    const temporary = sourceFile(this.root, 'acquisition-progress.next.json'), target = sourceFile(this.root, 'acquisition-progress.json');
    // Recovery from a killed write leaves a conservative reservation in the committed progress file.
    const bytes = JSON.stringify(this.progress, null, 2) + '\n';
    retryAcquisitionFileOperation(() => fs.writeFileSync(temporary, bytes));
    retryAcquisitionFileOperation(() => fs.renameSync(temporary, target));
  }
  json(relative: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), file = sourceFile(this.root, relative);
    if (fs.existsSync(file)) assert.deepEqual(fs.readFileSync(file), bytes, 'Derived output drift: ' + relative);
    else {fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes, {flag: 'wx'});}
    return {path: relative, bytes: bytes.length, sha256: sourceSha256(bytes)};
  }
  async payload(relative: string, selection: Pick<SelectedPayload, 'url' | 'bytes' | 'sha256' | 'cache'>): Promise<AcquiredPayload> {
    const url = permittedAcquisitionUrl(selection.url), old = this.progress.payloads.find(ref => ref.path === relative);
    if (old) {assert.equal(old.url, url); const bytes = readSourceFile(this.root, old); this.expected(bytes, selection); return old;}
    const file = sourceFile(this.root, relative); assert.ok(!fs.existsSync(file), 'Unledgered existing payload: ' + relative);
    let bytes: Buffer;
    if (selection.cache) {bytes = readSourceFile(selection.cache.root, selection.cache); assert.ok(bytes.length <= this.job.maxPayloadBytes, 'Cached payload exceeds cap');}
    else bytes = await this.download(url, selection.bytes);
    this.expected(bytes, selection); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes, {flag: 'wx'});
    const ref = {path: relative, url, bytes: bytes.length, sha256: sourceSha256(bytes), retrievedAt: new Date().toISOString(), ...(selection.cache ? {reused: selection.cache} : {})};
    this.progress.payloads.push(ref); this.save(); return ref;
  }
  expected(bytes: Buffer, selection: Pick<SelectedPayload, 'bytes' | 'sha256'>) {
    if (selection.bytes !== undefined) assert.equal(bytes.length, selection.bytes, 'Selected source size drift');
    if (selection.sha256 !== undefined) assert.equal(sourceSha256(bytes), selection.sha256, 'Selected source digest drift');
  }
  async download(url: string, expectedBytes?: number): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      const desired = expectedBytes ?? this.job.maxPayloadBytes;
      while (this.activeReservations > 0 && this.job.budgetBytes - this.progress.chargedNetworkBytes < desired) await new Promise<void>(resolve => this.reservationWaiters.push(resolve));
      const capacity = Math.min(desired, this.job.budgetBytes - this.progress.chargedNetworkBytes);
      assert.ok(capacity > 0, 'Total acquisition network budget exhausted');
      // Reserve before network I/O. A crash cannot erase bytes already transferred from the next run's budget.
      this.progress.chargedNetworkBytes += capacity; this.save(); this.activeReservations++; let consumed = 0;
      let settlementAttempted = false;
      const settleReservation = () => {
        assert.ok(!settlementAttempted, 'Network reservation settled twice'); settlementAttempted = true;
        // A single received chunk may cross the cap. Abort immediately, but account
        // for every byte already observed, including that final overflow chunk.
        const refund = capacity - consumed;
        this.progress.chargedNetworkBytes -= refund;
        try {this.save();} catch (error) {
          // The committed journal still holds the reservation. Restore it in memory too,
          // so another concurrent worker cannot persist a second refund after this failure.
          this.progress.chargedNetworkBytes += Math.max(0, refund);
          throw error;
        }
      };
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error('Acquisition timeout')), this.job.timeoutMs ?? 60000);
      try {
        const response = await this.fetcher(url, {redirect: 'error', signal: abort.signal, headers: {'User-Agent': 'helsinki-game-world-pipeline/0.1 (bounded geography acquisition)'}});
        if (!response.ok) {await response.body?.cancel(); const error = new Error(`Source HTTP ${response.status}`); Object.assign(error, {retryable: response.status === 429 || response.status >= 500}); throw error;}
        const length = response.headers.get('content-length');
        assert.ok(length === null || /^\d+$/.test(length) && Number(length) <= capacity, 'Source body exceeds reserved byte cap');
        assert.ok(response.body, 'Empty source response'); const reader = response.body.getReader(), chunks: Buffer[] = [];
        try {
          for (;;) {const next = await reader.read(); if (next.done) break; consumed += next.value.byteLength; if (consumed > capacity) {abort.abort(); throw new Error('Source body exceeds byte cap');} chunks.push(Buffer.from(next.value));}
        } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
        assert.ok(consumed > 0, 'Empty source payload');
        settleReservation(); return Buffer.concat(chunks);
      } catch (error) {
        if (settlementAttempted) throw error;
        settleReservation();
        const retryable = (error as {retryable?: boolean}).retryable || error instanceof TypeError || abort.signal.aborted && consumed <= capacity;
        if (!retryable || attempt >= (this.job.retries ?? 2)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      } finally {clearTimeout(timer); abort.abort(); this.activeReservations--; const waiters = this.reservationWaiters; this.reservationWaiters = []; for (const resolve of waiters) resolve();}
    }
  }
}

export function validateWfsResponse(value: unknown, maxFeatures: number): {type: 'FeatureCollection'; crs: unknown; features: any[]} {
  assert.ok(value && typeof value === 'object'); const data = value as any;
  assert.equal(data.type, 'FeatureCollection'); assert.ok(Array.isArray(data.features) && data.features.length < maxFeatures, 'WFS possibly truncated; subdivide this partition');
  assert.ok(data.features.length === 0 && data.crs == null || /(?:EPSG::|EPSG:|\/EPSG\/0\/)3879$/.test(String(data.crs?.properties?.name)), 'WFS CRS drift');
  for (const field of ['numberMatched', 'totalFeatures']) if (data[field] !== undefined) {
    assert.ok(Number.isSafeInteger(data[field]) && data[field] === data.features.length, 'Incomplete WFS result count');
  }
  if (data.numberReturned !== undefined) assert.equal(data.numberReturned, data.features.length);
  assert.ok(!data.next && !(data.links ?? []).some((link: any) => link.rel === 'next'), 'WFS response is paginated');
  const visit = (coords: unknown): void => {
    assert.ok(Array.isArray(coords) && coords.length > 0, 'WFS invalid coordinates');
    if (typeof coords[0] === 'number') {assert.ok(coords.length >= 2 && coords.every(Number.isFinite)); assert.ok(coords[0] >= 25400000 && coords[0] <= 25600000 && coords[1] >= 6600000 && coords[1] <= 6800000, 'WFS axis order drift');}
    else for (const child of coords) visit(child);
  };
  for (const feature of data.features) {
    assert.equal(feature.type, 'Feature'); assert.ok(feature.properties && typeof feature.properties === 'object');
    assert.ok(feature.geometry && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type), 'WFS polygon geometry required'); visit(feature.geometry.coordinates);
  }
  return data;
}

export function validateOsmResponse(value: unknown): any[] {
  assert.ok(value && typeof value === 'object'); const data = value as any;
  assert.equal(String(data.version), '0.6'); assert.ok(typeof data.license === 'string' && data.license.toLowerCase().includes('odbl'), 'OSM license drift');
  assert.ok(Array.isArray(data.elements) && data.elements.length <= 1_000_000, 'OSM elements missing or unbounded');
  const seen = new Set<string>();
  for (const element of data.elements) {
    assert.ok(['node', 'way', 'relation'].includes(element.type)); assert.ok(Number.isSafeInteger(element.id) && element.id > 0);
    const key = `${element.type}/${element.id}`; assert.ok(!seen.has(key), 'Duplicate OSM element'); seen.add(key);
    if (element.type === 'node') assert.ok(Number.isFinite(element.lat) && Math.abs(element.lat) <= 90 && Number.isFinite(element.lon) && Math.abs(element.lon) <= 180);
    else if (element.type === 'way') assert.ok(Array.isArray(element.nodes) && element.nodes.length >= 2 && element.nodes.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0));
    else {assert.ok(Array.isArray(element.members)); for (const member of element.members) assert.ok(['node', 'way', 'relation'].includes(member.type) && Number.isSafeInteger(member.ref) && member.ref > 0);}
  }
  return data.elements;
}

/** A missing register identifier is not a fabricated VTJ: retain source feature identity, then geometry identity. */
export function wfsFeatureIdentity(feature: any, property: string) {
  const value = feature.properties[property];
  if (typeof value === 'string' && value.trim().length > 0 || Number.isSafeInteger(value)) return {key: `property:${property}:${String(value)}`, strategy: 'property'};
  if (typeof feature.id === 'string' && feature.id.trim().length > 0 && feature.id.length <= 512 || Number.isSafeInteger(feature.id)) return {key: `feature:${String(feature.id)}`, strategy: 'feature-id'};
  assert.ok(feature.geometry && typeof feature.geometry === 'object', 'Feature without identity requires source geometry');
  return {key: `geometry:${sourceSha256(JSON.stringify(feature.geometry))}`, strategy: 'geometry-sha256'};
}

export function missingOsmReferences(elements: readonly any[]): string[] {
  const present = new Set(elements.map(element => `${element.type}/${element.id}`)), missing = new Set<string>();
  for (const element of elements) {
    const refs = element.type === 'way' ? element.nodes.map((id: number) => `node/${id}`) : element.type === 'relation' ? element.members.map((member: any) => `${member.type}/${member.ref}`) : [];
    for (const ref of refs) if (!present.has(ref)) missing.add(ref);
  }
  return [...missing].sort();
}

/** A full relation/way closes many dependencies in one bounded request; individual nodes are a last resort. */
export function nextOsmClosureTarget(elements: readonly any[], attempted: ReadonlySet<string>): string | undefined {
  const present = new Set(elements.map(element => `${element.type}/${element.id}`)), missing = missingOsmReferences(elements);
  const relations = elements.filter(element => element.type === 'relation').map(element => ({key: `relation/${element.id}`, missing: element.members.filter((member: any) => !present.has(`${member.type}/${member.ref}`)).length}));
  const relation = relations.filter(ref => ref.missing > 0 && !attempted.has(ref.key)).sort((a, b) => b.missing - a.missing || a.key.localeCompare(b.key))[0];
  if (relation) return relation.key;
  const missingRelation = missing.find(key => key.startsWith('relation/') && !attempted.has(key)); if (missingRelation) return missingRelation;
  const incompleteWay = elements.find(element => element.type === 'way' && !attempted.has(`way/${element.id}`) && element.nodes.some((id: number) => !present.has(`node/${id}`)));
  if (incompleteWay) return `way/${incompleteWay.id}`;
  return missing.find(key => key.startsWith('way/') && !attempted.has(key)) ?? missing.find(key => !attempted.has(key));
}

const EXCLUDABLE_RELATION_TYPES = new Set(['route', 'route_master', 'unposted_route', 'was:route', 'was:route_master', 'superroute', 'boundary', 'surveillance', 'destinationsign', 'destination_sign', 'street', 'public_transport', 'site', 'network', 'multilinestring']);
function bindOsmReview(store: AcquisitionStore, value: unknown): OsmClosureReview | undefined {
  if (value === undefined) {assert.ok(!store.progress.osmReview, 'The bound OSM consumer review is required on every resume'); return undefined;}
  exactKeys(value, ['schemaVersion', 'kind', 'sourceJobSha256', 'baseProgressSha256', 'layer', 'maxAdditionalClosureRequests', 'supersedesReviewSha256', 'consumers', 'excludedRelations'], 'OSM closure review');
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, 'reviewed-osm-consumer-closure'); assert.equal(value.sourceJobSha256, store.progress.jobSha256);
  assert.match(String(value.baseProgressSha256), SHA); assert.ok(store.job.layers.some(layer => layer.kind === 'osm' && layer.id === value.layer));
  boundedInteger(value.maxAdditionalClosureRequests, 0, 100, 'supplemental OSM closure budget');
  assert.ok(Array.isArray(value.consumers) && value.consumers.length > 0 && value.consumers.length <= 32);
  for (const ref of value.consumers) {exactKeys(ref, ['file', 'sha256'], 'consumer'); assert.match(String(ref.sha256), SHA); text(ref.file, 'consumer file'); assert.equal(sourceSha256(fs.readFileSync(String(ref.file))), ref.sha256, 'OSM consumer producer changed');}
  assert.ok(Array.isArray(value.excludedRelations) && value.excludedRelations.length <= 10000); const ids = new Set<number>();
  for (const ref of value.excludedRelations) {exactKeys(ref, ['id', 'sourceSha256', 'type', 'reason'], 'relation disposition'); boundedInteger(ref.id, 1, Number.MAX_SAFE_INTEGER, 'relation ID'); assert.ok(!ids.has(Number(ref.id))); ids.add(Number(ref.id)); assert.match(String(ref.sourceSha256), SHA);
    assert.ok(EXCLUDABLE_RELATION_TYPES.has(String(ref.type)), 'Geometry/access/bridge/restriction relations cannot be excluded'); text(ref.reason, 'relation exclusion reason');}
  const review = value as unknown as OsmClosureReview, digest = sourceSha256(JSON.stringify(review)), previous = store.progress.osmReview;
  if (!previous || previous.sha256 !== digest) {
    assert.equal(review.baseProgressSha256, store.openedProgressSha256, 'OSM review must bind the current stopped progress');
    if (previous) {assert.equal(review.supersedesReviewSha256, previous.sha256, 'OSM amendment must explicitly supersede its prior review'); assert.ok(review.maxAdditionalClosureRequests >= previous.additionalClosureRequests, 'OSM amendment may not erase consumed supplemental budget');}
    else assert.equal(review.supersedesReviewSha256, undefined);
    store.progress.osmReview = {sha256: digest, layer: review.layer, additionalClosureRequests: review.maxAdditionalClosureRequests, history: [...previous?.history ?? [], digest]}; store.save();
  }
  store.json(`osm-review/${digest}.json`, review); return review;
}

async function boundedMap<T, R>(values: readonly T[], concurrency: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(values.length); let next = 0, failure: unknown;
  await Promise.all(Array.from({length: Math.min(concurrency, values.length)}, async () => {
    while (failure === undefined && next < values.length) {
      const index = next++;
      try {output[index] = await run(values[index]!);} catch (error) {failure = error;}
    }
  }));
  if (failure !== undefined) throw failure;
  return output;
}

function lonLatBounds(bbox: ProjectedBounds) {
  const [e0, n0, e1, n1] = bbox, corners = [[e0, n0], [e1, n0], [e0, n1], [e1, n1]].map(([e, n]) => gk25ToGeodetic(e!, n!));
  const ll = [Math.min(...corners.map(c => c[1])), Math.min(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1])), Math.max(...corners.map(c => c[0]))];
  assert.ok((ll[2]! - ll[0]!) * (ll[3]! - ll[1]!) <= 0.25, 'OSM partition exceeds map API area bound'); return ll;
}

export async function acquireGeography(options: {job: unknown; out: string; resume?: boolean; fetcher?: Fetcher; osmReview?: unknown}) {
  const job = validateAcquisitionJob(options.job), jobSha256 = sourceSha256(JSON.stringify(job)), store = new AcquisitionStore(options.out, job, jobSha256, options.resume ?? false, options.fetcher ?? fetch);
  const review = bindOsmReview(store, options.osmReview);
  const sources = [];
  for (const layer of job.layers) {
    const prefix = `${layer.id}/${job.snapshot}`, conflicts: unknown[] = [];
    let snapshot: Record<string, unknown>;
    if (layer.kind === 'tiles') {
      for (const selected of layer.metadata ?? []) await store.payload(`${prefix}/${selected.file}`, selected);
      const saved = await boundedMap(layer.tiles, job.concurrency ?? 4, async selected => {
        const ref = await store.payload(`${prefix}/${selected.file}`, selected);
        const bytes = readSourceFile(store.root, ref);
        if (selected.file.endsWith('.glb')) assert.equal(bytes.toString('ascii', 0, 4), 'glTF', 'Expected GLB city tile');
        const {cache: _cache, ...metadata} = selected;
        return {...metadata, bytes: ref.bytes, sha256: ref.sha256};
      });
      const index = store.json(`${prefix}/tiles.json`, {...layer.indexMetadata, schemaVersion: 1, bboxEN: job.bboxEN, tiles: saved});
      snapshot = {...layer.indexMetadata, path: `${job.snapshot}/tiles.json`, sha256: index.sha256, tiles: saved.length, bytes: saved.reduce((sum, tile) => sum + tile.bytes, 0)};
    } else if (layer.kind === 'wfs') {
      const retained = new Map<string, any[]>(), baseline = new Set<string>(), parts = [], identityFallbacks: unknown[] = [];
      const acceptedPrefix: any[] = [], additions: any[] = [];
      let crs: unknown;
      const add = (features: any[], part: string, accepted: boolean) => {
        for (const feature of features) {
          const identity = wfsFeatureIdentity(feature, layer.stableKey), key = identity.key, prior = retained.get(key);
          if (identity.strategy !== 'property') identityFallbacks.push({...identity, part, requestedProperty: layer.stableKey, originalFeatureId: feature.id ?? null});
          if (accepted) {
            acceptedPrefix.push(feature); const group = prior ?? []; group.push(feature); retained.set(key, group); baseline.add(key);
          } else if (prior) {
            if (!prior.some(previous => JSON.stringify(previous) === JSON.stringify(feature))) conflicts.push({key, part, old: prior, fresh: feature, policy: baseline.has(key) ? 'ACCEPTED_FEATURE_RETAINED' : 'FIRST_NEW_FEATURE_RETAINED'});
          } else {retained.set(key, [feature]); additions.push(feature);}
        }
      };
      if (layer.accepted) {
        const old = JSON.parse(readSourceFile(layer.accepted.root, layer.accepted).toString());
        // Existing accepted snapshots can be larger than one bounded request.
        validateWfsResponse({type: old.type, crs: old.crs, features: old.features}, Number.MAX_SAFE_INTEGER); crs = old.crs; add(old.features, 'accepted', true);
      }
      for (const partition of layer.partitions) {
        const url = WFS + '?' + new URLSearchParams({service: 'WFS', version: '1.0.0', request: 'GetFeature', typeName: layer.typeName, srsName: 'EPSG:3879', bbox: partition.bboxEN.join(','), maxFeatures: String(layer.maxFeatures), outputFormat: 'application/json'});
        const ref = await store.payload(`${layer.id}/parts/${partition.id}.geojson`, {url}), data = validateWfsResponse(JSON.parse(readSourceFile(store.root, ref).toString()), layer.maxFeatures);
        crs ??= data.crs; add(data.features, partition.id, false); parts.push({...partition, ...ref, features: data.features.length, requestedCrs: 'EPSG:3879', responseCrs: data.crs ?? null});
      }
      const output = store.json(`${prefix}.geojson`, {type: 'FeatureCollection', crs: crs ?? null, features: [...acceptedPrefix, ...additions]}), conflict = store.json(`${layer.id}/conflicts.json`, {schemaVersion: 1, conflicts});
      const identities = store.json(`${layer.id}/identity-fallbacks.json`, {schemaVersion: 1, fallbacks: identityFallbacks, originalsUnmodified: true});
      snapshot = {path: `${job.snapshot}.geojson`, bytes: output.bytes, sha256: output.sha256, features: acceptedPrefix.length + additions.length, stableKeys: retained.size, parts, conflicts: conflicts.length, conflictsSha256: conflict.sha256,
        identityFallbacks: identityFallbacks.length, identityFallbacksSha256: identities.sha256, ...(layer.accepted ? {cached: layer.accepted, acceptedFeatures: acceptedPrefix.length, acceptedStableKeys: baseline.size} : {})};
    } else {
      const retained = new Map<string, any>(), baseline = new Set<string>(), parts = [];
      const add = (elements: any[], part: string, accepted: boolean) => {
        for (const element of elements) {
          const key = `${element.type}/${element.id}`, prior = retained.get(key);
          if (prior && JSON.stringify(prior) !== JSON.stringify(element)) conflicts.push({key, part, old: prior, fresh: element, policy: baseline.has(key) ? 'ACCEPTED_ELEMENT_RETAINED' : 'FIRST_NEW_ELEMENT_RETAINED'});
          else if (!prior) retained.set(key, element);
          if (accepted) baseline.add(key);
        }
      };
      if (layer.accepted) add(validateOsmResponse(JSON.parse(readSourceFile(layer.accepted.root, layer.accepted).toString())), 'accepted', true);
      for (const partition of layer.partitions) {
        const bboxLonLat = lonLatBounds(partition.bboxEN), url = OSM + 'map.json?bbox=' + bboxLonLat.join(',');
        const ref = await store.payload(`${layer.id}/parts/${partition.id}.json`, {url}); add(validateOsmResponse(JSON.parse(readSourceFile(store.root, ref).toString())), partition.id, false); parts.push({...partition, bboxLonLat, ...ref});
      }
      const completedClosure = store.progress.payloads.filter(ref => ref.path.startsWith(`${layer.id}/closure/`));
      const targetFor = (ref: AcquiredPayload) => new URL(ref.url).pathname.replace('/api/0.6/', '').replace(/(?:\/full)?\.json$/, '');
      const attempted = new Set([...(store.progress.closureTargets?.[layer.id] ?? []), ...completedClosure.map(targetFor)]);
      for (const ref of completedClosure) {const key = targetFor(ref); add(validateOsmResponse(JSON.parse(readSourceFile(store.root, ref).toString())), key, false); parts.push({...ref, closureOf: key});}
      const activeReview = review?.layer === layer.id ? review : undefined, excluded = new Set<number>();
      for (const disposition of activeReview?.excludedRelations ?? []) {
        const relation = retained.get(`relation/${disposition.id}`); assert.ok(relation, 'Reviewed relation is missing from raw source parts');
        assert.equal(relation.tags?.type, disposition.type); assert.equal(sourceSha256(JSON.stringify(relation)), disposition.sourceSha256, 'Reviewed relation source drift');
        assert.ok(!baseline.has(`relation/${disposition.id}`), 'An accepted relation cannot be omitted by a new-source disposition'); excluded.add(disposition.id);
      }
      const consumerElements = () => [...retained.values()].filter(element => element.type !== 'relation' || !excluded.has(element.id));
      const requestLimit = layer.maxClosureRequests + (activeReview?.maxAdditionalClosureRequests ?? 0);
      store.progress.closureTargets ??= {}; store.progress.closureTargets[layer.id] = [...attempted]; store.save();
      for (;;) {
        const elements = consumerElements(), missing = missingOsmReferences(elements); if (!missing.length) break;
        const next = nextOsmClosureTarget(elements, attempted);
        if (!next || attempted.size >= requestLimit) {
          const file = `${layer.id}/closure-incomplete-${store.progress.osmReview?.sha256.slice(0, 12) ?? 'global'}.json`;
          store.json(file, {schemaVersion: 1, closureScope: activeReview ? 'reviewed-native-consumers' : 'all-record-references', missing, nextSuggestedTarget: next ?? null, attempted: [...attempted], originalMaxClosureRequests: layer.maxClosureRequests, supplementalMaxClosureRequests: activeReview?.maxAdditionalClosureRequests ?? 0, cumulativeMaxClosureRequests: requestLimit});
          throw new Error(`OSM reference closure incomplete (${missing.length} missing); see ${file}; original and supplemental request budgets are cumulative across resumes`);
        }
        attempted.add(next); store.progress.closureTargets[layer.id] = [...attempted]; store.save(); const url = OSM + next + (next.startsWith('node/') ? '.json' : '/full.json');
        const ref = await store.payload(`${layer.id}/closure/${next.replace('/', '_')}.json`, {url}); add(validateOsmResponse(JSON.parse(readSourceFile(store.root, ref).toString())), next, false); parts.push({...ref, closureOf: next});
      }
      const elements = consumerElements(), output = store.json(`${prefix}.json`, {version: '0.6', generator: 'helsinki-bounded-acquisition', license: 'https://opendatacommons.org/licenses/odbl/1-0/', elements}), conflict = store.json(`${layer.id}/conflicts.json`, {schemaVersion: 1, conflicts});
      snapshot = {path: `${job.snapshot}.json`, bytes: output.bytes, sha256: output.sha256, elements: Object.fromEntries(['node', 'way', 'relation'].map(kind => [kind, elements.filter(element => element.type === kind).length])), parts,
        closureScope: activeReview ? 'reviewed-native-consumers-not-global-osm' : 'all-record-references', excludedRelations: [...excluded], consumerReviewSha256: activeReview ? store.progress.osmReview!.sha256 : null,
        missingReferences: [], closureRequests: attempted.size, originalMaxClosureRequests: layer.maxClosureRequests, supplementalMaxClosureRequests: activeReview?.maxAdditionalClosureRequests ?? 0,
        conflicts: conflicts.length, conflictsSha256: conflict.sha256, ...(layer.accepted ? {cached: layer.accepted, acceptedElements: baseline.size} : {})};
    }
    const retrievedAt = store.progress.payloads.filter(ref => ref.path.startsWith(layer.id + '/')).map(ref => ref.retrievedAt).sort().at(-1)!;
    const ledger = store.json(`${layer.id}/ledger.json`, {schemaVersion: 1, source: layer.source, snapshots: {[job.snapshot]: {...snapshot, url: layer.source.url, vintage: layer.vintage, retrievedAt,
      bboxEN: job.bboxEN, sourceJobSha256: jobSha256, acquisition: 'Bounded selected source snapshot. Accepted inputs are immutable; source conflicts require review before geometry generation.'}}});
    sources.push({id: layer.id, ...ledger, snapshot: job.snapshot});
  }
  const report = {schemaVersion: 1, status: 'ACQUIRED_PENDING_GEOMETRY_AND_CONFLICT_REVIEW', jobSha256, bboxEN: job.bboxEN, sources, chargedNetworkBytes: store.progress.chargedNetworkBytes,
    budgetBytes: job.budgetBytes, maxPayloadBytes: job.maxPayloadBytes, payloads: store.progress.payloads.length, downloadedPayloads: store.progress.payloads.filter(ref => !ref.reused).length,
    osmConsumerReviewSha256: store.progress.osmReview?.sha256 ?? null, producerSha256: sourceSha256(fs.readFileSync(import.meta.filename))};
  store.json('acquisition-report.json', report); store.progress.complete = true; store.save(); return report;
}
