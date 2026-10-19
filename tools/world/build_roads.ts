// Road graph from the OpenStreetMap snapshot (plan sections 3 and 4.2): drivable ways become directed lanes between
// junction nodes, with turn connectors (respecting OSM turn restrictions), heights from the terrain, parking slots
// from the city's street-part polygons, and footways for the minimap. Everything is in the runtime frame.
//   node tools/world/build_roads.ts --osm-ledger data/raw/osm/ledger.json --snapshot senate-district \
//     --origin content/helsinki/world-origin.json --config content/helsinki/roads.json \
//     --terrain data/work/m0/terrain/terrain.bin --street-parts data/raw/helsinki-street-parts/senate-district.geojson \
//     --out data/work/m0/roads
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  geodeticToGk25, parseTerrain, sampleTerrain, polylineLength, validateRoadGraph, RoadIndex,
  type RoadConnector, type RoadGraph, type RoadLane, type RoadNode, type Vec3,
} from '../../packages/world-schema/src/index.ts';
import { centroid, loadGeoJsonPolygons, pointInPolygon, ringDistance, type Pt } from './lib/geometry.ts';
import { isSupportedSurfaceWay } from './lib/surface-way.ts';
import { unsupportedRoadApproaches } from './lib/road-approaches.ts';
import { sourceCutRoadEnds } from './lib/road-end-turns.ts';
import { registeredBridgeDecks, type CoastalOsm } from './lib/coastal-mask.ts';
import { roadLaneLayout } from './lib/road-lane-layout.ts';
import {verifyUnsupportedPortalComponent,type UnsupportedPortalComponent}from './lib/unsupported-portal-component.ts';
import {sourceVehicleDeadEnd,type VehicleDeadEndTrim}from './lib/source-vehicle-deadend.ts';
import {applySourceRoadRegistrations,registerConnector,vehicleSourceProof,type RoadRegistrations}from './lib/source-road-registration.ts';

const { values } = parseArgs({ options: {
  'osm-ledger': { type: 'string' }, snapshot: { type: 'string' }, origin: { type: 'string' }, config: { type: 'string' },
  terrain: { type: 'string' }, 'street-parts': { type: 'string' }, out: { type: 'string' },
} });
for (const k of ['osm-ledger', 'snapshot', 'origin', 'config', 'terrain', 'street-parts', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`);
if (existsSync(values.out!)) throw new Error(`${values.out} exists; the build writes into a new directory`);
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

const ledger = JSON.parse(readFileSync(values['osm-ledger']!, 'utf8'));
const snap = ledger.snapshots[values.snapshot!];
if (!snap) throw new Error(`snapshot ${values.snapshot} not in the OSM ledger`);
const osmBytes = readFileSync(path.join(path.dirname(values['osm-ledger']!), snap.path));
if (sha256(osmBytes) !== snap.sha256) throw new Error('OSM snapshot does not match its ledger hash');
const osm = JSON.parse(osmBytes.toString('utf8')) as { elements: OsmElement[] };
const origin = JSON.parse(readFileSync(values.origin!, 'utf8'));
const [E0, N0] = origin.originProjected as [number, number, number];
const config = JSON.parse(readFileSync(values.config!, 'utf8'));
const terrain = parseTerrain(new Uint8Array(readFileSync(values.terrain!)));
const area = config.playArea as { minX: number; maxX: number; minZ: number; maxZ: number };

interface OsmElement { type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string>; members?: { type: string; ref: number; role: string }[] }

// ---- nodes to the runtime frame ----
const nodeXZ = new Map<number, [number, number]>();
for (const e of osm.elements) if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) {
  const [E, N] = geodeticToGk25(e.lat, e.lon);
  nodeXZ.set(e.id, [E - E0, -(N - N0)]);
}
const heightAt = (x: number, z: number) => sampleTerrain(terrain, x, z);
const inArea = (p: [number, number]) => p[0] >= area.minX && p[0] <= area.maxX && p[1] >= area.minZ && p[1] <= area.maxZ;
const parts = loadGeoJsonPolygons(values['street-parts']!, E0, N0, (p, i) => String(p['osan_id'] ?? p['id'] ?? i));
const registration=config.sourceRegistration as (RoadRegistrations&{sourceHashes:{osm:string;streetParts:string;buildingRegister:string};buildingRegister:string;portalComponents:UnsupportedPortalComponent[];vehicleDeadEndTrims?:VehicleDeadEndTrim[]})|undefined;
if(registration&&(registration.sourceHashes.osm!==snap.sha256||registration.sourceHashes.streetParts!==sha256(readFileSync(values['street-parts']!))||registration.sourceHashes.buildingRegister!==sha256(readFileSync(registration.buildingRegister))))throw new Error('Road registration source hashes do not match frozen source geometry');
for(const d of registration?.junctionMouths??[])if(d.bodyOverhangPhysicalProof){const proof=readFileSync(d.bodyOverhangPhysicalProof.file);if(sha256(proof)!==d.bodyOverhangPhysicalProof.sha256||JSON.parse(proof.toString('utf8')).totalCollisions!==0)throw new Error('Source junction body overhang physical proof differs from its approved evidence');}
const registrationBuildings=registration?loadGeoJsonPolygons(registration.buildingRegister,E0,N0,(p,i)=>String(p['vtj_prt']??i)):[];
// Some surveyed bridge decks have no bridge tag on their OSM approach way.
// An explicit source binding keeps unknown deck heights out of surface routing.
const surveyBridgeExclusions = (config.unmodelledSurveyBridgeWays ?? []) as { wayId: number; partIds: string[]; reason: string }[];
if (!Array.isArray(surveyBridgeExclusions)) throw new Error('unmodelledSurveyBridgeWays must be an array');
for (const declaration of surveyBridgeExclusions) {
  const way = osm.elements.find(e => e.type === 'way' && e.id === declaration.wayId);
  if (!Number.isSafeInteger(declaration.wayId) || !way?.nodes?.length || !way.tags?.['highway'] || !Array.isArray(declaration.partIds) || !declaration.partIds.length || typeof declaration.reason !== 'string' || !declaration.reason.length) throw new Error('Invalid source-bound survey bridge exclusion');
  const axis = way.nodes.map(id => nodeXZ.get(id));
  if (axis.some(point => !point)) throw new Error(`Survey bridge ${way.id} has missing nodes`);
  const laneCount = Math.max(1, Math.min(8, Number(way.tags['lanes']) || 2));
  const halfWidth = laneCount * Number(config.laneWidth[way.tags['highway']] ?? config.laneWidth.default) / 2;
  for (const id of declaration.partIds) {
    const part = parts.find(p => p.id === id);
    if (!part || part.properties['paatyyppi'] !== 'Silta') throw new Error(`Survey bridge ${way.id} lacks declared Silta part ${id}`);
    let intersects = false;
    for (let i = 0; i + 1 < axis.length; i++) {
      const a = axis[i]!, b = axis[i + 1]!, count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 4));
      for (let j = 0; j <= count; j++) {
        const point: Pt = [a[0] + (b[0] - a[0]) * j / count, -(a[1] + (b[1] - a[1]) * j / count)];
        if (pointInPolygon(point, part.rings) || ringDistance(point, part.rings[0]!) <= halfWidth) { intersects = true; break; }
      }
    }
    if (!intersects) throw new Error(`Survey bridge ${way.id} does not meet declared source part ${id}`);
  }
}
const supportedBridgeIds = new Set<number>(config.supportedBridgeWayIds ?? []);
const bridgeDecks = supportedBridgeIds.size ? registeredBridgeDecks(osm as CoastalOsm,parts,origin.originProjected) : null;
for (const id of supportedBridgeIds) {
  const way = osm.elements.find(e=>e.type==='way'&&e.id===id);
  if (!Number.isSafeInteger(id) || !way?.tags?.['bridge'] || way.tags['bridge']==='no' || !isSupportedSurfaceWay({...way.tags,bridge:'no'}) || !bridgeDecks?.matches.some(m=>m.way===id)) throw new Error(`bridge ${id} lacks an eligible registered deck`);
}
const supportsWay = (way: OsmElement) => !!way.tags && (isSupportedSurfaceWay(way.tags) || supportedBridgeIds.has(way.id) && isSupportedSurfaceWay({...way.tags,bridge:'no'}));

// ---- drivable ways ----
const drivable = new Set<string>(config.drivable);
const portalComponents=(registration?.portalComponents??[]).map(d=>verifyUnsupportedPortalComponent(osm.elements,d,drivable));
const vehicleDeadEndTrims=(registration?.vehicleDeadEndTrims??[]).map(d=>{
  for(const id of d.protectedPartIds){const p=parts.find(p=>p.id===id);if(!p||!String(p.properties['alatyyppi']).toLowerCase().includes('pensas'))throw new Error(`Project-car dead-end lacks source planting guard ${id}`);}
  return sourceVehicleDeadEnd(osm.elements,d,drivable);
});
const unsupportedApproaches = unsupportedRoadApproaches(osm.elements, drivable);
const unsupportedApproachIds = new Set(unsupportedApproaches.map(a => a.wayId));
const footwayClasses = new Set<string>(config.footways);
const closures = new Set<number>([...config.closures, ...surveyBridgeExclusions.map(record => record.wayId),...portalComponents.flatMap(c=>c.wayIds)]);
interface Way { id: number; nodes: number[]; tags: Record<string, string> }
const ways: Way[] = [];
const footways: { id: string; points: Vec3[] }[] = [];
for (const e of osm.elements) {
  if (e.type !== 'way' || !e.nodes || !e.tags) continue;
  if (!supportsWay(e) || closures.has(e.id)) continue;
  const hw = e.tags['highway'];
  if (!hw) continue;
  if (e.tags['area'] === 'yes') continue;
  const pts = e.nodes.map(n => nodeXZ.get(n)).filter((p): p is [number, number] => !!p);
  if (pts.length < 2) continue;
  if (footwayClasses.has(hw) && pts.some(inArea)) footways.push({ id: `w${e.id}`, points: pts.map(p => [p[0], heightAt(p[0], p[1]), p[1]]) });
  if (!drivable.has(hw)) continue;
  if (unsupportedApproachIds.has(e.id)) continue;
  const access = e.tags['motor_vehicle'] ?? e.tags['vehicle'] ?? e.tags['access'];
  if (access === 'no' || access === 'private') continue;
  if (closures.has(e.id)) continue;
  if (!pts.some(inArea)) continue;
  const trimmed=vehicleDeadEndTrims.find(d=>d.wayId===e.id);
  ways.push({ id: e.id, nodes: (trimmed?.nodes??e.nodes).filter(n => nodeXZ.has(n)), tags: e.tags });
}

// ---- junction detection and way pieces ----
const useCount = new Map<number, number>();
for (const w of ways) for (const n of w.nodes) useCount.set(n, (useCount.get(n) ?? 0) + 1);
const isJunction = (n: number, w: Way, i: number) => (useCount.get(n) ?? 0) > 1 || i === 0 || i === w.nodes.length - 1;
interface Piece { id: string; way: Way; nodes: number[] }
const pieces: Piece[] = [];
for (const w of ways) {
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (isJunction(w.nodes[i]!, w, i)) {
      pieces.push({ id: `${w.id}:${pieces.filter(p => p.way === w).length}`, way: w, nodes: w.nodes.slice(start, i + 1) });
      start = i;
    }
  }
}

const nodes = new Map<string, RoadNode>();
const unsupportedSourceWayIds=new Set<number>([...closures,...unsupportedApproachIds]);
for(const element of osm.elements)if(element.type==='way'&&element.tags&&drivable.has(element.tags.highway??'')&&!supportsWay(element))unsupportedSourceWayIds.add(element.id);
const sourceCutEnds=sourceCutRoadEnds(osm.elements,drivable,ways,unsupportedSourceWayIds);
const sourceCutEndByNode=new Map(sourceCutEnds.map(end=>[`n${end.nodeId}`,end]));
const nodeId = (n: number) => `n${n}`;
for (const p of pieces) for (const n of [p.nodes[0]!, p.nodes[p.nodes.length - 1]!]) {
  if (nodes.has(nodeId(n))) continue;
  const xz = nodeXZ.get(n)!;
  const uses = useCount.get(n) ?? 0;
  const kind = !inArea(xz) ? 'boundary' : uses > 1 ? 'junction' : 'end';
  nodes.set(nodeId(n), { id: nodeId(n), position: [xz[0], heightAt(xz[0], xz[1]), xz[1]], kind });
}
// Interior nodes of a piece that are shared by another way (should not happen after splitting) are junctions too.
for (const p of pieces) for (let i = 1; i < p.nodes.length - 1; i++) if ((useCount.get(p.nodes[i]!) ?? 0) > 1) throw new Error(`piece ${p.id} has an interior junction`);

// ---- lanes ----
const speedFor = (hw: string, tags: Record<string, string>): number => {
  const m = tags['maxspeed']?.match(/^(\d+)/);
  if (m) return Number(m[1]) / 3.6;
  return config.speedLimits[hw] ?? config.speedLimits.default;
};
const widthFor = (hw: string): number => config.laneWidth[hw] ?? config.laneWidth.default;
const surfaceFor = (tags: Record<string, string>): string => config.surfaces[tags['surface'] ?? ''] ?? config.surfaces.default;
function offsetPolyline(pts: [number, number][], offset: number): [number, number][] {
  // Offset to the right of travel (runtime frame: right of direction d = (dx, dz) is (-dz, dx)... in a Y-up right-handed
  // frame with Z south, the right-hand side of travel direction (dx, dz) is (-dz, dx).
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    // miter scale for corners
    let scale = 1;
    if (i > 0 && i < pts.length - 1) {
      const p = pts[i - 1]!, q = pts[i]!, r = pts[i + 1]!;
      const d1x = q[0] - p[0], d1z = q[1] - p[1], l1 = Math.hypot(d1x, d1z) || 1;
      const d2x = r[0] - q[0], d2z = r[1] - q[1], l2 = Math.hypot(d2x, d2z) || 1;
      const cos = (d1x * d2x + d1z * d2z) / (l1 * l2);
      scale = Math.min(2, 1 / Math.max(0.5, Math.cos(Math.acos(Math.max(-1, Math.min(1, cos))) / 2)));
    }
    out.push([pts[i]![0] - dz * offset * scale, pts[i]![1] + dx * offset * scale]);
  }
  return out;
}
const lanes: RoadLane[] = [];
const pieceLanes = new Map<string, { forward: RoadLane[]; backward: RoadLane[] }>();
const laneLayouts = new Map<number, ReturnType<typeof roadLaneLayout>>();
for (const p of pieces) {
  const t = p.way.tags, hw = t['highway']!;
  const sharedOverride=registration?.fullCorridors.find(d=>d.wayId===p.way.id);
  if(sharedOverride&&['lanes','lanes:forward','lanes:backward'].some(k=>t[k]!==undefined))throw new Error(`Source-shared override conflicts with explicit lane count on${p.way.id}`);
  const layout = laneLayouts.get(p.way.id) ?? roadLaneLayout(sharedOverride?{...t,lanes:'1'}:t,widthFor(hw));
  laneLayouts.set(p.way.id,layout);
  const fwd=layout.forward,bwd=layout.backward,width=layout.width;
  const base = p.nodes.map(n => nodeXZ.get(n)!);
  const entry = { forward: [] as RoadLane[], backward: [] as RoadLane[] };
  pieceLanes.set(p.id, entry);
  const make = (dir: 'f' | 'b', idx: number, count: number) => {
    const pts = dir === 'f' ? base : [...base].reverse();
    const offset = layout.offsets[dir==='f'?'forward':'backward'][idx]!;
    const line = offsetPolyline(pts, offset);
    const points: Vec3[] = line.map(q => [q[0], heightAt(q[0], q[1]), q[1]]);
    const from = nodeId(dir === 'f' ? p.nodes[0]! : p.nodes[p.nodes.length - 1]!);
    const to = nodeId(dir === 'f' ? p.nodes[p.nodes.length - 1]! : p.nodes[0]!);
    const lane: RoadLane = { id: `${p.id}:${dir}${idx}`, wayId: p.way.id, name: t['name'] ?? null, highway: hw, surface: surfaceFor(t),
      speedLimit: speedFor(hw, t), width, from, to, points, length: polylineLength(points), index: idx, count };
    lanes.push(lane);
    (dir === 'f' ? entry.forward : entry.backward).push(lane);
  };
  for (let i = 0; i < fwd; i++) make('f', i, fwd);
  for (let i = 0; i < bwd; i++) make('b', i, bwd);
}
const logicalLanePoints=new Map(lanes.map(l=>[l.id,l.points]));
if(registration)for(const d of registration.endpointAlignments){const way=ways.find(w=>w.id===d.wayId);if(!way||way.nodes[d.endpoint==='start'?0:way.nodes.length-1]!==d.endpointNodeId)throw new Error(`Source registration endpoint differs from OSM way${d.wayId}`);}
const registered=registration?applySourceRoadRegistrations({lanes,nodes,parts,buildings:registrationBuildings,registrations:registration,heightAt}):null;

// ---- turn restrictions ----
interface Restriction { from: number; via: number; to: number; only: boolean }
const restrictions: Restriction[] = [];
for (const e of osm.elements) {
  if (e.type !== 'relation' || e.tags?.['type'] !== 'restriction' || !e.members) continue;
  const r = e.tags['restriction'] ?? e.tags['restriction:motorcar'] ?? '';
  const from = e.members.find(m => m.role === 'from' && m.type === 'way'), to = e.members.find(m => m.role === 'to' && m.type === 'way');
  const via = e.members.find(m => m.role === 'via' && m.type === 'node');
  if (!from || !to || !via) continue;
  restrictions.push({ from: from.ref, via: via.ref, to: to.ref, only: r.startsWith('only_') });
}
function allowed(inLane: RoadLane, outLane: RoadLane, node: string): boolean {
  const via = Number(node.slice(1));
  for (const r of restrictions) {
    if (r.via !== via) continue;
    if (r.only) { if (r.from === inLane.wayId && r.to !== outLane.wayId) return false; }
    else if (r.from === inLane.wayId && r.to === outLane.wayId) return false;
  }
  return true;
}

// ---- connectors ----
const laneByNodeIn = new Map<string, RoadLane[]>(), laneByNodeOut = new Map<string, RoadLane[]>();
for (const l of lanes) {
  (laneByNodeIn.get(l.to) ?? laneByNodeIn.set(l.to, []).get(l.to)!).push(l);
  (laneByNodeOut.get(l.from) ?? laneByNodeOut.set(l.from, []).get(l.from)!).push(l);
}
const tangentAtEnd = (l: RoadLane): [number, number] => {
  const a = l.points[l.points.length - 2]!, b = l.points[l.points.length - 1]!;
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
  return [(b[0] - a[0]) / len, (b[2] - a[2]) / len];
};
const tangentAtStart = (l: RoadLane): [number, number] => {
  const a = l.points[0]!, b = l.points[1]!;
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
  return [(b[0] - a[0]) / len, (b[2] - a[2]) / len];
};
function curve(p0: Vec3, t0: [number, number], p3: Vec3, t1: [number, number], dense=false): Vec3[] {
  const d = Math.hypot(p3[0] - p0[0], p3[2] - p0[2]);
  const k = Math.max(0.5, d / 3);
  const p1: Vec3 = [p0[0] + t0[0] * k, p0[1], p0[2] + t0[1] * k];
  const p2: Vec3 = [p3[0] - t1[0] * k, p3[1], p3[2] - t1[1] * k];
  const n = dense?160:Math.max(3, Math.min(12, Math.ceil(d / 2)));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, u = 1 - s;
    const x = u * u * u * p0[0] + 3 * u * u * s * p1[0] + 3 * u * s * s * p2[0] + s * s * s * p3[0];
    const z = u * u * u * p0[2] + 3 * u * u * s * p1[2] + 3 * u * s * s * p2[2] + s * s * s * p3[2];
    out.push([x, heightAt(x, z), z]);
  }
  return out;
}
const connectors: RoadConnector[] = [];
const suppressedCutEndReversals:{id:string;node:string;source:typeof sourceCutEnds[number]}[]=[];
const connectorRegistrationProofs:unknown[]=[];
for (const [node, incoming] of laneByNodeIn) {
  const n = nodes.get(node)!;
  if (n.kind === 'boundary') continue;
  const outgoing = laneByNodeOut.get(node) ?? [];
  for (const inLane of incoming) {
    const t0 = tangentAtEnd(inLane);
    const inPiece = inLane.id.slice(0, inLane.id.lastIndexOf(':'));
    let made = 0;
    for (const outLane of outgoing) {
      const outPiece = outLane.id.slice(0, outLane.id.lastIndexOf(':'));
      const reversal = outPiece === inPiece;
      if (reversal && n.kind !== 'end') continue; // U-turns only at dead ends
      if(reversal&&sourceCutEndByNode.has(node)){
        suppressedCutEndReversals.push({id:`${inLane.id}>${outLane.id}`,node,source:sourceCutEndByNode.get(node)!});
        continue;
      }
      if (!allowed(inLane, outLane, node)) continue;
      const t1 = tangentAtStart(outLane);
      // signed angle in the X/-Z (east/north) plane: positive = left turn
      const logical0=tangentAtEnd({...inLane,points:logicalLanePoints.get(inLane.id)!}),logical1=tangentAtStart({...outLane,points:logicalLanePoints.get(outLane.id)!});
      const cross = logical0[0] * (-logical1[1]) - (-logical0[1]) * logical1[0];
      const dot = logical0[0] * logical1[0] + logical0[1] * logical1[1];
      const angle = Math.atan2(cross, dot) * 180 / Math.PI;
      const turn = reversal ? 'u-turn' : Math.abs(angle) < 30 ? 'straight' : angle > 0 ? 'left' : 'right';
      // Straight-through between multi-lane pieces keeps the lane index.
      if (turn === 'straight' && inLane.count > 1 && outLane.count > 1 && inLane.index !== outLane.index) continue;
      const field=registered?.connectorFields.get(node);
      let points = curve(inLane.points[inLane.points.length - 1]!, t0, outLane.points[0]!, t1,!!field);
      if(field){const fit=registerConnector(points,field,heightAt);points=fit.points;const bodyProof=registration?.fullCorridors.some(d=>d.wayId===inLane.wayId||d.wayId===outLane.wayId)?vehicleSourceProof(points,field):null,physicalProof=registration?.junctionMouths?.find(d=>`n${d.nodeId}`===node)?.bodyOverhangPhysicalProof;if(bodyProof&&(bodyProof.wheelFailures||bodyProof.failures&&!physicalProof))throw new Error(`Connector${inLane.id}>${outLane.id} lacks full vehicle support: ${JSON.stringify(bodyProof.firstFailure)}`);connectorRegistrationProofs.push({id:`${inLane.id}>${outLane.id}`,node,maxShift:fit.maxShift,bodyProof,physicalProof:physicalProof??null});}
      connectors.push({ id: `${inLane.id}>${outLane.id}`, node, from: inLane.id, to: outLane.id, turn, points, length: polylineLength(points) });
      made++;
    }
    // A node with no connectors is a one-way stub or a boundary cut; the report lists it.
    void made;
  }
}

// ---- parking slots from the city's street parts (Ajorata / Pysäköintialue) ----
const parking: { id: string; kind: 'lane' | 'area'; points: Vec3[]; heading: number | null }[] = [];
const spacing = Number(config.parkingSlotSpacing), inset = Number(config.parkingInset);
for (const poly of parts) {
  if (poly.properties['alatyyppi'] !== 'Pysäköintialue') continue;
  const ring = poly.rings[0]!;
  // Principal axis by the longest edge direction weighted by length.
  let ax = 0, ay = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx) * 2; // double angle so opposite directions agree
    ax += Math.cos(ang) * l; ay += Math.sin(ang) * l;
  }
  const theta = Math.atan2(ay, ax) / 2;
  const ux = Math.cos(theta), uy = Math.sin(theta);
  const c = centroid(ring);
  let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
  for (const p of ring) {
    const s = (p[0] - c[0]) * ux + (p[1] - c[1]) * uy, t = -(p[0] - c[0]) * uy + (p[1] - c[1]) * ux;
    smin = Math.min(smin, s); smax = Math.max(smax, s); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
  }
  const rows = Math.max(1, Math.floor((tmax - tmin) / 5.0));
  const points: Vec3[] = [];
  for (let r = 0; r < rows; r++) {
    const t = tmin + (tmax - tmin) * (r + 0.5) / rows;
    for (let s = smin + inset; s <= smax - inset; s += spacing) {
      const x = c[0] + ux * s - uy * t, y = c[1] + uy * s + ux * t;
      const pt: Pt = [x, y];
      if (!pointInPolygon(pt, poly.rings) || ringDistance(pt, ring) < inset * 0.8) continue;
      // Slots are stored in the runtime frame: z = -y; the heading along +s in ENU is atan2(ux, uy) from north.
      if (!inArea([x, -y])) continue;
      points.push([x, heightAt(x, -y), -y]);
    }
  }
  if (points.length === 0) continue;
  const headingDeg = ((Math.atan2(ux, uy) * 180 / Math.PI) + 360) % 360;
  parking.push({ id: `p${poly.id}`, kind: 'area', points, heading: headingDeg });
}

const graph: RoadGraph = {
  schemaVersion: 2, originId: origin.id,
  source: { id: ledger.source.id, sha256: snap.sha256, attribution: ledger.source.attribution, license: ledger.source.license },
  nodes: [...nodes.values()], lanes, connectors, parking, footways,
};
const problems = validateRoadGraph(graph);
if (problems.length) throw new Error(problems.join('\n'));

// ---- connectivity report: weak components, then directed reachability from the longest lane of the main one ----
const index = new RoadIndex(graph);
const adjacency = new Map<string, Set<string>>();
const link = (a: string, b: string) => { (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b); };
for (const c of connectors) { link(c.from, c.to); link(c.to, c.from); }
const seen = new Set<string>();
const components: string[][] = [];
for (const l of lanes) {
  if (seen.has(l.id)) continue;
  const comp: string[] = [], stack = [l.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id); comp.push(id);
    for (const n of adjacency.get(id) ?? []) stack.push(n);
  }
  components.push(comp);
}
components.sort((a, b) => b.length - a.length);
const main = new Set(components[0] ?? []);
const seed = lanes.filter(l => main.has(l.id)).sort((a, b) => b.length - a.length)[0]?.id;
const reachable = new Set<string>();
if (seed) {
  const stack = [seed];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const c of index.outgoing.get(id) ?? []) stack.push(c.to);
  }
}
const deadEnds = lanes.filter(l => (index.outgoing.get(l.id) ?? []).length === 0 && nodes.get(l.to)!.kind !== 'boundary').map(l => l.id);
const unreachable = lanes.filter(l => main.has(l.id) && !reachable.has(l.id) && nodes.get(l.from)!.kind !== 'boundary').map(l => l.id);
const isolated = components.slice(1).map(c => ({ lanes: c.length, names: [...new Set(c.map(id => index.laneById.get(id)!.name))] }));
const byKind: Record<string, number> = {};
for (const n of nodes.values()) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
const laneMetres: Record<string, number> = {};
for (const l of lanes) laneMetres[l.highway] = Math.round(((laneMetres[l.highway] ?? 0) + l.length) * 10) / 10;

mkdirSync(values.out!, { recursive: true });
const round = (v: number) => Math.round(v * 1000) / 1000;
const json = JSON.stringify(graph, (_k, v) => typeof v === 'number' ? round(v) : v);
writeFileSync(path.join(values.out!, 'roads.json'), json);
const report = {
  snapshot: { id: values.snapshot, retrievedAt: snap.retrievedAt, sha256: snap.sha256 },
  ways: ways.length, pieces: pieces.length, lanes: lanes.length, connectors: connectors.length, nodes: byKind, laneMetres,
  unsupportedApproaches,
  sourceCutEnds, suppressedCutEndReversals,
  surveyBridgeExclusions,
  supportedBridges: bridgeDecks?.matches.filter(m=>supportedBridgeIds.has(m.way)) ?? [],
  laneLayouts: [...laneLayouts].map(([wayId,layout])=>({wayId,...layout})),
  sourceRegistration:registered?{...registered.report,connectors:connectorRegistrationProofs,portalComponents,vehicleDeadEndTrims,sourceHashes:registration!.sourceHashes}:null,
  restrictions: restrictions.length, parkingAreas: parking.length, parkingSlots: parking.reduce((s, p) => s + p.points.length, 0),
  footways: footways.length, mainComponentLanes: main.size, seedLane: seed ?? null, deadEnds, unreachable, isolated,
  bytes: Buffer.byteLength(json), sha256: sha256(json),
};
writeFileSync(path.join(values.out!, 'roads-report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ lanes: lanes.length, connectors: connectors.length, nodes: byKind, mainComponent: main.size, deadEnds: deadEnds.length, unreachable: unreachable.length, isolated: isolated.length, parkingSlots: report.parkingSlots }));
