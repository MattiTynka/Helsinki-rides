#!/usr/bin/env python3
"""Read-only served-object gate for the one approved pinned GitHub raw profile."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path
import urllib.error
import urllib.request
import zlib

spec = importlib.util.spec_from_file_location('raw_verification_preparer', Path(__file__).with_name('prepare-external-world.py'))
external = importlib.util.module_from_spec(spec)
spec.loader.exec_module(external)
pages, raw = external.pages, external.pages.github_raw


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('GitHub raw redirects are forbidden')


def request(url, method):
    # All callers use descriptor-derived relative paths under an exact allowlisted base.
    return urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(
        url, method=method, headers={'Origin': pages.GAME_ORIGIN, 'Accept-Encoding': 'gzip'}), timeout=30)


def verify_response(response, url, name, item, body=True):
    if response.status != 200 or response.geturl() != url:
        raise ValueError('served object status or URL differs')
    headers = dict(response.headers)
    encoding = raw.validate_headers(name, headers)
    if not body:
        return {'status': 200, 'contentEncoding': encoding or None}
    digest, count, wire = hashlib.sha256(), 0, 0
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == 'gzip' else None
    while block := response.read(65_536):
        wire += len(block)
        if wire > item['bytes'] + 1_048_576:
            raise ValueError('served response exceeds bounded transport bytes')
        decoded = decoder.decompress(block, item['bytes'] - count + 1) if decoder else block
        count += len(decoded)
        if count > item['bytes'] or (decoder and (decoder.unconsumed_tail or decoder.unused_data)):
            raise ValueError('served response exceeds manifest bytes or has trailing compressed data')
        digest.update(decoded)
    if decoder and not decoder.eof:
        raise ValueError('truncated HTTP gzip response')
    if count != item['bytes'] or digest.hexdigest() != item['sha256']:
        raise ValueError('served payload digest or byte count differs')
    return {'status': 200, 'bytes': count, 'sha256': digest.hexdigest(), 'wireBytes': wire,
            'contentType': response.headers.get('Content-Type'), 'contentEncoding': encoding or None,
            'cacheControl': response.headers.get('Cache-Control')}


def verify(descriptor_path, world, out, workers=4):
    descriptor, descriptor_sha = pages.load_descriptor(descriptor_path)
    if descriptor.get('deliveryProvider') != raw.PROVIDER:
        raise ValueError('served verifier requires the explicit GitHub raw profile')
    commit = raw.validate_base(descriptor['worldBaseUrl'], descriptor['worldOrigin'])
    if type(workers) is not int or not 1 <= workers <= 4:
        raise ValueError('verification concurrency must be between one and four')
    raw.fresh_output(out, world, descriptor_path)
    inventory, local = external.inventory_world(world, descriptor['manifestSha256'], descriptor['worldBudgetBytes'])
    if local['worldBytes'] != descriptor['worldBytes'] or local['worldRelease'] != descriptor['worldRelease']:
        raise ValueError('descriptor world differs from local validated inventory')
    if any(item['bytes'] > raw.MAX_FILE_BYTES for item in inventory.values()):
        raise ValueError('world contains an oversized GitHub file')
    base = descriptor['worldBaseUrl'] + descriptor['worldRelease'] + '/'

    def check(entry):
        name, item = entry
        url = base + pages.safe_relative_path(name)
        with request(url, 'HEAD') as response:
            head = verify_response(response, url, name, item, False)
        with request(url, 'GET') as response:
            get = verify_response(response, url, name, item)
        return {'path': name, 'head': head, 'get': get}

    with ThreadPoolExecutor(max_workers=workers) as executor:
        objects = list(executor.map(check, sorted(inventory.items())))
    missing = base + 'missing-object-probe-' + descriptor['manifestSha256'] + '.json'
    try:
        with request(missing, 'GET') as response:
            raise ValueError('missing object did not return 404')
    except urllib.error.HTTPError as error:
        if error.code != 404 or error.geturl() != missing:
            raise ValueError('missing object response is not a direct 404') from error
        error.close()
    if pages.load_descriptor(descriptor_path)[1] != descriptor_sha:
        raise ValueError('descriptor changed during served verification')
    result = {'schemaVersion': 1, 'status': 'PASS_ALL_SERVED_OBJECTS_RUNTIME_ACCEPTANCE_SEPARATE',
              'deliveryProvider': raw.PROVIDER, 'descriptorSha256': descriptor_sha,
              'assetCommit': commit, 'worldBaseUrl': descriptor['worldBaseUrl'],
              'worldRelease': descriptor['worldRelease'], 'manifestSha256': descriptor['manifestSha256'],
              'worldBytes': descriptor['worldBytes'], 'worldFiles': len(inventory),
              'requestOrigin': pages.GAME_ORIGIN, 'requestCredentials': 'omit', 'missingObjectStatus': 404,
              'objectResultsSha256': hashlib.sha256(json.dumps(objects, sort_keys=True).encode()).hexdigest(),
              'objects': objects, 'limitations': ['HTTP verification sends the Pages Origin header; real browser origin and traversal gates remain separate.',
                                                 'No availability or bandwidth guarantee.']}
    out.mkdir(parents=True)
    (out / 'served-verification.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    return result


def record_shell_verification(shell, descriptor_path, result):
    if not shell.is_dir() or shell.is_symlink() or shell.is_junction():
        raise ValueError('shell must be an existing regular directory')
    descriptor, digest = pages.load_descriptor(descriptor_path)
    if result['descriptorSha256'] != digest or result['status'] != 'PASS_ALL_SERVED_OBJECTS_RUNTIME_ACCEPTANCE_SEPARATE':
        raise ValueError('served proof does not match the shell descriptor')
    receipt_file = shell / 'release-info.json'
    if receipt_file.is_symlink() or receipt_file.stat().st_size > 64_000:
        raise ValueError('invalid shell receipt')
    receipt = pages._json(receipt_file.read_bytes())
    for key in ['descriptorSha256', 'manifestSha256', 'worldRelease', 'worldBaseUrl', 'assetCommit']:
        if receipt.get(key) != result.get(key):
            raise ValueError('shell and served-object identity differ')
    expected = set(receipt['shellFiles']) | {'release-info.json', '.nojekyll'}
    actual = {p.relative_to(shell).as_posix() for p in shell.rglob('*') if p.is_file()}
    if actual != expected or any(p.is_symlink() or p.is_junction() for p in shell.rglob('*')):
        raise ValueError('shell files changed after local staging')
    payloads = receipt.get('shellPayloads', [])
    if len(payloads) != len(receipt['shellFiles']) or {ref['path'] for ref in payloads} != set(receipt['shellFiles']):
        raise ValueError('shell receipt lacks exact staged payload pins')
    for ref in payloads:
        target = shell / pages.safe_relative_path(ref['path'])
        if target.stat().st_size != ref['bytes'] or pages._hash_file(target) != ref['sha256']:
            raise ValueError('shell payload bytes changed after staging')
    receipt.update(hostingStatus='ALL_SERVED_OBJECTS_VERIFIED_RUNTIME_ACCEPTANCE_SEPARATE',
                   servedObjectsSha256=result['objectResultsSha256'])
    data = (json.dumps(receipt, indent=2, sort_keys=True) + '\n').encode()
    total = sum((shell / name).stat().st_size for name in expected if name != 'release-info.json') + len(data)
    if total > descriptor['shellBudgetBytes']:
        raise ValueError('served receipt exceeds the explicit shell budget')
    receipt_file.write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['descriptor', 'world', 'out']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--shell', type=Path)
    args = parser.parse_args()
    if args.shell:
        raw.fresh_output(args.out, args.world, args.descriptor, args.shell)
    result = verify(args.descriptor, args.world, args.out, args.workers)
    if args.shell:
        record_shell_verification(args.shell, args.descriptor, result)
    print(json.dumps({key: value for key, value in result.items() if key != 'objects'}))


if __name__ == '__main__':
    main()
