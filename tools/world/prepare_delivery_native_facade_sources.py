"""Transfer licensed CityGML appearance UVs to unchanged exact-BID native wall faces.

Input is a locally pinned official MultiExporter CityGML ZIP. No web requests,
Google pixels or generated geometry. Native positions and winding never change.
"""
import argparse,hashlib,json,math,pathlib,struct,zipfile,xml.etree.ElementTree as ET
NS={'b':'http://www.opengis.net/citygml/building/2.0','a':'http://www.opengis.net/citygml/appearance/2.0','g':'http://www.opengis.net/gml','gen':'http://www.opengis.net/citygml/generics/2.0'}
GID='{http://www.opengis.net/gml}id'
sha=lambda b:hashlib.sha256(b).hexdigest()
def triangle_key(points):
    v=[struct.pack('<fff',*p).hex()for p in points]
    return min(':'.join(v[(i+k)%3]for k in range(3))for i in range(3))
def normal(points):
    a,b,c=points;u=[b[k]-a[k]for k in range(3)];v=[c[k]-a[k]for k in range(3)];n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];l=math.sqrt(sum(x*x for x in n));return[n/l for n in n]if l else[0,0,0]
def source_faces(building,binary):
    result=[]
    for part,p in enumerate(building['parts']):
        P=struct.unpack_from('<'+'f'*(p['positions']['bytes']//4),binary,p['positions']['offset']);I=struct.unpack_from('<'+'I'*(p['indices']['bytes']//4),binary,p['indices']['offset'])
        for t in range(0,len(I),3):
            points=[(P[I[t+k]*3],P[I[t+k]*3+2],-P[I[t+k]*3+1])for k in range(3)];n=normal(points)
            if p['texture']is None and abs(n[1])<.3 and any(n):result.append({'part':part,'triangle':t//3,'points':points,'normal':n,'key':triangle_key(points)})
    return result
def main():
    p=argparse.ArgumentParser();p.add_argument('--archive',required=True);p.add_argument('--archive-sha256',required=True);p.add_argument('--city-model',required=True);p.add_argument('--city-sha256',required=True);p.add_argument('--out',required=True);p.add_argument('--building',action='append',required=True);p.add_argument('--theme',choices=['rgbTexture_2024','rgbTexture_2021'],default='rgbTexture_2024');a=p.parse_args();out=pathlib.Path(a.out);assert not out.exists(),'Fresh source-transfer output required'
    archive=pathlib.Path(a.archive).read_bytes();assert sha(archive)==a.archive_sha256;z=zipfile.ZipFile(a.archive);assert sum(i.file_size for i in z.infolist())<=150000000;gmlnames=[n for n in z.namelist()if n.endswith('.gml')];assert len(gmlnames)==1;gml=z.read(gmlnames[0]);assert len(gml)<=64000000 and b'<!DOCTYPE'not in gml.upper()and b'<!ENTITY'not in gml.upper();doc=ET.fromstring(gml)
    city_dir=pathlib.Path(a.city_model);city_bytes=(city_dir/'city-model.json').read_bytes();assert sha(city_bytes)==a.city_sha256;city=json.loads(city_bytes);binary=(city_dir/city['binary']['file']).read_bytes();assert sha(binary)==city['binary']['sha256'];byid={b['id']:b for b in city['buildings']};assert len(set(a.building))==len(a.building)
    output=[];images={};missing=[]
    for bid in a.building:
        b=byid[bid];building=[r for r in doc.findall('.//b:Building',NS)if r.get(GID)==bid];assert len(building)==1;building=building[0];vtj=building.find("gen:stringAttribute[@name='VTJ_PRT']/gen:value",NS);vtj=None if vtj is None else vtj.text;assert vtj==b['vtj'],'Exact VTJ identity required'
        polygons={q.get(GID):q for q in building.findall('.//g:Polygon',NS)};surfaces=[]
        for appearance in building.findall('.//a:Appearance',NS):
            if appearance.findtext('a:theme',namespaces=NS)!=a.theme:continue
            for pic in appearance.findall('.//a:ParameterizedTexture',NS):
                image=pic.findtext('a:imageURI',namespaces=NS);assert image and not pathlib.PurePosixPath(image).is_absolute()and'..'not in pathlib.PurePosixPath(image).parts;filenames=[n for n in z.namelist()if n.endswith('/'+image)];assert len(filenames)==1;image_bytes=z.read(filenames[0]);assert len(image_bytes)<16000000;digest=sha(image_bytes);suffix=pathlib.PurePosixPath(image).suffix.lower();assert suffix in('.jpg','.jpeg','.png');name=digest+suffix;images[name]=image_bytes
                for target in pic.findall('a:target',NS):
                    poly_id=target.get('uri');assert poly_id and poly_id.startswith('#');poly=polygons[poly_id[1:]];rings={r.get(GID):r for r in poly.findall('.//g:LinearRing',NS)};verts=[];exterior=[]
                    exterior_ring=poly.find('g:exterior/g:LinearRing',NS);assert exterior_ring is not None
                    for uv in target.findall('.//a:textureCoordinates',NS):
                        ring=rings[uv.get('ring')[1:]];P=[float(x)for x in ring.findtext('g:posList',namespaces=NS).split()];U=[float(x)for x in uv.text.split()];assert len(P)//3==len(U)//2 and len(P)>=12
                        ring_vertices=[((P[i]-25497350,P[i+2]-7.5,6672960-P[i+1]),(U[i//3*2],1-U[i//3*2+1]))for i in range(0,len(P)-3,3)]
                        assert all(math.isfinite(v)and-.001<=v<=1.001 for _,uvs in ring_vertices for v in uvs)
                        verts+=ring_vertices
                        if ring.get(GID)==exterior_ring.get(GID):exterior=[v[0]for v in ring_vertices]
                    assert len(exterior)>=3
                    pn=[sum((exterior[i][(k+1)%3]-exterior[(i+1)%len(exterior)][(k+1)%3])*(exterior[i][(k+2)%3]+exterior[(i+1)%len(exterior)][(k+2)%3])for i in range(len(exterior)))for k in range(3)]
                    length=math.sqrt(sum(n*n for n in pn));assert length>1e-10;pn=[n/length for n in pn]
                    surfaces.append({'polygon':poly_id[1:],'image':name,'verts':verts,'normal':pn})
        matched=[];unmatched=[]
        for face in source_faces(b,binary):
            options=[]
            for surface in surfaces:
                if abs(sum(x*y for x,y in zip(face['normal'],surface['normal'])))<.9999:continue
                nearest=[min((math.dist(p,q),i,q,uv)for i,(q,uv)in enumerate(surface['verts']))for p in face['points']];err=max(n[0]for n in nearest)
                if err<=.005:
                    assert len(set(n[1]for n in nearest))==3,'Degenerate texture-source vertex mapping';options.append((err,surface,nearest))
            if not options:unmatched.append({k:face[k]for k in['part','triangle','key','points']});continue
            options.sort(key=lambda o:o[0]);_,surface,near=options[0];uvs=[n[3]for n in near]
            # Several coplanar source surfaces may duplicate a corner triangle.
            # Accept only identical image/UV mappings; never nearest-only ambiguity.
            equivalent=all(o[1]['image']==surface['image']and all(math.dist(x[3],y)<1e-8 for x,y in zip(o[2],uvs))for o in options)
            assert equivalent,('Ambiguous source polygon/image/UV mapping',bid,face['triangle'],[(o[1]['polygon'],o[1]['image'])for o in options])
            matched.append({**face,'image':surface['image'],'polygon':surface['polygon'],'sourcePolygonAliases':sorted(set(o[1]['polygon']for o in options)),'sourcePolygonNormalDot':sum(x*y for x,y in zip(face['normal'],surface['normal'])),'uv':uvs,'sourceVertexErrorMetres':max(n[0]for n in near),'sourceVertices':[n[2]for n in near]})
        output.append({'id':bid,'vtj':vtj,'address':b['address'],'sourceWallTriangles':len(matched)+len(unmatched),'matchedWallTriangles':len(matched),'unmatchedWallTriangles':len(unmatched),'maximumSourceVertexErrorMetres':max((f['sourceVertexErrorMetres']for f in matched),default=None),'faces':matched,'unmatched':unmatched})
    used={f['image']for b in output for f in b['faces']};out.mkdir(parents=True);(out/'images').mkdir()
    for name in sorted(used):(out/'images'/name).write_bytes(images[name])
    profile={'schemaVersion':1,'status':'SOURCE_UV_TRANSFER_READY_REQUIRES_RUNTIME_REVIEW','source':{'archiveSha256':sha(archive),'archiveBytes':len(archive),'gmlSha256':sha(gml),'citySha256':sha(city_bytes),'binarySha256':sha(binary),'originId':city['originId'],'theme':a.theme,'license':'CC-BY-4.0','attribution':'Buildings and original municipal appearance imagery © City of Helsinki, CC BY4.0; native UV transfer and atlas resampling by Helsinki Rides.'},'identityGate':{'maximumVertexDistanceMetres':.005,'sameBIDAndVTJ':True,'sourcePolygonOrientationRecorded':True,'nativeWindingPreserved':True,'ambiguousImageOrUVRejected':True,'nativePositionsChanged':False},'images':[{'path':'images/'+name,'sha256':sha(images[name]),'bytes':len(images[name])}for name in sorted(used)],'buildings':output}
    (out/'profile.json').write_text(json.dumps(profile,indent=2,ensure_ascii=True)+'\n');print(json.dumps({'status':profile['status'],'buildings':[{k:v for k,v in b.items()if k not in('faces','unmatched')}for b in output],'imageBytes':sum(len(images[n])for n in used),'images':len(used)}))
if __name__=='__main__':main()
