/**
 * The checkpoints of a Forge run, derived from the Beads snapshot.
 *
 * A checkpoint is a leaf issue under the run's epic — anything with children
 * (features, or a task that was split into subtasks) is a container, not a
 * checkpoint. Order follows `blocks`/`requires` edges, which is how the plan
 * phase sequences them.
 */

import type { BeadsIssue, BeadsPayload, IssueStatus } from "../../types/beads";

export interface Checkpoint {
  id: string;
  title: string;
  status: IssueStatus;
  /** The container this checkpoint sits under (a feature, or the epic). */
  groupId: string;
  groupTitle: string;
  /** Issues this checkpoint is still waiting on — closed blockers drop out. */
  blockedBy: string[];
}

export interface CheckpointSummary {
  checkpoints: Checkpoint[];
  done: number;
  total: number;
  /** In progress if anything is; otherwise the first open, unblocked one. */
  activeId: string | null;
}

const EMPTY: CheckpointSummary = {
  checkpoints: [],
  done: 0,
  total: 0,
  activeId: null,
};

const BLOCKING = new Set(["blocks", "requires"]);

export function checkpointsForEpic(
  payload: BeadsPayload | null,
  epicId: string | null,
): CheckpointSummary {
  if (!payload || !epicId) return EMPTY;
  const issues = payload.issues ?? [];
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  if (!byId.has(epicId)) return EMPTY;

  const childrenOf = new Map<string, BeadsIssue[]>();
  for (const issue of issues) {
    if (!issue.parent) continue;
    const siblings = childrenOf.get(issue.parent) ?? [];
    siblings.push(issue);
    childrenOf.set(issue.parent, siblings);
  }

  const leaves: BeadsIssue[] = [];
  const seen = new Set<string>([epicId]);
  const queue = [epicId];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const child of childrenOf.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if ((childrenOf.get(child.id) ?? []).length > 0) queue.push(child.id);
      else leaves.push(child);
    }
  }

  const leafIds = new Set(leaves.map((leaf) => leaf.id));
  const deps = payload.deps ?? [];

  const blockers = new Map<string, string[]>();
  const incoming = new Map<string, number>(leaves.map((leaf) => [leaf.id, 0]));
  const outgoing = new Map<string, string[]>();
  const edges = new Set<string>();
  for (const dep of deps) {
    if (!BLOCKING.has(dep.type) || !leafIds.has(dep.from)) continue;
    const blocker = byId.get(dep.to);
    if (blocker && blocker.status !== "closed") {
      const list = blockers.get(dep.from) ?? [];
      if (!list.includes(dep.to)) list.push(dep.to);
      blockers.set(dep.from, list);
    }
    // Ordering only considers edges between checkpoints of this run.
    const key = `${dep.to}->${dep.from}`;
    if (!leafIds.has(dep.to) || dep.to === dep.from || edges.has(key)) continue;
    edges.add(key);
    outgoing.set(dep.to, [...(outgoing.get(dep.to) ?? []), dep.from]);
    incoming.set(dep.from, (incoming.get(dep.from) ?? 0) + 1);
  }

  const ready = leaves
    .filter((leaf) => incoming.get(leaf.id) === 0)
    .map((leaf) => leaf.id)
    .sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  // A dependency cycle must not hide work; list it after everything ordered.
  for (const id of [...leafIds].sort()) {
    if (!ordered.includes(id)) ordered.push(id);
  }

  const checkpoints = ordered.map((id): Checkpoint => {
    const issue = byId.get(id) as BeadsIssue;
    const groupId = issue.parent ?? epicId;
    return {
      id,
      title: issue.title,
      status: issue.status,
      groupId,
      groupTitle: byId.get(groupId)?.title ?? "",
      blockedBy: blockers.get(id) ?? [],
    };
  });

  const active =
    checkpoints.find((checkpoint) => checkpoint.status === "in_progress") ??
    checkpoints.find(
      (checkpoint) =>
        checkpoint.status === "open" && checkpoint.blockedBy.length === 0,
    ) ??
    null;

  return {
    checkpoints,
    done: checkpoints.filter((checkpoint) => checkpoint.status === "closed")
      .length,
    total: checkpoints.length,
    activeId: active?.id ?? null,
  };
}
