import { describe, expect, test } from "bun:test";
import { checkpointsForEpic } from "../../docs/js/forge-checkpoints";
import type {
  BeadsDependency,
  BeadsIssue,
  BeadsPayload,
} from "../../types/beads";

function issue(over: Partial<BeadsIssue> & { id: string }): BeadsIssue {
  return {
    type: "task",
    title: `Title ${over.id}`,
    status: "open",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  } as BeadsIssue;
}

function payload(issues: BeadsIssue[], deps: BeadsDependency[] = []) {
  return { issues, deps, comments: [] } as unknown as BeadsPayload;
}

const EPIC = issue({ id: "epic", type: "epic", title: "The epic" });
const FEATURE = issue({
  id: "feat",
  type: "feature",
  title: "Foundations",
  parent: "epic",
});

describe("checkpointsForEpic", () => {
  test("collects leaf issues through features, not the containers", () => {
    const summary = checkpointsForEpic(
      payload([
        EPIC,
        FEATURE,
        issue({ id: "t1", parent: "feat" }),
        issue({ id: "t2", parent: "feat" }),
        issue({ id: "elsewhere" }),
      ]),
      "epic",
    );
    expect(summary.checkpoints.map((c) => c.id).sort()).toEqual(["t1", "t2"]);
    expect(summary.checkpoints[0]?.groupTitle).toBe("Foundations");
  });

  test("treats a task with subtasks as a container", () => {
    // agent-forge-harness-t1b1.2.2 is a task whose four subtasks are the work.
    const summary = checkpointsForEpic(
      payload([
        EPIC,
        issue({ id: "parent-task", parent: "epic" }),
        issue({ id: "sub-1", parent: "parent-task" }),
        issue({ id: "sub-2", parent: "parent-task" }),
      ]),
      "epic",
    );
    expect(summary.checkpoints.map((c) => c.id).sort()).toEqual([
      "sub-1",
      "sub-2",
    ]);
  });

  test("orders checkpoints by their blocking dependencies", () => {
    const summary = checkpointsForEpic(
      payload(
        [
          EPIC,
          FEATURE,
          issue({ id: "a-last", parent: "feat" }),
          issue({ id: "b-first", parent: "feat" }),
          issue({ id: "c-middle", parent: "feat" }),
        ],
        [
          { from: "c-middle", to: "b-first", type: "blocks" },
          { from: "a-last", to: "c-middle", type: "blocks" },
        ],
      ),
      "epic",
    );
    expect(summary.checkpoints.map((c) => c.id)).toEqual([
      "b-first",
      "c-middle",
      "a-last",
    ]);
  });

  test("lists only blockers that are still open", () => {
    const summary = checkpointsForEpic(
      payload(
        [
          EPIC,
          FEATURE,
          issue({ id: "done", parent: "feat", status: "closed" }),
          issue({ id: "wip", parent: "feat", status: "in_progress" }),
          issue({ id: "waiting", parent: "feat" }),
        ],
        [
          { from: "waiting", to: "done", type: "blocks" },
          { from: "waiting", to: "wip", type: "blocks" },
        ],
      ),
      "epic",
    );
    const waiting = summary.checkpoints.find((c) => c.id === "waiting");
    expect(waiting?.blockedBy).toEqual(["wip"]);
  });

  test("the active checkpoint is the one in progress", () => {
    const summary = checkpointsForEpic(
      payload([
        EPIC,
        FEATURE,
        issue({ id: "t1", parent: "feat", status: "closed" }),
        issue({ id: "t2", parent: "feat", status: "in_progress" }),
        issue({ id: "t3", parent: "feat" }),
      ]),
      "epic",
    );
    expect(summary.activeId).toBe("t2");
    expect(summary.done).toBe(1);
    expect(summary.total).toBe(3);
  });

  test("otherwise it is the first open checkpoint with nothing blocking it", () => {
    const summary = checkpointsForEpic(
      payload(
        [
          EPIC,
          FEATURE,
          issue({ id: "t1", parent: "feat", status: "closed" }),
          issue({ id: "t2", parent: "feat" }),
          issue({ id: "t3", parent: "feat" }),
        ],
        [{ from: "t3", to: "t2", type: "blocks" }],
      ),
      "epic",
    );
    expect(summary.activeId).toBe("t2");
  });

  test("a finished run has no active checkpoint", () => {
    const summary = checkpointsForEpic(
      payload([
        EPIC,
        FEATURE,
        issue({ id: "t1", parent: "feat", status: "closed" }),
      ]),
      "epic",
    );
    expect(summary.activeId).toBeNull();
    expect(summary.done).toBe(1);
  });

  test("a dependency cycle still lists every checkpoint", () => {
    const summary = checkpointsForEpic(
      payload(
        [
          EPIC,
          FEATURE,
          issue({ id: "x", parent: "feat" }),
          issue({ id: "y", parent: "feat" }),
        ],
        [
          { from: "x", to: "y", type: "blocks" },
          { from: "y", to: "x", type: "blocks" },
        ],
      ),
      "epic",
    );
    expect(summary.checkpoints.map((c) => c.id).sort()).toEqual(["x", "y"]);
  });

  test("is empty without a snapshot, an epic, or an epic in the snapshot", () => {
    expect(checkpointsForEpic(null, "epic").total).toBe(0);
    expect(checkpointsForEpic(payload([EPIC]), null).total).toBe(0);
    expect(checkpointsForEpic(payload([EPIC]), "missing").total).toBe(0);
  });
});
