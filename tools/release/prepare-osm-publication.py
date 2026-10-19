"""Prepare a privacy-minimized, reproducible OSM source download.

The original acquisition stays untouched. Publication removes contributor
usernames/IDs and contact tags, retaining map geometry and all other tags.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tempfile
import urllib.parse

EMAIL = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b')


def encoded(document: object) -> bytes:
    return (json.dumps(document, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf8')


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def minimize(document: dict) -> tuple[dict, dict]:
    if not isinstance(document, dict) or not isinstance(document.get('elements'), list):
        raise ValueError('Expected an OSM map document with an elements array')
    result = copy.deepcopy(document)
    removed = {'user': 0, 'uid': 0, 'contactTags': 0, 'emailValueTags': 0}
    for element in result['elements']:
        if not isinstance(element, dict) or element.get('type') not in ('node', 'way', 'relation'):
            raise ValueError('Invalid OSM element')
        for key in ('user', 'uid'):
            if key in element:
                del element[key]
                removed[key] += 1
        tags = element.get('tags', {})
        if not isinstance(tags, dict) or any(not isinstance(v, str) for v in tags.values()):
            raise ValueError('Invalid OSM tags')
        for key, value in list(tags.items()):
            if key.lower() == 'email' or key.lower().startswith('contact:'):
                del tags[key]
                removed['contactTags'] += 1
            elif EMAIL.search(urllib.parse.unquote(value)):
                del tags[key]
                removed['emailValueTags'] += 1
    return result, removed


def prepare(source: Path, ledger: Path, out: Path) -> dict:
    if out.is_symlink() or (hasattr(out, 'is_junction') and out.is_junction()):
        raise ValueError('Linked publication directories are not allowed')
    source, ledger, out = source.resolve(), ledger.resolve(), out.resolve()
    if source.is_relative_to(out) or ledger.is_relative_to(out):
        raise ValueError('Publication directory must be separate from original inputs')
    original, ledger_bytes = source.read_bytes(), ledger.read_bytes()
    book = json.loads(ledger_bytes)
    matches = [(name, row) for name, row in book.get('snapshots', {}).items()
               if row.get('sha256') == sha(original)]
    if len(matches) != 1:
        raise ValueError('Original input must match exactly one ledger snapshot')
    snapshot_name, snapshot = matches[0]
    document, removed = minimize(json.loads(original))
    payload = encoded(document)
    archive = io.BytesIO()
    with gzip.GzipFile(fileobj=archive, mode='wb', filename='', mtime=0) as stream:
        stream.write(payload)
    compressed = archive.getvalue()
    public_ledger = {
        'schemaVersion': 1,
        'source': book['source'],
        'license': 'ODbL-1.0',
        'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
        'snapshot': snapshot_name,
        'retrievedAt': snapshot.get('retrievedAt'),
        'originalInput': {'path': source.name, 'bytes': len(original), 'sha256': sha(original)},
        'originalLedger': {'path': ledger.name, 'bytes': len(ledger_bytes), 'sha256': sha(ledger_bytes)},
        'publication': {
            'path': 'osm-source.json.gz', 'contentEncoding': 'gzip',
            'bytes': len(compressed), 'sha256': sha(compressed),
            'uncompressedBytes': len(payload), 'uncompressedSha256': sha(payload),
            'elements': len(document['elements']),
        },
        'transformation': {
            'tool': 'tools/release/prepare-osm-publication.py',
            'toolSha256': sha(Path(__file__).read_bytes()),
            'method': 'Remove each element user and uid; remove tags named email or prefixed contact: '
                      '(case insensitive), and any other tag with an email-shaped literal or percent-decoded value. '
                      'Serialize UTF-8 compact JSON with one final newline; gzip with mtime zero.',
            'removedFields': removed,
            'preserved': 'All element IDs, coordinates, node/member references, ordering, source notices '
                         'and retained tags are unchanged. This is a minimized derivative, not the original source bytes.',
        },
        'acquisitionMethod': snapshot.get('acquisition'),
    }
    out.mkdir(parents=True, exist_ok=True)
    if out.is_symlink() or (hasattr(out, 'is_junction') and out.is_junction()):
        raise ValueError('Linked publication directories are not allowed')
    outputs = {'osm-source.json.gz': compressed, 'osm-source-ledger.json': encoded(public_ledger)}
    for name in outputs:
        target = out / name
        if target.exists() and (target.is_symlink() or (hasattr(target, 'is_junction') and target.is_junction())):
            raise ValueError('Linked publication files are not allowed')
    for name, data in outputs.items():
        # Replacing a fresh file also prevents an existing hardlink from mutating
        # an original input or another publication artifact.
        with tempfile.NamedTemporaryFile(dir=out, prefix='.osm-publication-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        try:
            temporary.replace(out / name)
        finally:
            temporary.unlink(missing_ok=True)
    return public_ledger


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = prepare(args.source, args.ledger, args.out)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'ERROR', 'errorType': type(error).__name__}))
        return 1
    print(json.dumps({'status': 'PASS', 'publication': result['publication'],
                      'removedFields': result['transformation']['removedFields']}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
