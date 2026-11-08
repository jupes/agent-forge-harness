import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import { startTestHearth } from "../testing";
import { createProjectWorktreeCleanupReviewReader } from "./project-worktree-cleanup-review";

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
