// Dedicated current-vintage theatre authoring. Existing facade plans/tools stay unchanged.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import{fileURLToPath}from'node:url';import{parseArgs}from'node:util';import{gunzipSync}from'node:zlib';import sharp from'sharp';
import{OriginalWallArt,chartForSourceTriangles,chartInSharedArtFrame}from'./author_senate_facade_charts.ts';
import{renderAlexanderTheatre,type TheatreFrame,type TheatreGroundProfile}from'./lib/alexander-theatre-facade.ts';
import{facadeChartSha256 as sha,facadeTriangleKey,type FacadeChart,type FacadeTriangle}from'./lib/facade-charts.ts';
import{parseCollisionBundle}from'../../packages/world-schema/src/collision.ts';
import{validateWorldManifest,type FileRef,type WorldManifest}from'../../packages/world-schema/src/index.ts';
import{deliveryFacadeImages,type DeliveryFacadeProfile}from'./apply_delivery_facade_charts.ts';
import{readFacadeChartTriangles}from'./lib/facade-chart-glb.ts';

export interface TheatreSourcePlan{
  schemaVersion:1;id:string;source:{cityJsonSha256:string;cityBinSha256:string;originId:string;version:string};building:{id:string;vtj:string;expectedOwner:string};atlas:[number,number];
  frames:(TheatreFrame&{pixels:FacadeChart['pixels'];triangleGroups:number[][];normal:readonly[number,number,number];uAxis:readonly[number,number,number];minU:number})[];
  references:DeliveryFacadeProfile['art']['references'];limitations:string[];
}
interface GroundFrame{frame:string;profile:TheatreGroundProfile;samples?:unknown[];method?:string}
export interface TheatreGroundReport{kind:string;manifestSha256?:string;worldRelease?:string;frames:GroundFrame[];[key:string]:unknown}
const load=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
function child(root:string,name:string){assert.ok(name&&!path.isAbsolute(name));const target=path.resolve(root,name),relative=path.relative(root,target);assert.ok(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'Payload escapes input root');assert.ok(!fs.lstatSync(target).isSymbolicLink());return target;}
function pinned(root:string,ref:FileRef){const file=child(root,ref.path),bytes=fs.readFileSync(file);assert.equal(bytes.length,ref.bytes);assert.equal(sha(bytes),ref.sha256);return bytes;}
function source(plan:TheatreSourcePlan,cityDir:string){
  assert.equal(plan.schemaVersion,1);assert.equal(plan.source.version,'305259202062');const bytes=fs.readFileSync(path.join(cityDir,'city-model.json'));assert.equal(sha(bytes),plan.source.cityJsonSha256);const city=JSON.parse(bytes.toString()),bin=fs.readFileSync(child(cityDir,city.binary.file));assert.equal(sha(bin),plan.source.cityBinSha256);assert.equal(sha(bin),city.binary.sha256);assert.equal(city.originId,plan.source.originId);
  const rows=city.buildings.filter((b:any)=>b.id===plan.building.id);assert.equal(rows.length,1);const b=rows[0];assert.equal(b.vtj,plan.building.vtj);assert.equal(b.parts.length,1);assert.equal(b.triangles,276);assert.equal(b.textured,false);
  const p=b.parts[0],P=new Float32Array(bin.buffer.slice(bin.byteOffset+p.positions.offset,bin.byteOffset+p.positions.offset+p.positions.bytes)),I=new Uint32Array(bin.buffer.slice(bin.byteOffset+p.indices.offset,bin.byteOffset+p.indices.offset+p.indices.bytes));
  const triangles:FacadeTriangle[]=Array.from({length:I.length/3},(_,i)=>[0,1,2].map(k=>{const v=I[i*3+k]!*3;return[P[v]!,P[v+2]!,-P[v+1]!] as const;}) as unknown as FacadeTriangle);return triangles;
}
function owner(plan:TheatreSourcePlan,manifest:WorldManifest){const found=manifest.cells.filter(c=>c.buildings.some(b=>b.id===plan.building.id&&b.vtj===plan.building.vtj));assert.equal(found.length,1,'Unique native theatre owner required');assert.equal(found[0]!.id,plan.building.expectedOwner,'Native theatre owner differs from qualified plan');return found[0]!;}
function groundAt(profile:TheatreGroundProfile,u:number){if(u<=profile[0]![0])return profile[0]![1];for(let i=1;i<profile.length;i++){const a=profile[i-1]!,b=profile[i]!;if(u<=b[0])return a[1]+(b[1]-a[1])*(u-a[0])/(b[0]-a[0]);}return profile.at(-1)![1];}
function supportAt(points:FacadeTriangle,x:number,z:number){
  const[a,b,c]=points,u=b.map((v,k)=>v-a[k]!),v=c.map((p,k)=>p-a[k]!),nx=u[1]!*v[2]!-u[2]!*v[1]!,ny=u[2]!*v[0]!-u[0]!*v[2]!,nz=u[0]!*v[1]!-u[1]!*v[0]!;if(ny/Math.hypot(nx,ny,nz)<.45)return null;
  const det=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(det)<1e-10)return null;const q=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/det,r=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/det;if(q< -1e-6||r< -1e-6||q+r>1+1e-6)return null;return q*a[1]+r*b[1]+(1-q-r)*c[1];
}

/** Require actual final-world HCOL and transformed upward visual ground, not a fallback HTER. */
export async function probeTheatreGround(args:{plan:string;cityModel:string;world:string;expected:string;out:string}){
  assert.ok(!fs.existsSync(args.out),'Fresh ground proof required');const plan=load(args.plan) as TheatreSourcePlan,triangles=source(plan,args.cityModel),manifestBytes=fs.readFileSync(path.join(args.world,'manifest.json'));assert.equal(sha(manifestBytes),args.expected);const manifest=JSON.parse(manifestBytes.toString()) as WorldManifest;assert.deepEqual(validateWorldManifest(manifest),[]);const selectedOwner=owner(plan,manifest);
  const collisions=new Map<string,ReturnType<typeof parseCollisionBundle>>(),visuals=new Map<string,Awaited<ReturnType<typeof readFacadeChartTriangles>>>(),records:GroundFrame[]=[];
  const box=(bounds:readonly number[],x:number,z:number)=>x>=bounds[0]!-1e-6&&x<=bounds[2]!+1e-6&&z>=bounds[1]!-1e-6&&z<=bounds[3]!+1e-6;
  for(const frame of plan.frames.filter(f=>f.role==='bulevardi'||f.role==='albertinkatu')){
    const selected=frame.triangleGroups.flat().map(i=>triangles[i]!),samples:{u:number;x:number;z:number;collision:any;visual:any}[]=[],dot=(p:readonly number[],a:readonly number[])=>p[0]!*a[0]!+p[2]!*a[2]!;
    for(const t of [.01,.12,.25,.375,.5,.625,.75,.88,.99]){
      const U=frame.minU+.03+(frame.width-.06)*t,ds:number[]=[];
      for(const tri of selected){const ps=tri.map(p=>({u:dot(p,frame.uAxis),d:dot(p,frame.normal)})).sort((a,b)=>a.u-b.u),a=ps[0]!,b=ps[2]!;if(U<a.u-1e-6||U>b.u+1e-6||b.u-a.u<1e-8)continue;ds.push(a.d+(b.d-a.d)*(U-a.u)/(b.u-a.u));}assert.ok(ds.length,'Theatre frontage envelope has a gap');
      const D=Math.max(...ds)+.75,x=U*frame.uAxis[0]+D*frame.normal[0],z=U*frame.uAxis[2]+D*frame.normal[2],colHits:any[]=[],visHits:any[]=[];
      const nearby=manifest.cells.filter(c=>box(c.collision.boundsXZ??c.boundsXZ,x,z)||c.id===selectedOwner.id);
      for(const cell of nearby){
        let bundle=collisions.get(cell.id);if(!bundle){const stored=pinned(args.world,cell.collision),decoded=cell.collision.compression?gunzipSync(stored):stored;if(cell.collision.decodedSha256)assert.equal(sha(decoded),cell.collision.decodedSha256);bundle=parseCollisionBundle(Uint8Array.from(decoded));collisions.set(cell.id,bundle);}
        for(const mesh of bundle.colliders){if(!['ground','kerbs'].includes(mesh.group))continue;for(let i=0;i<mesh.indices.length;i+=3){const tri=[0,1,2].map(k=>{const v=mesh.indices[i+k]!*3;return[mesh.positions[v]!,mesh.positions[v+1]!,mesh.positions[v+2]!] as const;}) as unknown as FacadeTriangle,y=supportAt(tri,x,z);if(y!==null)colHits.push({cell:cell.id,collider:mesh.id,triangle:i/3,tag:bundle.header.surfaceTags[mesh.triangleTags[i/3]!],y,collisionRef:cell.collision});}}
        let faces=visuals.get(cell.id);if(!faces){const ref=cell.visual.lod0,bytes=pinned(args.world,ref),images=deliveryFacadeImages(args.world,ref,bytes,manifest.sharedTextures??[]);faces=(await readFacadeChartTriangles(bytes,images)).filter(f=>f.node.includes('_ground')||f.node.includes('_kerb'));visuals.set(cell.id,faces);}
        for(const face of faces){const y=supportAt(face.points,x,z);if(y!==null)visHits.push({cell:cell.id,node:face.node,triangle:face.triangle,key:face.key,y,visualRef:cell.visual.lod0});}
      }
      colHits.sort((a,b)=>b.y-a.y);visHits.sort((a,b)=>b.y-a.y);assert.ok(colHits.length&&visHits.length,'No actual theatre street support');assert.ok(Math.abs(colHits[0].y-visHits[0].y)<1e-5,'Theatre visual/HCOL support mismatch');samples.push({u:U-frame.minU,x,z,collision:colHits[0],visual:visHits[0]});
    }
    const profile:TheatreGroundProfile=[[0,samples[0]!.collision.y],...samples.map(s=>[s.u,s.collision.y] as const),[frame.width,samples.at(-1)!.collision.y]];records.push({frame:frame.id,profile,samples,method:'Nine actual upward HCOL/ground-GLB samples0.75m outside exact selected street-front envelope; endpoint extrapolation1% only'});
  }
  for(const frame of plan.frames.filter(f=>f.role==='plain-return'||f.role==='albert-attic')){
    const main=plan.frames.find(f=>f.role===(frame.role==='albert-attic'?'albertinkatu':frame.normal[2]>.5?'albertinkatu':'bulevardi'))!,record=records.find(r=>r.frame===main.id)!,points=frame.triangleGroups.flat().flatMap(i=>[...triangles[i]!]),cx=points.reduce((s,p)=>s+p[0]/points.length,0),cz=points.reduce((s,p)=>s+p[2]/points.length,0),U=cx*main.uAxis[0]+cz*main.uAxis[2]-main.minU,y=groundAt(record.profile,U);records.push({frame:frame.id,profile:[[0,y],[frame.width,y]],method:frame.role==='albert-attic'?'Ground is unused by the qualified high gable renderer':'Tiny return plinth interpolated from the adjacent actually sampled public-front support; no new openings'});
  }
  const result:TheatreGroundReport={kind:'PINNED_HCOL_AND_RENDERED_GROUND',manifestSha256:sha(manifestBytes),worldRelease:manifest.worldReleaseId,ownerCell:selectedOwner.id,planSha256:sha(fs.readFileSync(args.plan)),frames:records};fs.mkdirSync(path.dirname(args.out),{recursive:true});fs.writeFileSync(args.out,JSON.stringify(result,null,2)+'\n');return result;
}

export async function authorTheatreFacades(args:{plan:string;cityModel:string;ground:string;out:string;baseline?:string;draft?:boolean}){
  assert.ok(!fs.existsSync(args.out),'Fresh authoring output required');assert.ok(args.draft?!args.baseline:args.baseline,'Draft mode cannot bind a world; publication authoring requires an actual baseline');
  const planBytes=fs.readFileSync(args.plan),plan=JSON.parse(planBytes.toString()) as TheatreSourcePlan,triangles=source(plan,args.cityModel),ground=load(args.ground) as TheatreGroundReport;
  assert.equal(plan.atlas[0],1024);assert.equal(plan.atlas[1],1024);const charts:FacadeChart[]=[],faces:{key:string;chart:string}[]=[],pieces:string[]=[];
  let baseline:WorldManifest|undefined,baselineSha:string|undefined,cell:WorldManifest['cells'][number]|undefined;
  if(!args.draft){assert.equal(ground.kind,'PINNED_HCOL_AND_RENDERED_GROUND');assert.equal(ground.planSha256,sha(planBytes));const bytes=fs.readFileSync(path.join(args.baseline!,'manifest.json'));baselineSha=sha(bytes);assert.equal(baselineSha,ground.manifestSha256);baseline=JSON.parse(bytes.toString());assert.deepEqual(validateWorldManifest(baseline),[]);cell=owner(plan,baseline!);}
  for(const frame of plan.frames){
    const profile=ground.frames.find(r=>r.frame===frame.id)?.profile;assert.ok(profile&&profile.length>=2);assert.ok(profile.every((p,i)=>p.length===2&&p.every(Number.isFinite)&&p[0]>=0&&p[0]<=frame.width&&(i===0||p[0]>profile[i-1]![0])),'Invalid measured theatre ground profile');
    assert.ok(frame.pixels[0]>=1&&frame.pixels[1]>=1&&frame.pixels[0]+frame.pixels[2]<1024&&frame.pixels[1]+frame.pixels[3]<1024,'Atlas gutter required');
    for(const[groupIndex,indices]of frame.triangleGroups.entries()){
      const groups:number[][]=[];try{chartForSourceTriangles('check',plan.building.id,indices.map(i=>triangles[i]!),frame.pixels);groups.push(indices);}catch{groups.push(...indices.map(i=>[i]));}
      for(const[pieceIndex,ids]of groups.entries()){
        const selected=ids.map(i=>{assert.ok(Number.isSafeInteger(i)&&triangles[i]);return triangles[i]!;}),local=chartForSourceTriangles(`${frame.id}-g${groupIndex}-p${pieceIndex}`,plan.building.id,selected,frame.pixels),ps=selected.flatMap(t=>[...t]),cx=ps.reduce((s,p)=>s+p[0]/ps.length,0),cz=ps.reduce((s,p)=>s+p[2]/ps.length,0),localCentre=(cx-local.origin[0])*local.uAxis[0]+(cz-local.origin[2])*local.uAxis[2],globalCentre=cx*frame.uAxis[0]+cz*frame.uAxis[2]-frame.minU,span=local.bounds[2]-local.bounds[0],startU=Math.max(0,Math.min(frame.width-span,globalCentre-(localCentre-local.bounds[0])));
        const chart=chartInSharedArtFrame(local,{id:frame.id,width:frame.width,minY:frame.minY,maxY:frame.maxY,startU},selected);charts.push(chart);for(const t of selected)faces.push({key:facadeTriangleKey(t),chart:chart.id});
      }
    }
    const wall=new OriginalWallArt(frame.width,frame.minY,frame.maxY);renderAlexanderTheatre(wall,frame,profile);pieces.push(wall.svg(frame.pixels));
  }
  assert.equal(new Set(faces.map(f=>f.key)).size,faces.length,'Theatre source face selected twice');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#c18a7d"/>${pieces.join('')}</svg>`,png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  fs.mkdirSync(args.out,{recursive:true});fs.writeFileSync(path.join(args.out,'facade.svg'),svg);fs.writeFileSync(path.join(args.out,'facade.png'),png);
  const art:DeliveryFacadeProfile['art']={path:'facade.png',sha256:sha(png),width:1024,height:1024,license:'CC0-1.0',attribution:'Original reference-led Alexander Theatre facade artwork by Helsinki Rides (2026); appearance references are not reproduced.',references:plan.references};
  if(cell){const profile:DeliveryFacadeProfile={schemaVersion:1,id:plan.id,baselineManifestSha256:baselineSha!,source:{cityJsonSha256:plan.source.cityJsonSha256,cityBinSha256:plan.source.cityBinSha256,originId:plan.source.originId},art,material:{name:'alexander-theatre-original-20261021',unlit:true,roughness:.95,doubleSided:true},charts,cells:[{id:cell.id,buildings:[{id:plan.building.id,vtj:plan.building.vtj}],baselineLevels:Object.fromEntries(Object.entries(cell.visual).map(([tier,ref])=>[tier,ref.sha256])),faces}]};fs.writeFileSync(path.join(args.out,'profile.json'),JSON.stringify(profile,null,2)+'\n');}
  const ledger={schemaVersion:1,status:args.draft?'DRAFT_SOURCE_TERRAIN_NOT_FOR_PUBLICATION':'SOURCE_BOUND_RUNTIME_REVIEW_REQUIRED',production:{kind:'original-procedural',license:art.license,referencePixelsCopied:false,artSha256:sha(png),svgSha256:sha(svg)},planSha256:sha(planBytes),source:plan.source,building:plan.building,baselineManifestSha256:baselineSha??null,ground:{kind:ground.kind,sha256:sha(fs.readFileSync(args.ground)),manifestSha256:ground.manifestSha256??null},frames:plan.frames,charts:charts.length,sourceTriangles:faces.length,limitations:plan.limitations,references:plan.references,dimensions:'Original opening dimensions and colour approximations are fitted to exact source planes. Only explicitly qualified counts are asserted; no architectural survey is claimed.',runtimeAcceptance:'REQUIRED'};fs.writeFileSync(path.join(args.out,'source-ledger.json'),JSON.stringify(ledger,null,2)+'\n');return {status:ledger.status,charts:charts.length,sourceTriangles:faces.length,artSha256:sha(png),baselineManifestSha256:baselineSha??null};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const{values}=parseArgs({options:{mode:{type:'string',default:'author'},plan:{type:'string'},'city-model':{type:'string'},ground:{type:'string'},baseline:{type:'string'},world:{type:'string'},expected:{type:'string'},out:{type:'string'},draft:{type:'boolean',default:false}}});assert.ok(values.plan&&values['city-model']&&values.out);
  if(values.mode==='probe-ground'){assert.ok(values.world&&values.expected);console.log(JSON.stringify(await probeTheatreGround({plan:values.plan,cityModel:values['city-model'],world:values.world,expected:values.expected,out:values.out}),null,2));}
  else{assert.equal(values.mode,'author');assert.ok(values.ground);console.log(JSON.stringify(await authorTheatreFacades({plan:values.plan,cityModel:values['city-model'],ground:values.ground,out:values.out,baseline:values.baseline,draft:values.draft}),null,2));}
}
