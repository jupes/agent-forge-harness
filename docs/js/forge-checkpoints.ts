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
  /**
   * Issues this checkpoint still waits on. Closed blockers drop out; a blocker
   * the snapshot does not hold stays, since nothing says it is done.
   */
  blockedBy: string[];
}

/**
 * Where a run stands. Explicit, so that "nothing to act on right now" is never
 * read as "finished":
 *
 * - `complete` — every checkpoint is closed.
 * - `in-progress` — at least one checkpoint is being worked on.
 * - `ready` — nothing is in progress, and a checkpoint can be started.
 * - `waiting` — work remains, but none of it is in progress or can start.
 * - `empty` — the epic has no checkpoints in the snapshot.
 */
export type RunState =
  | "empty"
  | "complete"
  | "in-progress"
  | "ready"
  | "waiting";

export interface CheckpointSummary {
  checkpoints: Checkpoint[];
  done: number;
  total: number;
  state: RunState;
  /**
   * Checkpoints being worked on, in run order. Only these can be reviewed: a
   * checkpoint nobody has claimed has nothing to approve yet.
   */
  inProgressIds: string[];
  /** The first open checkpoint nothing blocks. Shown as next; never reviewable. */
  nextReadyId: string | null;
  /**
   * For a waiting run, what its remaining checkpoints wait on from outside the
   * run. Blockers that are themselves remaining checkpoints are left out, so
   * this names the cause rather than the queue behind it.
   */
  waitingOn: string[];
}

const EMPTY: CheckpointSummary = {
  checkpoints: [],
  done: 0,
  total: 0,
  state: "empty",
  inProgressIds: [],
  nextReadyId: null,
  waitingOn: [],
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
  const blockers = new Map<string, string[]>();
  const incoming = new Map<string, number>(leaves.map((leaf) => [leaf.id, 0]));
  const outgoing = new Map<string, string[]>();
  const edges = new Set<string>();
  for (const dep of payload.deps ?? []) {
    if (
      !BLOCKING.has(dep.type) ||
      !leafIds.has(dep.from) ||
      dep.to === dep.from
    ) {
      continue;
    }
    if (byId.get(dep.to)?.status !== "closed") {
      const list = blockers.get(dep.from) ?? [];
      if (!list.includes(dep.to)) list.push(dep.to);
      blockers.set(dep.from, list);
    }
    // Ordering only considers edges between checkpoints of this run.
    const key = `${dep.to}->${dep.from}`;
    if (!leafIds.has(dep.to) || edges.has(key)) continue;
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

  const total = checkpoints.length;
  const done = checkpoints.filter((c) => c.status === "closed").length;
  const inProgressIds = checkpoints
    .filter((c) => c.status === "in_progress")
    .map((c) => c.id);
  const nextReadyId =
    checkpoints.find((c) => c.status === "open" && c.blockedBy.length === 0)
      ?.id ?? null;

  const state: RunState =
    total === 0
      ? "empty"
      : done === total
        ? "complete"
        : inProgressIds.length > 0
          ? "in-progress"
          : nextReadyId !== null
            ? "ready"
            : "waiting";

  const remaining = new Set(
    checkpoints.filter((c) => c.status !== "closed").map((c) => c.id),
  );
  const waitingOn =
    state === "waiting"
      ? [
          ...new Set(
            checkpoints
              .flatMap((c) => (remaining.has(c.id) ? c.blockedBy : []))
              .filter((id) => !remaining.has(id)),
          ),
        ]
      : [];

  return {
    checkpoints,
    done,
    total,
    state,
    inProgressIds,
    nextReadyId,
    waitingOn,
  };
}
