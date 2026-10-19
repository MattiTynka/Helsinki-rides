#!/usr/bin/env python3
"""Snapshot a City of Helsinki polygon layer (building footprints by default) for a projected bounding box.

Uses WFS 1.0.0, whose bbox and output keep easting/northing order for EPSG:3879, and rejects any
response whose coordinates do not look like GK25 eastings/northings (catches swapped axes). The raw
response is stored unchanged with a ledger entry. Plain footprints are a reference only; the register and
street-part layers feed the cell builder's footprint matching and authored ground (tools/world/build_cells.ts).
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))  # tools run with python -I
from worldlib import http_open, read_json, utc_now, write_json

WFS = "https://kartta.hel.fi/ws/geoserver/avoindata/wfs"
MAX_FEATURES = 5000
UNVERIFIED = "CC BY 4.0 (City of Helsinki open geographic data terms; layer-level licence text not separately verified)"
LAYERS = {
    "buildings": {
        "layer": "avoindata:Rakennukset_alue", "id": "helsinki-buildings-wfs",
        "title": "City of Helsinki building footprints (Rakennukset_alue)",
        "attribution": "Building footprints © City of Helsinki, CC BY 4.0"},
    "building-register": {
        "layer": "avoindata:Rakennukset_alue_rekisteritiedot", "id": "helsinki-building-register-wfs",
        "title": "City of Helsinki building footprints with register attributes (Rakennukset_alue_rekisteritiedot)",
        "attribution": "Building register © City of Helsinki, CC BY 4.0"},
    "street-parts": {
        "layer": "avoindata:YLRE_Katu_ja_viherosat_kaikki_alue", "id": "helsinki-street-parts-wfs",
        "title": "City of Helsinki public area register, street and green parts (YLRE_Katu_ja_viherosat_kaikki_alue)",
        "attribution": "Street areas © City of Helsinki, CC BY 4.0"},
}


def check_gk25(features):
    for feature in features:
        geometry = feature["geometry"]
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        for polygon in polygons:
            for ring in polygon:
                for e, n, *_ in ring:
                    if not (25_400_000 < e < 25_600_000 and 6_600_000 < n < 6_800_000):
                        raise ValueError(f"Coordinate {e}, {n} is not GK25 easting/northing; check axis order")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bbox", required=True, nargs=4, type=float, metavar=("EMIN", "NMIN", "EMAX", "NMAX"))
    parser.add_argument("--name", required=True, help="snapshot name, e.g. senate-square")
    parser.add_argument("--out", required=True, type=Path, help="raw directory (outside Git), one per layer")
    parser.add_argument("--layer", choices=sorted(LAYERS), default="buildings")
    args = parser.parse_args()
    layer = LAYERS[args.layer]

    emin, nmin, emax, nmax = args.bbox
    if not (emin < emax and nmin < nmax):
        raise SystemExit("bbox must be EMIN NMIN EMAX NMAX")
    query = {"service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": layer["layer"],
             "srsName": "EPSG:3879", "bbox": f"{emin:.0f},{nmin:.0f},{emax:.0f},{nmax:.0f}",
             "maxFeatures": MAX_FEATURES, "outputFormat": "application/json"}
    url = f"{WFS}?{urlencode(query)}"
    with http_open(url, timeout=120) as response:
        body = response.read()
    data = json.loads(body)
    crs = data.get("crs", {}).get("properties", {}).get("name", "")
    if not crs.endswith("EPSG::3879"):
        raise SystemExit(f"Unexpected response CRS {crs!r}")
    features = data["features"]
    if len(features) >= MAX_FEATURES:
        raise SystemExit("Response hit maxFeatures; split the bounding box")
    check_gk25(features)

    target = args.out / f"{args.name}.geojson"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    ledger_path = args.out / "ledger.json"
    ledger = read_json(ledger_path) if ledger_path.exists() else {"schemaVersion": 1, "snapshots": {}}
    if ledger.get("source", {}).get("layer", layer["layer"]) != layer["layer"]:
        raise SystemExit(f"{ledger_path} records another layer; use a separate --out directory per layer")
    ledger["source"] = {
        "id": layer["id"], "title": layer["title"], "url": WFS, "layer": layer["layer"], "license": UNVERIFIED,
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/", "attribution": layer["attribution"],
    }
    ledger["snapshots"][args.name] = {"path": target.name, "url": url, "retrievedAt": utc_now(),
                                      "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                                      "features": len(features), "crs": crs, "bbox": args.bbox}
    write_json(ledger_path, ledger)
    print(f"{len(features)} {args.layer} features -> {target}")


if __name__ == "__main__":
    main()
