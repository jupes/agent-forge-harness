import { expect, test } from "bun:test";
import {
  insertKeeperSuggestion,
  keeperCommands,
  keeperObjects,
  keeperPicker,
} from "../../apps/desktop/src/keeper-context";
import type { KeeperReadResult } from "../../types/keeper";

test("mention reads reject foreign scopes, mismatched kinds, wrong modes, duplicate ids and unverifiable details", () => {
  const result: KeeperReadResult = {
    scope: {
      projectId: "alpha",
      name: "Alpha",
      slug: "alpha",
      catalogRevision: 1,
      workspace: "/fixture",
      repositories: [],
      epicIds: [],
      repositoryCount: 0,
      epicCount: 0,
      detailsComplete: true,
      detailsReason: null,
      label: "project:alpha",
      unavailableWorkspaces: 0,
    },
    kind: "beads",
    mode: "index",
    source: "Scoped tracker",
    asOf: "2026-10-22T00:00:00.000Z",
    complete: false,
    reason: "Bounded source",
    records: [{ id: "one", data: { title: "Actual title" }, truncated: false }],
    totalKnown: null,
    nextCursor: 100,
  };
  expect(keeperObjects("alpha", "bead", result)).toMatchObject({
    items: [{ kind: "bead", id: "one", title: "Actual title" }],
    complete: false,
    reason: "Bounded source",
    more: true,
  });
  for (const raw of [
    null,
    { ...result, scope: { ...result.scope, projectId: "beta" } },
    { ...result, kind: "sessions" },
    { ...result, mode: "detail" },
    { ...result, records: [...result.records, ...result.records] },
  ])
    expect(() => keeperObjects("alpha", "bead", raw)).toThrow(
      "could not be verified",
    );
  expect(() =>
    keeperObjects("alpha", "bead", { ...result, mode: "detail" }, "missing"),
  ).toThrow("could not be verified");
  expect(
    keeperObjects(
      "alpha",
      "bead",
      {
        ...result,
        mode: "detail",
        records: [{ id: "one", data: null, truncated: true }],
      },
      "one",
    ).items,
  ).toEqual([{ kind: "bead", id: "one", title: "one" }]);
});

test("picker boundaries respect caret position, email addresses and the closed object kinds", () => {
  expect(keeperPicker("Explain @session:parent later", 23)).toMatchObject({
    mode: "mention",
    kind: "session",
    query: "parent",
    start: 8,
    end: 23,
  });
  expect(keeperPicker("name@example.com", 16)).toBeNull();
  expect(keeperPicker("@file:../../secret", 18)).toBeNull();
  expect(keeperPicker("Look /forge", 11)).toMatchObject({
    mode: "command",
    query: "/forge",
  });
  expect(keeperPicker("https://example.com/forge", 25)).toBeNull();
});

test("command suggestions come from the generated harness catalog and replace only the active token", () => {
  const text = "Explain /forge here";
  const picker = keeperPicker(text, 14);
  expect(picker).not.toBeNull();
  if (!picker) throw new Error("Expected picker");
  expect(keeperCommands("/forge").map((command) => command.name)).toContain(
    "/forge-plan",
  );
  expect(keeperCommands("/does-not-exist")).toEqual([]);
  expect(insertKeeperSuggestion(text, picker, "/forge-plan")).toEqual({
    text: "Explain /forge-plan here",
    caret: 20,
  });
});
