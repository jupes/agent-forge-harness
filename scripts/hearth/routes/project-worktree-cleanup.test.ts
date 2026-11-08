import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalCleanupRequest } from "../../projects/worktree-cleanup-protocol";
import { createProjectWorktreeCleanupRoutes } from "./project-worktree-cleanup";

const projectId = "project-a1000000-0000-4000-8000-000000000001";
const review = {
  requestId: "a1000000-0000-4000-8000-000000000002",
  repository: "/repo",
  expectedCatalogRevision: 1,
  expectedRecord: {
    id: "shift-test-1",
    path: "/repo/trees/shift-test-1",
    branch: "feat/test",
    createdAt: "2026-11-07T00:00:00.000Z",
    beadId: "alpha-task",
  },
  expectedHead: "a".repeat(40),
};
test("cleanup route subject freezes the exact review before audit callbacks", () => {
  const routes = createProjectWorktreeCleanupRoutes({
    home: "/private",
    root: "/repo",
    queueLockFile: "/private/queue-lock.db",
    ledgerPath: "/private/ledger.db",
    runBd: async () => {
      throw Error("Unexpected source access");
    },
  });
  const body = structuredClone(review);
  const parsed = routes.cleanup.validate({
    params: { id: projectId },
    query: new URLSearchParams(),
    headers: {},
    body,
  });
  if (!parsed.ok) throw Error("Expected a complete reviewed request");
  body.expectedRecord.branch = "feat/substituted";
  expect(Object.isFrozen(parsed.value.request)).toBe(true);
  expect(Object.isFrozen(parsed.value.request.expectedRecord)).toBe(true);
  expect(routes.cleanup.subject(parsed.value)).toEqual({
    target: projectId,
    beadId: review.expectedRecord.beadId,
    family: "project-worktree-cleanup",
    requestId: review.requestId,
    inputHash: createHash("sha256")
      .update(canonicalCleanupRequest(projectId, review))
      .digest("hex"),
  });
});
