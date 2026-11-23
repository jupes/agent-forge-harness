import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CHECKPOINT_REVIEW_INVENTORY_UNAVAILABLE,
  projectCheckpointReviewInventoryJson,
  projectCheckpointReviewInventoryReadSchema,
} from "../../types/project-checkpoint-review-inventory";
import {
  type ProjectCheckpointReviewBinding,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
} from "../../types/project-checkpoint-reviews";
import { createProjectCheckpointReviewRoutes } from "../hearth/routes/project-checkpoint-reviews";
import { writeOwnerOnly } from "../hearth/token";
import { readProjectCheckpointReviewDiscovery } from "./project-checkpoint-review-inventory";
import {
  createProjectCheckpointReviewStore,
  type ProjectCheckpointReviewQueueLock,
  readProjectCheckpointReviewInventory,
} from "./project-checkpoint-review-store";

const owned: string[] = [];
afterEach(() => {
  for (const base of owned.splice(0)) {
    if (
      dirname(resolve(base)) !== resolve(tmpdir()) ||
      !basename(base).startsWith("checkpoint-review-inventory-")
    )
      throw Error("Unexpected cleanup root");
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
});
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "checkpoint-review-inventory-"));
  owned.push(base);
  return {
    base,
    home: join(base, "home"),
    workspacePath: join(base, "workspace"),
    projectId: "project-12345678-1234-4234-8234-123456789abc",
  };
}
test("an empty owned scope is observed without creating private files or source publications", async () => {
  const f = fixture();
  const result = await readProjectCheckpointReviewDiscovery(f);
  expect(result).toMatchObject({
    available: true,
    schemaVersion: 1,
    scope: { projectId: f.projectId, workspacePath: f.workspacePath },
    coverage: "retained-review-records",
    records: [],
  });
  expect(existsSync(f.home)).toBe(false);
});

const stamp = "2026-11-13T00:00:00.000Z";
const memoryLock: ProjectCheckpointReviewQueueLock = async (_file, work) => ({
  ok: true,
  value: await work(),
});
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function binding(
  f: ReturnType<typeof fixture>,
  overrides: Partial<ProjectCheckpointReviewBinding> = {},
): ProjectCheckpointReviewBinding {
  return {
    projectId: f.projectId,
    workspacePath: f.workspacePath,
    checkout: f.workspacePath,
    runSlug: "missing-run",
    epicId: "forge-test",
    beadId: "forge-test.1",
    runUpdatedAt: stamp,
    catalogRevision: 1,
    scopeHash: "a".repeat(64),
    ...overrides,
  };
}
function original(bound: ProjectCheckpointReviewBinding, createdAt = stamp) {
  const saved = {
    schemaVersion: 1 as const,
    requestId: randomUUID(),
    binding: bound,
    decision: "approve" as const,
    note: "",
    createdAt,
    commentText: "",
    intentHash: "0".repeat(64),
  };
  saved.commentText = projectCheckpointReviewCommentText(saved);
  saved.intentHash = digest(projectCheckpointReviewIntentJson(saved));
  return saved;
}
const scopeOf = (bound: ProjectCheckpointReviewBinding) => ({
  projectId: bound.projectId,
  workspacePath: bound.workspacePath,
  runSlug: bound.runSlug,
  beadId: bound.beadId,
});
function storeFor(f: ReturnType<typeof fixture>) {
  return createProjectCheckpointReviewStore({
    home: f.home,
    withQueueLock: memoryLock,
    now: () => new Date(stamp),
  });
}
function journalFiles(f: ReturnType<typeof fixture>) {
  return readdirSync(join(f.home, "checkpoint-reviews"))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(f.home, "checkpoint-reviews", name));
}
async function savedReview(
  f: ReturnType<typeof fixture>,
  state:
    | "prepared"
    | "dispatching"
    | "unknown"
    | "confirmed"
    | "refused"
    | "retired",
  n: number,
  overrides: Partial<ProjectCheckpointReviewBinding> = {},
) {
  const store = storeFor(f),
    saved = original(binding(f, { beadId: "forge-test." + n, ...overrides })),
    scope = scopeOf(saved.binding);
  await store.prepare(saved, 1);
  if (state === "retired")
    await store.retire(scope, saved.requestId, saved.intentHash, 2);
  else if (state !== "prepared") {
    const claim = await store.claim(
      scope,
      saved.requestId,
      saved.intentHash,
      2,
    );
    if (claim.kind !== "claimed") throw Error("Expected fixture claim");
    if (state === "refused")
      await store.finish(claim.permit, { kind: "refused-before-dispatch" }, 3);
    else if (state !== "dispatching") {
      await store.finish(
        claim.permit,
        { kind: "unknown", reportedCommentId: null },
        3,
      );
      if (state === "confirmed")
        await store.recordReadback(
          scope,
          saved.requestId,
          saved.intentHash,
          {
            kind: "found",
            commentId: "exact-comment",
            body: saved.commentText,
          },
          4,
        );
    }
  }
  return { store, saved, scope };
}
test("retained states survive missing Runs, preserve exact originals and exclude other projects or workspaces", async () => {
  const f = fixture();
  const saved = [];
  for (const [i, state] of (
    [
      "prepared",
      "dispatching",
      "unknown",
      "confirmed",
      "refused",
      "retired",
    ] as const
  ).entries())
    saved.push(await savedReview(f, state, i + 1));
  await savedReview(f, "prepared", 7, {
    projectId: "project-12345678-1234-4234-8234-123456789abd",
  });
  await savedReview(f, "prepared", 8, {
    workspacePath: f.workspacePath + "-foreign",
  });
  const result = await readProjectCheckpointReviewDiscovery(f);
  expect(result.available).toBe(true);
  if (!result.available) throw Error(result.error);
  expect(result.records).toHaveLength(6);
  for (const item of saved) {
    const found = result.records.find(
      (row) => row.original.requestId === item.saved.requestId,
    );
    expect(found?.original).toEqual(item.saved);
  }
  expect(
    result.records.filter((row) => row.receipt.state === "unknown"),
  ).toHaveLength(2);
  expect(result.observationRevision).toBe(
    digest(projectCheckpointReviewInventoryJson(result.scope, result.records)),
  );
  expect(Object.isFrozen(result.records)).toBe(true);
});
test("a valid owner mutation between collections is unavailable rather than a mixed receipt snapshot", async () => {
  const f = fixture(),
    row = await savedReview(f, "prepared", 1);
  const changed = await readProjectCheckpointReviewDiscovery({
    ...f,
    afterFirstCollection: async () => {
      await row.store.retire(
        row.scope,
        row.saved.requestId,
        row.saved.intentHash,
        2,
      );
    },
  });
  expect(changed).toEqual({
    available: false,
    error: CHECKPOINT_REVIEW_INVENTORY_UNAVAILABLE,
  });
  const after = await readProjectCheckpointReviewDiscovery(f);
  expect(after.available && after.records[0]?.receipt.state).toBe("retired");
});
test("unrecognized JSON sidecars are never treated as harmless SQLite lock files", async () => {
  const f = fixture();
  await savedReview(f, "prepared", 1);
  const file = journalFiles(f)[0];
  if (!file) throw Error("Missing fixture journal");
  writeOwnerOnly(
    file.replace(/\.json$/, ".lock.db-wal"),
    "inert SQLite sidecar",
  );
  expect((await readProjectCheckpointReviewDiscovery(f)).available).toBe(true);
  writeOwnerOnly(file + "-wal", "unrecognized private entry");
  expect((await readProjectCheckpointReviewDiscovery(f)).available).toBe(false);
});
test("corrupt, lost anchored and hardlinked journals are unavailable and preserve targets", async () => {
  for (const mode of ["corrupt", "missing", "linked"] as const) {
    const f = fixture();
    await savedReview(f, "prepared", 1);
    const file = journalFiles(f)[0];
    if (!file) throw Error("Missing fixture journal");
    const before = readFileSync(file, "utf8");
    if (mode === "corrupt") writeOwnerOnly(file, "{");
    else if (mode === "missing") unlinkSync(file);
    else linkSync(file, join(f.base, "untouched-linked-target"));
    const result = await readProjectCheckpointReviewDiscovery(f);
    expect(result.available).toBe(false);
    if (mode === "linked")
      expect(
        readFileSync(join(f.base, "untouched-linked-target"), "utf8"),
      ).toBe(before);
  }
});

test("the protected retained-review row uses host scope and closes without any source or tracker effect", async () => {
  const f = fixture();
  await savedReview(f, "prepared", 1);
  let effects = 0;
  const unexpected = async () => {
    effects++;
    throw Error("Unexpected source or tracker effect");
  };
  const routes = createProjectCheckpointReviewRoutes({
    home: f.home,
    workspace: f.workspacePath,
    appendEvent: () => {
      effects++;
      return { ok: true, id: 1, ulid: "inert" };
    },
    queueLock: memoryLock,
    runBd: unexpected,
    resolveAuthority: unexpected,
    readScope: () => {
      effects++;
      throw Error("Current scope must not gate retained inventory");
    },
    source: {
      checkout: f.workspacePath,
      resolveCurrentAuthority: unexpected,
      capture: { capture: unexpected, close: async () => {} },
    },
  });
  try {
    const row = routes.reads.find(
      (item) => item.path === "/projects/:id/checkpoint-reviews",
    );
    expect(row).toBeDefined();
    if (!row) throw Error("Missing retained-review row");
    expect(row.operatorOnly).toBe(true);
    const request = {
      params: { id: f.projectId },
      query: new URLSearchParams(),
      headers: {},
      body: null,
    };
    const checked = row.validate(request);
    if (!checked.ok) throw Error("Invalid route fixture");
    expect(await row.read(checked.value)).toEqual({
      status: 200,
      data: await readProjectCheckpointReviewDiscovery(f),
    });
    request.query.set("workspace", "/other");
    expect(row.validate(request).ok).toBe(false);
    request.query.delete("workspace");
    request.params.id = "wrong";
    expect(row.validate(request).ok).toBe(false);
    await routes.close();
    expect((await row.read(checked.value)).status).toBe(503);
    expect(effects).toBe(0);
  } finally {
    await routes.close();
  }
});

test("same-family records retain owner insertion order when original clocks move backwards", async () => {
  const f = fixture(),
    store = storeFor(f),
    first = original(binding(f)),
    second = original(binding(f), "2026-11-12T00:00:00.000Z"),
    scope = scopeOf(first.binding);
  for (const saved of [first, second]) {
    await store.prepare(saved, 1);
    await store.retire(scope, saved.requestId, saved.intentHash, 2);
  }
  const result = await readProjectCheckpointReviewDiscovery(f);
  if (!result.available) throw Error(result.error);
  expect(result.records.map((row) => row.original.requestId)).toEqual([
    first.requestId,
    second.requestId,
  ]);
});
test("source-only publications are outside Review coverage and their anchor loss remains unavailable", async () => {
  const f = fixture(),
    bound = binding(f),
    sourceVersion = {
      kind: "committed-git-snapshot" as const,
      commit: "b".repeat(40),
      tree: "c".repeat(40),
    };
  const store = createProjectCheckpointReviewStore({
    home: f.home,
    withQueueLock: memoryLock,
    now: () => new Date(stamp),
    admit: async (_id, work) => work(),
    submission: {
      resolveSnapshot: async () => ({ binding: bound, sourceVersion }),
    },
  });
  const published = await store.publishSubmission(
    {
      schemaVersion: 1,
      kind: "publish",
      requestId: randomUUID(),
      binding: bound,
      sourceVersion,
      expectedSubmissionGeneration: 0,
    },
    1,
  );
  const result = await readProjectCheckpointReviewDiscovery(f);
  expect(result).toMatchObject({
    available: true,
    coverage: "retained-review-records",
    records: [],
  });
  expect(store.submissionInventory(scopeOf(bound)).items).toEqual([
    published.record,
  ]);
  const file = journalFiles(f)[0];
  if (!file) throw Error("Missing source journal");
  unlinkSync(join(f.home, "checkpoint-review-anchors", basename(file)));
  expect((await readProjectCheckpointReviewDiscovery(f)).available).toBe(false);
});
test("new families between collections and elapsed budget exhaustion cannot appear complete", async () => {
  const f = fixture();
  await savedReview(f, "prepared", 1);
  expect(
    (
      await readProjectCheckpointReviewDiscovery({
        ...f,
        afterFirstCollection: async () => {
          await savedReview(f, "prepared", 2);
        },
      })
    ).available,
  ).toBe(false);
  let ticks = 0;
  expect(
    (
      await readProjectCheckpointReviewDiscovery({
        ...f,
        now: () => (ticks++ === 0 ? 0 : 2001),
      })
    ).available,
  ).toBe(false);
});
test("the bounded family set refuses the 65th valid owner journal without truncation", async () => {
  const f = fixture();
  for (let n = 1; n <= 64; n++) await savedReview(f, "prepared", n);
  // Freeze only the injected elapsed clock to isolate this size boundary; process/case bounds stay unchanged.
  const before = await readProjectCheckpointReviewDiscovery({
    ...f,
    now: () => 0,
  });
  expect(before.available && before.records.length).toBe(64);
  await savedReview(f, "prepared", 65);
  expect(
    (await readProjectCheckpointReviewDiscovery({ ...f, now: () => 0 }))
      .available,
  ).toBe(false);
});
test("valid private journals whose public expansion exceeds the full envelope ceiling are unavailable", async () => {
  const f = fixture(),
    store = storeFor(f),
    longStamp = "2026-11-13T00:00:00." + "1".repeat(20000) + "Z";
  for (let family = 1; family <= 3; family++) {
    const bound = binding(f, { beadId: "forge-test." + family }),
      scope = scopeOf(bound);
    for (let n = 0; n < 25; n++) {
      const saved = original(bound, longStamp);
      await store.prepare(saved, 1);
      await store.retire(scope, saved.requestId, saved.intentHash, 2);
    }
  }
  const stored = readProjectCheckpointReviewInventory(
    f.home,
    journalFiles(f),
    f.projectId,
  );
  expect(stored).toHaveLength(75);
  const payload = {
    schemaVersion: 1,
    scope: { projectId: f.projectId, workspacePath: f.workspacePath },
    coverage: "retained-review-records",
    records: stored.map((row) => ({
      original: row.original,
      receipt: row.receipt,
      metadata: {
        schemaVersion: 1,
        requestId: row.original.requestId,
        intentHash: row.original.intentHash,
        scope: row.scope,
        state: row.receipt.state,
        commentId: row.receipt.commentId,
        createdAt: row.original.createdAt,
        updatedAt: row.receipt.updatedAt,
      },
    })),
  };
  const candidate = {
    available: true,
    ...payload,
    observationRevision: "a".repeat(64),
  };
  expect(
    new TextEncoder().encode(
      JSON.stringify({ ok: true, data: candidate, error: null }),
    ).byteLength,
  ).toBeGreaterThan(4 * 1024 * 1024);
  expect(
    projectCheckpointReviewInventoryReadSchema.safeParse(candidate).success,
  ).toBe(false);
  expect(
    (await readProjectCheckpointReviewDiscovery({ ...f, now: () => 0 }))
      .available,
  ).toBe(false);
});

test("canonical host workspace comparison preserves the exact original spelling", async () => {
  const f = fixture(),
    saved = await savedReview(f, "prepared", 1),
    alias = f.workspacePath.replaceAll("\\", "/") + "/";
  const result = await readProjectCheckpointReviewDiscovery({
    ...f,
    workspacePath: alias,
  });
  if (!result.available) throw Error(result.error);
  expect(result.records[0]?.original).toEqual(saved.saved);
  expect(result.scope.workspacePath).toBe(alias);
});
test("strict receiving count limits reject the 1001st complete canonical Review row", async () => {
  const f = fixture();
  await savedReview(f, "prepared", 1);
  const base = await readProjectCheckpointReviewDiscovery(f);
  if (!base.available) throw Error(base.error);
  const row = base.records[0];
  if (!row) throw Error("Missing fixture Review");
  const records = Array.from({ length: 1001 }, () => {
    const saved = original(binding(f));
    return {
      ...row,
      original: saved,
      metadata: {
        ...row.metadata,
        requestId: saved.requestId,
        intentHash: saved.intentHash,
      },
      receipt: {
        ...row.receipt,
        requestId: saved.requestId,
        intentHash: saved.intentHash,
      },
    };
  });
  expect(
    projectCheckpointReviewInventoryReadSchema.safeParse({
      ...base,
      records: records.slice(0, 1000),
    }).success,
  ).toBe(true);
  expect(
    projectCheckpointReviewInventoryReadSchema.safeParse({ ...base, records })
      .success,
  ).toBe(false);
});
test("the transport envelope is counted even when the DTO alone fits its byte ceiling", async () => {
  const f = fixture();
  await savedReview(f, "prepared", 1);
  const base = await readProjectCheckpointReviewDiscovery(f);
  if (!base.available) throw Error(base.error);
  const captured = base.records[0];
  if (!captured) throw Error("Missing fixture Review");
  const row = structuredClone(captured);
  const prefix = "2026-11-13T00:00:00.",
    initial = prefix + "1Z";
  row.metadata.updatedAt = initial;
  row.receipt.updatedAt = initial;
  const candidate = { ...base, records: [row] },
    initialBytes = new TextEncoder().encode(
      JSON.stringify(candidate),
    ).byteLength;
  const fraction = "1".repeat(
      1 + Math.floor((4 * 1024 * 1024 - initialBytes - 16) / 2),
    ),
    updatedAt = prefix + fraction + "Z";
  row.metadata.updatedAt = updatedAt;
  row.receipt.updatedAt = updatedAt;
  expect(
    new TextEncoder().encode(JSON.stringify(candidate)).byteLength,
  ).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(
    new TextEncoder().encode(
      JSON.stringify({ ok: true, data: candidate, error: null }),
    ).byteLength,
  ).toBeGreaterThan(4 * 1024 * 1024);
  expect(
    projectCheckpointReviewInventoryReadSchema.safeParse(candidate).success,
  ).toBe(false);
});
