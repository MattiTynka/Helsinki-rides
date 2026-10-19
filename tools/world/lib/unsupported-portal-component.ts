interface Element{type:string;id:number;nodes?:number[];tags?:Record<string,string>}
export interface UnsupportedPortalComponent{portalWayId:number;wayIds:number[];reason:string}
/** Explicit source declaration, proven closed on its courtyard side. Branches
 * never make a public through-road or an unverified service way disappear. */
export function verifyUnsupportedPortalComponent(elements:readonly Element[],declaration:UnsupportedPortalComponent,drivable:ReadonlySet<string>){
 const ways=elements.filter(e=>e.type==='way'&&e.nodes&&drivable.has(e.tags?.highway??'')),portal=ways.find(w=>w.id===declaration.portalWayId),members=declaration.wayIds.map(id=>ways.find(w=>w.id===id));
 if(!portal||portal.tags?.tunnel!=='building_passage'||!declaration.reason||!members.length||members.some(w=>!w||w.tags?.highway!=='service'))throw new Error('Invalid source-bound unsupported portal component');
 const ids=new Set(declaration.wayIds),memberNodes=new Set(members.flatMap(w=>w!.nodes!)),boundaries=[];
 for(const w of ways.filter(w=>!ids.has(w.id)))for(const node of w.nodes!)if(memberNodes.has(node)){if(w.id!==portal.id)throw new Error(`Portal component has another vehicle connection ${w.id} at node${node}`);boundaries.push({wayId:w.id,node});}
 if(!boundaries.length)throw new Error('Portal component does not touch the declared source portal');
 const reached=new Set<number>(),stack=[members[0]!];while(stack.length){const w=stack.pop()!;if(reached.has(w.id))continue;reached.add(w.id);for(const q of members)if(!reached.has(q!.id)&&q!.nodes!.some(n=>w.nodes!.includes(n)))stack.push(q!);}
 if(reached.size!==members.length)throw new Error('Portal declaration contains disconnected ways');
 return{...declaration,boundaries,source:members.map(w=>({id:w!.id,nodes:w!.nodes,tags:w!.tags})),portal:{id:portal.id,nodes:portal.nodes,tags:portal.tags},proof:'All component vehicle connections are internal or the single unmodelled building passage; no other public/service/offmap road connection exists. Raw OSM ways are retained.'};
}
