// Original vector artwork fitted to individually observed public elevations.
// These renderers read no photographs and do not infer unobserved side walls.
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';
export type FacadeGroundSample=readonly [number,number];

function groundAt(x:number,ground:number,profile?:readonly FacadeGroundSample[]):number{
  if(!profile?.length)return ground;
  if(x<=profile[0]![0])return profile[0]![1];if(x>=profile.at(-1)![0])return profile.at(-1)![1];
  for(let i=1;i<profile.length;i++){const a=profile[i-1]!,b=profile[i]!;if(x<=b[0])return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);}return ground;
}
function slopingGranitePlinth(wall:OriginalWallArt,ground:number,profile:readonly FacadeGroundSample[]|undefined,height=.48){
  const points=[...[0,...(profile??[]).map(p=>p[0]),wall.width]].filter((x,i,a)=>x>=0&&x<=wall.width&&a.indexOf(x)===i).sort((a,b)=>a-b);
  wall.pieces.push(`<polygon data-feature="measured-sloping-granite-plinth" points="${[[0,wall.maxY-wall.minY],[wall.width,wall.maxY-wall.minY],...points.reverse().map(x=>[x,wall.maxY-groundAt(x,ground,profile)-height])].map(p=>p.join(',')).join(' ')}" fill="#626963"/>`);
}
function panelField(wall:OriginalWallArt,palette:readonly string[],width:number,height:number){
  for(let row=0,y=wall.minY;y<wall.maxY;row++,y+=height)for(let col=0,x=0;x<wall.width;col++,x+=width){
    const w=Math.min(width,wall.width-x),h=Math.min(height,wall.maxY-y);wall.rect(x,y,w,h,palette[(row+col*3)%palette.length]!);wall.line(x,y,x+w,y,'#59635e',.018);wall.line(x,y,x,y+h,'#5e6861',.018);
  }
}
function plainModernWindow(wall:OriginalWallArt,x:number,y:number,w:number,h:number,id:string){
  wall.rect(x-w/2-.055,y-.055,w+.11,h+.11,'#393e37',id);wall.rect(x-w/2,y,w,h,glassFill('modern-original-glass',id));
  wall.line(x,y,x,y+h,'#6d6653',.045);wall.line(x-w/2,y+h*.7,x+w/2,y+h*.7,'#6d6653',.035);
}
function glassFill(prefix:string,identity:string|number){const hash=String(identity).split('').reduce((h,c)=>Math.imul(h,31)+c.charCodeAt(0)|0,7);return `url(#${prefix}-${(hash>>>0)%5})`;}
function blueGrayGlassDefinitions(wall:OriginalWallArt,prefix:string){
  const palette=[['#8a9aa1','#52636d'],['#7f929d','#495e6c'],['#96a1a5','#586872'],['#7f8b94','#475b6c'],['#a2abaf','#5c6b73']];
  wall.pieces.push(`<defs>${palette.map(([light,dark],i)=>`<linearGradient id="${prefix}-${i}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient>`).join('')}<linearGradient id="${prefix}" href="#${prefix}-0"/></defs>`);
}
function modernGlassDefinition(wall:OriginalWallArt){blueGrayGlassDefinitions(wall,'modern-original-glass');}

/** Four upper rows, flush panel grid and the observed single recessed passage. */
export function renderFabianinkatu16East(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY;modernGlassDefinition(wall);panelField(wall,['#555b5c','#5b6061','#50585a'],1.18,.66);
  const first=ground+5.35,last=top-1.02-2.18,step=(last-first)/3,columns=Math.max(2,Math.round(W/1.85));
  for(let row=0;row<4;row++)for(let i=0;i<columns;i++)plainModernWindow(wall,(i+.5)*W/columns,first+row*step,.90,2.18,`fabian16-upper-row${row+1}-module-${i+1}`);
  const passage=[W*.43,W*.60] as const,shopTop=ground+4.05;
  for(let x=.65,index=1;x<W-.5;x+=2.18,index++){
    if(x>passage[0]-.5&&x<passage[1]+.5)continue;
    const bottom=groundAt(x,ground,profile)+.46;plainModernWindow(wall,x,bottom,1.72,shopTop-bottom,`fabian16-ground-glazing-${index}`);
  }
  wall.rect(passage[0],ground-.05,passage[1]-passage[0],shopTop-ground+.05,'#26332e','fabian16-central-recessed-passage');
  wall.rect(passage[0]+.40,ground+.12,passage[1]-passage[0]-.80,shopTop-ground-.38,'#344f45');wall.rect(passage[0]+.65,ground+.15,passage[1]-passage[0]-1.3,.18,'#777e72');
  wall.rect(0,shopTop+.10,W,.11,'#303f37','fabian16-flush-storefront-head');slopingGranitePlinth(wall,ground,profile,.40);wall.rect(0,top-.16,W,.16,'#434d45','fabian16-flush-coping');
}

/** Four regular upper rows over paired tall ground glazing; no classical surrounds. */
export function renderFabianinkatu18East(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY;modernGlassDefinition(wall);panelField(wall,['#aaa193','#b0a799','#a59d90'],1.36,.62);
  const first=ground+6.30,last=top-1.15-2.13,step=(last-first)/3,columns=Math.max(3,Math.round(W/2.15));
  for(let row=0;row<4;row++)for(let i=0;i<columns;i++)plainModernWindow(wall,(i+.5)*W/columns,first+row*step,1.03,2.13,`fabian18-upper-row${row+1}-module-${i+1}`);
  const head=ground+5.14,bays=Math.max(3,Math.round(W/3.8));
  for(let i=0;i<bays;i++){
    const cx=(i+.5)*W/bays,bottom=groundAt(cx,ground,profile)+.58;
    for(const sign of [-1,1])plainModernWindow(wall,cx+sign*.67,bottom,1.16,head-bottom,`fabian18-paired-ground-${i+1}-${sign}`);
  }
  wall.rect(0,head+.14,W,.19,'#34433c','fabian18-projecting-metal-canopy');wall.line(0,head+.34,W,head+.34,'#68776b',.09);
  slopingGranitePlinth(wall,ground,profile,.56);wall.rect(0,top-.20,W,.20,'#777f72','fabian18-plain-roof-edge');
}

/** Four continuous upper glazing ribbons and two glass shop levels, kept distinct from the east triple-bay block. */
export function renderAleksanterinkatu9West(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY;modernGlassDefinition(wall);panelField(wall,['#91988f','#989e95','#89948b'],1.25,.60);
  const baseTop=ground+7.15,upperStep=(top-baseTop-.40)/4;
  for(let row=0;row<4;row++){
    const y=baseTop+row*upperStep+.36,h=upperStep*.59;wall.rect(0,y,W,h,'#364d46',`aleks9-west-ribbon-${row+1}`);
    for(let x=.12;x<W;x+=.82){wall.rect(x,y+.06,.66,h-.12,glassFill('modern-original-glass',`${row}-${x}`));wall.line(x,y,x,y+h,'#655f4b',.055);}
    wall.line(0,y-.04,W,y-.04,'#b1ad96',.045);
  }
  for(let floor=0;floor<2;floor++){
    const y=floor===0?ground+.48:ground+3.85,h=floor===0?3.0:2.90;wall.rect(0,y,W,h,'#425a50',`aleks9-west-shop-level-${floor+1}`);
    for(let x=.18;x<W;x+=1.20){wall.rect(x,y+.06,1.01,h-.12,glassFill('modern-original-glass',`${floor}-${x}`));wall.line(x,y,x,y+h,'#5f5c45',.06);}
  }
  for(const y of [ground+3.65,ground+7.10]){wall.rect(0,y,W,.11,'#85784c','aleks9-west-brass-canopy-stripe');wall.rect(0,y-.10,W,.10,'#3d4b3f');}
  slopingGranitePlinth(wall,ground,profile,.42);wall.rect(0,top-.17,W,.17,'#68776c','aleks9-west-flush-coping');
}

/** Three broad four-pane groups, plus narrow glazing strips in the piers. */
export function renderAleksanterinkatu9East(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY;modernGlassDefinition(wall);panelField(wall,['#777d77','#7f847c','#737b73'],1.22,.58);
  const baseTop=ground+7.12,step=(top-baseTop-.38)/4;
  for(let row=0;row<4;row++){
    const y=baseTop+row*step+.34,h=step*.60;
    for(let group=0;group<3;group++){
      const cx=(group+.5)*W/3,groupWidth=W*.227,pane=(groupWidth-.18)/4;
      wall.rect(cx-groupWidth/2-.08,y-.07,groupWidth+.16,h+.14,'#414e45',`aleks9-east-row${row+1}-group-${group+1}`);
      for(let i=0;i<4;i++)wall.rect(cx-groupWidth/2+.025+i*pane,y,pane-.045,h,glassFill('modern-original-glass',`${row}-${group}-${i}`),`aleks9-east-row${row+1}-group${group+1}-pane-${i+1}`);
    }
    for(let strip=0;strip<=3;strip++){
      const x=strip===0?.18:strip===3?W-.18:strip*W/3;
      wall.rect(x-.14,y,.28,h,'#344b43',`aleks9-east-row${row+1}-pier-strip-${strip+1}`);wall.line(x,y,x,y+h,'#867d66',.035);
    }
  }
  for(let floor=0;floor<2;floor++){
    const y=ground+.42+floor*3.40,h=3.04;wall.rect(0,y,W,h,'#3f574d',`aleks9-east-shop-level-${floor+1}`);
    for(let x=.18;x<W;x+=1.22){wall.rect(x,y+.06,1.02,h-.12,glassFill('modern-original-glass',`${floor}-${x}`));wall.line(x,y,x,y+h,'#5b5a49',.055);}
  }
  wall.rect(0,baseTop-.12,W,.20,'#35483c','aleks9-east-thin-shop-canopy');wall.line(0,baseTop+.10,W,baseTop+.10,'#8a8872',.045);
  slopingGranitePlinth(wall,ground,profile,.43);wall.rect(0,top-.17,W,.17,'#5d6a5e','aleks9-east-flush-coping');
}

const sandstone=['#c5b5a5','#b7a596','#cdbdad','#bfae9d','#c2b3a4','#b9aa9c'];
function stoneCourses(wall:OriginalWallArt,bottom:number,top:number,width:number,height:number,palette:readonly string[]){
  for(let row=0,y=bottom;y<top;row++,y+=height){
    const shift=row%2?width*.48:0;
    for(let col=-1,x=-shift;x<wall.width;col++,x+=width){
      const left=Math.max(0,x),right=Math.min(wall.width,x+width),h=Math.min(height,top-y);if(right<=left)continue;
      const colour=palette[((row*7+col*3)%palette.length+palette.length)%palette.length]!;
      wall.rect(left,y,right-left,h,colour);wall.line(left,y,right,y,'#968d82',.018);wall.line(right,y,right,y+h,'#a79d90',.018);
    }
  }
}
function rectGlazing(wall:OriginalWallArt,x:number,bottom:number,width:number,height:number,id:string){
  wall.rect(x-width/2-.10,bottom-.08,width+.20,height+.16,'#cfc2ae',id+'-stone-reveal');
  wall.rect(x-width/2,bottom,width,height,'#453f36',id);wall.rect(x-width/2+.06,bottom+.06,width-.12,height-.12,glassFill('etela12-authored-glass',id));
  wall.line(x,bottom,x,bottom+height,'#756b58',.045);wall.line(x-width/2,bottom+height*.65,x+width/2,bottom+height*.65,'#756b58',.045);
  wall.rect(x-width/2-.16,bottom-.16,width+.32,.10,'#b5a58e');
}
function semicircularShop(wall:OriginalWallArt,x:number,ground:number,width:number,height:number,id:string,door:boolean){
  const r=width/2,spring=ground+height-r,Y=(y:number)=>wall.maxY-y;
  for(let i=0;i<11;i++){
    const a=i*Math.PI/11,b=(i+1)*Math.PI/11,point=(rad:number,t:number)=>[x+Math.cos(t)*rad,Y(spring+Math.sin(t)*rad)];
    const points=[point(r+.08,a),point(r+.48,a),point(r+.48,b),point(r+.08,b)];
    wall.pieces.push(`<polygon points="${points.map(p=>p.join(',')).join(' ')}" fill="${sandstone[i%sandstone.length]}" stroke="#948878" stroke-width=".022"/>`);
  }
  const outline=`M${x-r},${Y(ground)}V${Y(spring)}A${r},${r} 0 0 1 ${x+r},${Y(spring)}V${Y(ground)}Z`;
  wall.pieces.push(`<path data-feature="${id}" d="${outline}" fill="${door?'#654933':glassFill('etela12-authored-glass',id)}" stroke="#8b7963" stroke-width=".10"/>`);
  wall.line(x-r,ground+height*.64,x+r,ground+height*.64,'#504c3e',.09);
  if(door){
    wall.line(x,ground,x,spring,'#3c362a',.09);
    for(const sign of [-1,1])for(let row=0;row<3;row++)wall.rect(x+sign*width*.24-width*.18,ground+.16+row*(height*.21),width*.36,height*.17,'#896346');
    wall.rect(x-.07,ground+1.1,.14,.08,'#c1a365');
  }else{
    wall.line(x,ground,x,spring+r-.08,'#574f3d',.065);for(const sign of [-1,1])wall.line(x+sign*width*.25,ground,x+sign*width*.25,spring+r*.78,'#625948',.055);
  }
}

/** Six upper bays: single ends and four paired centres; five lower arches. */
export function renderEtelaesplanadi12North(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY,eave=Math.min(top,21.42),H=eave-ground;
  blueGrayGlassDefinitions(wall,'etela12-authored-glass');
  stoneCourses(wall,wall.minY,top,.92,.38,sandstone);
  stoneCourses(wall,wall.minY,ground+.56,1.25,.50,['#77776e','#808075','#6c716b','#858176']);
  slopingGranitePlinth(wall,ground,profile,.56);
  // The source has a raised central roof section; the regular street windows
  // must fit the lower side eaves rather than being stretched into that roof.
  wall.rect(0,eave-.28,W,.28,'#968d7b','etela12-parapet-coping');wall.rect(0,eave-1.2,W,.18,'#d1c3ad');
  wall.rect(0,ground+5.12,W,.18,'#d2c3ac','etela12-ground-belt');
  const bayCentres=[.065,.245,.415,.585,.755,.935].map(t=>t*W);
  const rowTops=[.39,.57,.74,.91].map(t=>ground+H*t),heights=[2.85,3.5,2.45,2.30];
  for(let row=0;row<4;row++){
    let opening=0;
    for(let bay=0;bay<6;bay++){
      const paired=bay>0&&bay<5,cx=bayCentres[bay]!,width=paired?.92:1.18,bottom=rowTops[row]!-heights[row]!;
      for(const dx of paired?[-.61,.61]:[0]){
        const id=`etela12-row${row+1}-opening-${++opening}`;
        rectGlazing(wall,cx+dx,bottom,width,heights[row]!,id);
      }
      if(paired)wall.rect(cx-.10,bottom-.12,.20,heights[row]!+.24,'#c5b79f',`etela12-row${row+1}-central-shaft-${bay}`);
      if(row===1||row===3){
        const half=paired?1.29:.83,hood=rowTops[row]!+.12;
        const crestY=top-hood;
        wall.pieces.push(`<path data-feature="etela12-row${row+1}-ogee-lintel-${bay+1}" d="M${cx-half},${crestY+.09}Q${cx-half*.90},${crestY-.27} ${cx-half*.49},${crestY-.27}Q${cx-half*.12},${crestY-.25} ${cx},${crestY-.64}Q${cx+half*.12},${crestY-.25} ${cx+half*.49},${crestY-.27}Q${cx+half*.90},${crestY-.27} ${cx+half},${crestY+.09}" fill="none" stroke="#a18e75" stroke-width=".16"/>`);
        if(paired){for(const [dx,dy]of [[-.12,0],[.12,0],[0,-.16]])wall.pieces.push(`<circle data-feature="etela12-row${row+1}-trefoil-${bay+1}" cx="${cx+dx!}" cy="${crestY-.18+dy!}" r=".13" fill="#a49378" stroke="#d2c2a7" stroke-width=".055"/>`);}
      }
    }
  }
  for(let i=0;i<5;i++){const x=(i+1)*W/6;semicircularShop(wall,x,groundAt(x,ground,profile)+.22,2.75,4.64,i===2?'etela12-central-wood-entry':`etela12-ground-shop-arch-${i<2?i+1:i}`,i===2);}
  const centre=W/2;
  for(const sign of [-1,1]){
    wall.rect(centre+sign*2.0-.16,ground+.9,.32,3.8,'#b09c82','etela12-portal-slender-panel');wall.rect(centre+sign*2.0-.07,ground+1.1,.14,3.35,'#857966');
  }
  wall.pieces.push(`<path data-feature="etela12-central-entry-stone-hood" d="M${centre-2.12},${top-ground-5.13}L${centre},${top-ground-5.82}L${centre+2.12},${top-ground-5.13}" fill="none" stroke="#ad987c" stroke-width=".22"/>`);
}

function stoneGlassDefinition(wall:OriginalWallArt){blueGrayGlassDefinitions(wall,'etela12-authored-glass');}
function griddedGlazing(wall:OriginalWallArt,x:number,y:number,width:number,height:number,id:string){
  wall.rect(x-width/2-.09,y-.09,width+.18,height+.18,'#7b7c6e',id+'-reveal');wall.rect(x-width/2,y,width,height,glassFill('etela12-authored-glass',id),id);
  for(let i=1;i<4;i++){wall.line(x-width/2+width*i/4,y,x-width/2+width*i/4,y+height,'#bfc6ae',.042);wall.line(x-width/2,y+height*i/4,x+width/2,y+height*i/4,'#bfc6ae',.042);}
}

/** Grey national-romantic main face and the separate arched north passage. */
export function renderFabianinkatu26East(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY,mainStart=W*.103,mainEnd=W*.69,mainWidth=mainEnd-mainStart;stoneGlassDefinition(wall);
  stoneCourses(wall,wall.minY,top,1.10,.48,['#bdbfb4','#c5c7bc','#b7bcb1','#c8c9bd']);
  stoneCourses(wall,wall.minY,ground+6.72,.83,.43,['#a7ada1','#adb3a6','#9da599','#b5b8aa']);
  for(let i=0;i<5;i++){
    const x=mainStart+(i+.5)*mainWidth/5,bottom=groundAt(x,ground,profile)+1.02;
    semicircularShop(wall,x,bottom,2.13,5.18,`fabian26-granite-main-arch-${i+1}`,false);
    griddedGlazing(wall,x,bottom-1.70,1.45,.72,`fabian26-basement-grid-${i+1}`);
  }
  const lowerTop=ground+7.3,upperHeight=3.20;
  for(let row=0;row<2;row++)for(let i=0;i<4;i++){
    const x=mainStart+mainWidth*(.17+i*.205),y=lowerTop+row*4.57;
    griddedGlazing(wall,x,y,1.93,upperHeight,`fabian26-upper-row${row+1}-central-axis-${i+1}`);
    wall.rect(x-1.02,y-.77,2.04,.62,'#c8c3a3',`fabian26-ochre-spandrel-${row}-${i}`);
  }
  // Source oriels lie just south of the main face and near its northern end.
  for(const [i,x]of [W*.068,W*.614].entries())for(let row=0;row<2;row++){
    const y=lowerTop+row*4.57;griddedGlazing(wall,x,y,.99,3.12,`fabian26-oriel-${i+1}-level-${row+1}`);wall.rect(x-.62,y-.73,1.24,.58,'#c4bc94');
  }
  const portalX=W*.846,portalGround=groundAt(portalX,ground,profile);
  semicircularShop(wall,portalX,portalGround+.08,4.34,5.62,'fabian26-north-return-pedestrian-arch',true);
  for(let row=0;row<2;row++)griddedGlazing(wall,portalX,ground+8.0+row*4.10,2.00,2.80,`fabian26-north-return-upper-${row+1}`);
  wall.rect(0,top-.21,W,.21,'#38443a','fabian26-black-roof-edge');slopingGranitePlinth(wall,ground,profile,.35);
}

/** Ochre plaster, three upper rows and the two actual municipal projecting oriels. */
export function renderFabianinkatu28East(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY,eave=25.32;stoneGlassDefinition(wall);
  wall.rect(0,wall.minY,W,top-wall.minY,'#c8ac69','fabian28-ochre-plaster');wall.rect(0,wall.minY,W,ground-wall.minY+5.22,'#6f5d45','fabian28-dark-rendered-ground');
  const oriels=[W*.278,W*.678],regular=[W*.035,W*.120,W*.406,W*.492,W*.570,W*.798,W*.905,W*.948],first=ground+5.97,step=(eave-first-2.72)/2;
  for(let row=0;row<3;row++){
    const y=first+row*step;
    for(const [i,x]of regular.entries()){
      wall.rect(x-.56,y-.08,1.12,2.80,'#a1834d');wall.rect(x-.46,y,.92,2.62,glassFill('etela12-authored-glass',`${row}-${i}`),`fabian28-upper-row${row+1}-regular-${i+1}`);
      wall.line(x,y,x,y+2.62,'#6a5335',.07);wall.line(x-.46,y+1.97,x+.46,y+1.97,'#6a5335',.07);for(const s of [-1,1])wall.line(x+s*.22,y+1.97,x+s*.22,y+2.62,'#6a5335',.045);
    }
    for(const [i,x]of oriels.entries()){
      wall.rect(x-.79,y-.15,1.58,2.97,'#bfa367');wall.rect(x-.66,y,1.32,2.62,glassFill('etela12-authored-glass',`oriel-${row}-${i}`),`fabian28-oriel-${i+1}-level-${row+1}`);
      wall.line(x,y,x,y+2.62,'#695237',.07);wall.line(x-.66,y+1.98,x+.66,y+1.98,'#695237',.07);
      if(row>0){wall.rect(x-.75,y-.67,1.50,.48,'#555542',`fabian28-oriel-${i+1}-iron-panel-${row}`);for(let k=0;k<5;k++)wall.line(x-.60+k*.30,y-.60,x-.60+k*.30,y-.24,'#b0a26a',.035);}
    }
  }
  const portal=W*.465,g=groundAt(portal,ground,profile);semicircularShop(wall,portal,g+.10,3.85,4.83,'fabian28-left-centre-arched-entry',true);
  for(const sign of [-1,1])for(let level=0;level<3;level++)wall.rect(portal+sign*2.22-.10,g+2.9+level*.46,.20,.26,'#9a8055','fabian28-entry-corbel');
  slopingGranitePlinth(wall,ground,profile,.53);
  for(const [i,x]of [W*.07,W*.20,W*.755,W*.865,W*.96].entries()){
    griddedGlazing(wall,x,groundAt(x,ground,profile)+.92,1.65,3.31,`fabian28-ground-tall-window-${i+1}`);wall.rect(x-.45,groundAt(x,ground,profile)+.16,.90,.34,'#404c3c',`fabian28-basement-vent-${i+1}`);
  }
  wall.rect(0,eave-.22,W,.22,'#b7a16d','fabian28-modest-cornice');
}

/** The five-arch central Mannerheimintie elevation; corner towers are not inferred. */
export function renderMannerheimintie5Central(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY,Y=(y:number)=>top-y;stoneGlassDefinition(wall);
  stoneCourses(wall,wall.minY,top,1.16,.55,['#d5cfb9','#dcd5bd','#d2ccb6','#d8d1b9']);
  const axes=Array.from({length:5},(_,i)=>(i+.5)*W/5);
  wall.rect(0,wall.minY,W,ground-wall.minY+.7,'#656b60','mannerheim5-dark-granite-base');
  for(const [i,x]of axes.entries()){
    const bottom=groundAt(x,ground,profile)+.30;
    if(i===2){wall.rect(x-1.38,bottom,2.76,3.64,'#594833','mannerheim5-central-kaivopiha-passage');wall.rect(x-1.08,bottom+.13,2.16,3.28,'#304438');wall.line(x,bottom,x,bottom+3.41,'#a29367',.09);}
    else griddedGlazing(wall,x,bottom,3.01,3.42,`mannerheim5-ground-shop-${i<2?i+1:i}`);
    const archBottom=ground+4.72,r=1.35,spring=archBottom+3.0;
    wall.pieces.push(`<path data-feature="mannerheim5-main-round-arch-${i+1}" d="M${x-r},${Y(archBottom)}V${Y(spring)}A${r},${r} 0 0 1 ${x+r},${Y(spring)}V${Y(archBottom)}Z" fill="${glassFill('etela12-authored-glass',`main-${i}`)}" stroke="#e2dac0" stroke-width=".26"/>`);
    wall.line(x,archBottom,x,spring+r-.07,'#625d47',.075);for(const t of [.30,.62])wall.line(x-r,archBottom+4.1*t,x+r,archBottom+4.1*t,'#6b6550',.055);
    for(let row=0;row<3;row++){
      const y=ground+10.00+row*3.66,height=row===0?2.65:2.42;
      rectGlazing(wall,x,y,1.61,height,`mannerheim5-rect-row${row+1}-axis-${i+1}`);
      if(i===2&&row===0)wall.pieces.push(`<path data-feature="mannerheim5-central-rect-window-pediment" d="M${x-1.12},${Y(y+height+.18)}L${x},${Y(y+height+.80)}L${x+1.12},${Y(y+height+.18)}Z" fill="#e8dfc4" stroke="#b3a482" stroke-width=".08"/>`);
    }
    griddedGlazing(wall,x,top-1.39,1.70,.89,`mannerheim5-low-attic-${i+1}`);
  }
  for(const sign of [-1,1]){
    const x=W/2+sign*1.84;griddedGlazing(wall,x,ground+4.89,.39,3.32,`mannerheim5-central-slender-flanking-light-${sign}`);
  }
  for(let i=0;i<=5;i++){
    const x=i*W/5;wall.rect(x-.20,ground+13.39,.40,6.41,'#e6ddc3',`mannerheim5-two-row-stone-pilaster-${i+1}`);wall.rect(x-.35,ground+19.80,.70,.22,'#e9dfc2');
  }
  wall.pieces.push(`<path data-feature="mannerheim5-central-stone-crest" d="M${W/2-.28},${Y(ground+13.65)}L${W/2},${Y(ground+14.06)}L${W/2+.28},${Y(ground+13.65)}L${W/2},${Y(ground+13.4)}Z" fill="#c3b793" stroke="#e3d6b5" stroke-width=".08"/>`);
  for(const y of [ground+4.15,ground+9.46,ground+13.18,top-1.62])wall.rect(0,y,W,.14,'#e4dcc2');
  slopingGranitePlinth(wall,ground,profile,.27);wall.rect(0,top-.28,W,.28,'#b6ae93','mannerheim5-flat-main-cornice');
}

/** Reference-led hotel frontage, with source-section-fitted axes rather than a claimed surveyed whole-building count. */
export function renderKampSouth(wall:OriginalWallArt,ground:number,profile?:readonly FacadeGroundSample[]){
  const W=wall.width,top=wall.maxY,eave=14.0,scale=W/87.25;stoneGlassDefinition(wall);
  // Municipal gable faces extend above the observed cornice. Their unverified
  // upper portions retain the neutral source wall colour; no new roof is drawn.
  wall.rect(0,wall.minY,W,top-wall.minY,'#cdcdcd','kamp-unverified-upper-source-colour');
  wall.rect(0,wall.minY,W,eave-wall.minY,'#c9a69b','kamp-salmon-upper-wall');wall.rect(0,ground+.48,W,4.00,'#e1d5bc','kamp-cream-rusticated-ground');
  for(let y=ground+.54;y<ground+4.45;y+=.46)wall.line(0,y,W,y,'#b5aa95',.033);
  for(let x=.1;x<W;x+=1.16)for(let row=0;row<9;row++)wall.line(x+(row%2)*.58,ground+.52+row*.46,x+(row%2)*.58,ground+.52+(row+1)*.46,'#c7bca5',.021);
  const risalits=[[3.96,13.12],[15.83,24.36],[32.25,41.53],[44.54,54.62],[55.22,61.63],[62.82,71.56],[75.56,83.22]].map(([a,b])=>[a!*scale,b!*scale] as const);
  const axes:number[]=[];
  // Two axes on the observed projecting-face rhythm; intervening source strips
  // receive a fitted single/regular module, explicitly recorded as approximate.
  let previous=0;
  for(const [left,right]of [...risalits,[W,W] as const]){
    const gap=left-previous;if(gap>1.4){const count=Math.max(1,Math.round(gap/3.65));for(let i=0;i<count;i++)axes.push(previous+(i+.5)*gap/count);}
    if(right>left){for(const f of [.28,.72])axes.push(left+(right-left)*f);}
    previous=right;
  }
  const rows=[ground+5.18,ground+8.56,ground+11.94],heights=[2.72,2.57,2.50];
  for(const [index,x]of axes.entries()){
    const bottom=groundAt(x,ground,profile)+.45;griddedGlazing(wall,x,bottom,1.76,3.33,`kamp-ground-glass-shop-${index+1}`);
    for(let row=0;row<3;row++){
      const y=rows[row]!,h=heights[row]!;
      if(row===0)wall.rect(x-1.27,y-.31,2.54,h+.83,'#e5d7bb',`kamp-lowest-cream-window-field-${index+1}`);
      rectGlazing(wall,x,y,1.23,h,`kamp-tall-row${row+1}-axis-${index+1}`);
      if(row===0)wall.pieces.push(`<path data-feature="kamp-lowest-triangular-pediment-${index+1}" d="M${x-.98},${top-y-h-.24}L${x},${top-y-h-.84}L${x+.98},${top-y-h-.24}Z" fill="#e6d8bc" stroke="#b6a486" stroke-width=".065"/>`);
    }
    const y=eave-2.63,w=1.05,r=w/2,h=1.26,spring=y+h-r,Y=(v:number)=>top-v;
    wall.pieces.push(`<path data-feature="kamp-low-round-arched-attic-${index+1}" d="M${x-r},${Y(y)}V${Y(spring)}A${r},${r} 0 0 1 ${x+r},${Y(spring)}V${Y(y)}Z" fill="${glassFill('etela12-authored-glass',index)}" stroke="#dfd1b5" stroke-width=".15"/>`);wall.line(x,y,x,spring+r-.05,'#6e6652',.045);
  }
  const portal=43.10*scale;wall.door(portal,groundAt(portal,ground,profile)+.10,1.78,3.61,'kamp-observed-single-wood-portal');
  for(const [region,[left,right]]of risalits.entries()){
    for(const [side,x]of [left,right].entries()){
      wall.rect(x-.27,ground+4.55,.54,eave-ground-5.02,'#e5d7bc',`kamp-cream-risalit-quoin-${region+1}-${side+1}`);
      for(let y=ground+4.66;y<eave-.55;y+=.45)wall.line(x-.27,y,x+.27,y,'#b8aa8c',.025);
    }
    const mid=(left+right)/2;
    wall.column(mid,rows[2]!-.25,rows[2]!+heights[2]!+.40,.39,`kamp-corinthian-upper-pier-${region+1}`,true);
    wall.rect(mid-.17,rows[1]!-.22,.34,heights[1]!+.50,'#e6d7b8',`kamp-middle-cream-pier-${region+1}`);
  }
  for(const y of [ground+4.55,ground+8.19,ground+11.61,eave-.70])wall.rect(0,y,W,.20,'#e7d9bc');
  wall.rect(0,eave-.49,W,.49,'#ddceb0','kamp-deep-dentil-cornice');for(let x=.05;x<W;x+=.37)wall.rect(x,eave-.72,.16,.23,'#efe2c9');
  slopingGranitePlinth(wall,ground,profile,.45);
}

export function renderCityFacade(wall:OriginalWallArt,renderer:string,ground:number,profile?:readonly FacadeGroundSample[]):boolean{
  if(renderer==='etelaesplanadi12-north'){renderEtelaesplanadi12North(wall,ground,profile);return true;}
  if(renderer==='fabianinkatu16-east'){renderFabianinkatu16East(wall,ground,profile);return true;}
  if(renderer==='fabianinkatu18-east'){renderFabianinkatu18East(wall,ground,profile);return true;}
  if(renderer==='aleksanterinkatu9-west-south'){renderAleksanterinkatu9West(wall,ground,profile);return true;}
  if(renderer==='aleksanterinkatu9-east-south'){renderAleksanterinkatu9East(wall,ground,profile);return true;}
  if(renderer==='fabianinkatu26-east'){renderFabianinkatu26East(wall,ground,profile);return true;}
  if(renderer==='fabianinkatu28-east'){renderFabianinkatu28East(wall,ground,profile);return true;}
  if(renderer==='mannerheimintie5-central-southwest'){renderMannerheimintie5Central(wall,ground,profile);return true;}
  if(renderer==='kamp-south'){renderKampSouth(wall,ground,profile);return true;}
  return false;
}
