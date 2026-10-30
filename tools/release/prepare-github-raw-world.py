#!/usr/bin/env python3
"""Prepare an isolated LOCAL asset commit and measured push pack. Never contacts GitHub."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import importlib.util


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


external = sibling('raw_external_preparer', 'prepare-external-world.py')
pages = external.pages
raw = pages.github_raw
source_release = sibling('raw_source_publication', 'source_release.py')
ATTRIBUTES = b'* -text\n'


def git_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM='1')
    return env


def git(repo, *args, data=None):
    return subprocess.run(['git', '-c', f'safe.directory={repo.resolve().as_posix()}', '-C', str(repo),
                           *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=git_env(), check=True).stdout


def validate_previous(repo, commit):
    if not re.fullmatch(r'[0-9a-f]{40}', commit or '') or not repo.is_dir():
        raise ValueError('previous assets require an existing local bare repository and pinned full commit')
    if git(repo, 'rev-parse', '--is-bare-repository').strip() != b'true':
        raise ValueError('previous assets must be the accepted isolated bare asset repository')
    if git(repo, 'rev-parse', '--show-object-format').strip() != b'sha1':
        raise ValueError('asset repository must use Git SHA-1 commit identities')
    if git(repo, 'rev-parse', commit + '^{commit}').decode().strip() != commit:
        raise ValueError('previous asset commit differs')
    if git(repo, 'for-each-ref', '--format=%(refname) %(objectname)').decode().splitlines() != [f'refs/heads/world-assets {commit}']:
        raise ValueError('previous asset repository has unreviewed refs')
    # A source checkout, unrelated branch or executable must not become asset history.
    commits = git(repo, 'rev-list', commit).decode().splitlines()
    if len(commits) > 1000:
        raise ValueError('asset history exceeds the bounded review limit')
    for current in commits:
        metadata = git(repo, 'show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', current).decode('utf-8').splitlines()
        if len(metadata) < 4 or (metadata[0], metadata[1]) not in source_release.PUBLIC_IDENTITIES or (metadata[2], metadata[3]) not in source_release.PUBLIC_IDENTITIES:
            raise ValueError('asset history has unreviewed author metadata')
        if source_release.scan_text('asset-commit', '\n'.join(metadata[4:])):
            raise ValueError('asset history has private commit metadata')
        count = 0
        for entry in git(repo, 'ls-tree', '-r', '-z', current).split(b'\0'):
            if not entry:
                continue
            info, encoded_path = entry.split(b'\t', 1)
            mode, kind, oid = info.decode().split()
            name = encoded_path.decode('utf-8')
            if mode != '100644' or kind != 'blob':
                raise ValueError('asset history contains nonregular objects')
            if name == '.gitattributes':
                if git(repo, 'cat-file', 'blob', oid) != ATTRIBUTES:
                    raise ValueError('asset history changes byte-preserving attributes')
            else:
                segments = name.split('/', 2)
                if len(segments) != 3 or segments[0] != 'world' or not pages.RELEASE.fullmatch(segments[1]):
                    raise ValueError('asset history contains a non-world path')
                relative = pages.safe_relative_path(segments[2])
                if not (pages._runtime_path(relative) or pages._publication_path(relative)):
                    raise ValueError('asset history contains an unapproved world file')
            count += 1
        if count > pages.MAX_FILES + 1:
            raise ValueError('asset history tree exceeds the file limit')
    return len(commits)


def check_stored_blobs(repo, entries):
    process = subprocess.Popen(['git', '-C', str(repo), 'cat-file', '--batch'], env=git_env(),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for oid, item in entries:
            process.stdin.write((oid + '\n').encode())
            process.stdin.flush()
            header = process.stdout.readline().decode().split()
            if header != [oid, 'blob', str(item['bytes'])]:
                raise ValueError('stored Git blob identity or length differs')
            remaining, digest = item['bytes'], hashlib.sha256()
            while remaining:
                block = process.stdout.read(min(1_048_576, remaining))
                if not block:
                    raise ValueError('truncated Git blob')
                digest.update(block)
                remaining -= len(block)
            if process.stdout.read(1) != b'\n' or digest.hexdigest() != item['sha256']:
                raise ValueError('Git changed payload bytes')
        process.stdin.close()
        if process.wait() != 0:
            raise ValueError('Git blob verification failed')
    finally:
        if not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()


def measure_repository(repo, repository_budget):
    ids = sorted({line.split(' ', 1)[0] for line in git(repo, 'rev-list', '--objects', '--all').decode().splitlines()})
    rows = git(repo, 'cat-file', '--batch-check', data=('\n'.join(ids) + '\n').encode()).decode().splitlines()
    objects, total = [], 0
    for line in rows:
        oid, kind, size = line.split()
        size = int(size)
        if size > raw.MAX_FILE_BYTES:
            raise ValueError('reachable Git object exceeds 100 MiB')
        total += size
        if total > repository_budget:
            raise ValueError('all-ref reachable object bytes exceed the explicit repository budget')
        objects.append({'oid': oid, 'kind': kind, 'bytes': size})
    return {'refs': git(repo, 'for-each-ref', '--format=%(refname) %(objectname)').decode().splitlines(),
            'reachableObjects': len(objects), 'reachableObjectBytes': total,
            'largestObjectBytes': max(x['bytes'] for x in objects),
            'objects': objects, 'objectInventorySha256': hashlib.sha256(json.dumps(objects, sort_keys=True).encode()).hexdigest()}


def measure_push(repo, commit, previous_commit, pack):
    revisions = commit + '\n' + (f'^{previous_commit}\n' if previous_commit else '')
    process = subprocess.Popen(['git', '-C', str(repo), 'pack-objects', '--stdout', '--revs'],
                               env=git_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    count, digest = 0, hashlib.sha256()
    try:
        process.stdin.write(revisions.encode())
        process.stdin.close()
        with pack.open('xb') as output:
            while chunk := process.stdout.read(1_048_576):
                count += len(chunk)
                if count >= raw.MAX_PUSH_BYTES:
                    raise ValueError('measured Git push pack reaches the conservative 2 GB limit')
                output.write(chunk)
                digest.update(chunk)
        if process.wait() != 0:
            raise ValueError('Git pack preparation failed')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()
    return {'bytes': count, 'sha256': digest.hexdigest(), 'limitBytes': raw.MAX_PUSH_BYTES,
            'assumedAlreadyHostedParent': previous_commit, 'file': pack.name}


def prepare(source, packet, out, expected_manifest, world_budget, repository_budget, archive_tag,
            previous_repo=None, previous_commit=None):
    protected = [source, packet] + ([previous_repo] if previous_repo else [])
    raw.fresh_output(out, *protected)
    pages._integer(repository_budget, raw.MAX_REPOSITORY_BYTES, 'repository budget')
    if bool(previous_repo) != bool(previous_commit):
        raise ValueError('previous repository and commit are required together')
    previous_count = validate_previous(previous_repo, previous_commit) if previous_repo else 0
    if previous_repo:
        measure_repository(previous_repo, repository_budget)
    inventory, descriptor = external.inventory_world(source, expected_manifest, world_budget)
    if any(item['bytes'] > raw.MAX_FILE_BYTES for item in inventory.values()):
        raise ValueError('world payload exceeds 100 MiB')
    archive_url = f'https://github.com/MattiTynka/Helsinki-rides/releases/download/{archive_tag}/pages-world.tar.gz'
    if not pages.ARCHIVE_URL.fullmatch(archive_url):
        raise ValueError('invalid archive release tag')
    receipt_path = packet / 'upload-inventory.json'
    if receipt_path.is_symlink() or receipt_path.stat().st_size > 8_000_000:
        raise ValueError('packet receipt must be a bounded regular file')
    prepared = pages._json(receipt_path.read_bytes())
    listed = {x['path']: {'bytes': x['bytes'], 'sha256': x['sha256']} for x in prepared['objects']}
    if len(listed) != len(prepared['objects']) or listed != inventory or prepared['manifestSha256'] != expected_manifest:
        raise ValueError('prepared packet inventory differs from source world')
    archive = packet / 'pages-world.tar.gz'
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size != prepared['archiveBytes'] or pages._hash_file(archive) != prepared['archiveSha256']:
        raise ValueError('prepared archive bytes changed')
    pages._integer(prepared['archiveBytes'], pages.MAX_EXTERNAL_ARCHIVE_BYTES, 'archive bytes')
    pages._integer(prepared['archiveBudgetBytes'], pages.MAX_EXTERNAL_ARCHIVE_BYTES, 'archive budget')
    # Every input check above precedes any output directory creation.
    out.mkdir(parents=True)
    repo = out / 'assets.git'
    subprocess.run(['git', 'init', '--bare', '--object-format=sha1', str(repo)], env=git_env(), check=True, capture_output=True)
    if previous_repo:
        git(repo, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', str(previous_repo.resolve()), previous_commit)
    paths = sorted(inventory)
    source_paths = [str((source / name).resolve()).replace('\\', '/') for name in paths]
    if any('\n' in name or '\r' in name or name.startswith('"') for name in source_paths):
        raise ValueError('source path cannot be encoded safely for Git')
    oids = git(repo, 'hash-object', '-w', '--no-filters', '--stdin-paths', data=('\n'.join(source_paths) + '\n').encode()).decode().splitlines()
    if len(oids) != len(paths):
        raise ValueError('Git did not write every source blob')
    entries = list(zip(oids, [inventory[name] for name in paths]))
    check_stored_blobs(repo, entries)
    attributes = git(repo, 'hash-object', '-w', '--stdin', data=ATTRIBUTES).decode().strip()
    index = f'100644 {attributes}\t.gitattributes\0'.encode() + b''.join(
        f"100644 {oid}\tworld/{descriptor['worldRelease']}/{name}\0".encode() for name, oid in zip(paths, oids))
    git(repo, 'update-index', '-z', '--index-info', data=index)
    tree = git(repo, 'write-tree').decode().strip()
    now = int(time.time())
    identity = f'{source_release.PUBLIC_DISPLAY_NAME} <> {now} +0000'
    commit_data = (f'tree {tree}\n' + (f'parent {previous_commit}\n' if previous_commit else '') +
                   f'author {identity}\ncommitter {identity}\n\nPublish world {descriptor["worldRelease"]}\n').encode('utf-8')
    commit = git(repo, 'hash-object', '-t', 'commit', '-w', '--stdin', data=commit_data).decode().strip()
    git(repo, 'update-ref', 'refs/heads/world-assets', commit)
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/world-assets')
    measured = measure_repository(repo, repository_budget)
    push = measure_push(repo, commit, previous_commit, out / 'measured-push.pack')
    for name, item in inventory.items():
        if (source / name).stat().st_size != item['bytes'] or pages._hash_file(source / name) != item['sha256']:
            raise ValueError('source world changed during local commit preparation')
    descriptor.update(schemaVersion=3, deliveryProvider=raw.PROVIDER, worldOrigin=raw.ORIGIN,
                      worldBaseUrl=f'{raw.ORIGIN}/MattiTynka/Helsinki-rides/{commit}/world/', corsOrigin=pages.GAME_ORIGIN,
                      archiveUrl=archive_url, archiveSha256=prepared['archiveSha256'], archiveBytes=prepared['archiveBytes'],
                      archiveBudgetBytes=prepared['archiveBudgetBytes'])
    descriptor_path = out / 'descriptor.local-not-published.json'
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + '\n', encoding='utf-8')
    pages.load_descriptor(descriptor_path)
    upload = pages.upload_inventory(inventory, descriptor)
    (out / 'upload-inventory.json').write_text(json.dumps(upload, indent=2) + '\n', encoding='utf-8')
    result = {'status': 'LOCAL_ASSET_COMMIT_NOT_PUBLISHED', 'assetCommit': commit, 'tree': tree,
              'manifestSha256': expected_manifest, 'worldBytes': descriptor['worldBytes'], 'worldFiles': len(inventory),
              'previousAcceptedCommit': previous_commit, 'previousAncestorCount': previous_count,
              'allRefs': measured, 'repositoryBudgetBytes': repository_budget, 'pushPack': push,
              'allPayloadGitBlobBytesVerified': True, 'attributes': '* -text', 'externalWrites': 0,
              'descriptorFile': descriptor_path.name,
              'remainingGates': ['Full central asset and real-controls acceptance.', 'Confirm remote asset ref equals the declared previous commit (or is absent).',
                                 'Authorized asset/archive publication, then all-object served verification and actual Pages-origin runtime gates.']}
    (out / 'preparation-receipt.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'packet', 'out']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--expected-manifest', required=True)
    parser.add_argument('--world-budget-bytes', type=int, required=True)
    parser.add_argument('--repository-budget-bytes', type=int, required=True)
    parser.add_argument('--archive-tag', required=True)
    parser.add_argument('--previous-assets-repo', type=Path)
    parser.add_argument('--previous-asset-commit')
    args = parser.parse_args()
    result = prepare(args.source, args.packet, args.out, args.expected_manifest, args.world_budget_bytes,
                     args.repository_budget_bytes, args.archive_tag, args.previous_assets_repo, args.previous_asset_commit)
    print(json.dumps({key: value for key, value in result.items() if key != 'allRefs'}))


if __name__ == '__main__':
    main()
