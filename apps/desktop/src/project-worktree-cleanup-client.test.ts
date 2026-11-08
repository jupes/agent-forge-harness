import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalCleanupRequest,
  cleanupRequestSchema,
} from "../../../scripts/projects/worktree-cleanup-protocol";
import { cleanupReviewSchema } from "../../../scripts/projects/worktree-cleanup-review-protocol";
import {
  advanceCleanupBrowserInventory,
  type CleanupBrowserInspection,
  type CleanupBrowserView,
  cleanupBrowserForProject,
  cleanupBrowserInventorySchema,
  cleanupBrowserOriginalSchema,
  cleanupBrowserRecordSchema,
  ProjectWorktreeCleanupOwner,
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
