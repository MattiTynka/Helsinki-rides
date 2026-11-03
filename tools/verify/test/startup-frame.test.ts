import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Game} from '../../../apps/game/src/game.ts';
import {NEUTRAL,encodeCommand,decodeCommand} from '../../../packages/sim/src/commands.ts';
for(const ready of [true,false])test(`startup initial frame records only a ready idle tick (models ${ready})`,async()=>{
 let tick=0,loaded=false,release!:()=>void;const order:string[]=[],commands:unknown[]=[];
 const pending=new Promise<void>(resolve=>{release=()=>{loaded=true;resolve();};});
 const state=()=>({tick,shots:[],characters:[{id:'a'},{id:'b'},{id:'c'}],player:{mode:'onFoot',alive:true,yaw:-2.094}});
 const game=Object.assign(Object.create(Game.prototype),{
  captureReplay:true,config:{review:true},commandLog:[],traceLog:[],eventLog:[],frameEvents:[],pendingShots:[],
  state:state(),previousState:state(),collision:{},collisionReady:()=>loaded,collisionLoaded:()=>pending,
  actorModelsReady:()=>ready,handleEvents:()=>{},currentCommand:()=>{throw Error('must not consume player input while loading');},
  sim:{player:{yaw:-2.094},step(c:unknown){commands.push(c);tick++;order.push('tick');return [];},state,digest:()=>String(tick)},
  syncViews:(dt:number,animationDt:number,s:unknown,limit:number)=>{assert.equal(dt,0);assert.equal(animationDt,0);assert.equal(s,game.state);assert.equal(limit,3);order.push('views');},render:()=>order.push('render'),
 });
 const preparation=game.prepareStartupFrame();await Promise.resolve();
 if(ready){assert.equal(tick,0);assert.deepEqual(order,[]);}release();await preparation;
 assert.deepEqual(order,ready?['tick','views','render']:['views','render']);
 const c={...NEUTRAL,yaw:-2.094};assert.deepEqual(commands,ready?[decodeCommand(encodeCommand(c))]:[]);
 assert.deepEqual(game.commandLog,ready?[encodeCommand(c)]:[]);
});
