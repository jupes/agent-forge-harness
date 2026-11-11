import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { inboxUsageRulesDocumentSchema } from "../../types/inbox-usage";
import { assertOwnerOnly, makeOwnerOnly } from "../hearth/acl-windows";
import { writeOwnerOnly } from "../hearth/token";
import { workspaceKey } from "./scope";
import { createProjectStore, projectCatalogPath } from "./store";
import { projectCatalogFixture } from "./testing";
import {
  createUsageThresholdStore,
  MAX_USAGE_POLICY_BYTES,
  MAX_USAGE_POLICY_DOCUMENTS,
  MAX_USAGE_POLICY_ORIGINALS,
  type UsageThresholdReceipt,
  type UsageThresholdRequest,
  usageThresholdRequestSchema,
} from "./usage-threshold-store";

const homes: string[] = [];
const requestId = "bb000000-0000-4000-8000-000000000001";
const ruleId = "aa000000-0000-4000-8000-000000000001";
const instant = new Date("2026-11-11T11:00:00.000Z");
afterEach(() => {
  for (const home of homes.splice(0)) {
    const target = realpathSync(home);
    if (
      dirname(target) !== realpathSync(tmpdir()) ||
      !basename(target).startsWith("forge-usage-policy-")
    )
      throw Error("Unsafe owned fixture cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture(
  options: Parameters<typeof createUsageThresholdStore>[2] = {},
) {
  const home = mkdtempSync(join(tmpdir(), "forge-usage-policy-"));
  homes.push(home);
  const workspace = workspaceKey(home);
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify(projectCatalogFixture(workspace)),
  );
  const project = createProjectStore(home).read().projects[0];
  if (!project) throw Error("Invalid catalog fixture");
  const request: UsageThresholdRequest = {
    requestId,
    workspace,
    expectedCatalogRevision: 1,
    expectedRevision: 0,
    rules: [
      {
        id: ruleId,
        provider: "claude",
        enabled: true,
        selector: {
          kind: "subscription-window",
          unit: "percent",
          source: "provider-cli",
          label: "private report window",
          basis: "used",
        },
        comparison: "at-least",
        threshold: 80,
      },
    ],
  };
  return {
    home,
    workspace,
    projectId: project.id,
    request,
    projects: createProjectStore(home),
    store: createUsageThresholdStore(home, workspace, {
      now: () => new Date(instant),
      ...options,
    }),
  };
}
test("the temporary owned catalog and explicit policy request satisfy actual source contracts", () => {
  const f = fixture();
  expect(f.projects.read()).toMatchObject({
    revision: 1,
    projects: [{ id: f.projectId, archived: false }],
  });
  expect(usageThresholdRequestSchema.parse(f.request)).toEqual(f.request);
});

test("one valid scoped save atomically retains the policy and exact original receipt", async () => {
  const f = fixture();
  const result = await f.store.write(f.projectId, f.request);
  expect(result).toMatchObject({
    document: {
      projectId: f.projectId,
      workspace: f.workspace,
      revision: 1,
      rules: f.request.rules,
    },
    receipt: {
      original: { projectId: f.projectId, ...f.request },
      outcome: "applied",
      observedRevision: 0,
      resultingRevision: 1,
      settledAt: instant.toISOString(),
      refusalCode: null,
    },
  });
  expect(result.receipt.originalHash).toMatch(/^[a-f0-9]{64}$/);
  expect(f.store.original(f.projectId, requestId)).toEqual(result);
  expect(
    createUsageThresholdStore(f.home, f.workspace).read(f.projectId),
  ).toEqual(result.document);
  expect(f.projects.read().revision).toBe(1);
});

const stateFile = (home: string) =>
  join(home, "usage-threshold-settings", "state.json");
const markerFile = (home: string) =>
  join(home, "projects", "usage-threshold-settings.initialized");
const nextId = (n: number) =>
  "bb000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
function seal(row: UsageThresholdReceipt) {
  row.originalHash = createHash("sha256")
    .update(canonical(row.original))
    .digest("hex");
  return row;
}
function rulesWithLargeLabels(request: UsageThresholdRequest) {
  const rule = request.rules[0];
  if (!rule) throw Error("Missing fixture rule");
  return Array.from({ length: 100 }, (_, n) => ({
    ...structuredClone(rule),
    id: "aa000000-0000-4000-8000-" + (n + 1).toString(16).padStart(12, "0"),
    selector: { ...rule.selector, label: "界".repeat(2048) },
  }));
}
test("same UUID is immutable, replay does not renew, and newer policy is separate from an older receipt", async () => {
  let writes = 0;
  const f = fixture({
    afterWrite: () => {
      writes++;
    },
  });
  expect(f.store.read(f.projectId)).toEqual({
    projectId: f.projectId,
    workspace: f.workspace,
    revision: 0,
    rules: [],
  });
  const first = await f.store.write(f.projectId, f.request),
    before = readFileSync(stateFile(f.home), "utf8");
  expect(await f.store.write(f.projectId, structuredClone(f.request))).toEqual(
    first,
  );
  expect(writes).toBe(1);
  expect(readFileSync(stateFile(f.home), "utf8")).toBe(before);
  for (const changed of [
    { ...f.request, expectedRevision: 1 },
    { ...f.request, expectedCatalogRevision: 2 },
    { ...f.request, rules: [] },
  ])
    await expect(f.store.write(f.projectId, changed)).rejects.toMatchObject({
      status: 409,
    });
  await expect(
    f.store.write("project-00000000-0000-4000-8000-000000000002", f.request),
  ).rejects.toMatchObject({ status: 409 });
  const second = await f.store.write(f.projectId, {
    ...f.request,
    requestId: nextId(2),
    expectedRevision: 1,
    rules: [],
  });
  const replay = await f.store.write(f.projectId, f.request);
  expect(replay.receipt).toEqual(first.receipt);
  expect(replay.document).toEqual(second.document);
  expect(replay.document.revision).toBe(2);
  expect(writes).toBe(2);
});
test("concurrent policy CAS applies once and retains an exact observed-revision refusal", async () => {
  const f = fixture();
  const other = createUsageThresholdStore(f.home, f.workspace);
  const results = await Promise.all([
    f.store.write(f.projectId, f.request),
    other.write(f.projectId, { ...f.request, requestId: nextId(2) }),
  ]);
  expect(results.map((row) => row.receipt.outcome).sort()).toEqual([
    "applied",
    "refused",
  ]);
  const refused = results.find((row) => row.receipt.outcome === "refused");
  expect(refused?.receipt).toMatchObject({
    observedRevision: 1,
    resultingRevision: 1,
    refusalCode: "policy-revision-conflict",
  });
  expect(f.store.read(f.projectId).revision).toBe(1);
  const initial = fixture();
  const refusal = await initial.store.write(initial.projectId, {
    ...initial.request,
    expectedRevision: 1,
  });
  expect(refusal).toMatchObject({
    document: { revision: 0, rules: [] },
    receipt: { outcome: "refused", observedRevision: 0, resultingRevision: 0 },
  });
});
test("domain lease stays outside first-use storage and project archive wins before admission", async () => {
  const f = fixture();
  let reached = false;
  const store = createUsageThresholdStore(f.home, f.workspace, {
    beforeAdmission: async () => {
      reached = true;
      expect(store.read(f.projectId).revision).toBe(0);
      expect(
        existsSync(
          join(f.home, "projects", "usage-threshold-settings.lock.db"),
        ),
      ).toBe(true);
      expect(existsSync(join(f.home, "usage-threshold-settings"))).toBe(false);
      await f.projects.preferences(f.projectId, 1, { archived: true });
    },
  });
  await expect(store.write(f.projectId, f.request)).rejects.toMatchObject({
    status: 409,
  });
  expect(reached).toBe(true);
  expect(existsSync(stateFile(f.home))).toBe(false);
  expect(existsSync(markerFile(f.home))).toBe(false);
});
test("catalog and workspace changes refuse new policy while retained originals survive archive or removal", async () => {
  const f = fixture();
  const first = await f.store.write(f.projectId, f.request);
  await f.projects.preferences(f.projectId, 1, { archived: true });
  expect((await f.store.write(f.projectId, f.request)).receipt).toEqual(
    first.receipt,
  );
  await expect(
    f.store.write(f.projectId, {
      ...f.request,
      requestId: nextId(2),
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const catalog = f.projects.read();
  catalog.projects = [];
  catalog.revision++;
  writeOwnerOnly(projectCatalogPath(f.home), JSON.stringify(catalog));
  expect(f.store.original(f.projectId, requestId).receipt).toEqual(
    first.receipt,
  );
  expect((await f.store.write(f.projectId, f.request)).receipt).toEqual(
    first.receipt,
  );
  expect(() =>
    createUsageThresholdStore(f.home, f.workspace + "/foreign").original(
      f.projectId,
      requestId,
    ),
  ).toThrow();
  await expect(
    createUsageThresholdStore(f.home, f.workspace + "/foreign").write(
      f.projectId,
      f.request,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const changed = fixture();
  await changed.projects.preferences(changed.projectId, 1, { pinned: true });
  await expect(
    changed.store.write(changed.projectId, changed.request),
  ).rejects.toMatchObject({ status: 409 });
  expect(existsSync(stateFile(changed.home))).toBe(false);
});
test("entire original and server binding are captured before lock awaits", async () => {
  const f = fixture();
  const captured = structuredClone(f.request);
  const pending = f.store.write(f.projectId, f.request);
  f.request.workspace += "/foreign";
  f.request.expectedRevision = 99;
  f.request.expectedCatalogRevision = 99;
  f.request.rules = [];
  const result = await pending;
  expect(result.receipt.original).toEqual({
    projectId: f.projectId,
    ...captured,
  });
  expect(result.document.rules).toEqual(captured.rules);
});
test("persist-then-throw retains exact recovery and never evaluates private error getters", async () => {
  let writes = 0,
    getterReads = 0;
  const f = fixture({
    afterWrite: () => {
      writes++;
      throw {
        get message() {
          getterReads++;
          throw Error("private getter");
        },
      };
    },
  });
  await expect(f.store.write(f.projectId, f.request)).rejects.toMatchObject({
    status: 504,
    code: "outcome-unknown",
  });
  const original = f.store.original(f.projectId, requestId);
  expect(original.receipt.outcome).toBe("applied");
  expect((await f.store.write(f.projectId, f.request)).receipt).toEqual(
    original.receipt,
  );
  expect(writes).toBe(1);
  expect(getterReads).toBe(0);
});
test("lost marker, lost state and lost files in an initialized directory never become empty defaults", async () => {
  for (const loss of ["marker", "state", "both"] as const) {
    const f = fixture();
    await f.store.write(f.projectId, f.request);
    if (loss !== "state") unlinkSync(markerFile(f.home));
    if (loss !== "marker") unlinkSync(stateFile(f.home));
    expect(() => f.store.read(f.projectId)).toThrow();
    expect(() => f.store.original(f.projectId, requestId)).toThrow();
    await expect(
      f.store.write(f.projectId, { ...f.request, requestId: nextId(2) }),
    ).rejects.toMatchObject({ status: 503 });
  }
});
test("corrupt bytes, over-limit state and shared hard links refuse without overwriting any original", async () => {
  for (const corrupt of [
    "private invalid JSON",
    " ".repeat(MAX_USAGE_POLICY_BYTES + 1),
  ]) {
    const f = fixture();
    await f.store.write(f.projectId, f.request);
    writeOwnerOnly(stateFile(f.home), corrupt);
    await expect(
      f.store.write(f.projectId, { ...f.request, requestId: nextId(2) }),
    ).rejects.toMatchObject({ status: 503 });
    expect(readFileSync(stateFile(f.home), "utf8")).toBe(corrupt);
  }
  const f = fixture();
  const original = await f.store.write(f.projectId, f.request);
  const bytes = readFileSync(stateFile(f.home), "utf8");
  // Link a fresh owned inode before privacy sealing; publication never touches it afterward.
  const linkHome = mkdtempSync(join(tmpdir(), "forge-usage-policy-"));
  homes.push(linkHome);
  const fresh = join(linkHome, "fresh-state.json"),
    alias = join(linkHome, "owned-state-alias.json");
  writeFileSync(fresh, bytes, { flag: "wx", mode: 0o600 });
  linkSync(fresh, alias);
  if (process.platform === "win32") {
    makeOwnerOnly(fresh, "file");
    assertOwnerOnly(fresh, "file");
    assertOwnerOnly(alias, "file");
  } else {
    chmodSync(fresh, 0o600);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  }
  expect(statSync(fresh).nlink).toBeGreaterThanOrEqual(2);
  expect(statSync(alias).ino).toBe(statSync(fresh).ino);
  expect(readFileSync(alias, "utf8")).toBe(bytes);
  expect(f.store.original(f.projectId, requestId).receipt).toEqual(
    original.receipt,
  );
  unlinkSync(stateFile(f.home));
  renameSync(fresh, stateFile(f.home));
  expect(statSync(stateFile(f.home)).nlink).toBeGreaterThanOrEqual(2);
  expect(statSync(stateFile(f.home)).ino).toBe(statSync(alias).ino);
  await expect(
    f.store.write(f.projectId, { ...f.request, requestId: nextId(2) }),
  ).rejects.toMatchObject({ status: 503 });
  expect(readFileSync(stateFile(f.home), "utf8")).toBe(bytes);
  expect(readFileSync(alias, "utf8")).toBe(bytes);
  expect(statSync(stateFile(f.home)).nlink).toBeGreaterThanOrEqual(2);
});
test("invalid and oversized requests fail before policy publication with fixed private errors", async () => {
  const f = fixture();
  for (const body of [
    { ...f.request, requestId: requestId.toUpperCase() },
    { ...f.request, extra: "private raw" },
    { ...f.request, expectedRevision: -1 },
    { ...f.request, expectedCatalogRevision: Number.POSITIVE_INFINITY },
    { ...f.request, rules: rulesWithLargeLabels(f.request) },
  ]) {
    await expect(f.store.write(f.projectId, body)).rejects.toMatchObject({
      status: 400,
    });
    expect(existsSync(stateFile(f.home))).toBe(false);
    expect(existsSync(markerFile(f.home))).toBe(false);
  }
  expect(f.store.read(f.projectId).revision).toBe(0);
});
test("full immutable history preserves exact replay and refuses a new original without eviction", async () => {
  const f = fixture();
  const first = await f.store.write(f.projectId, f.request);
  const receipts = [structuredClone(first.receipt)];
  for (let i = 2; i <= MAX_USAGE_POLICY_ORIGINALS; i++)
    receipts.push(
      seal({
        ...structuredClone(first.receipt),
        original: {
          ...structuredClone(first.receipt.original),
          requestId: nextId(i),
        },
        outcome: "refused",
        observedRevision: 1,
        resultingRevision: 1,
        refusalCode: "policy-revision-conflict",
      }),
    );
  writeOwnerOnly(
    stateFile(f.home),
    JSON.stringify({ version: 1, documents: [first.document], receipts }),
  );
  expect(f.store.original(f.projectId, requestId).receipt).toEqual(
    first.receipt,
  );
  const bytes = readFileSync(stateFile(f.home), "utf8");
  expect((await f.store.write(f.projectId, f.request)).receipt).toEqual(
    first.receipt,
  );
  await expect(
    f.store.write(f.projectId, {
      ...f.request,
      requestId: nextId(999),
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ status: 503, code: "history-full" });
  expect(readFileSync(stateFile(f.home), "utf8")).toBe(bytes);
});
test("retained state cannot contain an original larger than any admitted request", async () => {
  const f = fixture();
  const first = await f.store.write(f.projectId, f.request),
    big = rulesWithLargeLabels(f.request);
  const doc = { ...structuredClone(first.document), rules: big },
    receipt = seal({
      ...structuredClone(first.receipt),
      original: { ...structuredClone(first.receipt.original), rules: big },
    });
  expect(inboxUsageRulesDocumentSchema.safeParse(doc).success).toBe(true);
  expect(
    usageThresholdRequestSchema.safeParse({ ...f.request, rules: big }).success,
  ).toBe(true);
  writeOwnerOnly(
    stateFile(f.home),
    JSON.stringify({ version: 1, documents: [doc], receipts: [receipt] }),
  );
  expect(() => f.store.original(f.projectId, requestId)).toThrow();
});
test("retained state refusal revisions must reflect the actual preceding policy history", async () => {
  const f = fixture();
  const first = await f.store.write(f.projectId, f.request);
  const premature = seal({
    ...structuredClone(first.receipt),
    original: {
      ...structuredClone(first.receipt.original),
      requestId: nextId(2),
    },
    outcome: "refused",
    observedRevision: 1,
    resultingRevision: 1,
    refusalCode: "policy-revision-conflict",
  });
  writeOwnerOnly(
    stateFile(f.home),
    JSON.stringify({
      version: 1,
      documents: [first.document],
      receipts: [premature, first.receipt],
    }),
  );
  expect(() => f.store.original(f.projectId, requestId)).toThrow();
});

test("retained hash, UUID, policy payload and complete applied-chain contradictions are never repaired or reset", async () => {
  const mutate: ((
    row: UsageThresholdReceipt,
    doc: ReturnType<ReturnType<typeof createUsageThresholdStore>["read"]>,
  ) => unknown)[] = [
    (row, doc) => ({ version: 1, documents: [doc], receipts: [row, row] }),
    (row, doc) => ({ version: 1, documents: [doc, doc], receipts: [row] }),
    (row, doc) => ({
      version: 1,
      documents: [doc],
      receipts: [{ ...row, originalHash: "0".repeat(64) }],
    }),
    (row, doc) => ({
      version: 1,
      documents: [{ ...doc, revision: 2 }],
      receipts: [row],
    }),
    (row, doc) => ({
      version: 1,
      documents: [{ ...doc, rules: [] }],
      receipts: [row],
    }),
    (row) => ({ version: 1, documents: [], receipts: [row] }),
    (_row, doc) => ({ version: 1, documents: [doc], receipts: [] }),
    (row, doc) => ({
      version: 1,
      documents: [doc],
      receipts: [
        row,
        seal({
          ...structuredClone(row),
          original: { ...structuredClone(row.original), requestId: nextId(2) },
        }),
      ],
    }),
    (row, doc) => ({
      version: 1,
      documents: [{ ...doc, revision: 2 }],
      receipts: [
        seal({
          ...row,
          original: { ...row.original, expectedRevision: 1 },
          observedRevision: 1,
          resultingRevision: 2,
        }),
      ],
    }),
    (row, doc) => ({ version: 2, documents: [doc], receipts: [row] }),
  ];
  for (const change of mutate) {
    const f = fixture();
    const first = await f.store.write(f.projectId, f.request);
    const content = JSON.stringify(
      change(structuredClone(first.receipt), structuredClone(first.document)),
    );
    writeOwnerOnly(stateFile(f.home), content);
    await expect(
      f.store.write(f.projectId, {
        ...f.request,
        requestId: nextId(999),
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(readFileSync(stateFile(f.home), "utf8")).toBe(content);
  }
  const f = fixture();
  await f.store.write(f.projectId, f.request);
  writeOwnerOnly(markerFile(f.home), "private corrupt marker");
  expect(() => f.store.original(f.projectId, requestId)).toThrow();
  await expect(
    f.store.write(f.projectId, { ...f.request, requestId: nextId(2) }),
  ).rejects.toMatchObject({ status: 503 });
});
test("document capacity refuses a new scoped policy while exact recovery remains usable", async () => {
  const f = fixture();
  const first = await f.store.write(f.projectId, f.request),
    documents = [structuredClone(first.document)],
    receipts = [structuredClone(first.receipt)];
  for (let i = 1; i < MAX_USAGE_POLICY_DOCUMENTS; i++) {
    const id =
      "project-" +
      i.toString(16).padStart(8, "0") +
      "-0000-4000-8000-000000000000";
    documents.push({ ...structuredClone(first.document), projectId: id });
    receipts.push(
      seal({
        ...structuredClone(first.receipt),
        original: {
          ...structuredClone(first.receipt.original),
          projectId: id,
          requestId: nextId(i + 1),
        },
      }),
    );
  }
  writeOwnerOnly(
    stateFile(f.home),
    JSON.stringify({ version: 1, documents, receipts }),
  );
  expect(f.store.original(f.projectId, requestId).receipt).toEqual(
    first.receipt,
  );
  const bytes = readFileSync(stateFile(f.home), "utf8");
  const catalog = f.projects.read(),
    base = catalog.projects[0];
  if (!base) throw Error("Missing catalog fixture");
  const id = "project-ffffffff-0000-4000-8000-000000000000";
  catalog.projects.push({
    ...structuredClone(base),
    id,
    slug: "extra-policy",
    name: "Extra policy",
  });
  catalog.revision++;
  writeOwnerOnly(projectCatalogPath(f.home), JSON.stringify(catalog));
  await expect(
    f.store.write(id, {
      ...f.request,
      requestId: nextId(999),
      expectedCatalogRevision: catalog.revision,
    }),
  ).rejects.toMatchObject({ status: 503, code: "history-full" });
  expect(readFileSync(stateFile(f.home), "utf8")).toBe(bytes);
  expect((await f.store.write(f.projectId, f.request)).receipt).toEqual(
    first.receipt,
  );
});
test("serialized-size preflight refuses before publication and preserves a fully valid existing journal", async () => {
  const f = fixture();
  const first = await f.store.write(f.projectId, f.request),
    receipts = [structuredClone(first.receipt)];
  const big = rulesWithLargeLabels(f.request).map((rule) => ({
    ...rule,
    selector: { ...rule.selector, label: "a".repeat(2048) },
  }));
  let n = 2;
  for (;;) {
    const row = seal({
      ...structuredClone(first.receipt),
      original: {
        ...structuredClone(first.receipt.original),
        requestId: nextId(n++),
        rules: big,
      },
      outcome: "refused",
      observedRevision: 1,
      resultingRevision: 1,
      refusalCode: "policy-revision-conflict",
    });
    const candidate = {
      version: 1,
      documents: [first.document],
      receipts: [...receipts, row],
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_USAGE_POLICY_BYTES)
      break;
    receipts.push(row);
  }
  const bytes = JSON.stringify({
    version: 1,
    documents: [first.document],
    receipts,
  });
  writeOwnerOnly(stateFile(f.home), bytes);
  expect(f.store.original(f.projectId, requestId).receipt).toEqual(
    first.receipt,
  );
  await expect(
    f.store.write(f.projectId, {
      ...f.request,
      requestId: nextId(999),
      expectedRevision: 1,
      rules: big,
    }),
  ).rejects.toMatchObject({ status: 503, code: "history-full" });
  expect(readFileSync(stateFile(f.home), "utf8")).toBe(bytes);
  expect(f.store.read(f.projectId).revision).toBe(1);
});

test("an initialized empty journal cannot reset policy or original history", async () => {
  const f = fixture();
  await f.store.write(f.projectId, f.request);
  const reset = JSON.stringify({ version: 1, documents: [], receipts: [] });
  writeOwnerOnly(stateFile(f.home), reset);
  const marker = readFileSync(markerFile(f.home), "utf8");
  expect(() => f.store.read(f.projectId)).toThrow();
  expect(() => f.store.original(f.projectId, requestId)).toThrow();
  await expect(
    f.store.write(f.projectId, { ...f.request, requestId: nextId(2) }),
  ).rejects.toMatchObject({ status: 503 });
  expect(readFileSync(stateFile(f.home), "utf8")).toBe(reset);
  expect(readFileSync(markerFile(f.home), "utf8")).toBe(marker);
  const fresh = fixture();
  expect(fresh.store.read(fresh.projectId).revision).toBe(0);
  const explicit = await fresh.store.write(fresh.projectId, {
    ...fresh.request,
    rules: [],
  });
  expect(explicit.document).toMatchObject({ revision: 1, rules: [] });
  expect(fresh.store.original(fresh.projectId, requestId).receipt).toEqual(
    explicit.receipt,
  );
});
