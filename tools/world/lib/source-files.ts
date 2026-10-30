import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const sourceSha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Only ordinary files inside a real directory are source inputs; reject symlink ancestors too. */
export function sourceFile(root: string, relative: string): string {
  assert.ok(relative.length <= 512 && relative.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)), 'Unsafe source path');
  const base = fs.realpathSync(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current)) assert.ok(!fs.lstatSync(current).isSymbolicLink(), 'Source symlinks are not allowed');
  }
  return current;
}

export function readSourceFile(root: string, ref: {path: string; bytes: number; sha256: string}): Buffer {
  assert.ok(Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && /^[a-f0-9]{64}$/.test(ref.sha256), 'Invalid source reference');
  const file = sourceFile(root, ref.path), stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && stat.size === ref.bytes, 'Source byte length mismatch: ' + ref.path);
  const bytes = fs.readFileSync(file);
  assert.equal(sourceSha256(bytes), ref.sha256, 'Source SHA-256 mismatch: ' + ref.path);
  return bytes;
}

export function writeSourceJson(root: string, relative: string, value: unknown): {path: string; bytes: number; sha256: string} {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), file = sourceFile(root, relative);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, bytes, {flag: 'wx'});
  return {path: relative, bytes: bytes.length, sha256: sourceSha256(bytes)};
}
