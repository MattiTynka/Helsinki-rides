import assert from 'node:assert/strict';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import {ringDistance} from './geometry.ts';
import {extraBridgeLocal,extraBridgeWorld,extraBridgeBankHeight,type ExtraBridgeFrame,type ExtraBridgeBankSegment,type ExtraBridgeUpperPart,type ExtraBridgeRole} from './delivery-extra-bridges-source.ts';
import {supportNormal,type SupportTriangle,type SupportVertex,type TramSupportPatch} from './tram-support-repair.ts';
import type {BridgeFace} from './bridge-reconstruction.ts';
import {extraBridgePierFaces,type ExtraBridgePier} from './delivery-extra-bridges-piers.ts';

export interface ExtraBridgeDeckProfile {
  surfaceMethod:'native-bank-piecewise-planar-ruled-sections-v1';
  frame:ExtraBridgeFrame;
  banks:[{s:number;segments:ExtraBridgeBankSegment[]},{s:number;segments:ExtraBridgeBankSegment[]}];
  upperParts:ExtraBridgeUpperPart[];
  /** Authored approximation, constrained by measured bank sections and complete
   * lower-floor clearance. This is not a survey of the missing upper deck. */
  crownMetres:number;deckThicknessMetres:number;maximumGrade:number;
  /** Curved streets can cross the frame's t=0 line. Source identities, rather
   * than the sign of an arbitrary coordinate, keep each side continuous. */
  sideByPartId?:Record<string,-1|1>;
  /** A source bridge island can start and end entirely between the two road
   * banks. Its explicitly authored kerb height follows the common road field. */
  authoredMedianAboveRoadMetres?:number;
  barriers?:{kind:'mesh-crash'|'picket'|'noise-opaque'|'noise-clear';sourcePartIds:number[];startS:number;endS:number;heightMetres:number;thicknessMetres:number;edge?:'source-part'}[];
  piers?:ExtraBridgePier[];
}
export interface ExtraBridgeFace extends BridgeFace {sourcePartIds:number[];colour?:[number,number,number]}
export function extraBridgeUpperBankZones(profile:ExtraBridgeDeckProfile):TramSupportPatch[]{
  const result:TramSupportPatch[]=[];
  for(const part of profile.upperParts.filter(p=>p.boundsS)){
    const local=part.rings.map(r=>r.map(p=>extraBridgeLocal(profile.frame,p))),lo=Math.min(...local.flat().map(p=>p[1]))-1,hi=Math.max(...local.flat().map(p=>p[1]))+1,[s0,s1]=part.boundsS!;
    for(const polygon of polygonClipping.intersection([local],[[[[s0,lo],[s1,lo],[s1,hi],[s0,hi]]]])){
      const flat:number[]=[],holes:number[]=[];for(const[i,ring]of polygon.entries()){if(i)holes.push(flat.length/2);for(const p of ring)flat.push(...p);}const ids=earcut(flat,holes);
      for(let i=0;i<ids.length;i+=3){const footprint=ids.slice(i,i+3).map(k=>extraBridgeWorld(profile.frame,flat[k*2]!,flat[k*2+1]!));result.push({id:`upper-bank-${part.id}-${result.length}`,cell:'source-bound',footprint,boundsXZ:[Math.min(...footprint.map(p=>p[0])),Math.min(...footprint.map(p=>p[1])),Math.max(...footprint.map(p=>p[0])),Math.max(...footprint.map(p=>p[1]))],triangles:[],sourceNode:`municipal-part-${part.id}`,sourcePrimitive:0,observations:['Only exact source-owned upper-bank triangles may be cut. Genuine lower source geometry has priority.']});}
    }
  }return result;
}
const f32=(p:readonly number[])=>p.map(Math.fround) as SupportVertex;
export const extraBridgePartSide=(profile:ExtraBridgeDeckProfile,role:ExtraBridgeRole,t:number,partId?:number)=>role==='road'||role==='median'?0:profile.sideByPartId?.[String(partId)]??Math.sign(t);
const rangeFor=(profile:ExtraBridgeDeckProfile,bank:ExtraBridgeDeckProfile['banks'][number],role:ExtraBridgeRole,sign:number)=>{
  const segments=bank.segments.filter(p=>p.role===role&&(sign===0||p.sourcePartIds.some(id=>extraBridgePartSide(profile,role,(p.t0+p.t1)/2,id)===sign)));assert.ok(segments.length,`Missing ${role}/${sign} source bank band`);
  return{segments,min:Math.min(...segments.map(p=>p.t0)),max:Math.max(...segments.map(p=>p.t1))};
};
type FieldTriangle=[[number,number,number],[number,number,number],[number,number,number]];
function extraBridgeField(profile:ExtraBridgeDeckProfile,role:ExtraBridgeRole,sign:number):FieldTriangle[]{
  const[a,b]=profile.banks,L=b.s-a.s;assert.ok(L>5&&L<350&&profile.crownMetres>=0&&profile.crownMetres<=12&&profile.deckThicknessMetres>=.25&&profile.deckThicknessMetres<=1.2);
  const medianOffset=role==='median'?profile.authoredMedianAboveRoadMetres:undefined;if(medianOffset!==undefined)assert.ok(medianOffset>=.08&&medianOffset<=.2);const referenceRole=medianOffset===undefined?role:'road';
  const A=rangeFor(profile,a,referenceRole,sign),B=rangeFor(profile,b,referenceRole,sign),sourceT=profile.upperParts.filter(p=>p.role===role).flatMap(p=>p.rings.flat().map(p=>extraBridgeLocal(profile.frame,p)[1])),extent=sourceT.flatMap(t=>[(t-A.min)/(A.max-A.min),(t-B.min)/(B.max-B.min)]),values=[Math.min(-2,...extent)-1,0,1,Math.max(3,...extent)+1,...A.segments.flatMap(p=>[p.t0,p.t1]).map(t=>(t-A.min)/(A.max-A.min)),...B.segments.flatMap(p=>[p.t0,p.t1]).map(t=>(t-B.min)/(B.max-B.min))].sort((x,y)=>x-y),cuts=values.filter((v,i)=>!i||v-values[i-1]!>1e-10),stations=profile.crownMetres?[0,.25,.5,.75,1]:[0,1],result:FieldTriangle[]=[];
  const row=(u:number,v:number):[number,number,number]=>{
    const V=Math.max(0,Math.min(1,v)),ta=A.min+(A.max-A.min)*V,tb=B.min+(B.max-B.min)*V,y0=extraBridgeBankHeight(A.segments,ta,referenceRole),y1=extraBridgeBankHeight(B.segments,tb,referenceRole),lo=A.min+(B.min-A.min)*u,width=(A.max-A.min)+((B.max-B.min)-(A.max-A.min))*u;
    return[a.s+u*L,lo+width*v,y0+(y1-y0)*u+profile.crownMetres*16*u*u*(1-u)*(1-u)+(medianOffset??0)];
  };
  // The new authored field is explicitly piecewise planar. Native bank knots
  // survive exactly, without a one-metre tessellation across a straight deck.
  for(let i=1;i<stations.length;i++)for(let j=1;j<cuts.length;j++){const a=row(stations[i-1]!,cuts[j-1]!),b=row(stations[i-1]!,cuts[j]!),c=row(stations[i]!,cuts[j]!),d=row(stations[i]!,cuts[j-1]!);result.push([a,b,c],[a,c,d]);}
  return result;
}
function fieldHeight(triangle:FieldTriangle,s:number,t:number,inside=true):number|null{
  const[a,b,c]=triangle,D=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(D)<1e-12)return null;
  const u=((b[1]-c[1])*(s-c[0])+(c[0]-b[0])*(t-c[1]))/D,v=((c[1]-a[1])*(s-c[0])+(a[0]-c[0])*(t-c[1]))/D;if(inside&&Math.min(u,v,1-u-v)<-1e-8)return null;return u*a[2]+v*b[2]+(1-u-v)*c[2];
}
export function extraBridgeDeckHeight(profile:ExtraBridgeDeckProfile,s:number,t:number,role:ExtraBridgeRole,partId?:number){
  for(const triangle of extraBridgeField(profile,role,extraBridgePartSide(profile,role,t,partId))){const y=fieldHeight(triangle,s,t);if(y!==null)return y;}throw Error(`Point outside explicitly authored deck field:${s}/${t}/${role}`);
}
export function validateExtraBridgeDeck(profile:ExtraBridgeDeckProfile){
  assert.equal(profile.surfaceMethod,'native-bank-piecewise-planar-ruled-sections-v1');
  assert.ok(profile.maximumGrade>0&&profile.maximumGrade<=.15);
  const[a,b]=profile.banks;assert.ok(a.s<b.s);assert.ok(profile.upperParts.length>0&&new Set(profile.upperParts.map(p=>p.id)).size===profile.upperParts.length);
  if(profile.authoredMedianAboveRoadMetres!==undefined)for(const part of profile.upperParts.filter(p=>p.role==='median')){const s=part.rings.flat().map(p=>extraBridgeLocal(profile.frame,p)[0]);assert.ok(Math.min(...s)>a.s+.001&&Math.max(...s)<b.s-.001,'An authored island offset cannot replace a real bank boundary');}
  let maximumGrade=0;
  for(let s=a.s;s<b.s-.001;s+=.25)for(const t of[-4,0,4]){
    const y0=extraBridgeDeckHeight(profile,s,t,'road'),y1=extraBridgeDeckHeight(profile,Math.min(b.s,s+.25),t,'road');
    maximumGrade=Math.max(maximumGrade,Math.abs(y1-y0)/Math.min(.25,b.s-s));
  }assert.ok(maximumGrade<=profile.maximumGrade,`Extra bridge grade ${maximumGrade} exceeds bounded profile`);return{surfaceMethod:profile.surfaceMethod,maximumGrade};
}
/** Emit identical Float32 floor triangles for visual tiers and HCOL. The exact
 * source polygons own X/Z. Native bank diagonal breaks own the joining rows. */
export function buildExtraBridgeDeck(profile:ExtraBridgeDeckProfile,options:{coarse?:boolean}={}):{faces:ExtraBridgeFace[];proof:ReturnType<typeof validateExtraBridgeDeck>} {
  const proof=validateExtraBridgeDeck(profile),faces:ExtraBridgeFace[]=[],[a,b]=profile.banks;
  const emit=(points:readonly SupportVertex[],material:BridgeFace['material'],role:BridgeFace['role'],normal:readonly number[],sourcePartIds:number[],colour?:[number,number,number],collision=true)=>{
    for(let k=1;k<points.length-1;k++){
      let tri=points.slice(0,1).concat([points[k]!,points[k+1]!]).map(f32) as SupportTriangle;let n:SupportVertex;try{n=supportNormal(tri);}catch{continue;}
      if(n.reduce((sum,v,i)=>sum+v*normal[i]!,0)<0)tri=[tri[0],tri[2],tri[1]];
      faces.push({points:tri,material,role,collision,sourcePartIds,...(colour?{colour}:{}),uvs:tri.map(p=>[p[0]/4,p[2]/4]) as BridgeFace['uvs']});
    }
  };
  function bar(A:SupportVertex,B:SupportVertex,height:number,thickness:number,offsetY:number,sourcePartIds:number[],colour:[number,number,number],material:BridgeFace['material']='steel'){
    const L=Math.hypot(B[0]-A[0],B[2]-A[2]);if(L<.00001)return;const dx=(B[0]-A[0])/L,dz=(B[2]-A[2])/L,n=[-dz*thickness/2,dx*thickness/2],row=(p:SupportVertex,sign:number,y:number)=>f32([p[0]+n[0]!*sign,p[1]+offsetY+y,p[2]+n[1]!*sign]);
    const a=row(A,-1,0),b=row(A,1,0),c=row(B,1,0),d=row(B,-1,0),e=row(A,-1,height),f=row(A,1,height),g=row(B,1,height),h=row(B,-1,height);
    for(const[quad,normal]of[[[a,b,c,d],[0,-1,0]],[[e,h,g,f],[0,1,0]],[[a,e,f,b],[-dx,0,-dz]],[[d,c,g,h],[dx,0,dz]],[[a,d,h,e],[dz,0,-dx]],[[b,f,g,c],[-dz,0,dx]]] as const)emit(quad,material,'railing',normal,sourcePartIds,colour);
  }
  const upperDomains:polygonClipping.MultiPolygon=[],partDomains:{part:ExtraBridgeUpperPart;polygon:polygonClipping.Polygon}[]=[];
  for(const part of profile.upperParts){
    const rawLocal=part.rings.map(r=>r.map(p=>extraBridgeLocal(profile.frame,p))),boundsS=part.boundsS??[a.s,b.s],rawBox=[Math.min(...rawLocal.flat().map(p=>p[0])),Math.min(...rawLocal.flat().map(p=>p[1])),Math.max(...rawLocal.flat().map(p=>p[0])),Math.max(...rawLocal.flat().map(p=>p[1]))];
    const domains=polygonClipping.intersection([rawLocal],[[[[boundsS[0],rawBox[1]!-1],[boundsS[1],rawBox[1]!-1],[boundsS[1],rawBox[3]!+1],[boundsS[0],rawBox[3]!+1]]]]);
    for(const local of domains){const box=[Math.min(...local.flat().map(p=>p[0])),Math.min(...local.flat().map(p=>p[1])),Math.max(...local.flat().map(p=>p[0])),Math.max(...local.flat().map(p=>p[1]))],meanT=local[0]!.reduce((n,p)=>n+p[1],0)/local[0]!.length;
      for(const field of extraBridgeField(profile,part.role,extraBridgePartSide(profile,part.role,meanT,part.id))){
        const clipped=polygonClipping.intersection([local],[[field.map(p=>[p[0],p[1]])]]);
        for(const polygon of clipped){
          const flat:number[]=[],holes:number[]=[];for(const[ri,ring]of polygon.entries()){if(ri)holes.push(flat.length/2);for(const p of ring)flat.push(...p);}
          const indices=earcut(flat,holes),position=(index:number)=>{const s=flat[index*2]!,t=flat[index*2+1]!,[x,z]=extraBridgeWorld(profile.frame,s,t);return f32([x,fieldHeight(field,s,t,false)!,z]);};
          for(let i=0;i<indices.length;i+=3){const points=indices.slice(i,i+3).map(position),role=part.role==='road'?'road':'footway',colour=part.role==='cycle'?[.25,.075,.045] as[number,number,number]:undefined;
            emit(points,part.role==='median'?'concrete':'asphalt',role,[0,1,0],[part.id],colour);
            emit([...points].reverse().map(p=>f32([p[0],p[1]-profile.deckThicknessMetres,p[2]])),'concrete','soffit',[0,-1,0],[part.id]);
          }
        }
      }
    const bounded=polygonClipping.intersection([local],[[[[a.s,box[1]!-1],[b.s,box[1]!-1],[b.s,box[3]!+1],[a.s,box[3]!+1]]]]);upperDomains.push(...bounded);partDomains.push(...bounded.map(polygon=>({part,polygon})));}
  }
  // Close actual level differences between road/cycle/walk source polygons.
  // Both sides contribute their real clipping vertices, so these risers follow
  // the same piecewise planar floors rather than hiding a gap behind a wall.
  const floorVertices=faces.filter(f=>f.role==='road'||f.role==='footway').flatMap(f=>f.points).map(p=>({p,st:extraBridgeLocal(profile.frame,[p[0],p[2]])}));
  for(const{part,polygon}of partDomains)for(const ring of polygon)for(let i=0;i<ring.length-1;i++){
    const P=ring[i]!,Q=ring[i+1]!,ds=Q[0]-P[0],dt=Q[1]-P[1],L2=ds*ds+dt*dt;if(L2<1e-12)continue;
    const cuts=[0,1];for(const{st}of floorVertices){const u=((st[0]-P[0])*ds+(st[1]-P[1])*dt)/L2;if(u>0&&u<1&&Math.abs(ds*(st[1]-P[1])-dt*(st[0]-P[0]))/Math.sqrt(L2)<.00008)cuts.push(u);}
    cuts.sort((a,b)=>a-b);const unique=cuts.filter((v,j)=>!j||v-cuts[j-1]!>1e-7);
    for(let j=1;j<unique.length;j++){
      const at=(v:number)=>[P[0]+ds*v,P[1]+dt*v]as[number,number],U=at(unique[j-1]!),V=at(unique[j]!),mid=at((unique[j-1]!+unique[j]!)/2),worldMid=extraBridgeWorld(profile.frame,...mid);
      const neighbor=profile.upperParts.find(other=>other.id!==part.id&&other.role!==part.role&&(!other.boundsS||mid[0]>=other.boundsS[0]&&mid[0]<=other.boundsS[1])&&other.rings.some(r=>ringDistance(worldMid,r)<.00025));if(!neighbor)continue;
      const h=extraBridgeDeckHeight(profile,...mid,part.role,part.id),low=extraBridgeDeckHeight(profile,...mid,neighbor.role,neighbor.id);if(h-low<.02)continue;
      const point=(st:[number,number],role:ExtraBridgeRole,id:number,drop=0)=>{const[x,z]=extraBridgeWorld(profile.frame,...st);return f32([x,extraBridgeDeckHeight(profile,...st,role,id)-drop,z]);},A=point(U,part.role,part.id),B=point(V,part.role,part.id),C=point(V,neighbor.role,neighbor.id),D=point(U,neighbor.role,neighbor.id),normal=[B[2]-A[2],0,A[0]-B[0]];
      emit([A,B,C,D],'concrete','curb',normal,[part.id,neighbor.id]);
      emit([point(U,part.role,part.id,profile.deckThicknessMetres),point(U,neighbor.role,neighbor.id,profile.deckThicknessMetres),point(V,neighbor.role,neighbor.id,profile.deckThicknessMetres),point(V,part.role,part.id,profile.deckThicknessMetres)],'concrete','soffit',normal.map(v=>-v),[part.id,neighbor.id]);
    }
  }
  // A continuous side fascia, without end walls across real road/walk banks.
  const union=polygonClipping.union(upperDomains[0]!,...upperDomains.slice(1));
  for(const polygon of union)for(const ring of polygon)for(let i=0;i<ring.length-1;i++){
    const P=ring[i]!,Q=ring[i+1]!;if(Math.abs(P[0]-Q[0])<.00001&&(Math.abs(P[0]-a.s)<.00001||Math.abs(P[0]-b.s)<.00001))continue;
    const L=Math.hypot(Q[0]-P[0],Q[1]-P[1]),count=Math.max(1,Math.ceil(L));
    for(let k=0;k<count;k++){
      const st=(u:number)=>[P[0]+(Q[0]-P[0])*u,P[1]+(Q[1]-P[1])*u] as[number,number],U=st(k/count),V=st((k+1)/count),mid=st((k+.5)/count),worldMid=extraBridgeWorld(profile.frame,...mid),owner=[...profile.upperParts].sort((x,y)=>Math.min(...x.rings.map(r=>ringDistance(worldMid,r)))-Math.min(...y.rings.map(r=>ringDistance(worldMid,r))))[0]!;
      const point=([s,t]:[number,number])=>{const[x,z]=extraBridgeWorld(profile.frame,s,t);return f32([x,extraBridgeDeckHeight(profile,s,t,owner.role,owner.id),z]);},A=point(U),B=point(V),C=f32([B[0],B[1]-profile.deckThicknessMetres,B[2]]),D=f32([A[0],A[1]-profile.deckThicknessMetres,A[2]]);
      emit([A,B,C,D],'concrete','soffit',[B[2]-A[2],0,A[0]-B[0]],[owner.id]);
      for(const barrier of(profile.barriers??[]).filter(b=>!b.edge)){
        assert.ok(barrier.heightMetres>=.9&&barrier.heightMetres<=3&&barrier.thicknessMetres>=.03&&barrier.thicknessMetres<=.2);
        if(!barrier.sourcePartIds.includes(owner.id)||Math.max(U[0],V[0])<barrier.startS||Math.min(U[0],V[0])>barrier.endS)continue;
        // End caps are open at actual source banks. Only the declared longitudinal
        // source outer edge owns a barrier; a transverse street exit never does.
        if(Math.abs(V[0]-U[0])<.8*Math.hypot(V[0]-U[0],V[1]-U[1]))continue;
        const grey:[number,number,number]=[.38,.40,.39],H=barrier.heightMetres,th=barrier.thicknessMetres;
        bar(A,B,.12,th*1.5,.03,[owner.id],[.37,.36,.34],'concrete');
        if(barrier.kind.startsWith('noise-')){
          bar(A,B,H-.15,th,.15,[owner.id],barrier.kind==='noise-opaque'?[.55,.56,.54]:[.45,.61,.60],barrier.kind==='noise-opaque'?'concrete':'glass');
          bar(A,B,.055,th*1.1,H-.055,[owner.id],grey);
          for(let y=.55;y<H-.1;y+=.5)bar(A,B,.035,th*1.05,y,[owner.id],grey);
        }else{
          bar(A,B,.045,th,H-.045,[owner.id],grey);bar(A,B,.035,th,H*.52,[owner.id],grey);
          if(barrier.kind==='mesh-crash')bar(A,B,.19,th*2,.32,[owner.id],[.32,.34,.33]);
        }
        const spacing=options.coarse?2:barrier.kind==='picket'?.25:2,segments=Math.max(1,Math.ceil(Math.hypot(B[0]-A[0],B[2]-A[2])/spacing));
        for(let j=0;j<segments;j++){const v=j/segments,P=f32(A.map((p,i)=>p+(B[i]!-p)*v)),Q=f32([P[0]+(B[0]-A[0])*.035,P[1],P[2]+(B[2]-A[2])*.035]);bar(P,Q,H,.045,0,[owner.id],grey);}
        if(barrier.kind==='mesh-crash'&&!options.coarse){
          // A sparse wire lattice is original geometry; distant tiers retain
          // the top/middle rails and posts without alpha shimmer.
          for(let y=.65;y<H-.05;y+=.16)bar(A,B,.012,.012,y,[owner.id],grey);
        }
      }
    }
  }
  // A median noise wall is an internal source boundary, not the exterior of
  // the entire deck union. Its own registered footprint owns both edges.
  for(const barrier of(profile.barriers??[]).filter(b=>b.edge==='source-part')){
    assert.ok(barrier.kind==='noise-clear'||barrier.kind==='noise-opaque');assert.ok(barrier.heightMetres>=.9&&barrier.heightMetres<=3&&barrier.thicknessMetres>=.03&&barrier.thicknessMetres<=.2);
    for(const{part,polygon}of partDomains.filter(p=>barrier.sourcePartIds.includes(p.part.id)))for(const ring of polygon)for(let i=1;i<ring.length;i++){
      const P=ring[i-1]!,Q=ring[i]!,L=Math.hypot(Q[0]-P[0],Q[1]-P[1]);if(L<.0001||Math.abs(Q[0]-P[0])<L*.8)continue;const count=Math.ceil(L/2);
      for(let k=0;k<count;k++){
        const at=(v:number)=>[P[0]+(Q[0]-P[0])*v,P[1]+(Q[1]-P[1])*v]as[number,number],U=at(k/count),V=at((k+1)/count);if(Math.max(U[0],V[0])<barrier.startS||Math.min(U[0],V[0])>barrier.endS)continue;
        const point=([s,t]:[number,number])=>{const[x,z]=extraBridgeWorld(profile.frame,s,t);return f32([x,extraBridgeDeckHeight(profile,s,t,part.role,part.id),z]);},A=point(U),B=point(V),grey:[number,number,number]=[.52,.54,.53],H=barrier.heightMetres,th=barrier.thicknessMetres;
        bar(A,B,.15,th*1.5,0,[part.id],[.45,.44,.42],'concrete');bar(A,B,H-.15,th,.15,[part.id],barrier.kind==='noise-clear'?[.45,.61,.60]:[.55,.56,.54],barrier.kind==='noise-clear'?'glass':'concrete');bar(A,B,.05,th*1.1,H-.05,[part.id],grey);bar(A,f32([A[0]+(B[0]-A[0])*.025,A[1],A[2]+(B[2]-A[2])*.025]),H,.05,0,[part.id],grey);
      }
    }
  }
  for(const pier of profile.piers??[]){const part=profile.upperParts.find(p=>p.id===pier.upperPartId);assert.ok(part,'A support must meet a declared upper source part');
    const colour:[number,number,number]=pier.kind==='painted-steel-column'?[.27,.12,.075]:[.43,.43,.40];
    for(const face of extraBridgePierFaces(profile.frame,pier,(s,t)=>extraBridgeDeckHeight(profile,s,t,part.role,part.id)-profile.deckThicknessMetres))emit(face.points,pier.kind==='painted-steel-column'?'steel':'concrete','pier',face.normal,[pier.upperPartId,pier.sourcePartId],colour);
  }
  return{faces,proof};
}
