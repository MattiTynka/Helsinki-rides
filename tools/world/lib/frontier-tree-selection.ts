import assert from 'node:assert/strict';

export type TreeFrontierSelection = {
  /** Legacy north/south selection across the entire world width. */
  bands?: readonly (readonly [number, number])[];
  /** Explicit XZ rectangles support west frontiers and their shared corners. */
  regions?: readonly (readonly [number, number, number, number])[];
};

export function validateTreeFrontierSelection(selection: TreeFrontierSelection): void {
  assert.ok(Boolean(selection.bands) !== Boolean(selection.regions), 'Choose either frontier bands or regions');
  const rows = selection.regions ?? selection.bands!;
  assert.ok(rows.length > 0 && rows.length <= 128, 'Tree frontier selection must contain1–128 bounds');
  for (const row of rows) {
    assert.ok(row.every(Number.isFinite), 'Tree frontier bounds must be finite');
    if (selection.regions) assert.ok(row.length === 4 && row[0]! < row[2]! && row[1]! < row[3]!, 'Invalid frontier rectangle');
    else assert.ok(row.length === 2 && row[0]! < row[1]!, 'Invalid frontier band');
  }
}

/** Bounds are taken from the complete transformed canopy, rather than just its anchor. */
export function canopyIntersectsFrontier(points: readonly (readonly [number, number])[], selection: TreeFrontierSelection) {
  assert.ok(points.length > 0 && points.every(p => p.length === 2 && p.every(Number.isFinite)), 'Invalid transformed canopy');
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, z] of points) {
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], z);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], z);
  }
  const selected = selection.regions
    ? selection.regions.some(r => bounds[0] <= r[2] && bounds[2] >= r[0] && bounds[1] <= r[3] && bounds[3] >= r[1])
    : selection.bands!.some(b => bounds[1] <= b[1] && bounds[3] >= b[0]);
  return {bounds, selected};
}
