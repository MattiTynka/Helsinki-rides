// Explicit, source-bound charts for existing untextured walls. This module
// projects material coordinates; it never creates or moves architectural faces.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import type {RgbaImage} from './gltf.ts';

export type FacadePoint = readonly [number, number, number];
export type FacadeTriangle = readonly [FacadePoint, FacadePoint, FacadePoint];
export interface FacadeChart {
  readonly id: string;
  readonly building: string;
  readonly origin: FacadePoint;
  readonly uAxis: FacadePoint;
  readonly vAxis: FacadePoint;
  /** Physical chart bounds: minU, minV, maxU, maxV, in metres. */
  readonly bounds: readonly [number, number, number, number];
  /** Content rectangle in the dedicated atlas: x, y, width, height. */
  readonly pixels: readonly [number, number, number, number];
  readonly planeToleranceMetres: number;
}
export interface FacadeChartTarget {
  readonly node: string;
  readonly primitive: number;
  readonly triangle: number;
  readonly key: string;
  readonly chart: string;
}
export interface FacadeChartCell {
  readonly id: string;
  readonly lod0Sha256: string;
  readonly lod2Sha256: string;
  readonly buildings: readonly {readonly id: string; readonly vtj: string | null}[];
  readonly detailed: readonly FacadeChartTarget[];
  readonly distant: readonly FacadeChartTarget[];
}
export interface FacadeChartProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly baseCellsIndexSha256: string;
  readonly source: {readonly cityJsonSha256: string; readonly cityBinSha256: string; readonly originId: string};
  readonly art: {readonly path: string; readonly sha256: string; readonly width: number; readonly height: number;
    readonly kind: 'original-procedural' | 'licensed-original'; readonly license: string; readonly attribution: string;
    readonly references: readonly {readonly title: string; readonly url: string; readonly role: 'appearance-reference-only'}[]};
  /** Full RGBA8 mip-chain estimate, including duplicated owner-cell instances. */
  readonly maximumFallbackBytes: number;
  readonly material: {readonly name: string; readonly unlit: boolean; readonly roughness: number; readonly doubleSided: boolean};
  readonly charts: readonly FacadeChart[];
  readonly cells: readonly FacadeChartCell[];
}
export const facadeChartSha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const hash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const finite = (a: readonly number[]) => a.every(Number.isFinite);
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
const difference = (a: FacadePoint, b: FacadePoint): FacadePoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: FacadePoint, b: FacadePoint): FacadePoint => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const keys = (x: object, expected: readonly string[]) => assert.deepEqual(Object.keys(x).sort(), [...expected].sort(), 'Unexpected or missing facade profile fields');

/** Cyclic rotation is immaterial; reversed winding and every Float32 bit remain distinct. */
export function facadeTriangleKey(triangle: FacadeTriangle): string {
  const vertex = (v: FacadePoint) => {
    assert.ok(finite(v)); const bytes = Buffer.alloc(12);
    for (let k = 0; k < 3; k++) bytes.writeFloatLE(Math.fround(v[k]!), k*4);
    return bytes.toString('hex');
  };
  const v = triangle.map(vertex);
  return [0,1,2].map(i => [v[i],v[(i+1)%3],v[(i+2)%3]].join(':')).sort()[0]!;
}

/** Exact integer mip accounting also applies to non-power-of-two atlases. */
export function facadeAtlasBytes(width: number, height: number, bytesPerTexel = 4): number {
  assert.ok(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0);
  assert.ok(Number.isSafeInteger(bytesPerTexel) && bytesPerTexel > 0);
  let sum = 0, w = width, h = height;
  for (;;) { sum += w*h*bytesPerTexel; if (w === 1 && h === 1) return sum; w = Math.max(1, Math.floor(w/2)); h = Math.max(1, Math.floor(h/2)); }
}
/** BC7/ASTC-4x4 account for a complete 16-byte block even in the last mips. */
export function facadeAtlasBc7Bytes(width:number,height:number):number {
  facadeAtlasBytes(width,height);let sum=0,w=width,h=height;
  for(;;){sum+=Math.ceil(w/4)*Math.ceil(h/4)*16;if(w===1&&h===1)return sum;w=Math.max(1,Math.floor(w/2));h=Math.max(1,Math.floor(h/2));}
}

export function validateFacadeChartProfile(value: unknown): asserts value is FacadeChartProfile {
  assert.ok(value && typeof value === 'object'); const p = value as FacadeChartProfile;
  keys(p, ['schemaVersion','id','baseCellsIndexSha256','source','art','maximumFallbackBytes','material','charts','cells']);
  assert.equal(p.schemaVersion, 1); assert.ok(typeof p.id === 'string' && p.id.length > 0); assert.ok(hash(p.baseCellsIndexSha256));
  keys(p.source, ['cityJsonSha256','cityBinSha256','originId']);
  assert.ok(hash(p.source.cityJsonSha256) && hash(p.source.cityBinSha256) && p.source.originId);
  keys(p.art, ['path','sha256','width','height','kind','license','attribution','references']);
  assert.ok(hash(p.art.sha256) && p.art.path && p.art.license && p.art.attribution);
  assert.ok(['original-procedural','licensed-original'].includes(p.art.kind), 'Only original or licensed source art may ship');
  assert.ok(p.art.width <= 768 && p.art.height <= 768, 'Facade atlas side cap is 768 pixels');
  assert.ok(Array.isArray(p.art.references));
  for (const r of p.art.references) { keys(r,['title','url','role']); assert.ok(r.title && /^https:\/\//.test(r.url)); assert.equal(r.role,'appearance-reference-only'); }
  keys(p.material,['name','unlit','roughness','doubleSided']);
  assert.ok(p.material.name && typeof p.material.unlit === 'boolean' && typeof p.material.doubleSided === 'boolean');
  assert.ok(Number.isFinite(p.material.roughness) && p.material.roughness >= 0 && p.material.roughness <= 1);
  assert.ok(Array.isArray(p.cells) && p.cells.length > 0 && new Set(p.cells.map(c=>c.id)).size === p.cells.length);
  assert.ok(p.maximumFallbackBytes > 0 && p.maximumFallbackBytes <= 3*1024*1024, 'Authored facade fallback cap must be at most 3 MiB');
  assert.ok(facadeAtlasBytes(p.art.width,p.art.height)*p.cells.length <= p.maximumFallbackBytes, 'Aggregate owner-cell atlas fallback estimate exceeds cap');
  assert.ok(Array.isArray(p.charts) && p.charts.length > 0 && new Set(p.charts.map(c=>c.id)).size === p.charts.length);
  const chartIds = new Set(p.charts.map(c=>c.id));
  for (const c of p.charts) {
    keys(c,['id','building','origin','uAxis','vAxis','bounds','pixels','planeToleranceMetres']);
    assert.ok(c.id && c.building && c.origin.length === 3 && c.uAxis.length === 3 && c.vAxis.length === 3 && finite([...c.origin,...c.uAxis,...c.vAxis]));
    assert.ok(Math.abs(dot(c.uAxis,c.uAxis)-1) < 1e-8 && Math.abs(dot(c.vAxis,c.vAxis)-1) < 1e-8 && Math.abs(dot(c.uAxis,c.vAxis)) < 1e-8, 'Chart axes must be orthonormal');
    assert.ok(Math.abs(c.vAxis[1]-1) < 1e-8, 'Wall charts must have a vertical upward V axis');
    assert.ok(c.bounds.length === 4 && finite(c.bounds) && c.bounds[2] > c.bounds[0] && c.bounds[3] > c.bounds[1]);
    assert.ok(c.pixels.length === 4 && c.pixels.every(Number.isSafeInteger) && c.pixels[0] >= 1 && c.pixels[1] >= 1 && c.pixels[2] >= 2 && c.pixels[3] >= 2);
    assert.ok(c.pixels[0]+c.pixels[2] < p.art.width && c.pixels[1]+c.pixels[3] < p.art.height, 'Atlas charts require an outer gutter');
    assert.ok(c.planeToleranceMetres >= 0 && c.planeToleranceMetres <= .002, 'Chart plane tolerance is bounded to 2 mm');
  }
  for (const c of p.cells) {
    keys(c,['id','lod0Sha256','lod2Sha256','buildings','detailed','distant']); assert.ok(c.id && hash(c.lod0Sha256) && hash(c.lod2Sha256));
    assert.ok(c.buildings.length > 0 && new Set(c.buildings.map((b:FacadeChartCell['buildings'][number])=>b.id)).size === c.buildings.length);
    for(const b of c.buildings){keys(b,['id','vtj']);assert.ok(b.id && (b.vtj === null || typeof b.vtj === 'string'));}
    for (const list of [c.detailed,c.distant]) {
      assert.ok(list.length > 0); const seen = new Set<string>();
      for (const t of list) {
        keys(t,['node','primitive','triangle','key','chart']); assert.ok(t.node && Number.isSafeInteger(t.primitive) && t.primitive >= 0 && Number.isSafeInteger(t.triangle) && t.triangle >= 0);
        assert.ok(/^[0-9a-f]{24}:[0-9a-f]{24}:[0-9a-f]{24}$/.test(t.key) && chartIds.has(t.chart));
        const chart = p.charts.find(q=>q.id === t.chart)!; assert.ok(c.buildings.some((b:FacadeChartCell['buildings'][number])=>b.id === chart.building));
        const k = `${t.node}:${t.primitive}:${t.triangle}`; assert.ok(!seen.has(k),'Duplicate facade target'); seen.add(k);
      }
    }
  }
}

export function projectFacadePoint(point: FacadePoint, chart: FacadeChart): readonly [number,number] {
  const delta = difference(point,chart.origin), normal = cross(chart.uAxis,chart.vAxis);
  assert.ok(Math.abs(dot(delta,normal)) <= chart.planeToleranceMetres + 1e-9, `Point is outside chart ${chart.id} plane`);
  const u = dot(delta,chart.uAxis), v = dot(delta,chart.vAxis), b = chart.bounds;
  assert.ok(u >= b[0]-1e-6 && u <= b[2]+1e-6 && v >= b[1]-1e-6 && v <= b[3]+1e-6, `Point is outside chart ${chart.id} bounds`);
  return [u,v];
}

export function facadeChartUv(point: FacadePoint, chart: FacadeChart, width: number, height: number): readonly [number,number] {
  const [u,v] = projectFacadePoint(point,chart), b = chart.bounds, p = chart.pixels;
  // Pixel centres keep the texture footprint inside its authored content/gutter.
  return [(p[0]+.5+(u-b[0])/(b[2]-b[0])*(p[2]-1))/width,
    (p[1]+.5+(b[3]-v)/(b[3]-b[1])*(p[3]-1))/height];
}

export function validateFacadeTriangle(triangle: FacadeTriangle, chart: FacadeChart): void {
  const n = cross(difference(triangle[1],triangle[0]),difference(triangle[2],triangle[0])), length = Math.hypot(...n);
  assert.ok(length > 0 && Math.abs(n[1]/length) < .3, 'Only existing nondegenerate exterior wall faces may receive charts');
  for (const p of triangle) projectFacadePoint(p,chart);
}

const area = (polygons: polygonClipping.MultiPolygon) => polygons.reduce((total, poly) => total+poly.reduce((sum,ring,i)=>{
  let a=0; for(let k=0;k+1<ring.length;k++)a+=ring[k]![0]*ring[k+1]![1]-ring[k+1]![0]*ring[k]![1]; return sum+(i?-1:1)*Math.abs(a)/2;
},0),0);
/** A distant face must lie wholly inside the selected detailed wall union. */
export function proveFacadeCoverage(coarse: FacadeTriangle, detailed: readonly FacadeTriangle[], chart: FacadeChart) {
  validateFacadeTriangle(coarse,chart); assert.ok(detailed.length > 0);
  const normal=(t:FacadeTriangle)=>cross(difference(t[1],t[0]),difference(t[2],t[0])),a=normal(coarse),b=normal(detailed[0]!);
  assert.ok(dot(a,b)>0,'Distant correspondence has reversed source winding');
  const polygon = (t: FacadeTriangle): polygonClipping.Polygon => { validateFacadeTriangle(t,chart); const p=t.map(v=>projectFacadePoint(v,chart) as [number,number]); return [[...p,p[0]!]]; };
  const polygons=detailed.map(polygon), source = polygonClipping.union(polygons[0]!,...polygons.slice(1)), target = polygon(coarse), outside = area(polygonClipping.difference(target,source));
  assert.ok(outside <= 1e-8, `Distant facade extends outside selected source faces (${outside} m²)`);
  return {outsideAreaMetres2:outside, selectedDetailedTriangles:detailed.length, coplanar:true};
}

export function sampleFacadeChartColour(point: FacadePoint, chart: FacadeChart, image: RgbaImage): readonly [number,number,number] {
  assert.equal(image.data.length,image.width*image.height*4);
  const [u,v]=facadeChartUv(point,chart,image.width,image.height), x=Math.min(image.width-1,Math.max(0,Math.floor(u*image.width))), y=Math.min(image.height-1,Math.max(0,Math.floor(v*image.height))), k=(y*image.width+x)*4;
  assert.equal(image.data[k+3],255,'Facade art must be opaque');
  const linear=(v:number)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
  return [linear(image.data[k]!/255),linear(image.data[k+1]!/255),linear(image.data[k+2]!/255)];
}
