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

describe("checkpointsForEpic: which issues are checkpoints", () => {
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

  test("is empty without a snapshot, an epic, or an epic in the snapshot", () => {
    expect(checkpointsForEpic(null, "epic").state).toBe("empty");
    expect(checkpointsForEpic(payload([EPIC]), null).state).toBe("empty");
    expect(checkpointsForEpic(payload([EPIC]), "missing").total).toBe(0);
    expect(checkpointsForEpic(payload([EPIC]), "epic").state).toBe("empty");
  });
});

describe("checkpointsForEpic: blockers", () => {
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

  test("keeps a blocker the snapshot does not hold, since nothing says it is done", () => {
    const summary = checkpointsForEpic(
      payload(
        [EPIC, FEATURE, issue({ id: "t1", parent: "feat" })],
        [{ from: "t1", to: "other-repo-9", type: "blocks" }],
      ),
      "epic",
    );
    expect(summary.checkpoints[0]?.blockedBy).toEqual(["other-repo-9"]);
    expect(summary.nextReadyId).toBeNull();
  });
});

describe("checkpointsForEpic: run state and what can be reviewed", () => {
  test("only in-progress checkpoints are reviewable", () => {
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
    expect(summary.state).toBe("in-progress");
    expect(summary.inProgressIds).toEqual(["t2"]);
    // t3 could be started, which makes it next — not something to approve.
    expect(summary.nextReadyId).toBe("t3");
    expect(summary.done).toBe(1);
    expect(summary.total).toBe(3);
  });

  test("lists every in-progress checkpoint, in run order", () => {
    const summary = checkpointsForEpic(
      payload(
        [
          EPIC,
          FEATURE,
          issue({ id: "t2", parent: "feat", status: "in_progress" }),
          issue({ id: "t1", parent: "feat", status: "in_progress" }),
        ],
        [{ from: "t2", to: "t1", type: "blocks" }],
      ),
      "epic",
    );
    expect(summary.inProgressIds).toEqual(["t1", "t2"]);
  });

  test("an unstarted run is ready, with nothing to review", () => {
    // Regression: the first open, unblocked checkpoint used to be treated as
    // active and offered for approval before anyone had claimed it.
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
    expect(summary.state).toBe("ready");
    expect(summary.inProgressIds).toEqual([]);
    expect(summary.nextReadyId).toBe("t2");
  });

  test("remaining work that nothing can start is waiting, not complete", () => {
    // Regression: 0 of 1 with its only checkpoint blocked read as complete.
    const summary = checkpointsForEpic(
      payload(
        [
          EPIC,
          FEATURE,
          issue({ id: "t1", parent: "feat" }),
          issue({ id: "outside" }),
        ],
        [{ from: "t1", to: "outside", type: "blocks" }],
      ),
      "epic",
    );
    expect(summary.done).toBe(0);
    expect(summary.total).toBe(1);
    expect(summary.state).toBe("waiting");
    expect(summary.waitingOn).toEqual(["outside"]);
    expect(summary.inProgressIds).toEqual([]);
    expect(summary.nextReadyId).toBeNull();
  });

  test("a checkpoint marked blocked, with no blocker recorded, is waiting too", () => {
    const summary = checkpointsForEpic(
      payload([
        EPIC,
        FEATURE,
        issue({ id: "t1", parent: "feat", status: "blocked" }),
      ]),
      "epic",
    );
    expect(summary.state).toBe("waiting");
    expect(summary.waitingOn).toEqual([]);
  });

  test("waitingOn names what blocks the run from outside, not the queue behind it", () => {
    const summary = checkpointsForEpic(
      payload(
        [
          EPIC,
          FEATURE,
          issue({ id: "t1", parent: "feat" }),
          issue({ id: "t2", parent: "feat" }),
          issue({ id: "outside" }),
        ],
        [
          { from: "t1", to: "outside", type: "blocks" },
          { from: "t2", to: "t1", type: "blocks" },
        ],
      ),
      "epic",
    );
    expect(summary.state).toBe("waiting");
    expect(summary.waitingOn).toEqual(["outside"]);
  });

  test("a dependency cycle still lists every checkpoint, and is waiting", () => {
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
    expect(summary.state).toBe("waiting");
    expect(summary.waitingOn).toEqual([]);
  });

  test("complete means every checkpoint is closed", () => {
    const summary = checkpointsForEpic(
      payload([
        EPIC,
        FEATURE,
        issue({ id: "t1", parent: "feat", status: "closed" }),
        issue({ id: "t2", parent: "feat", status: "closed" }),
      ]),
      "epic",
    );
    expect(summary.state).toBe("complete");
    expect(summary.done).toBe(2);
    expect(summary.inProgressIds).toEqual([]);
    expect(summary.nextReadyId).toBeNull();
  });
});
