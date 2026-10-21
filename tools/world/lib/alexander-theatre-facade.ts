// Original CC0 architectural drawing from the qualified street-view observations.
// No image files or reference pixels are read by this renderer.
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';

export interface TheatreRegion {id:string;kind:string;count:number;start:number;end:number;eave:number;apex:number}
export interface TheatreFrame {id:string;role:'bulevardi'|'albertinkatu'|'albert-attic'|'plain-return';width:number;minY:number;maxY:number;regions:TheatreRegion[]}
export type TheatreGroundProfile=readonly (readonly [number,number])[];
const cream='#e8d9bb',salmon='#c18a7d',lowerRed='#a75f56',stone='#747976';
function at(profile:TheatreGroundProfile,u:number){
  if(!profile.length)throw new Error('A ground profile is required');if(u<=profile[0]![0])return profile[0]![1];
  for(let i=1;i<profile.length;i++){const a=profile[i-1]!,b=profile[i]!;if(u<=b[0])return a[1]+(b[1]-a[1])*(u-a[0])/(b[0]-a[0]);}return profile.at(-1)![1];
}
function glass(wall:OriginalWallArt){
  const palettes=[['#98a4ac','#596a75'],['#8b9aa5','#485f70'],['#9da8ae','#60717a'],['#8e9ba1','#536675']];
  wall.pieces.push(`<defs>${palettes.map(([a,b],i)=>`<linearGradient id="theatre-glass-${i}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`).join('')}</defs>`);
}
function fill(id:string){return `url(#theatre-glass-${id.split('').reduce((a,c)=>a+c.charCodeAt(0),0)%4})`;}
function base(wall:OriginalWallArt,profile:TheatreGroundProfile){
  const ground=at(profile,wall.width/2),belt=ground+5.15;wall.rect(0,wall.minY,wall.width,wall.maxY-wall.minY,salmon,'theatre-salmon-plaster');
  wall.rect(0,wall.minY,wall.width,belt-wall.minY,lowerRed,'theatre-deep-red-lower');
  for(let y=wall.minY;y<belt;y+=.48){wall.rect(0,y,wall.width,.045,cream,'theatre-rustication-joint');for(let x=.25+(Math.round((y-wall.minY)/.48)%2)*.75;x<wall.width;x+=1.5)wall.rect(x,y,.032,.48,'#d2b89e');}
  wall.rect(0,belt,wall.width,.22,cream,'theatre-storey-belt');
  const points=[0,...profile.map(p=>p[0]),wall.width].filter((u,i,a)=>u>=0&&u<=wall.width&&a.indexOf(u)===i).sort((a,b)=>a-b);
  wall.pieces.push(`<polygon data-feature="theatre-ground-fitted-stone-plinth" points="${[[0,wall.maxY-wall.minY],[wall.width,wall.maxY-wall.minY],...points.reverse().map(u=>[u,wall.maxY-at(profile,u)-.46])].map(p=>p.join(',')).join(' ')}" fill="${stone}"/>`);
}
function rectWindow(wall:OriginalWallArt,x:number,y:number,w:number,h:number,id:string,pediment=false){
  wall.rect(x-w/2-.18,y-.12,w+.36,h+.34,cream,id+'-cream-frame');wall.rect(x-w/2,y,w,h,fill(id),id);
  wall.line(x,y,x,y+h,'#ded8c8',.065);wall.line(x-w/2,y+h*.68,x+w/2,y+h*.68,'#ded8c8',.06);
  wall.rect(x-w/2-.28,y-.24,w+.56,.13,'#ede1c7');wall.rect(x-w/2-.27,y+h+.21,w+.54,.16,'#f1e4c9');
  if(pediment)wall.pieces.push(`<path data-feature="${id}-small-pediment" d="M${x-w/2-.30},${wall.maxY-y-h-.40}L${x},${wall.maxY-y-h-.87}L${x+w/2+.30},${wall.maxY-y-h-.40}Z" fill="${cream}" stroke="#a79176" stroke-width=".07"/>`);
}
function roundArch(wall:OriginalWallArt,x:number,y:number,w:number,h:number,id:string,door=false){
  const r=w/2,spring=y+h-r,Y=(n:number)=>wall.maxY-n,d=`M${x-r},${Y(y)}V${Y(spring)}A${r},${r} 0 0 1 ${x+r},${Y(spring)}V${Y(y)}Z`;
  wall.pieces.push(`<path data-feature="${id}" d="${d}" fill="${door?'#4f352f':fill(id)}" stroke="${cream}" stroke-width=".28"/>`);
  if(door){
    wall.pieces.push(`<g data-feature="${id}-wood-glazed-entrance-assembly">`);
    const glazingBottom=y+h*.44,glazingHeight=h*.32;
    for(const sign of [-1,1]){
      const leafX=x+sign*w*.23-w*.16;
      wall.rect(leafX,y+.22,w*.32,h*.31,'#785246',`${id}-wood-door-panel-${sign}`);
      wall.rect(leafX,glazingBottom,w*.32,glazingHeight,fill(id),`${id}-entrance-glazed-panel-${sign}`);
      wall.rect(leafX+w*.055,glazingBottom+.20,w*.21,glazingHeight*.30,'#d4cbbb',`${id}-blank-notice-panel-${sign}`);
      wall.line(x+sign*w*.07,y+h*.35,x+sign*w*.07,y+h*.43,'#baab83',.045);
    }
    wall.line(x,y+.08,x,spring+r-.12,'#3d2926',.095);
    wall.line(x-r+.10,spring-.02,x+r-.10,spring-.02,'#8e6c59',.10);
    wall.pieces.push('</g>');
  }else{wall.line(x,y,x,spring+r-.10,'#dfd8c5',.065);wall.line(x-r,y+h*.62,x+r,y+h*.62,'#d8d0bc',.065);}
  wall.rect(x-r-.28,y-.15,w+.56,.16,'#c7baa0');
}
function pilaster(wall:OriginalWallArt,x:number,bottom:number,top:number,width:number,id:string){
  wall.rect(x-width/2,bottom,width,top-bottom,cream,id);wall.rect(x-width*.68,bottom,width*1.36,.23,'#f0e0bf');wall.rect(x-width*.72,top-.28,width*1.44,.28,'#efe1c5');
  wall.line(x-width*.27,bottom+.3,x-width*.27,top-.33,'#c0ac8d',.045);wall.line(x+width*.27,bottom+.3,x+width*.27,top-.33,'#f2e4c9',.045);
}
function cornice(wall:OriginalWallArt,start:number,end:number,eave:number,id:string){
  wall.rect(start,eave-.55,end-start,.18,'#b19a7e');wall.rect(start,eave-.35,end-start,.35,cream,id);
  for(let x=start+.12;x<end-.1;x+=.43)wall.rect(x,eave-.72,.17,.18,'#eadcbd');
}
function balcony(wall:OriginalWallArt,x:number,y:number,width:number,id:string){
  wall.rect(x-width/2,y-.13,width,.19,cream,id+'-floor');wall.rect(x-width/2,y+.75,width,.13,cream,id+'-rail');
  for(let u=x-width/2+.14;u<x+width/2-.12;u+=.34){wall.rect(u,y,.11,.73,'#eadfc6');wall.rect(u-.045,y+.26,.2,.20,'#e8dabd');}
  for(const sign of [-1,1])wall.pieces.push(`<path data-feature="${id}-cream-console-${sign}" d="M${x+sign*width*.34},${wall.maxY-y+.10}q${-sign*.65},.05 ${-sign*.34},.72" fill="none" stroke="${cream}" stroke-width=".21"/>`);
}

export function renderAlexanderTheatre(wall:OriginalWallArt,frame:TheatreFrame,profile:TheatreGroundProfile){
  glass(wall);
  if(frame.role==='albert-attic'){
    wall.rect(0,wall.minY,wall.width,wall.maxY-wall.minY,salmon,'theatre-observed-high-salmon-gable');
    const eave=16.2396,apex=20.37548,left=.03,right=wall.width-.03,mid=wall.width/2,Y=(v:number)=>wall.maxY-v;
    wall.rect(0,eave-.19,wall.width,.19,cream,'theatre-high-gable-base-cornice');
    wall.pieces.push(`<path data-feature="theatre-high-gable-raking-cream-cornice" d="M${left},${Y(eave)}L${mid},${Y(apex-.04)}L${right},${Y(eave)}" stroke="${cream}" stroke-width=".23" fill="none"/>`);
    const bottom=17.25,r=1.30;wall.pieces.push(`<path data-feature="theatre-high-gable-semicircular-attic-opening" d="M${mid-r},${Y(bottom)}A${r},${r} 0 0 1 ${mid+r},${Y(bottom)}Z" fill="#35434d" stroke="${cream}" stroke-width=".21"/>`);wall.line(mid-r,bottom,mid+r,bottom,cream,.13);return;
  }
  base(wall,profile);if(frame.role==='plain-return'){cornice(wall,0,wall.width,Math.min(wall.maxY,12.3),'theatre-public-return-cornice');return;}
  const g=at(profile,wall.width/2);
  for(const region of frame.regions){
    const width=region.end-region.start,centre=(region.start+region.end)/2,eave=Math.min(region.eave,12.31);
    const central=region.kind==='observed-main-three-portals'||region.kind==='central-balcony',right=region.kind==='observed-right-wing';
    for(let i=0;i<region.count;i++){
      const x=region.start+(i+.5)*width/region.count,lowerBottom=at(profile,x)+.64,lowerWidth=central?1.66:right?1.66:region.kind==='observed-left-wing'?1.47:1.37;
      roundArch(wall,x,lowerBottom,lowerWidth,3.87,`${frame.id}-${region.id}-lower-arch-${i+1}`,region.kind==='observed-main-three-portals'||region.kind==='central-balcony'&&i===1);
      const upperY=g+6.48,upperH=Math.min(3.32,eave-upperY-.93),upperWidth=central?1.71:right?1.67:region.kind==='observed-left-wing'?1.46:1.34;
      rectWindow(wall,x,upperY,upperWidth,upperH,`${frame.id}-${region.id}-upper-rect-${i+1}`,frame.role==='bulevardi'&&!central);
    }
    if(central){
      for(let i=0;i<4;i++)pilaster(wall,region.start+.22+i*(width-.44)/3,g+5.44,eave-.36,.52,`${frame.id}-central-cream-pilaster-${i+1}`);
      const apex=region.apex,Y=(v:number)=>wall.maxY-v;
      wall.pieces.push(`<path data-feature="${frame.id}-small-front-pediment-cream-edge" d="M${region.start+.09},${Y(eave)}L${centre},${Y(apex-.06)}L${region.end-.09},${Y(eave)}Z" stroke="${cream}" stroke-width=".19" fill="${salmon}"/>`);
      wall.pieces.push(`<path data-feature="${frame.id}-small-front-pediment-relief" d="M${centre-.61},${Y(eave+.43)}q.30,-.37 .61,-.16q.31,-.21 .61,.16q-.40,.24-.61,.05q-.21,.19-.61,-.05" fill="${cream}"/>`);
      if(frame.role==='albertinkatu'){
        wall.rect(region.start+.26,g+5.02,width-.52,.17,'#30393c','theatre-albert-joined-canopy-head');
        for(let i=0;i<3;i++){const x=region.start+(i+.5)*width/3;wall.rect(x-1.41,g+5.00,2.82,.29,'#344047',`theatre-albert-three-unit-canopy-${i+1}`);
          for(const sign of [-1,1])wall.pieces.push(`<path data-feature="theatre-albert-canopy-iron-bracket-${i}-${sign}" d="M${x+sign*1.05},${wall.maxY-g-5.00}q${-sign*.46},.14 ${-sign*.30},.65q${sign*.12},.28 ${sign*.32},.03" fill="none" stroke="#303b40" stroke-width=".06"/>`);}
      }else balcony(wall,centre,g+5.28,4.72,'theatre-bulevardi-central-balcony');
    }else{
      for(const x of [region.start+.13,region.end-.13])pilaster(wall,x,g+.48,eave-.35,.42,`${frame.id}-${region.id}-cream-corner`);
      if(frame.role==='bulevardi'){
        wall.rect(region.start,eave-.02,width,.11,cream);for(let x=region.start+.23;x<region.end-.15;x+=.51)wall.rect(x,eave-.45,.12,.42,'#e4d6b8');
      }
    }
    cornice(wall,region.start,region.end,eave,`${frame.id}-${region.id}-cornice`);
  }
}
