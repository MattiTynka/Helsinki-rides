"""Stream one pinned official LAZ into a bounded diagnostic street subset; no geometry authoring."""
import argparse
import csv
import hashlib
import json
import pathlib
import sys
import time
from collections import Counter

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--receipt', required=True)
parser.add_argument('--reader', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--roi', required=True, nargs=4, type=float)
args = parser.parse_args()
source, receipt_file, reader_root, output_root = map(pathlib.Path, [args.source, args.receipt, args.reader, args.out])
assert not output_root.exists()
assert source.is_file() and not source.is_symlink() and source.stat().st_size <= 128 * 1024 * 1024
assert args.roi[0] < args.roi[2] and args.roi[1] < args.roi[3]
assert (args.roi[2] - args.roi[0]) * (args.roi[3] - args.roi[1]) <= 10_000

def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

receipt = json.loads(receipt_file.read_text(encoding='utf-8'))
assert receipt['status'] == 'DIAGNOSTIC_SOURCE_ONLY_NOT_QUALIFIED_FOR_ASSETS'
assert receipt['storedBytes'] == source.stat().st_size and sha(source) == receipt['sha256']
assert receipt['horizontalCRS'] == 'EPSG:3879' and receipt['verticalDatum'] == 'N2000'
sys.path.insert(0, str(reader_root / 'packages'))
import laspy
import numpy as np

assert laspy.__version__ == '2.7.0'
chunk_size, point_cap, byte_cap = 100_000, 600_000, 96 * 1024 * 1024
output_root.mkdir()
output = output_root / 'street-roi.csv'
classes, all_classes, total, selected_count = Counter(), Counter(), 0, 0
started = time.time()
with laspy.open(source, laz_backend=laspy.LazBackend.Lazrs) as reader, output.open('x', newline='') as file:
    header = reader.header
    assert header.point_count <= 30_000_000
    header_record = dict(version=str(header.version), pointFormat=header.point_format.id,
                         pointCount=header.point_count, mins=header.mins.tolist(), maxs=header.maxs.tolist(),
                         scales=header.scales.tolist(), offsets=header.offsets.tolist())
    writer = csv.writer(file)
    writer.writerow(['sourcePointIndex', 'x', 'z', 'heightN2000', 'classification', 'returnNumber',
                     'numberOfReturns', 'pointSourceId', 'gpsTime', 'synthetic', 'keyPoint', 'withheld'])
    for points in reader.chunk_iterator(chunk_size):
        assert len(points) <= chunk_size
        x, z, heights = np.asarray(points.x) - 25497350, 6672960 - np.asarray(points.y), np.asarray(points.z)
        classifications = np.asarray(points.classification)
        unique, counts = np.unique(classifications, return_counts=True)
        all_classes.update({int(a): int(b) for a, b in zip(unique, counts)})
        indices = np.flatnonzero((x >= args.roi[0]) & (x <= args.roi[2]) & (z >= args.roi[1]) & (z <= args.roi[3]))
        selected_count += len(indices)
        assert selected_count <= point_cap
        attributes = {name: np.asarray(points[name]) for name in ['return_number', 'number_of_returns', 'point_source_id', 'gps_time', 'synthetic', 'key_point', 'withheld']}
        for i in indices:
            classification = int(classifications[i]); classes[classification] += 1
            writer.writerow([total + int(i), float(x[i]), float(z[i]), float(heights[i]), classification,
                             int(attributes['return_number'][i]), int(attributes['number_of_returns'][i]),
                             int(attributes['point_source_id'][i]), float(attributes['gps_time'][i]),
                             int(attributes['synthetic'][i]), int(attributes['key_point'][i]), int(attributes['withheld'][i])])
        total += len(points); file.flush()
        assert file.tell() <= byte_cap
    assert total == header.point_count
assert sha(source) == receipt['sha256']
report = dict(schemaVersion=1, status='MEASURED_SOURCE_POINTS_ONLY_NO_SURFACE_AUTHORING',
              sourceSha256=receipt['sha256'], sourceReceiptSha256=sha(receipt_file),
              scriptSha256=sha(pathlib.Path(__file__)), readerInstallReportSha256=sha(reader_root / 'install-report.json'),
              laspyVersion=laspy.__version__, numpyVersion=np.__version__, backend='Lazrs single thread',
              chunkPoints=chunk_size, maximumRoiPoints=point_cap, maximumCsvBytes=byte_cap,
              roiRuntimeXZ=args.roi, originProjected=[25497350, 6672960, 7.5], horizontalCRS='EPSG:3879',
              verticalDatum='N2000', header=header_record, fullTileClassCounts=all_classes,
              roiPoints=selected_count, roiClassCounts=classes, csv=dict(file=output.name, bytes=output.stat().st_size, sha256=sha(output)),
              elapsedSeconds=time.time() - started)
(output_root / 'roi-report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(dict(roiPoints=selected_count, roiClassCounts=classes, csv=report['csv'], elapsedSeconds=report['elapsedSeconds'])))
