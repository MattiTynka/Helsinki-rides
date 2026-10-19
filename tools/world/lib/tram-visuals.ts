// Offline tram detail. Source track axes determine X/Z; the final decoded
// upward ground envelope determines Y. Nothing here changes physical ground.
import assert from 'node:assert/strict';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import {certifyTramCoverageFringes} from './tram-coverage.ts';

export type TramPoint = [number, number];
export type TramVertex = [number, number, number];
type Polygon = polygonClipping.Polygon;
type MultiPolygon = polygonClipping.MultiPolygon;
// Boolean construction uses a micrometre integer grid. It prevents nearly
// coincident source turnout edges from producing unclosed sweep-line rings;
// original axes/floors are untouched and final Float32 resolution is coarser.
export const TRAM_BOOLEAN_GRID_METRES=.000001;
export interface TramTrack {
  wayId: number;
  points: readonly {nodeId:number; x:number; z:number}[];
  tags: Readonly<Record<string,string>>;
}
export interface TramBounds {minX:number; maxX:number; minZ:number; maxZ:number}
export interface TramProfile {
  gaugeMetres:number;
  headWidthMetres:number;
  grooveWidthMetres:number;
  guardWidthMetres:number;
  liftMetres:number;
  maximumMiterRatio:number;
}
export const DEFAULT_TRAM_PROFILE: Readonly<TramProfile> = Object.freeze({
  gaugeMetres:1, headWidthMetres:.060, grooveWidthMetres:.035,
  guardWidthMetres:.015, liftMetres:.003, maximumMiterRatio:2,
});
export interface TramFootprint {
  wayId:number;
  segment:number;
  kind:'head'|'groove'|'guard';
  polygon:TramPoint[];
  side:-1|1;
  textureMapping:{origin:TramPoint;normal:TramPoint};
}
export interface TramGroundTriangle {
  id:string;
  vertices:[TramVertex,TramVertex,TramVertex];
  visual:{node:string; primitive:number; triangle:number};
  collision:{collider:string; triangles:number[]};
  tag:string;
}
export interface TramMesh {
  positions:number[]; normals:number[]; colours:number[]; uvs:number[]; indices:number[];
  bindings:{ground:TramGroundTriangle; triangles:number; wayIds:number[]}[];
  stats:{expectedArea:number; coveredArea:number; missingArea:number; maximumLiftError:number; triangles:number};
  coverage?:{missingPolygons:MultiPolygon;fringes:TramCoverageFringe[];qualifiedNumericalArea:number;unresolvedArea:number};
}
export interface TramCoverageFringe {
  polygon:Polygon;area:number;minimumContainingWidth:number;maximumDistanceToGroundUpperBound:number;
  f32HalfUlpXZ:[number,number];booleanAllowance:number;allowedDistance:number;qualified:boolean;
}
const cross=(a:TramPoint,b:TramPoint,c:TramPoint)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const area=(ring:readonly TramPoint[])=>Math.abs(ring.reduce((n,p,i)=>{const q=ring[(i+1)%ring.length]!;return n+p[0]*q[1]-p[1]*q[0];},0))/2;
const multiArea=(polygons:MultiPolygon)=>polygons.reduce((n,p)=>n+p.reduce((m,r,i)=>m+(i===0?1:-1)*area(r),0),0);
const close=(r:readonly TramPoint[]):Polygon=>[[...r.map(p=>[...p] as TramPoint),[...r[0]!] as TramPoint]];
const boundsRing=(b:TramBounds):TramPoint[]=>[[b.minX,b.minZ],[b.maxX,b.minZ],[b.maxX,b.maxZ],[b.minX,b.maxZ]];
const box=(r:readonly TramPoint[])=>[Math.min(...r.map(p=>p[0])),Math.min(...r.map(p=>p[1])),Math.max(...r.map(p=>p[0])),Math.max(...r.map(p=>p[1]))] as const;
const boxesTouch=(a:readonly number[],b:readonly number[])=>a[0]!<=b[2]!&&a[2]!>=b[0]!&&a[1]!<=b[3]!&&a[3]!>=b[1]!;
const integer=(p:Polygon|MultiPolygon):any=>Array.isArray(p[0]?.[0]?.[0])?(p as MultiPolygon).map(integer):(p as Polygon).map(r=>r.map(([x,z])=>[Math.round(x/TRAM_BOOLEAN_GRID_METRES),Math.round(z/TRAM_BOOLEAN_GRID_METRES)]));
const metres=(p:MultiPolygon):MultiPolygon=>p.map(poly=>poly.map(r=>r.map(([x,z])=>[x*TRAM_BOOLEAN_GRID_METRES,z*TRAM_BOOLEAN_GRID_METRES])));
const union=(polygons:Polygon[]):MultiPolygon=>polygons.length?metres(polygonClipping.union(integer(polygons[0]!),...polygons.slice(1).map(integer))):[];
const intersection=(a:Polygon|MultiPolygon,b:Polygon|MultiPolygon):MultiPolygon=>metres(polygonClipping.intersection(integer(a),integer(b)));
const difference=(a:MultiPolygon,b:MultiPolygon):MultiPolygon=>!a.length?[]:!b.length?a:metres(polygonClipping.difference(integer(a),integer(b)));

function validateProfile(profile:TramProfile) {
  for(const value of Object.values(profile))assert.ok(Number.isFinite(value)&&value>0,'Tram profile requires positive finite measurements');
  assert.equal(profile.gaugeMetres,1,'This profile is bound to Helsinki 1000mm gauge');
  assert.ok(profile.liftMetres<=.003,'Embedded own-lane rail may rise at most3mm above paving');
  assert.ok(profile.grooveWidthMetres+profile.guardWidthMetres<profile.gaugeMetres/2);
  assert.ok(profile.maximumMiterRatio<=2);
}

/** Offset the measuring faces, not the steel ribbon centre: the inner gauge
 * stays exactly1m even though steel heads have nonzero width. Shared degree-two
 * OSM nodes use the same continuation tangent across way boundaries. */
export function tramFootprints(tracks:readonly TramTrack[],profile:TramProfile=DEFAULT_TRAM_PROFILE):TramFootprint[] {
  validateProfile(profile);
  const points=new Map<number,TramPoint>(),neighbours=new Map<number,Set<number>>();
  for(const track of tracks){
    assert.ok(Number.isSafeInteger(track.wayId)&&track.wayId>0&&track.points.length>=2,'Invalid source tram way');
    assert.equal(track.tags.railway,'tram','Only actual railway=tram axes can author rails');
    assert.ok(!['yes','building_passage'].includes(track.tags.tunnel??''),'Underground tracks need an explicit separate rendering authority');
    assert.ok(!track.tags.tracks||track.tags.tracks==='1','A multiple-track source axis must not invent parallel track locations');
    for(const p of track.points){
      assert.ok(Number.isSafeInteger(p.nodeId)&&p.nodeId>0&&Number.isFinite(p.x)&&Number.isFinite(p.z));
      const prior=points.get(p.nodeId);if(prior)assert.deepEqual(prior,[p.x,p.z],'OSM node coordinates differ between ways');else points.set(p.nodeId,[p.x,p.z]);
    }
    for(let i=1;i<track.points.length;i++)for(const[a,b]of[[track.points[i-1]!,track.points[i]!],[track.points[i]!,track.points[i-1]!]] as const){
      assert.ok(Math.hypot(a.x-b.x,a.z-b.z)>1e-6,'Coincident source nodes do not determine a rail tangent');
      const set=neighbours.get(a.nodeId)??new Set<number>();set.add(b.nodeId);neighbours.set(a.nodeId,set);
    }
  }
  const result:TramFootprint[]=[];
  for(const track of tracks){
    const offsets=track.points.map((p,i)=>{
      let previous=i>0?track.points[i-1]!.nodeId:undefined,next=i+1<track.points.length?track.points[i+1]!.nodeId:undefined;
      const adjacent=[...neighbours.get(p.nodeId)!];
      if(adjacent.length===2){
        const a=points.get(adjacent[0]!)!,b=points.get(adjacent[1]!)!;
        // Two selected outgoing branches at a cut turnout are not a through
        // continuation. Inferring one would create a giant backwards miter.
        const opposite=(a[0]-p.x)*(b[0]-p.x)+(a[1]-p.z)*(b[1]-p.z)<0;
        if(opposite){if(previous===undefined)previous=adjacent.find(n=>n!==next);if(next===undefined)next=adjacent.find(n=>n!==previous);}
      }
      const here:TramPoint=[p.x,p.z];
      const normal=(a:TramPoint,b:TramPoint):TramPoint=>{const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);assert.ok(length>0);return[-dz/length,dx/length];};
      const before=previous===undefined?null:normal(points.get(previous)!,here),after=next===undefined?null:normal(here,points.get(next)!);
      if(!before)return after!;if(!after)return before;
      const sum:TramPoint=[before[0]+after[0],before[1]+after[1]],denominator=sum[0]*after[0]+sum[1]*after[1];
      assert.ok(denominator>1e-8,`Source tram${track.wayId} reverses direction at node${p.nodeId}`);
      const offset:TramPoint=[sum[0]/denominator,sum[1]/denominator];
      assert.ok(Math.hypot(...offset)<=profile.maximumMiterRatio,`Source tram${track.wayId} has an unresolved sharp bend at node${p.nodeId}`);
      return offset;
    });
    for(let segment=0;segment<track.points.length-1;segment++){
      const a=track.points[segment]!,b=track.points[segment+1]!,na=offsets[segment]!,nb=offsets[segment+1]!;
      const bands:[TramFootprint['kind'],number,number][]=[['head',.5,.5+profile.headWidthMetres],['groove',.5-profile.grooveWidthMetres,.5],['guard',.5-profile.grooveWidthMetres-profile.guardWidthMetres,.5-profile.grooveWidthMetres]];
      for(const sign of [-1,1])for(const[kind,inner,outer]of bands){
        const d0=Math.min(inner*sign,outer*sign),d1=Math.max(inner*sign,outer*sign);
        const polygon:TramPoint[]=[[a.x+na[0]*d0,a.z+na[1]*d0],[b.x+nb[0]*d0,b.z+nb[1]*d0],[b.x+nb[0]*d1,b.z+nb[1]*d1],[a.x+na[0]*d1,a.z+na[1]*d1]];
        assert.ok(area(polygon)>1e-12,'Degenerate source rail footprint');
        const length=Math.hypot(b.x-a.x,b.z-a.z);
        result.push({wayId:track.wayId,segment,kind,polygon,side:sign as -1|1,textureMapping:{origin:[a.x,a.z],normal:[-(b.z-a.z)/length,(b.x-a.x)/length]}});
      }
    }
  }
  return result;
}

function plane(triangle:TramGroundTriangle) {
  const[a,b,c]=triangle.vertices,u=b.map((v,i)=>v-a[i]!),v=c.map((n,i)=>n-a[i]!);
  const n:TramVertex=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],length=Math.hypot(...n);
  assert.ok(length>0&&n[1]/length>.3,`Rail support${triangle.id} must be upward nonvertical ground`);
  const normal=n.map(x=>x/length) as TramVertex;
  const y=(p:TramPoint)=>a[1]-(n[0]*(p[0]-a[0])+n[2]*(p[1]-a[2]))/n[1];
  const ring=triangle.vertices.map(p=>[p[0],p[2]] as TramPoint),bbox=box(ring);
  return{triangle,normal,y,ring,bbox};
}

/** Keep a convex polygon on the nonnegative side of a linear function. This
 * also splits crossing ground planes instead of choosing one centroid height. */
function positiveHalfPlane(ring:readonly TramPoint[],value:(p:TramPoint)=>number):TramPoint[] {
  const result:TramPoint[]=[];
  for(let i=0;i<ring.length;i++){
    const a=ring[i]!,b=ring[(i+1)%ring.length]!,va=value(a),vb=value(b),insideA=va>=0,insideB=vb>=0;
    if(insideA)result.push(a);
    if(insideA!==insideB){const t=va/(va-vb);result.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
  }
  return result;
}
function convexIntersection(a:readonly TramPoint[],b:readonly TramPoint[]):TramPoint[]{
  let result=[...a];const orientation=Math.sign(cross(b[0]!,b[1]!,b[2]!));
  for(let i=0;i<b.length&&result.length>=3;i++){const p=b[i]!,q=b[(i+1)%b.length]!;result=positiveHalfPlane(result,r=>cross(p,q,r)*orientation);}
  return result;
}

/** Union source ribbons before draping: turnout and crossing rail intersections
 * share one surface instead of adding coplanar duplicate strips. */
export function drapeTramFootprints(footprints:readonly TramFootprint[],ground:readonly TramGroundTriangle[],bounds:TramBounds,coarse=false,profile:TramProfile=DEFAULT_TRAM_PROFILE):TramMesh {
  validateProfile(profile);
  assert.ok(bounds.maxX>bounds.minX&&bounds.maxZ>bounds.minZ);
  const boundsPolygon=close(boundsRing(bounds)),cellBox=[bounds.minX,bounds.minZ,bounds.maxX,bounds.maxZ];
  const relevantKeys=new Set(footprints.filter(f=>boxesTouch(box(f.polygon),cellBox)).map(f=>`${f.wayId}:${f.segment}:${f.side}`));
  const selected=footprints.filter(f=>relevantKeys.has(`${f.wayId}:${f.segment}:${f.side}`)&&(coarse?f.kind==='head':true));
  const byKind=(kind:TramFootprint['kind'])=>selected.filter(f=>f.kind===kind).map(f=>close(f.polygon));
  const targets:{polygon:MultiPolygon;colour:TramVertex;uv:(p:TramPoint)=>number}[]=[];
  if(coarse)targets.push({polygon:intersection(union(byKind('head')),boundsPolygon),colour:[.49,.52,.54],uv:()=>.75});
  else{
    const groups=new Map<string,{head?:TramFootprint;guard?:TramFootprint}>();
    for(const f of selected){const key=`${f.wayId}:${f.segment}:${f.side}`,group=groups.get(key)??{};if(f.kind==='head')group.head=f;if(f.kind==='guard')group.guard=f;groups.set(key,group);}
    let claimed:MultiPolygon=[];
    for(const key of [...groups.keys()].sort()){
      const{head,guard}=groups.get(key)!;assert.ok(head&&guard,'A source rail ribbon requires its complete cross section');
      const full=head.side===1?[guard.polygon[0]!,guard.polygon[1]!,head.polygon[2]!,head.polygon[3]!]:[head.polygon[0]!,head.polygon[1]!,guard.polygon[2]!,guard.polygon[3]!];
      const clipped=intersection(close(full),boundsPolygon),owned=difference(clipped,claimed);claimed=union([...claimed,...clipped]);
      if(!owned.length)continue;
      const{origin,normal}=head.textureMapping,width=profile.headWidthMetres+profile.grooveWidthMetres+profile.guardWidthMetres,inner=profile.gaugeMetres/2-profile.grooveWidthMetres-profile.guardWidthMetres;
      targets.push({polygon:owned,colour:[1,1,1],uv:p=>(head.side*((p[0]-origin[0])*normal[0]+(p[1]-origin[1])*normal[1])-inner)/width});
    }
  }
  const sourceBoxes=selected.map(f=>box(f.polygon));
  const surfaces=ground.filter(t=>{const b=box(t.vertices.map(p=>[p[0],p[2]] as TramPoint));return boxesTouch(b,cellBox)&&sourceBoxes.some(s=>boxesTouch(b,s));}).map(plane).sort((a,b)=>a.triangle.id.localeCompare(b.triangle.id));
  const result:TramMesh={positions:[],normals:[],colours:[],uvs:[],indices:[],bindings:[],stats:{expectedArea:targets.reduce((n,t)=>n+multiArea(t.polygon),0),coveredArea:0,missingArea:0,maximumLiftError:0,triangles:0}};
  const coveredPolygons:Polygon[]=[];
  for(let surfaceIndex=0;surfaceIndex<surfaces.length;surfaceIndex++){
    const surface=surfaces[surfaceIndex]!,bindings:number[]=[];
    const obscurers:Polygon[]=[];
    for(let otherIndex=0;otherIndex<surfaces.length;otherIndex++){
      if(otherIndex===surfaceIndex)continue;const other=surfaces[otherIndex]!;if(!boxesTouch(surface.bbox,other.bbox))continue;
      const common=convexIntersection(surface.ring,other.ring);
      if(common.length<3||area(common)<=1e-10)continue;
      const deltas=other.ring.map(p=>other.y(p)-surface.y(p));
      // On exactly coplanar duplicate surfaces, the stable source order owns the
      // intersection once. Otherwise use the actual highest visible envelope.
      const coplanar=deltas.every(d=>Math.abs(d)<=1e-8);
      if(coplanar){if(otherIndex<surfaceIndex)obscurers.push(close(other.ring));continue;}
      if(deltas.every(d=>d<=0))continue;
      const above=positiveHalfPlane(other.ring,p=>other.y(p)-surface.y(p));
      if(above.length>=3&&area(above)>1e-12)obscurers.push(close(above));
    }
    const hidden=union(obscurers);
    let added=0;const contributing=new Set<number>();
    for(const target of targets){
      if(!target.polygon.length)continue;
      if(!target.polygon.some(p=>boxesTouch(box(p[0]!),surface.bbox)))continue;
      const clipped=difference(intersection(target.polygon,close(surface.ring)),hidden);coveredPolygons.push(...clipped);
      result.stats.coveredArea+=multiArea(clipped);
      for(const polygon of clipped){
        const flat:number[]=[],holes:number[]=[];
        polygon.forEach((ring,i)=>{if(i)holes.push(flat.length/2);const open=ring.length>1&&ring[0]![0]===ring[ring.length-1]![0]&&ring[0]![1]===ring[ring.length-1]![1]?ring.slice(0,-1):ring;for(const p of open)flat.push(...p);});
        const indices=earcut(flat,holes,2);
        for(let i=0;i<indices.length;i+=3){
          let points=indices.slice(i,i+3).map(id=>[Math.fround(flat[id*2]!),Math.fround(surface.y([flat[id*2]!,flat[id*2+1]!])+profile.liftMetres),Math.fround(flat[id*2+1]!)] as TramVertex);
          let signed=cross([points[0]![0],points[0]![2]],[points[1]![0],points[1]![2]],[points[2]![0],points[2]![2]]);
          if(signed===0)continue;if(signed>0){points=[points[0]!,points[2]!,points[1]!];signed=-signed;}
          assert.ok(signed<0,'Tram ribbon must face upward');
          const first=result.positions.length/3;
          for(const p of points){const error=Math.abs(p[1]-surface.y([p[0],p[2]])-profile.liftMetres);result.stats.maximumLiftError=Math.max(result.stats.maximumLiftError,error);assert.ok(error<=.0001,'Float32 rail exceeded0.1mm support precision');result.positions.push(...p);result.normals.push(...surface.normal);result.colours.push(...target.colour);result.uvs.push(Math.max(0,Math.min(1,target.uv([p[0],p[2]]))),.5);}
          result.indices.push(first,first+1,first+2);added++;
        }
        const pb=box(polygon[0]!);
        // Conservative source membership avoids a second Boolean operation on
        // coincident turnout boundaries. Exact authoring polygons are retained
        // in the hash-bound profile; these IDs are candidate contributors.
        for(const source of selected)if(boxesTouch(pb,box(source.polygon)))contributing.add(source.wayId);
      }
    }
    if(added){bindings.push(added);result.bindings.push({ground:surface.triangle,triangles:added,wayIds:[...contributing].sort((a,b)=>a-b)});}
  }
  const missingPolygons=difference(union(targets.flatMap(t=>t.polygon)),union(coveredPolygons));
  result.stats.missingArea=multiArea(missingPolygons);
  result.stats.coveredArea=result.stats.expectedArea-result.stats.missingArea;
  const fringes=qualifyTramCoverageFringes(missingPolygons,ground);
  result.coverage={missingPolygons,fringes,qualifiedNumericalArea:fringes.filter(f=>f.qualified).reduce((n,f)=>n+f.area,0),unresolvedArea:fringes.filter(f=>!f.qualified).reduce((n,f)=>n+f.area,0)};
  result.stats.triangles=result.indices.length/3;
  return result;
}

export function qualifyTramCoverageFringes(missing:MultiPolygon,ground:readonly TramGroundTriangle[]):TramCoverageFringe[]{
  return certifyTramCoverageFringes(missing,ground);
}
