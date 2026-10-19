"""Shared helpers for the offline world tools: hashing, atomic JSON and verified HTTP range reads.

Standard library only, so the same code runs on the host or in the pinned tool container.
"""
import hashlib
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import urllib.request

USER_AGENT = "helsinki-game-world-tools/0.1 (offline asset build)"


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, data):
    """Write JSON through a temporary file so an interrupted run never leaves a partial record."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temp, path)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def http_open(url, method="GET", headers=None, timeout=120):
    request = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT, **(headers or {})})
    return urllib.request.urlopen(request, timeout=timeout)


class RangeFile(io.RawIOBase):
    """Seekable read-only view of a remote file using HTTP Range requests.

    Every response must be a 206 for exactly the requested span and carry the ETag seen by the initial
    HEAD request, so a file replaced on the server mid-read fails instead of mixing two versions.
    """

    def __init__(self, url):
        super().__init__()
        self.url = url
        self.position = 0
        self.requests = 0
        self.bytes_read = 0
        with http_open(url, method="HEAD", timeout=60) as response:
            if response.headers.get("Accept-Ranges") != "bytes":
                raise IOError(f"Server does not advertise byte ranges for {url}")
            self.size = int(response.headers["Content-Length"])
            self.etag = response.headers.get("ETag")
            self.last_modified = response.headers.get("Last-Modified")
        if not self.etag:
            raise IOError(f"No ETag for {url}; cannot pin the archive version")

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: self.size}[whence]
        self.position = base + offset
        if self.position < 0:
            raise ValueError("Negative seek position")
        return self.position

    def readinto(self, buffer):
        count = min(len(buffer), self.size - self.position)
        if count <= 0:
            return 0
        end = self.position + count - 1
        with http_open(self.url, headers={"Range": f"bytes={self.position}-{end}"}) as response:
            if response.status != 206:
                raise IOError(f"Expected 206 Partial Content, got {response.status}")
            if response.headers.get("ETag") != self.etag:
                raise IOError("Archive ETag changed during the read; restart against the new version")
            expected = f"bytes {self.position}-{end}/{self.size}"
            if response.headers.get("Content-Range") != expected:
                raise IOError(f"Unexpected Content-Range {response.headers.get('Content-Range')!r}")
            data = response.read()
        if len(data) != count:
            raise IOError(f"Short range read: {len(data)} of {count} bytes")
        buffer[:count] = data
        self.position += count
        self.requests += 1
        self.bytes_read += count
        return count
