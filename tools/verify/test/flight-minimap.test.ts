import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hud } from '../../../apps/game/src/ui/hud.ts';
import { compassHeading, LiveMinimap, mapYaw } from '../../../apps/game/src/ui/minimap.ts';

test('compass follows runtime cardinal axes and occupied aircraft heading', () => {
  for (const [yaw, degrees, cardinal] of [[Math.PI, 0, 'N'], [Math.PI / 2, 90, 'E'], [0, 180, 'S'], [-Math.PI / 2, 270, 'W']] as const) {
    assert.deepEqual(compassHeading(yaw), { degrees, cardinal });
  }
  assert.deepEqual(compassHeading(Math.PI * 3), { degrees: 0, cardinal: 'N' });
  const state = { player: { yaw: 0, aircraftId: 'a' }, aircraft: [{ id: 'a', yaw: Math.PI / 2 }], vehicles: [] };
  assert.equal(mapYaw(state as never), Math.PI / 2);
  assert.equal(mapYaw({ ...state, player: { yaw: 0, inVehicle: 'car' }, vehicles: [{ id: 'car', rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }] } as never).toFixed(6), '1.570796');
  assert.deepEqual(compassHeading(Number.NaN), { degrees: 0, cardinal: 'N' });
});

/** Canvas command sink: observe the real painter without requiring a native raster library. */
function canvas() {
  const fills: string[] = [];
  const context = { fillStyle: '', beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() { fills.push(this.fillStyle); }, clearRect() {} };
  return { width: 0, height: 0, getContext: () => context, fills };
}

test('late live data paints water, roads and buildings and survives source cache eviction', async () => {
  const made: ReturnType<typeof canvas>[] = [];
  const map = new LiveMinimap(() => { const c = canvas(); made.push(c); return c as never; });
  assert.equal(map.cell(-1, 2, null), null);
  assert.equal(made.length, 0, 'unavailable cells are never cached as blank canvases');
  const positions = new Float32Array([-128, 0, 256, -120, 0, 256, -128, 0, 264]);
  const indices = new Uint32Array([0, 1, 2]);
  const ground = { positions, normals: positions, classes: [{ surface: 'road', indices }], water: { positions, indices } };
  const { encodeCollisionBundle } = await import('../../../packages/world-schema/src/index.ts');
  const hcol = encodeCollisionBundle({ originId: 'test', frame: 'X-east,Y-up,Z-south', cell: '-1,2', surfaceTags: ['roof'] }, [{ id: 'building', group: 'buildings', ref: null, positions, indices, triangleTags: new Uint16Array([0]) }]);
  const tile = map.cell(-1, 2, { ground, hcol } as never);
  assert.ok(tile);
  assert.equal(new Set(made[0]!.fills).size, 3, 'explicit water, road and building use distinct paint');
  assert.equal(map.cell(-1, 2, null), tile, 'recent mapped context survives source LRU eviction');
  assert.equal(map.cell(-1, 2, { ground } as never), tile, 'evicted collision bytes do not erase buildings');
  assert.notEqual(map.cell(-1, 2, { ground: { ...ground } } as never), tile, 'new source geometry refreshes the canvas');
  for (let cx = 0; cx < 30; cx++) map.cell(cx, 2, { ground } as never);
  assert.equal(map.cell(-1, 2, null), null, 'old painted cells are evicted during long flights');
});

test('flying HUD paints late cached cells at world coordinates with a wider north-up view', () => {
  const draws: unknown[][] = [], scales: number[][] = [], rotations: number[] = [];
  const context = {
    save() {}, restore() {}, clearRect() {}, beginPath() {}, arc() {}, clip() {}, translate() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, strokeText() {}, fillText() {},
    scale(x: number, y: number) { scales.push([x, y]); }, rotate(yaw: number) { rotations.push(yaw); },
    drawImage(...args: unknown[]) { draws.push(args); },
  };
  const hud = Object.assign(Object.create(Hud.prototype), {
    minimap: { width: 220 }, mapCtx: context, area: { minX: 0, minZ: 0 }, scale: 2, tileSize: 256, tile: () => null,
    liveMap: new LiveMinimap(() => canvas() as never), compassHeading: { textContent: '' }, compassNeedle: { style: {} }, compass: { setAttribute() {} },
  });
  let ready = false;
  const positions = new Float32Array([0, 0, 0, 20, 0, 0, 0, 0, 20]);
  const ground = { positions, normals: positions, classes: [{ surface: 'road', indices: new Uint32Array([0, 1, 2]) }], water: null };
  hud.setMapSource((cx: number, cz: number) => ready && cx === 0 && cz === 0 ? { ground } : null);
  const state = { player: { position: [0, 5, 0], yaw: 0, aircraftId: 'a' }, aircraft: [{ id: 'a', yaw: Math.PI / 2, position: [0, 5, 0] }], vehicles: [], characters: [], wanted: {} };
  hud.drawMinimap(state);
  assert.equal(draws.length, 0);
  ready = true;
  hud.drawMinimap(state);
  assert.equal(draws.length, 1, 'data arriving after the first paint appears without recreating the HUD');
  assert.deepEqual(draws[0]!.slice(1), [300, 300], 'world origin lies at the centre of the 300m flight view');
  assert.deepEqual(scales[0], [220 / 600, 220 / 600]);
  assert.equal(rotations.at(-1), Math.PI / 2, 'player arrow uses occupied aircraft heading');
  assert.equal(hud.compassHeading.textContent, 'E 090°');
  assert.equal(hud.compassNeedle.style.transform, 'rotate(90deg)');
});

test('cached collision ground still maps roads when the optional ground visual was evicted', async () => {
  const { encodeCollisionBundle } = await import('../../../packages/world-schema/src/index.ts');
  const hcol = encodeCollisionBundle({ originId: 'test', frame: 'X-east,Y-up,Z-south', cell: '0,0', surfaceTags: ['road:asphalt'] }, [{ id: 'ground', group: 'ground', ref: null, positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 0, 4]), indices: new Uint32Array([0, 1, 2]), triangleTags: new Uint16Array([0]) }]);
  const image = canvas();
  const map = new LiveMinimap(() => image as never);
  assert.ok(map.cell(0, 0, { hcol }), 'cached HCOL retains useful ground without a separate visual');
  assert.ok(image.fills.includes('#c9d2e3'), 'actual road-tagged triangles are painted as roads');
});

test('release terrain is shaded within its true extent and missing territory stays visibly hatched', () => {
  const created: { colours: string[]; strokes: number }[] = [];
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() {
    const painted = { colours: [] as string[], strokes: 0 }; created.push(painted);
    const context = { fillStyle: '', translate() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { painted.strokes++; }, fillRect() { painted.colours.push(this.fillStyle); } };
    return { width: 0, height: 0, getContext: () => context };
  } } });
  try {
    const hud = Object.assign(Object.create(Hud.prototype), { area: { minX: 0, minZ: 0 }, scale: 2, tileSize: 256, tileGutter: 1, tiles: new Map(), tileShapes: new Map(), terrain: { x0: 0, z0: 0, resolution: 8, nx: 2, nz: 2, heights: new Float32Array([0, 0, 0, 0]) } });
    hud.tile(0, 0); hud.tile(20, 20);
    assert.ok(created[0]!.colours.some(c => c.startsWith('rgb(')), 'finite terrain has real relief context');
    assert.deepEqual(created[1]!.colours, ['#1c2230'], 'terrain samples are never clamped into unavailable territory');
    assert.ok(created[1]!.strokes > 0, 'missing territory has a distinct hatch');
  } finally {
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
