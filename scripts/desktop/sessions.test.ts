import { expect, test } from "bun:test";
import { keeperSession } from "../../apps/desktop/src/keeper-session";
import { sessionRows } from "../../apps/desktop/src/sessions-model";
import type { ConversationPage } from "../../types/conversation";
import type { SessionSummary } from "../../types/hearth";

const asOf = "2026-10-22T12:00:00.000Z";

test("only current-turn identity and this hearth's ownership make a Keeper session eligible", () => {
  const binding = {
    provider: "claude" as const,
    sessionId: "actual",
    version: "fixture",
  };
  const turn = {
    requestId: "request",
    hash: "0".repeat(64),
    phase: "running" as const,
    createdAt: asOf,
    updatedAt: asOf,
    reason: null,
    owner: null,
  };
  const page: ConversationPage = {
    version: 1,
    projectId: "alpha",
    conversationId: "keeper-alpha",
    binding,
    revision: 2,
    turns: [turn],
    frames: [
      {
        seq: 1,
        turnId: turn.requestId,
        at: asOf,
        event: { kind: "identity", ...binding },
      },
    ],
    controllable: true,
    request: null,
    more: false,
    nextCursor: 1,
    lastSequence: 1,
  };
  expect(keeperSession("alpha", page)?.canStop).toBe(true);
  expect(keeperSession("beta", page)).toBeNull();
  expect(keeperSession("alpha", { ...page, frames: [] })).toBeNull();
  expect(
    keeperSession("alpha", {
      ...page,
      turns: [{ ...turn, requestId: "later" }],
    }),
  ).toBeNull();
  expect(
    keeperSession("alpha", { ...page, controllable: false }),
  ).toMatchObject({
    canStop: false,
    reason: "This hearth does not own the process.",
  });
  expect(
    keeperSession("alpha", { ...page, turns: [{ ...turn, phase: "unknown" }] }),
  ).toMatchObject({ canStop: false, phase: "unknown" });
});
const session = (
  sessionId: string,
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({
  sessionId,
  workspace: "/fixture",
  lastEventAt: asOf,
  ...extra,
});
test("session grouping preserves observations and nests a child even when it arrives first", () => {
  const rows = sessionRows(
    [
      session("child", { parentSessionId: "parent" }),
      session("parent"),
      session("ended", { endedAt: asOf }),
      session("orphan", { parentSessionId: "absent" }),
    ],
    {},
    asOf,
  );
  expect(rows.find((row) => row.session.sessionId === "child")?.depth).toBe(1);
  expect(rows.find((row) => row.session.sessionId === "parent")?.group).toBe(
    "observed",
  );
  expect(rows.find((row) => row.session.sessionId === "ended")?.group).toBe(
    "ended-today",
  );
  expect(rows.find((row) => row.session.sessionId === "orphan")?.depth).toBe(0);
});
test("filters retain actual provider identity and cycles or duplicates never repeat rows", () => {
  const sessions = [
    session("a", {
      parentSessionId: "b",
      executor: {
        provider: "grok",
        model: "reported-model",
        smith: "own-smith",
      },
    }),
    session("b", { parentSessionId: "a" }),
    session("a", { lastEventAt: "2026-10-21T00:00:00.000Z" }),
  ];
  expect(sessionRows(sessions, {}, asOf)).toHaveLength(2);
  expect(
    sessionRows(
      sessions,
      { provider: "grok", smith: "own-smith", search: "reported" },
      asOf,
    ).map((row) => row.session.sessionId),
  ).toEqual(["a"]);
});
