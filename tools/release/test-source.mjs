// Source-checkout gate. Dataset/asset proof remains available through `pnpm test`.
// Exclusions are explicit and do not depend on whether a local file happens to exist.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directories = ['packages/sim/test', 'packages/world-schema/test', 'tools/verify/test', 'tools/world/test', 'apps/game/test', 'tools/release/test'];
const excludedSuites = new Map([
  ['tools/verify/test/finn-preservation.test.mjs', 'Needs the separately supplied Finn GLB and historical collar patch datasets; these are outside the source distribution.'],
  ['tools/verify/test/rain-preservation.test.mjs', 'Needs the separately supplied data/raw Rain GLB, outside the source distribution.'],
  ['tools/world/test/guard-completion-art.test.ts', 'Needs historical data/evidence source-fit engineering receipts; this is a full asset reconstruction gate.'],
]);
const excludedTests = [
  { suite: 'tools/world/test/vegetation.test.ts', name: 'University reconstruction retains original upper windows, all donor pixels and other UV charts', reason: 'Needs the original municipal texture master under data/work; all synthetic tests in this suite still run.' },
];

const files = [];
for (const directory of directories) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) throw new Error(`Source test directory is missing: ${directory}`);
  for (const name of readdirSync(absolute).sort()) if (/\.test\.(?:ts|mjs)$/.test(name)) files.push(`${directory}/${name}`);
}
for (const suite of [...excludedSuites.keys(), ...excludedTests.map(test => test.suite)]) {
  if (!files.includes(suite)) throw new Error(`Stale source-test exclusion: ${suite}`);
}
for (const [suite, reason] of excludedSuites) console.log(`OMITTED SUITE ${suite}: ${reason}`);
for (const test of excludedTests) console.log(`OMITTED TEST ${test.suite} :: ${test.name}: ${test.reason}`);
const included = files.filter(file => !excludedSuites.has(file));
console.log(`Source gate: ${included.length} suites; ${excludedSuites.size} asset suites and ${excludedTests.length} named asset regression omitted explicitly.`);
if (process.argv.includes('--list')) {
  console.log(included.join('\n'));
  process.exit(0);
}
if (process.argv.length > 2) throw new Error('Usage: node tools/release/test-source.mjs [--list]');

// Two synthetic integration suites use guarded, task-specific work/evidence parents.
// Create only these empty scratch parents: no source assets or recorded proof are fabricated.
for (const directory of ['data/work/city-north-20261019/service-ground/water-static-diagnosis', 'data/evidence/city-north-20261019']) {
  const absolute = path.resolve(root, directory);
  if (!absolute.startsWith(`${path.resolve(root, 'data')}${path.sep}`)) throw new Error('Scratch directory escapes data/');
  mkdirSync(absolute, { recursive: true });
}
const escapedNames = excludedTests.map(test => test.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const result = spawnSync(process.execPath, [
  '--test', '--test-concurrency=2', `--test-skip-pattern=^(?:${escapedNames.join('|')})$`, ...included,
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.signal) throw new Error(`Source test runner terminated by ${result.signal}`);
process.exit(result.status ?? 1);
