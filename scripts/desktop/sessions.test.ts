import { expect, test } from "bun:test";
import { sessionRows } from "../../apps/desktop/src/sessions-model";
import type { SessionSummary } from "../../types/hearth";

const asOf = "2026-10-22T12:00:00.000Z";
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
