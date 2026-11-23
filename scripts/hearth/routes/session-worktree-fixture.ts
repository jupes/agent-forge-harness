import { join } from "node:path";
import type {
  SessionWorktreeReceipt,
  SessionWorktreeRequest,
} from "../../../types/session-worktrees";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import {
  sessionWorktreeId,
  sessionWorktreeJournalFile,
  sessionWorktreeRequestHash,
} from "../../sessions/worktrees";
import type { TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

export const FIXTURE_WORKTREE_REQUEST = "7429508e-2321-472a-9c3a-eef27a91d0d3";
export function sessionWorktreeFixtureRequest(
  h: TestHearth,
): SessionWorktreeRequest {
  return {
    requestId: FIXTURE_WORKTREE_REQUEST,
    repository: h.workspace,
    baseRef: "HEAD",
    branch: "feat/worktree-fixture",
  };
}
/** A synthetic already-confirmed receipt for the common authority matrix; no Git process. */
export function seedSessionWorktreeFixture(h: TestHearth) {
  const request = sessionWorktreeFixtureRequest(h),
    id = sessionWorktreeId(FIXTURE_PROJECT_ID, request.requestId);
  const receipt: SessionWorktreeReceipt = {
    projectId: FIXTURE_PROJECT_ID,
    requestId: request.requestId,
    repository: request.repository,
    baseRef: request.baseRef,
    resolvedCommit: "a".repeat(40),
    branch: request.branch,
    worktree: {
      id,
      path: join(h.workspace, "trees", id),
      branch: request.branch,
      createdAt: "2026-10-23T00:00:00.000Z",
    },
    state: "created",
    reason: null,
  };
  writeOwnerOnly(
    sessionWorktreeJournalFile(h.home),
    JSON.stringify({
      version: 1,
      records: [
        {
          request,
          requestHash: sessionWorktreeRequestHash(FIXTURE_PROJECT_ID, request),
          plan: {
            ...receipt,
            state: "unknown",
            reason: "Synthetic original creation intent.",
          },
          receipt,
        },
      ],
    }),
  );
}
