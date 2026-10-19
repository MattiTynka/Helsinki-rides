import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import polygonClipping from 'polygon-clipping';
import { buildCarriagewayGrade, meshCarriagewayGrade } from '../lib/carriageway-grade.ts';
import { signedArea, type LocalPolygon, type Pt } from '../lib/geometry.ts';
import type { TerrainGrid } from '../../../packages/world-schema/src/index.ts';

test('actual west source-cell sweep failure uses bounded existing numeric retry without dropping pavement', () => {
  const witness = JSON.parse(readFileSync(new URL('./fixtures/road-mesher-precision-west.json', import.meta.url), 'utf8'));
  assert.throws(() => polygonClipping.intersection(witness.inputs[0], witness.inputs[1]), /Unable to find segment/);
  const square: LocalPolygon = { id: 'whole-cell', bbox: [-1592, -228, -1588, -224],
    rings: [[[-1592, -228], [-1588, -228], [-1588, -224], [-1592, -224]]],
    properties: { paatyyppi: 'Ajorata', alatyyppi: 'Ajorata', materiaali: 'Asfalttibetoni' } };
  const terrain: TerrainGrid = { x0: -1593, z0: 223, resolution: 1, nx: 7, nz: 7, heights: new Float32Array(49) };
  const base = buildCarriagewayGrade([square], terrain, { area: { minX: -1592, maxX: -1588, minZ: 224, maxZ: 228 },
    protectedArea: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, protectedMarginMetres: 4, gridMetres: 4, maxAxisGrade: .35 });
  const parts: LocalPolygon[] = witness.inputs[0].map((rings: Pt[][], i: number) => ({ ...square, id: `source-${i}`, rings }));
  const field = { ...base, parts, cells: [{ ...base.cells[0]!, polygons: parts.map(part => ({ source: part.id, rings: part.rings })) }] };
  let retries = 0; const pieces = meshCarriagewayGrade(field, 128, () => retries++);
  assert.ok(retries >= 1, 'The failing legacy mesher intersection must use the numeric recovery');
  assert.ok(pieces.length > 0);
  let area = 0;
  for (const piece of pieces) for (let i = 0; i < piece.indices.length; i += 3) {
    const triangle = [0, 1, 2].map(k => { const at = piece.indices[i + k]! * 3; assert.equal(piece.positions[at + 1], 0); return [piece.positions[at]!, -piece.positions[at + 2]!] as Pt; });
    area += Math.abs(signedArea(triangle));
  }
  const sourceArea = parts.reduce((sum, part) => sum + Math.abs(signedArea(part.rings[0]!)), 0);
  assert.ok(Math.abs(area - sourceArea) < 1e-6, `Source pavement area lost: ${sourceArea} -> ${area}`);
  assert.ok(sourceArea > 1 && area < 16, 'Recovery must not replace the source outline with its grid square');
});
