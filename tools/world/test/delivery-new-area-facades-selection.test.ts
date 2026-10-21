import assert from'node:assert/strict';import test from'node:test';import{assertCompleteSelectedFacadePlane,assertCompleteSelectedFacadeSupportPlanes}from'../lib/delivery-new-area-facades-selection.ts';import{facadeTriangleKey,type FacadeTriangle}from'../lib/facade-charts.ts';
test('A complete flat facade rejects the missed diagonal while retaining neighboring plane exclusions',()=>{
 const triangles:FacadeTriangle[]=[[[0,0,0],[2,0,0],[2,3,0]],[[0,0,0],[2,3,0],[0,3,0]],[[0,0,1],[2,0,1],[2,3,1]]],faces=triangles.map(points=>({key:facadeTriangleKey(points),points,kind:'wall',texture:null})),frame={origin:[0,0]as const,axis:[1,0]as const,width:2,minY:0,maxY:3};
 assert.throws(()=>assertCompleteSelectedFacadePlane(faces,faces.slice(0,1),frame),/omits a coplanar/);assert.equal(assertCompleteSelectedFacadePlane(faces,faces.slice(0,2),frame).sourceTrianglesInExactElevation,2);
});
test('A projecting bay checks the second selected native support plane without inventing coverage of an unselected plane',()=>{
 const triangles:FacadeTriangle[]=[[[0,0,0],[2,0,0],[2,3,0]],[[0,0,0],[2,3,0],[0,3,0]],[[0,0,1],[2,0,1],[2,3,1]],[[0,0,1],[2,3,1],[0,3,1]],[[0,0,2],[2,0,2],[2,3,2]]],faces=triangles.map(points=>({key:facadeTriangleKey(points),points,kind:'wall',texture:null})),frame={origin:[0,0]as const,axis:[1,0]as const,width:2,minY:0,maxY:3};
 assert.throws(()=>assertCompleteSelectedFacadeSupportPlanes(faces,faces.slice(0,3),frame),/omits a coplanar/);assert.equal(assertCompleteSelectedFacadeSupportPlanes(faces,faces.slice(0,4),frame).selectedTriangles,4);
});
