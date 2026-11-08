import { expect, test } from "bun:test";
import {
  type CleanupReview,
  cleanupReviewSchema,
} from "./worktree-cleanup-review-protocol";

const common = {
  projectId: "project-a1000000-0000-4000-8000-000000000001",
  worktreeId: "shift-review-1",
  asOf: "2026-11-08T00:00:00.000Z",
  removalAuthorized: false as const,
};
const eligible: Extract<CleanupReview, { state: "eligible" }> = {
  ...common,
  state: "eligible" as const,
  repository: "/repo",
  expectedCatalogRevision: 1,
  expectedRecord: {
    id: common.worktreeId,
    path: "/repo/trees/shift-review-1",
    branch: "feat/review",
    createdAt: common.asOf,
    beadId: "alpha-task",
  },
  expectedHead: "a".repeat(40),
  reasons: [],
};
test("cleanup review states preserve exact proof while every outcome remains advisory", () => {
  const valid: CleanupReview[] = [
    eligible,
    { ...eligible, expectedHead: "b".repeat(64) },
    { ...common, state: "refused", reasons: ["The target is dirty"] },
    { ...common, state: "unknown", reasons: ["The source is incomplete"] },
  ];
  for (const value of valid)
    expect(cleanupReviewSchema.parse(value)).toEqual(value);
  const invalid: unknown[] = [
    { ...eligible, worktreeId: "another-target" },
    { ...eligible, removalAuthorized: true },
    { ...eligible, reasons: ["This proof is not eligible"] },
    { ...eligible, expectedHead: "a".repeat(39) },
    { ...eligible, expectedHead: "a".repeat(65) },
    { ...eligible, expectedHead: "A".repeat(40) },
    {
      ...eligible,
      expectedRecord: { ...eligible.expectedRecord, beadId: undefined },
    },
    { ...eligible, expectedCatalogRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...eligible, requestId: "a1000000-0000-4000-8000-000000000002" },
    { ...eligible, requestHash: "a".repeat(64) },
    { ...eligible, audit: { eventId: 1 } },
    { ...eligible, force: false },
    { ...eligible, context: { auditEventId: 1 } },
    { ...eligible, state: "refused", reasons: ["No reusable proof"] },
    { ...eligible, state: "unknown", reasons: ["No reusable proof"] },
    { ...common, state: "refused", reasons: [] },
    { ...common, state: "unknown", reasons: [""] },
    { ...common, state: "unknown", reasons: ["x".repeat(1001)] },
    { ...common, state: "unknown", reasons: Array(21).fill("Unverified") },
    {
      ...common,
      state: "unknown",
      reasons: ["Unverified"],
      repository: "/repo",
    },
    {
      ...common,
      state: "unknown",
      reasons: ["Unverified"],
      expectedRecord: eligible.expectedRecord,
    },
    { ...common, state: "unknown", reasons: ["Unverified"], asOf: "unknown" },
  ];
  invalid.forEach((value, index) => {
    expect({
      index,
      valid: cleanupReviewSchema.safeParse(value).success,
    }).toEqual({ index, valid: false });
  });
});
