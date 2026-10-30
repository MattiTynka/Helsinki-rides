"""Explicit public-data transport contract; not a general GitHub URL fetcher."""
from pathlib import Path
import os
import re

PROVIDER = 'github-raw'
ORIGIN = 'https://raw.githubusercontent.com'
BASE = re.compile(r'https://raw\.githubusercontent\.com/MattiTynka/Helsinki-rides/([0-9a-f]{40})/world/\Z')
MAX_FILE_BYTES = 100 * 1024 * 1024
# Conservative decimal limit, also below 2 GiB. This applies to measured Git pack bytes.
MAX_PUSH_BYTES = 2_000_000_000
MAX_REPOSITORY_BYTES = 5_000_000_000


def validate_base(value, origin):
    match = BASE.fullmatch(value) if isinstance(value, str) else None
    if match is None or origin != ORIGIN:
        raise ValueError('GitHub raw requires the approved repository, full lowercase commit and /world/ prefix')
    return match.group(1)


def fresh_output(out: Path, *inputs: Path):
    """Resolve existing ancestors/junctions and Windows case before any mkdir."""
    if out.exists() or out.is_symlink() or out.is_junction():
        raise ValueError('output must be a fresh directory')
    target = os.path.normcase(str(out.resolve()))
    for source in inputs:
        resolved = os.path.normcase(str(source.resolve(strict=True)))
        try:
            common = os.path.commonpath([target, resolved])
        except ValueError:  # Different Windows drives cannot overlap.
            continue
        if common in (target, resolved):
            raise ValueError('output and protected input trees must not overlap')


def content_types(name):
    if name.endswith('.gz'):
        return ['application/octet-stream', 'application/gzip']
    return {'.json': ['text/plain', 'application/json'], '.md': ['text/plain', 'text/markdown'],
            '.txt': ['text/plain'], '.png': ['image/png'],
            '.glb': ['application/octet-stream', 'model/gltf-binary'],
            '.ktx2': ['application/octet-stream', 'image/ktx2']}.get(Path(name).suffix, ['application/octet-stream'])


def inventory_contract(common, descriptor):
    commit = validate_base(descriptor['worldBaseUrl'], descriptor['worldOrigin'])
    objects = [{**item, 'acceptedContentTypes': content_types(item['path']),
                'httpContentEncoding': 'identity-only' if item['path'].endswith('.gz') else 'identity-or-gzip',
                'url': descriptor['worldBaseUrl'] + item['key']} for item in common['objects']]
    if any(item['bytes'] > MAX_FILE_BYTES for item in objects):
        raise ValueError('GitHub raw payload exceeds 100 MiB normal Git file limit')
    for item in objects:
        item.pop('contentType', None)
    return {**common, 'provider': PROVIDER, 'assetCommit': commit,
            'worldBaseUrl': descriptor['worldBaseUrl'], 'requestCredentials': 'omit',
            'requestOrigin': descriptor['corsOrigin'],
            'requiredHeaders': {'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff'},
            'cachePolicy': {'observedMaxAgeSeconds': 300, 'immutableHttpHeaderRequired': False,
                            'identity': 'full-git-commit-plus-manifest-and-payload-digests'},
            'forbiddenHeaders': ['Access-Control-Allow-Credentials'],
            'requirements': ['Use only the pinned repository commit prefix; redirects are forbidden.',
                             'Stored .gz objects must have no HTTP Content-Encoding and retain exact compressed bytes.',
                             'Other files may use HTTP gzip only when decoded response bytes match the manifest.',
                             'Public data uses credential-free CORS; scripts and WASM remain on Pages.',
                             'Verify GET/HEAD, every response digest/size, and missing-object 404 before shell publication.',
                             'Retain previous reachable asset commits and source/descriptor pairs for rollback.',
                             'Five-minute HTTP caching is not an availability or bandwidth guarantee.'],
            'objects': objects}


def validate_headers(name, headers):
    headers = {key.lower(): value.strip() for key, value in headers.items()}
    if headers.get('access-control-allow-origin') != '*' or 'access-control-allow-credentials' in headers:
        raise ValueError('GitHub raw requires public credential-free wildcard CORS')
    if headers.get('x-content-type-options', '').lower() != 'nosniff':
        raise ValueError('GitHub raw response lacks nosniff')
    mime = headers.get('content-type', '').split(';', 1)[0].strip().lower()
    if mime not in content_types(name):
        raise ValueError('GitHub raw response has an unexpected content type')
    encoding = headers.get('content-encoding', '').lower()
    if encoding not in ('', 'identity', 'gzip') or (name.endswith('.gz') and encoding):
        raise ValueError('stored gzip must not use HTTP Content-Encoding')
    directives = [part.strip().lower() for part in headers.get('cache-control', '').split(',')]
    ages = [part[8:] for part in directives if part.startswith('max-age=')]
    if len(ages) != 1 or ages[0] != '300' or any(x in directives for x in ('private', 'no-store', 'no-cache')):
        raise ValueError('GitHub raw cache policy differs from the reviewed max-age=300 profile')
    return encoding
