#!/usr/bin/env python3
"""Remove private image metadata from an explicit source-export tree, losslessly.

Only the six reviewed production JPEG/PNG paths are eligible. No image is
decoded or re-encoded. JPEG scan data and PNG pixel chunks are preserved exactly;
ICC/color descriptors remain intact. Output is a value-free JSON hash receipt.
The caller must update export-only source hash pins using that receipt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import zlib


IMAGE_PATHS = (
    "content/assets/facades/estates/front-2021.jpg",
    "content/assets/facades/estates/park-2022.jpg",
    "content/assets/facades/esplanadi/catani-valtonen.jpg",
    "content/helsinki/district-expansion/facade-charts/canalside-v1/canalside-original.png",
    "content/helsinki/district-expansion/facade-charts/canalside-v2/canalside-original.png",
    "content/helsinki/district-expansion/facade-charts/canalside-v3/canalside-original.png",
)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_KEEP = {
    b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"cHRM", b"gAMA",
    b"iCCP", b"sRGB", b"sBIT", b"bKGD", b"pHYs", b"acTL", b"fcTL", b"fdAT",
}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def jpeg_tokens(data: bytes) -> tuple[list[tuple[int | None, bytes, bytes]], bytes]:
    """Return exact marker/scan bytes; None marks compressed raster scan data."""
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("Invalid JPEG signature")
    tokens: list[tuple[int | None, bytes, bytes]] = [(0xD8, data[:2], b"")]
    pos = 2
    in_scan = False
    seen_scan = False
    while pos < len(data):
        if in_scan:
            start = pos
            while pos < len(data):
                if data[pos] != 0xFF:
                    pos += 1
                    continue
                marker_start = pos
                while pos < len(data) and data[pos] == 0xFF:
                    pos += 1
                if pos == len(data):
                    raise ValueError("Truncated JPEG scan marker")
                code = data[pos]
                if code == 0 or 0xD0 <= code <= 0xD7:
                    pos += 1
                    continue
                pos = marker_start
                break
            if pos >= len(data):
                raise ValueError("JPEG scan has no end marker")
            tokens.append((None, data[start:pos], b""))
            in_scan = False
        start = pos
        if data[pos] != 0xFF:
            raise ValueError("Expected JPEG marker")
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        if pos >= len(data):
            raise ValueError("Truncated JPEG marker")
        code = data[pos]
        pos += 1
        if code == 0xD9:
            if not seen_scan:
                raise ValueError("JPEG has no raster scan")
            tokens.append((code, data[start:pos], b""))
            return tokens, data[pos:]
        if code == 0x01 or 0xD0 <= code <= 0xD7:
            tokens.append((code, data[start:pos], b""))
            continue
        if code in (0, 0xD8) or pos + 2 > len(data):
            raise ValueError("Invalid JPEG marker sequence")
        length = int.from_bytes(data[pos:pos + 2], "big")
        end = pos + length
        if length < 2 or end > len(data):
            raise ValueError("Truncated JPEG segment")
        payload = data[pos + 2:end]
        tokens.append((code, data[start:end], payload))
        pos = end
        if code == 0xDA:
            seen_scan = True
            in_scan = True
        elif code == 0xDC and seen_scan:
            # DNL may appear within an entropy-coded scan.
            in_scan = True
    raise ValueError("JPEG has no end marker")


def jpeg_keep(code: int | None, payload: bytes) -> bool:
    if code == 0xFE:
        return False  # COM: arbitrary text.
    if code is not None and 0xE0 <= code <= 0xEF:
        # Preserve known rendering descriptors only. Other application markers
        # may contain EXIF, XMP, IPTC, thumbnails, contacts or arbitrary metadata.
        jfif = (
            payload.startswith(b"JFIF\x00") and len(payload) >= 14
            and len(payload) == 14 + 3 * payload[12] * payload[13]
        )
        return (
            code == 0xE0 and jfif
            or code == 0xE2 and payload.startswith(b"ICC_PROFILE\x00")
            or code == 0xEE and payload.startswith(b"Adobe") and len(payload) == 12
        )
    return True


def sanitize_jpeg(data: bytes) -> tuple[bytes, dict[str, int], str]:
    tokens, trailer = jpeg_tokens(data)
    removed: dict[str, int] = {}
    kept = []
    raster = b"".join(raw for code, raw, _ in tokens if code is None)
    for code, raw, payload in tokens:
        if jpeg_keep(code, payload):
            kept.append(raw)
        else:
            category = "COM" if code == 0xFE else f"APP{code - 0xE0}"
            removed[category] = removed.get(category, 0) + 1
    if trailer:
        removed["trailing_bytes"] = len(trailer)
    result = b"".join(kept)
    after, after_trailer = jpeg_tokens(result)
    if after_trailer or b"".join(raw for code, raw, _ in after if code is None) != raster:
        raise ValueError("JPEG raster preservation failed")
    return result, removed, sha(raster)


def png_chunks(data: bytes) -> tuple[list[tuple[bytes, bytes]], bytes]:
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("Invalid PNG signature")
    chunks = []
    pos = len(PNG_SIGNATURE)
    while pos + 12 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], "big")
        kind = data[pos + 4:pos + 8]
        end = pos + length + 12
        if end > len(data):
            raise ValueError("Truncated PNG chunk")
        if not all(65 <= c <= 90 or 97 <= c <= 122 for c in kind):
            raise ValueError("Invalid PNG chunk type")
        payload = data[pos + 8:end - 4]
        expected_crc = int.from_bytes(data[end - 4:end], "big")
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected_crc:
            raise ValueError("Invalid PNG chunk checksum")
        if not chunks and kind != b"IHDR":
            raise ValueError("PNG does not start with IHDR")
        chunks.append((kind, data[pos:end]))
        pos = end
        if kind == b"IEND":
            if length or not any(k == b"IDAT" for k, _ in chunks):
                raise ValueError("Invalid PNG image structure")
            return chunks, data[pos:]
    raise ValueError("PNG has no complete IEND")


def sanitize_png(data: bytes) -> tuple[bytes, dict[str, int], str]:
    chunks, trailer = png_chunks(data)
    removed: dict[str, int] = {}
    kept = []
    for kind, raw in chunks:
        if kind in PNG_KEEP:
            kept.append(raw)
        elif kind[0] & 0x20:
            label = kind.decode("ascii")
            removed[label] = removed.get(label, 0) + 1
        else:
            raise ValueError("Unsupported critical PNG chunk")
    if trailer:
        removed["trailing_bytes"] = len(trailer)
    result = PNG_SIGNATURE + b"".join(kept)
    after, after_trailer = png_chunks(result)
    pixel_chunks = lambda rows: b"".join(raw for kind, raw in rows if kind in {b"IHDR", b"PLTE", b"IDAT", b"tRNS", b"acTL", b"fcTL", b"fdAT"})
    if after_trailer or pixel_chunks(after) != pixel_chunks(chunks):
        raise ValueError("PNG pixel chunk preservation failed")
    return result, removed, sha(pixel_chunks(chunks))


def sanitize_export(root: Path) -> dict:
    root = root.resolve(strict=True)
    if not root.is_dir() or root == Path(__file__).resolve().parents[2]:
        raise ValueError("An explicit separate source-export directory is required")
    prepared = []
    for relative in IMAGE_PATHS:
        source = root / relative
        if not source.exists():
            continue
        resolved = source.resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise ValueError("Export image escapes the selected tree")
        # Reject symlink/junction parents as well as an image symlink. Even an
        # in-tree target could accidentally address a second curated input.
        for parent in [source, *source.parents]:
            if parent == root:
                break
            if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
                raise ValueError("Export image traverses a link")
        original = source.read_bytes()
        cleaner = sanitize_jpeg if source.suffix.lower() == ".jpg" else sanitize_png
        sanitized, removed, raster_hash = cleaner(original)
        prepared.append((source, sanitized, {
            "path": relative,
            "beforeSha256": sha(original), "afterSha256": sha(sanitized),
            "beforeBytes": len(original), "afterBytes": len(sanitized),
            "changed": original != sanitized, "removed": removed,
            "rasterPayloadSha256": raster_hash,
        }))
    # All formats and targets are checked before writing. Atomic replacement
    # deliberately breaks a hardlink instead of changing a development original.
    for source, sanitized, receipt in prepared:
        if not receipt["changed"]:
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".image-sanitize-", dir=source.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(sanitized)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, source)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
    rows = [receipt for _, _, receipt in prepared]
    return {
        "schemaVersion": 1, "status": "PASS_LOSSLESS_EXPORT_IMAGE_SANITIZATION",
        "images": rows, "imagesChecked": len(rows),
        "imagesChanged": sum(row["changed"] for row in rows),
        "metadataValuesPrinted": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-root", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = sanitize_export(args.export_root)
    except (OSError, ValueError):
        # Do not expose paths or metadata through exception interpolation.
        parser.exit(1, "Image sanitization failed; invalid export target or image structure.\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
