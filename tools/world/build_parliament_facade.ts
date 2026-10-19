// A bounded exterior correction for the untextured LoD2 Parliament facade.
// The addition replaces exactly three flat source-wall triangles. Source massing,
// every other building, collision and authored ground remain with the cell build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import { validateBytes } from 'gltf-validator';
import { geodeticToGk25, parseTerrain, sampleTerrain } from '../../packages/world-schema/src/index.ts';
import { cleanRing, type Pt } from './lib/geometry.ts';
import { flatNormals, GlbBuilder } from './lib/gltf.ts';

export const PARLIAMENT_ID = 'BID_31acb401-f0ce-43c6-aed2-167cbed5d05e';
export const PARLIAMENT_VTJ = '1031902037';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
type Vertex = [number, number, number];
type Buffers = { positions: number[]; indices: number[] };
type SourcePart = { positions: { offset: number; bytes: number }; indices: { offset: number; bytes: number } };

/** Winding-preserving canonical world Float32 coordinates, independent of index
 * sharing and a cyclic rotation performed by meshopt. Reversal remains distinct. */
export function worldTriangleKey(triangle: readonly (readonly number[])[]): string {
  assert.equal(triangle.length, 3);
  const values = triangle.map(v => {
    assert.equal(v.length, 3); assert.ok(v.every(Number.isFinite));
    return v.map(n => Object.is(Math.fround(n), -0) ? 0 : Math.fround(n));
  });
  const rotations = [0, 1, 2].map(i => JSON.stringify([values[i], values[(i + 1) % 3], values[(i + 2) % 3]]));
  return sha(rotations.sort()[0]!);
}

export function readParliamentSource(cityDir: string) {
  const cityBytes = readFileSync(path.join(cityDir, 'city-model.json'));
  const city = JSON.parse(cityBytes.toString('utf8'));
  const bin = readFileSync(path.join(cityDir, city.binary.file));
  assert.equal(sha(bin), city.binary.sha256, 'Source city binary hash differs');
  const building = city.buildings.find((b: { id: string; vtj: string }) => b.id === PARLIAMENT_ID && b.vtj === PARLIAMENT_VTJ);
  assert.ok(building, 'Exact Parliament source building absent');
  assert.equal(building.textured, false); assert.equal(building.triangles, 1155);
  const triangles: Vertex[][] = [];
  for (const p of building.parts as SourcePart[]) {
    const P = new Float32Array(bin.buffer.slice(bin.byteOffset + p.positions.offset, bin.byteOffset + p.positions.offset + p.positions.bytes));
    const I = new Uint32Array(bin.buffer.slice(bin.byteOffset + p.indices.offset, bin.byteOffset + p.indices.offset + p.indices.bytes));
    for (let i = 0; i < I.length; i += 3) triangles.push([0, 1, 2].map(k => Array.from(P.slice(I[i + k]! * 3, I[i + k]! * 3 + 3)) as Vertex));
  }
  const removedIndices = [633, 634, 635], wall = removedIndices.map(i => triangles[i]!);
  const a = wall[0]![0]!, b = wall[0]![1]!, c = wall[0]![2]!;
  const ab = b.map((v, i) => v - a[i]!), ac = c.map((v, i) => v - a[i]!);
  const nx = ab[1]! * ac[2]! - ab[2]! * ac[1]!, ny = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
  const length = Math.hypot(nx, ny), normal: Pt = [nx / length, ny / length], tangent: Pt = [-normal[1], normal[0]];
  assert.ok(normal[0] > 0.95 && normal[1] > 0.29 && normal[1] < 0.31, 'Source east facade orientation changed');
  const origin: Pt = [a[0], a[1]], local = (p: readonly number[]) => (p[0]! - origin[0]) * tangent[0] + (p[1]! - origin[1]) * tangent[1];
  const width = Math.max(...wall.flat().map(local)), bottom = Math.min(...wall.flat().map(v => v[2])), top = Math.max(...wall.flat().map(v => v[2]));
  assert.ok(width > 54 && width < 55 && top > 37.8 && top < 38, 'Source facade dimensions changed');
  for (const v of wall.flat()) assert.ok(Math.abs((v[0] - origin[0]) * normal[0] + (v[1] - origin[1]) * normal[1]) < 0.0001, 'Source wall is not planar');
  const runtimeWall = wall.map(t => t.map(([x, n, h]) => [x, h, -n] as Vertex));
  return { city, building, triangles, wall, runtimeWall, removedIndices, normal, tangent, origin, width, bottom, top,
    source: { cityJson: { path: path.join(cityDir, 'city-model.json'), sha256: sha(cityBytes) }, binary: { path: path.join(cityDir, city.binary.file), sha256: sha(bin) }, removedTriangleKeys: runtimeWall.map(worldTriangleKey) } };
}

export function makeParliamentFacade(frame: { origin: Pt; normal: Pt; tangent: Pt; width: number; bottom: number; top: number }, baseHeight: number, columnFeet: readonly number[]) {
  assert.equal(columnFeet.length, 14); assert.ok(columnFeet.every(Number.isFinite));
  const groups: Record<'stone' | 'joints' | 'glass', Buffers> = { stone: { positions: [], indices: [] }, joints: { positions: [], indices: [] }, glass: { positions: [], indices: [] } };
  const point = (u: number, h: number, depth: number): Vertex => [frame.origin[0] + frame.tangent[0] * u + frame.normal[0] * depth, h, -(frame.origin[1] + frame.tangent[1] * u + frame.normal[1] * depth)];
  const tri = (group: keyof typeof groups, a: Vertex, b: Vertex, c: Vertex) => { const g = groups[group], offset = g.positions.length / 3; g.positions.push(...a, ...b, ...c); g.indices.push(offset, offset + 1, offset + 2); };
  const quad = (group: keyof typeof groups, a: Vertex, b: Vertex, c: Vertex, d: Vertex) => { tri(group, a, b, c); tri(group, a, c, d); };
  const panel = (group: keyof typeof groups, u0: number, u1: number, h0: number, h1: number, depth: number) => quad(group, point(u0, h0, depth), point(u1, h0, depth), point(u1, h1, depth), point(u0, h1, depth));
  const shapedPanel = (group: keyof typeof groups, outline: Pt[], depth: number) => {
    const flat = outline.flat(), I = earcut(flat, undefined, 2);
    for (let i = 0; i < I.length; i += 3) tri(group, ...[0, 1, 2].map(k => point(flat[I[i + k]! * 2]!, flat[I[i + k]! * 2 + 1]!, depth)) as [Vertex, Vertex, Vertex]);
  };
  const archOutline = (u: number, bottom: number, spring: number, radius: number): Pt[] => [[u - radius, bottom], [u + radius, bottom], ...Array.from({ length: 17 }, (_, i) => [u + Math.cos(i * Math.PI / 16) * radius, spring + Math.sin(i * Math.PI / 16) * radius] as Pt)];
  const box = (group: keyof typeof groups, u0: number, u1: number, h0: number, h1: number, back: number, front: number) => {
    const p = [point(u0, h0, back), point(u1, h0, back), point(u1, h1, back), point(u0, h1, back), point(u0, h0, front), point(u1, h0, front), point(u1, h1, front), point(u0, h1, front)];
    for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]) quad(group, p[a!]!, p[b!]!, p[c!]!, p[d!]!);
  };
  const disk = (group: keyof typeof groups, u: number, h: number, radius: number, depth: number, segments = 24) => {
    for (let i = 0; i < segments; i++) { const a = i * Math.PI * 2 / segments, b = (i + 1) * Math.PI * 2 / segments; tri(group, point(u, h, depth), point(u + Math.cos(a) * radius, h + Math.sin(a) * radius, depth), point(u + Math.cos(b) * radius, h + Math.sin(b) * radius, depth)); }
  };
  const shaftTop = baseHeight + 17, entablatureTop = shaftTop + 1.75;
  assert.ok(entablatureTop + 3 < frame.top, 'No room for source attic above colonnade');
  const centers = Array.from({ length: 14 }, (_, i) => 2.9 + (frame.width - 5.8) * i / 13);
  const bays = centers.slice(0, -1).map((u, i) => (u + centers[i + 1]!) / 2);
  const spacing = centers[1]! - centers[0]!;
  // The complete exterior reference has an additional glazed oculus beyond
  // each end column. Two still farther blind roundels belong to adjacent piers.
  const oculi = [centers[0]! - spacing / 2, ...bays, centers.at(-1)! + spacing / 2];
  const oculusY = entablatureTop + 1.35, oculusRadius = 0.62;
  // The remaining wall follows the source envelope. Holes expose the actual
  // recessed portico and circular attic windows, avoiding painted-on shadows.
  const outline: Pt[] = [[0, frame.bottom], [frame.width, frame.bottom], [frame.width, frame.top], [0, frame.top]];
  const openings: Pt[][] = [[[1.9, baseHeight], [frame.width - 1.9, baseHeight], [frame.width - 1.9, shaftTop], [1.9, shaftTop]], ...oculi.map(u => Array.from({ length: 24 }, (_, i) => [u + Math.cos(i * Math.PI / 12) * oculusRadius, oculusY + Math.sin(i * Math.PI / 12) * oculusRadius] as Pt))];
  const wall = polygonClipping.difference([[outline]], ...openings.map(r => [[r]])) as Pt[][][];
  for (const poly of wall) {
    const flat: number[] = [], holes: number[] = [];
    for (const [i, r] of poly.entries()) { if (i) holes.push(flat.length / 2); for (const p of cleanRing(r)) flat.push(...p); }
    const I = earcut(flat, holes.length ? holes : undefined, 2);
    for (let i = 0; i < I.length; i += 3) tri('stone', ...[0, 1, 2].map(k => point(flat[I[i + k]! * 2]!, flat[I[i + k]! * 2 + 1]!, -0.16)) as [Vertex, Vertex, Vertex]);
  }
  panel('stone', 1.9, frame.width - 1.9, baseHeight, shaftTop, -3.2);
  box('stone', 1.9, frame.width - 1.9, shaftTop - 0.1, shaftTop + 0.28, -3.2, -0.002);
  box('stone', 0, frame.width, shaftTop + 0.4, shaftTop + 0.7, -0.25, -0.002);
  box('stone', 0, frame.width, entablatureTop - 0.28, entablatureTop, -0.25, -0.002);
  box('stone', 0, frame.width, oculusY + 0.85, oculusY + 1.08, -0.2, -0.002);
  box('stone', 0, frame.width, frame.top - 0.38, frame.top - 0.1, -0.2, -0.002);
  // Keep the broad architectural stone bands above. Thin geometric mortar
  // strips alias into stippled pixels at street distance; they are omitted.
  for (const u of oculi) {
    disk('glass', u, oculusY, oculusRadius * 0.96, -0.32);
    for (let i = 0; i < 24; i++) {
      const a = i * Math.PI / 12, b = (i + 1) * Math.PI / 12;
      quad('stone', point(u + Math.cos(a) * oculusRadius, oculusY + Math.sin(a) * oculusRadius, -0.015), point(u + Math.cos(b) * oculusRadius, oculusY + Math.sin(b) * oculusRadius, -0.015), point(u + Math.cos(b) * (oculusRadius + 0.16), oculusY + Math.sin(b) * (oculusRadius + 0.16), -0.015), point(u + Math.cos(a) * (oculusRadius + 0.16), oculusY + Math.sin(a) * (oculusRadius + 0.16), -0.015));
    }
  }
  for (const [bayIndex, u] of bays.entries()) {
    const isDoor = [3, 6, 9].includes(bayIndex), h0 = baseHeight + (isDoor ? 0.05 : 0.35), h1 = baseHeight + 3.1, radius = 0.72, spring = h1 - radius;
    shapedPanel('joints', archOutline(u, h0 - 0.12, spring, radius + 0.12), -3.1);
    shapedPanel('glass', archOutline(u, h0, spring, radius), -3.0);
    // Both the springline and the curved head remain clear of the unchanged
    // planar backwall. No large diagonal backing triangle sits in front of glass.
    panel('stone', u - 0.035, u + 0.035, h0, h1 - 0.03, -2.9);
    for (let h = h0 + 0.7; h < h1 - 0.06; h += 0.7) {
      const half = h <= spring ? radius : Math.sqrt(Math.max(0, radius * radius - (h - spring) ** 2));
      panel('stone', u - half, u - 0.035, h, h + 0.035, -2.9);
      panel('stone', u + 0.035, u + half, h, h + 0.035, -2.9);
    }
    if (isDoor) {
      panel('joints', u - radius, u + radius, h0, h0 + 0.5, -2.8);
      panel('joints', u - 0.035, u + 0.035, h0, spring, -2.7);
      for (const side of [-1, 1]) panel('stone', u + side * 0.12 - 0.025, u + side * 0.12 + 0.025, h0 + 1.1, h0 + 1.4, -2.6);
    }
    for (const [h0, h1] of [[baseHeight + 5.2, baseHeight + 9.2], [baseHeight + 11.6, baseHeight + 14.7]] as [number, number][]) {
      const half = 0.72;
      panel('joints', u - half - 0.12, u + half + 0.12, h0 - 0.12, h1 + 0.12, -3.1);
      panel('glass', u - half, u + half, h0, h1, -3.0);
      panel('stone', u - 0.035, u + 0.035, h0, h1, -2.9);
      for (let h = h0 + 0.7; h < h1; h += 0.7) { panel('stone', u - half, u - 0.035, h, h + 0.045, -2.9); panel('stone', u + 0.035, u + half, h, h + 0.045, -2.9); }
    }
  }
  for (const [i, u] of centers.entries()) {
    const foot = columnFeet[i]!;
    assert.ok(Math.abs(foot - baseHeight) < 1.5, `Column ${i} has no source-ground base near measured landing`);
    box('stone', u - 0.84, u + 0.84, foot - 0.05, baseHeight + 0.32, -1.9, -0.02);
    const levels = [[baseHeight + 0.32, 0.7], [baseHeight + 1.2, 0.65], [baseHeight + 6.5, 0.66], [shaftTop - 0.85, 0.55]];
    for (let j = 0; j + 1 < levels.length; j++) for (let k = 0; k < 20; k++) {
      const a = k * Math.PI / 10, b = (k + 1) * Math.PI / 10, [h0, r0] = levels[j]!, [h1, r1] = levels[j + 1]!;
      quad('stone', point(u + Math.cos(a) * r0!, h0!, -1 + Math.sin(a) * r0!), point(u + Math.cos(b) * r0!, h0!, -1 + Math.sin(b) * r0!), point(u + Math.cos(b) * r1!, h1!, -1 + Math.sin(b) * r1!), point(u + Math.cos(a) * r1!, h1!, -1 + Math.sin(a) * r1!));
    }
    box('stone', u - 0.7, u + 0.7, shaftTop - 0.85, shaftTop - 0.5, -1.7, -0.3);
    box('stone', u - 0.94, u + 0.94, shaftTop - 0.5, shaftTop, -1.94, -0.06);
  }
  // Every vertex remains behind the former facade plane and within its width.
  for (const g of Object.values(groups)) for (let i = 0; i < g.positions.length; i += 3) {
    const x = g.positions[i]! - frame.origin[0], n = -g.positions[i + 2]! - frame.origin[1];
    const depth = x * frame.normal[0] + n * frame.normal[1];
    assert.ok(depth <= 0.00001 && depth >= -3.21, 'Facade leaves the existing massing envelope');
  }
  return { groups, centers, baseHeight, shaftTop, oculusCount: oculi.length, oculusCenters: oculi, lowerArchedBays: bays.length, doorBays: [3, 6, 9], columnFeet: [...columnFeet] };
}

export async function buildParliamentFacade(cityArgument: string, terrainArgument: string, osmArgument: string, outArgument: string) {
  const out = path.resolve(outArgument); assert.ok(!existsSync(out), 'Use a new Parliament output directory');
  const source = readParliamentSource(cityArgument), terrainPath = path.join(terrainArgument, 'terrain.bin'), terrainBytes = readFileSync(terrainPath), terrain = parseTerrain(new Uint8Array(terrainBytes));
  const osmBytes = readFileSync(osmArgument), osm = JSON.parse(osmBytes.toString('utf8'));
  const origin = source.city.originProjected;
  const nodes = new Map<number, Pt>(osm.elements.filter((e: { type: string }) => e.type === 'node').map((e: { id: number; lat: number; lon: number }) => { const p = geodeticToGk25(e.lat, e.lon); return [e.id, [p[0] - origin[0], p[1] - origin[1]]]; }));
  const landingSamples = [1006919253, 1006919257, 1006919265].map(id => {
    const way = osm.elements.find((e: { id: number; type: string }) => e.id === id && e.type === 'way'); assert.ok(way, `Source Parliament stair ${id} absent`);
    const p = nodes.get(way.nodes.at(-1))!; assert.ok(p);
    return { way: id, positionENU: p, height: sampleTerrain(terrain, p[0], -p[1]) };
  });
  const baseHeight = landingSamples.map(p => p.height).sort((a, b) => a - b)[1]!;
  const centers = Array.from({ length: 14 }, (_, i) => 2.9 + (source.width - 5.8) * i / 13);
  const columnFeet = centers.map(u => {
    const x = source.origin[0] + source.tangent[0] * u - source.normal[0], n = source.origin[1] + source.tangent[1] * u - source.normal[1];
    return sampleTerrain(terrain, x, -n);
  });
  const facade = makeParliamentFacade(source, baseHeight, columnFeet), glb = new GlbBuilder('parliament-facade');
  const colours: Record<string, [number, number, number, number]> = { stone: [0.48, 0.415, 0.38, 1], joints: [0.30, 0.265, 0.25, 1], glass: [0.065, 0.105, 0.14, 1] };
  for (const [name, b] of Object.entries(facade.groups)) {
    const P = Float32Array.from(b.positions), I = Uint32Array.from(b.indices);
    await glb.addMesh({ name: `parliament_facade_${name}`, positions: P, normals: flatNormals(P, I), indices: I, materialName: `parliament_${name}` }, { name: `parliament_${name}`, baseColor: colours[name]!, unlit: false, roughness: name === 'glass' ? 0.45 : 0.95, doubleSided: true });
  }
  const bytes = await glb.toGlb('Parliament facade geometry: original Helsinki game authoring; source building City of Helsinki CC BY 4.0. Reference photographs are not embedded.', { building: PARLIAMENT_ID, vtj: PARLIAMENT_VTJ, columns: 14, visualApproximation: true, portico: 'solid collision retained; non-enterable' }, 'exact');
  const validation = await validateBytes(bytes, { maxIssues: 100 }); assert.equal(validation.issues.numErrors, 0, 'Facade GLB validation failed');
  const report = { status: 'BUILT_NOT_RUNTIME_REVIEWED', builtAt: new Date().toISOString(), id: 'parliament-mannerheim-facade-v1', building: PARLIAMENT_ID, vtj: PARLIAMENT_VTJ, originId: source.city.originId,
    toolSha256: sha(readFileSync(import.meta.filename)), source: source.source,
    inputs: { terrain: { path: terrainPath, sha256: sha(terrainBytes) }, osm: { path: osmArgument, sha256: sha(osmBytes) } },
    removedSourceTriangleIndices: source.removedIndices, removedSourceTrianglesRuntime: source.runtimeWall,
    frame: { originENU: source.origin, normalENU: source.normal, tangentENU: source.tangent, width: source.width, bottom: source.bottom, top: source.top },
    placement: { baseHeight, landingSamples, columnFeet, columnCenters: centers, columnCount: 14, columnHeightMetresApprox: 17, shaftTop: facade.shaftTop, oculusCount: facade.oculusCount, oculusCenters: facade.oculusCenters, lowerArchedBays: facade.lowerArchedBays, doorBays: facade.doorBays, depthRange: [-3.2, -0.002], depthLayers: { backing: -3.2, windowOutline: -3.1, glazing: -3.0, mullions: -2.9, doorPanel: -2.8, doorDivider: -2.7, doorHandles: -2.6, outerWall: -0.16, projectingBands: -0.002, oculusGlass: -0.32, oculusRim: -0.015 }, fineMortarStrips: 'omitted to avoid subpixel aliasing' },
    authoredApproximation: { portico: 'Exterior visual only; original solid building collider remains', capitalDetail: 'Simplified rectangular stylized capitals', windowsAndOculi: 'Reference-derived rhythm, approximate dimensions; 13 arched lower bays with three entrance doors, two rectangular upper tiers, and 15 glazed attic oculi; two farther blind stone roundels on adjacent piers are outside this central-wall correction and are not added', material: 'Original procedural warm granite colours; no reference pixels' },
    output: { file: 'parliament-facade.glb', bytes: bytes.length, sha256: sha(bytes) }, triangles: glb.stats.triangles, drawCalls: glb.stats.primitives, textureBytes: 0, validator: validation.issues };
  mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, report.output.file), bytes); writeFileSync(path.join(out, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  // Deterministic, uncompressed geometry for a CPU review plate and focused QA.
  writeFileSync(path.join(out, 'review-geometry.json'), JSON.stringify({ frame: report.frame, groups: facade.groups }) + '\n');
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'city-model': { type: 'string' }, terrain: { type: 'string' }, osm: { type: 'string' }, out: { type: 'string' } } });
  assert.ok(values['city-model'] && values.terrain && values.osm && values.out, '--city-model, --terrain, --osm and --out required');
  const report = await buildParliamentFacade(values['city-model'], values.terrain, values.osm, values.out);
  console.log(JSON.stringify({ status: report.status, output: report.output, triangles: report.triangles, drawCalls: report.drawCalls, baseHeight: report.placement.baseHeight }));
}
