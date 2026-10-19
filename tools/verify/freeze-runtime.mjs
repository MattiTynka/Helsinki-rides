// Freeze local source without copying published worlds or third-party packages.
// node tools/verify/freeze-runtime.mjs FRESH_DIRECTORY FRESH_INVENTORY_JSON
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const [destination, inventoryFile] = process.argv.slice(2);
if (!destination || !inventoryFile || fs.existsSync(destination) || fs.existsSync(inventoryFile)) throw new Error('fresh destination and inventory required');
const root = process.cwd(), frozen = path.resolve(destination);
if (!frozen.startsWith(path.join(root, 'data', 'work') + path.sep)) throw new Error('snapshot must be under data/work');
const ignored = new Set(['node_modules', 'dist', '.git', '__pycache__']);
const files = [];
function copy(relative) {
  const source = path.join(root, relative), target = path.join(frozen, relative), stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`source junction must be explicit: ${relative}`);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(source).sort()) {
      if (ignored.has(entry) || relative === 'apps/game/public' && entry === 'world') continue;
      copy(path.join(relative, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(target), {recursive:true});
    const bytes = fs.readFileSync(source); fs.writeFileSync(target, bytes);
    files.push({path:relative.replaceAll('\\','/'), bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')});
  }
}
for (const item of ['apps/game','packages','tools/world','tools/verify','content','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json']) copy(item);
const dependencyLinks = [];
function dependencies(relative) {
  const source = path.join(root,relative);
  if (!fs.existsSync(source)) return;
  const target = path.join(frozen,relative); fs.mkdirSync(target,{recursive:true});
  for (const entry of fs.readdirSync(source)) {
    if (entry.startsWith('.') && entry !== '.bin') continue;
    if (entry.startsWith('@')) {dependencies(path.join(relative,entry)); continue;}
    let resolved = fs.realpathSync(path.join(source,entry));
    if (resolved.startsWith(path.join(root,'packages') + path.sep)) resolved = path.join(frozen,path.relative(root,resolved));
    fs.symlinkSync(resolved,path.join(target,entry),'junction');
    dependencyLinks.push({path:path.join(relative,entry).replaceAll('\\','/'),target:resolved});
  }
}
for (const relative of ['node_modules','apps/game/node_modules',...fs.readdirSync(path.join(root,'packages')).map(p=>`packages/${p}/node_modules`)]) dependencies(relative);
files.sort((a,b)=>a.path.localeCompare(b.path));
const inventory = {createdAt:new Date().toISOString(),root:destination,files,inventorySha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),dependencyLinks};
fs.mkdirSync(path.dirname(inventoryFile),{recursive:true}); fs.writeFileSync(inventoryFile,JSON.stringify(inventory,null,2)+'\n');
console.log(JSON.stringify({root:destination,files:files.length,dependencyLinks:dependencyLinks.length,inventorySha256:inventory.inventorySha256}));
