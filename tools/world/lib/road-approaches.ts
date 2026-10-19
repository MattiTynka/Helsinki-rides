import { isSupportedSurfaceWay } from './surface-way.ts';

interface Element { type: string; id: number; nodes?: number[]; tags?: Record<string, string> }
export interface UnsupportedApproach { wayId: number; nodeId: number; reason: string; connectedWayId?: number }

/** Surface-only routing must stop before unmodelled portals and closed driveways.
 * Untagged approach pieces inherit the portal only through unbranched access
 * roads; ordinary streets and public junctions remain available. */
export function unsupportedRoadApproaches(elements: readonly Element[], drivable: ReadonlySet<string>): UnsupportedApproach[] {
  const nodes = new Map(elements.filter(e => e.type === 'node').map(e => [e.id, e]));
  const ways = elements.filter(e => e.type === 'way' && e.nodes?.length && drivable.has(e.tags?.['highway'] ?? ''));
  const ferryAtNode = new Map<number, number>();
  for (const way of elements) if (way.type === 'way' && way.tags?.['route'] === 'ferry') {
    for (const node of way.nodes ?? []) ferryAtNode.set(node, way.id);
  }
  const atNode = new Map<number, Element[]>();
  // Closed driveways repeat their first node. Connectivity counts distinct ways,
  // otherwise a loop looks like a two-way junction with no other way to follow.
  for (const way of ways) for (const node of new Set(way.nodes!)) {
    const neighbors = atNode.get(node) ?? []; neighbors.push(way); atNode.set(node, neighbors);
  }
  const excluded = new Map<number, UnsupportedApproach>();
  const undergroundApproaches = new Set<number>();
  const accessBranch = (way: Element) => way.tags?.['highway'] === 'service' || (way.tags?.['foot'] === 'no' && way.tags?.['bicycle'] === 'no');
  const unnamedUnclassified = (way: Element) => way.tags?.['highway'] === 'unclassified' &&
    !Object.entries(way.tags).some(([key, value]) => value && (key === 'name' || key.startsWith('name:') || key === 'ref' || key.startsWith('ref:')));
  const endpoint = (way: Element, id: number) => way.nodes![0] === id || way.nodes!.at(-1) === id;
  for (const [nodeId, connected] of atNode) {
    const tags = nodes.get(nodeId)?.tags ?? {};
    const surfaces = connected.filter(w => isSupportedSurfaceWay(w.tags!));
    const tunnel = connected.find(w => (w.tags?.['tunnel'] && w.tags['tunnel'] !== 'no') || Number(w.tags?.['layer'] ?? 0) < 0);
    for (const way of surfaces) {
      if (!endpoint(way, nodeId)) continue;
      if (tags['amenity'] === 'parking_entrance' && tags['parking'] === 'underground') {
        excluded.set(way.id, { wayId: way.id, nodeId, reason: 'unmodelled underground parking entrance', ...(tunnel ? { connectedWayId: tunnel.id } : {}) });
        undergroundApproaches.add(way.id);
      } else if (ferryAtNode.has(nodeId) && surfaces.length === 1 && way.tags?.['highway'] === 'service' &&
        (tags['ferry'] === 'yes' || tags['amenity'] === 'ferry_terminal')) {
        // A boarding spur ends at a moving/off-map ferry, not a static road deck.
        // Keep public streets and pedestrian access separate from vehicle routing.
        excluded.set(way.id, { wayId: way.id, nodeId, reason: 'isolated boarding approach to unmodelled ferry', connectedWayId: ferryAtNode.get(nodeId)! });
      } else if (tunnel && surfaces.length === 1 && accessBranch(way)) {
        excluded.set(way.id, { wayId: way.id, nodeId, reason: 'isolated approach to unmodelled tunnel or building passage', connectedWayId: tunnel.id });
      }
    }
    // A driveway crossing a source gate/private node is not an open through road.
    if (tags['barrier'] === 'gate' || tags['access'] === 'private') for (const way of surfaces) {
      if (way.tags?.['service'] === 'driveway' && tags['access'] !== 'yes') excluded.set(way.id, { wayId: way.id, nodeId, reason: 'driveway with unmodelled gate or private access' });
    }
  }
  const queue = ways.filter(w => excluded.has(w.id));
  while (queue.length) {
    const current = queue.shift()!;
    for (const nodeId of [current.nodes![0]!, current.nodes!.at(-1)!]) {
      const connected = atNode.get(nodeId)!;
      if (connected.length !== 2) continue;
      const next = connected.find(w => w.id !== current.id)!;
      // Parking ramps are sometimes mapped as unnamed unclassified streets.
      // Leaving such a continuation creates a false dead end and a synthetic
      // U-turn at the cut portal. Inherit only a proven underground terminal;
      // retain named streets and stop at the first real vehicle junction.
      const followsUnderground = undergroundApproaches.has(current.id);
      if (excluded.has(next.id) || !endpoint(next, nodeId) || !isSupportedSurfaceWay(next.tags!) ||
        !(accessBranch(next) || followsUnderground && unnamedUnclassified(next))) continue;
      excluded.set(next.id, { wayId: next.id, nodeId, reason: 'unbranched continuation of unsupported access road', connectedWayId: current.id });
      if (followsUnderground) undergroundApproaches.add(next.id);
      queue.push(next);
    }
  }
  return [...excluded.values()].sort((a, b) => a.wayId - b.wayId);
}
