// Offline replay of pinned municipal tile metadata for a newly requested projected source envelope.
// No network or writes to source snapshots. Missing external metadata is reported explicitly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gk25ToGeodetic} from '../../packages/world-schema/src/index.ts';
import {permittedAcquisitionUrl} from './lib/bounded-acquisition.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';

const {values} = parseArgs({options: {selection: {type: 'string'}, metadata: {type: 'string'}, bbox: {type: 'string'}, out: {type: 'string'}}});
assert.ok(values.selection && values.metadata && values.bbox && values.out, '--selection --metadata --bbox JSON --out required');
const selectionBytes = fs.readFileSync(values.selection), selection = JSON.parse(selectionBytes.toString());
const bbox = JSON.parse(values.bbox) as [number, number, number, number];
assert.ok(bbox.length === 4 && bbox.every(Number.isFinite) && bbox[0] >= 25400000 && bbox[2] <= 25600000 && bbox[1] >= 6600000 && bbox[3] <= 6800000 && bbox[0] < bbox[2] && bbox[1] < bbox[3]);
assert.ok(!fs.existsSync(values.out), 'Fresh offline metadata replay output required');
const metadata = new Map<string, any>(selection.metadata.map((ref: any) => [ref.url, ref]));
const radians = Math.PI / 180, corners = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]].map(([e, n]) => gk25ToGeodetic(e!, n!));
const angular = [Math.min(...corners.map(p => p[1])) * radians, Math.min(...corners.map(p => p[0])) * radians, Math.max(...corners.map(p => p[1])) * radians, Math.max(...corners.map(p => p[0])) * radians];
const [lat, lon] = gk25ToGeodetic((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2), f = 1 / 298.257222101, e2 = f * (2 - f), n = 6378137 / Math.sqrt(1 - e2 * Math.sin(lat * radians) ** 2);
const centre = [(n + 50) * Math.cos(lat * radians) * Math.cos(lon * radians), (n + 50) * Math.cos(lat * radians) * Math.sin(lon * radians), (n * (1 - e2) + 50) * Math.sin(lat * radians)];
const radius = Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 2 + 150;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a: number[], b: number[]) {const result = Array<number>(16).fill(0); for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) result[c * 4 + row]! += a[k * 4 + row]! * b[c * 4 + k]!; return result;}
const layers = [];
for (const id of ['lod2', 'trees/street', 'trees/plot']) {
  const prior = selection.selections[id], old = new Map<string, any>(prior.tiles.map((tile: any) => [tile.url, tile]));
  const missingMetadata = new Set<string>(), visited = new Set<string>(), inputPins: any[] = [], tiles: any[] = []; let traversed = 0;
  function read(url: string): any | null {
    permittedAcquisitionUrl(url); assert.ok(!visited.has(url), 'Cyclic or duplicate external tileset'); visited.add(url);
    const ref = metadata.get(url); if (!ref) {missingMetadata.add(url); return null;}
    const bytes = readSourceFile(values.metadata!, {path: ref.file, bytes: ref.bytes, sha256: ref.sha256}); inputPins.push(ref); return JSON.parse(bytes.toString());
  }
  function walk(tile: any, base: string, parent: number[], depth: number) {
    assert.ok(depth < 64 && ++traversed < 100000, 'Tile replay traversal cap');
    const matrix = tile.transform ? multiply(parent, tile.transform) : parent; assert.ok(matrix.length === 16 && matrix.every(Number.isFinite));
    const volume = tile.boundingVolume, region = volume?.region, sphere = volume?.sphere; let intersects = false;
    if (region) intersects = !(region[2] < angular[0]! || region[0] > angular[2]! || region[3] < angular[1]! || region[1] > angular[3]!);
    else if (sphere && id !== 'lod2') {
      const [x, y, z, r] = sphere, scale = Math.max(Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!), Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!), Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!));
      const point = [matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!, matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!, matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!];
      intersects = Math.hypot(...point.map((value, i) => value - centre[i]!)) <= r * scale + radius;
    } else throw new Error('Unqualified bounding volume');
    if (!intersects) return;
    const uri = tile.content?.uri ?? tile.content?.url, children = tile.children ?? [];
    if (uri) {
      const url = permittedAcquisitionUrl(new URL(uri, base).href);
      if (new URL(url).pathname.endsWith('.json')) {const external = read(url); if (external) walk(external.root, url, matrix, depth + 1); return;}
      if (!children.length) {const existing = old.get(url); if (existing) assert.deepEqual(existing.transform, matrix, 'Existing tile transform drift'); tiles.push({url, transform: matrix, geometricError: tile.geometricError, alreadySelected: !!existing});}
    }
    for (const child of children) walk(child, base, matrix, depth + 1);
  }
  const root = read(prior.url); assert.ok(root && root.asset.tilesetVersion === prior.version, 'Pinned root version drift'); walk(root.root, prior.url, identity, 0);
  layers.push({id, version: prior.version, completeMetadataTraversal: missingMetadata.size === 0, missingMetadata: [...missingMetadata].sort(), traversed, inputPins, selectedTiles: tiles.length, additionalKnownTiles: tiles.filter(tile => !tile.alreadySelected), reusedSelectedTiles: tiles.filter(tile => tile.alreadySelected).map(tile => tile.url)});
}
fs.mkdirSync(values.out, {recursive: true});
const report = {schemaVersion: 1, status: layers.every(layer => layer.completeMetadataTraversal) ? 'OFFLINE_TILE_SELECTION_COMPLETE_PENDING_PAYLOADS' : 'MISSING_PINNED_METADATA_FOR_NEW_SOURCE_ENVELOPE', selectionSha256: sourceSha256(selectionBytes), bboxEN: bbox, networkRequests: 0, layers, producerSha256: sourceSha256(fs.readFileSync(import.meta.filename))};
writeSourceJson(values.out, 'tile-coverage-replay.json', report);
console.log(JSON.stringify({status: report.status, layers: layers.map(layer => ({id: layer.id, missingMetadata: layer.missingMetadata.length, additionalKnownTiles: layer.additionalKnownTiles.length, reused: layer.reusedSelectedTiles.length}))}));
