export interface TreePlacement {
  id: string;
  colliderHeight: number;
  [key: string]: unknown;
}

/** Keep accepted scenery and trunk policy while extending the surrounding road graph. */
export function preserveTreePlacements<T extends TreePlacement>(previous: readonly T[], expanded: readonly T[]) {
  const next = new Map(expanded.map(tree => [tree.id, tree]));
  if (next.size !== expanded.length || new Set(previous.map(tree => tree.id)).size !== previous.length) throw new Error('duplicate tree ID');
  const preserved = new Set<string>(), colliderOverrides: string[] = [];
  for (const tree of previous) {
    const candidate = next.get(tree.id);
    if (!candidate) throw new Error(`expanded source omits accepted tree ${tree.id}`);
    const keys = new Set([...Object.keys(tree), ...Object.keys(candidate)]);
    for (const key of keys) if (key !== 'colliderHeight' && JSON.stringify(tree[key]) !== JSON.stringify(candidate[key])) throw new Error(`accepted tree ${tree.id}: ${key} changed`);
    if (tree.colliderHeight !== candidate.colliderHeight) colliderOverrides.push(tree.id);
    preserved.add(tree.id);
  }
  return {trees:[...previous, ...expanded.filter(tree => !preserved.has(tree.id))], colliderOverrides};
}
