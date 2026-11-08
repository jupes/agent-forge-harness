import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "../../../scripts/projects/worktree-cleanup-protocol";
import { cleanupReviewSchema } from "../../../scripts/projects/worktree-cleanup-review-protocol";
import {
  advanceCleanupBrowserInventory,
  type CleanupBrowserInspection,
  type CleanupBrowserRecord,
  type CleanupBrowserScope,
  type CleanupBrowserView,
  cleanupBrowserForProject,
  cleanupBrowserInventorySchema,
  cleanupBrowserOriginalSchema,
  cleanupBrowserRecordSchema,
  ProjectWorktreeCleanupOwner,
  readCleanupBrowserInventory,
  reconcileCleanupBrowserInventory,
  sameCleanupOriginal,
  settleCleanupBrowserReceipt,
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

function ownerFixture() {
  const saved = new Map<string, string>(),
    trace: string[] = [];
  let tail = Promise.resolve();
  const deps = {
    authorityKey,
    storage: {
      getItem(key: string) {
        trace.push("read:" + key);
        return saved.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        trace.push("write:" + key);
        saved.set(key, value);
      },
    },
    withLock: <T>(work: () => Promise<T>): Promise<T> => {
      const next = tail.then(work);
      tail = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    uuid: () => request.requestId,
    hash: storedHash,
    currentScope: () => ({
      projectId,
      repository: request.repository,
      worktreeId: request.expectedRecord.id,
    }),
    canWrite: () => true,
    readReview: async (): Promise<unknown> => {
      throw Error("Unexpected review read");
    },
    readReceipt: async (): Promise<unknown> => {
      throw Error("Unexpected receipt read");
    },
    operatorPost: async (): Promise<Response> => {
      throw Error("Unexpected cleanup POST");
    },
  };
  return { saved, trace, deps, owner: new ProjectWorktreeCleanupOwner(deps) };
}
test("cleanup owner construction retains a stable immutable initial snapshot without storage I/O", () => {
  const f = ownerFixture(),
    snapshot = f.owner.snapshot();
  expect(f.trace).toEqual([]);
  expect(f.owner.snapshot()).toBe(snapshot);
  expect(snapshot).toEqual({
    phase: "idle",
    inventory: null,
    storageError: false,
    inspection: { phase: "idle", selection: null, review: null, notice: "" },
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
  let calls = 0;
  const unsubscribe = f.owner.subscribe(() => {
    calls++;
  });
  unsubscribe();
  unsubscribe();
  expect(calls).toBe(0);
  expect(f.trace).toEqual([]);
});

test("observed marker survives a later storage read failure and both-key loss", async () => {
  const f = ownerFixture();
  await f.owner.restore();
  const [markerKey] = [...f.saved.keys()];
  if (!markerKey || !f.saved.get(markerKey))
    throw Error("Expected an initialized marker");
  const reads: string[] = [];
  let failSecond = true,
    faults = 0,
    markerObserved = false;
  const owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    storage: {
      getItem(key: string) {
        reads.push(key);
        const result = f.saved.get(key) ?? null;
        if (key === markerKey && result !== null) markerObserved = true;
        if (failSecond && reads.length === 2) {
          faults++;
          throw Error("Second read unavailable");
        }
        return result;
      },
      setItem: f.deps.storage.setItem,
    },
  });
  f.trace.length = 0;
  await owner.restore();
  expect({
    first: reads[0],
    count: reads.length,
    faults,
    markerObserved,
  }).toEqual({ first: markerKey, count: 2, faults: 1, markerObserved: true });
  expect(f.trace.filter((event) => event.startsWith("write:"))).toEqual([]);
  expect(owner.snapshot().storageError).toBe(true);
  f.saved.clear();
  failSecond = false;
  await owner.restore();
  expect(f.trace.filter((event) => event.startsWith("write:"))).toEqual([]);
  expect(f.saved.size).toBe(0);
  expect(owner.snapshot().storageError).toBe(true);
});

test("duplicate restore callers await the same paused verification completion", async () => {
  const f = ownerFixture();
  await f.owner.restore();
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  if (!inventoryKey) throw Error("Expected the initialized inventory");
  f.saved.set(
    inventoryKey,
    rawInventory([{ original, receipt: null }], request.requestId),
  );
  let release = () => {},
    signal = () => {},
    reached = false,
    timedOut = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    hash: async (text) => {
      reached = true;
      signal();
      await gate;
      return storedHash(text);
    },
  });
  const pending: Promise<void>[] = [];
  const watchdog = setTimeout(() => {
    timedOut = true;
    signal();
    release();
  }, 8000);
  let secondSettled = false,
    secondEarly = false;
  try {
    pending.push(owner.restore());
    await entered;
    pending.push(
      owner.restore().then(() => {
        secondSettled = true;
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    secondEarly = secondSettled;
  } finally {
    release();
    await Promise.all(pending);
    clearTimeout(watchdog);
  }
  expect({ reached, timedOut, secondEarly, secondSettled }).toEqual({
    reached: true,
    timedOut: false,
    secondEarly: false,
    secondSettled: true,
  });
  expect(owner.snapshot()).toMatchObject({
    phase: "retained-unconfirmed",
    storageError: false,
  });
}, 15000);

test("cleanup owner initializes marker first and restores immutable truth despite observer failure", async () => {
  const f = ownerFixture(),
    initial = f.owner.snapshot();
  expect(f.trace).toEqual([]);
  expect(f.owner.snapshot()).toBe(initial);
  let observed = 0;
  const unsubscribe = f.owner.subscribe(() => {
    observed++;
    throw Error("Observer failure");
  });
  await f.owner.restore();
  const empty = f.owner.snapshot();
  expect(empty).toMatchObject({
    phase: "idle",
    storageError: false,
    inventory: { version: 1, authorityKey, records: [], activeRequestId: null },
  });
  const [markerKey, inventoryKey] = [...f.saved.keys()];
  if (!markerKey || !inventoryKey)
    throw Error("Expected both initialized storage keys");
  expect(f.trace.filter((event) => event.startsWith("write:"))).toEqual([
    "write:" + markerKey,
    "write:" + inventoryKey,
  ]);
  expect(
    await readCleanupBrowserInventory(
      f.saved.get(markerKey) ?? null,
      f.saved.get(inventoryKey) ?? null,
      authorityKey,
      storedHash,
    ),
  ).toEqual(empty.inventory);
  f.saved.set(
    inventoryKey,
    rawInventory([{ original, receipt: confirmed }], null),
  );
  await f.owner.restore();
  const known = f.owner.snapshot(),
    retained = known.inventory?.records[0];
  if (!retained)
    throw Error("Expected independently visible saved terminal truth");
  expect(retained.receipt).toMatchObject({ state: "confirmed" });
  expect(known.storageError).toBe(false);
  expect(Object.isFrozen(known)).toBe(true);
  expect(Object.isFrozen(retained.original.request.expectedRecord)).toBe(true);
  expect(empty.inventory?.records).toEqual([]);
  expect(observed).toBeGreaterThan(0);
  unsubscribe();
  const reloaded = new ProjectWorktreeCleanupOwner(f.deps);
  await reloaded.restore();
  expect(reloaded.snapshot().inventory).toEqual(known.inventory);
});

test("terminal cleanup observer rejection is handled without escaping or changing truth", async () => {
  const f = ownerFixture();
  await f.owner.restore();
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  if (!inventoryKey) throw Error("Expected initialized inventory");
  f.saved.set(
    inventoryKey,
    rawInventory([{ original, receipt: confirmed }], null),
  );
  const failure = Error("Async cleanup observer failure");
  const unhandled: unknown[] = [],
    tasks: Promise<void>[] = [];
  let release = () => {},
    rejected = 0,
    synchronousNotices = 0,
    timedOut = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = () =>
    new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
  const observe = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", observe);
  const unsubscribe = f.owner.subscribe((value) => {
    if (
      !value.inventory?.records.some(
        (row) => row.receipt?.state === "confirmed",
      )
    )
      return;
    const task = (async () => {
      await gate;
      rejected++;
      throw failure;
    })();
    tasks.push(task);
    return task;
  });
  const unsubscribeSecond = f.owner.subscribe((value) => {
    if (
      value.inventory?.records.some((row) => row.receipt?.state === "confirmed")
    )
      synchronousNotices++;
  });
  const watchdog = setTimeout(() => {
    timedOut = true;
    release();
  }, 8000);
  let completed: PromiseSettledResult<void>[] = [];
  try {
    await f.owner.restore();
    expect(timedOut).toBe(false);
    expect(synchronousNotices).toBeGreaterThan(0);
    release();
    await turn();
    await turn();
    expect(rejected).toBeGreaterThan(0);
    expect(unhandled.filter((reason) => reason !== failure)).toEqual([]);
    expect(unhandled.filter((reason) => reason === failure)).toEqual([]);
    expect(f.owner.snapshot().inventory?.records[0]?.receipt).toMatchObject({
      state: "confirmed",
    });
  } finally {
    unsubscribe();
    unsubscribeSecond();
    release();
    clearTimeout(watchdog);
    await turn();
    await turn();
    completed = await Promise.allSettled(tasks);
    await turn();
    process.off("unhandledRejection", observe);
  }
  expect(completed.length).toBeGreaterThan(0);
  expect(
    completed.every(
      (result) => result.status === "rejected" && result.reason === failure,
    ),
  ).toBe(true);
}, 15000);

test("cleanup project projection separates selected review from another original and global health", () => {
  const other = "project-10000000-0000-4000-8000-000000000099";
  const otherReview = cleanupReviewSchema.options[0].parse({
    ...review,
    projectId: other,
    worktreeId: "other-shift-1",
    expectedRecord: {
      ...request.expectedRecord,
      id: "other-shift-1",
      path: request.expectedRecord.path.replace(
        "shift-review-1",
        "other-shift-1",
      ),
      beadId: "beta-task",
    },
  });
  const inspection: CleanupBrowserInspection = {
    phase: "eligible-review",
    notice: "",
    selection: {
      projectId: other,
      repository: otherReview.repository,
      worktreeId: otherReview.worktreeId,
    },
    review: otherReview,
  };
  const view: CleanupBrowserView = {
    ...ownerFixture().owner.snapshot(),
    phase: "storage-unavailable",
    inspection,
    inventory: inventoryReceipt(unknownReceipt),
    storageError: true,
  };
  expect(cleanupBrowserForProject(view, other)).toEqual({
    inspection,
    records: [],
    active: null,
    globalHold: true,
    storageError: true,
  });
  const held = cleanupBrowserForProject(view, projectId);
  expect(held.inspection).toBeNull();
  expect(held.active?.original).toEqual(original);
  expect(held.records).toHaveLength(1);
  const settled: CleanupBrowserView = {
    ...view,
    phase: "idle",
    storageError: false,
    inventory: inventoryReceipt(confirmed),
  };
  expect(cleanupBrowserForProject(settled, other)).toEqual({
    inspection,
    records: [],
    active: null,
    globalHold: false,
    storageError: false,
  });
  expect(
    cleanupBrowserForProject(settled, projectId).records[0]?.receipt,
  ).toMatchObject({ state: "confirmed", projectId });
});

test("inspection B survives a paused original restore A without mutating global recovery", async () => {
  const f = ownerFixture();
  await f.owner.restore();
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  if (!inventoryKey) throw Error("Expected initialized inventory");
  f.saved.set(
    inventoryKey,
    rawInventory([{ original, receipt: null }], request.requestId),
  );
  const selected = {
    projectId: "project-10000000-0000-4000-8000-000000000099",
    repository: request.repository,
    worktreeId: "other-shift-1",
  };
  const proof = cleanupReviewSchema.options[0].parse({
    ...review,
    ...selected,
    expectedRecord: {
      ...request.expectedRecord,
      id: selected.worktreeId,
      branch: "feat/beta",
      beadId: "beta-task",
      path: request.expectedRecord.path.replace(
        request.expectedRecord.id,
        selected.worktreeId,
      ),
    },
  });
  const reads: Array<{ url: string; maxBodyBytes: number }> = [],
    effects: string[] = [];
  let release = () => {},
    signal = () => {},
    reached = false,
    timedOut = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    currentScope: () => selected,
    hash: async (text) => {
      effects.push("hash");
      reached = true;
      signal();
      await gate;
      return storedHash(text);
    },
    uuid: () => {
      effects.push("uuid");
      return request.requestId;
    },
    operatorPost: async () => {
      effects.push("POST");
      throw Error("Unexpected cleanup POST");
    },
    readReview: async (url, limits) => {
      reads.push({ url, ...limits });
      return proof;
    },
  });
  const restoring = owner.restore();
  const watchdog = setTimeout(() => {
    timedOut = true;
    signal();
    release();
  }, 8000);
  let inspected: CleanupBrowserInspection | null = null;
  try {
    await entered;
    const before = [...f.trace],
      caller = { ...selected };
    const reading = owner.inspect(caller);
    caller.projectId = projectId;
    caller.repository = "/changed";
    caller.worktreeId = "changed";
    await reading;
    inspected = owner.snapshot().inspection;
    expect(inspected).toMatchObject({
      phase: "eligible-review",
      selection: selected,
      review: proof,
    });
    expect(owner.snapshot().inventory).toBeNull();
    expect(f.trace).toEqual(before);
  } finally {
    release();
    await restoring;
    clearTimeout(watchdog);
  }
  expect({ reached, timedOut }).toEqual({ reached: true, timedOut: false });
  expect(reads).toEqual([
    {
      url:
        "/projects/" +
        selected.projectId +
        "/settings/worktree-cleanup-review/" +
        selected.worktreeId,
      maxBodyBytes: 65536,
    },
  ]);
  expect(effects).toEqual(["hash"]);
  const view = owner.snapshot();
  expect(view.inspection).toEqual(inspected);
  expect(view.phase).toBe("retained-unconfirmed");
  expect(cleanupBrowserForProject(view, selected.projectId)).toMatchObject({
    records: [],
    active: null,
    globalHold: true,
    inspection: inspected,
  });
  expect(cleanupBrowserForProject(view, projectId).active?.original).toEqual(
    original,
  );
});

async function inspectionFixture() {
  const f = ownerFixture();
  await f.owner.restore();
  const key = [...f.saved.keys()].find((value) => value.endsWith(".inventory"));
  if (!key) throw Error("Expected initialized inventory");
  f.saved.set(
    key,
    rawInventory([{ original, receipt: unknownReceipt }], request.requestId),
  );
  const selection: CleanupBrowserScope = {
    projectId,
    repository: request.repository,
    worktreeId: request.expectedRecord.id,
  };
  let scope: CleanupBrowserScope | null = selection,
    answer: () => Promise<unknown> = async () => review;
  let scopeHook = () => {};
  const calls: string[] = [],
    faults: unknown[] = [];
  const reads: Array<{ url: string; maxBodyBytes: number }> = [];
  const owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    withLock: <T>(work: () => Promise<T>): Promise<T> => {
      calls.push("lock");
      return f.deps.withLock(work);
    },
    canWrite: () => {
      calls.push("canWrite");
      return true;
    },
    currentScope: () => {
      calls.push("scope");
      scopeHook();
      return scope;
    },
    readReview: async (url, limits) => {
      calls.push("review");
      reads.push({ url, ...limits });
      try {
        return await answer();
      } catch (error) {
        faults.push(error);
        throw error;
      }
    },
    hash: async (text) => {
      calls.push("hash");
      return storedHash(text);
    },
    uuid: () => {
      calls.push("uuid");
      return request.requestId;
    },
    operatorPost: async () => {
      calls.push("POST");
      throw Error("Unexpected POST");
    },
    readReceipt: async () => {
      calls.push("receipt");
      throw Error("Unexpected receipt read");
    },
  });
  await owner.restore();
  f.saved.delete(key);
  await owner.restore();
  const baseline = owner.snapshot();
  if (
    !baseline.storageError ||
    baseline.inventory?.activeRequestId !== request.requestId
  )
    throw Error("Expected a quarantined retained original fixture");
  calls.length = 0;
  f.trace.length = 0;
  return {
    ...f,
    owner,
    selection,
    calls,
    faults,
    reads,
    setScope: (value: CleanupBrowserScope | null) => {
      scope = value;
    },
    respond: (value: () => Promise<unknown>) => {
      answer = value;
    },
    onScope: (work: () => void) => {
      scopeHook = work;
    },
  };
}
test.each([
  "refused",
  "unknown",
  "foreign-project",
  "foreign-target",
  "foreign-root",
  "malformed",
  "cap-error",
] as const)("readonly cleanup inspection retains ownership after %s response", async (mode) => {
  const f = await inspectionFixture(),
    before = f.owner.snapshot().inventory;
  const fault = Error("Protected read receiving byte limit exceeded");
  let body: unknown = null;
  if (mode === "refused" || mode === "unknown")
    body = cleanupReviewSchema.parse({
      projectId,
      worktreeId: request.expectedRecord.id,
      asOf: review.asOf,
      removalAuthorized: false,
      state: mode,
      reasons: ["Not eligible"],
    });
  if (mode === "foreign-project")
    body = cleanupReviewSchema.options[0].parse({
      ...review,
      projectId: "project-10000000-0000-4000-8000-000000000099",
    });
  if (mode === "foreign-target")
    body = cleanupReviewSchema.options[0].parse({
      ...review,
      worktreeId: "other-shift-1",
      expectedRecord: {
        ...request.expectedRecord,
        id: "other-shift-1",
        path: request.expectedRecord.path.replace(
          request.expectedRecord.id,
          "other-shift-1",
        ),
      },
    });
  if (mode === "foreign-root")
    body = cleanupReviewSchema.options[0].parse({
      ...review,
      repository: "/foreign-root",
      expectedRecord: {
        ...request.expectedRecord,
        path: "/foreign-root/trees/" + request.expectedRecord.id,
      },
    });
  f.respond(async () => {
    if (mode === "cap-error") throw fault;
    return body;
  });
  await f.owner.inspect(f.selection);
  const view = f.owner.snapshot();
  expect(view.inspection.phase).toBe(
    mode === "refused" ? "review-refused" : "review-unknown",
  );
  if (mode === "refused" || mode === "unknown")
    expect(view.inspection.review).toEqual(cleanupReviewSchema.parse(body));
  else expect(view.inspection.review).toBeNull();
  expect(
    view.inspection.review !== null &&
      "expectedRecord" in view.inspection.review,
  ).toBe(false);
  expect(view.inventory).toEqual(before);
  expect(view.storageError).toBe(true);
  expect(f.trace).toEqual([]);
  expect(f.calls.filter((call) => !["scope", "review"].includes(call))).toEqual(
    [],
  );
  expect(f.reads).toEqual([
    {
      url:
        "/projects/" +
        projectId +
        "/settings/worktree-cleanup-review/" +
        request.expectedRecord.id,
      maxBodyBytes: 65536,
    },
  ]);
  expect(f.faults).toEqual(mode === "cap-error" ? [fault] : []);
});
test.each([
  "before",
  "after",
] as const)("same-turn scope drift %s read cannot retain proof", async (when) => {
  const f = await inspectionFixture(),
    before = f.owner.snapshot().inventory;
  const changed = { ...f.selection, repository: "/different-native-root" };
  let reached = false;
  if (when === "before") f.setScope(changed);
  else
    f.respond(async () => {
      reached = true;
      f.setScope(changed);
      return review;
    });
  await f.owner.inspect(f.selection);
  expect(f.owner.snapshot()).toMatchObject({
    inventory: before,
    storageError: true,
    inspection: {
      phase: "review-changed",
      selection: f.selection,
      review: null,
    },
  });
  expect(f.reads).toHaveLength(when === "before" ? 0 : 1);
  expect(reached).toBe(when === "after");
  expect(f.trace).toEqual([]);
  expect(f.calls.filter((call) => !["scope", "review"].includes(call))).toEqual(
    [],
  );
});

test.each([
  "response",
  "error",
  "null",
] as const)("stale inspection %s cannot replace a newer turn", async (mode) => {
  const f = await inspectionFixture(),
    known = f.owner.snapshot().inventory;
  const nextScope = {
    ...f.selection,
    projectId: "project-10000000-0000-4000-8000-000000000099",
    worktreeId: "next-shift-1",
  };
  const nextReview = cleanupReviewSchema.options[0].parse({
    ...review,
    ...nextScope,
    expectedRecord: {
      ...request.expectedRecord,
      id: nextScope.worktreeId,
      branch: "feat/next",
      beadId: "beta-task",
      path: request.expectedRecord.path.replace(
        request.expectedRecord.id,
        nextScope.worktreeId,
      ),
    },
  });
  let resolveRead: (value: unknown) => void = () => {},
    rejectRead: (reason: unknown) => void = () => {},
    signal = () => {};
  const oldReply = new Promise<unknown>((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  let reached = false,
    timedOut = false;
  const failure = Error("Old inspection failed");
  f.respond(async () => {
    reached = true;
    signal();
    return oldReply;
  });
  const old = f.owner.inspect(f.selection);
  const watchdog = setTimeout(() => {
    timedOut = true;
    signal();
    resolveRead(review);
  }, 8000);
  let expected: CleanupBrowserInspection | null = null;
  try {
    await entered;
    if (mode === "null") {
      const calls = [...f.calls],
        io = [...f.trace];
      await f.owner.inspect(null);
      expect(f.calls).toEqual(calls);
      expect(f.trace).toEqual(io);
      expected = f.owner.snapshot().inspection;
      expect(expected).toEqual({
        phase: "idle",
        selection: null,
        review: null,
        notice: "",
      });
    } else {
      f.setScope(nextScope);
      f.respond(async () => nextReview);
      await f.owner.inspect(nextScope);
      expected = f.owner.snapshot().inspection;
      expect(expected).toMatchObject({
        phase: "eligible-review",
        selection: nextScope,
        review: nextReview,
      });
    }
    if (mode === "error") rejectRead(failure);
    else resolveRead(review);
    await old;
  } finally {
    resolveRead(review);
    try {
      await old;
    } finally {
      clearTimeout(watchdog);
    }
  }
  expect({ reached, timedOut }).toEqual({ reached: true, timedOut: false });
  expect(f.owner.snapshot()).toMatchObject({
    inventory: known,
    storageError: true,
    inspection: expected,
  });
  expect(f.faults).toEqual(mode === "error" ? [failure] : []);
  expect(f.reads).toHaveLength(mode === "null" ? 1 : 2);
  expect(f.reads.every((read) => read.maxBodyBytes === 65536)).toBe(true);
  expect(f.trace).toEqual([]);
  expect(f.calls.filter((call) => !["scope", "review"].includes(call))).toEqual(
    [],
  );
}, 15000);
test.each([
  "scope-before",
  "scope-after",
  "notification",
  "read-error",
] as const)("reentrant %s invalidation cannot publish stale inspection state", async (mode) => {
  const f = await inspectionFixture(),
    known = f.owner.snapshot().inventory;
  let reached = false,
    unsubscribe = () => {};
  const nested: Promise<void>[] = [];
  let joined: PromiseSettledResult<void>[] = [];
  const failure = Error("Read invalidated its own inspection");
  const invalidate = () => {
    if (!reached) {
      reached = true;
      nested.push(f.owner.inspect(null));
    }
  };
  if (mode === "scope-before" || mode === "scope-after")
    f.onScope(() => {
      if (mode === "scope-before" || f.reads.length > 0) invalidate();
    });
  if (mode === "notification")
    unsubscribe = f.owner.subscribe((view) => {
      if (view.inspection.phase === "checking-review") invalidate();
    });
  if (mode === "read-error")
    f.respond(async () => {
      invalidate();
      throw failure;
    });
  try {
    await f.owner.inspect(f.selection);
  } finally {
    unsubscribe();
    joined = await Promise.allSettled(nested);
  }
  expect(reached).toBe(true);
  expect(joined.length).toBeGreaterThan(0);
  expect(joined.every((result) => result.status === "fulfilled")).toBe(true);
  expect(f.owner.snapshot()).toMatchObject({
    inventory: known,
    storageError: true,
    inspection: { phase: "idle", selection: null, review: null, notice: "" },
  });
  expect(f.reads).toHaveLength(
    mode === "scope-after" || mode === "read-error" ? 1 : 0,
  );
  expect(f.reads.every((read) => read.maxBodyBytes === 65536)).toBe(true);
  expect(f.faults).toEqual(mode === "read-error" ? [failure] : []);
  expect(f.trace).toEqual([]);
  expect(f.calls.filter((call) => !["scope", "review"].includes(call))).toEqual(
    [],
  );
});

async function nextCleanupOriginalFixture() {
  const nextProject = "project-10000000-0000-4000-8000-000000000099";
  const nextRequest = cleanupRequestSchema.parse({
    ...request,
    requestId: "20000000-0000-4000-8000-000000000003",
    expectedRecord: {
      ...request.expectedRecord,
      id: "next-shift-1",
      branch: "feat/next",
      beadId: "beta-task",
      path: request.expectedRecord.path.replace(
        request.expectedRecord.id,
        "next-shift-1",
      ),
    },
  });
  const nextReview = cleanupReviewSchema.options[0].parse({
    ...review,
    projectId: nextProject,
    worktreeId: nextRequest.expectedRecord.id,
    expectedRecord: nextRequest.expectedRecord,
    asOf: "2026-11-08T00:00:05.000Z",
  });
  return cleanupBrowserOriginalSchema.parse({
    projectId: nextProject,
    review: nextReview,
    request: nextRequest,
    requestHash: await storedHash(
      canonicalCleanupRequest(nextProject, nextRequest),
    ),
  });
}
test("receipt settlement retains the full original while terminal truth absorbs older unknown", () => {
  const reserved = inventoryReceipt(null);
  const attempted = settleCleanupBrowserReceipt(
    reserved,
    request.requestId,
    unknownReceipt,
  );
  const terminal = settleCleanupBrowserReceipt(
    attempted,
    request.requestId,
    confirmed,
  );
  expect(terminal).toEqual(inventoryReceipt(confirmed));
  expect(terminal.activeRequestId).toBeNull();
  expect(
    terminal.records.find(
      (row) => row.original.request.requestId === request.requestId,
    )?.original,
  ).toEqual(original);
  expect(
    settleCleanupBrowserReceipt(terminal, request.requestId, {
      ...unknownReceipt,
      attemptedAt: null,
    }),
  ).toEqual(terminal);
  expect(() =>
    settleCleanupBrowserReceipt(attempted, request.requestId, {
      ...unknownReceipt,
      attemptedAt: null,
    }),
  ).toThrow();
  const refused = inventoryReceipt({
    ...confirmed,
    state: "refused",
    reason: "not eligible",
    attemptedAt: null,
  });
  expect(
    settleCleanupBrowserReceipt(refused, request.requestId, {
      ...unknownReceipt,
      attemptedAt: null,
    }),
  ).toEqual(refused);
  expect(() =>
    settleCleanupBrowserReceipt(refused, request.requestId, unknownReceipt),
  ).toThrow();
  expect(reserved).toEqual(inventoryReceipt(null));
});
test("late original A evidence cannot clear new B or bypass full receipt validation", async () => {
  const next = await nextCleanupOriginalFixture();
  const known = inventoryFrom(
    [
      { original, receipt: confirmed },
      { original: next, receipt: null },
    ],
    next.request.requestId,
  );
  const before = structuredClone(known);
  for (const receipt of [confirmed, { ...unknownReceipt, attemptedAt: null }])
    expect(
      settleCleanupBrowserReceipt(known, request.requestId, receipt),
    ).toEqual(known);
  for (const audit of [
    { ...confirmed.audit, eventId: 2 },
    { ...confirmed.audit, ulid: "01J00000000000000000000001" },
    { ...confirmed.audit, ts: "2026-11-08T00:00:02.500Z" },
  ])
    expect(() =>
      settleCleanupBrowserReceipt(known, request.requestId, {
        ...unknownReceipt,
        audit,
      }),
    ).toThrow();
  for (const receipt of [
    {
      ...unknownReceipt,
      expectedRecord: {
        ...request.expectedRecord,
        path: "/repo/native/root/trees/shift-review-1",
      },
    },
    { ...unknownReceipt, attemptedAt: "2026-11-08T00:00:03.500Z" },
    { ...confirmed, projectId: next.projectId },
    { ...confirmed, endedAt: "2026-11-08T00:00:06.000Z" },
  ])
    expect(() =>
      settleCleanupBrowserReceipt(known, request.requestId, receipt),
    ).toThrow();
  expect(known).toEqual(before);
});
test("reconciliation heals only retained terminal evidence over an existing valid same-original prefix", async () => {
  const terminal = inventoryReceipt(confirmed);
  for (const receipt of [
    null,
    unknownReceipt,
    { ...unknownReceipt, attemptedAt: null },
  ])
    expect(
      reconcileCleanupBrowserInventory(terminal, inventoryReceipt(receipt)),
    ).toEqual(terminal);
  const next = await nextCleanupOriginalFixture();
  const fresh = inventoryFrom(
    [
      { original, receipt: confirmed },
      { original: next, receipt: null },
    ],
    next.request.requestId,
  );
  expect(
    reconcileCleanupBrowserInventory(inventoryReceipt(unknownReceipt), fresh),
  ).toEqual(fresh);
  const saved = structuredClone(fresh);
  const changedOriginal = {
    ...original,
    review: { ...review, asOf: "2026-11-08T00:00:06.000Z" },
  };
  for (const invalid of [
    null,
    {},
    inventoryFrom([], null),
    inventoryFrom(
      [{ original: changedOriginal, receipt: unknownReceipt }],
      request.requestId,
    ),
    inventoryReceipt({
      ...unknownReceipt,
      audit: { ...confirmed.audit, eventId: 2 },
    }),
    inventoryReceipt({
      ...unknownReceipt,
      attemptedAt: "2026-11-08T00:00:03.500Z",
    }),
    inventoryReceipt({
      ...confirmed,
      state: "refused",
      reason: "conflict",
      attemptedAt: null,
    }),
  ])
    expect(() => reconcileCleanupBrowserInventory(terminal, invalid)).toThrow();
  expect(() =>
    reconcileCleanupBrowserInventory(fresh, inventoryReceipt(unknownReceipt)),
  ).toThrow();
  expect(fresh).toEqual(saved);
});

test("each awaited inventory hash pins its raw baseline before the next row", async () => {
  const f = ownerFixture();
  await f.owner.restore();
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  const markerKey = [...f.saved.keys()].find((key) => key.endsWith(".marker"));
  if (!inventoryKey || !markerKey) throw Error("Expected initialized metadata");
  const next = await nextCleanupOriginalFixture();
  const nextReceipt = {
    ...confirmed,
    ...next.request,
    projectId: next.projectId,
    requestHash: next.requestHash,
    audit: {
      eventId: 2,
      ulid: "01J00000000000000000000001",
      ts: "2026-11-08T00:00:06.000Z",
    },
    attemptedAt: "2026-11-08T00:00:07.000Z",
    endedAt: "2026-11-08T00:00:08.000Z",
  };
  const rows = [
    { original, receipt: unknownReceipt },
    { original: next, receipt: nextReceipt },
  ];
  const baseline = rawInventory(rows, request.requestId);
  f.saved.set(inventoryKey, baseline);
  expect(
    await readCleanupBrowserInventory(
      marker,
      baseline,
      authorityKey,
      storedHash,
    ),
  ).toEqual(inventoryFrom(rows, request.requestId));
  const calls: string[] = [],
    writes: string[] = [],
    hashes: string[] = [];
  const reads: Array<{ url: string; maxBodyBytes: number }> = [];
  let armed = false;
  const owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    currentScope: () => {
      calls.push("scope");
      return null;
    },
    canWrite: () => {
      calls.push("canWrite");
      return false;
    },
    uuid: () => {
      calls.push("uuid");
      return request.requestId;
    },
    operatorPost: async () => {
      calls.push("POST");
      throw Error("Unexpected cleanup POST");
    },
    readReceipt: async (url, limits) => {
      reads.push({ url, ...limits });
      return confirmed;
    },
    hash: async (text) => {
      const digest = await storedHash(text);
      if (armed) {
        hashes.push(text);
        if (hashes.length === 1) f.saved.set(inventoryKey, baseline + " ");
        if (hashes.length === 2) f.saved.set(inventoryKey, baseline);
      }
      return digest;
    },
    storage: {
      getItem: f.deps.storage.getItem,
      setItem(key, text) {
        writes.push(key);
        f.deps.storage.setItem(key, text);
      },
    },
  });
  await owner.restore();
  expect(owner.snapshot().inventory).toEqual(
    inventoryFrom(rows, request.requestId),
  );
  armed = true;
  const pending = owner.checkOriginal(request.requestId);
  try {
    await pending;
  } finally {
    armed = false;
    await pending;
    f.saved.set(inventoryKey, baseline);
  }
  expect({
    writeCount: writes.length,
    hashBoundaryCount: hashes.length,
    storageError: owner.snapshot().storageError,
  }).toEqual({ writeCount: 0, hashBoundaryCount: 1, storageError: true });
  expect(hashes).toEqual([canonicalCleanupRequest(projectId, request)]);
  expect(calls).toEqual([]);
  expect(reads).toEqual([
    {
      url:
        "/projects/" +
        projectId +
        "/settings/worktree-cleanup/" +
        request.requestId +
        "?requestHash=" +
        original.requestHash,
      maxBodyBytes: 65536,
    },
  ]);
  expect(owner.snapshot()).toMatchObject({
    storageError: true,
    phase: "storage-unavailable",
    inventory: inventoryFrom(
      [
        { original, receipt: confirmed },
        { original: next, receipt: nextReceipt },
      ],
      null,
    ),
  });
  expect(f.saved.get(markerKey)).toBe(marker);
  expect(f.saved.get(inventoryKey)).toBe(baseline);
});

test("exact original GET settles memory before storage and remains readable without active scope or writes", async () => {
  const f = ownerFixture();
  await f.owner.restore();
  const keys = [...f.saved.keys()],
    inventoryKey = keys.find((key) => key.endsWith(".inventory"));
  const markerKey = keys.find((key) => key.endsWith(".marker"));
  if (!inventoryKey || !markerKey)
    throw Error("Expected initialized recovery namespace");
  f.saved.set(
    inventoryKey,
    rawInventory([{ original, receipt: null }], request.requestId),
  );
  const calls: string[] = [],
    reads: Array<{ url: string; maxBodyBytes: number }> = [];
  const saves: Array<{
    key: string;
    state: string | undefined;
    active: string | null | undefined;
  }> = [];
  let answer: unknown = confirmed,
    owner: ProjectWorktreeCleanupOwner | undefined;
  owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    currentScope: () => {
      calls.push("scope");
      return null;
    },
    canWrite: () => {
      calls.push("canWrite");
      return false;
    },
    uuid: () => {
      calls.push("uuid");
      return request.requestId;
    },
    operatorPost: async () => {
      calls.push("POST");
      throw Error("Unexpected POST");
    },
    readReceipt: async (url, limits) => {
      reads.push({ url, ...limits });
      return answer;
    },
    storage: {
      getItem: f.deps.storage.getItem,
      setItem(key, text) {
        const view = owner?.snapshot();
        saves.push({
          key,
          state: view?.inventory?.records.find(
            (row) => row.original.request.requestId === request.requestId,
          )?.receipt?.state,
          active: view?.inventory?.activeRequestId,
        });
        f.deps.storage.setItem(key, text);
      },
    },
  });
  await owner.restore();
  f.trace.length = 0;
  await owner.checkOriginal(request.requestId);
  expect(saves).toEqual([
    { key: inventoryKey, state: "confirmed", active: null },
  ]);
  expect(owner.snapshot()).toMatchObject({
    storageError: false,
    inventory: inventoryReceipt(confirmed),
    inspection: { phase: "idle", selection: null, review: null },
  });
  answer = { ...unknownReceipt, attemptedAt: null };
  await owner.checkOriginal(request.requestId);
  expect(reads).toEqual(
    Array.from({ length: 2 }, () => ({
      url:
        "/projects/" +
        projectId +
        "/settings/worktree-cleanup/" +
        request.requestId +
        "?requestHash=" +
        original.requestHash,
      maxBodyBytes: 65536,
    })),
  );
  expect(calls).toEqual([]);
  expect(owner.snapshot().inventory).toEqual(inventoryReceipt(confirmed));
  expect(
    await readCleanupBrowserInventory(
      f.saved.get(markerKey) ?? null,
      f.saved.get(inventoryKey) ?? null,
      authorityKey,
      storedHash,
    ),
  ).toEqual(owner.snapshot().inventory);
});

test("older GET verification preserves newer terminal warning and queued restore ownership", async () => {
  const f = ownerFixture();
  await f.owner.restore();
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  const markerKey = [...f.saved.keys()].find((key) => key.endsWith(".marker"));
  if (!inventoryKey || !markerKey) throw Error("Expected initialized metadata");
  const next = await nextCleanupOriginalFixture();
  const nextConfirmed = {
    ...confirmed,
    ...next.request,
    projectId: next.projectId,
    requestHash: next.requestHash,
    audit: {
      eventId: 2,
      ulid: "01J00000000000000000000001",
      ts: "2026-11-08T00:00:06.000Z",
    },
    attemptedAt: "2026-11-08T00:00:07.000Z",
    endedAt: "2026-11-08T00:00:08.000Z",
  };
  const baseline = inventoryFrom(
    [
      { original, receipt: confirmed },
      {
        original: next,
        receipt: {
          ...nextConfirmed,
          state: "unknown",
          reason: "unconfirmed",
          endedAt: null,
        },
      },
    ],
    next.request.requestId,
  );
  f.saved.set(inventoryKey, JSON.stringify(baseline));
  const gate = () => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, open: () => resolve() };
  };
  const reachedA = gate(),
    releaseA = gate(),
    queuedC = gate();
  const reachedC = gate(),
    releaseC = gate();
  const trace: string[] = [],
    faults: Error[] = [];
  const reads: Array<{ url: string; maxBodyBytes: number }> = [];
  const lockFailure = Error("B acquisition unavailable");
  let tag = "setup",
    lockOwner: string | null = null;
  let armed = false,
    pausedA = false,
    pausedC = false,
    timedOut = false;
  const owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    currentScope: () => ({
      projectId: next.projectId,
      repository: next.request.repository,
      worktreeId: next.request.expectedRecord.id,
    }),
    readReview: async () => next.review,
    readReceipt: async (url, limits) => {
      reads.push({ url, ...limits });
      return url.includes(next.request.requestId) ? nextConfirmed : confirmed;
    },
    withLock: async (work) => {
      const requested = tag;
      trace.push(requested + ":queued");
      if (requested === "B") {
        faults.push(lockFailure);
        throw lockFailure;
      }
      if (requested === "C") queuedC.open();
      return f.deps.withLock(async () => {
        lockOwner = requested;
        trace.push(requested + ":acquired");
        try {
          return await work();
        } finally {
          trace.push(requested + ":released");
          lockOwner = null;
        }
      });
    },
    hash: async (text) => {
      const digest = await storedHash(text);
      if (armed && lockOwner === "A" && !pausedA) {
        pausedA = true;
        reachedA.open();
        await releaseA.promise;
      }
      if (armed && lockOwner === "C" && !pausedC) {
        pausedC = true;
        reachedC.open();
        await releaseC.promise;
      }
      return digest;
    },
  });
  await owner.restore();
  expect(owner.snapshot().inventory).toEqual(baseline);
  await owner.inspect({
    projectId: next.projectId,
    repository: next.request.repository,
    worktreeId: next.request.expectedRecord.id,
  });
  const inspection = owner.snapshot().inspection;
  expect(inspection.phase).toBe("eligible-review");
  trace.length = 0;
  f.trace.length = 0;
  armed = true;
  const pending: Promise<void>[] = [];
  let beforeRelease: CleanupBrowserView | undefined;
  let duringRestore: CleanupBrowserView | undefined;
  let joined: PromiseSettledResult<void>[] = [];
  const watchdog = setTimeout(() => {
    timedOut = true;
    for (const barrier of [reachedA, releaseA, queuedC, reachedC, releaseC])
      barrier.open();
  }, 2000);
  try {
    tag = "A";
    const a = owner.checkOriginal(request.requestId);
    pending.push(a);
    await reachedA.promise;
    tag = "B";
    const b = owner.checkOriginal(next.request.requestId);
    pending.push(b);
    await b;
    beforeRelease = owner.snapshot();
    tag = "C";
    const c = owner.restore();
    pending.push(c);
    await queuedC.promise;
    releaseA.open();
    await a;
    await reachedC.promise;
    duringRestore = owner.snapshot();
    releaseC.open();
    await c;
  } finally {
    releaseA.open();
    releaseC.open();
    joined = await Promise.allSettled(pending);
    clearTimeout(watchdog);
    armed = false;
  }
  const terminal = inventoryFrom(
    [
      { original, receipt: confirmed },
      { original: next, receipt: nextConfirmed },
    ],
    null,
  );
  expect(timedOut).toBe(false);
  expect([pausedA, pausedC]).toEqual([true, true]);
  expect(faults).toEqual([lockFailure]);
  expect(joined.map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ]);
  expect(trace).toEqual([
    "A:queued",
    "A:acquired",
    "B:queued",
    "C:queued",
    "A:released",
    "C:acquired",
    "C:released",
  ]);
  expect(beforeRelease).toMatchObject({
    storageError: true,
    inventory: terminal,
    inspection,
  });
  expect(duringRestore).toMatchObject({
    phase: "restoring",
    storageError: true,
    inventory: terminal,
    inspection,
  });
  expect(owner.snapshot()).toMatchObject({
    phase: "idle",
    storageError: false,
    inventory: terminal,
    inspection,
  });
  expect(reads).toEqual(
    [original, next].map((held) => ({
      url:
        "/projects/" +
        held.projectId +
        "/settings/worktree-cleanup/" +
        held.request.requestId +
        "?requestHash=" +
        held.requestHash,
      maxBodyBytes: 65536,
    })),
  );
  expect(f.trace.filter((event) => event.startsWith("write:"))).toEqual([
    "write:" + inventoryKey,
  ]);
  expect(
    await readCleanupBrowserInventory(
      f.saved.get(markerKey) ?? null,
      f.saved.get(inventoryKey) ?? null,
      authorityKey,
      storedHash,
    ),
  ).toEqual(terminal);
});

test.each([
  "before-save",
  "save-then-throw",
  "readback-getter",
  "readback-digest",
])("retained original survives %s and heals only its valid same-original journal", async (mode) => {
  const f = ownerFixture();
  await f.owner.restore();
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  const markerKey = [...f.saved.keys()].find((key) => key.endsWith(".marker"));
  if (!inventoryKey || !markerKey) throw Error("Expected initialized metadata");
  const prior = inventoryReceipt(unknownReceipt);
  const terminal = inventoryReceipt(confirmed);
  f.saved.set(inventoryKey, JSON.stringify(prior));
  const fault = Error("Injected " + mode);
  const calls: string[] = [];
  const reads: Array<{ url: string; maxBodyBytes: number }> = [];
  const saves: Array<CleanupBrowserView | undefined> = [];
  let armed = false,
    savedWrite = false,
    getterReady = false;
  let faultCount = 0,
    readbackDigests = 0;
  let owner: ProjectWorktreeCleanupOwner | undefined;
  owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    currentScope: () => {
      calls.push("scope");
      return null;
    },
    canWrite: () => {
      calls.push("canWrite");
      return false;
    },
    uuid: () => {
      calls.push("uuid");
      return request.requestId;
    },
    operatorPost: async () => {
      calls.push("POST");
      throw Error("Unexpected cleanup POST");
    },
    readReceipt: async (url, limits) => {
      reads.push({ url, ...limits });
      return confirmed;
    },
    storage: {
      getItem(key) {
        if (armed && getterReady && mode === "readback-getter") {
          faultCount++;
          throw fault;
        }
        return f.deps.storage.getItem(key);
      },
      setItem(key, text) {
        saves.push(owner?.snapshot());
        if (armed && mode === "before-save") {
          faultCount++;
          throw fault;
        }
        f.deps.storage.setItem(key, text);
        savedWrite = true;
        if (armed && mode === "save-then-throw") {
          faultCount++;
          throw fault;
        }
      },
    },
    hash: async (text) => {
      const digest = await storedHash(text);
      if (armed && savedWrite) {
        readbackDigests++;
        if (mode === "readback-getter") getterReady = true;
        if (mode === "readback-digest") {
          faultCount++;
          throw fault;
        }
      }
      return digest;
    },
  });
  await owner.restore();
  expect(owner.snapshot().inventory).toEqual(prior);
  f.trace.length = 0;
  armed = true;
  await owner.checkOriginal(request.requestId);
  expect(faultCount).toBe(1);
  expect(readbackDigests).toBe(mode.startsWith("readback") ? 1 : 0);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ inventory: terminal });
  expect(owner.snapshot()).toMatchObject({
    phase: "storage-unavailable",
    storageError: true,
    inventory: terminal,
  });
  const diskAfterFault = await readCleanupBrowserInventory(
    f.saved.get(markerKey) ?? null,
    f.saved.get(inventoryKey) ?? null,
    authorityKey,
    storedHash,
  );
  expect(diskAfterFault).toEqual(mode === "before-save" ? prior : terminal);
  armed = false;
  await owner.checkOriginal(request.requestId);
  expect(faultCount).toBe(1);
  expect(saves).toHaveLength(2);
  expect(owner.snapshot()).toMatchObject({
    phase: "idle",
    storageError: false,
    inventory: terminal,
    inspection: { phase: "idle", selection: null, review: null },
  });
  expect(
    await readCleanupBrowserInventory(
      f.saved.get(markerKey) ?? null,
      f.saved.get(inventoryKey) ?? null,
      authorityKey,
      storedHash,
    ),
  ).toEqual(terminal);
  expect(f.saved.get(markerKey)).toBe(marker);
  expect(reads).toEqual(
    Array.from({ length: 2 }, () => ({
      url:
        "/projects/" +
        projectId +
        "/settings/worktree-cleanup/" +
        request.requestId +
        "?requestHash=" +
        original.requestHash,
      maxBodyBytes: 65536,
    })),
  );
  expect(calls).toEqual([]);
  expect(f.trace.filter((event) => event.startsWith("write:"))).toHaveLength(
    mode === "before-save" ? 1 : 2,
  );
});

async function retainedReceiptFixture(receipt: unknown) {
  const f = ownerFixture();
  await f.owner.restore();
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  const markerKey = [...f.saved.keys()].find((key) => key.endsWith(".marker"));
  if (!inventoryKey || !markerKey) throw Error("Expected initialized metadata");
  const prior = inventoryReceipt(receipt);
  f.saved.set(inventoryKey, JSON.stringify(prior));
  let reply: unknown;
  const calls: string[] = [],
    faults: Error[] = [];
  const reads: Array<{ url: string; maxBodyBytes: number }> = [];
  const owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    currentScope: () => {
      calls.push("scope");
      return null;
    },
    canWrite: () => {
      calls.push("canWrite");
      return false;
    },
    uuid: () => {
      calls.push("uuid");
      return request.requestId;
    },
    operatorPost: async () => {
      calls.push("POST");
      throw Error("Unexpected cleanup POST");
    },
    readReceipt: async (url, limits) => {
      reads.push({ url, ...limits });
      if (reply instanceof Error) {
        faults.push(reply);
        throw reply;
      }
      return reply;
    },
  });
  await owner.restore();
  expect(owner.snapshot().inventory).toEqual(prior);
  f.trace.length = 0;
  return {
    ...f,
    owner,
    inventoryKey,
    markerKey,
    calls,
    faults,
    reads,
    respond: (value: unknown) => {
      reply = value;
    },
  };
}
test("invalid decoded receipts and receiving-dependency rejections retain exact saved evidence", async () => {
  const f = await retainedReceiptFixture(unknownReceipt);
  const conflicts: unknown[] = [
    { ...confirmed, projectId: "project-10000000-0000-4000-8000-000000000099" },
    { ...confirmed, requestId: "20000000-0000-4000-8000-000000000099" },
    { ...confirmed, requestHash: "f".repeat(64) },
    { ...confirmed, repository: "/repo/foreign" },
    { ...confirmed, expectedCatalogRevision: 4 },
    { ...confirmed, expectedHead: "b".repeat(40) },
    ...[
      { id: "foreign-shift" },
      { path: "/repo/foreign/trees/shift-review-1" },
      { branch: "feat/foreign" },
      { createdAt: "2026-11-07T00:00:00.000Z" },
      { beadId: "foreign-task" },
    ].map((change) => ({
      ...confirmed,
      expectedRecord: { ...request.expectedRecord, ...change },
    })),
    ...[
      { eventId: 2 },
      { ulid: "01J00000000000000000000001" },
      { ts: "2026-11-08T00:00:02.500Z" },
    ].map((change) => ({
      ...confirmed,
      audit: { ...confirmed.audit, ...change },
    })),
    { ...confirmed, attemptedAt: "2026-11-08T00:00:03.500Z" },
  ];
  for (const conflict of conflicts)
    expect(cleanupReceiptSchema.safeParse(conflict).success).toBe(true);
  const failures = [
    Error("Receiving dependency returned HTTP 404"),
    Error("Receiving dependency transport failed"),
    RangeError("Receiving dependency rejected body above 65536 bytes"),
  ];
  const replies = [
    ...conflicts,
    null,
    {},
    { ...confirmed, extra: true },
    ...failures,
  ];
  const before = f.owner.snapshot(),
    saved = [...f.saved.entries()];
  for (const reply of replies) {
    f.respond(reply);
    await f.owner.checkOriginal(request.requestId);
    expect(f.owner.snapshot()).toEqual(before);
    expect([...f.saved.entries()]).toEqual(saved);
    expect(f.trace.filter((event) => event.startsWith("write:"))).toEqual([]);
  }
  expect(f.faults).toEqual(failures);
  expect(f.calls).toEqual([]);
  expect(f.reads).toEqual(
    Array.from({ length: replies.length }, () => ({
      url:
        "/projects/" +
        projectId +
        "/settings/worktree-cleanup/" +
        request.requestId +
        "?requestHash=" +
        original.requestHash,
      maxBodyBytes: 65536,
    })),
  );
});
test("a valid unknown receipt persists first audit and attempt while retaining the full active original", async () => {
  const f = await retainedReceiptFixture(null);
  f.respond(unknownReceipt);
  await f.owner.checkOriginal(request.requestId);
  const expected = inventoryReceipt(unknownReceipt);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "retained-unconfirmed",
    storageError: false,
    inventory: expected,
  });
  expect(f.owner.snapshot().inventory?.records[0]?.original).toEqual(original);
  expect(f.owner.snapshot().inventory?.activeRequestId).toBe(request.requestId);
  expect(f.trace.filter((event) => event.startsWith("write:"))).toEqual([
    "write:" + f.inventoryKey,
  ]);
  expect(
    await readCleanupBrowserInventory(
      f.saved.get(f.markerKey) ?? null,
      f.saved.get(f.inventoryKey) ?? null,
      authorityKey,
      storedHash,
    ),
  ).toEqual(expected);
  expect(f.calls).toEqual([]);
  expect(f.faults).toEqual([]);
  expect(f.reads).toEqual([
    {
      url:
        "/projects/" +
        projectId +
        "/settings/worktree-cleanup/" +
        request.requestId +
        "?requestHash=" +
        original.requestHash,
      maxBodyBytes: 65536,
    },
  ]);
});

test.each([
  "both-missing",
  "marker-missing",
  "inventory-missing",
  "corrupt",
  "foreign",
])("saved UUID recovery never repairs an initialized %s namespace", async (mode) => {
  const f = await retainedReceiptFixture(unknownReceipt);
  expect(f.owner.snapshot()).toMatchObject({
    storageError: false,
    inventory: inventoryReceipt(unknownReceipt),
  });
  if (mode === "both-missing" || mode === "marker-missing")
    f.saved.delete(f.markerKey);
  if (mode === "both-missing" || mode === "inventory-missing")
    f.saved.delete(f.inventoryKey);
  if (mode === "corrupt") f.saved.set(f.inventoryKey, "{");
  if (mode === "foreign") {
    const foreignKey = "another-cleanup-authority";
    const foreignMarker = JSON.stringify({
      version: 1,
      authorityKey: foreignKey,
    });
    const foreignInventory = {
      ...inventoryReceipt(unknownReceipt),
      authorityKey: foreignKey,
    };
    const foreignRaw = JSON.stringify(foreignInventory);
    expect(
      await readCleanupBrowserInventory(
        foreignMarker,
        foreignRaw,
        foreignKey,
        storedHash,
      ),
    ).toEqual(foreignInventory);
    f.saved.set(f.markerKey, foreignMarker);
    f.saved.set(f.inventoryKey, foreignRaw);
  }
  const badBytes = [...f.saved.entries()];
  const observations: CleanupBrowserView[] = [];
  const unsubscribe = f.owner.subscribe((view) => {
    observations.push(view);
  });
  let first: CleanupBrowserView | undefined;
  let afterFirst: Array<[string, string]> = [];
  try {
    f.respond(confirmed);
    await f.owner.checkOriginal(request.requestId);
    first = f.owner.snapshot();
    afterFirst = [...f.saved.entries()];
    f.respond({ ...unknownReceipt, attemptedAt: null });
    await f.owner.checkOriginal(request.requestId);
  } finally {
    unsubscribe();
  }
  const terminal = inventoryReceipt(confirmed);
  expect(observations[0]).toMatchObject({
    storageError: false,
    inventory: terminal,
  });
  expect(observations.findIndex((view) => view.storageError)).toBeGreaterThan(
    0,
  );
  expect(
    observations.every(
      (view) =>
        view.inventory?.activeRequestId === null &&
        view.inventory.records[0]?.receipt?.state === "confirmed",
    ),
  ).toBe(true);
  expect(first).toMatchObject({
    phase: "storage-unavailable",
    storageError: true,
    inventory: terminal,
  });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "storage-unavailable",
    storageError: true,
    inventory: terminal,
  });
  expect(afterFirst).toEqual(badBytes);
  expect([...f.saved.entries()]).toEqual(badBytes);
  expect(f.trace.filter((event) => event.startsWith("write:"))).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(f.faults).toEqual([]);
  expect(f.reads).toEqual(
    Array.from({ length: 2 }, () => ({
      url:
        "/projects/" +
        projectId +
        "/settings/worktree-cleanup/" +
        request.requestId +
        "?requestHash=" +
        original.requestHash,
      maxBodyBytes: 65536,
    })),
  );
});

test("confirmation durably verifies the full displayed original before one capped POST outside the lock", async () => {
  const f = ownerFixture();
  const events: string[] = [],
    hashInputs: string[] = [];
  const reviews: Array<{ url: string; maxBodyBytes: number }> = [];
  const posts: Array<{
    url: string;
    body: unknown;
    limits: unknown;
    held: boolean;
    saved: Array<[string, string]>;
    view: CleanupBrowserView;
    events: string[];
    hashes: string[];
  }> = [];
  let held = false,
    minted = 0;
  const owner: ProjectWorktreeCleanupOwner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    readReview: async (url, limits) => {
      reviews.push({ url, ...limits });
      return reviews.length === 1
        ? review
        : {
            ...review,
            asOf: "2026-11-08T00:00:02.000Z",
          };
    },
    uuid: () => {
      minted++;
      return request.requestId;
    },
    hash: async (text) => {
      const value = await storedHash(text);
      hashInputs.push(text);
      events.push("hash");
      return value;
    },
    storage: {
      getItem: f.deps.storage.getItem,
      setItem(key, text) {
        events.push(key.endsWith(".marker") ? "marker" : "inventory");
        f.deps.storage.setItem(key, text);
      },
    },
    withLock: (work) =>
      f.deps.withLock(async () => {
        held = true;
        events.push("acquired");
        try {
          return await work();
        } finally {
          held = false;
          events.push("released");
        }
      }),
    operatorPost: async (url, body, limits) => {
      posts.push({
        url,
        body: structuredClone(body),
        limits,
        held,
        saved: [...f.saved.entries()],
        view: owner.snapshot(),
        events: [...events],
        hashes: [...hashInputs],
      });
      return new Response(
        JSON.stringify({ ok: true, data: confirmed, error: null }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  await owner.inspect({
    projectId,
    repository: request.repository,
    worktreeId: request.expectedRecord.id,
  });
  expect(owner.snapshot().inspection).toMatchObject({
    phase: "eligible-review",
    review,
  });
  await owner.confirm();
  await owner.confirm();
  expect(posts).toHaveLength(1);
  const post = posts[0];
  if (!post) throw Error("Expected one actual operator POST invocation");
  expect(post).toMatchObject({
    url: "/projects/" + projectId + "/settings/worktree-cleanup",
    body: request,
    limits: { maxBodyBytes: 65536 },
    held: false,
    view: { phase: "dispatching", inventory: inventoryReceipt(null) },
  });
  const markerEntry = post.saved.find(([key]) => key.endsWith(".marker"));
  const inventoryEntry = post.saved.find(([key]) => key.endsWith(".inventory"));
  if (!markerEntry || !inventoryEntry)
    throw Error("Expected durable original at dispatch");
  expect(
    await readCleanupBrowserInventory(
      markerEntry[1],
      inventoryEntry[1],
      authorityKey,
      storedHash,
    ),
  ).toEqual(inventoryReceipt(null));
  expect(post.hashes).toEqual(
    Array.from({ length: 2 }, () =>
      canonicalCleanupRequest(projectId, request),
    ),
  );
  expect(post.events.slice(-5)).toEqual([
    "acquired",
    "hash",
    "inventory",
    "hash",
    "released",
  ]);
  expect(minted).toBe(1);
  expect(reviews).toEqual(
    Array.from({ length: 2 }, () => ({
      url:
        "/projects/" +
        projectId +
        "/settings/worktree-cleanup-review/" +
        request.expectedRecord.id,
      maxBodyBytes: 65536,
    })),
  );
  expect(owner.snapshot()).toMatchObject({
    phase: "idle",
    storageError: false,
    inventory: inventoryReceipt(confirmed),
    inspection: { phase: "review-changed", review: null },
  });
  const finalKeys = [...f.saved.keys()];
  const markerKey = finalKeys.find((key) => key.endsWith(".marker"));
  const inventoryKey = finalKeys.find((key) => key.endsWith(".inventory"));
  if (!markerKey || !inventoryKey)
    throw Error("Expected retained terminal original");
  expect(
    await readCleanupBrowserInventory(
      f.saved.get(markerKey) ?? null,
      f.saved.get(inventoryKey) ?? null,
      authorityKey,
      storedHash,
    ),
  ).toEqual(inventoryReceipt(confirmed));
  expect(held).toBe(false);
});

test.each([
  "scope-from-write",
  "writes-from-raw",
])("dispatch refuses one-shot %s drift after the earlier live gate observation", async (mode) => {
  const f = ownerFixture();
  let scope: CleanupBrowserScope | null = {
    projectId,
    repository: request.repository,
    worktreeId: request.expectedRecord.id,
  };
  let writable = true,
    triggered = 0,
    minted = 0;
  let owner: ProjectWorktreeCleanupOwner | undefined;
  const posts: Array<{ url: string; body: unknown; limits: unknown }> = [];
  owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    currentScope: () => scope,
    canWrite: () => {
      if (
        mode === "scope-from-write" &&
        !triggered &&
        owner?.snapshot().phase === "dispatching"
      ) {
        triggered++;
        scope = null;
      }
      return writable;
    },
    readReview: async () => review,
    uuid: () => {
      minted++;
      return request.requestId;
    },
    storage: {
      getItem(key) {
        const actual = f.deps.storage.getItem(key);
        if (
          mode === "writes-from-raw" &&
          !triggered &&
          owner?.snapshot().phase === "dispatching"
        ) {
          triggered++;
          writable = false;
        }
        return actual;
      },
      setItem: f.deps.storage.setItem,
    },
    operatorPost: async (url, body, limits) => {
      posts.push({ url, body: structuredClone(body), limits });
      throw Error("Stale POST was invoked after a live gate changed");
    },
  });
  await owner.inspect(scope);
  expect(owner.snapshot().inspection.phase).toBe("eligible-review");
  await owner.confirm();
  expect({ trigger: triggered, POSTs: posts.length }).toEqual({
    trigger: 1,
    POSTs: 0,
  });
  if (mode === "scope-from-write") expect(scope).toBeNull();
  else expect(writable).toBe(false);
  expect(minted).toBe(1);
  expect(owner.snapshot()).toMatchObject({
    phase: "retained-unconfirmed",
    storageError: false,
    inventory: inventoryReceipt(null),
    inspection: { phase: "review-changed", review: null },
  });
  const markerKey = [...f.saved.keys()].find((key) => key.endsWith(".marker"));
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  if (!markerKey || !inventoryKey)
    throw Error("Expected full durable reserved original");
  expect(
    await readCleanupBrowserInventory(
      f.saved.get(markerKey) ?? null,
      f.saved.get(inventoryKey) ?? null,
      authorityKey,
      storedHash,
    ),
  ).toEqual(inventoryReceipt(null));
  const saved = [...f.saved.entries()];
  await owner.confirm();
  expect(posts).toEqual([]);
  expect(minted).toBe(1);
  expect([...f.saved.entries()]).toEqual(saved);
});

async function confirmationFixture(
  inventory: NonNullable<CleanupBrowserView["inventory"]>,
) {
  const f = ownerFixture();
  await f.owner.restore();
  const inventoryKey = [...f.saved.keys()].find((key) =>
    key.endsWith(".inventory"),
  );
  const markerKey = [...f.saved.keys()].find((key) => key.endsWith(".marker"));
  if (!inventoryKey || !markerKey) throw Error("Expected initialized metadata");
  f.saved.set(inventoryKey, JSON.stringify(inventory));
  const control: {
    scope: CleanupBrowserScope | null;
    writable: boolean;
    uuid: string;
    review: unknown;
    reply: () => Promise<Response>;
  } = {
    scope: {
      projectId,
      repository: request.repository,
      worktreeId: request.expectedRecord.id,
    },
    writable: true,
    uuid: request.requestId,
    review,
    reply: async () => {
      throw Error("Controlled uncertain POST response");
    },
  };
  const trace: {
    minted: number;
    hashes: Array<{ text: string; minted: number; writes: number }>;
    writes: string[];
    posts: Array<{ url: string; body: unknown; limits: unknown }>;
  } = { minted: 0, hashes: [], writes: [], posts: [] };
  const owner = new ProjectWorktreeCleanupOwner({
    ...f.deps,
    currentScope: () => control.scope,
    canWrite: () => control.writable,
    readReview: async () => control.review,
    uuid: () => {
      trace.minted++;
      return control.uuid;
    },
    hash: async (text) => {
      const digest = await storedHash(text);
      trace.hashes.push({
        text,
        minted: trace.minted,
        writes: trace.writes.length,
      });
      return digest;
    },
    storage: {
      getItem: f.deps.storage.getItem,
      setItem(key, text) {
        trace.writes.push(key);
        f.deps.storage.setItem(key, text);
      },
    },
    operatorPost: async (url, body, limits) => {
      trace.posts.push({ url, body: structuredClone(body), limits });
      return control.reply();
    },
  });
  await owner.restore();
  expect(owner.snapshot().inventory).toEqual(inventory);
  return { ...f, owner, inventoryKey, markerKey, control, trace };
}
test.each([
  "unresolved-other-project",
  "terminal-history",
  "duplicate-UUID",
])("confirmation honors complete %s before candidate allocation", async (mode) => {
  const next = await nextCleanupOriginalFixture();
  const nextConfirmed = cleanupReceiptSchema.parse({
    ...confirmed,
    ...next.request,
    projectId: next.projectId,
    requestHash: next.requestHash,
    audit: {
      eventId: 2,
      ulid: "01J00000000000000000000001",
      ts: "2026-11-08T00:00:06.000Z",
    },
    attemptedAt: "2026-11-08T00:00:07.000Z",
    endedAt: "2026-11-08T00:00:08.000Z",
  });
  const adopting = mode === "unresolved-other-project";
  const initial =
    mode === "duplicate-UUID"
      ? inventoryReceipt(confirmed)
      : inventoryFrom(
          [
            {
              original: next,
              receipt: adopting
                ? {
                    ...nextConfirmed,
                    state: "unknown",
                    reason: "unconfirmed",
                    endedAt: null,
                  }
                : nextConfirmed,
            },
          ],
          adopting ? next.request.requestId : null,
        );
  const f = await confirmationFixture(initial);
  const saved = [...f.saved.entries()];
  await f.owner.inspect(f.control.scope);
  expect(f.owner.snapshot().inspection.phase).toBe("eligible-review");
  await f.owner.confirm();
  expect(f.owner.snapshot().inspection.phase).toBe("review-changed");
  expect(f.trace.hashes.length).toBeGreaterThanOrEqual(initial.records.length);
  const storedInputs = initial.records.map((row) =>
    canonicalCleanupRequest(row.original.projectId, row.original.request),
  );
  expect(
    f.trace.hashes
      .filter((entry) => entry.minted === 0)
      .every((entry) => storedInputs.includes(entry.text)),
  ).toBe(true);
  if (mode === "terminal-history") {
    const expected = inventoryFrom(
      [...initial.records, { original, receipt: null }],
      request.requestId,
    );
    expect(f.trace.minted).toBe(1);
    expect(f.trace.posts).toHaveLength(1);
    expect(f.trace.posts[0]).toMatchObject({
      body: request,
      limits: { maxBodyBytes: 65536 },
    });
    expect(
      f.trace.hashes.filter(
        (entry) => entry.minted === 1 && entry.writes === 0,
      ),
    ).toEqual([
      {
        text: canonicalCleanupRequest(projectId, request),
        minted: 1,
        writes: 0,
      },
    ]);
    expect(f.trace.writes).toEqual([f.inventoryKey]);
    expect(f.owner.snapshot().inventory).toEqual(expected);
    expect(
      await readCleanupBrowserInventory(
        f.saved.get(f.markerKey) ?? null,
        f.saved.get(f.inventoryKey) ?? null,
        authorityKey,
        storedHash,
      ),
    ).toEqual(expected);
  } else {
    expect(f.trace.minted).toBe(adopting ? 0 : 1);
    expect(f.trace.hashes.filter((entry) => entry.minted !== 0)).toEqual([]);
    expect(f.trace.posts).toEqual([]);
    expect(f.trace.writes).toEqual([]);
    expect(f.owner.snapshot().inventory).toEqual(initial);
    expect([...f.saved.entries()]).toEqual(saved);
  }
  expect(f.owner.snapshot().storageError).toBe(false);
});

async function terminalCleanupRows(count: number, template = original) {
  const rows: CleanupBrowserRecord[] = [];
  for (let index = 0; index < count; index++) {
    const nextRequest = cleanupRequestSchema.parse({
      ...template.request,
      requestId:
        "30000000-0000-4000-8000-" + (index + 1).toString(16).padStart(12, "0"),
    });
    const nextOriginal = cleanupBrowserOriginalSchema.parse({
      ...template,
      request: nextRequest,
      requestHash: await storedHash(
        canonicalCleanupRequest(template.projectId, nextRequest),
      ),
    });
    rows.push(
      cleanupBrowserRecordSchema.parse({
        original: nextOriginal,
        receipt: {
          ...confirmed,
          ...nextRequest,
          projectId: template.projectId,
          requestHash: nextOriginal.requestHash,
          state: "refused",
          reason: "x",
          attemptedAt: null,
          audit: {
            eventId: index + 1,
            ulid: (index + 1).toString().padStart(26, "0"),
            ts: confirmed.audit.ts,
          },
        },
      }),
    );
  }
  return rows;
}
test("a fully valid hundred-row terminal history refuses allocation after verifying every stored hash", async () => {
  const initial = inventoryFrom(await terminalCleanupRows(100), null);
  const raw = JSON.stringify(initial);
  expect(initial.records).toHaveLength(100);
  expect(initial.activeRequestId).toBeNull();
  expect(
    await readCleanupBrowserInventory(marker, raw, authorityKey, storedHash),
  ).toEqual(initial);
  const f = await confirmationFixture(initial);
  const saved = [...f.saved.entries()];
  const hashOffset = f.trace.hashes.length;
  await f.owner.inspect(f.control.scope);
  expect(f.owner.snapshot().inspection.phase).toBe("eligible-review");
  await f.owner.confirm();
  const checked = f.trace.hashes.slice(hashOffset);
  const canonical = initial.records.map((row) =>
    canonicalCleanupRequest(row.original.projectId, row.original.request),
  );
  expect(checked.length).toBeGreaterThanOrEqual(100);
  expect([...new Set(checked.map((entry) => entry.text))].sort()).toEqual(
    [...canonical].sort(),
  );
  expect(
    checked.every((entry) => entry.minted === 0 && entry.writes === 0),
  ).toBe(true);
  expect(f.trace.minted).toBe(0);
  expect(f.trace.posts).toEqual([]);
  expect(f.trace.writes).toEqual([]);
  expect(f.owner.snapshot()).toMatchObject({
    storageError: false,
    inventory: initial,
    inspection: { phase: "review-changed", review: null },
  });
  expect([...f.saved.entries()]).toEqual(saved);
});

test("exact UTF8 capacity refuses a candidate above one MiB despite a valid smaller character count", async () => {
  const limit = 1048576;
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  const repository = "/repo/" + "界".repeat(700);
  const expectedRecord = {
    ...request.expectedRecord,
    path: repository + "/trees/" + request.expectedRecord.id,
    branch: "feat/" + "界".repeat(200),
  };
  const heavyReview = cleanupReviewSchema.options[0].parse({
    ...review,
    repository,
    expectedRecord,
  });
  const heavyRequest = cleanupRequestSchema.parse({
    ...request,
    repository,
    expectedRecord,
  });
  const heavyOriginal = cleanupBrowserOriginalSchema.parse({
    ...original,
    review: heavyReview,
    request: heavyRequest,
    requestHash: await storedHash(
      canonicalCleanupRequest(projectId, heavyRequest),
    ),
  });
  const placeholder = "00000000-0000-4000-8000-000000000000";
  const capacityRaw = (
    inventory: NonNullable<CleanupBrowserView["inventory"]>,
  ) =>
    JSON.stringify({
      ...inventory,
      records: [
        ...inventory.records,
        {
          original: {
            ...heavyOriginal,
            request: { ...heavyRequest, requestId: placeholder },
            requestHash: "0".repeat(64),
          },
          receipt: null,
        },
      ],
      activeRequestId: placeholder,
    });
  const prefix: CleanupBrowserRecord[] = [];
  for (const row of await terminalCleanupRows(100, heavyOriginal)) {
    if (bytes(JSON.stringify(inventoryFrom([...prefix, row], null))) >= limit)
      break;
    prefix.push(row);
  }
  let initial = inventoryFrom(prefix, null);
  while (bytes(capacityRaw(initial)) >= limit)
    initial = inventoryFrom(initial.records.slice(0, -1), null);
  let padding = limit + 1 - bytes(capacityRaw(initial));
  for (const row of initial.records) {
    if (padding === 0) break;
    if (
      !row.receipt ||
      row.receipt.state !== "refused" ||
      row.receipt.reason === null
    )
      throw Error("Expected pre-adoption refused history");
    const addition = Math.min(1000 - row.receipt.reason.length, padding);
    row.receipt.reason += "x".repeat(addition);
    padding -= addition;
  }
  const raw = JSON.stringify(initial),
    candidate = capacityRaw(initial);
  expect(padding).toBe(0);
  expect(initial.records.length).toBeGreaterThan(0);
  expect(initial.records.length).toBeLessThan(100);
  expect(initial.activeRequestId).toBeNull();
  expect(bytes(raw)).toBeLessThan(limit);
  expect(raw.length).toBeLessThan(limit);
  expect(bytes(candidate)).toBe(limit + 1);
  expect(candidate.length).toBeLessThan(limit);
  expect(
    await readCleanupBrowserInventory(marker, raw, authorityKey, storedHash),
  ).toEqual(initial);
  const f = await confirmationFixture(initial);
  f.control.scope = { projectId, repository, worktreeId: expectedRecord.id };
  f.control.review = heavyReview;
  const saved = [...f.saved.entries()],
    hashOffset = f.trace.hashes.length;
  await f.owner.inspect(f.control.scope);
  expect(f.owner.snapshot().inspection).toMatchObject({
    phase: "eligible-review",
    review: heavyReview,
  });
  await f.owner.confirm();
  const checked = f.trace.hashes.slice(hashOffset);
  const canonical = initial.records.map((row) =>
    canonicalCleanupRequest(row.original.projectId, row.original.request),
  );
  expect(checked.length).toBeGreaterThanOrEqual(initial.records.length);
  expect([...new Set(checked.map((entry) => entry.text))].sort()).toEqual(
    [...canonical].sort(),
  );
  expect(
    checked.every((entry) => entry.minted === 0 && entry.writes === 0),
  ).toBe(true);
  expect(f.trace.minted).toBe(0);
  expect(f.trace.posts).toEqual([]);
  expect(f.trace.writes).toEqual([]);
  expect(f.owner.snapshot()).toMatchObject({
    storageError: false,
    inventory: initial,
    inspection: { phase: "review-changed", review: null },
  });
  expect([...f.saved.entries()]).toEqual(saved);
});
