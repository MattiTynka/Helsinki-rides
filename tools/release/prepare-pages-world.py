#!/usr/bin/env python3
"""Derive a smaller Pages world by retaining existing UASTC mip levels.

No encoder, geometry decoder or image resampler is involved. KTX2 layout follows
https://github.com/KhronosGroup/KTX-Specification/blob/main/ktxspec.adoc.
The original world and the active pointer are never changed. Output is a new,
deterministic world tree and a GNU regular-file-only tar.gz beside that tree.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import tarfile


KTX2 = b'\xabKTX 20\xbb\r\n\x1a\n'
SHA = re.compile(r'^[0-9a-f]{64}$')
RELEASE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,100}$')
PRIVACY_SPEC = importlib.util.spec_from_file_location('pages_source_privacy', Path(__file__).with_name('source_release.py'))
PRIVACY = importlib.util.module_from_spec(PRIVACY_SPEC)
PRIVACY_SPEC.loader.exec_module(PRIVACY)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')


def check_private(value, context):
    """Reject concrete private home paths/credentials without printing values."""
    if isinstance(value, str):
        require(not PRIVACY.scan_text(context, value), 'Private metadata detected in ' + context)
    elif isinstance(value, dict):
        for key, item in value.items():
            check_private(key, context)
            check_private(item, context)
    elif isinstance(value, list):
        for item in value:
            check_private(item, context)


def safe_path(root, relative):
    require(isinstance(relative, str) and bool(relative), 'Missing payload path')
    require('\\' not in relative and ':' not in relative and '%' not in relative and '\x00' not in relative,
            'Unsafe payload path')
    p = PurePosixPath(relative)
    require(not p.is_absolute() and all(part not in ('', '.', '..') for part in relative.split('/')),
            'Unsafe payload path')
    target = root.joinpath(*p.parts)
    require(target.resolve().is_relative_to(root.resolve()), 'Payload leaves release directory')
    cursor = target
    while cursor != root:
        require(not cursor.is_symlink() and not cursor.is_junction(), 'Linked payload path')
        cursor = cursor.parent
    return target


def refs(value):
    if isinstance(value, dict):
        if 'path' in value:
            require({'path', 'bytes', 'sha256'}.issubset(value), 'Incomplete file reference')
            require(type(value['bytes']) is int and value['bytes'] >= 0 and SHA.fullmatch(value['sha256']),
                    'Invalid file reference')
            yield value
        for item in value.values():
            yield from refs(item)
    elif isinstance(value, list):
        for item in value:
            yield from refs(item)


def span(data, start, length, label):
    require(type(start) is int and type(length) is int and start >= 0 and length >= 0 and start + length <= len(data),
            'Invalid ' + label + ' range')
    return data[start:start + length]


def nonoverlap(ranges):
    ordered = sorted((s, e) for s, e in ranges if s != e)
    require(all(a[1] <= b[0] for a, b in zip(ordered, ordered[1:])), 'Overlapping payload ranges')


def ktx_info(data):
    require(len(data) >= 80 and data[:12] == KTX2, 'Invalid KTX2 texture')
    h = list(struct.unpack_from('<13I2Q', data, 12))
    vk, size, width, height, depth, layers, faces, count, scheme, do, dl, ko, kl, so, sl = h
    require(width > 0 and height > 0 and depth == 0 and layers == 0 and faces == 1 and 1 <= count <= 32,
            'Only ordinary 2D KTX2 textures are supported')
    require(count <= 1 + int(math.log2(max(width, height))), 'Invalid KTX2 mip count')
    index_end = 80 + count * 24
    require(index_end <= len(data), 'Truncated KTX2 level index')
    dfd = span(data, do, dl, 'KTX2 DFD')
    require(len(dfd) >= 28 and do % 4 == 0 and struct.unpack_from('<I', dfd)[0] == dl,
            'Invalid KTX2 data format descriptor')
    kvd = span(data, ko, kl, 'KTX2 KVD') if kl else b''
    if kl:
        require(ko % 4 == 0, 'Unaligned KTX2 KVD')
    pos = 0
    while pos < len(kvd):
        require(pos + 4 <= len(kvd), 'Truncated KTX2 key/value length')
        length = struct.unpack_from('<I', kvd, pos)[0]
        field = span(kvd, pos + 4, length, 'KTX2 key/value')
        require(b'\0' in field, 'Malformed KTX2 key/value')
        check_private(field.decode('utf-8', errors='replace'), 'KTX2 key/value')
        pos = (pos + 4 + length + 3) & ~3
    require(pos == len(kvd), 'Malformed KTX2 key/value padding')
    levels = [struct.unpack_from('<3Q', data, 80 + i * 24) for i in range(count)]
    ranges = [(0, index_end), (do, do + dl)]
    if kl:
        ranges.append((ko, ko + kl))
    if sl:
        span(data, so, sl, 'KTX2 SGD')
        ranges.append((so, so + sl))
    for offset, length, raw in levels:
        # BasisLZ/ETC1S has no independent inflated level size and uses zero.
        require(length > 0 and (raw > 0 or scheme == 1), 'Empty KTX2 mip level')
        span(data, offset, length, 'KTX2 level')
        ranges.append((offset, offset + length))
    nonoverlap(ranges)
    return {'header': h, 'width': width, 'height': height, 'levels': levels,
            'dfd': dfd, 'kvd': kvd, 'model': dfd[12], 'scheme': scheme}


def resident_bytes(info):
    """Exact block allocation estimate for BC7 UASTC / BC1-or-BC3 ETC1S."""
    model = info['model']
    require(model in (163, 166), 'Unsupported KTX2 colour model')
    if model == 166:
        block = 16
    else:
        block_size = struct.unpack_from('<H', info['dfd'], 10)[0]
        require(block_size >= 40 and (block_size - 24) % 16 == 0, 'Invalid ETC1S DFD')
        block = 16 if (block_size - 24) // 16 > 1 else 8
    return sum(max(1, (max(1, info['width'] >> i) + 3) // 4) *
               max(1, (max(1, info['height'] >> i) + 3) // 4) * block
               for i in range(len(info['levels'])))


def trim_ktx2(data, maximum):
    info = ktx_info(data)
    if max(info['width'], info['height']) <= maximum:
        return data, resident_bytes(info), 0
    h = info['header'][:]
    require(h[0] == 0 and h[1] == 1 and info['model'] == 166 and h[8] in (0, 2) and h[13] == 0 and h[14] == 0,
            'Resize requires UASTC with no supercompression global data, scheme 0 or Zstd')
    require(info['dfd'][16:20] == bytes((3, 3, 0, 0)), 'Unsupported UASTC block dimensions')
    dropped = 0
    while max(max(1, info['width'] >> dropped), max(1, info['height'] >> dropped)) > maximum:
        dropped += 1
    require(dropped < len(info['levels']), 'Missing retained KTX2 mip levels')
    for i, (_, length, raw) in enumerate(info['levels']):
        expected = ((max(1, info['width'] >> i) + 3) // 4) * ((max(1, info['height'] >> i) + 3) // 4) * 16
        require(raw == expected and (h[8] != 0 or length == raw), 'Invalid UASTC mip byte length')
    kept = info['levels'][dropped:]
    h[2], h[3], h[7] = max(1, h[2] >> dropped), max(1, h[3] >> dropped), len(kept)
    out = bytearray(80 + len(kept) * 24)
    h[9], h[10] = len(out), len(info['dfd'])
    out.extend(info['dfd'])
    if info['kvd']:
        out.extend(b'\0' * (-len(out) % 4))
        h[11], h[12] = len(out), len(info['kvd'])
        out.extend(info['kvd'])
    else:
        h[11] = h[12] = 0
    # KTX2 stores the smallest level first; Zstd levels are independent and need
    # no alignment. Unsupcompressed UASTC has a 16-byte texel-block alignment.
    newlevels = [None] * len(kept)
    for i in range(len(kept) - 1, -1, -1):
        offset, length, raw = kept[i]
        if h[8] == 0:
            out.extend(b'\0' * (-len(out) % 16))
        newlevels[i] = (len(out), length, raw)
        out.extend(data[offset:offset + length])
    out[:12] = KTX2
    struct.pack_into('<13I2Q', out, 12, *h)
    for i, level in enumerate(newlevels):
        struct.pack_into('<3Q', out, 80 + i * 24, *level)
    final = ktx_info(out)
    require(final['dfd'] == info['dfd'] and final['kvd'] == info['kvd'], 'KTX2 metadata changed')
    for old, new in zip(kept, final['levels']):
        require(data[old[0]:old[0] + old[1]] == out[new[0]:new[0] + new[1]], 'KTX2 mip payload changed')
    return bytes(out), resident_bytes(final), dropped


def read_glb(data):
    require(len(data) >= 28 and struct.unpack_from('<III', data) == (0x46546c67, 2, len(data)), 'Invalid GLB header')
    length, kind = struct.unpack_from('<II', data, 12)
    require(kind == 0x4e4f534a and length % 4 == 0, 'Invalid GLB JSON chunk')
    doc = json.loads(span(data, 20, length, 'GLB JSON'))
    check_private(doc, 'GLB JSON')
    base = 20 + length
    require(base + 8 <= len(data), 'Missing GLB BIN chunk')
    bl, bt = struct.unpack_from('<II', data, base)
    require(bt == 0x004e4942 and bl % 4 == 0 and base + 8 + bl == len(data), 'Invalid GLB BIN chunk')
    binary = data[base + 8:]
    require(doc.get('buffers') and 'uri' not in doc['buffers'][0], 'GLB buffer0 must be embedded')
    require(0 <= bl - doc['buffers'][0]['byteLength'] <= 3, 'Invalid GLB buffer length')
    return doc, binary[:doc['buffers'][0]['byteLength']]


def trim_glb(data, maximum):
    doc, binary = read_glb(data)
    views = doc.get('bufferViews', [])
    replacements, seen, estimated, changes = [], set(), 0, []
    for image in doc.get('images', []):
        require('uri' not in image and type(image.get('bufferView')) is int, 'Only embedded GLB images supported')
        index = image['bufferView']
        require(0 <= index < len(views), 'Invalid GLB image bufferView')
        if index in seen:
            continue
        seen.add(index)
        view = views[index]
        require(view.get('buffer') == 0, 'Image must use embedded buffer0')
        start, length = view.get('byteOffset', 0), view['byteLength']
        payload = span(binary, start, length, 'GLB image')
        if image.get('mimeType') == 'image/ktx2':
            result, resident, dropped = trim_ktx2(payload, maximum)
        elif image.get('mimeType') == 'image/png':
            require(payload[:8] == b'\x89PNG\r\n\x1a\n' and payload[12:16] == b'IHDR', 'Invalid GLB PNG')
            width, height = struct.unpack_from('>II', payload, 16)
            require(0 < max(width, height) <= maximum, 'Oversized PNG cannot be resized losslessly')
            result, dropped = payload, 0
            resident = sum(max(1, width >> i) * max(1, height >> i) * 4 for i in range(1 + int(math.log2(max(width, height)))))
        else:
            raise ValueError('Unsupported embedded city image type')
        estimated += resident
        if dropped:
            require(start % 4 == 0, 'Unaligned image bufferView')
            replacements.append((start, start + length, result, index))
            changes.append({'image': index, 'droppedLevels': dropped, 'sourceBytes': len(payload), 'bytes': len(result)})
    if not replacements:
        return data, estimated, []
    replacements.sort()
    nonoverlap([(s, e) for s, e, _, _ in replacements])
    # Replace only image ranges. Preserve all intervening bytes, including meshopt
    # streams, orphaned bytes and existing padding, with a 4-aligned delta.
    newbin, cursor, shifts, image_offsets = bytearray(), 0, [], {}
    for start, end, payload, index in replacements:
        newbin.extend(binary[cursor:start])
        image_offsets[index] = len(newbin)
        newbin.extend(payload)
        newbin.extend(b'\0' * ((end - start - len(payload)) % 4))
        shifts.append((start, end, len(newbin) - end))
        cursor = end
    newbin.extend(binary[cursor:])

    def translated(start, length, label):
        span(binary, start, length, label)
        require(all(start + length <= s or start >= e for s, e, _, _ in replacements),
                'Unexpected buffer range overlaps replaced image')
        delta = 0
        for _, end, shift in shifts:
            if start >= end:
                delta = shift
        return start + delta

    by_index = {i: payload for _, _, payload, i in replacements}
    for index, view in enumerate(views):
        if view.get('buffer') == 0:
            if index in by_index:
                view['byteOffset'], view['byteLength'] = image_offsets[index], len(by_index[index])
            else:
                view['byteOffset'] = translated(view.get('byteOffset', 0), view['byteLength'], 'GLB bufferView')
        meshopt = view.get('extensions', {}).get('EXT_meshopt_compression')
        if meshopt and meshopt.get('buffer') == 0:
            meshopt['byteOffset'] = translated(meshopt.get('byteOffset', 0), meshopt['byteLength'], 'meshopt stream')
    doc['buffers'][0]['byteLength'] = len(newbin)
    encoded = json_bytes(doc).rstrip(b'\n')
    encoded += b' ' * (-len(encoded) % 4)
    newbin.extend(b'\0' * (-len(newbin) % 4))
    total = 12 + 8 + len(encoded) + 8 + len(newbin)
    out = struct.pack('<III', 0x46546c67, 2, total) + struct.pack('<II', len(encoded), 0x4e4f534a) + encoded
    out += struct.pack('<II', len(newbin), 0x004e4942) + newbin
    read_glb(out)
    return bytes(out), estimated, changes


def prepare(source, out, maximum=1024, release=None, archive=None, publication_dir=None):
    source, out = Path(source).resolve(), Path(out).absolute()
    require(source.is_dir() and not source.is_symlink(), 'Missing source release directory')
    require(not out.resolve().is_relative_to(source), 'Output must be outside source release')
    require(not out.exists(), 'Output directory must not exist')
    require(type(maximum) is int and maximum >= 4 and maximum & (maximum - 1) == 0, 'Maximum texture size must be a power of two >=4')
    original = safe_path(source, 'manifest.json').read_bytes()
    manifest = json.loads(original)
    check_private(manifest, 'manifest')
    require(manifest.get('schemaVersion') == 2 and isinstance(manifest.get('cells'), list), 'Unsupported world manifest')
    source_id = manifest.get('worldReleaseId')
    require(isinstance(source_id, str) and RELEASE.fullmatch(source_id), 'Invalid source release identifier')
    source_hash = sha(original)
    release = release or 'senate-pages-20261019-' + source_hash[:8] + '-tex' + str(maximum)
    require(RELEASE.fullmatch(release) and release != source_id, 'Invalid derivative release identifier')
    references, input_by_path = list(refs(manifest)), {}
    for ref in references:
        path = safe_path(source, ref['path'])
        require(path.is_file(), 'Missing referenced payload: ' + ref['path'])
        prior = input_by_path.get(ref['path'])
        if prior is not None:
            require((prior['bytes'], prior['sha256']) == (ref['bytes'], ref['sha256']), 'Conflicting payload references')
            continue
        require(path.stat().st_size == ref['bytes'], 'Payload byte count mismatch: ' + ref['path'])
        require(file_sha(path) == ref['sha256'], 'Payload SHA256 mismatch: ' + ref['path'])
        input_by_path[ref['path']] = ref
    source_bytes = len(original) + sum(r['bytes'] for r in input_by_path.values())
    detailed = {}
    for cell in manifest['cells']:
        visual = cell['visual']['lod0']
        require(visual['path'].endswith('.glb'), 'Detailed cell must be GLB')
        detailed[visual['path']] = visual
    for cell in manifest['cells']:
        for tier, item in cell['visual'].items():
            require(tier == 'lod0' or item['path'] not in detailed, 'Detailed and distant cell files must be distinct')
    archive = Path(archive).absolute() if archive else out.with_suffix('.tar.gz')
    require(not archive.exists() and not archive.resolve().is_relative_to(out.resolve()), 'Archive must be new and outside payload tree')
    publications = []
    if publication_dir is not None:
        publication_dir = Path(publication_dir).resolve()
        require(publication_dir.is_dir(), 'Missing publication directory')
        for item in sorted(publication_dir.rglob('*')):
            require(not item.is_symlink() and not item.is_junction(), 'Linked publication payload')
            if item.is_dir():
                continue
            require(item.is_file() and (item.suffix.lower() in ('.md', '.txt', '.json') or item.name.endswith('.json.gz')),
                    'Unsupported publication payload')
            name = 'publication/' + item.relative_to(publication_dir).as_posix()
            require(name not in input_by_path, 'Publication payload conflicts with source manifest')
            content = item.read_bytes()
            text = gzip.decompress(content).decode('utf-8') if item.name.endswith('.json.gz') else content.decode('utf-8')
            check_private(text, 'publication text')
            if item.name.endswith(('.json', '.json.gz')):
                check_private(json.loads(text), 'publication JSON')
            publications.append((name, content))
    out.mkdir(parents=True)
    destination = out / 'world' / release
    destination.mkdir(parents=True)
    modifications, replacements, file_receipts = [], {}, []
    for name in sorted(input_by_path):
        ref = input_by_path[name]
        path = safe_path(source, name)
        final_name, digest, size = name, ref['sha256'], ref['bytes']
        if name in detailed:
            payload, resident, changes = trim_glb(path.read_bytes(), maximum)
            if changes:
                digest, size = sha(payload), len(payload)
                p = PurePosixPath(name)
                final_name = str(p.with_name(p.stem + '.pages-' + digest[:12] + p.suffix))
                replacements[name] = (final_name, size, digest, resident)
                modifications.append({'sourcePath': name, 'path': final_name, 'sourceBytes': ref['bytes'],
                                      'bytes': size, 'images': changes})
                target = safe_path(destination, final_name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
            else:
                target = safe_path(destination, name)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
        else:
            target = safe_path(destination, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        file_receipts.append({'path': final_name, 'bytes': size, 'sha256': digest})
    for ref in references:
        if ref['path'] in replacements:
            name, size, digest, resident = replacements[ref['path']]
            ref.update(path=name, bytes=size, sha256=digest)
            if 'textureBytesEstimate' in ref:
                ref['textureBytesEstimate'] = resident
    if publications:
        newrefs = []
        for name, content in publications:
            target = safe_path(destination, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            item = {'path': name, 'bytes': len(content), 'sha256': sha(content)}
            file_receipts.append(item)
            newrefs.append(item)
        manifest['publicationFiles'] = manifest.get('publicationFiles', []) + newrefs
    manifest['worldReleaseId'] = release
    encoded = json_bytes(manifest)
    (destination / 'manifest.json').write_bytes(encoded)
    manifest_hash = sha(encoded)
    file_receipts.append({'path': 'manifest.json', 'bytes': len(encoded), 'sha256': manifest_hash})
    world_bytes = sum(f['bytes'] for f in file_receipts)
    require(world_bytes <= 950_000_000, 'Pages world exceeds 950000000-byte publication budget')
    archive.parent.mkdir(parents=True, exist_ok=True)
    with archive.open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=6) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.GNU_FORMAT) as tar:
                for item in sorted(file_receipts, key=lambda f: f['path']):
                    member = tarfile.TarInfo('world/' + release + '/' + item['path'])
                    member.size, member.mode, member.mtime, member.uid, member.gid = item['bytes'], 0o644, 0, 0, 0
                    with safe_path(destination, item['path']).open('rb') as stream:
                        tar.addfile(member, stream)
    return {'schemaVersion': 1, 'sourceWorldRelease': source_id, 'sourceManifestSha256': source_hash,
            'release': release, 'manifestSha256': manifest_hash, 'worldBytes': world_bytes,
            'files': len(file_receipts), 'cells': len(manifest['cells']), 'maxTextureSize': maximum,
            'modifiedCells': len(modifications), 'modifiedImages': sum(len(m['images']) for m in modifications),
            'sourceBytes': source_bytes,
            'archiveFile': archive.name, 'archiveBytes': archive.stat().st_size, 'archiveSha256': file_sha(archive),
            'preservation': {'geometry': 'exact original bytes', 'nonImageBufferData': 'exact original bytes',
                             'heroAssets': 'byte exact', 'distantCells': 'byte exact', 'collisionAndGameplay': 'byte exact'},
            'modifications': modifications, 'publicationFiles': file_receipts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--max-texture-size', type=int, default=1024)
    parser.add_argument('--release')
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--publication-dir', type=Path, help='Public notices and source database files, copied under publication/')
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    try:
        receipt = prepare(args.source, args.out, args.max_texture_size, args.release, args.archive, args.publication_dir)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_bytes(json_bytes(receipt))
        print(json.dumps({k: v for k, v in receipt.items() if k not in ('modifications', 'publicationFiles')}, indent=2))
    except (ValueError, OSError, KeyError, struct.error, json.JSONDecodeError) as error:
        parser.exit(1, 'Pages world preparation failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
