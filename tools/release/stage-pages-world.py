#!/usr/bin/env python3
"""Validate a pinned Pages world archive before adding it to the built shell.

Only the committed descriptor chooses a download. This tool never fetches URLs,
uses tar extraction helpers, follows links, or merges an existing world tree.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from typing import Any


MAX_WORLD_BYTES = 950_000_000
MAX_ARTIFACT_BYTES = 980_000_000
MAX_ARCHIVE_BYTES = 980_000_000
MAX_FILES = 10_000
MAX_MANIFEST_BYTES = 8_000_000
MAX_TRAILER_BYTES = 1_048_576
DESCRIPTOR_KEYS = frozenset({
    'schemaVersion', 'worldRelease', 'manifestSha256', 'worldBaseUrl',
    'archiveUrl', 'archiveSha256', 'archiveBytes', 'worldBytes',
})
WORLD_BASE_URL = 'https://mattitynka.github.io/Helsinki-rides/world/'
DIGEST = re.compile(r'[0-9a-f]{64}\Z')
RELEASE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}\Z')
ARCHIVE_URL = re.compile(
    r'https://github\.com/MattiTynka/Helsinki-rides/releases/download/'
    r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}/pages-world\.tar\.gz\Z'
)
SAFE_SEGMENT = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*\Z')
RUNTIME_EXTENSIONS = frozenset({'.glb', '.hcol', '.bin', '.json'})
PUBLICATION_EXTENSIONS = frozenset({'.json', '.md', '.txt'})
SHELL_ASSET = re.compile(r'assets/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:js|css|wasm)\Z')


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON object key')
        result[key] = value
    return result


def _json(data: bytes) -> Any:
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non-finite JSON number')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError('invalid UTF-8 JSON document') from error


def _integer(value: Any, maximum: int, label: str) -> int:
    if type(value) is not int or not 0 < value <= maximum:
        raise ValueError(f'{label} must be a positive integer within the publication limit')
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or DIGEST.fullmatch(value) is None:
        raise ValueError(f'{label} must be a lowercase SHA-256 digest')
    return value


def safe_relative_path(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 240:
        raise ValueError('invalid archive or manifest relative path')
    parts = value.split('/')
    if any(part in {'.', '..'} or SAFE_SEGMENT.fullmatch(part) is None for part in parts):
        raise ValueError('unsafe archive or manifest relative path')
    return value


def _publication_path(path: str) -> bool:
    return Path(path).suffix in PUBLICATION_EXTENSIONS or path.endswith('.json.gz')


def load_descriptor(path: Path) -> tuple[dict[str, Any], str]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16_384:
        raise ValueError('descriptor must be a small regular JSON file')
    data = path.read_bytes()
    value = _json(data)
    if not isinstance(value, dict) or set(value) != DESCRIPTOR_KEYS:
        raise ValueError('descriptor has unexpected or missing fields')
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('descriptor schemaVersion must be 1')
    if not isinstance(value['worldRelease'], str) or RELEASE.fullmatch(value['worldRelease']) is None:
        raise ValueError('invalid world release identifier')
    if value['worldRelease'] in {'.', '..'} or '..' in value['worldRelease']:
        raise ValueError('invalid world release identifier')
    if value['worldBaseUrl'] != WORLD_BASE_URL:
        raise ValueError('worldBaseUrl must be the approved repository Pages world directory')
    if not isinstance(value['archiveUrl'], str) or ARCHIVE_URL.fullmatch(value['archiveUrl']) is None:
        raise ValueError('archiveUrl must name the approved repository release asset')
    _digest(value['manifestSha256'], 'manifestSha256')
    _digest(value['archiveSha256'], 'archiveSha256')
    _integer(value['archiveBytes'], MAX_ARCHIVE_BYTES, 'archiveBytes')
    _integer(value['worldBytes'], MAX_WORLD_BYTES, 'worldBytes')
    return value, hashlib.sha256(data).hexdigest()


def write_github_env(descriptor: dict[str, Any], path: Path) -> None:
    # Every value is single-line and allowlisted before it reaches the runner file.
    values = {
        'VITE_WORLD_BASE_URL': descriptor['worldBaseUrl'],
        'VITE_WORLD_RELEASE': descriptor['worldRelease'],
        'VITE_WORLD_MANIFEST_SHA256': descriptor['manifestSha256'],
        'PAGES_WORLD_ARCHIVE_URL': descriptor['archiveUrl'],
        'PAGES_WORLD_ARCHIVE_BYTES': str(descriptor['archiveBytes']),
    }
    with path.open('a', encoding='utf-8', newline='\n') as stream:
        for key, value in values.items():
            stream.write(f'{key}={value}\n')


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1_048_576), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _read_exact(stream: Any, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise ValueError('truncated tar archive')
    return data


def _tar_text(field: bytes) -> str:
    value, separator, padding = field.partition(b'\0')
    if separator and padding.strip(b'\0'):
        raise ValueError('invalid tar text padding')
    try:
        return value.decode('ascii')
    except UnicodeError as error:
        raise ValueError('tar paths must be ASCII') from error


def _tar_octal(field: bytes) -> int:
    value = field.strip(b'\0 ')
    if not value or any(byte not in b'01234567' for byte in value):
        raise ValueError('invalid tar numeric field')
    return int(value, 8)


def _unpack(archive: Path, destination: Path, descriptor: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Read the small regular-file tar subset, without PAX/link interpretation.

    A bounded reader also rejects concatenated/hidden tar data and gzip bombs.
    The producer uses GNU tar, with no directory or extended-header entries.
    """
    inventory: dict[str, dict[str, Any]] = {}
    total = 0
    prefix = f"world/{descriptor['worldRelease']}/"
    with gzip.open(archive, 'rb') as stream:
        while True:
            header = _read_exact(stream, 512)
            if header == bytes(512):
                if _read_exact(stream, 512) != bytes(512):
                    raise ValueError('invalid tar end marker')
                trailer = stream.read(MAX_TRAILER_BYTES + 1)
                if len(trailer) > MAX_TRAILER_BYTES or trailer.strip(b'\0'):
                    raise ValueError('unexpected data after tar end marker')
                break
            if len(inventory) >= MAX_FILES:
                raise ValueError('archive contains too many files')
            checksum = _tar_octal(header[148:156])
            if checksum != sum(header[:148]) + 8 * 32 + sum(header[156:]):
                raise ValueError('tar header checksum mismatch')
            magic = header[257:263]
            if magic not in {b'ustar\0', b'ustar '}:
                raise ValueError('only standard GNU/ustar headers are accepted')
            if header[156:157] not in {b'0', b'\0'} or _tar_text(header[157:257]):
                raise ValueError('archive entries must be regular files without links')
            name = _tar_text(header[:100])
            if magic == b'ustar\0':
                tar_prefix = _tar_text(header[345:500])
                name = f'{tar_prefix}/{name}' if tar_prefix else name
            safe_relative_path(name)
            if not name.startswith(prefix):
                raise ValueError('archive entry is outside the pinned world release')
            relative = name[len(prefix):]
            safe_relative_path(relative)
            if Path(relative).suffix not in RUNTIME_EXTENSIONS and not _publication_path(relative):
                raise ValueError('archive contains an unapproved file type')
            if relative in inventory:
                raise ValueError('duplicate archive path')
            size = _integer(_tar_octal(header[124:136]), MAX_WORLD_BYTES, 'tar file size')
            total += size
            if total > descriptor['worldBytes'] or total > MAX_WORLD_BYTES:
                raise ValueError('archive exceeds the pinned world byte count')
            if relative == 'manifest.json' and size > MAX_MANIFEST_BYTES:
                raise ValueError('world manifest is too large')
            target = destination.joinpath(*name.split('/'))
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with target.open('xb') as output:
                remaining = size
                while remaining:
                    chunk = _read_exact(stream, min(1_048_576, remaining))
                    digest.update(chunk)
                    output.write(chunk)
                    remaining -= len(chunk)
            padding = (-size) % 512
            if padding and _read_exact(stream, padding).strip(b'\0'):
                raise ValueError('nonzero tar file padding')
            inventory[relative] = {'bytes': size, 'sha256': digest.hexdigest()}
    if total != descriptor['worldBytes']:
        raise ValueError('archive does not match the pinned world byte count')
    return inventory


def _manifest_refs(data: bytes, descriptor: dict[str, Any]) -> dict[str, dict[str, Any]]:
    manifest = _json(data)
    if not isinstance(manifest, dict) or type(manifest.get('schemaVersion')) is not int or manifest['schemaVersion'] != 2:
        raise ValueError('world manifest must use native schemaVersion 2')
    if manifest.get('worldReleaseId') != descriptor['worldRelease']:
        raise ValueError('manifest world release differs from the descriptor')
    if not isinstance(manifest.get('cells'), list) or not manifest['cells']:
        raise ValueError('manifest must contain world cells')
    if not isinstance(manifest.get('assets'), list) or not manifest['assets']:
        raise ValueError('manifest must contain runtime assets')
    if any(not isinstance(asset, dict) or 'path' not in asset for asset in manifest['assets']):
        raise ValueError('manifest assets must be pinned file references')
    for name in ['terrain', 'roads', 'gameplay']:
        if not isinstance(manifest.get(name), dict) or 'path' not in manifest[name]:
            raise ValueError('manifest is missing a required runtime file reference')
    for cell in manifest['cells']:
        if not isinstance(cell, dict) or not isinstance(cell.get('visual'), dict):
            raise ValueError('invalid manifest world cell')
        if not isinstance(cell.get('collision'), dict) or 'path' not in cell['collision']:
            raise ValueError('cell is missing its collision file reference')
        if not isinstance(cell['visual'].get('lod0'), dict) or 'path' not in cell['visual']['lod0']:
            raise ValueError('cell is missing its primary visual file reference')
    if 'scenery' in manifest and (not isinstance(manifest['scenery'], dict) or 'path' not in manifest['scenery']):
        raise ValueError('manifest scenery must be a pinned file reference')
    if 'publicationFiles' in manifest:
        if not isinstance(manifest['publicationFiles'], list) or any(
                not isinstance(item, dict) or 'path' not in item for item in manifest['publicationFiles']):
            raise ValueError('publicationFiles must be an array of pinned file references')
    refs: dict[str, dict[str, Any]] = {}

    def visit(value: Any, publication: bool = False) -> None:
        if isinstance(value, dict):
            if 'path' in value:
                path = safe_relative_path(value['path'])
                allowed = _publication_path(path) if publication else Path(path).suffix in RUNTIME_EXTENSIONS
                if path == 'manifest.json' or not allowed:
                    raise ValueError('manifest contains an unapproved referenced path')
                item = {'bytes': _integer(value.get('bytes'), MAX_WORLD_BYTES, 'file reference bytes'),
                        'sha256': _digest(value.get('sha256'), 'file reference sha256')}
                if path in refs and refs[path] != item:
                    raise ValueError('manifest contains conflicting file references')
                refs[path] = item
                if len(refs) >= MAX_FILES:
                    raise ValueError('manifest references too many files')
            for key, child in value.items():
                visit(child, publication or key == 'publicationFiles')
        elif isinstance(value, list):
            for child in value:
                visit(child, publication)

    visit(manifest)
    return refs


def _shell_inventory(output: Path) -> tuple[list[str], int]:
    if output.is_symlink() or not output.is_dir():
        raise ValueError('Pages output must be an existing regular directory')
    names: list[str] = []
    total = 0
    for directory, directories, files in os.walk(output, followlinks=False):
        for name in directories + files:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError('Pages output must not contain symlinks')
        for name in files:
            path = Path(directory) / name
            relative = path.relative_to(output).as_posix()
            if relative not in {'index.html', 'basis/basis_transcoder.js', 'basis/basis_transcoder.wasm'} and SHELL_ASSET.fullmatch(relative) is None:
                raise ValueError('Pages output contains an unexpected, source, or review file')
            if not path.is_file():
                raise ValueError('Pages output must contain only regular files')
            names.append(relative)
            total += path.stat().st_size
    if not {'index.html', 'basis/basis_transcoder.js', 'basis/basis_transcoder.wasm'}.issubset(names):
        raise ValueError('Pages output is missing its entry page or Basis decoder')
    if (output / 'world').exists():
        raise ValueError('Pages output already contains a world release')
    return sorted(names), total


def stage(descriptor_path: Path, archive: Path, output: Path, source_sha: str) -> dict[str, Any]:
    descriptor, descriptor_sha = load_descriptor(descriptor_path)
    if re.fullmatch(r'[0-9a-f]{40}', source_sha) is None:
        raise ValueError('source SHA must be the exact lowercase Git commit identifier')
    shell_files, shell_bytes = _shell_inventory(output)
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size != descriptor['archiveBytes']:
        raise ValueError('archive does not match the pinned compressed byte count')
    if _hash_file(archive) != descriptor['archiveSha256']:
        raise ValueError('archive SHA-256 does not match the committed descriptor')
    if shell_bytes + descriptor['worldBytes'] > MAX_ARTIFACT_BYTES:
        raise ValueError('Pages artifact would exceed the publication byte limit')
    with tempfile.TemporaryDirectory(prefix='.pages-world-', dir=output.parent) as temporary:
        scratch = Path(temporary)
        inventory = _unpack(archive, scratch, descriptor)
        manifest = inventory.get('manifest.json')
        if manifest is None or manifest['sha256'] != descriptor['manifestSha256']:
            raise ValueError('manifest SHA-256 does not match the committed descriptor')
        world = scratch / 'world' / descriptor['worldRelease']
        refs = _manifest_refs((world / 'manifest.json').read_bytes(), descriptor)
        expected = dict(refs)
        expected['manifest.json'] = manifest
        if set(expected) != set(inventory):
            raise ValueError('archive files do not exactly match the manifest references')
        if any(inventory[path] != value for path, value in expected.items()):
            raise ValueError('a world payload differs from its manifest digest or byte count')
        receipt = {
            'schemaVersion': 1, 'repository': 'MattiTynka/Helsinki-rides',
            'sourceCommit': source_sha, 'descriptorSha256': descriptor_sha,
            'worldRelease': descriptor['worldRelease'], 'worldBaseUrl': descriptor['worldBaseUrl'],
            'manifestSha256': descriptor['manifestSha256'],
            'archiveSha256': descriptor['archiveSha256'], 'archiveBytes': descriptor['archiveBytes'],
            'worldBytes': descriptor['worldBytes'], 'worldFiles': len(inventory),
            'shellBytes': shell_bytes, 'shellFiles': shell_files,
        }
        receipt_bytes = (json.dumps(receipt, indent=2, sort_keys=True) + '\n').encode('utf-8')
        total = shell_bytes + descriptor['worldBytes'] + len(receipt_bytes)
        if total > MAX_ARTIFACT_BYTES:
            raise ValueError('Pages artifact exceeds the publication byte limit')
        # All inputs have been verified before the first mutation of the build output.
        shutil.move(str(scratch / 'world'), str(output / 'world'))
        (output / 'release-info.json').write_bytes(receipt_bytes)
        (output / '.nojekyll').write_bytes(b'')
    return {'status': 'PASS', 'artifactBytes': total, **receipt}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    validate = commands.add_parser('validate', help='validate the committed descriptor before downloading')
    validate.add_argument('--descriptor', type=Path, required=True)
    validate.add_argument('--github-env', type=Path)
    staging = commands.add_parser('stage', help='verify and stage the pinned world in the built shell')
    staging.add_argument('--descriptor', type=Path, required=True)
    staging.add_argument('--archive', type=Path, required=True)
    staging.add_argument('--out', type=Path, required=True)
    staging.add_argument('--source-sha', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'validate':
            descriptor, sha = load_descriptor(args.descriptor)
            if args.github_env:
                write_github_env(descriptor, args.github_env)
            result = {'status': 'PASS', 'descriptorSha256': sha, **descriptor}
        else:
            result = stage(args.descriptor, args.archive, args.out, args.source_sha)
    except (ValueError, OSError, EOFError) as error:
        print(f'Pages staging refused: {error}', file=sys.stderr)
        raise SystemExit(1) from error
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
