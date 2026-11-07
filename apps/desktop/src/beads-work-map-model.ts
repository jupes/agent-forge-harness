import type { BeadsDependency } from "../../../types/beads";
import type { ProjectBead } from "../../../types/project-beads";

export const WORK_MAP_LIMITS = {
  beads: 1000,
  graphNodes: 300,
  graphEdges: 2000,
} as const;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export interface WorkMapNode {
  bead: ProjectBead;
  parent: string | null;
  children: string[];
  hierarchyCycle: boolean;
  dependencyCycle: boolean;
  progress: { total: number; closed: number };
  prerequisites: string[];
  dependents: string[];
  related: string[];
}
export interface DiagramNode {
  id: string;
  x: number;
  y: number;
  context: boolean;
  cyclic: boolean;
}
export interface DiagramEdge {
  from: string;
  to: string;
  type: BeadsDependency["type"];
  cyclic: boolean;
}
export interface DependencyDiagram {
  available: boolean;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
  nodeIds: string[];
  nodeCount: number;
  edgeCount: number;
  filteredEdges: number;
  contextCount: number;
}
export interface OutlineRow {
  id: string;
  depth: number;
  context: boolean;
}
export interface BeadWorkMap {
  nodes: Map<string, WorkMapNode>;
  outline: OutlineRow[];
  graphOutline: OutlineRow[];
  matchCount: number;
  problems: string[];
  unavailableBlockers: number;
  graph: DependencyDiagram;
}

/** Scoped tracker relationships only. No execution, path reads, or inferred telemetry. */
export function buildBeadWorkMap(
  rows: readonly ProjectBead[],
  dependencies: readonly BeadsDependency[],
  matches: ReadonlySet<string> = new Set(rows.map((row) => row.id)),
): BeadWorkMap {
  if (rows.length > WORK_MAP_LIMITS.beads)
    throw Error("Work map exceeds the scoped 1000-bead contract");
  if (dependencies.length > 10000)
    throw Error("Work map exceeds the scoped 10000-edge contract");
  const problems: string[] = [],
    duplicate = new Set<string>(),
    byId = new Map<string, ProjectBead>();
  for (const bead of rows) {
    if (byId.has(bead.id)) duplicate.add(bead.id);
    byId.set(bead.id, bead);
  }
  for (const id of duplicate) byId.delete(id);
  if (duplicate.size)
    problems.push(
      `${duplicate.size} duplicate bead identities were omitted; refresh the tracker read.`,
    );
  const ids = [...byId.keys()].sort(compare),
    parents = new Map<string, string | null>(),
    originalChildren = new Map<string, string[]>();
  let missing = 0;
  for (const id of ids) {
    const parent = byId.get(id)!.parent;
    if (parent && !byId.has(parent)) missing++;
    parents.set(id, parent && byId.has(parent) ? parent : null);
    if (parent && byId.has(parent)) {
      const group = originalChildren.get(parent) ?? [];
      group.push(id);
      originalChildren.set(parent, group);
    }
  }
  if (missing)
    problems.push(
      `${missing} parent relationships are unavailable in this scoped read.`,
    );
  const done = new Set<string>(),
    cycles = new Set<string>();
  for (const id of ids) {
    const path: string[] = [],
      indexes = new Map<string, number>();
    let current: string | null = id;
    while (current && !done.has(current)) {
      const seen = indexes.get(current);
      if (seen !== undefined) {
        const members = path.slice(seen).sort(compare);
        for (const member of members) cycles.add(member);
        parents.set(members[0]!, null); // Stable presentation break; the cycle remains explicitly marked.
        break;
      }
      indexes.set(current, path.length);
      path.push(current);
      current = parents.get(current) ?? null;
    }
    for (const member of path) done.add(member);
  }
  if (cycles.size)
    problems.push(
      `${cycles.size} beads have a hierarchy cycle. The outline breaks each cycle for navigation.`,
    );
  const nodes = new Map<string, WorkMapNode>();
  for (const id of ids) {
    const seen = new Set([id]),
      pending = [...(originalChildren.get(id) ?? [])];
    let closed = 0;
    for (let index = 0; index < pending.length; index++) {
      const child = pending[index]!;
      if (seen.has(child)) continue;
      seen.add(child);
      if (byId.get(child)?.status === "closed") closed++;
      pending.push(...(originalChildren.get(child) ?? []));
    }
    nodes.set(id, {
      bead: byId.get(id)!,
      parent: parents.get(id) ?? null,
      children: [],
      hierarchyCycle: cycles.has(id),
      dependencyCycle: false,
      progress: { total: seen.size - 1, closed },
      prerequisites: [],
      dependents: [],
      related: [],
    });
  }
  for (const [id, node] of nodes)
    if (node.parent) nodes.get(node.parent)!.children.push(id);
  const included = new Set<string>();
  for (const id of ids)
    if (matches.has(id)) {
      let current: string | null = id;
      while (current && !included.has(current)) {
        included.add(current);
        current = parents.get(current) ?? null;
      }
    }
  const roots = ids.filter((id) => !parents.get(id)),
    pending = roots
      .slice()
      .reverse()
      .map((id) => ({ id, depth: 0 })),
    outline: OutlineRow[] = [],
    fullOutline: OutlineRow[] = [];
  while (pending.length) {
    const row = pending.pop()!;
    const item = { ...row, context: !matches.has(row.id) };
    fullOutline.push(item);
    if (included.has(row.id)) outline.push(item);
    for (const child of nodes.get(row.id)!.children.slice().reverse())
      pending.push({ id: child, depth: row.depth + 1 });
  }
  const edges = new Map<string, DiagramEdge>();
  let unavailable = 0;
  for (const edge of dependencies) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      unavailable++;
      continue;
    }
    const [from, to] =
      edge.type === "relates"
        ? [edge.from, edge.to].sort(compare)
        : [edge.to, edge.from];
    edges.set(JSON.stringify([edge.type, from, to]), {
      from: from!,
      to: to!,
      type: edge.type,
      cyclic: false,
    });
  }
  if (unavailable)
    problems.push(
      `${unavailable} dependency relationships have unavailable endpoints in this scoped read.`,
    );
  const allEdges = [...edges.values()].sort((a, b) =>
    compare(`${a.from}\0${a.to}\0${a.type}`, `${b.from}\0${b.to}\0${b.type}`),
  );
  for (const edge of allEdges) {
    if (edge.type === "relates") {
      nodes.get(edge.from)!.related.push(edge.to);
      if (edge.from !== edge.to) nodes.get(edge.to)!.related.push(edge.from);
    } else {
      nodes.get(edge.to)!.prerequisites.push(edge.from);
      nodes.get(edge.from)!.dependents.push(edge.to);
    }
  }
  for (const node of nodes.values()) {
    node.prerequisites = [...new Set(node.prerequisites)].sort(compare);
    node.dependents = [...new Set(node.dependents)].sort(compare);
    node.related = [...new Set(node.related)].sort(compare);
  }
  const allComponents = stronglyConnected(ids, allEdges);
  for (const members of allComponents.components)
    if (members.length > 1)
      for (const id of members) nodes.get(id)!.dependencyCycle = true;
  for (const edge of allEdges)
    if (edge.type !== "relates" && edge.from === edge.to)
      nodes.get(edge.from)!.dependencyCycle = true;
  const graph = dependencyDiagram(ids, allEdges, matches);
  const graphIncluded = new Set(graph.nodeIds);
  for (const id of graph.nodeIds) {
    let parent = parents.get(id);
    while (parent && !graphIncluded.has(parent)) {
      graphIncluded.add(parent);
      parent = parents.get(parent);
    }
  }
  const graphOutline = fullOutline.filter((row) => graphIncluded.has(row.id));
  for (const node of graph.nodes)
    node.cyclic = nodes.get(node.id)!.dependencyCycle;
  return {
    nodes,
    outline,
    graphOutline,
    graph,
    matchCount: ids.filter((id) => matches.has(id)).length,
    problems,
    unavailableBlockers: ids.reduce(
      (count, id) => count + byId.get(id)!.unavailableBlockers,
      0,
    ),
  };
}

/** SCC condensation is iterative so long chains and rootless cycles never recurse. */
function dependencyDiagram(
  ids: string[],
  allEdges: DiagramEdge[],
  matches: ReadonlySet<string>,
): DependencyDiagram {
  const included = new Set(ids.filter((id) => matches.has(id)));
  for (const edge of allEdges)
    if (matches.has(edge.from) || matches.has(edge.to)) {
      included.add(edge.from);
      included.add(edge.to);
    }
  const selected = ids.filter((id) => included.has(id)),
    edges = allEdges.filter(
      (edge) => included.has(edge.from) && included.has(edge.to),
    );
  const base = {
    nodeIds: selected,
    nodeCount: selected.length,
    edgeCount: edges.length,
    filteredEdges: allEdges.length - edges.length,
    contextCount: selected.filter((id) => !matches.has(id)).length,
  };
  if (
    selected.length > WORK_MAP_LIMITS.graphNodes ||
    edges.length > WORK_MAP_LIMITS.graphEdges
  )
    return {
      ...base,
      available: false,
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    };
  const { components, componentOf } = stronglyConnected(selected, edges);
  const cyclic = new Set(
    components.flatMap((members) => (members.length > 1 ? members : [])),
  );
  for (const edge of edges)
    if (edge.type !== "relates" && edge.from === edge.to) cyclic.add(edge.from);
  const next = components.map(() => new Set<number>()),
    incoming = components.map(() => 0),
    level = components.map(() => 0);
  for (const edge of edges)
    if (edge.type !== "relates") {
      const from = componentOf.get(edge.from)!,
        to = componentOf.get(edge.to)!;
      if (from !== to && !next[from]!.has(to)) {
        next[from]!.add(to);
        incoming[to] = incoming[to]! + 1;
      }
      edge.cyclic = from === to && cyclic.has(edge.from);
    }
  const pending = components
    .map((_, index) => index)
    .filter((index) => incoming[index] === 0);
  while (pending.length) {
    pending.sort((a, b) => compare(components[a]![0]!, components[b]![0]!));
    const current = pending.shift()!;
    for (const child of next[current]!) {
      level[child] = Math.max(level[child]!, level[current]! + 1);
      incoming[child] = incoming[child]! - 1;
      if (incoming[child] === 0) pending.push(child);
    }
  }
  const ranks = new Map<number, string[]>();
  for (const id of selected) {
    const rank = level[componentOf.get(id)!]!,
      group = ranks.get(rank) ?? [];
    group.push(id);
    ranks.set(rank, group);
  }
  const nodes = selected.map((id) => {
    const rank = level[componentOf.get(id)!]!,
      row = ranks.get(rank)!.indexOf(id);
    return {
      id,
      x: 24 + rank * 328,
      y: 24 + row * 120,
      context: !matches.has(id),
      cyclic: cyclic.has(id),
    };
  });
  return {
    ...base,
    available: true,
    nodes,
    edges,
    width: Math.max(360, ...nodes.map((node) => node.x + 352)),
    height: Math.max(160, ...nodes.map((node) => node.y + 104)),
  };
}

/** Flat traversal avoids recursive render/stack limits on deeply nested trackers. */
export function visibleBeadOutline(
  map: BeadWorkMap,
  collapsed: ReadonlySet<string>,
): OutlineRow[] {
  const result: OutlineRow[] = [];
  let hiddenBelow: number | null = null;
  for (const row of map.outline) {
    if (hiddenBelow !== null && row.depth > hiddenBelow) continue;
    hiddenBelow = collapsed.has(row.id) ? row.depth : null;
    result.push(row);
  }
  return result;
}

function stronglyConnected(ids: string[], edges: DiagramEdge[]) {
  const forward = new Map(ids.map((id) => [id, [] as string[]])),
    reverse = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges)
    if (edge.type !== "relates") {
      forward.get(edge.from)!.push(edge.to);
      reverse.get(edge.to)!.push(edge.from);
    }
  const seen = new Set<string>(),
    finished: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stack = [{ id, next: 0 }];
    while (stack.length) {
      const frame = stack.at(-1)!,
        adjacent = forward.get(frame.id)!;
      if (frame.next < adjacent.length) {
        const child = adjacent[frame.next++]!;
        if (!seen.has(child)) {
          seen.add(child);
          stack.push({ id: child, next: 0 });
        }
      } else {
        finished.push(frame.id);
        stack.pop();
      }
    }
  }
  const components: string[][] = [],
    componentOf = new Map<string, number>();
  for (const id of finished.slice().reverse()) {
    if (componentOf.has(id)) continue;
    const index = components.length,
      members: string[] = [],
      stack = [id];
    componentOf.set(id, index);
    while (stack.length) {
      const item = stack.pop()!;
      members.push(item);
      for (const parent of reverse.get(item)!)
        if (!componentOf.has(parent)) {
          componentOf.set(parent, index);
          stack.push(parent);
        }
    }
    components.push(members.sort(compare));
  }
  return { components, componentOf };
}
