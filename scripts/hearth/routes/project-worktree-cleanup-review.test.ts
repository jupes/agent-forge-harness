import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import { startTestHearth } from "../testing";
import {
  createProjectWorktreeCleanupReviewReader,
  createProjectWorktreeCleanupReviewRoute,
} from "./project-worktree-cleanup-review";

test("cleanup advisory reader refuses absent current membership without source or history", async () => {
  const h = await startTestHearth();
  let gitCalls = 0;
  try {
    const read = createProjectWorktreeCleanupReviewReader(
      {
        home: h.home,
        root: h.root,
        ledgerPath: h.ledger,
        runBd: h.bd.run,
      },
      {
        git: () => {
          gitCalls++;
          return { status: 1, stdout: "", stderr: "Unexpected Git read" };
        },
      },
    );
    expect(await read(FIXTURE_PROJECT_ID, "shift-review-1")).toMatchObject({
      projectId: FIXTURE_PROJECT_ID,
      worktreeId: "shift-review-1",
      state: "refused",
      removalAuthorized: false,
    });
    expect({
      gitCalls,
      source: h.bd.calls,
      ledger: existsSync(h.ledger),
      history: existsSync(join(h.home, "project-worktree-cleanup")),
    }).toEqual({ gitCalls: 0, source: [], ledger: false, history: false });
  } finally {
    await h.close();
  }
});

test("cleanup review route validates copied selectors and contains unavailable authority", async () => {
  const callbacks: string[] = [];
  const row = createProjectWorktreeCleanupReviewRoute(
    {
      home: "relative-home",
      root: "relative-root",
      ledgerPath: "relative-ledger",
      runBd: async () => {
        callbacks.push("source");
        return { status: 1, stdout: "", stderr: "" };
      },
    },
    {
      git: () => {
        callbacks.push("Git");
        return { status: 1, stdout: "", stderr: "" };
      },
    },
  );
  const input = {
    params: { id: FIXTURE_PROJECT_ID, worktreeId: "shift-review-1" },
    query: new URLSearchParams(),
    headers: {},
    body: undefined,
  };
  expect(row).toMatchObject({
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/settings/worktree-cleanup-review/:worktreeId",
  });
  for (const invalid of [
    { ...input, params: { ...input.params, id: "bad" } },
    { ...input, params: { ...input.params, worktreeId: "../foreign" } },
    { ...input, query: new URLSearchParams("unexpected=1&unexpected=2") },
  ])
    expect(row.validate(invalid).ok).toBe(false);
  const parsed = row.validate(input);
  if (!parsed.ok) throw Error("Expected valid copied selectors");
  input.params.worktreeId = "changed";
  expect(parsed.value).toEqual({
    projectId: FIXTURE_PROJECT_ID,
    worktreeId: "shift-review-1",
  });
  expect(await row.read(parsed.value)).toMatchObject({
    status: 503,
    error: expect.any(String),
  });
  expect(callbacks).toEqual([]);
});
