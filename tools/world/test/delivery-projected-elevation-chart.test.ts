import assert from 'node:assert/strict';import{test}from'node:test';
import{chartForSourceTriangles}from'../author_senate_facade_charts.ts';
import{facadeChartUv,type FacadeTriangle}from'../lib/facade-charts.ts';
import{chartInProjectedElevation}from'../lib/delivery-projected-elevation-chart.ts';
const a:FacadeTriangle=[[0,0,0],[0,0,-2],[0,3,0]],b:FacadeTriangle=[[0,0,-2],[1,0,-4],[0,3,-2]],pixels=[2,2,1020,1020]as const,frame={originXZ:[0,0]as const,axisXZ:[0,-1]as const,width:4,minY:0,maxY:3};
test('a bent source wall shares identical artwork coordinates at its physical seam',()=>{
 const before=structuredClone([a,b]),A=chartInProjectedElevation(chartForSourceTriangles('a','building',[a],pixels),[a],frame),B=chartInProjectedElevation(chartForSourceTriangles('b','building',[b],pixels),[b],frame);
 for(const y of[0,.4,1.5,2.8,3]){const point=[0,y,-2]as const,u=facadeChartUv(point,A,1024,1024),v=facadeChartUv(point,B,1024,1024);for(let i=0;i<2;i++)assert.ok(Math.abs(u[i]!-v[i]!)<1e-12,'A corner must not duplicate or shift the drawn facade');}
 const north=facadeChartUv([1,1.5,-4],B,1024,1024);assert.ok(Math.abs(north[0]!-1021.5/1024)<1e-12,'The native end stays at the last content-pixel centre, inside its gutter');assert.deepEqual([a,b],before);
});
test('common artwork coordinates retain the exact native facet plane tolerance',()=>{
 const source=chartForSourceTriangles('a','building',[a],pixels);assert.throws(()=>chartInProjectedElevation(source,[[[.01,0,0],[.01,0,-2],[.01,3,0]]],frame),/plane/);assert.equal(chartInProjectedElevation(source,[a],frame).planeToleranceMetres,source.planeToleranceMetres);
});
test('invalid or reversed common source frames fail before authoring',()=>{
 const source=chartForSourceTriangles('a','building',[a],pixels);for(const invalid of[{...frame,axisXZ:[0,-2]as const},{...frame,width:0},{...frame,minY:NaN}])assert.throws(()=>chartInProjectedElevation(source,[a],invalid),/Invalid common/);assert.throws(()=>chartInProjectedElevation(source,[a],{...frame,axisXZ:[0,1]}),/orientation/);
});
