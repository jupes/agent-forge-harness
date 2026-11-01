import { expect, test } from "bun:test";
import type { BeadWriteNotice } from "./bead-writes-client";
import { readInboxWriteSources } from "./inbox-write-source";

const notice: BeadWriteNotice = {
  key: "write-unknown-1",
  projectId: "project-alpha",
  workspace: "C:/work/alpha",
  action: "comment",
  beadId: "alpha-1",
  title: "Reviewed task",
  createdId: null,
  stage: "write",
  phase: "unknown",
  message: "Outcome unknown; check the bead.",
};
const projects = [
  {
    id: "project-alpha",
    name: "Alpha",
    archived: false,
    workspaces: [{ root: "C:/work/alpha" }],
  },
];
const page = (patch: Record<string, unknown> = {}) => ({
  projectId: "project-alpha",
  workspace: "C:/work/alpha",
  asOf: "2026-10-31T12:00:00.000Z",
  complete: true,
  problems: [],
  beads: [],
  dependencies: [],
  ...patch,
});
const bead = {
  id: "alpha-1",
  title: "Task",
  type: "task",
  status: "open",
  priority: 2,
  parent: null,
  assignee: null,
  owner: null,
  labels: [],
  createdAt: "2026-10-31T12:00:00.000Z",
  updatedAt: "2026-10-31T12:00:00.000Z",
  due: null,
  description: "",
  acceptanceCriteria: "",
  estimate: null,
  spent: null,
  ready: true,
  blocked: false,
  blockers: [],
  unavailableBlockers: 0,
  queue: null,
  smith: null,
  comments: [],
  commentsComplete: true,
  detailsLoaded: true,
  fileMap: null,
  fileMapReason: null,
  reservations: null,
  activity: null,
  activityComplete: true,
};

test("a fresh exact bead read adds check context but never resolves an unknown write", async () => {
  let reads = 0;
  const snapshot = await readInboxWriteSources({
    notices: [notice],
    projects,
    observedAt: "2026-10-31T12:00:01.000Z",
    read: async (path) => {
      reads++;
      expect(path).toBe("/projects/project-alpha/beads");
      return page();
    },
  });
  expect(reads).toBe(1);
  expect(snapshot.membership.get(notice.key)).toBe(false);
  const noticeCard = snapshot.cards.find((item) => item.notice);
  const actionCard = snapshot.cards.find((item) => !item.notice);
  expect(noticeCard?.sourceState).toBe("current");
  expect(noticeCard?.resolved).toBe(false);
  expect(noticeCard?.canSnooze).toBe(false);
  expect(noticeCard?.canCheck).toBe(true);
  expect(noticeCard?.stableItemId).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(noticeCard?.stableItemId.length).toBeLessThanOrEqual(200);
  expect(actionCard).toMatchObject({
    sourceState: "current",
    resolved: false,
    canSnooze: true,
    canCheck: false,
    notice: false,
  });
  expect(actionCard?.stableItemId).toBe(noticeCard?.stableItemId);
  expect(actionCard?.sourceRevision).toBe(noticeCard?.sourceRevision);
});

test("current membership still does not resolve the original unknown effect", async () => {
  const snapshot = await readInboxWriteSources({
    notices: [notice],
    projects,
    read: async () => page({ beads: [bead] }),
  });
  expect(snapshot.membership.get(notice.key)).toBe(true);
  expect(snapshot.cards[0]?.resolved).toBe(false);
  expect(snapshot.cards[0]?.detail).toContain("does not confirm this write");
});

test("wrong-scope, incomplete, or failed reads keep the notice visible and unverified", async () => {
  for (const read of [
    async () => page({ workspace: "C:/work/other" }),
    async () => page({ complete: false }),
    async () => {
      throw Error("source unavailable");
    },
  ]) {
    const snapshot = await readInboxWriteSources({
      notices: [notice],
      projects,
      read,
    });
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0]?.sourceState).toBe("unavailable");
    expect(snapshot.cards[0]?.resolved).toBe(false);
    expect(snapshot.cards[0]?.canSnooze).toBe(false);
    expect(snapshot.cards[0]?.canCheck).toBe(true);
  }
});

test("scope mismatch retains an unavailable notice without reading a foreign project", async () => {
  let reads = 0;
  const snapshot = await readInboxWriteSources({
    notices: [
      { ...notice, phase: "sending" },
      { ...notice, workspace: "C:/work/foreign" },
    ],
    projects,
    read: async () => {
      reads++;
      return page();
    },
  });
  expect(reads).toBe(0);
  expect(snapshot.cards).toHaveLength(1);
  expect(snapshot.cards[0]).toMatchObject({
    notice: true,
    sourceState: "unavailable",
    resolved: false,
    canSnooze: false,
    canCheck: true,
  });
  expect(snapshot.coverage).toEqual([
    expect.objectContaining({
      sourceKind: "unknown-bead-write",
      state: "unavailable",
    }),
  ]);
});
