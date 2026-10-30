import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {containsSupportedArea, type GameplayBundle, type RoadGraph, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import {sourceSha256} from './source-files.ts';
import {assertReviewedKopernikCurrentRegistration,type ReviewedKopernikRegistration} from './reviewed-kopernik-registration.ts';

type Coverage = Pick<GameplayBundle, 'playArea' | 'supportedArea'>;
const tolerance = 1e-9;
const close = (a: Vec3, b: Vec3) => Math.hypot(...a.map((v,i) => v-b[i]!)) <= tolerance;
const interpolate = (a: Vec3,b: Vec3,t: number): Vec3 => t===0 ? [...a] : t===1 ? [...b] : a.map((v,i)=>v+(b[i]!-v)*t) as unknown as Vec3;
function boundaries(coverage: Coverage) {
  const b=coverage.playArea, rectangle=[[b.minX,b.minZ],[b.maxX,b.minZ],[b.maxX,b.maxZ],[b.minX,b.maxZ]];
  return [rectangle,...coverage.supportedArea?.regions.flatMap(r=>[r.outer,...r.holes??[]])??[]].flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]!] as const));
}
function split(a:Vec3,b:Vec3,edges:ReturnType<typeof boundaries>) {
  const dx=b[0]-a[0],dz=b[2]-a[2],length2=dx*dx+dz*dz,ts=[0,1];
  if(!length2)return ts;
  for(const[p,q]of edges){
    if(Math.max(a[0],b[0])<Math.min(p[0]!,q[0]!)||Math.min(a[0],b[0])>Math.max(p[0]!,q[0]!)||Math.max(a[2],b[2])<Math.min(p[1]!,q[1]!)||Math.min(a[2],b[2])>Math.max(p[1]!,q[1]!))continue;
    const ex=q[0]!-p[0]!,ez=q[1]!-p[1]!,px=p[0]!-a[0],pz=p[1]!-a[2],denominator=dx*ez-dz*ex;
    if(Math.abs(denominator)>1e-12){const t=(px*ez-pz*ex)/denominator,u=(px*dz-pz*dx)/denominator;if(t>0&&t<1&&u>=0&&u<=1)ts.push(t);}
    else if(Math.abs(px*dz-pz*dx)<1e-8)for(const endpoint of[p,q]){const t=((endpoint[0]!-a[0])*dx+(endpoint[1]!-a[2])*dz)/length2;if(t>0&&t<1)ts.push(t);}
  }return [...new Set(ts)].sort((x,y)=>x-y);
}
function simplify(points:Vec3[]) {
  const out:Vec3[]=[];
  for(const p of points){if(out.length&&close(p,out.at(-1)!))continue;out.push(p);
    while(out.length>=3){const a=out.at(-3)!,b=out.at(-2)!,c=out.at(-1)!,d=c.map((v,i)=>v-a[i]!),length2=d.reduce((s,v)=>s+v*v,0),t=length2?b.reduce((s,v,i)=>s+(v-a[i]!)*d[i]!,0)/length2:-1;
      if(t<0||t>1||!close(b,interpolate(a,c,t)))break;out.splice(-2,1);
    }
  }return out;
}
/** Continuous boundary splitting preserves every protected 3D chord and isolated
 * boundary contact. Sampling would miss a small hole or a moved entry height. */
export function protectedRoadPieces(points:readonly Vec3[],coverage:Coverage) {
  assert.ok(points.length>=2&&points.every(p=>p.length===3&&p.every(Number.isFinite)));
  const edges=boundaries(coverage),pieces:Vec3[][]=[];let active:Vec3[]=[];
  const flush=()=>{if(active.length){pieces.push(simplify(active));active=[];}};
  const include=(p:Vec3)=>{if(active.length&&!close(active.at(-1)!,p))flush();if(!active.length||!close(active.at(-1)!,p))active.push(p);};
  for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!,ts=split(a,b,edges);
    for(let k=1;k<ts.length;k++){const lo=ts[k-1]!,hi=ts[k]!,p=interpolate(a,b,lo),q=interpolate(a,b,hi),mid=interpolate(a,b,(lo+hi)/2);
      if(containsSupportedArea(coverage,mid[0],mid[2])){include(p);active.push(q);}
      else{if(containsSupportedArea(coverage,p[0],p[2]))include(p);flush();if(containsSupportedArea(coverage,q[0],q[2]))include(q);}
    }
  }flush();return pieces;
}
/** Both detached baselines must be reconstructed by prepareAppendRoads from opaque
 * reviewed authorities. This helper checks preservation; it grants no repair authority. */
export function assertCurrentPlayableNavigationPreserved(current:RoadGraph,next:RoadGraph,coverage:Coverage,original:RoadGraph,registeredAcceptedBaseline:RoadGraph=original,reviewedCurrentBaseline:RoadGraph=current,kopernikRegistration?:ReviewedKopernikRegistration) {
  assert.equal(next.originId,current.originId);let protectedRecords=0,addedRecords=0;
  // This capability verifies both exact records and the complete actual current
  // graph. It is separate from the ordered-XZ height-only baseline below.
  const registrations=kopernikRegistration?assertReviewedKopernikCurrentRegistration(kopernikRegistration,current,next):[];
  const registeredCurrent=new Map(registrations.map(w=>[w.id,w]));let appliedRegistrations=0;
  const groups=['nodes','lanes','connectors','parking','footways']as const;
  const withoutGroups=(graph:RoadGraph)=>Object.fromEntries(Object.entries(graph).filter(([name])=>!groups.some(group=>group===name)));
  assert.deepEqual(withoutGroups(reviewedCurrentBaseline),withoutGroups(current),'Reviewed current baseline changed graph metadata');
  const reviewedHeightCorrections:{group:string;id:string;beforeSha256:string;reviewedSha256:string}[]=[];
  for(const group of groups){
    const records=new Map(next[group].map(r=>[r.id,r]));assert.equal(records.size,next[group].length,'Duplicate navigation IDs');const originalIds=new Set(original[group].map(r=>r.id));
    assert.equal(reviewedCurrentBaseline[group].length,current[group].length,'Reviewed baseline added or removed current records');
    for(const[index,raw]of current[group].entries()){
      const old=reviewedCurrentBaseline[group][index]!;assert.equal(old.id,raw.id,'Reviewed baseline reordered current records');
      if(!isDeepStrictEqual(raw,old)){
        assert.ok(originalIds.has(raw.id)&&'points'in raw&&'points'in old,'Reviewed baseline changed an earlier expansion, anchor or parking');
        const{points:a,...metadataBefore}=raw,{points:b,...metadataAfter}=old;
        assert.deepEqual(metadataAfter,metadataBefore,'Reviewed current correction changed nonpoint metadata');
        assert.ok(b.length<=100000&&b.every(p=>p.length===3&&p.every(Number.isFinite)),'Invalid corrected current points');
        // Exact reviewed height subdivisions preserve the whole ordered XZ
        // curve; they need not insert a new knot at a coverage boundary.
        assertHorizontalSubdivision(a,b);
        reviewedHeightCorrections.push({group,id:raw.id,beforeSha256:sourceSha256(JSON.stringify(raw)),reviewedSha256:sourceSha256(JSON.stringify(old))});
      }
      const fresh=records.get(old.id);assert.ok(fresh,'Current playable navigation record removed');
      if(!originalIds.has(old.id)){assert.deepEqual(fresh,old,'Earlier expansion navigation record changed');addedRecords++;continue;}
      const registration=registeredCurrent.get(old.id);
      if(registration){
        assert.equal(group,'lanes','Kopernik registration cannot change another record kind');
        assert.deepEqual(raw,registration.before,'Kopernik current BEFORE changed');
        assert.deepEqual(old,raw,'Horizontal registration cannot enter the height-only current baseline');
        assert.deepEqual(fresh,registration.after,'Kopernik current AFTER changed');
        appliedRegistrations++;continue;
      }
      if(isDeepStrictEqual(fresh,old))continue;
      assert.ok('points'in old&&'points'in fresh,'Current anchor or parking changed');const{points:a,...oa}=old,{points:b,...ob}=fresh;let expectedMetadata:object=oa;
      // This detached baseline must come from prepareAppendRoads' opaque source
      // authority. Only that exact registered lane length may differ; this helper
      // supplies preservation checks, never source/registration permission.
      if(group==='lanes'){
        const prior=original.lanes.find(r=>r.id===old.id)!,registered=registeredAcceptedBaseline.lanes.find(r=>r.id===old.id)!;assert.ok(prior&&registered);
        if(!isDeepStrictEqual(prior,registered)){
          assert.ok('length'in old&&(old.length===prior.length||old.length===registered.length),'Current registered lane length has no accepted binding');
          expectedMetadata={...oa,length:registered.length};
        }
      }assert.deepEqual(ob,expectedMetadata,'Current navigation metadata changed');
      const before=protectedRoadPieces(a,coverage),after=protectedRoadPieces(b,coverage);assert.equal(after.length,before.length,'Current protected road component count changed');
      for(let i=0;i<before.length;i++){assert.equal(after[i]!.length,before[i]!.length,'Current protected road chord count changed');for(let k=0;k<before[i]!.length;k++)assert.ok(close(before[i]![k]!,after[i]![k]!),'Current protected road position, order or height changed');}protectedRecords++;
    }
  }
  assert.equal(appliedRegistrations,registrations.length,'Joint current registration was not fully applied');
  const reviewedCurrentHorizontalRegistrations=registrations.map(({kind,id,beforeSha256,afterSha256})=>({kind,id,beforeSha256,afterSha256}));
  return{earlierExpansionRecordsPreserved:addedRecords,changedOriginalRecordsWithProtectedChordsVerified:protectedRecords,reviewedHeightCorrections,reviewedCurrentHorizontalRegistrations,continuousCurrentPlayableGeometryPreserved:reviewedHeightCorrections.length===0&&registrations.length===0,continuousReviewedCurrentPlayableGeometryPreserved:true};
}
