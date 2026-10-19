// Finlandia Hall only. Architectural correspondence is recorded in the pinned chart catalogue.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FacadeRestorationModule, FacadeSources } from './facade-restoration-types.ts';

type Point = readonly [number, number];
type Vec3 = readonly [number, number, number];
type Box = readonly [number, number, number, number];
interface Triangle { xyz: Vec3[]; uv: Point[]; sourceTriangle: number }
interface Chart { id: string; page: number; normal: Vec3; profile: 'north-end'|'north-return'|'congress-end'|'congress-curves'; tris: Triangle[] }
interface Profile { protected: Box[]; minimumAlong?: number; marbleAbove?: number; windows?: Box[]; doors?: Box[]; endWindows?: Box[]; lowerGlassNorth?: Point; lowerGlassHeight?: Point; upperGlassNorth?: Point; upperGlassHeight?: Point; unresolved?: string }
const root = 'content/assets/facades/finlandia/';
export const FINLANDIA_MAPPING_SHA = '55b8edef83444a5760e603a10a5c5be2de379fcde00c8b1aeaf04113868b6638';
const bytes = readFileSync(new URL('../../../content/assets/facades/finlandia/wall-mapping.json', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== FINLANDIA_MAPPING_SHA) throw new Error('Finlandia chart catalogue changed; review facade correspondence');
export const finlandiaMapping = JSON.parse(bytes.toString()) as {
  building: { id: string; vtj: string }; charts: Chart[]; profiles: Record<Chart['profile'], Profile>;
  masters: { page: number; width: number; height: number; pngSha256: string }[];
};
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const fract = (value: number) => value - Math.floor(value);
const inBox = (x: number, height: number, b: Box) => x >= b[0] && x <= b[1] && height >= b[2] && height <= b[3];
function barycentric(p: Point, v: readonly Point[]): number[] | null {
  const [a,b,c] = v as [Point,Point,Point];
  const d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  if (Math.abs(d)<1e-12) return null;
  const aWeight=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/d;
  const bWeight=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/d;
  return aWeight>=0 && bWeight>=0 && aWeight+bWeight<=1 ? [aWeight,bWeight,1-aWeight-bWeight] : null;
}
function along(chart: Chart, p: Vec3): number { return chart.normal[1]*p[0]-chart.normal[0]*p[1]; }
function native(chartId: string, s: number, height: number, sources: FacadeSources): number[] {
  const chart=finlandiaMapping.charts.find(c=>c.id===chartId)!;
  for (const tri of chart.tris) {
    const weights=barycentric([s,height],tri.xyz.map(p=>[along(chart,p),p[2]]));
    if (!weights) continue;
    const uv=[0,1].map(k=>weights.reduce((sum,w,i)=>sum+w*tri.uv[i]![k]!,0));
    const source=sources.get(chart.page)!;
    const x=clamp(Math.floor(uv[0]!*source.width),0,source.width-1),y=clamp(Math.floor(uv[1]!*source.height),0,source.height-1);
    return Array.from(source.data.slice((y*source.width+x)*4,(y*source.width+x)*4+3));
  }
  throw new Error(`Finlandia donor outside pinned chart ${chartId}: ${s}, ${height}`);
}
function marble(chart: Chart, s: number, height: number, sources: FacadeSources): number[] {
  const north=chart.profile==='north-end'||chart.profile==='north-return';
  const donor=north ? native('1006-2',-27+fract(s*.13)*.7,10.75+fract(height*.19)*.25,sources)
    : native('1016-18',1027+fract(s*.13),8+fract(height*.19),sources);
  // Panel dimensions and fine marble detail are authored approximations, confirmed as marble
  // rather than openings by the official elevations and architect's 2024 exterior photographs.
  const column=Math.floor(s/.85),horizontal=fract((height+(column%2)*.67)/1.34),vertical=fract(s/.85);
  const joint=vertical<.018||horizontal<.014;
  const light=north?1:clamp(.82+chart.normal[1]*.11,.69,.95);
  return donor.map(v=>v*light*(joint?.88:1));
}
function granite(s: number, height: number, sources: FacadeSources): number[] {
  return native('1013-0',-82+fract(s*.23)*.2,-.2+fract(height*.17)*.15,sources).map(v=>v*.72);
}
function glazing(s: number, height: number, bounds: Box, sources: FacadeSources, tall=false): number[] {
  const edge=Math.min(s-bounds[0],bounds[1]-s,height-bounds[2],bounds[3]-height);
  const mullion=fract((s-bounds[0])/(tall?1.25:1.15));
  if(edge<.06 || mullion<.04 || (tall && Math.abs(height-11.7)<.045)) return [65,72,73];
  // Same-building clear glazing is a colour/material donor; no reflected tree pixels copied.
  const base=native('1013-0',-69.9+fract(s*.1)*.08,.55+fract(height*.1)*.05,sources);
  return base.map((v,k)=>v*(tall?.75:.9)+(k===2?4:0));
}

/** Returns null for intentionally retained architecture and the unresolved lower end wall. */
export function finlandiaPixel(chart: Chart, east: number, north: number, height: number, sources: FacadeSources): number[] | null {
  const profile=finlandiaMapping.profiles[chart.profile],s=chart.normal[1]*east-chart.normal[0]*north;
  const x=chart.profile==='congress-curves'?north:s;
  if(profile.protected.some(b=>inBox(x,height,b))) return null;
  if(chart.profile==='congress-end') return height>profile.marbleAbove! ? marble(chart,s,height,sources) : granite(s,height,sources);
  if(chart.profile==='north-end'||chart.profile==='north-return') {
    if(s<profile.minimumAlong!) return null;
    for(const b of [...profile.windows??[],...profile.doors??[]]) if(inBox(s,height,b)) return glazing(s,height,b,sources);
    return height>profile.marbleAbove! ? marble(chart,s,height,sources) : granite(s,height,sources);
  }
  // Each interval is pinned to the specific congress elevation, not a city-wide foliage filter.
  const lower=[...profile.lowerGlassNorth!,...profile.lowerGlassHeight!] as Box;
  const upper=[...profile.upperGlassNorth!,...profile.upperGlassHeight!] as Box;
  for(const b of [lower,upper,...profile.endWindows??[],...profile.doors??[]]) if(inBox(north,height,b)) return glazing(north,height,b,sources,b===upper);
  return height>2.45 ? marble(chart,north,height,sources) : granite(north,height,sources);
}

export const finlandiaRestoration: FacadeRestorationModule = {
  id:'finlandia-hall-reference-bound',targetPages:[1006,1008,1011,1013,1016],sourcePages:[1006,1008,1011,1013,1016],
  supportFiles:[{file:root+'wall-mapping.json',sha256:FINLANDIA_MAPPING_SHA},{file:root+'source-ledger.json',sha256:'705fe1333ee8da2e01ae5498a123c0df24385139776213491a1af6b1d147151d'}],
  apply(page,rgba,width,height,sources) {
    if(!this.targetPages.includes(page)) return [];
    for(const master of finlandiaMapping.masters) {
      const image=sources.get(master.page);
      if(!image||image.pngSha256!==master.pngSha256||image.width!==master.width||image.height!==master.height||image.data.length!==master.width*master.height*4) throw new Error(`Finlandia master ${master.page} changed; review source mapping`);
    }
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<128||height<128||rgba.length!==width*height*4) throw new Error('Finlandia target dimensions invalid');
    const evidence=[];
    for(const chart of finlandiaMapping.charts.filter(c=>c.page===page)) {
      const changed=new Set<number>();
      for(const tri of chart.tris) {
        const xs=tri.uv.map(p=>p[0]*width),ys=tri.uv.map(p=>p[1]*height);
        for(let y=Math.max(0,Math.floor(Math.min(...ys)));y<Math.min(height,Math.ceil(Math.max(...ys)));y++) for(let x=Math.max(0,Math.floor(Math.min(...xs)));x<Math.min(width,Math.ceil(Math.max(...xs)));x++) {
          const weights=barycentric([(x+.5)/width,(y+.5)/height],tri.uv);if(!weights) continue;
          const p=[0,1,2].map(k=>weights.reduce((sum,w,i)=>sum+w*tri.xyz[i]![k]!,0));
          const rgb=finlandiaPixel(chart,p[0]!,p[1]!,p[2]!,sources);if(!rgb) continue;
          const offset=(y*width+x)*4;for(let k=0;k<3;k++) rgba[offset+k]=Math.round(clamp(rgb[k]!,0,255));
          changed.add(offset/4);
        }
      }
      if(changed.size) evidence.push({id:chart.id,page,changedTexels:changed.size,profile:chart.profile,limits:'Exact Finlandia wall triangles only; original authored architecture with approximate panel/frame dimensions, same-building licensed material donors. Existing source windows/stair and all alpha retained. 1016-18 central bank and two lower entrance columns below Y 1.7 remain source pixels; the exposed Y 1.7..2.2 bands use the existing granite donor. Geometry unchanged.'});
    }
    return evidence;
  },
};
