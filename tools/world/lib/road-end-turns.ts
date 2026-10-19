interface SourceElement { type: string; id: number; nodes?: readonly number[]; tags?: Record<string,string> }
interface RetainedWay { id: number; nodes: readonly number[] }
export interface SourceCutRoadEnd { nodeId: number; retainedWayId: number; unsupportedWayIds: number[] }

/** A clipped bridge/tunnel approach is not a source turning circle. Restrict
 * this proof to explicitly unsupported continuations; access filtering alone
 * must not change how an otherwise genuine road end is classified. */
export function sourceCutRoadEnds(elements: readonly SourceElement[], drivable: ReadonlySet<string>, retainedWays: readonly RetainedWay[], unsupportedWayIds: ReadonlySet<number>): SourceCutRoadEnd[] {
  const retainedAt = new Map<number,Set<number>>(), unsupportedAt = new Map<number,Set<number>>();
  const retainedIds = new Set(retainedWays.map(way=>way.id));
  for (const way of retainedWays) for (const node of new Set(way.nodes)) {
    const ids=retainedAt.get(node)??new Set<number>();ids.add(way.id);retainedAt.set(node,ids);
  }
  for (const way of elements) {
    if (way.type!=='way'||!way.nodes?.length||!unsupportedWayIds.has(way.id)||retainedIds.has(way.id)||
      !drivable.has(way.tags?.highway??'')||way.tags?.area==='yes') continue;
    for (const node of new Set(way.nodes)) {
      const ids=unsupportedAt.get(node)??new Set<number>();ids.add(way.id);unsupportedAt.set(node,ids);
    }
  }
  return [...retainedAt].filter(([node,ids])=>ids.size===1&&unsupportedAt.has(node))
    .map(([node,ids])=>({nodeId:node,retainedWayId:[...ids][0]!,unsupportedWayIds:[...unsupportedAt.get(node)!].sort((a,b)=>a-b)}))
    .sort((a,b)=>a.nodeId-b.nodeId);
}
