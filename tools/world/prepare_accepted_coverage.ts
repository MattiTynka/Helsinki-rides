// node tools/world/prepare_accepted_coverage.ts --source WORLD --expected MANIFEST_SHA --out FRESH_DIRECTORY
// Revalidate later without writes: --source WORLD --expected MANIFEST_SHA --verify COVERAGE_DIRECTORY
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {prepareAcceptedCoverage, verifyAcceptedCoverage} from './lib/accepted-coverage.ts';
const {values} = parseArgs({options: {source: {type: 'string'}, expected: {type: 'string'}, out: {type: 'string'}, verify: {type: 'string'}}});
assert.ok(values.source && values.expected && Boolean(values.out) !== Boolean(values.verify), 'Require --source, --expected and exactly one of --out or --verify');
const result = values.verify ? verifyAcceptedCoverage({source: values.source, expectedManifestSha256: values.expected, coverage: values.verify})
  : prepareAcceptedCoverage({source: values.source, expectedManifestSha256: values.expected, out: values.out!});
console.log(JSON.stringify({...result, ...('checks' in result ? {checks: undefined, sourceRefs: undefined} : {})}));
