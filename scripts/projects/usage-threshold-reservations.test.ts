import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  usageThresholdIntentSchema,
  usageThresholdPendingSchema,
} from "../../types/usage-threshold-intents";
import {
  usageThresholdDocumentSchema,
  usageThresholdJson,
  usageThresholdOriginalSchema,
  usageThresholdReceiptSchema,
} from "../../types/usage-threshold-settings";
import { writeOwnerOnly } from "../hearth/token";
import { workspaceKey } from "./scope";
import { createProjectStore, projectCatalogPath } from "./store";
import { projectCatalogFixture } from "./testing";
import {
  createUsageThresholdStore,
  MAX_USAGE_POLICY_BYTES,
  MAX_USAGE_POLICY_REQUEST_BYTES,
  UsageThresholdError,
  type UsageThresholdRecord,
  usageThresholdRequestSchema,
} from "./usage-threshold-store";

const homes: string[] = [];
const requestId = "bc000000-0000-4000-8000-000000000001";
const instant = new Date("2026-11-11T12:00:00.000Z");
afterEach(() => {
  for (const home of homes.splice(0)) {
    const target = realpathSync(home);
    if (
      dirname(target) !== realpathSync(tmpdir()) ||
      !basename(target).startsWith("forge-usage-reservation-")
    )
      throw Error("Unsafe owned reservation fixture cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "forge-usage-reservation-"));
  homes.push(home);
  const workspace = workspaceKey(home);
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify(projectCatalogFixture(workspace)),
  );
  const project = createProjectStore(home).read().projects[0];
  if (!project) throw Error("Invalid canonical project fixture");
  const request = usageThresholdRequestSchema.parse({
    requestId,
    workspace,
    expectedCatalogRevision: 1,
    expectedRevision: 0,
    rules: [],
  });
  const store = createUsageThresholdStore(home, workspace, {
    now: () => new Date(instant),
  });
  return { home, workspace, projectId: project.id, request, store };
}
const stateFile = (home: string) =>
  join(home, "usage-threshold-settings", "state.json");
function legacyState(home: string, saved: UsageThresholdRecord) {
  const state = {
    version: 1,
    documents: [saved.document],
    receipts: [saved.receipt],
  };
  writeOwnerOnly(stateFile(home), JSON.stringify(state));
  return state;
}

test("a real canonical request and exact legacy v1 journal preserve the original receipt", async () => {
  const f = fixture();
  expect(usageThresholdRequestSchema.parse(f.request)).toEqual(f.request);
  const saved = await f.store.write(f.projectId, f.request);
  expect(saved.receipt.originalHash).toBe(
    createHash("sha256")
      .update(usageThresholdJson({ ...f.request, projectId: f.projectId }))
      .digest("hex"),
  );
  expect(saved.receipt).toMatchObject({
    outcome: "applied",
    observedRevision: 0,
    resultingRevision: 1,
    settledAt: instant.toISOString(),
    refusalCode: null,
  });
  legacyState(f.home, saved);
  const before = readFileSync(stateFile(f.home));
  const restored = createUsageThresholdStore(f.home, f.workspace);
  expect(restored.read(f.projectId)).toEqual(saved.document);
  expect(restored.original(f.projectId, requestId)).toEqual(saved);
  expect(await restored.write(f.projectId, f.request)).toEqual(saved);
  expect(readFileSync(stateFile(f.home))).toEqual(before);
});

test("a complete original is durably reserved before any policy revision or applied receipt exists", async () => {
  const f = fixture();
  const reserve = f.store.reserve;
  expect(typeof reserve).toBe("function");
  if (typeof reserve !== "function")
    throw Error("Missing policy reservation producer");
  const result = await f.store.reserve(f.projectId, f.request);
  expect(result).toMatchObject({
    origin: "reservation",
    phase: "reserved",
    original: { ...f.request, projectId: f.projectId },
    reservedAt: instant.toISOString(),
    discardedAt: null,
    receipt: null,
    document: {
      projectId: f.projectId,
      workspace: f.workspace,
      revision: 0,
      rules: [],
    },
  });
  expect(f.store.read(f.projectId).revision).toBe(0);
  expect(() => f.store.original(f.projectId, requestId)).toThrow();
  expect(readFileSync(stateFile(f.home), "utf8")).toContain(requestId);
});

test("only explicit exact reserved Apply can publish and direct write cannot bypass the pending original", async () => {
  const f = fixture();
  await f.store.reserve(f.projectId, f.request);
  const reserved = readFileSync(stateFile(f.home));
  await expect(f.store.write(f.projectId, f.request)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    f.store.write(f.projectId, {
      ...f.request,
      requestId: "bc000000-0000-4000-8000-000000000002",
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(stateFile(f.home))).toEqual(reserved);
  const apply = f.store.applyReserved;
  expect(typeof apply).toBe("function");
  if (typeof apply !== "function")
    throw Error("Missing explicit reserved Apply");
  const result = await f.store.applyReserved(f.projectId, f.request);
  expect(result).toMatchObject({
    document: { revision: 1, rules: [] },
    receipt: {
      original: { ...f.request, projectId: f.projectId },
      outcome: "applied",
      observedRevision: 0,
      resultingRevision: 1,
    },
  });
  expect(f.store.original(f.projectId, requestId)).toEqual(result);
  const applied = readFileSync(stateFile(f.home));
  expect(await f.store.applyReserved(f.projectId, f.request)).toEqual(result);
  expect(await f.store.write(f.projectId, f.request)).toEqual(result);
  expect(readFileSync(stateFile(f.home))).toEqual(applied);
});

test("the reserved wire view requires the exact current policy revision", async () => {
  const f = fixture();
  await f.store.write(f.projectId, f.request);
  const pending = await f.store.reserve(f.projectId, {
    ...f.request,
    requestId: "bc000000-0000-4000-8000-000000000002",
    expectedRevision: 1,
  });
  expect(usageThresholdIntentSchema.parse(pending)).toEqual(pending);
  for (const revision of [0, 2])
    expect(
      usageThresholdIntentSchema.safeParse({
        ...pending,
        document: { ...pending.document, revision },
      }).success,
    ).toBe(false);
});

test.each([
  0, 2,
])("a validly rehashed pending revision %i cannot contradict current revision1", async (revision) => {
  const f = fixture();
  await f.store.write(f.projectId, f.request);
  const request = {
    ...f.request,
    requestId: "bc000000-0000-4000-8000-000000000002",
    expectedRevision: 1,
  };
  await f.store.reserve(f.projectId, request);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stateFile(f.home), "utf8"));
  } catch {
    throw Error("Invalid actual reservation fixture JSON");
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !("originals" in raw) ||
    !Array.isArray(raw.originals)
  )
    throw Error("Missing actual reservation rows");
  const row: unknown = raw.originals[0];
  if (
    !row ||
    typeof row !== "object" ||
    !("original" in row) ||
    !("originalHash" in row)
  )
    throw Error("Missing complete actual original");
  row.original = {
    ...usageThresholdOriginalSchema.parse(row.original),
    expectedRevision: revision,
  };
  row.originalHash = createHash("sha256")
    .update(usageThresholdJson(row.original))
    .digest("hex");
  writeOwnerOnly(stateFile(f.home), JSON.stringify(raw));
  const before = readFileSync(stateFile(f.home));
  expect(() => f.store.read(f.projectId)).toThrow(UsageThresholdError);
  expect(() => f.store.original(f.projectId, requestId)).toThrow(
    UsageThresholdError,
  );
  await expect(
    f.store.applyReserved(f.projectId, request),
  ).rejects.toMatchObject({ status: 503 });
  expect(readFileSync(stateFile(f.home))).toEqual(before);
});

test("retained reservation recovery is complete across removed projects and previous workspaces", async () => {
  const f = fixture();
  const first = await f.store.reserve(f.projectId, f.request);
  const otherWorkspace = workspaceKey(join(f.home, "previous-workspace"));
  const catalog = createProjectStore(f.home).read();
  writeOwnerOnly(
    projectCatalogPath(f.home),
    JSON.stringify({
      ...catalog,
      revision: 2,
      projects: catalog.projects.map((project) => ({
        ...project,
        workspaces: [
          ...project.workspaces,
          { ...project.workspaces[0], root: otherWorkspace },
        ],
      })),
    }),
  );
  const otherStore = createUsageThresholdStore(f.home, otherWorkspace);
  const second = await otherStore.reserve(f.projectId, {
    ...f.request,
    requestId: "bc000000-0000-4000-8000-000000000002",
    workspace: otherWorkspace,
    expectedCatalogRevision: 2,
  });
  writeOwnerOnly(
    projectCatalogPath(f.home),
    JSON.stringify({ ...catalog, revision: 3, projects: [] }),
  );
  const before = readFileSync(stateFile(f.home));
  const restarted = createUsageThresholdStore(f.home, otherWorkspace);
  expect(typeof restarted.recovery).toBe("function");
  expect(restarted.recovery()).toEqual({
    version: 1,
    complete: true,
    pending: [first, second].map(({ original, originalHash, reservedAt }) =>
      usageThresholdPendingSchema.parse({ original, originalHash, reservedAt }),
    ),
  });
  expect(restarted.reservation(f.projectId, second.original.requestId)).toEqual(
    second,
  );
  expect(() => restarted.reservation(f.projectId, requestId)).toThrow();
  expect(
    createUsageThresholdStore(f.home, f.workspace).reservation(
      f.projectId,
      requestId,
    ),
  ).toEqual(first);
  expect(readFileSync(stateFile(f.home))).toEqual(before);
});

test("exact legacy reservation views preserve receipt bytes without inventing a reserved timestamp", async () => {
  const f = fixture();
  const saved = await f.store.write(f.projectId, f.request);
  legacyState(f.home, saved);
  const before = readFileSync(stateFile(f.home));
  expect(typeof f.store.reservation).toBe("function");
  expect(f.store.reservation(f.projectId, requestId)).toEqual({
    origin: "legacy-receipt",
    phase: "applied",
    original: saved.receipt.original,
    originalHash: saved.receipt.originalHash,
    reservedAt: null,
    discardedAt: null,
    receipt: saved.receipt,
    document: saved.document,
  });
  expect(f.store.recovery()).toEqual({
    version: 1,
    complete: true,
    pending: [],
  });
  expect(readFileSync(stateFile(f.home))).toEqual(before);
});

test("discard requires the exact original and is revision neutral and immutable after project removal", async () => {
  const f = fixture();
  const pending = await f.store.reserve(f.projectId, f.request);
  const before = readFileSync(stateFile(f.home));
  expect(typeof f.store.discardReserved).toBe("function");
  await expect(
    f.store.discardReserved(f.projectId, requestId, {
      ...pending.original,
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.store.discardReserved(f.projectId, requestId, {
      ...pending.original,
      extra: true,
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(readFileSync(stateFile(f.home))).toEqual(before);
  const catalog = createProjectStore(f.home).read();
  writeOwnerOnly(
    projectCatalogPath(f.home),
    JSON.stringify({ ...catalog, revision: 2, projects: [] }),
  );
  const discarded = await f.store.discardReserved(
    f.projectId,
    requestId,
    pending.original,
  );
  expect(discarded).toEqual({
    ...pending,
    phase: "discarded",
    discardedAt: instant.toISOString(),
  });
  expect(discarded.document.revision).toBe(0);
  expect(f.store.recovery().pending).toEqual([]);
  const after = readFileSync(stateFile(f.home));
  expect(
    await f.store.discardReserved(f.projectId, requestId, pending.original),
  ).toEqual(discarded);
  expect(await f.store.reserve(f.projectId, f.request)).toEqual(discarded);
  await expect(
    f.store.applyReserved(f.projectId, f.request),
  ).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(stateFile(f.home))).toEqual(after);
});

const nextId = (value: number) =>
  `bc000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const largeRules = usageThresholdRequestSchema.shape.rules.parse(
  Array.from({ length: 100 }, (_, i) => ({
    id: nextId(i + 1),
    provider: "codex",
    enabled: true,
    selector: {
      kind: "subscription-window",
      unit: "percent",
      source: "provider-cli",
      label: "a".repeat(2048),
      basis: "used",
    },
    comparison: "at-least",
    threshold: 80,
  })),
);
const digest = (value: unknown) =>
  createHash("sha256").update(usageThresholdJson(value)).digest("hex");

test("reserved growth covers maximum counters, receipt and document bytes and discard overhead", () => {
  const f = fixture();
  const original = usageThresholdOriginalSchema.parse({
    ...f.request,
    projectId: f.projectId,
    rules: largeRules,
    expectedCatalogRevision: Number.MAX_SAFE_INTEGER,
    expectedRevision: Number.MAX_SAFE_INTEGER - 1,
  });
  const bytes = Buffer.byteLength(JSON.stringify(original));
  expect(bytes).toBeLessThanOrEqual(MAX_USAGE_POLICY_REQUEST_BYTES);
  const receipt = usageThresholdReceiptSchema.parse({
    original,
    originalHash: digest(original),
    outcome: "applied",
    observedRevision: Number.MAX_SAFE_INTEGER - 1,
    resultingRevision: Number.MAX_SAFE_INTEGER,
    settledAt: instant.toISOString(),
    refusalCode: null,
  });
  const document = usageThresholdDocumentSchema.parse({
    projectId: f.projectId,
    workspace: f.workspace,
    revision: Number.MAX_SAFE_INTEGER,
    rules: largeRules,
  });
  expect(
    Buffer.byteLength(JSON.stringify(receipt)) +
      Buffer.byteLength(JSON.stringify(document)) +
      2,
  ).toBeLessThanOrEqual(2 * bytes + 512);
  const row = { phase: "reserved", discardedAt: null };
  expect(
    Buffer.byteLength(
      JSON.stringify({
        phase: "discarded",
        discardedAt: instant.toISOString(),
      }),
    ) - Buffer.byteLength(JSON.stringify(row)),
  ).toBe(23);
});

test.each([
  "apply",
  "discard",
] as const)("near-capacity held bytes survive foreign writes and permit exact %s", async (terminal) => {
  const f = fixture();
  const otherWorkspace = workspaceKey(join(f.home, "foreign-workspace"));
  const catalog = createProjectStore(f.home).read();
  writeOwnerOnly(
    projectCatalogPath(f.home),
    JSON.stringify({
      ...catalog,
      revision: 2,
      projects: catalog.projects.map((project) => ({
        ...project,
        workspaces: [
          ...project.workspaces,
          { ...project.workspaces[0], root: otherWorkspace },
        ],
      })),
    }),
  );
  const request = {
    ...f.request,
    expectedCatalogRevision: 2,
    rules: largeRules,
  };
  const pending = await f.store.reserve(f.projectId, request);
  const row = {
    ...usageThresholdPendingSchema.parse({
      original: pending.original,
      originalHash: pending.originalHash,
      reservedAt: pending.reservedAt,
    }),
    phase: "reserved" as const,
    discardedAt: null,
  };
  const fillers: Array<
    Omit<typeof row, "phase" | "discardedAt"> & {
      phase: "discarded";
      discardedAt: string;
    }
  > = [];
  const state = () => ({
    version: 2,
    documents: [],
    receipts: [],
    originals: [row, ...fillers],
  });
  const held = 2 * Buffer.byteLength(JSON.stringify(row.original)) + 512;
  for (let n = 2; n <= 256; n++) {
    const original = { ...row.original, requestId: nextId(n) };
    const next = {
      ...row,
      original,
      originalHash: digest(original),
      phase: "discarded" as const,
      discardedAt: row.reservedAt,
    };
    const candidate = { ...state(), originals: [...state().originals, next] };
    if (
      Buffer.byteLength(JSON.stringify(candidate)) + held >
      MAX_USAGE_POLICY_BYTES
    )
      break;
    fillers.push(next);
  }
  expect(fillers.length).toBeGreaterThan(0);
  const bytes = JSON.stringify(state());
  expect(Buffer.byteLength(bytes) + held).toBeLessThanOrEqual(
    MAX_USAGE_POLICY_BYTES,
  );
  expect(MAX_USAGE_POLICY_BYTES - Buffer.byteLength(bytes) - held).toBeLessThan(
    Buffer.byteLength(JSON.stringify(row)),
  );
  writeOwnerOnly(stateFile(f.home), bytes);
  expect(f.store.recovery().pending).toHaveLength(1);
  const foreign = createUsageThresholdStore(f.home, otherWorkspace, {
    now: () => new Date(instant),
  });
  expect(foreign.read(f.projectId).revision).toBe(0);
  const foreignRequest = {
    ...request,
    requestId: nextId(999),
    workspace: otherWorkspace,
  };
  const original = { ...foreignRequest, projectId: f.projectId };
  const receipt = usageThresholdReceiptSchema.parse({
    original,
    originalHash: digest(original),
    outcome: "applied",
    observedRevision: 0,
    resultingRevision: 1,
    settledAt: instant.toISOString(),
    refusalCode: null,
  });
  const wouldWrite = JSON.stringify({
    ...state(),
    documents: [
      {
        projectId: f.projectId,
        workspace: otherWorkspace,
        revision: 1,
        rules: largeRules,
      },
    ],
    receipts: [receipt],
  });
  expect(Buffer.byteLength(wouldWrite)).toBeLessThanOrEqual(
    MAX_USAGE_POLICY_BYTES,
  );
  expect(Buffer.byteLength(wouldWrite) + held).toBeGreaterThan(
    MAX_USAGE_POLICY_BYTES,
  );
  await expect(
    foreign.write(f.projectId, foreignRequest),
  ).rejects.toMatchObject({ status: 503, code: "history-full" });
  expect(readFileSync(stateFile(f.home), "utf8")).toBe(bytes);
  if (terminal === "apply")
    expect(
      (await f.store.applyReserved(f.projectId, request)).receipt.outcome,
    ).toBe("applied");
  else
    expect(
      (await f.store.discardReserved(f.projectId, requestId, pending.original))
        .phase,
    ).toBe("discarded");
  expect(f.store.reservation(f.projectId, requestId).phase).toBe(
    terminal === "apply" ? "applied" : "discarded",
  );
  expect(f.store.recovery().pending).toEqual([]);
  expect(readFileSync(stateFile(f.home)).length).toBeLessThanOrEqual(
    MAX_USAGE_POLICY_BYTES,
  );
});

test("legacy refused receipts replay beside a different pending original without changing either", async () => {
  const f = fixture();
  const first = await f.store.write(f.projectId, f.request);
  const request = { ...f.request, requestId: nextId(2), expectedRevision: 99 };
  const refused = await f.store.write(f.projectId, request);
  writeOwnerOnly(
    stateFile(f.home),
    JSON.stringify({
      version: 1,
      documents: [first.document],
      receipts: [first.receipt, refused.receipt],
    }),
  );
  const legacy = f.store.reservation(f.projectId, request.requestId);
  expect(legacy).toMatchObject({
    origin: "legacy-receipt",
    phase: "refused",
    reservedAt: null,
    receipt: refused.receipt,
  });
  const pending = await f.store.reserve(f.projectId, {
    ...f.request,
    requestId: nextId(3),
    expectedRevision: 1,
  });
  const before = readFileSync(stateFile(f.home));
  expect(await f.store.write(f.projectId, request)).toEqual(refused);
  expect(await f.store.applyReserved(f.projectId, request)).toEqual(refused);
  expect(await f.store.reserve(f.projectId, request)).toEqual(legacy);
  expect(
    await f.store.discardReserved(
      f.projectId,
      request.requestId,
      legacy.original,
    ),
  ).toEqual(legacy);
  expect(f.store.recovery().pending[0]?.original).toEqual(pending.original);
  expect(readFileSync(stateFile(f.home))).toEqual(before);
});

test("all256 retained UUIDs allow exact replay and discard but refuse a new original without eviction", async () => {
  const f = fixture();
  const pending = await f.store.reserve(f.projectId, f.request);
  const originals = Array.from({ length: 256 }, (_, index) => {
    const original = { ...pending.original, requestId: nextId(index + 1) };
    return {
      original,
      originalHash: digest(original),
      reservedAt: pending.reservedAt,
      phase: index === 0 ? "reserved" : "discarded",
      discardedAt: index === 0 ? null : pending.reservedAt,
    };
  });
  writeOwnerOnly(
    stateFile(f.home),
    JSON.stringify({
      version: 2,
      documents: [],
      receipts: [],
      originals,
    }),
  );
  expect(f.store.recovery().pending).toHaveLength(1);
  const before = readFileSync(stateFile(f.home));
  expect(await f.store.reserve(f.projectId, f.request)).toEqual(pending);
  expect(readFileSync(stateFile(f.home))).toEqual(before);
  expect(
    (await f.store.discardReserved(f.projectId, requestId, pending.original))
      .phase,
  ).toBe("discarded");
  const discarded = readFileSync(stateFile(f.home));
  await expect(
    f.store.reserve(f.projectId, { ...f.request, requestId: nextId(999) }),
  ).rejects.toMatchObject({ status: 503, code: "history-full" });
  expect(f.store.reservation(f.projectId, nextId(256)).phase).toBe("discarded");
  expect(readFileSync(stateFile(f.home))).toEqual(discarded);
});

test.each([
  true,
  false,
])("apply/discard serialize one immutable terminal when apply starts first=%s", async (applyFirst) => {
  const f = fixture();
  const pending = await f.store.reserve(f.projectId, f.request);
  const apply = () => f.store.applyReserved(f.projectId, f.request);
  const discard = () =>
    f.store.discardReserved(f.projectId, requestId, pending.original);
  const starts = applyFirst ? [apply(), discard()] : [discard(), apply()];
  const outcomes = await Promise.allSettled(starts);
  const final = f.store.reservation(f.projectId, requestId);
  expect(["applied", "discarded"]).toContain(final.phase);
  expect(final.document.revision).toBe(final.phase === "applied" ? 1 : 0);
  expect(f.store.recovery().pending).toEqual([]);
  const applied = outcomes[applyFirst ? 0 : 1];
  const discarded = outcomes[applyFirst ? 1 : 0];
  expect(discarded?.status).toBe("fulfilled");
  expect(applied?.status).toBe(
    final.phase === "applied" ? "fulfilled" : "rejected",
  );
  if (applied?.status === "rejected")
    expect(applied.reason).toMatchObject({ status: 409 });
  const before = readFileSync(stateFile(f.home));
  expect(await discard()).toEqual(final);
  expect(readFileSync(stateFile(f.home))).toEqual(before);
});
