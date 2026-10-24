"""Curate and audit the source release; never read environment files or follow links.

python tools/release/source_release.py audit [--root DIRECTORY] [--git]
python tools/release/source_release.py export --out build/source-release

This bounded privacy check complements an independent Gitleaks scan. It is not a
claim that arbitrary unknown credentials can be recognized by pattern matching.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zlib

ROOT = Path(__file__).resolve().parents[2]
ROOT_FILES = {
    '.gitignore', '.gitattributes', '.gitleaks.toml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'CONTRIBUTING.md', 'SECURITY.md', 'package.json', 'pnpm-lock.yaml',
    'pnpm-workspace.yaml', 'tsconfig.base.json',
}
SOURCE_DIRS = {'apps', 'packages', 'tools', 'content', 'docs', '.github', 'skills'}
PUBLIC_SKILLS = {'build-helsinki-game', 'motion-design', 'texture-mapping-3d'}
SKILL_SOURCE_DIRS = {'agents', 'assets', 'references', 'scripts', 'tests'}
OMIT_DIRS = {'node_modules', 'dist', 'dist-pages', '__pycache__', '.git'}
TEXT_SUFFIXES = {'.ts', '.mjs', '.js', '.py', '.json', '.geojson', '.md', '.yaml', '.yml', '.html', '.css', '.svg'}
COMPRESSED_JSON = {
    'content/helsinki/city-expansion-20261021/road-registration-source-gate-v2.json.gz',
    'content/helsinki/city-expansion-20261021/road-registration-source-v1.json.gz',
}
MAX_DECODED_SOURCE_BYTES = 64 * 1024 * 1024
IMAGES = {
    'apps/game/src/assets/senate-square-start.jpg',
    'content/helsinki/city-expansion-20261021/theatre-facade/v1/facade.png',
    'content/assets/facades/estates/front-2021.jpg',
    'content/assets/facades/estates/park-2022.jpg',
    'content/assets/facades/esplanadi/catani-valtonen.jpg',
    *(f'content/helsinki/district-expansion/facade-charts/canalside-v{i}/canalside-original.png' for i in (1, 2, 3)),
    *(f'content/helsinki/senate-facades/v1/{vtj}/facade.png' for vtj in ('103017637K', '103036705N', '1030368080')),
    *(f'content/helsinki/city-facades/v1/{cell}/facade.png' for cell in ('c_m02_p00', 'c_m02_p02', 'c_m02_m02', 'c_m06_m01', 'c_m02_p01')),
    *(f'content/assets/facades/new-area/{name}/facade.png' for name in (
        'anonymous/1851b11d/northwest', 'anonymous/96ce40d5/corner', 'anonymous/96ce40d5/east',
        'anonymous/96ce40d5/south', 'anonymous/a83797fb/west', 'anonymous/de9b9a73/northeast',
        'linjat/toinen-10/front', 'linjat/toinen-12-103151972Y/northeast', 'linjat/toinen-14/northwest')),
}
DECODERS = {'apps/game/public/basis/basis_transcoder.js', 'apps/game/public/basis/basis_transcoder.wasm'}
PUBLIC_HANDLE = 'MattiTynka'
PUBLIC_EMAIL = PUBLIC_HANDLE + '@users.noreply.github.com'
PUBLIC_AUTHOR_NAMES = {PUBLIC_HANDLE, 'Matti Tynka'}
OMIT_FILES = {f'content/assets/facades/estates/DSC{number}.jpg' for number in ('05064', '05070', '05072')}
PATTERNS = {
    'personal-home-path': re.compile(r'(?:[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+|/(?:Users|home)/)[^\s"<>]+', re.I),
    'private-key': re.compile(r'-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----'),
    'provider-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,})'),
    'credential-assignment': re.compile(r'''(?i)\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\b\s*[:=]\s*["'][A-Za-z0-9_+/=-]{12,}["']'''),
    'credential-in-url': re.compile(r'https?://[^\s/:]+:[^\s/@]+@[^\s/]+'),
    'email': re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
}


def selected(relative: str) -> bool:
    p = Path(relative)
    parts = p.parts
    if not parts or any(x in OMIT_DIRS for x in parts) or relative.startswith('apps/game/public/world/'):
        return False
    if relative in OMIT_FILES or relative.endswith(('.rgba.deflate', '.pyc', '.log')):
        return False
    if p.name.startswith('.env'):
        return False
    if parts[0] == 'skills':
        if relative == 'skills/README.md':
            return True
        if len(parts) < 3 or parts[1] not in PUBLIC_SKILLS:
            return False
        if len(parts) == 3:
            return p.name in {'SKILL.md', 'LICENSE'}
        return parts[2] in SKILL_SOURCE_DIRS and p.suffix in TEXT_SUFFIXES | {'.sh'}
    return relative in ROOT_FILES or relative in IMAGES or relative in DECODERS or relative in COMPRESSED_JSON or (
        parts[0] in SOURCE_DIRS and p.suffix in TEXT_SUFFIXES)


def source_files(root: Path) -> list[str]:
    files = [name for name in sorted(ROOT_FILES) if (root / name).is_file()]
    for dirname in sorted(SOURCE_DIRS):
        for folder, dirs, names in os.walk(root / dirname, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in OMIT_DIRS and not (Path(folder) / d).is_symlink()
                             and not (Path(folder) / d).is_junction()) if hasattr(Path(), 'is_junction') else sorted(
                d for d in dirs if d not in OMIT_DIRS and not (Path(folder) / d).is_symlink())
            if Path(folder).relative_to(root).as_posix() == 'apps/game/public':
                dirs[:] = [d for d in dirs if d != 'world']
            for name in sorted(names):
                p = Path(folder) / name
                relative = p.relative_to(root).as_posix()
                if selected(relative):
                    if p.is_symlink() or not p.resolve().is_relative_to(root.resolve()):
                        raise ValueError(f'Linked source is not allowed: {relative}')
                    files.append(relative)
    return sorted(set(files))


def sample_only(value: str) -> bool:
    # Reserved example domains are intentional adversarial URL fixtures, not identities.
    host = value.rsplit('@', 1)[-1].split('/')[0].rstrip("'\",]")
    return host in {'example.org', 'example.com', 'example.net', 'example.invalid'} or host.endswith(
        ('.example.org', '.example.com', '.example.net', '.example.invalid'))


def scan_text(name: str, text: str) -> list[dict]:
    findings = []
    for rule, pattern in PATTERNS.items():
        for match in pattern.finditer(text):
            if rule in {'email', 'credential-in-url'} and sample_only(match.group()):
                continue
            findings.append({'file': name, 'line': text.count('\n', 0, match.start()) + 1, 'rule': rule})
    return findings


def source_text(name: str, data: bytes) -> str:
    if name in COMPRESSED_JSON:
        # The exact two public datasets may be compressed; never skip their
        # decoded privacy scan or accept filenames/comments in gzip headers.
        if len(data) < 10 or data[:3] != b'\x1f\x8b\x08' or data[3] != 0:
            raise ValueError('invalid or metadata-bearing compressed source')
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            decoded = decoder.decompress(data, MAX_DECODED_SOURCE_BYTES + 1)
        except zlib.error as error:
            raise ValueError('invalid compressed source') from error
        if len(decoded) > MAX_DECODED_SOURCE_BYTES:
            raise ValueError('decoded source limit exceeded')
        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise ValueError('compressed source must contain exactly one complete member')
        data = decoded
        text = data.decode('utf-8-sig')
        json.loads(text)
        return text
    return data.decode('utf-8-sig')


def git_output(root: Path, *args: str) -> bytes:
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=False)
    if result.returncode:
        # Git errors can contain the operator's absolute path. Never echo stderr.
        raise ValueError(f'Git audit command failed: {args[0]}')
    return result.stdout


def image_findings(name: str, data: bytes) -> list[dict]:
    spec = importlib.util.spec_from_file_location('image_sanitizer', ROOT / 'tools/release/sanitize-images.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        cleaned, _, _ = (module.sanitize_jpeg if name.endswith('.jpg') else module.sanitize_png)(data)
        return [] if cleaned == data else [{'file': name, 'rule': 'image-private-metadata'}]
    except ValueError:
        return [{'file': name, 'rule': 'invalid-image-structure'}]


def audit(root: Path, include_git: bool = False, images: bool = False) -> dict:
    files = source_files(root)
    findings = []
    byte_count = 0
    inventory = []
    for name in files:
        data = (root / name).read_bytes()
        byte_count += len(data)
        inventory.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        findings.extend(scan_text(name, name))
        if images and name in IMAGES:
            findings.extend(image_findings(name, data))
        if name not in IMAGES and not name.endswith('.wasm'):
            try:
                findings.extend(scan_text(name, source_text(name, data)))
            except (UnicodeDecodeError, ValueError, OSError, EOFError):
                findings.append({'file': name, 'rule': 'invalid-compressed-source' if name in COMPRESSED_JSON else 'unexpected-binary'})
        if len(data) > 25_000_000:
            findings.append({'file': name, 'rule': 'oversize-source'})
    commits = 0
    if include_git:
        # Inspect every reachable commit, its metadata, every tree path, and unique blob.
        commit_ids = git_output(root, 'rev-list', '--all').decode().splitlines()
        commits = len(commit_ids)
        seen = set()
        for commit in commit_ids:
            metadata = git_output(root, 'show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', commit).decode('utf8')
            # Keep legacy handle attribution and the approved display name on the same public email.
            rows = metadata.splitlines()
            if (len(rows) < 4 or rows[0] not in PUBLIC_AUTHOR_NAMES or rows[1] != PUBLIC_EMAIL
                    or rows[2] not in PUBLIC_AUTHOR_NAMES or rows[3] != PUBLIC_EMAIL):
                findings.append({'file': 'git-metadata', 'commit': commit, 'rule': 'unreviewed-author-identity'})
            findings.extend(scan_text(f'commit/{commit}', '\n'.join(rows[4:])))
            for entry in git_output(root, 'ls-tree', '-r', '-z', commit).split(b'\0'):
                if not entry:
                    continue
                info, raw_name = entry.split(b'\t', 1)
                mode, kind, oid = info.decode().split()
                name = raw_name.decode('utf8')
                if not selected(name) or mode not in {'100644', '100755'} or kind != 'blob':
                    findings.append({'file': name, 'commit': commit, 'rule': 'unapproved-git-path'})
                if oid in seen:
                    continue
                seen.add(oid)
                blob = git_output(root, 'cat-file', 'blob', oid)
                if images and name in IMAGES:
                    findings.extend(image_findings(name, blob))
                if name not in IMAGES and not name.endswith('.wasm'):
                    try:
                        findings.extend(scan_text(name, source_text(name, blob)))
                    except (UnicodeDecodeError, ValueError, OSError, EOFError):
                        findings.append({'file': name, 'rule': 'invalid-compressed-git-source' if name in COMPRESSED_JSON else 'unexpected-git-binary'})
    return {'schemaVersion': 1, 'status': 'PASS' if not findings else 'FAIL', 'files': len(files),
            'bytes': byte_count, 'commits': commits, 'imageMetadataChecked': images,
            'findings': findings, 'inventory': inventory}


def export(root: Path, out: Path) -> dict:
    root, out = root.resolve(), out.resolve()
    if not out.is_relative_to(root / 'build') or out == root / 'build' or out.exists():
        raise ValueError('Export requires a new directory below build/; existing exports are never overwritten')
    before = audit(root)
    if before['findings']:
        return before
    out.mkdir(parents=True)
    for name in source_files(root):
        dest = out / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, dest)
    sanitizer = root / 'tools/release/sanitize-images.py'
    result = subprocess.run([sys.executable, str(sanitizer), '--export-root', str(out)], capture_output=True)
    if result.returncode:
        raise ValueError('Export image sanitization failed; inspect the sanitizer without exposing metadata')
    receipt = json.loads(result.stdout)
    # Keep input integrity checks valid for the lossless, privacy-sanitized copies.
    credits_path = out / 'content/assets/facades/estates/credits.json'
    credits = json.loads(credits_path.read_text('utf8'))
    module_path = out / 'tools/world/lib/estates-facade-restoration.ts'
    module = module_path.read_text('utf8')
    for row in receipt['images']:
        if not row['changed']:
            continue
        matches = [a for a in credits['assets'] if row['path'].endswith('/' + a['file'])]
        if len(matches) != 1 or matches[0]['sha256'] != row['beforeSha256'] or module.count(row['beforeSha256']) != 1:
            raise ValueError('Unexpected sanitized image pin; review its consumers before exporting')
        matches[0].update({'sourceSha256': row['beforeSha256'], 'sha256': row['afterSha256'],
                          'privacyChanges': 'Non-rendering camera/location/contact metadata removed; encoded pixels unchanged.'})
        module = module.replace(row['beforeSha256'], row['afterSha256'])
    credits_path.write_text(json.dumps(credits, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
    module_path.write_text(module, encoding='utf8')
    report = audit(out, images=True)
    report['imageSanitization'] = receipt
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['audit', 'export'])
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--git', action='store_true')
    parser.add_argument('--images', action='store_true', help='Require sanitized image metadata (use on the export)')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if args.command == 'export' and args.out is None:
        parser.error('export requires --out')
    try:
        result = export(args.root, args.out) if args.command == 'export' else audit(args.root, args.git, args.images)
    except (ValueError, OSError) as error:
        # No exception paths, credential contents or source lines in public logs.
        print(json.dumps({'status': 'ERROR', 'errorType': type(error).__name__}))
        return 2
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2) + '\n', encoding='utf8')
    print(json.dumps({key: value for key, value in result.items() if key != 'inventory'}, indent=2))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
