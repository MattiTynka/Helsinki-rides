#!/usr/bin/env python3
"""Launch tm3d.py in headless Blender with the release pinned, the Python exit code wired and a log kept.

    python run_blender.py [--blender PATH] [--require 5.2] [--threads 4] [--timeout 1800] [--log-dir DIR] -- <tm3d command> [args]

Discovery order: --blender, BLENDER_PATH environment variable, BLENDER_PATH in ./.env (value only, never printed
with the rest of the file), the standard install folder for the pinned release, then PATH.
Exit codes: Blender's own (1 = Python error in the script), 2 = launcher problem, 124 = timeout.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTRY = HERE / 'tm3d.py'


def env_file_value(key):
    env = Path.cwd() / '.env'
    if not env.is_file():
        return None
    for line in env.read_text(encoding='utf-8', errors='replace').splitlines():
        line = line.strip()
        if line.startswith(key + '='):
            return line.split('=', 1)[1].strip().strip('"').strip("'") or None
    return None


def candidates(explicit, release):
    if explicit:
        yield explicit
    for value in (os.environ.get('BLENDER_PATH'), env_file_value('BLENDER_PATH')):
        if value:
            yield value
    yield rf'C:\Program Files\Blender Foundation\Blender {release}\blender.exe'
    yield f'/Applications/Blender.app/Contents/MacOS/Blender'
    found = shutil.which('blender')
    if found:
        yield found


def blender_version(exe):
    out = subprocess.run([exe, '--version'], capture_output=True, text=True, timeout=120)
    first = next((l for l in out.stdout.splitlines() if l.startswith('Blender ')), '')
    return first.split()[1] if first else None


def find_blender(explicit, release):
    tried = []
    for exe in candidates(explicit, release):
        if not Path(exe).is_file():
            tried.append(f'{exe} (missing)')
            continue
        ver = blender_version(exe)
        if ver and (ver == release or ver.startswith(release + '.')):
            return exe, ver
        tried.append(f'{exe} (version {ver})')
        if explicit and exe == explicit:
            break
    raise SystemExit('No Blender matching release ' + release + ' found. Tried: ' + '; '.join(tried))


def main():
    argv = sys.argv[1:]
    if '--' not in argv:
        print(__doc__)
        return 2
    cut = argv.index('--')
    p = argparse.ArgumentParser()
    p.add_argument('--blender')
    p.add_argument('--require', default='5.2', help='pinned Blender MAJOR.MINOR')
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--timeout', type=int, default=1800)
    p.add_argument('--log-dir', default=None)
    o = p.parse_args(argv[:cut])
    tail_args = argv[cut + 1:]
    if not tail_args:
        print('Give a tm3d command after --')
        return 2
    exe, ver = find_blender(o.blender, o.require)
    cmd = [exe, '--background', '--factory-startup', '--disable-autoexec', '--threads', str(o.threads),
           '--python-exit-code', '1', '--python', str(ENTRY), '--', '--require', o.require, *tail_args]
    log_dir = Path(o.log_dir or Path.cwd() / 'tm3d-logs')
    log_dir.mkdir(parents=True, exist_ok=True)
    log = log_dir / f'{time.strftime("%Y%m%d-%H%M%S")}-{tail_args[0]}.log'
    print(f'[run_blender] Blender {ver}: {exe}\n[run_blender] log: {log}', flush=True)
    env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY'))}
    t0 = time.time()
    with open(log, 'w', encoding='utf-8', errors='replace') as fh:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', env=env)
        try:
            for line in proc.stdout:
                fh.write(line)
                if line.startswith('[tm3d]') or 'Error' in line or 'Traceback' in line or line.startswith('  File') or line.startswith('SystemExit'):
                    print(line, end='', flush=True)
                if time.time() - t0 > o.timeout:
                    proc.kill()
                    print(f'[run_blender] timeout after {o.timeout} s', flush=True)
                    return 124
            code = proc.wait(timeout=max(1, o.timeout - (time.time() - t0)))
        except subprocess.TimeoutExpired:
            proc.kill()
            print(f'[run_blender] timeout after {o.timeout} s', flush=True)
            return 124
    if code != 0:
        lines = log.read_text(encoding='utf-8', errors='replace').splitlines()
        print('[run_blender] last log lines:\n' + '\n'.join(lines[-15:]), flush=True)
    print(f'[run_blender] exit {code} after {time.time() - t0:.1f} s', flush=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
