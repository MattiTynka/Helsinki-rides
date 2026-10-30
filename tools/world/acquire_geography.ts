// node tools/world/acquire_geography.ts --job SELECTED_JOB.json --out FRESH_DIRECTORY [--resume]
// Job schema is in lib/acquisition-job.ts. The downloader never deletes an old source snapshot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {acquireGeography} from './lib/bounded-acquisition.ts';
const {values} = parseArgs({options: {job: {type: 'string'}, out: {type: 'string'}, resume: {type: 'boolean', default: false}, 'osm-review': {type: 'string'}}});
assert.ok(values.job && values.out, '--job and --out required');
assert.ok(fs.statSync(values.job).size <= 32 * 1024 * 1024, 'Acquisition job exceeds 32 MiB');
if (values['osm-review']) assert.ok(fs.statSync(values['osm-review']).size <= 8 * 1024 * 1024, 'OSM review exceeds 8 MiB');
console.log(JSON.stringify(await acquireGeography({job: JSON.parse(fs.readFileSync(values.job, 'utf8')), out: values.out, resume: values.resume,
  osmReview: values['osm-review'] ? JSON.parse(fs.readFileSync(values['osm-review'], 'utf8')) : undefined})));
