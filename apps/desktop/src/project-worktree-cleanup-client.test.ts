import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalCleanupRequest,
  cleanupRequestSchema,
} from "../../../scripts/projects/worktree-cleanup-protocol";
import { cleanupReviewSchema } from "../../../scripts/projects/worktree-cleanup-review-protocol";
import {
  cleanupBrowserOriginalSchema,
  cleanupBrowserRecordSchema,
  sameCleanupOriginal,
} from "./project-worktree-cleanup-client";

const projectId = "project-10000000-0000-4000-8000-000000000001";
const request = cleanupRequestSchema.parse({
  requestId: "20000000-0000-4000-8000-000000000002",
  repository: "/repo/native\\root",
  expectedCatalogRevision: 3,
  expectedHead: "a".repeat(40),
  expectedRecord: {
    id: "shift-review-1",
    path: "/repo/native\\root/trees/shift-review-1",
    branch: "feat/review",
    createdAt: "2026-11-08T00:00:00.000Z",
    beadId: "alpha-task",
  },
});
const review = cleanupReviewSchema.options[0].parse({
  repository: request.repository,
  expectedCatalogRevision: request.expectedCatalogRevision,
  expectedHead: request.expectedHead,
  expectedRecord: request.expectedRecord,
  projectId,
  worktreeId: request.expectedRecord.id,
  asOf: "2026-11-08T00:00:01.000Z",
  removalAuthorized: false,
  state: "eligible",
  reasons: [],
});
const original = cleanupBrowserOriginalSchema.parse({
  projectId,
  review,
  request,
  requestHash: createHash("sha256")
    .update(canonicalCleanupRequest(projectId, request))
    .digest("hex"),
});
const confirmed = {
  ...request,
  projectId,
  requestHash: original.requestHash,
  state: "confirmed",
  reason: null,
  attemptedAt: "2026-11-08T00:00:03.000Z",
  endedAt: "2026-11-08T00:00:04.000Z",
  audit: {
    eventId: 1,
    ulid: "01J00000000000000000000000",
    ts: "2026-11-08T00:00:02.000Z",
  },
};

test("cleanup browser original retains the full displayed review and exact native request", () => {
  expect(cleanupBrowserOriginalSchema.parse(original)).toEqual(original);
  expect(sameCleanupOriginal(original, structuredClone(original))).toBe(true);
  const changed = {
    ...original,
    review: { ...review, asOf: "2026-11-08T00:00:02.000Z" },
  };
  expect(cleanupBrowserOriginalSchema.safeParse(changed).success).toBe(true);
  expect(sameCleanupOriginal(original, changed)).toBe(false);
  for (const invalid of [
    { ...original, projectId: "project-10000000-0000-4000-8000-000000000099" },
    {
      ...original,
      review: { ...review, state: "refused", reasons: ["changed"] },
    },
    { ...original, review: { ...review, repository: "/repo/native/root" } },
    { ...original, request: { ...request, expectedHead: "b".repeat(40) } },
    {
      ...original,
      request: {
        ...request,
        expectedRecord: { ...request.expectedRecord, beadId: "other" },
      },
    },
  ])
    expect(cleanupBrowserOriginalSchema.safeParse(invalid).success).toBe(false);
});
test("stored cleanup receipts bind every native original field and ordered audit evidence", () => {
  for (const receipt of [
    null,
    confirmed,
    {
      ...confirmed,
      state: "refused",
      reason: "not eligible",
      attemptedAt: null,
    },
    { ...confirmed, state: "unknown", reason: "uncertain", endedAt: null },
  ])
    expect(
      cleanupBrowserRecordSchema.safeParse({ original, receipt }).success,
    ).toBe(true);
  for (const receipt of [
    { ...confirmed, repository: "/repo/native/root" },
    { ...confirmed, expectedCatalogRevision: 4 },
    { ...confirmed, requestHash: "f".repeat(64) },
    { ...confirmed, requestId: "20000000-0000-4000-8000-000000000099" },
    {
      ...confirmed,
      expectedRecord: { ...request.expectedRecord, branch: "feat/other" },
    },
    { ...confirmed, attemptedAt: "2026-11-08T00:00:01.000Z" },
    {
      ...confirmed,
      state: "refused",
      reason: "refused",
      attemptedAt: null,
      endedAt: "2026-11-08T00:00:01.000Z",
    },
    { ...confirmed, audit: { ...confirmed.audit, ulid: "8" + "0".repeat(25) } },
  ])
    expect(
      cleanupBrowserRecordSchema.safeParse({ original, receipt }).success,
    ).toBe(false);
});
