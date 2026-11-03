import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellParts, type ConvertedTile } from '../../../apps/game/src/world/live/convert/buildings.ts';
import { LiveCellSource } from '../../../apps/game/src/world/live/live-source.ts';
import type { LiveBuildingPart } from '../../../apps/game/src/world/live/contract.ts';
import type { LiveWorkerRequest, LiveWorkerResponse } from '../../../apps/game/src/world/live/live-worker.ts';

// Four faces of one tetrahedron: changing winding, dropping a face, or rewriting normals must fail this test.
const faces = [
  [1, 1, 1, 1, 2, 1, 2, 1, 1],
  [1, 1, 1, 2, 1, 1, 1, 1, 2],
  [1, 1, 1, 1, 1, 2, 1, 2, 1],
  [2, 1, 1, 1, 2, 1, 1, 1, 2],
];
const fixture = (): ConvertedTile => ({
  url: 'tile', bytes: 1000,
  features: [{ id: 'building', vtj: null, centroidX: 1.5, centroidZ: 1.5,
    parts: faces.map((positions, i) => ({
      texture: i < 2 ? `tile#${i}` : null,
      color: i === 3 ? [0.1, 0.2, 0.3] as const : [0.7, 0.6, 0.5] as const,
      positions: new Float32Array(positions), normals: new Float32Array(9).fill(i + 1),
      uvs: i < 2 ? new Float32Array([0, 0, 1, 0, 0, 1]) : null,
    })),
  }],
  textures: new Map([0, 1].map(i => [`tile#${i}`, { bytes: Uint8Array.of(7, 8, i).buffer, width: 4, height: 4, triangles: 1 }])),
});
const no = () => false;

function triangleRecords(parts: readonly LiveBuildingPart[]): string[] {
  return parts.flatMap(part => {
    const records: string[] = [];
    for (let at = 0; at < part.positions.length; at += 9) records.push(JSON.stringify({
      positions: [...part.positions.subarray(at, at + 9)], normals: [...part.normals.subarray(at, at + 9)], color: part.color,
    }));
    return records;
  }).sort();
}

function signedVolume(parts: readonly LiveBuildingPart[]): number {
  let sum = 0;
  for (const part of parts) for (let at = 0; at < part.positions.length; at += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [...part.positions.subarray(at, at + 9)] as [number, number, number, number, number, number, number, number, number];
    sum += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return sum;
}

test('coarse payload merges only by colour without changing triangles or the cached detail tile', () => {
  const tile = fixture(), original = structuredClone(tile);
  const coarse = cellParts([tile], 0, 0, no, no, 'coarse');
  assert.equal(coarse.parts.length, 2, 'three same-colour parts share a draw payload even across texture keys');
  assert.equal(coarse.triangles, 4);
  assert.deepEqual(coarse.textures, []);
  for (const part of coarse.parts) { assert.equal(part.texture, null); assert.equal(part.uvs, null); }

  const detail = cellParts([tile], 0, 0, no, no, 'detail');
  assert.equal(detail.parts.length, 4);
  assert.equal(detail.triangles, 4);
  assert.deepEqual(detail.parts.map(p => p.texture), ['tile#0', 'tile#1', null, null]);
  assert.deepEqual(detail.parts.slice(0, 2).map(p => [...p.uvs!]), [[0, 0, 1, 0, 0, 1], [0, 0, 1, 0, 0, 1]]);
  assert.deepEqual(detail.textures.map(t => [t.key, [...new Uint8Array(t.bytes)], t.share]), [['tile#0', [7, 8, 0], 1], ['tile#1', [7, 8, 1], 1]]);
  assert.deepEqual(triangleRecords(coarse.parts), triangleRecords(detail.parts));
  assert.ok(Math.abs(signedVolume(coarse.parts) - 1 / 6) < 1e-12);
  assert.equal(signedVolume(coarse.parts), signedVolume(detail.parts));
  assert.deepEqual(tile, original, 'coarse assembly never strips UVs/images from the URL-keyed converted tile cache');
});

test('live source sends each payload kind over the worker boundary and can request detail after coarse', async () => {
  const tile = fixture(), original = structuredClone(tile);
  // The external worker is replaced at the message boundary; assembly and the source's request/reply path stay real.
  class AssemblyWorker extends EventTarget {
    postMessage(message: LiveWorkerRequest): void {
      const net = { requests: 0, downloadedBytes: 0, errors: [] };
      let response: LiveWorkerResponse;
      if (message.type === 'init') response = { type: 'ready', net };
      else if (message.type === 'visual') response = { type: 'visual', req: message.req, net,
        result: { id: 'live:0:0', maxGeometricError: message.maxGeometricError,
          ...cellParts([tile], message.cx, message.cz, no, no, message.kind) } };
      else return;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: response })));
    }
    terminate(): void {}
  }
  const workerProperty = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: AssemblyWorker });
  const source = new LiveCellSource({ origin: [0, 0, 0], originId: 'fixture', staticCellIds: [], staticBuildingIds: [], staticVtj: [] });
  try {
    const coarse = await source.visual(0, 0, 20, 'coarse');
    assert.equal(coarse.parts.length, 2);
    assert.deepEqual(coarse.textures, []);
    assert.ok(coarse.parts.every(p => p.texture === null && p.uvs === null));
    const detail = await source.visual(0, 0, 5, 'detail');
    assert.equal(detail.parts.length, 4);
    assert.equal(detail.textures.length, 2);
    assert.deepEqual(triangleRecords(coarse.parts), triangleRecords(detail.parts));
    assert.deepEqual(tile, original);
  } finally {
    source.dispose();
    if (workerProperty) Object.defineProperty(globalThis, 'Worker', workerProperty);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});
