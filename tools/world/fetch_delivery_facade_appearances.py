"""Bounded public Helsinki CityGML facade appearance acquisition.

The official viewer's short-lived export credential is read into memory only.
No email, account data, credential, raw server response or server path is saved.
Only exact selected public building IDs are requested; 2017 themes are excluded.
"""
import argparse,hashlib,io,json,pathlib,re,urllib.parse,urllib.request,zipfile,xml.etree.ElementTree as ET

ORIGIN='https://kartta.hel.fi'
ENDPOINT=ORIGIN+'/3d/fmedatadownload/VirtualCitySystems/MultiExporter_Helsinki.fmw'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise ValueError('Unexpected redirect from the pinned municipal source')
OPENER=urllib.request.build_opener(NoRedirect)
def bounded(url,limit,body=None,headers=None):
    parsed=urllib.parse.urlsplit(url)
    assert parsed.scheme=='https'and parsed.netloc=='kartta.hel.fi'and not parsed.fragment and not parsed.username
    assert parsed.path.startswith(('/3d/configs/','/3d/fmedatadownload/'))or parsed.path=='/3d/app.config.json'
    request=urllib.request.Request(url,data=body,headers=headers or{},method='POST'if body is not None else'GET')
    with OPENER.open(request,timeout=55)as response:
        data=response.read(limit+1)
        if len(data)>limit:raise ValueError('Municipal source response exceeded the explicit byte cap')
        return data
def sha(data):return hashlib.sha256(data).hexdigest()
def validate_selection(value):
    assert isinstance(value,dict)and set(value)=={'schemaVersion','theme','buildingIds'}and value['schemaVersion']==1
    assert value['theme']in('rgbTexture_2024','rgbTexture_2021')
    ids=value['buildingIds'];assert isinstance(ids,list)and 1<=len(ids)<=400 and len(set(ids))==len(ids)
    assert all(isinstance(bid,str)and re.fullmatch(r'BID_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',bid)for bid in ids)
    return sorted(ids)
def fetch(selection,out,maximum):
    selection_bytes=pathlib.Path(selection).read_bytes();assert len(selection_bytes)<128000;plan=json.loads(selection_bytes);ids=validate_selection(plan);out=pathlib.Path(out);assert not out.exists(),'A fresh acquisition directory is required';out.mkdir(parents=True)
    app=json.loads(bounded(ORIGIN+'/3d/app.config.json',1000000));modules=app['modules'];assert isinstance(modules,list)and 1<=len(modules)<=8;plugins=[]
    for module in modules:
        assert isinstance(module,str)and re.fullmatch(r'configs/[0-9a-f-]{36}\.json',module)
        cfg=json.loads(bounded(ORIGIN+'/3d/'+module,5000000));plugins.extend(p for p in cfg.get('plugins',[])if p.get('name')=='@vcmap/export')
    assert len(plugins)==1;plugin=plugins[0];assert plugin['fmeServerUrl']==ENDPOINT;assert plan['theme']in plugin['appearanceThemeList'];token=plugin['fmeSecurityToken'];assert isinstance(token,str)and 8<len(token)<1000
    parameters={'COORD_SYS':'EPSG:3879','OPT_SERVICEMODE':'sync','OPT_RESPONSEFORMAT':'json','EXPORT_FORMAT':'CityGML','THEM_CLASS':'26','LOD_SELECTION':'LoD2','TEXTURE':'Yes','LOCAL':'No','TILE_OUTPUT':'No','GENERIC_ATTRIB':'Yes','APP_THEME':plan['theme'],'HEIGHTMODE':'absolute','TERRAIN':'No','nm_NAME':'helsinki-rides-native-facade-source'}
    url=ENDPOINT+'?'+urllib.parse.urlencode(parameters);receipts=[];used=0;namespace={'b':'http://www.opengis.net/citygml/building/2.0','a':'http://www.opengis.net/citygml/appearance/2.0'}
    for batch,start in enumerate(range(0,len(ids),24)):
        selected=ids[start:start+24];body=json.dumps({'selectedFeatures':selected}).encode();raw=bounded(url,1000000,body,{'Accept':'application/json','Content-Type':'application/json','Authorization':'fmetoken token='+token});reply=json.loads(raw)['serviceResponse'];assert reply['statusInfo']['status']=='success';result=reply['fmeTransformationResult']['fmeEngineResponse'];download=result['downloadUrl'];parts=urllib.parse.urlsplit(download);assert parts.scheme=='https'and parts.netloc=='kartta.hel.fi'and parts.path.startswith('/3d/fmedatadownload/results/')and not parts.query and not parts.fragment
        data=bounded(download,min(60000000,maximum-used));used+=len(data);assert used<=maximum;z=zipfile.ZipFile(io.BytesIO(data));assert sum(entry.file_size for entry in z.infolist())<=150000000;gml_names=[n for n in z.namelist()if n.endswith('.gml')];assert len(gml_names)==1;gml=z.read(gml_names[0]);assert len(gml)<=64000000 and b'<!DOCTYPE'not in gml.upper()and b'<!ENTITY'not in gml.upper();doc=ET.fromstring(gml);buildings=doc.findall('.//b:Building',namespace);assert sorted(b.get('{http://www.opengis.net/gml}id')for b in buildings)==selected
        name='batch-'+str(batch).zfill(2)+'.zip';(out/name).write_bytes(data);record={'schemaVersion':1,'endpoint':ENDPOINT,'parameters':parameters,'selected':selected,'requestBodySha256':sha(body),'jobId':reply['jobID'],'archive':{'path':name,'url':download,'bytes':len(data),'sha256':sha(data)},'gml':{'path':gml_names[0],'bytes':len(gml),'sha256':sha(gml)},'buildings':[{'id':b.get('{http://www.opengis.net/gml}id'),'parameterizedTextures':len(b.findall('.//a:ParameterizedTexture',namespace))}for b in buildings]};(out/(name+'.json')).write_text(json.dumps(record,indent=2)+'\n');receipts.append(record);print(json.dumps({'batch':batch,'buildings':len(selected),'archiveBytes':len(data),'totalArchiveBytes':used}),flush=True)
    summary={'schemaVersion':1,'status':'ACQUIRED_SOURCE_ONLY_GEOMETRY_AND_VISUAL_QUALIFICATION_REQUIRED','selectionSha256':sha(selection_bytes),'theme':plan['theme'],'buildings':len(ids),'archiveBytes':used,'maximumArchiveBytes':maximum,'archives':[r['archive']for r in receipts],'license':'CC-BY-4.0','attribution':'Buildings and appearance imagery © City of Helsinki, CC BY4.0','licenseUrl':'https://creativecommons.org/licenses/by/4.0/','informationUrl':'https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d'};(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');return summary
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--selection',required=True);parser.add_argument('--out',required=True);parser.add_argument('--maximum-archive-bytes',type=int,default=200000000);args=parser.parse_args();assert 0<args.maximum_archive_bytes<=200000000;print(json.dumps(fetch(args.selection,args.out,args.maximum_archive_bytes)))
