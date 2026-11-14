import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CHECKPOINT_INBOX_CONTEXT_MAX_BYTES,
  CHECKPOINT_INBOX_CONTEXT_UNAVAILABLE,
  projectCheckpointInboxContextReadSchema,
} from "../../types/project-checkpoint-inbox-context";
import {
  type ProjectCheckpointReviewBinding,
  projectCheckpointReviewBindingSchema,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalSchema,
} from "../../types/project-checkpoint-reviews";
import { createProjectCheckpointReviewRoutes } from "../hearth/routes/project-checkpoint-reviews";
import { writeOwnerOnly } from "../hearth/token";
import { withProjectAdmission } from "../projects/admission";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import { createProjectCheckpointReviewStore } from "./project-checkpoint-review-store";

const owned: string[] = [];
afterEach(() => {
  for (const base of owned.splice(0)) {
    if (
      dirname(resolve(base)) !== resolve(tmpdir()) ||
      !basename(base).startsWith("checkpoint-association-")
    )
      throw Error("Unexpected cleanup root");
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
});
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "checkpoint-association-"));
  owned.push(base);
  const home = join(base, "home"),
    workspacePath = join(base, "workspace");
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  const projects = createProjectStore(home);
  const catalog = await projects.create(
    {
      slug: "association",
      name: "Association",
      description: "",
      icon: "A",
      workspaces: [
        {
          root: workspacePath,
          repositories: [workspacePath],
          epicIds: ["forge-association"],
        },
      ],
    },
    0,
  );
  const scope = {
    projectId: catalog.projects[0]!.id,
    workspacePath,
    runSlug: "association",
    beadId: "forge-association.1",
  };
  const binding = {
    ...scope,
    checkout: workspacePath,
    epicId: "forge-association",
    runUpdatedAt: "2026-11-13T00:00:00.000Z",
    catalogRevision: 1,
    scopeHash: "a".repeat(64),
  };
  const snapshot = {
    binding,
    sourceVersion: {
      kind: "committed-git-snapshot" as const,
      commit: "b".repeat(40),
      tree: "c".repeat(40),
    },
  };
  type Resolver = NonNullable<
    Parameters<typeof createProjectCheckpointReviewStore>[0]["submission"]
  >["resolveSnapshot"];
  let resolver: Resolver = async () => structuredClone(snapshot);
  const store = createProjectCheckpointReviewStore({
    home,
    withQueueLock,
    admit: (id, work) => withProjectAdmission(home, id, work),
    submission: { resolveSnapshot: (scope) => resolver(scope) },
  });
  const publish = () => ({
    schemaVersion: 1 as const,
    kind: "publish" as const,
    requestId: randomUUID(),
    binding: structuredClone(binding),
    sourceVersion: snapshot.sourceVersion,
    expectedSubmissionGeneration: 0,
  });
  return {
    home,
    scope,
    binding,
    snapshot,
    store,
    publish,
    setResolver: (next: Resolver) => {
      resolver = next;
    },
  };
}
test("only an anchored current publication has a complete matching-review association", async () => {
  const f = await fixture();
  const before = await f.store.submissionReviewContext(f.scope);
  expect(before.available && before.association.complete).toBe(false);
  const original = f.publish();
  await f.store.publishSubmission(original, 1);
  const result = await f.store.submissionReviewContext(f.scope);
  expect(result.available).toBe(true);
  if (!result.available) throw Error("Missing source association");
  expect(result.context.record?.original.requestId).toBe(original.requestId);
  expect(result.association).toEqual({
    complete: true,
    blockedElsewhere: false,
    records: [],
  });
});

function review(binding: ProjectCheckpointReviewBinding, note = "Ready") {
  const original = {
    schemaVersion: 1 as const,
    requestId: randomUUID(),
    binding: structuredClone(binding),
    decision: "approve" as const,
    note,
    createdAt: binding.runUpdatedAt,
    commentText: "",
    intentHash: "0".repeat(64),
  };
  original.commentText = projectCheckpointReviewCommentText(original);
  original.intentHash = createHash("sha256")
    .update(projectCheckpointReviewIntentJson(original))
    .digest("hex");
  return projectCheckpointReviewOriginalSchema.parse(original);
}
async function published(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.publishSubmission(f.publish(), 1);
  const context = await f.store.submissionContext(f.scope);
  if (!context.reviewBinding) throw Error("Missing submitted binding");
  return context;
}
test("one source generation joins prepared, dispatching, unknown and confirmed decisions", async () => {
  const f = await fixture(),
    context = await published(f);
  if (!context.reviewBinding) throw Error("Missing binding");
  const original = review(context.reviewBinding);
  await f.store.prepare(original, 2);
  const prepared = await f.store.submissionReviewContext(f.scope);
  if (!prepared.available) throw Error("Missing association");
  expect(prepared.association.records[0]?.original).toEqual(original);
  expect(prepared.association.records[0]?.receipt.state).toBe("prepared");
  const claim = await f.store.claim(
    f.scope,
    original.requestId,
    original.intentHash,
    3,
  );
  if (claim.kind !== "claimed") throw Error("Expected dispatch claim");
  const dispatching = await f.store.submissionReviewContext(f.scope);
  expect(
    dispatching.available && dispatching.association.records[0]?.receipt.state,
  ).toBe("unknown");
  await f.store.finish(
    claim.permit,
    { kind: "unknown", reportedCommentId: null },
    4,
  );
  await f.store.recordReadback(
    f.scope,
    original.requestId,
    original.intentHash,
    { kind: "found", commentId: "comment-1", body: original.commentText },
    5,
  );
  const confirmed = await f.store.submissionReviewContext(f.scope);
  if (!confirmed.available) throw Error("Missing association");
  expect(confirmed.association.records[0]?.receipt).toMatchObject({
    state: "confirmed",
    readback: "found",
    commentId: "comment-1",
  });
  expect(confirmed.context.generation).toBe(1);
  expect(await f.store.submissionContext(f.scope)).toEqual(context);
  const later = review(context.reviewBinding, "A later attempt");
  await f.store.prepare(later, 6);
  await f.store.retire(f.scope, later.requestId, later.intentHash, 7);
  const ordered = await f.store.submissionReviewContext(f.scope);
  if (!ordered.available) throw Error("Missing association");
  expect(
    ordered.association.records.map((row) => [
      row.original.requestId,
      row.receipt.state,
    ]),
  ).toEqual([
    [original.requestId, "confirmed"],
    [later.requestId, "retired"],
  ]);
  await f.store.publishSubmission(
    { ...f.publish(), expectedSubmissionGeneration: 1 },
    8,
  );
  const resubmitted = await f.store.submissionReviewContext(f.scope);
  if (!resubmitted.available) throw Error("Missing association");
  expect(resubmitted.association.records).toEqual([]);
  expect(resubmitted.context.sourceVersion).toEqual(context.sourceVersion);
  expect(resubmitted.context.record?.originalHash).not.toBe(
    context.record?.originalHash,
  );
});
test("foreign unresolved legacy decisions are blocked and never leaked as empty readiness", async () => {
  const f = await fixture();
  const foreign = review(
    { ...f.binding, runSlug: "foreign-run" },
    "Foreign review private note",
  );
  await f.store.prepare(foreign, 1);
  const result = await f.store.submissionReviewContext(f.scope);
  if (!result.available) throw Error("Missing legacy context");
  expect(result.association).toEqual({
    complete: false,
    blockedElsewhere: true,
    records: [],
  });
  expect(JSON.stringify(result)).not.toContain(foreign.requestId);
  expect(JSON.stringify(result)).not.toContain("Foreign review private note");
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
test("association captures scope before await and reads one current journal after the snapshot", async () => {
  const f = await fixture(),
    context = await published(f);
  if (!context.reviewBinding) throw Error("Missing binding");
  const entered = deferred<void>(),
    held = deferred<void>();
  let reads = 0;
  f.setResolver(async (scope) => {
    expect(scope).toEqual(f.scope);
    if (++reads === 1) {
      entered.resolve();
      await held.promise;
    }
    return structuredClone(f.snapshot);
  });
  const input = { ...f.scope },
    pending = f.store.submissionReviewContext(input);
  await entered.promise;
  input.runSlug = "mutated";
  const original = review(context.reviewBinding);
  await f.store.prepare(original, 2);
  held.resolve();
  const result = await pending;
  if (!result.available) throw Error("Missing coherent context");
  expect(result.association.records[0]?.original.requestId).toBe(
    original.requestId,
  );
  expect(result.association.records[0]?.metadata.state).toBe(
    result.association.records[0]?.receipt.state,
  );
  expect(result.context.baseBinding.runSlug).toBe(f.scope.runSlug);
});
test("source change, withdrawal and snapshot failure do not manufacture a complete empty association", async () => {
  const f = await fixture();
  await published(f);
  f.snapshot.sourceVersion.commit = "d".repeat(40);
  const stale = await f.store.submissionReviewContext(f.scope);
  expect(stale.available && stale.association.complete).toBe(false);
  const source = f.store.submissionInventory(f.scope).items[0]!;
  await f.store.withdrawSubmission(
    {
      schemaVersion: 1,
      kind: "withdraw",
      requestId: randomUUID(),
      scope: f.scope,
      targetSubmissionRequestId: source.original.requestId,
      targetOriginalHash: source.originalHash,
      expectedSubmissionGeneration: 1,
    },
    2,
  );
  const withdrawn = await f.store.submissionReviewContext(f.scope);
  expect(withdrawn.available && withdrawn.association.complete).toBe(false);
  f.setResolver(async () => {
    throw Error("private path and diagnostics");
  });
  expect(await f.store.submissionReviewContext(f.scope)).toEqual({
    available: false,
    error: CHECKPOINT_INBOX_CONTEXT_UNAVAILABLE,
  });
});
test("strict DTO rejects duplicate, contradictory, and other-binding associations", async () => {
  const f = await fixture(),
    context = await published(f);
  if (!context.reviewBinding) throw Error("Missing binding");
  await f.store.prepare(review(context.reviewBinding), 2);
  const result = await f.store.submissionReviewContext(f.scope);
  if (!result.available) throw Error("Missing association");
  const row = result.association.records[0]!;
  const wrong = review({ ...context.reviewBinding, scopeHash: "e".repeat(64) });
  const wrongRow = {
    metadata: {
      ...row.metadata,
      requestId: wrong.requestId,
      intentHash: wrong.intentHash,
    },
    original: wrong,
    receipt: {
      ...row.receipt,
      requestId: wrong.requestId,
      intentHash: wrong.intentHash,
    },
  };
  expect(
    projectCheckpointInboxContextReadSchema.safeParse({
      ...result,
      association: { ...result.association, records: [wrongRow] },
    }).success,
  ).toBe(false);
  expect(
    projectCheckpointInboxContextReadSchema.safeParse({
      ...result,
      association: { ...result.association, complete: false },
    }).success,
  ).toBe(false);
  expect(
    projectCheckpointInboxContextReadSchema.safeParse({
      ...result,
      association: { ...result.association, blockedElsewhere: true },
    }).success,
  ).toBe(false);
  expect(
    projectCheckpointInboxContextReadSchema.safeParse({
      ...result,
      association: {
        ...result.association,
        records: [...result.association.records, ...result.association.records],
      },
    }).success,
  ).toBe(false);
});

test("the protected association read uses the same owner without tracker effects", async () => {
  const f = await fixture();
  await published(f);
  let effects = 0;
  const routes = createProjectCheckpointReviewRoutes({
    home: f.home,
    workspace: f.scope.workspacePath,
    appendEvent: () => {
      effects++;
      return { ok: true, id: 1, ulid: "inert" };
    },
    queueLock: withQueueLock,
    runBd: async () => {
      effects++;
      return { status: 1, stdout: "", stderr: "unused" };
    },
    resolveAuthority: async () => f.binding,
    readScope: () => f.scope,
    source: {
      checkout: f.binding.checkout,
      resolveCurrentAuthority: async () => f.binding,
      capture: {
        capture: async () => f.snapshot.sourceVersion,
        close: async () => {},
      },
    },
  });
  try {
    const row = routes.reads.find((item) =>
      item.path.endsWith("/source-review-context"),
    );
    expect(row).toBeDefined();
    if (!row) throw Error("Missing association row");
    expect(row.operatorOnly).toBe(true);
    const input = {
      params: {
        id: f.scope.projectId,
        slug: f.scope.runSlug,
        beadId: f.scope.beadId,
      },
      query: new URLSearchParams(),
      headers: {},
      body: null,
    };
    const checked = row.validate(input);
    if (!checked.ok) throw Error("Invalid route fixture");
    const result = await row.read(checked.value);
    expect(result.status).toBe(200);
    expect(result).toEqual({
      status: 200,
      data: await f.store.submissionReviewContext(f.scope),
    });
    input.query.set("root", "/other");
    expect(row.validate(input).ok).toBe(false);
    expect(effects).toBe(0);
  } finally {
    await routes.close();
  }
});

test("complete association refuses over-count and over-byte payloads rather than truncating", async () => {
  const f = await fixture(),
    context = await published(f);
  if (!context.reviewBinding) throw Error("Missing binding");
  await f.store.prepare(review(context.reviewBinding), 2);
  const result = await f.store.submissionReviewContext(f.scope);
  if (!result.available) throw Error("Missing association");
  const row = result.association.records[0]!;
  const records = Array.from({ length: 101 }, (_, index) => {
    const original = review(context.reviewBinding!, "Recorded " + index),
      commentId = "comment-" + index;
    return {
      metadata: {
        ...row.metadata,
        state: "confirmed",
        commentId,
        requestId: original.requestId,
        intentHash: original.intentHash,
      },
      original,
      receipt: {
        ...row.receipt,
        state: "confirmed",
        commentId,
        reportedCommentId: commentId,
        readback: "found",
        requestId: original.requestId,
        intentHash: original.intentHash,
      },
    };
  });
  expect(
    projectCheckpointInboxContextReadSchema.safeParse({
      ...result,
      association: { ...result.association, records },
    }).success,
  ).toBe(false);
  const longTime = "2026-11-13T00:00:00." + "1".repeat(2 * 1024 * 1024) + "Z";
  const large = {
    metadata: { ...row.metadata, updatedAt: longTime },
    original: row.original,
    receipt: { ...row.receipt, updatedAt: longTime },
  };
  expect(
    projectCheckpointInboxContextReadSchema.safeParse({
      ...result,
      association: { ...result.association, records: [large] },
    }).success,
  ).toBe(false);
  expect(result.association.records).toHaveLength(1);
});

test("the supported byte ceiling includes the standard success envelope", async () => {
  const f = await fixture(),
    context = await published(f);
  if (!context.reviewBinding) throw Error("Missing binding");
  await f.store.prepare(review(context.reviewBinding), 2);
  const result = await f.store.submissionReviewContext(f.scope);
  if (!result.available) throw Error("Missing association");
  const row = result.association.records[0]!;
  const candidate = (digits: number) => {
    const time = "2026-11-13T00:00:00." + "1".repeat(digits) + "Z";
    return {
      ...result,
      association: {
        ...result.association,
        records: [
          {
            ...row,
            metadata: { ...row.metadata, updatedAt: time },
            receipt: { ...row.receipt, updatedAt: time },
          },
        ],
      },
    };
  };
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const digits = Math.floor(
    (CHECKPOINT_INBOX_CONTEXT_MAX_BYTES - 16 - bytes(candidate(0))) / 2,
  );
  const large = candidate(digits);
  expect(bytes(large)).toBeLessThanOrEqual(CHECKPOINT_INBOX_CONTEXT_MAX_BYTES);
  expect(bytes({ ok: true, data: large, error: null })).toBeGreaterThan(
    CHECKPOINT_INBOX_CONTEXT_MAX_BYTES,
  );
  expect(projectCheckpointInboxContextReadSchema.safeParse(large).success).toBe(
    false,
  );
});

test("a valid retained journal with an oversized valid snapshot becomes unavailable", async () => {
  const f = await fixture(),
    original = f.publish();
  await f.store.publishSubmission(original, 1);
  f.snapshot.binding.runUpdatedAt =
    "2026-11-13T00:00:00." +
    "1".repeat(CHECKPOINT_INBOX_CONTEXT_MAX_BYTES) +
    "Z";
  expect(
    projectCheckpointReviewBindingSchema.safeParse(f.snapshot.binding).success,
  ).toBe(true);
  expect(await f.store.submissionReviewContext(f.scope)).toEqual({
    available: false,
    error: CHECKPOINT_INBOX_CONTEXT_UNAVAILABLE,
  });
  expect(
    f.store.submissionOriginal(f.scope, original.requestId)?.original,
  ).toEqual(original);
});
test("corrupt or lost anchored private journals return unavailable rather than empty history", async () => {
  for (const kind of ["corrupt", "missing"]) {
    const f = await fixture();
    await published(f);
    const key = createHash("sha256")
      .update(
        JSON.stringify([workspaceKey(f.scope.workspacePath), f.scope.beadId]),
      )
      .digest("hex");
    const directory = resolve(join(f.home, "checkpoint-reviews")),
      file = resolve(join(directory, key + ".json"));
    if (dirname(file) !== directory)
      throw Error("Fixture journal path escaped its owned directory");
    if (kind === "corrupt") writeOwnerOnly(file, "corrupt");
    else rmSync(file);
    expect(await f.store.submissionReviewContext(f.scope)).toEqual({
      available: false,
      error: CHECKPOINT_INBOX_CONTEXT_UNAVAILABLE,
    });
  }
});
