import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from '../../apps/game/node_modules/vite/dist/node/index.js';

// A real browser catches the native path-building cost that a canvas command sink cannot.
test('dense minimap keeps exact water, ground and footprint pixels without quadratic path closing', async () => {
  const root = fileURLToPath(new URL('../../apps/game/', import.meta.url));
  const source = await readFile(new URL('../../apps/game/src/ui/minimap.ts', import.meta.url), 'utf8');
  const server = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] } },
    optimizeDeps: { noDiscovery: true },
    plugins: [{ name: 'minimap-test-page', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Minimap raster comparison</title>');
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(origin);
    const transformed = (await server.transformRequest('/src/ui/minimap.ts')).code.replaceAll('from "/', `from "${origin}/`);
    const schemaUrl = `${origin}/@fs/${fileURLToPath(new URL('../../packages/world-schema/src/index.ts', import.meta.url)).replaceAll('\\', '/')}`;
    const result = await page.evaluate(async ({ transformed, hasClose, schemaUrl }) => {
      const original = hasClose ? transformed : transformed.replace(/(context\.lineTo\([^\n]+\);\s*)(\}\s*context\.fill\(\))/, '$1context.closePath();\n$2');
      const candidate = transformed.replace('context.closePath();', '');
      async function load(code) {
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        try { return (await import(url)).LiveMinimap; } finally { URL.revokeObjectURL(url); }
      }
      const [Original, Candidate, Current] = await Promise.all([load(original), load(candidate), load(transformed)]);
      if (!original.includes('context.closePath();')) throw new Error('original comparison must explicitly close triangles');
      const { encodeCollisionBundle } = await import(schemaUrl);
      const positions = [], groups = [[], [], [], []], water = [], roofs = [];
      const side = 64;
      for (let z = 0; z <= side; z++) for (let x = 0; x <= side; x++) positions.push(-128 + x * 2 + 0.17, (x + z) % 3, 256 + z * 2 + 0.31);
      for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
        const a = z * (side + 1) + x, b = a + 1, c = a + side + 1, d = c + 1;
        const triangles = [a, b, c, b, d, c];
        // Interleave surfaces, opposite windings, an irregular shoreline and footprint holes.
        if (x >= 20 + 8 * Math.sin(z)) groups[(x + z) % 4].push(...(x % 2 ? [c, b, a, c, d, b] : triangles));
        if (x < 35 + 8 * Math.sin(z)) water.push(...triangles);
        if ((x + z) % 7 < 2 && !(x > 20 && x < 44 && z > 20 && z < 44)) roofs.push(...triangles);
      }
      const points = new Float32Array(positions);
      const indices = values => new Uint32Array(values);
      const ground = { positions: points, normals: points, classes: groups.map((group, i) => ({ surface: ['road', 'walk', 'green', 'yard'][i], indices: indices(group) })), water: { positions: points, indices: indices(water) } };
      const hcol = encodeCollisionBundle({ originId: 'canvas-test', frame: 'X-east,Y-up,Z-south', cell: '-1,2', surfaceTags: ['roof'] },
        [{ id: 'footprints', group: 'buildings', ref: null, positions: points, indices: indices(roofs), triangleTags: new Uint16Array(roofs.length / 3) }]);
      const data = { ground, hcol };
      function paint(Map) {
        const start = performance.now();
        const canvas = new Map().cell(-1, 2, data);
        const pixels = canvas.getContext('2d').getImageData(0, 0, 256, 256).data;
        return { ms: performance.now() - start, pixels };
      }
      const baseline = paint(Original), proposed = paint(Candidate), current = paint(Current);
      let differentBytes = 0, currentDifferentBytes = 0;
      for (let i = 0; i < baseline.pixels.length; i++) {
        if (baseline.pixels[i] !== proposed.pixels[i]) differentBytes++;
        if (baseline.pixels[i] !== current.pixels[i]) currentDifferentBytes++;
      }
      const solidColours = new Set();
      for (let i = 0; i < baseline.pixels.length; i += 4) if (baseline.pixels[i + 3] === 255) solidColours.add(Array.from(baseline.pixels.slice(i, i + 3)).join(','));
      const times = { original: [], candidate: [], current: [] };
      // Alternate orders to reduce warm-up or clock drift bias. The pixel read forces actual raster work.
      for (let run = 0; run < 5; run++) {
        const variants = run % 2 ? [['current', Current], ['candidate', Candidate], ['original', Original]] : [['original', Original], ['candidate', Candidate], ['current', Current]];
        for (const [name, Map] of variants) times[name].push(paint(Map).ms);
      }
      const medians = Object.fromEntries(Object.entries(times).map(([name, samples]) => [name, [...samples].sort((a, b) => a - b)[2]]));
      return { browser: navigator.userAgent, triangles: (groups.flat().length + water.length + roofs.length) / 3, differentBytes, currentDifferentBytes, visibleColours: ['39,79,112', '201,210,227', '114,126,145', '64,92,76', '84,87,73', '148,146,156'].filter(colour => solidColours.has(colour)), medians, times };
    }, { transformed, schemaUrl, hasClose: source.includes('context.closePath();') });
    console.log(`minimap canvas comparison ${JSON.stringify(result)}`);
    assert.equal(result.differentBytes, 0, 'omitting closePath must preserve every RGBA byte');
    assert.equal(result.currentDifferentBytes, 0, 'production must preserve every original RGBA byte');
    assert.equal(result.visibleColours.length, 6, 'water, four ground classes and building footprints must all be visible in the fixture');
    assert.ok(result.medians.candidate < result.medians.original * 0.5, 'the proposed painter removes the measured native path cost');
    assert.ok(result.medians.current < result.medians.original * 0.5, 'production must remove the measured native path cost');
  } finally { await browser?.close(); await server.close(); }
});
