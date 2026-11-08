import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalCleanupRequest,
  cleanupRequestSchema,
} from "../../../scripts/projects/worktree-cleanup-protocol";
import { cleanupReviewSchema } from "../../../scripts/projects/worktree-cleanup-review-protocol";
import {
  advanceCleanupBrowserInventory,
  cleanupBrowserInventorySchema,
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

test("raw cleanup metadata refuses partial corrupt duplicate foreign and incoherent ownership", async () => {
  const active = { original, receipt: null },
    terminal = { original, receipt: confirmed };
  for (const [savedMarker, savedInventory] of [
    [null, rawInventory([], null)],
    [marker, null],
    ["{", rawInventory([], null)],
    [
      marker.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      rawInventory([], null),
    ],
    [
      marker,
      rawInventory([], null).replace('"version":1', '"version":1,"version":1'),
    ],
    [marker.replace(authorityKey, "foreign"), rawInventory([], null)],
    [marker, rawInventory([], null).replace(authorityKey, "foreign")],
    [marker.replace('"version":1', '"version":2'), rawInventory([], null)],
    [marker, rawInventory([active, active], request.requestId)],
    [marker, rawInventory([active], null)],
    [marker, rawInventory([terminal], request.requestId)],
    [marker, rawInventory([], request.requestId)],
    [
      marker,
      rawInventory(
        Array.from({ length: 101 }, () => terminal),
        null,
      ),
    ],
  ] as const)
    await expect(
      readCleanupBrowserInventory(
        savedMarker,
        savedInventory,
        authorityKey,
        storedHash,
      ),
    ).rejects.toThrow();
  expect(
    await readCleanupBrowserInventory(
      marker,
      rawInventory([], null),
      authorityKey,
      storedHash,
    ),
  ).toEqual({ version: 1, authorityKey, records: [], activeRequestId: null });
});

test("cleanup raw byte caps apply before JSON parsing or hash work", async () => {
  const calls: string[] = [];
  const hash = async (text: string) => {
    calls.push(text);
    return storedHash(text);
  };
  await expect(
    readCleanupBrowserInventory(
      " ".repeat(16385),
      rawInventory([], null),
      authorityKey,
      hash,
    ),
  ).rejects.toThrow("byte limit");
  const multibyte = JSON.stringify({ authorityKey: "é".repeat(600000) });
  await expect(
    readCleanupBrowserInventory(marker, multibyte, authorityKey, hash),
  ).rejects.toThrow("byte limit");
  expect(calls).toEqual([]);
});

test("raw inventory independently rejects terminal duplicate UUID and distinct unresolved owners", async () => {
  const nextRequest = {
    ...request,
    requestId: "20000000-0000-4000-8000-000000000003",
  };
  const next = cleanupBrowserOriginalSchema.parse({
    ...original,
    request: nextRequest,
    requestHash: await storedHash(
      canonicalCleanupRequest(projectId, nextRequest),
    ),
  });
  const terminal = cleanupBrowserRecordSchema.parse({
    original,
    receipt: confirmed,
  });
  const first = cleanupBrowserRecordSchema.parse({ original, receipt: null });
  const second = cleanupBrowserRecordSchema.parse({
    original: next,
    receipt: null,
  });
  const checks: string[] = [];
  const hash = async (text: string) => {
    checks.push(text);
    return storedHash(text);
  };
  for (const [records, active] of [
    [[terminal, terminal], null],
    [[first, second], nextRequest.requestId],
  ] as const) {
    await expect(
      readCleanupBrowserInventory(
        marker,
        rawInventory([...records], active),
        authorityKey,
        hash,
      ),
    ).rejects.toThrow();
  }
  expect(checks).toEqual([]);
});

const inventoryFrom = (records: unknown[], activeRequestId: string | null) =>
  cleanupBrowserInventorySchema.parse({
    version: 1,
    authorityKey,
    records,
    activeRequestId,
  });
const inventoryReceipt = (receipt: unknown) =>
  inventoryFrom(
    [{ original, receipt }],
    receipt &&
      cleanupBrowserRecordSchema.parse({ original, receipt }).receipt?.state !==
        "unknown"
      ? null
      : request.requestId,
  );
const unknownReceipt = {
  ...confirmed,
  state: "unknown",
  reason: "unconfirmed",
  endedAt: null,
};

test("cleanup inventory advances verified evidence and adopts new ownership without stale merging", async () => {
  const reserved = inventoryReceipt(null),
    attempted = inventoryReceipt(unknownReceipt);
  const terminal = inventoryReceipt(confirmed);
  expect(advanceCleanupBrowserInventory(reserved, attempted)).toEqual(
    attempted,
  );
  expect(advanceCleanupBrowserInventory(attempted, terminal)).toEqual(terminal);
  const nextRequest = {
    ...request,
    requestId: "20000000-0000-4000-8000-000000000003",
  };
  const next = cleanupBrowserOriginalSchema.parse({
    ...original,
    request: nextRequest,
    requestHash: await storedHash(
      canonicalCleanupRequest(projectId, nextRequest),
    ),
  });
  const expanded = inventoryFrom(
    [...terminal.records, { original: next, receipt: null }],
    nextRequest.requestId,
  );
  expect(advanceCleanupBrowserInventory(terminal, expanded)).toEqual(expanded);
  expect(terminal.records).toHaveLength(1);
});
test("cleanup inventory refuses history identity and observed audit or attempt erasure", async () => {
  const movedRequest = {
    ...request,
    repository: "/repo/native/root",
    expectedRecord: {
      ...request.expectedRecord,
      path: "/repo/native/root/trees/shift-review-1",
    },
  };
  const moved = cleanupBrowserOriginalSchema.parse({
    ...original,
    request: movedRequest,
    review: {
      ...review,
      repository: movedRequest.repository,
      expectedRecord: movedRequest.expectedRecord,
    },
    requestHash: await storedHash(
      canonicalCleanupRequest(projectId, movedRequest),
    ),
  });
  expect(() =>
    advanceCleanupBrowserInventory(
      inventoryReceipt(null),
      inventoryFrom([{ original: moved, receipt: null }], request.requestId),
    ),
  ).toThrow();
  const known = inventoryReceipt(unknownReceipt);
  const changedOriginal = {
    ...original,
    review: { ...review, asOf: "2026-11-08T00:00:02.000Z" },
  };
  for (const fresh of [
    inventoryFrom([], null),
    { ...known, authorityKey: "foreign" },
    { ...known, version: 2 },
    inventoryFrom(
      [{ original: changedOriginal, receipt: unknownReceipt }],
      request.requestId,
    ),
    inventoryReceipt(null),
    inventoryReceipt({ ...unknownReceipt, attemptedAt: null }),
    inventoryReceipt({
      ...unknownReceipt,
      attemptedAt: "2026-11-08T00:00:03.500Z",
    }),
    inventoryReceipt({
      ...unknownReceipt,
      audit: { ...confirmed.audit, eventId: 2 },
    }),
    inventoryReceipt({
      ...unknownReceipt,
      audit: { ...confirmed.audit, ulid: "01J00000000000000000000001" },
    }),
    inventoryReceipt({
      ...unknownReceipt,
      audit: { ...confirmed.audit, ts: "2026-11-08T00:00:02.500Z" },
    }),
  ])
    expect(() => advanceCleanupBrowserInventory(known, fresh)).toThrow();
  expect(known).toEqual(inventoryReceipt(unknownReceipt));
});
test("both terminal cleanup states preserve exact reason end and immutable evidence", () => {
  const refused = {
    ...confirmed,
    state: "refused",
    reason: "not eligible",
    attemptedAt: null,
  };
  const known = inventoryReceipt(confirmed);
  expect(() =>
    advanceCleanupBrowserInventory(known, inventoryFrom([], null)),
  ).toThrow();
  for (const receipt of [
    unknownReceipt,
    refused,
    { ...confirmed, endedAt: "2026-11-08T00:00:05.000Z" },
    { ...confirmed, attemptedAt: "2026-11-08T00:00:03.500Z" },
    { ...confirmed, audit: { ...confirmed.audit, eventId: 2 } },
  ])
    expect(() =>
      advanceCleanupBrowserInventory(known, inventoryReceipt(receipt)),
    ).toThrow();
  const denied = inventoryReceipt(refused);
  expect(() =>
    advanceCleanupBrowserInventory(
      denied,
      inventoryReceipt({ ...refused, reason: "changed" }),
    ),
  ).toThrow();
  expect(() => advanceCleanupBrowserInventory(denied, known)).toThrow();
  expect(
    advanceCleanupBrowserInventory(denied, structuredClone(denied)),
  ).toEqual(denied);
});
