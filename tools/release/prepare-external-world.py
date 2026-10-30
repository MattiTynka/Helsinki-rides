#!/usr/bin/env python3
"""Validate and package a final immutable world without changing any asset bytes.

This provider-neutral step needs no asset hostname, credentials or network. It
produces a bounded archive and upload inventory; it neither provisions nor uploads.
The Pages shell is staged later against an explicit schema-v2 external descriptor.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import tarfile


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pages = sibling('external_world_staging', 'stage-pages-world.py')


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def inventory_world(source: Path, expected_manifest: str, world_budget: int) -> tuple[dict, dict]:
    pages._digest(expected_manifest, 'expected manifest SHA-256')
    pages._integer(world_budget, pages.MAX_EXTERNAL_WORLD_BYTES, 'world budget')
    _require(source.is_dir() and not source.is_symlink() and not source.is_junction(),
             'source world must be a regular directory')
    inventory, total = {}, 0
    for directory, directories, files in os.walk(source, followlinks=False):
        for name in directories + files:
            target = Path(directory) / name
            _require(not target.is_symlink() and not target.is_junction(), 'linked world paths are forbidden')
        for name in sorted(files):
            target = Path(directory) / name
            relative = pages.safe_relative_path(target.relative_to(source).as_posix())
            _require(target.is_file(), 'world must contain only regular files')
            _require(pages._runtime_path(relative) or pages._publication_path(relative), 'unapproved world file type')
            size = pages._integer(target.stat().st_size, world_budget, 'world file size')
            total += size
            _require(total <= world_budget, 'external world exceeds its explicit byte budget')
            _require(len(inventory) < pages.MAX_FILES, 'external world contains too many files')
            if relative == 'manifest.json':
                _require(size <= pages.MAX_MANIFEST_BYTES, 'world manifest is too large')
            inventory[relative] = {'bytes': size, 'sha256': pages._hash_file(target)}
    _require(inventory.get('manifest.json', {}).get('sha256') == expected_manifest, 'source manifest hash mismatch')
    manifest = pages._json((source / 'manifest.json').read_bytes())
    release = manifest.get('worldReleaseId') if isinstance(manifest, dict) else None
    _require(isinstance(release, str) and pages.re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', release),
             'invalid world release identifier')
    descriptor = {'deliveryMode': 'external', 'worldRelease': release,
                  'manifestSha256': expected_manifest, 'worldBytes': total,
                  'worldBudgetBytes': world_budget, 'archiveBudgetBytes': pages.MAX_EXTERNAL_ARCHIVE_BYTES,
                  'shellBudgetBytes': pages.MAX_EXTERNAL_SHELL_BYTES}
    pages.validate_world_inventory(source, inventory, descriptor)
    pages.validate_privacy(source, inventory)
    return inventory, descriptor


class BoundedWriter:
    def __init__(self, stream, maximum):
        self.stream, self.maximum, self.written = stream, maximum, 0

    def write(self, data):
        if self.written + len(data) > self.maximum:
            raise ValueError('external archive exceeds its explicit byte budget')
        count = self.stream.write(data)
        self.written += count
        return count

    def flush(self):
        self.stream.flush()


class HashingReader:
    def __init__(self, stream):
        self.stream, self.digest, self.bytes = stream, hashlib.sha256(), 0

    def read(self, count):
        data = self.stream.read(count)
        self.digest.update(data)
        self.bytes += len(data)
        return data


def prepare(source: Path, out: Path, expected_manifest: str, world_budget: int, archive_budget: int) -> dict:
    pages._integer(archive_budget, pages.MAX_EXTERNAL_ARCHIVE_BYTES, 'archive budget')
    _require(not out.exists() and not out.is_symlink(), 'output must be a fresh directory')
    _require(not out.resolve().is_relative_to(source.resolve()) and not source.resolve().is_relative_to(out.resolve()),
             'source world and output must be separate trees')
    inventory, descriptor = inventory_world(source, expected_manifest, world_budget)
    descriptor['archiveBudgetBytes'] = archive_budget
    out.mkdir(parents=True)
    archive = out / 'pages-world.tar.gz'
    with archive.open('xb') as raw:
        bounded = BoundedWriter(raw, archive_budget)
        with gzip.GzipFile(filename='', mode='wb', fileobj=bounded, mtime=0, compresslevel=6) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as tar:
                for name, item in sorted(inventory.items()):
                    path = source / name
                    _require(path.stat().st_size == item['bytes'] and pages._hash_file(path) == item['sha256'],
                             'source changed while packaging')
                    entry = tarfile.TarInfo(f"world/{descriptor['worldRelease']}/{name}")
                    entry.size, entry.mode, entry.mtime = item['bytes'], 0o644, 0
                    with path.open('rb') as stream:
                        reader = HashingReader(stream)
                        tar.addfile(entry, reader)
                        _require(reader.bytes == item['bytes'] and reader.digest.hexdigest() == item['sha256']
                                 and stream.read(1) == b'', 'source changed while packaging')
    receipt = {**pages.upload_inventory(inventory, descriptor), 'archiveFile': archive.name,
               'archiveBytes': archive.stat().st_size, 'archiveSha256': pages._hash_file(archive),
               'archiveBudgetBytes': archive_budget, 'privacy': 'PASS', 'assetTransformation': 'none',
               'worldBaseUrl': None, 'provider': None}
    (out / 'upload-inventory.json').write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Final native world release directory')
    parser.add_argument('--out', type=Path, required=True, help='Fresh archive/inventory directory')
    parser.add_argument('--expected-manifest', required=True)
    parser.add_argument('--world-budget-bytes', type=int, required=True)
    parser.add_argument('--archive-budget-bytes', type=int, required=True)
    args = parser.parse_args()
    try:
        result = prepare(args.source, args.out, args.expected_manifest, args.world_budget_bytes, args.archive_budget_bytes)
    except (ValueError, OSError, EOFError, KeyError, struct.error) as error:
        parser.exit(1, f'External world preparation refused: {error}\n')
    print(json.dumps({key: value for key, value in result.items() if key != 'objects'}, indent=2))


if __name__ == '__main__':
    main()
