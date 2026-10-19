// Isolated actual-Three.js review of the packed asset. World placement is verified separately in the game.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
const { values } = parseArgs({ options: { asset: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.asset && values.out); assert.ok(!existsSync(values.out)); mkdirSync(values.out, { recursive: true });
const root = process.cwd(), asset = path.resolve(values.asset), placement = JSON.parse(readFileSync(path.join(path.dirname(asset), 'placement.json'))).placement;
const html = `<!doctype html><html><head><style>html,body{margin:0;background:#abb8c2;overflow:hidden}#label{position:absolute;left:20px;top:18px;color:white;background:#17202ddc;padding:12px 16px;font:16px system-ui}</style><script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script></head><body><div id="label">Alexander II | packed GLB | isolated asset review</div><script type="module">
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
const r=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});r.setSize(1200,900);r.setPixelRatio(1);r.outputColorSpace=THREE.SRGBColorSpace;r.toneMapping=THREE.ACESFilmicToneMapping;r.toneMappingExposure=1.15;document.body.append(r.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0xabb8c2);scene.add(new THREE.HemisphereLight(0xcce3ff,0x8b8070,2));const sun=new THREE.DirectionalLight(0xfff3db,3);sun.position.set(-8,18,12);scene.add(sun);const fill=new THREE.DirectionalLight(0xc8ddff,1);fill.position.set(8,8,-10);scene.add(fill);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0x777b77,roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=${placement.groundY}-0.005;scene.add(ground);
const grid=new THREE.GridHelper(30,30,0x929994,0x929994);grid.position.y=${placement.groundY}+0.001;scene.add(grid);
const camera=new THREE.PerspectiveCamera(34,1200/900,.1,300);
const ktx=new KTX2Loader().setTranscoderPath('/basis/').detectSupport(r);const loader=new GLTFLoader().setKTX2Loader(ktx).setMeshoptDecoder(MeshoptDecoder);
const model=await loader.loadAsync('/asset.glb');scene.add(model.scene);const box=new THREE.Box3().setFromObject(model.scene),meshes=[];model.scene.traverse(o=>{if(o.isMesh)meshes.push({name:o.name,triangles:o.geometry.index.count/3,material:o.material.name});});
window.review={draw:(position,label)=>{camera.position.fromArray(position);camera.lookAt(0,5.1,0);document.getElementById('label').textContent='Alexander II | '+label+' | isolated asset review';r.render(scene,camera);return{triangles:r.info.render.triangles,drawCalls:r.info.render.calls};},bounds:{min:box.min.toArray(),max:box.max.toArray()},meshes,ready:true};window.review.draw([13,9,24],'south east');
</script></body></html>`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 }), errors = [];
try {
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('http://127.0.0.1:5317/**', async route => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
    let file; if (p === '/asset.glb') file = asset;
    else if (p.startsWith('/three/')) file = path.resolve(root, 'apps/game/node_modules/three', p.slice('/three/'.length));
    else if (p.startsWith('/basis/')) file = path.resolve(root, 'apps/game/public/basis', p.slice('/basis/'.length));
    else return route.abort();
    const allowed = [asset, path.resolve(root, 'apps/game/node_modules/three') + path.sep, path.resolve(root, 'apps/game/public/basis') + path.sep];
    assert.ok(allowed.some(a => file === a || file.startsWith(a)));
    await route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'model/gltf-binary' });
  });
  await page.goto('http://127.0.0.1:5317/'); await page.waitForFunction(() => window.review?.ready, undefined, { timeout: 90000 });
  const metrics = await page.evaluate(() => ({ bounds: window.review.bounds, meshes: window.review.meshes })), views = [];
  for (const [name, position] of [['south-front', [0, 8, 27]], ['south-east', [15, 10, 24]], ['north-rear', [0, 8, -27]], ['west', [-27, 8, 0]]]) {
    const stats = await page.evaluate(([p, n]) => window.review.draw(p, n), [position, name]); await page.screenshot({ path: path.join(values.out, name + '.png') }); views.push({ name, position, ...stats });
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(values.out, 'review.json'), JSON.stringify({ status: 'CAPTURED_REQUIRES_OPENING', asset: values.asset, assetSha256: createHash('sha256').update(readFileSync(asset)).digest('hex'), scriptSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'), engine: 'Three.js0.186.1/GLTFLoader/KTX2Loader/MeshoptDecoder', scope: 'Isolated asset fixture; not world placement or gameplay proof', metrics, views, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ metrics, views, errors }));
} finally { await context.close(); await browser.close(); }
