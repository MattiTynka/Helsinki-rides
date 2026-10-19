// Fixture geometry is unchanged; local filesystem prefixes in its saved error stack were removed for source release.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

test('actual Pitkäsilta sweep-line failure recovers without changing its dry source triangle',()=>{
  const fixture=fileURLToPath(new URL('./fixtures/coastal-precision-pitkasilta.json',import.meta.url));
  const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha(readFileSync(fixture)),'5a214ec6c402fca1ba0335e9f8aa31e6facb6c0d03e31964de6c6a25191edbe7');
  // The real operands trigger unbounded segment proliferation. Lowering only
  // the library's guard reproduces the identical recorded error using ~110 MiB,
  // without forcing a million segments into a shared test/build process.
  const replay=spawnSync(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./helpers/replay-coastal-witness.mjs',import.meta.url)),fixture],{
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS:'8192',POLYGON_CLIPPING_MAX_QUEUE_SIZE:'32768'},encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
  });
  assert.equal(replay.error,undefined);assert.equal(replay.status,0,replay.stderr);
  const result=JSON.parse(replay.stdout);
  assert.equal(result.witnessSha256,'5a214ec6c402fca1ba0335e9f8aa31e6facb6c0d03e31964de6c6a25191edbe7');
  assert.equal(result.helperSha256,sha(readFileSync(new URL('../lib/coastal-mask.ts',import.meta.url))));
  assert.equal(result.exact.ok,false);assert.equal(result.exact.error.message,'Infinite loop when passing sweep line over endpoints (too many sweep line segments).');
  assert.equal(result.snapped.ok,true);assert.equal(result.snapped.polygons,0);assert.equal(result.snapped.area,0);
  assert.equal(result.helper.precisionRetries,1);assert.equal(result.helper.callbacks,1);assert.equal(result.helper.callbackBeforeRetry,true);
  assert.deepEqual(result.helper.stages,['triangle-water-intersection']);assert.deepEqual(result.helper.recoveredStatuses,['recovered']);assert.equal(result.helper.sourcePieceIdentityPreserved,true);
  assert.equal(result.geometry.allFinite,true);assert.equal(result.geometry.outputVertices,3);assert.equal(result.geometry.outputTriangles,1);
  assert.equal(result.geometry.outputArea,result.geometry.sourceArea);assert.equal(result.geometry.areaPartitionError,0);
  assert.equal(result.geometry.maxHeightInterpolationError,0);assert.equal(result.geometry.maxUvInterpolationError,0);assert.equal(result.geometry.maxOutputOutsideWeight,0);
  assert.ok(result.geometry.maxAxisDisplacementMetres<=5.0001e-8);assert.equal(result.inputsUnchanged,true);
  assert.equal(result.snappedDifference.ok,true);assert.ok(Math.abs(result.snappedDifference.area-result.geometry.sourceArea)<result.geometry.areaTolerance);
});
