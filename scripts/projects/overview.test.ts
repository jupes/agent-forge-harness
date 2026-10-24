import { expect, test } from "bun:test";
import type { BeadsIssue } from "../../types/beads";
import type { LedgerEvent } from "../../types/hearth";
import { buildProjectOverview } from "./overview";
import { projectFixture } from "./testing";

const project = projectFixture("/fixture");
const issues: BeadsIssue[] = [
  {
    id: "alpha-epic",
    title: "Epic",
    type: "epic",
    status: "open",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    labels: ["project:alpha"],
  },
  {
    id: "member",
    title: "Member",
    type: "task",
    parent: "alpha-epic",
    status: "closed",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    labels: ["project:alpha"],
  },
];
const sources = {
  workspace: "/fixture",
  asOf: "2026-10-22T12:00:00.000Z",
  issues,
  queue: [],
  sessions: [],
  sessionsComplete: true,
  problems: [],
};
const close = (id: number, beadId: string, ts: string): LedgerEvent => ({
  id,
  ulid: `fixture-${id}`,
  kind: "bead.transitioned",
  workspace: "/fixture",
  beadId,
  ts,
  payload: { action: "close" },
});

test("overview counts stay available when history is missing and scoped epics include real descendants", () => {
  const overview = buildProjectOverview(project, sources, {
    events: null,
    more: false,
    reservations: null,
    shifts: null,
  });
  expect(overview.summary.beads?.closed).toBe(1);
  expect(overview.epics).toEqual([
    { id: "alpha-epic", title: "Epic", closed: 1, total: 2 },
  ]);
  expect(overview.throughput.data).toBeNull();
  expect(overview.usage.data).toBeNull();
});

test("session read failure does not erase independent tracker counts", () => {
  const overview = buildProjectOverview(
    project,
    {
      ...sources,
      sessionsComplete: false,
      problems: ["Session observations are unavailable."],
    },
    { events: null, more: false, reservations: null, shifts: null },
  );
  expect(overview.summary.beads?.closed).toBe(1);
  expect(overview.summary.sessionsComplete).toBe(false);
});

test("30 UTC days count recorded closures once per bead/day and exclude foreign or future events", () => {
  const overview = buildProjectOverview(project, sources, {
    events: [
      close(1, "member", "2026-10-21T23:59:59.999Z"),
      close(2, "member", "2026-10-22T00:00:00.000Z"),
      close(3, "member", "2026-10-22T00:00:01.000Z"),
      close(4, "foreign", "2026-10-22T00:00:00.000Z"),
      close(5, "member", "2026-10-23T00:00:00.000Z"),
    ],
    more: false,
    reservations: [],
    shifts: [],
  });
  expect(overview.throughput.data).toHaveLength(30);
  expect(overview.throughput.data?.slice(-2)).toEqual([
    { date: "2026-10-21", count: 1 },
    { date: "2026-10-22", count: 1 },
  ]);
  expect(overview.throughput.source).toContain("recorded");
});

test("duplicate session-end observations and absent prices do not invent project spend", () => {
  const event: LedgerEvent = {
    id: 1,
    ulid: "fixture",
    kind: "session.ended",
    workspace: "/fixture",
    beadId: "member",
    sessionId: "s",
    ts: sources.asOf,
    executor: { provider: "claude", model: "fixture" },
    payload: { usage: { inputTokens: 42 } },
  };
  const overview = buildProjectOverview(project, sources, {
    events: [
      event,
      { ...event, id: 2 },
      {
        ...event,
        id: 3,
        sessionId: "foreign",
        beadId: "foreign",
        payload: { usage: { costUsd: 99 } },
      },
    ],
    more: true,
    reservations: [],
    shifts: [],
  });
  expect(overview.usage.data).toEqual([
    { provider: "claude", sessions: 1, usage: { inputTokens: 42 } },
  ]);
  expect(overview.usage.complete).toBe(false);
  expect(overview.throughput.complete).toBe(false);
});
