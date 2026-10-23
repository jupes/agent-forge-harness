import { expect, test } from "bun:test";
import type { BeadsIssue } from "../../types/beads";
import type { ConversationState } from "../../types/conversation";
import type { LedgerEvent } from "../../types/hearth";
import type { ProjectSources } from "../projects/summary";
import { projectFixture } from "../projects/testing";
import { keeperBriefs, parseKeeperBrief } from "./brief-model";
import {
  buildKeeperBriefSnapshot,
  MAX_BRIEF_SNAPSHOT_BYTES,
} from "./brief-snapshot";

const project = projectFixture("/served");
const asOf = "2026-10-22T12:00:00.000Z";
const bead = (
  id: string,
  parent?: string,
  label = "project:alpha",
): BeadsIssue => ({
  id,
  title: id,
  type: parent ? "task" : "epic",
  status: "open",
  createdAt: project.createdAt,
  updatedAt: asOf,
  labels: [label],
  ...(parent ? { parent } : {}),
});
const source: ProjectSources = {
  workspace: "/served",
  asOf,
  issues: [
    bead("alpha-epic"),
    bead("member", "alpha-epic"),
    bead("foreign", "alpha-epic", "project:beta"),
  ],
  queue: [
    {
      beadId: "member",
      title: "Actual approval",
      state: "review",
      status: "open",
      backed: true,
    },
    {
      beadId: "foreign",
      title: "Foreign private approval",
      state: "review",
      status: "open",
      backed: true,
    },
  ],
  sessions: [],
  sessionsComplete: true,
  runs: [],
  checkout: "/served",
  problems: [],
};
const event = (
  id: number,
  beadId: string,
  workspace = "/served",
): LedgerEvent => ({
  id,
  ulid: `fixture-${id}`,
  kind: "bead.transitioned",
  workspace,
  beadId,
  sessionId: "reused",
  ts: asOf,
  payload: { action: "close" },
});

test("brief facts use exact project membership and each event's binding, with honest absent sources and a byte bound", () => {
  const snapshot = buildKeeperBriefSnapshot(project, 3, source, {
    events: [
      event(1, "member"),
      event(2, "foreign"),
      event(3, "member", "/elsewhere"),
    ],
    more: false,
  });
  expect(snapshot.projectId).toBe(project.id);
  expect(snapshot.asOf).toBe(asOf);
  expect(snapshot.catalogRevision).toBe(3);
  expect(JSON.stringify(snapshot)).not.toContain("foreign");
  expect(
    snapshot.facts
      .filter((fact) => fact.section === "moving")
      .map((fact) => fact.object.id),
  ).toEqual(["1"]);
  expect(
    snapshot.facts
      .filter((fact) => fact.section === "waiting")
      .map((fact) => fact.object.id),
  ).toEqual(["member"]);
  const unknown = buildKeeperBriefSnapshot(
    project,
    3,
    {
      ...source,
      issues: null,
      queue: null,
      sessionsComplete: false,
      problems: ["Tracker unavailable."],
    },
    { events: null, more: false },
  );
  expect(unknown.observed.beads).toBeNull();
  expect(unknown.observed.queue).toBeNull();
  expect(unknown.observed.sessions).toBeNull();
  expect(unknown.observed.activity).toBeNull();
  expect(unknown.complete).toBe(false);
  const bounded = buildKeeperBriefSnapshot(
    project,
    3,
    {
      ...source,
      issues: [
        bead("alpha-epic"),
        ...Array.from({ length: 200 }, (_, index) => ({
          ...bead(`member-${index}`, "alpha-epic"),
          title: "🌱".repeat(500),
        })),
      ],
    },
    { events: [], more: true },
  );
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
    MAX_BRIEF_SNAPSHOT_BYTES,
  );
  expect(bounded.complete).toBe(false);
  expect(bounded.limitations.join(" ")).toMatch(/bounded|omitted|limit/i);
});

test("brief sections can cite only provided evidence in the matching section; hostile or malformed output is never a confirmed brief", () => {
  const snapshot = buildKeeperBriefSnapshot(project, 1, source, {
    events: [],
    more: false,
  });
  const waiting = snapshot.facts.findIndex(
    (fact) => fact.section === "waiting",
  );
  const content = {
    summary: "One approval is recorded.",
    moving: [],
    waiting: [{ text: "Review the selected bead.", facts: [waiting] }],
    stuck: [],
  };
  expect(parseKeeperBrief(JSON.stringify(content), snapshot)).toEqual(content);
  expect(
    parseKeeperBrief(
      JSON.stringify({
        ...content,
        waiting: [{ text: "Foreign", facts: [999] }],
      }),
      snapshot,
    ),
  ).toBeNull();
  expect(
    parseKeeperBrief(
      JSON.stringify({ ...content, moving: content.waiting }),
      snapshot,
    ),
  ).toBeNull();
  expect(parseKeeperBrief("<script>alert(1)</script>", snapshot)).toBeNull();
  expect(
    parseKeeperBrief(
      JSON.stringify({ ...content, execute: "start shift" }),
      snapshot,
    ),
  ).toBeNull();
});

test("stuck evidence comes from blocked beads or backed halted queue state, and movement respects the previous brief window", () => {
  const since = "2026-10-22T11:00:00.000Z";
  const snapshot = buildKeeperBriefSnapshot(
    project,
    3,
    {
      ...source,
      issues: [
        bead("alpha-epic"),
        { ...bead("member", "alpha-epic"), status: "blocked" },
      ],
      queue: [
        {
          beadId: "member",
          title: "Halted by gate",
          state: "halted",
          status: "open",
          backed: true,
        },
        {
          beadId: "alpha-epic",
          title: "Inherited label only",
          state: "proposed",
          status: "open",
          backed: false,
        },
      ],
    },
    {
      events: [
        { ...event(1, "member"), ts: "2026-10-22T10:59:59.000Z" },
        event(2, "member"),
        { ...event(3, "member"), ts: "2026-10-22T12:00:01.000Z" },
      ],
      more: false,
    },
    since,
  );
  expect(snapshot.since).toBe(since);
  expect(
    snapshot.facts
      .filter((fact) => fact.section === "moving")
      .map((fact) => fact.object.id),
  ).toEqual(["2"]);
  expect(
    snapshot.facts.filter((fact) => fact.section === "waiting"),
  ).toHaveLength(0);
  expect(
    snapshot.facts
      .filter((fact) => fact.section === "stuck")
      .map((fact) => fact.state),
  ).toEqual(["queue:halted", "bead:blocked"]);
  expect(JSON.stringify(snapshot)).not.toContain("Inherited label only");
  expect(() =>
    buildKeeperBriefSnapshot(
      project,
      3,
      { ...source, workspace: "/foreign" },
      { events: [], more: false },
    ),
  ).toThrow("does not serve");
});

test("failed, malformed and unknown refreshes preserve the last confirmed brief and its original source time", () => {
  const snapshot = buildKeeperBriefSnapshot(project, 1, source, {
    events: [],
    more: false,
  });
  const content = JSON.stringify({
    summary: "One observed project.",
    moving: [],
    waiting: [],
    stuck: [],
  });
  const binding = {
    provider: "claude" as const,
    sessionId: "actual",
    version: "fixture",
  };
  const state: ConversationState = {
    version: 1,
    projectId: project.id,
    conversationId: `keeper-${project.id}`,
    revision: 10,
    binding,
    turns: [],
    frames: [],
  };
  for (const [index, phase, text] of [
    [1, "completed", content],
    [2, "failed", content],
    [3, "completed", "not a brief"],
    [4, "unknown", content],
  ] as const) {
    const requestId = `1a5832fa-7a21-403b-8184-44892f0d8d8${index}`;
    state.turns.push({
      requestId,
      phase,
      hash: "0".repeat(64),
      owner: null,
      createdAt: asOf,
      updatedAt: asOf,
      reason: null,
    });
    for (const item of [
      {
        kind: "user" as const,
        text: "Refresh Keeper brief",
        about: [],
        brief: snapshot,
      },
      { kind: "identity" as const, ...binding },
      { kind: "text" as const, text },
    ])
      state.frames.push({
        seq: state.frames.length + 1,
        turnId: requestId,
        at: asOf,
        event: item,
      });
  }
  const projection = keeperBriefs(state);
  expect(projection.latest?.requestId).toBe(state.turns[0]?.requestId);
  expect(projection.latest?.snapshot.asOf).toBe(asOf);
  expect(projection.earlier).toEqual([]);
  expect(projection.refresh?.phase).toBe("unknown");
});
