#!/usr/bin/env python3
"""Offline regression tests: no Blender, network or external assets required."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import sys

sys.dont_write_bytecode = True
from localize_obj import localize
from validate_world import validate
spec = importlib.util.spec_from_file_location('census_spec', Path(__file__).parent/'blender/census_spec.py')
census = importlib.util.module_from_spec(spec)
spec.loader.exec_module(census)


class LocalizerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'source.obj'
        self.output = self.root/'local.obj'
        self.report = self.root/'report.json'
        self.origin = (25496000.0, 6673000.0, 12.0)

    def run_case(self, text, **kw):
        self.source.write_text(text)
        return localize(self.source, self.output, self.report, 'EPSG:3879', self.origin, **kw)

    def test_precision_before_float32_and_axis_contract(self):
        report = self.run_case('v 25496000.01 6673001 13\nv 25496000.02 6673002 14\nv 25496000 6673000 12\nf 1 2 3\n')
        rows = self.output.read_text().splitlines()
        xyz = list(map(float, rows[0].split()[1:]))
        self.assertAlmostEqual(xyz[0], 0.01, places=7)
        self.assertEqual(xyz[1:], [1,1])
        f32 = lambda n: struct.unpack('f', struct.pack('f', n))[0]
        self.assertEqual(f32(25496000.01)-f32(25496000.0), 0)
        self.assertAlmostEqual(f32(xyz[0]), 0.01, places=7)
        self.assertEqual([xyz[0], xyz[2], -xyz[1]], [xyz[0],1,-1])
        self.assertEqual(report['vertices'], 3)
        self.assertEqual(report['sourceSha256'], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(report['outputSha256'], hashlib.sha256(self.output.read_bytes()).hexdigest())
        self.assertEqual(json.loads(self.report.read_text())['outputAxes'], 'X-east,Y-north,Z-up')

    def test_preserves_nonposition_data_and_vertex_colors(self):
        report = self.run_case('mtllib city.mtl\nvt 0.1 0.2\nvn 0 0 1\nv 25495999 6672999 11 0.1 0.2 0.3 # RGB\nusemtl wall\nf 1/1/1 1/1/1 1/1/1\n')
        text = self.output.read_text()
        self.assertIn('v -1 -1 -1 0.1 0.2 0.3 # RGB', text)
        self.assertIn('vn 0 0 1', text)
        self.assertIn('f 1/1/1 1/1/1 1/1/1', text)
        self.assertEqual(report['materialLibraries'], ['city.mtl'])

    def test_bad_input_leaves_no_output(self):
        for text in ['v nan 1 2\n', 'v 24 60 0\n', 'v 25496000 6673000 12 2\n', '# empty\n', 'v 1 2\n']:
            with self.subTest(text=text):
                with self.assertRaises(ValueError): self.run_case(text)
                self.assertFalse(self.output.exists())
                self.assertFalse(self.report.exists())

    def test_refuses_overwrite_and_equal_paths(self):
        self.output.write_text('existing')
        with self.assertRaises(ValueError): self.run_case('v 25496000 6673000 12\n')
        self.assertEqual(self.output.read_text(), 'existing')
        with self.assertRaises(ValueError): localize(self.source, self.source, self.report, 'EPSG:3879', self.origin)

    def test_invalid_origin_radius_or_crs(self):
        self.source.write_text('v 25496000 6673000 12\n')
        for crs, origin, radius in [('EPSG:4326',self.origin,100),('EPSG:3879',(0,float('inf'),0),100),('EPSG:3879',self.origin,-1)]:
            with self.subTest(crs=crs, origin=origin, radius=radius):
                with self.assertRaises(ValueError): localize(self.source,self.output,self.report,crs,origin,radius)


class WorldTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        def payload(name):
            content = ('controlled fixture '+name).encode()
            (self.root/name).write_bytes(content)
            return {'path':name,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()}
        self.data = {'schemaVersion':1,'buildId':'fixture-1','coordinates':{'crs':'EPSG:3879','heightDatum':'N2000','units':'meter','runtimeAxes':'X-east,Y-up,Z-south','originProjected':[25496000,6673000,0]},'tileSizeMeters':128,'sources':[{'id':'synthetic','url':'urn:test:fixture','license':'test-only','attribution':'Synthetic test fixture','retrievedAt':'2026-10-15','sha256':'a'*64}], 'tiles':[{'id':'-1_0','boundsXZ':[-128,0,0,128],'sourceIds':['synthetic'],'visual':[dict(payload('visual.glb'),lod=0,maxDistanceMeters=200)],'collision':payload('collision.bin'),'nav':payload('nav.bin'),'roads':payload('roads.json')}]}

    def test_accepts_hashes_and_negative_tile_coordinates(self):
        result = validate(self.data,self.root)
        self.assertEqual(result['status'],'STRUCTURE_AND_HASHES_PASS')
        self.assertEqual(result['uniqueAssets'],4)

    def test_modified_asset_is_rejected(self):
        file = self.root/'nav.bin'
        content = file.read_bytes()
        file.write_bytes(b'x'+content[1:])
        with self.assertRaisesRegex(ValueError,'SHA-256'): validate(self.data,self.root)

    def test_missing_asset(self):
        (self.root/'collision.bin').unlink()
        with self.assertRaisesRegex(ValueError,'Missing'): validate(self.data,self.root)

    def test_bad_structure(self):
        mutations = [
            lambda d: d['coordinates'].update(crs='EPSG:4326'),
            lambda d: d['coordinates'].update(originProjected=[0,float('nan'),0]),
            lambda d: d.update(buildId='REPLACE_ME'),
            lambda d: d['tiles'][0].pop('collision'),
            lambda d: d['tiles'][0].update(boundsXZ=[-128,0,1,128]),
            lambda d: d['tiles'][0].update(boundsXZ=[-127,0,1,128]),
            lambda d: d['tiles'][0].update(sourceIds=['unknown']),
            lambda d: d['tiles'][0]['visual'][0].update(lod=2),
            lambda d: d['tiles'][0]['nav'].update(bytes=999),
            lambda d: d['tiles'][0].update(collision=copy.deepcopy(d['tiles'][0]['visual'][0])),
            lambda d: d['tiles'].append(dict(copy.deepcopy(d['tiles'][0]),id='different-id')),
            lambda d: d['sources'][0].update(retrievedAt='yesterday')]
        for i, mutate in enumerate(mutations):
            with self.subTest(case=i):
                data=copy.deepcopy(self.data); mutate(data)
                with self.assertRaises(ValueError): validate(data,self.root)

    def test_unsafe_paths(self):
        for path in ['../visual.glb','/etc/passwd','x/../../visual.glb','https://example.com/a','a\\b','a%2fb','./visual.glb','visual.glb?x']:
            with self.subTest(path=path):
                data=copy.deepcopy(self.data);data['tiles'][0]['collision']['path']=path
                with self.assertRaises(ValueError): validate(data,self.root)

    def test_symlink_escape(self):
        link = self.root/'link.bin'
        try: link.symlink_to(self.root/'nav.bin')
        except OSError: self.skipTest('Symlink creation unavailable')
        self.data['tiles'][0]['nav']['path']='link.bin'
        with self.assertRaisesRegex(ValueError,'Symlink'): validate(self.data,self.root)

    def test_draft_template_is_not_release_ready(self):
        data=json.loads((Path(__file__).parent.parent/'assets/world-manifest.template.json').read_text())
        with self.assertRaises(ValueError): validate(data,self.root)


class CensusSpecTests(unittest.TestCase):
    def good(self):
        return {'require_version':'5.2','self_overlap':{'enabled':True,'max_faces':1000},
                'limits':{'nonmanifold_interior_edges':0,'flipped_edges':0,'self_overlap_pairs':0},
                'dimensions':[{'object':'COL_body','size':[4.5,1.8,1.4],'tolerance':0.01}],'unit_scale':1.0,'applied_transforms':True}

    def report(self, **overrides):
        obj={'name':'COL_body','counts':{'nonmanifold_interior_edges':0,'flipped_edges':0,'self_overlap_pairs':0},
             'dimensions':[4.505,1.8,1.4],'transforms_applied':True}
        obj.update(overrides)
        return {'blender':{'version':[5,2,1]},'unit_scale':1.0,'objects':[obj]}

    def test_valid_spec_and_passing_report(self):
        checks,failed=census.judge(census.validate_spec(self.good()),self.report())
        self.assertEqual((len(checks),failed),(7,0))

    def test_rejects_unknown_counts_bad_versions_and_no_checks(self):
        cases=[{},{'limits':{'nonmanifld_edges':0}},{'limits':{'flipped_edges':-1}},{'limits':{'flipped_edges':0.5}},
               {'require_version':'5'},{'require_version':5.2},{'limits':{'self_overlap_pairs':0}},
               {'dimensions':[{'object':'a','size':[1,2],'tolerance':0}]},{'dimensions':[{'object':'a','size':[1,2,3]}]},
               {'unit_scale':0},{'objects':'COL_body','limits':{'faces':1}},{'limts':{}},{'applied_transforms':False},
               {'self_overlap':{'enabled':True,'max_faces':0},'limits':{'faces':1}},{'weld_distance':-1,'limits':{'faces':1}}]
        for data in cases:
            with self.subTest(data=data):
                with self.assertRaises(ValueError): census.validate_spec(data)

    def test_fails_closed_on_unmeasured_mismatched_or_missing(self):
        spec=census.validate_spec(self.good())
        skipped=self.report(counts={'nonmanifold_interior_edges':0,'flipped_edges':0,'self_overlap_pairs':None})
        self.assertEqual(census.judge(spec,skipped)[1],1)
        wrong_version=self.report();wrong_version['blender']['version']=[4,5,3]
        self.assertEqual(census.judge(spec,wrong_version)[1],1)
        self.assertEqual(census.judge(spec,self.report(dimensions=[4.6,1.8,1.4]))[1],1)
        self.assertEqual(census.judge(spec,self.report(transforms_applied=False))[1],1)
        checks,failed=census.judge(spec,self.report(name='BODY'))
        self.assertEqual(failed,1)
        self.assertIsNone([c for c in checks if c['check']=='dimensions'][0]['value'])
        self.assertEqual(census.judge(spec,{'blender':{},'objects':[]})[1],3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
