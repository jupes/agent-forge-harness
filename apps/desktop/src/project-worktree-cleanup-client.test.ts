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
  readCleanupBrowserInventory,
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

const authorityKey = "cleanup-browser-test";
const marker = JSON.stringify({ version: 1, authorityKey });
const rawInventory = (records: unknown[], activeRequestId: string | null) =>
  JSON.stringify({ version: 1, authorityKey, records, activeRequestId });
const storedHash = async (text: string) =>
  createHash("sha256").update(text).digest("hex");

test("raw cleanup inventory verifies every full original including inactive terminal rows", async () => {
  const nextRequest = {
    ...request,
    requestId: "20000000-0000-4000-8000-000000000003",
  };
  const second = cleanupBrowserOriginalSchema.parse({
    ...original,
    request: nextRequest,
    requestHash: await storedHash(
      canonicalCleanupRequest(projectId, nextRequest),
    ),
  });
  const records = [
    { original, receipt: null },
    {
      original: second,
      receipt: {
        ...confirmed,
        ...nextRequest,
        requestHash: second.requestHash,
      },
    },
  ].map((row) => cleanupBrowserRecordSchema.parse(row));
  const checked: string[] = [];
  const hash = async (text: string) => {
    checked.push(text);
    return storedHash(text);
  };
  expect(
    await readCleanupBrowserInventory(null, null, authorityKey, hash),
  ).toBeNull();
  const loaded = await readCleanupBrowserInventory(
    marker,
    rawInventory(records, request.requestId),
    authorityKey,
    hash,
  );
  expect(loaded?.records).toEqual(records);
  expect(checked).toEqual([
    canonicalCleanupRequest(projectId, request),
    canonicalCleanupRequest(projectId, nextRequest),
  ]);
  const corrupt = structuredClone(records);
  const tail = corrupt[1];
  if (!tail || !tail.receipt)
    throw Error("Expected a complete terminal fixture");
  tail.original.requestHash = "f".repeat(64);
  tail.receipt.requestHash = "f".repeat(64);
  checked.length = 0;
  await expect(
    readCleanupBrowserInventory(
      marker,
      rawInventory(corrupt, request.requestId),
      authorityKey,
      hash,
    ),
  ).rejects.toThrow();
  expect(checked).toHaveLength(2);
});
