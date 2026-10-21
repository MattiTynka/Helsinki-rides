import type {RoadGraph} from './types.ts';
import {validateRoadGraph} from './roads.ts';

/** Lossless delivery transport. Simulation and recording consumers still receive
 * the same schema2 RoadGraph with ordinary JS numbers and arrays. */
export const MAX_PACKED_ROAD_BYTES=8_000_000;
const MAX_LEGACY_BYTES=64*1024*1024,MAX_RECORDS=100_000,MAX_POINTS=333_333;
const MAGIC='HROADS01',HEADER_BYTES=32;
const GROUPS=['nodes','lanes','connectors','parking','footways']as const;
type Group=typeof GROUPS[number];
const FIELDS:Record<Group,readonly string[]>={nodes:['id','kind'],lanes:['id','wayId','name','highway','surface','speedLimit','width','from','to','length','index','count'],connectors:['id','node','from','to','turn','length'],parking:['id','kind','heading'],footways:['id']};
const STRINGS=new Set(['id','kind','name','highway','surface','from','to','node','turn']);
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
function requireValue(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(`road payload: ${message}`);}
function keys(value:unknown,expected:readonly string[],label:string){requireValue(value&&typeof value==='object'&&!Array.isArray(value),`${label} must be an object`);requireValue(Object.getPrototypeOf(value)===Object.prototype,`${label} prototype is not plain`);const actual=Object.keys(value);requireValue(actual.length===expected.length&&expected.every(k=>Object.hasOwn(value,k)),`${label} fields differ`);}
function safeJson(value:unknown,depth=0){requireValue(depth<=16,'metadata depth exceeded');if(value===null||typeof value==='boolean')return;if(typeof value==='number'){requireValue(Number.isFinite(value),'nonfinite metadata');return;}if(typeof value==='string'){requireValue(value.length<=4096,'string too long');return;}requireValue(value&&typeof value==='object','unsupported metadata');if(Array.isArray(value)){requireValue(value.length<=1_000_000,'metadata array exceeded');for(const v of value)safeJson(v,depth+1);return;}requireValue(Object.getPrototypeOf(value)===Object.prototype,'metadata prototype is not plain');for(const[k,v]of Object.entries(value)){requireValue(!['__proto__','prototype','constructor'].includes(k),'unsafe metadata key');safeJson(v,depth+1);}}
function checkGraph(value:unknown):asserts value is RoadGraph{
 keys(value,['schemaVersion','originId','source',...GROUPS],'graph');const g=value as any;requireValue(g.schemaVersion===2&&typeof g.originId==='string'&&g.originId.length>0&&g.originId.length<=512,'graph identity');keys(g.source,['id','sha256','attribution','license'],'source');safeJson(g.source);for(const v of Object.values(g.source))requireValue(typeof v==='string','source must contain strings');
 let points=0;for(const kind of GROUPS){requireValue(Array.isArray(g[kind])&&g[kind].length<=MAX_RECORDS,'record count exceeded');for(const record of g[kind]){const position=kind==='nodes'?'position':'points';keys(record,[...FIELDS[kind],position],`${kind} record`);for(const field of FIELDS[kind]){const v=record[field];requireValue(STRINGS.has(field)?v===null&&field==='name'||typeof v==='string'&&v.length<=4096:v===null&&field==='heading'||typeof v==='number'&&Number.isFinite(v),`${kind}.${field} type`);}const xyz=kind==='nodes'?[record.position]:record.points;requireValue(Array.isArray(xyz)&&xyz.length>0&&xyz.length<=MAX_POINTS,'point count exceeded');points+=xyz.length;requireValue(points<=MAX_POINTS,'total point count exceeded');for(const p of xyz)requireValue(Array.isArray(p)&&p.length===3&&p.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n)),'invalid F64 XYZ');}}
 requireValue(validateRoadGraph(g).length===0,'logical road graph validation failed');
}

export function isPackedRoadGraph(bytes:Uint8Array){return bytes.length>=8&&MAGIC.split('').every((c,i)=>bytes[i]===c.charCodeAt(0));}

export function encodePackedRoadGraph(graph:RoadGraph):Uint8Array{
 checkGraph(graph);const strings:string[]=[],indices=new Map<string,number>(),xyz:number[]=[],groups:Record<string,unknown>={};
 const intern=(s:string)=>{let i=indices.get(s);if(i===undefined){i=strings.length;indices.set(s,i);strings.push(s);}return i;};
 for(const kind of GROUPS){const fields=FIELDS[kind],rows=(graph[kind]as readonly any[]).map(record=>{const points=kind==='nodes'?[record.position]:record.points,start=xyz.length/3;for(const p of points)xyz.push(p[0],p[1],p[2]);return[...fields.map(field=>{const v=record[field];return STRINGS.has(field)?v===null?null:intern(v):Object.is(v,-0)?'-0':v;}),start,points.length];});groups[kind]={fields,rows};}
 const json=encoder.encode(JSON.stringify({schemaVersion:1,root:{schemaVersion:graph.schemaVersion,originId:graph.originId,source:graph.source},strings,groups})),offset=Math.ceil((HEADER_BYTES+json.length)/8)*8,total=offset+xyz.length*8;
 requireValue(total<=MAX_PACKED_ROAD_BYTES,'packed transport exceeds8MB');const bytes=new Uint8Array(total),view=new DataView(bytes.buffer);bytes.set(encoder.encode(MAGIC));view.setUint32(8,1,true);view.setUint32(12,json.length,true);view.setUint32(16,xyz.length/3,true);view.setUint32(20,0,true);view.setUint32(24,offset,true);view.setUint32(28,total,true);bytes.set(json,HEADER_BYTES);for(let i=0;i<xyz.length;i++)view.setFloat64(offset+i*8,xyz[i]!,true);return bytes;
}

/** Input must first pass the manifest's stored/decoded size and SHA-256 checks.
 * This parser independently bounds structure before reconstructing any graph. */
export function decodeRoadGraph(bytes:Uint8Array):RoadGraph{
 requireValue(bytes.length>0&&bytes.length<=MAX_LEGACY_BYTES,'input exceeds64MiB');
 if(!isPackedRoadGraph(bytes)){const value:unknown=JSON.parse(decoder.decode(bytes));safeJson(value);checkGraph(value);return value;}
 requireValue(bytes.length>=HEADER_BYTES&&bytes.length<=MAX_PACKED_ROAD_BYTES,'packed length exceeds8MB');const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),jsonBytes=view.getUint32(12,true),count=view.getUint32(16,true),offset=view.getUint32(24,true);
 requireValue(view.getUint32(8,true)===1&&view.getUint32(20,true)===0,'unsupported packed version/reserved bits');requireValue(count<=MAX_POINTS&&jsonBytes>0&&jsonBytes<=MAX_PACKED_ROAD_BYTES-HEADER_BYTES,'invalid header counts');requireValue(offset===Math.ceil((HEADER_BYTES+jsonBytes)/8)*8&&offset+count*24===bytes.length&&view.getUint32(28,true)===bytes.length,'truncated or overlapping packed ranges');for(let i=HEADER_BYTES+jsonBytes;i<offset;i++)requireValue(bytes[i]===0,'nonzero alignment padding');
 const header:unknown=JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES,HEADER_BYTES+jsonBytes)));keys(header,['schemaVersion','root','strings','groups'],'header');const h=header as any;requireValue(h.schemaVersion===1,'invalid header schema');keys(h.root,['schemaVersion','originId','source'],'root');safeJson(h.root);requireValue(Array.isArray(h.strings)&&h.strings.length<=MAX_RECORDS,'string dictionary count exceeded');for(const s of h.strings)requireValue(typeof s==='string'&&s.length<=4096,'invalid string dictionary');keys(h.groups,GROUPS,'groups');
 const graph:any={...h.root};let next=0,expandedBytes=encoder.encode(JSON.stringify(h.root)).length;
 for(const kind of GROUPS){const table=h.groups[kind];keys(table,['fields','rows'],`${kind} table`);requireValue(Array.isArray(table.fields)&&JSON.stringify(table.fields)===JSON.stringify(FIELDS[kind]),'unsupported table fields');requireValue(Array.isArray(table.rows)&&table.rows.length<=MAX_RECORDS,'row count exceeded');graph[kind]=[];for(const row of table.rows){const fields=FIELDS[kind];requireValue(Array.isArray(row)&&row.length===fields.length+2,'table row width');const start=row[fields.length],length=row[fields.length+1];requireValue(Number.isSafeInteger(start)&&start===next&&Number.isSafeInteger(length)&&length>0&&length<=count-next&&(!(kind==='nodes')||length===1),'invalid point interval');next+=length;
   const record:Record<string,unknown>={};for(let i=0;i<fields.length;i++){const field=fields[i]!,v=row[i];if(STRINGS.has(field)){requireValue(v===null&&field==='name'||Number.isSafeInteger(v)&&v>=0&&v<h.strings.length,'invalid string reference');record[field]=v===null?null:h.strings[v];}else{requireValue(v===null&&field==='heading'||v==='-0'||typeof v==='number'&&Number.isFinite(v),'invalid scalar');record[field]=v==='-0'?-0:v;}}
   const points:number[][]=[];for(let i=0;i<length;i++){const p=[0,1,2].map(k=>view.getFloat64(offset+(start+i)*24+k*8,true));requireValue(p.every(Number.isFinite),'nonfinite packed F64');points.push(p);}record[kind==='nodes'?'position':'points']=kind==='nodes'?points[0]:points;
   expandedBytes+=encoder.encode(JSON.stringify(record)).length+1;requireValue(expandedBytes<=MAX_LEGACY_BYTES,'expanded graph exceeds64MiB');graph[kind].push(record);
 }}requireValue(next===count,'unclaimed packed points');checkGraph(graph);return graph;
}
