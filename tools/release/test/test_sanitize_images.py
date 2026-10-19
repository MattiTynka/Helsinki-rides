"""Synthetic marker/chunk tests; no local city data or camera metadata required."""
import importlib.util
import os
from pathlib import Path
import struct
import tempfile
import unittest
import zlib


SPEC = importlib.util.spec_from_file_location("sanitize_images", Path(__file__).parents[1] / "sanitize-images.py")
IMAGES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMAGES)


def segment(code, payload=b""):
    return b"\xff" + bytes([code]) + struct.pack(">H", len(payload) + 2) + payload


def jpeg(*metadata):
    return b"\xff\xd8" + b"".join(metadata) + segment(0xDB, b"quantization") + segment(0xDA, b"scan") + b"raster\xff\x00stuffed\xff\xd0restart" + b"\xff\xd9"


def chunk(kind, payload=b""):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def png(*metadata):
    return IMAGES.PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + b"".join(metadata) + chunk(b"IDAT", zlib.compress(b"\x00\x01\x02\x03")) + chunk(b"IEND")


class SanitizeImagesTest(unittest.TestCase):
    def test_jpeg_preserves_raster_icc_jfif_adobe(self):
        retained = [segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"), segment(0xE2, b"ICC_PROFILE\x00\x01\x01color"), segment(0xEE, b"Adobe\x00\x64\x00\x00\x00\x00\x01")]
        removed = [segment(0xE1, b"Exif\x00private"), segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00private"), segment(0xED, b"Photoshop 3.0\x00private"), segment(0xFE, b"comment"), segment(0xEB, b"unknown-metadata"), segment(0xE2, b"unrecognized-personal-data")]
        cleaned, counts, raster = IMAGES.sanitize_jpeg(jpeg(*retained, *removed) + b"private-trailer")
        self.assertEqual(cleaned, jpeg(*retained))
        self.assertEqual(counts["APP1"], 2)
        self.assertEqual(counts["COM"], 1)
        self.assertIn("APP13", counts)
        self.assertEqual(IMAGES.sanitize_jpeg(cleaned), (cleaned, {}, raster))

    def test_jpeg_progressive_scans_and_between_scan_comment(self):
        original = jpeg(segment(0xE1, b"Exif\x00private"))[:-2] + segment(0xFE, b"private") + segment(0xDA, b"second-scan") + b"second-raster\xff\x00bytes\xff\xd9"
        clean, _, _ = IMAGES.sanitize_jpeg(original)
        self.assertIn(b"second-raster\xff\x00bytes", clean)
        self.assertNotIn(b"private", clean)
        self.assertEqual(len([row for row in IMAGES.jpeg_tokens(clean)[0] if row[0] is None]), 2)

    def test_png_removes_metadata_preserves_color_and_pixel_chunks(self):
        retained = [chunk(b"iCCP", b"profile\x00\x00" + zlib.compress(b"color-profile")), chunk(b"gAMA", struct.pack(">I", 45455)), chunk(b"sRGB", b"\x00")]
        removed = [chunk(b"tEXt", b"Author\x00private"), chunk(b"zTXt", b"Comment\x00\x00" + zlib.compress(b"private")), chunk(b"iTXt", b"XML\x00private"), chunk(b"eXIf", b"private"), chunk(b"tIME", b"private"), chunk(b"vpAg", b"unknown-metadata")]
        clean, counts, raster = IMAGES.sanitize_png(png(*retained, *removed) + b"private-trailer")
        self.assertEqual(clean, png(*retained))
        self.assertEqual(counts["eXIf"], 1)
        self.assertEqual(IMAGES.sanitize_png(clean), (clean, {}, raster))

    def test_rejects_corrupt_or_truncated_images(self):
        for data in [b"not-jpeg", jpeg()[:-1], b"\xff\xd8" + segment(0xE1, b"metadata")]:
            with self.assertRaises(ValueError):
                IMAGES.sanitize_jpeg(data)
        bad = bytearray(png()); bad[-1] ^= 1
        for data in [bytes(bad), png()[:-1], png(chunk(b"ABCD", b"unknown-critical"))]:
            with self.assertRaises(ValueError):
                IMAGES.sanitize_png(data)

    def test_export_only_known_paths_and_breaks_hardlink(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            original = root / "development-original.jpg"
            original.write_bytes(jpeg(segment(0xE1, b"Exif\x00private")))
            target = root / IMAGES.IMAGE_PATHS[0]
            target.parent.mkdir(parents=True)
            os.link(original, target)
            ignored = root / "content/unrecognized.jpg"
            ignored.write_bytes(original.read_bytes())
            receipt = IMAGES.sanitize_export(root)
            self.assertEqual(receipt["imagesChanged"], 1)
            self.assertIn(b"private", original.read_bytes())
            self.assertEqual(ignored.read_bytes(), original.read_bytes())
            self.assertNotIn(b"private", target.read_bytes())
            self.assertEqual(IMAGES.sanitize_export(root)["imagesChanged"], 0)

    def test_rejects_original_workspace(self):
        with self.assertRaises(ValueError):
            IMAGES.sanitize_export(Path(IMAGES.__file__).resolve().parents[2])

    def test_rejects_link_to_outside_tree(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            root = base / "export"; root.mkdir()
            outside = base / "outside.jpg"; outside.write_bytes(jpeg())
            target = root / IMAGES.IMAGE_PATHS[0]; target.parent.mkdir(parents=True)
            try:
                target.symlink_to(outside)
            except OSError:
                self.skipTest("Host does not permit symlink creation")
            with self.assertRaises(ValueError):
                IMAGES.sanitize_export(root)


if __name__ == "__main__":
    unittest.main()
