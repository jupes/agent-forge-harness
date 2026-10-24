import { expect, test } from "bun:test";
import {
  briefAge,
  briefFollowup,
  briefHeadline,
  KeeperBriefCard,
} from "../../apps/desktop/src/KeeperBrief";
import { createKeeperClient } from "../../apps/desktop/src/keeper-client";
import type { KeeperBrief } from "../../types/keeper-brief";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const at = "2026-10-22T12:00:00.000Z";
const brief: KeeperBrief = {
  requestId: "1a5832fa-7a21-403b-8184-44892f0d8d86",
  createdAt: at,
  snapshot: {
    version: 1,
    projectId: "alpha",
    projectName: "Alpha",
    workspace: "/fixture",
    catalogRevision: 3,
    asOf: at,
    since: "2026-10-21T12:00:00.000Z",
    scope: {
      label: "project:alpha",
      epicIds: ["alpha-epic"],
      epicCount: 1,
      repositoryCount: 1,
    },
    observed: { beads: 1, queue: null, sessions: null, runs: 0, activity: 1 },
    complete: false,
    limitations: ["Queue is unavailable."],
    facts: [
      {
        section: "moving",
        object: { kind: "bead", id: "alpha-epic" },
        title: "Actual movement",
        state: "bead:closed",
        at,
      },
    ],
  },
  content: {
    summary: "A recorded change <script> is plain text.",
    moving: [{ text: "Closed the scoped bead.", facts: [0, 0] }],
    waiting: [],
    stuck: [],
  },
};

test("brief age uses source time, marks an old brief and never invents a negative age", () => {
  expect(briefAge(at, Date.parse(at) - 1000)).toBe("just now");
  expect(briefAge(at, Date.parse(at) + 7 * 60_000)).toBe("7 minutes ago");
  expect(briefAge(at, Date.parse(at) + 3 * 3600_000)).toBe(
    "3 hours ago · older brief",
  );
  expect(briefFollowup(brief)).toContain(
    `Brief as of ${at} · project:alpha\n> A recorded change`,
  );
  expect(briefFollowup(brief)).toContain("> moving: Closed the scoped bead.");
  expect(briefHeadline("Two beads moved. One is waiting.")).toBe(
    "Two beads moved.",
  );
  expect(briefHeadline("Read at 09:12:00.123Z\nMore detail")).toBe(
    "Read at 09:12:00.123Z",
  );
});

test("the brief card retains source limitations, distinguishes unknown from zero, and links only actual evidence", () => {
  const client = createKeeperClient({
    canWrite: () => false,
    requestId: () => brief.requestId,
    read: async () => null,
    post: async () => ({ state: "refused", message: "No provider" }),
    stream: () => () => ({ close() {} }),
  });
  const card = KeeperBriefCard({ brief, client });
  const text = textOf(card);
  expect(text).toContain("— unavailable queue");
  expect(text).toContain("0 runs");
  expect(text).toContain("Source scope and limitations · incomplete");
  expect(text).toContain("Queue is unavailable.");
  expect(findAll(card, "script")).toHaveLength(0);
  const links = findAll(card, "a");
  expect(links).toHaveLength(1);
  expect(attrs(links[0]!).href).toContain("selectionId=alpha-epic");
  client.dispose();
});
