#!/usr/bin/env python3
"""Audit full selected source ancestry without fetching unrelated asset refs."""
import argparse
import importlib.util
import json
from pathlib import Path
import re

spec = importlib.util.spec_from_file_location('selected_source_audit', Path(__file__).with_name('source_release.py'))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


def audit(root, expected):
    if not re.fullmatch(r'[0-9a-f]{40}', expected):
        raise ValueError('source commit must be an exact Git identifier')
    if source.git_output(root, 'rev-parse', 'HEAD').decode().strip() != expected:
        raise ValueError('checked out source differs from the selected commit')
    if source.git_output(root, 'rev-parse', '--is-shallow-repository').strip() != b'false':
        raise ValueError('full selected source ancestry is required for the history audit')
    ancestors = set(source.git_output(root, 'rev-list', expected).decode().splitlines())
    refs = source.git_output(root, 'for-each-ref', '--format=%(refname) %(objectname)').decode().splitlines()
    for row in refs:
        name, oid = row.split()
        if name not in ('refs/heads/main', 'refs/remotes/origin/main') or oid not in ancestors:
            raise ValueError('source audit checkout includes an unrelated ref')
    # Verify the existing --all audit has exactly the selected source scope.
    reachable = set(source.git_output(root, 'rev-list', '--all').decode().splitlines())
    if reachable != ancestors:
        raise ValueError('source audit refs do not cover exactly the selected ancestry')
    result = source.audit(root, include_git=True, images=True)
    result.update(sourceCommit=expected, auditedRefs=refs, selectedAncestorCount=len(ancestors),
                  historyScope='full-selected-source-ancestry-only; asset refs and tags not fetched')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=source.ROOT)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.root, args.source_sha)
    if args.report.exists():
        raise ValueError('audit report must be fresh')
    args.report.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in result.items() if key != 'inventory'}))
    raise SystemExit(0 if result['status'] == 'PASS' else 1)


if __name__ == '__main__':
    main()
