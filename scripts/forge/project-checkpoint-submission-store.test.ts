import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  type ProjectCheckpointReviewBinding,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalSchema,
} from "../../types/project-checkpoint-reviews";
import {
  type ProjectCheckpointSubmissionRecord,
  projectCheckpointSourceVersionSchema,
  projectCheckpointSubmissionOriginalJson,
  projectCheckpointSubmissionOriginalSchema,
} from "../../types/project-checkpoint-submissions";
import { writeOwnerOnly } from "../hearth/token";
import { withProjectAdmission } from "../projects/admission";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  createProjectCheckpointReviewStore,
  readProjectCheckpointReviewInventory,
} from "./project-checkpoint-review-store";

const bases: string[] = [];
function removeOwned(base: string, target = base) {
  const allocated = resolve(base);
  const checked = resolve(target);
  if (
    dirname(allocated) !== resolve(tmpdir()) ||
    !basename(allocated).startsWith("checkpoint-source-")
  )
    throw Error("Unexpected fixture root");
  if (checked !== allocated && !checked.startsWith(allocated + sep))
    throw Error("Fixture cleanup escaped its root");
  rmSync(checked, { recursive: true, force: true, maxRetries: 3 });
}
afterEach(() => {
  for (const base of bases.splice(0)) removeOwned(base);
});
const stamp = "2026-11-11T20:00:00.000Z";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "checkpoint-source-"));
  bases.push(base);
  const home = join(base, "home");
  const workspacePath = join(base, "workspace");
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  const projects = createProjectStore(home);
  const catalog = await projects.create(
    {
      slug: "checkpoint-source",
      name: "Checkpoint source",
      description: "",
      icon: "C",
      workspaces: [
        {
          root: workspacePath,
          repositories: [workspacePath],
          epicIds: ["forge-test"],
        },
      ],
    },
    0,
  );
  const projectId = catalog.projects[0]!.id;
  const scope = {
    projectId,
    workspacePath,
    runSlug: "checkpoint-source",
    beadId: "forge-test.1",
  };
  const binding: ProjectCheckpointReviewBinding = {
    ...scope,
    checkout: workspacePath,
    epicId: "forge-test",
    runUpdatedAt: stamp,
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
  const options = {
    home,
    withQueueLock,
    now: () => new Date(stamp),
    admit: <T>(id: string, work: () => T | Promise<T>) =>
      withProjectAdmission(home, id, work),
    submission: { resolveSnapshot: async () => structuredClone(snapshot) },
  };
  const store = createProjectCheckpointReviewStore(options);
  const publish = (generation = 0) => ({
    schemaVersion: 1 as const,
    kind: "publish" as const,
    requestId: randomUUID(),
    binding: structuredClone(binding),
    sourceVersion: structuredClone(snapshot.sourceVersion),
    expectedSubmissionGeneration: generation,
  });
  const review = (
    current = binding,
    decision: "approve" | "request-changes" = "approve",
  ) => {
    const original = {
      schemaVersion: 1 as const,
      requestId: randomUUID(),
      binding: structuredClone(current),
      decision,
      note: decision === "approve" ? "" : "Correct the source.",
      createdAt: stamp,
      commentText: "",
      intentHash: "0".repeat(64),
    };
    original.commentText = projectCheckpointReviewCommentText(original);
    original.intentHash = digest(projectCheckpointReviewIntentJson(original));
    return projectCheckpointReviewOriginalSchema.parse(original);
  };
  return {
    base,
    home,
    scope,
    binding,
    snapshot,
    options,
    store,
    publish,
    review,
    projects,
    projectId,
  };
}

test("legacy review originals retain their canonical hash and exact recovery", async () => {
  const f = await fixture();
  const original = f.review();
  const prepared = await f.store.prepare(original, 1);
  expect(prepared.original).toEqual(original);
  expect(prepared.original.intentHash).toBe(
    digest(projectCheckpointReviewIntentJson(original)),
  );
  expect(
    (await f.store.retire(f.scope, original.requestId, original.intentHash, 2))
      .receipt.state,
  ).toBe("retired");
});

test("an explicit source original survives restart without inventing a decision", async () => {
  const f = await fixture();
  const original = f.publish();
  const published = await f.store.publishSubmission(original, 3);
  expect(published.created).toBe(true);
  expect(published.record.original).toEqual(original);
  expect(published.record.receipt).toMatchObject({
    state: "applied",
    observedGeneration: 0,
    resultingGeneration: 1,
  });
  const restarted = createProjectCheckpointReviewStore(f.options);
  expect(
    await restarted.submissionOriginal(f.scope, original.requestId),
  ).toEqual(published.record);
  expect(restarted.inventory(f.scope)).toEqual([]);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
function fileFor(f: Fixture) {
  const key = digest(
    JSON.stringify([workspaceKey(f.scope.workspacePath), f.scope.beadId]),
  );
  return join(f.home, "checkpoint-reviews", key + ".json");
}
function anchorFor(f: Fixture) {
  return join(f.home, "checkpoint-review-anchors", basename(fileFor(f)));
}
function readObject(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw Error("Object required");
    return value as Record<string, unknown>;
  } catch {
    throw Error("Invalid fixture object");
  }
}
function withdraw(
  f: Fixture,
  publication: ProjectCheckpointSubmissionRecord,
  generation: number,
) {
  return {
    schemaVersion: 1 as const,
    kind: "withdraw" as const,
    requestId: randomUUID(),
    scope: { ...f.scope },
    targetSubmissionRequestId: publication.original.requestId,
    targetOriginalHash: publication.originalHash,
    expectedSubmissionGeneration: generation,
  };
}
async function current(f: Fixture) {
  const context = await f.store.submissionContext(f.scope);
  if (context.reviewBinding === null) throw Error("Expected a current source");
  return context.reviewBinding;
}
async function confirm(
  f: Fixture,
  binding: ProjectCheckpointReviewBinding,
  decision: "approve" | "request-changes" = "approve",
) {
  const original = f.review(binding, decision);
  await f.store.prepare(original, 10);
  const claimed = await f.store.claim(
    f.scope,
    original.requestId,
    original.intentHash,
    11,
  );
  if (claimed.kind !== "claimed") throw Error("Expected a claim");
  await f.store.finish(
    claimed.permit,
    { kind: "unknown", reportedCommentId: "comment-exact" },
    12,
  );
  await f.store.recordReadback(
    f.scope,
    original.requestId,
    original.intentHash,
    { kind: "found", commentId: "comment-exact", body: original.commentText },
    13,
  );
  return original;
}
function legacyRecords(f: Fixture, count: number, large = false) {
  return Array.from({ length: count }, () => {
    const original = f.review();
    if (large) {
      original.binding.checkout = "界".repeat(4096);
      original.note = "界".repeat(2000);
    }
    original.commentText = projectCheckpointReviewCommentText(original);
    original.intentHash = digest(projectCheckpointReviewIntentJson(original));
    projectCheckpointReviewOriginalSchema.parse(original);
    return {
      scope: { ...f.scope },
      original,
      state: "retired",
      receipt: {
        schemaVersion: 1,
        requestId: original.requestId,
        intentHash: original.intentHash,
        state: "retired",
        commentId: null,
        reportedCommentId: null,
        readback: "not-checked",
        auditEventId: 1,
        createdAt: stamp,
        updatedAt: stamp,
      },
    } satisfies ReturnType<typeof f.store.inventory>[number];
  });
}
function plantLegacy(f: Fixture, records: ReturnType<typeof legacyRecords>) {
  mkdirSync(dirname(fileFor(f)), { recursive: true });
  writeOwnerOnly(
    fileFor(f),
    JSON.stringify({ version: 1, activeRequestId: null, records }),
  );
}

test("strict source schemas bind exact UTF8 canonical originals and reject unsupported versions", async () => {
  const f = await fixture();
  const original = f.publish();
  expect(
    projectCheckpointSubmissionOriginalSchema.safeParse(original).success,
  ).toBe(true);
  expect(
    projectCheckpointSubmissionOriginalSchema.safeParse({
      ...original,
      extra: true,
    }).success,
  ).toBe(false);
  expect(
    projectCheckpointSourceVersionSchema.safeParse({
      ...original.sourceVersion,
      commit: "d".repeat(64),
    }).success,
  ).toBe(false);
  expect(
    projectCheckpointSourceVersionSchema.safeParse({
      ...original.sourceVersion,
      tree: "0".repeat(40),
    }).success,
  ).toBe(false);
  expect(
    projectCheckpointSubmissionOriginalSchema.safeParse({
      ...original,
      expectedSubmissionGeneration: Number.MAX_SAFE_INTEGER,
    }).success,
  ).toBe(false);
  const first = await f.store.publishSubmission(original, 1);
  expect(first.record.originalHash).toBe(
    digest(projectCheckpointSubmissionOriginalJson(original)),
  );
  expect(first.record.receipt.reviewScopeHash).not.toBe(f.binding.scopeHash);
});

test("v1 upgrade preserves all original preimages and receipt values; source-only inventory has no fake review row", async () => {
  const f = await fixture();
  const records = legacyRecords(f, 2);
  plantLegacy(f, records);
  expect(readObject(fileFor(f)).version).toBe(1);
  expect(f.store.inventory(f.scope)).toEqual(records);
  expect(readObject(fileFor(f)).version).toBe(1);
  const before = readFileSync(fileFor(f), "utf8");
  await f.store.publishSubmission(f.publish(), 1);
  expect(readObject(fileFor(f)).version).toBe(2);
  expect(f.store.inventory(f.scope)).toEqual(records);
  expect(before).not.toBe(readFileSync(fileFor(f), "utf8"));
  expect(
    readProjectCheckpointReviewInventory(f.home, [fileFor(f)], f.projectId),
  ).toEqual(records);
  const empty = await fixture();
  await empty.store.publishSubmission(empty.publish(), 1);
  expect(
    readProjectCheckpointReviewInventory(
      empty.home,
      [fileFor(empty)],
      empty.projectId,
    ),
  ).toEqual([]);
});

test("publication captures its entire original before await and exact replay ignores later admission failure", async () => {
  const f = await fixture();
  const original = f.publish();
  const retained = structuredClone(original);
  const pending = f.store.publishSubmission(original, 1);
  original.sourceVersion.commit = "d".repeat(40);
  original.binding.checkout = "private mutation";
  const first = await pending;
  expect(first.record.original).toEqual(retained);
  expect(Object.isFrozen(first.record.original)).toBe(true);
  await f.projects.preferences(f.projectId, 1, { archived: true });
  expect(await f.store.publishSubmission(retained, 99)).toEqual({
    created: false,
    record: first.record,
  });
  expect(await f.store.submissionOriginal(f.scope, randomUUID())).toBeNull();
  await expect(
    f.store.publishSubmission(
      {
        ...retained,
        sourceVersion: { ...retained.sourceVersion, commit: "e".repeat(40) },
      },
      2,
    ),
  ).rejects.toThrow();
  expect(
    (await f.store.withdrawSubmission(withdraw(f, first.record, 1), 3)).record
      .receipt.resultingGeneration,
  ).toBe(2);
});

test("withdrawal survives actual catalog loss and leaves an ever-bound tombstone", async () => {
  const f = await fixture();
  const pub = await f.store.publishSubmission(f.publish(), 1);
  removeOwned(f.base, join(f.home, "projects", "catalog.json"));
  const original = withdraw(f, pub.record, 1);
  const result = await f.store.withdrawSubmission(original, 2);
  expect(f.store.submissionInventory(f.scope)).toMatchObject({
    everBound: true,
    generation: 2,
    currentRequestId: null,
  });
  expect((await f.store.submissionContext(f.scope)).state).toBe("withdrawn");
  expect(await f.store.withdrawSubmission(original, 3)).toEqual({
    created: false,
    record: result.record,
  });
  await expect(f.store.prepare(f.review(), 4)).rejects.toThrow();
  await expect(f.store.publishSubmission(f.publish(2), 5)).rejects.toThrow();
});

test("all source kinds and reviews share UUID identity; stale generations and wrong targets have no effect", async () => {
  const f = await fixture();
  const original = f.publish();
  const pub = await f.store.publishSubmission(original, 1);
  const before = readFileSync(fileFor(f), "utf8");
  await expect(f.store.publishSubmission(f.publish(0), 2)).rejects.toThrow();
  await expect(
    f.store.withdrawSubmission(
      { ...withdraw(f, pub.record, 1), requestId: original.requestId },
      3,
    ),
  ).rejects.toThrow();
  await expect(
    f.store.withdrawSubmission(
      { ...withdraw(f, pub.record, 1), targetOriginalHash: "d".repeat(64) },
      4,
    ),
  ).rejects.toThrow();
  const collision = f.review(await current(f));
  collision.requestId = original.requestId;
  collision.commentText = projectCheckpointReviewCommentText(collision);
  collision.intentHash = digest(projectCheckpointReviewIntentJson(collision));
  await expect(f.store.prepare(collision, 5)).rejects.toThrow();
  expect(readFileSync(fileFor(f), "utf8")).toBe(before);
  await f.store.withdrawSubmission(withdraw(f, pub.record, 1), 6);
  await expect(
    f.store.publishSubmission(
      { ...f.publish(2), requestId: original.requestId },
      7,
    ),
  ).rejects.toThrow();
});

test("no adapter or no project admission can manufacture a current source", async () => {
  const f = await fixture();
  const plain = createProjectCheckpointReviewStore({
    home: f.home,
    withQueueLock,
  });
  await expect(plain.publishSubmission(f.publish(), 1)).rejects.toThrow();
  await expect(plain.submissionContext(f.scope)).rejects.toThrow("unavailable");
  const noAdmission = createProjectCheckpointReviewStore({
    home: f.home,
    withQueueLock,
    submission: f.options.submission,
  });
  await expect(noAdmission.publishSubmission(f.publish(), 1)).rejects.toThrow();
  const malicious = {
    ...f.publish(),
    get sourceVersion(): never {
      throw Error("private source sentinel");
    },
  };
  expect(() => f.store.publishSubmission(malicious, 1)).toThrow(
    "valid immutable",
  );
  const failed = createProjectCheckpointReviewStore({
    ...f.options,
    submission: {
      resolveSnapshot: async () => {
        throw Error("private resolver sentinel");
      },
    },
  });
  await expect(failed.publishSubmission(f.publish(), 1)).rejects.toThrow(
    "context is unavailable",
  );
});

test("the live complete base binding and committed source must match; stale source cannot be reviewed", async () => {
  const f = await fixture();
  await expect(
    f.store.publishSubmission(
      { ...f.publish(), binding: { ...f.binding, catalogRevision: 0 } },
      1,
    ),
  ).rejects.toThrow();
  await expect(
    f.store.publishSubmission(
      {
        ...f.publish(),
        sourceVersion: { ...f.snapshot.sourceVersion, commit: "e".repeat(40) },
      },
      2,
    ),
  ).rejects.toThrow();
  const pub = await f.store.publishSubmission(f.publish(), 3);
  const binding = await current(f);
  await expect(f.store.prepare(f.review(f.binding), 4)).rejects.toThrow();
  f.snapshot.sourceVersion.commit = "d".repeat(40);
  expect((await f.store.submissionContext(f.scope)).state).toBe("stale");
  await expect(f.store.prepare(f.review(binding), 5)).rejects.toThrow();
  expect(f.store.inventory(f.scope)).toEqual([]);
  expect(
    await f.store.submissionOriginal(f.scope, pub.record.original.requestId),
  ).toEqual(pub.record);
});

test("every review lifecycle write preserves source history and exact late readback", async () => {
  const f = await fixture();
  const pub = await f.store.publishSubmission(f.publish(), 1);
  const binding = await current(f);
  const retired = f.review(binding);
  await f.store.prepare(retired, 2);
  await f.store.retire(f.scope, retired.requestId, retired.intentHash, 3);
  const original = f.review(binding);
  await f.store.prepare(original, 4);
  const claim = await f.store.claim(
    f.scope,
    original.requestId,
    original.intentHash,
    5,
  );
  if (claim.kind !== "claimed") throw Error("Expected claim");
  await f.store.finish(
    claim.permit,
    { kind: "unknown", reportedCommentId: null },
    6,
  );
  await f.store.recordReadback(
    f.scope,
    original.requestId,
    original.intentHash,
    { kind: "incomplete" },
    7,
  );
  expect(
    await f.store.submissionOriginal(f.scope, pub.record.original.requestId),
  ).toEqual(pub.record);
  await expect(
    f.store.withdrawSubmission(withdraw(f, pub.record, 1), 8),
  ).rejects.toThrow();
  f.snapshot.sourceVersion.commit = "d".repeat(40);
  expect(
    (
      await f.store.recordReadback(
        f.scope,
        original.requestId,
        original.intentHash,
        { kind: "found", commentId: "late-exact", body: original.commentText },
        9,
      )
    ).receipt.state,
  ).toBe("confirmed");
  expect(
    await f.store.submissionOriginal(f.scope, pub.record.original.requestId),
  ).toEqual(pub.record);
  await f.store.publishSubmission(f.publish(1), 10);
  expect((await f.store.submissionContext(f.scope)).generation).toBe(2);
});

test("confirmed Request changes permits explicit corrected source resubmission without granting approval", async () => {
  const f = await fixture();
  const pub = await f.store.publishSubmission(f.publish(), 1);
  await expect(f.store.publishSubmission(f.publish(1), 2)).rejects.toThrow();
  const old = await confirm(f, await current(f), "request-changes");
  f.snapshot.sourceVersion.commit = "e".repeat(40);
  const next = await f.store.publishSubmission(f.publish(1), 3);
  expect(next.record.receipt.reviewScopeHash).not.toBe(
    pub.record.receipt.reviewScopeHash,
  );
  expect(
    (await f.store.original(f.scope, old.requestId))?.original.decision,
  ).toBe("request-changes");
  expect(
    f.store
      .inventory(f.scope)
      .every(
        (row) =>
          row.original.binding.scopeHash !==
          next.record.receipt.reviewScopeHash,
      ),
  ).toBe(true);
});

test("foreign source discovery retains generation and hides originals until exact routeback", async () => {
  const f = await fixture();
  const pub = await f.store.publishSubmission(f.publish(), 1);
  const foreignScope = { ...f.scope, runSlug: "another-run" };
  const foreign = createProjectCheckpointReviewStore({
    ...f.options,
    submission: {
      resolveSnapshot: async () => ({
        binding: { ...f.binding, runSlug: foreignScope.runSlug },
        sourceVersion: f.snapshot.sourceVersion,
      }),
    },
  });
  const context = await foreign.submissionContext(foreignScope);
  expect(context).toMatchObject({
    state: "foreign",
    generation: 1,
    record: null,
    reviewBinding: null,
    foreign: { projectId: f.projectId, runSlug: f.scope.runSlug },
  });
  expect(
    foreign.submissionOriginal(foreignScope, pub.record.original.requestId),
  ).toBeNull();
  expect(foreign.submissionInventory(foreignScope)).toMatchObject({
    blocked: true,
    currentRequestId: null,
    items: [],
  });
  await expect(
    foreign.publishSubmission(
      {
        ...f.publish(1),
        binding: { ...f.binding, runSlug: foreignScope.runSlug },
      },
      2,
    ),
  ).rejects.toThrow();
  await expect(
    foreign.withdrawSubmission(
      { ...withdraw(f, pub.record, 1), scope: foreignScope },
      3,
    ),
  ).rejects.toThrow();
});

test("publication and withdrawal inspect unresolved reviews across the whole shared journal", async () => {
  const f = await fixture();
  const legacy = createProjectCheckpointReviewStore({
    home: f.home,
    withQueueLock,
  });
  const foreign = f.review({ ...f.binding, runSlug: "foreign-run" });
  await legacy.prepare(foreign, 1);
  await expect(f.store.publishSubmission(f.publish(), 2)).rejects.toThrow(
    "outstanding",
  );
  await legacy.retire(
    { ...f.scope, runSlug: "foreign-run" },
    foreign.requestId,
    foreign.intentHash,
    3,
  );
  const pub = await f.store.publishSubmission(f.publish(), 4);
  const original = f.review(await current(f));
  await f.store.prepare(original, 5);
  await expect(
    f.store.withdrawSubmission(withdraw(f, pub.record, 1), 6),
  ).rejects.toThrow();
  const claim = await f.store.claim(
    f.scope,
    original.requestId,
    original.intentHash,
    7,
  );
  if (claim.kind !== "claimed") throw Error("Expected claim");
  await expect(f.store.publishSubmission(f.publish(1), 8)).rejects.toThrow();
  await f.store.finish(claim.permit, { kind: "refused-before-dispatch" }, 9);
  await expect(f.store.publishSubmission(f.publish(1), 10)).rejects.toThrow();
  expect(
    (await f.store.withdrawSubmission(withdraw(f, pub.record, 1), 11)).created,
  ).toBe(true);
});

test("concurrent preparation versus withdrawal has exactly one durable winner", async () => {
  const f = await fixture();
  const pub = await f.store.publishSubmission(f.publish(), 1);
  const other = createProjectCheckpointReviewStore(f.options);
  const original = f.review(await current(f));
  const outcomes = await Promise.allSettled([
    f.store.prepare(original, 2),
    other.withdrawSubmission(withdraw(f, pub.record, 1), 3),
  ]);
  expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  const inventory = f.store.submissionInventory(f.scope);
  const reviews = f.store.inventory(f.scope);
  expect(
    (inventory.currentRequestId === null && reviews.length === 0) ||
      (inventory.currentRequestId === pub.record.original.requestId &&
        reviews[0]?.state === "prepared"),
  ).toBe(true);
});

test("claim and source withdrawal serialize without discarding a prepared review", async () => {
  const f = await fixture();
  const pub = await f.store.publishSubmission(f.publish(), 1);
  const original = f.review(await current(f));
  await f.store.prepare(original, 2);
  const other = createProjectCheckpointReviewStore(f.options);
  const outcomes = await Promise.allSettled([
    f.store.claim(f.scope, original.requestId, original.intentHash, 3),
    other.withdrawSubmission(withdraw(f, pub.record, 1), 4),
  ]);
  expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  expect((await f.store.metadata(f.scope)).items[0]?.state).toBe("unknown");
  expect(f.store.submissionInventory(f.scope).currentRequestId).toBe(
    pub.record.original.requestId,
  );
});

test("known journal and family loss, missing anchors, and crash-after-anchor never reset to empty", async () => {
  for (const loss of ["file", "family", "anchor", "only-anchor"] as const) {
    const f = await fixture();
    await f.store.publishSubmission(f.publish(), 1);
    if (loss === "file" || loss === "only-anchor")
      removeOwned(f.base, fileFor(f));
    if (loss === "family")
      removeOwned(f.base, join(f.home, "checkpoint-reviews"));
    if (loss === "anchor") removeOwned(f.base, anchorFor(f));
    expect(() => f.store.submissionInventory(f.scope)).toThrow();
    expect(() =>
      readProjectCheckpointReviewInventory(
        f.home,
        loss === "family" || loss === "file" || loss === "only-anchor"
          ? []
          : [fileFor(f)],
        f.projectId,
      ),
    ).toThrow();
    await expect(f.store.publishSubmission(f.publish(), 2)).rejects.toThrow();
  }
});

test("malformed source history, hashes, count headers, versions and anchor identities fail closed", async () => {
  for (const corrupt of [
    "generation",
    "pointer",
    "version",
    "prefix",
    "hash",
    "anchor",
  ] as const) {
    const f = await fixture();
    const pub = await f.store.publishSubmission(f.publish(), 1);
    await f.store.withdrawSubmission(withdraw(f, pub.record, 1), 2);
    const raw = readObject(fileFor(f));
    if (corrupt === "generation") raw.submissionGeneration = 1;
    if (corrupt === "pointer")
      raw.currentSubmissionRequestId = pub.record.original.requestId;
    if (corrupt === "version") raw.version = "2";
    if (corrupt === "prefix")
      raw.submissionRecords = f.store
        .submissionInventory(f.scope)
        .items.slice(1);
    if (corrupt === "hash")
      raw.submissionRecords = [{ ...pub.record, originalHash: "d".repeat(64) }];
    if (corrupt === "anchor")
      writeOwnerOnly(
        anchorFor(f),
        JSON.stringify({ ...readObject(anchorFor(f)), key: "d".repeat(64) }),
      );
    else writeOwnerOnly(fileFor(f), JSON.stringify(raw));
    expect(() => f.store.submissionInventory(f.scope)).toThrow();
    expect(() =>
      readProjectCheckpointReviewInventory(f.home, [fileFor(f)], f.projectId),
    ).toThrow();
  }
});

test("publication reserves an actual review count slot and retains withdrawal after the 100th review", async () => {
  const full = await fixture();
  plantLegacy(full, legacyRecords(full, 100));
  const before = readFileSync(fileFor(full), "utf8");
  await expect(full.store.publishSubmission(full.publish(), 1)).rejects.toThrow(
    "review slot",
  );
  expect(readFileSync(fileFor(full), "utf8")).toBe(before);
  expect(() => readFileSync(anchorFor(full))).toThrow();
  const f = await fixture();
  plantLegacy(f, legacyRecords(f, 99));
  const pub = await f.store.publishSubmission(f.publish(), 1);
  await confirm(f, await current(f));
  expect(f.store.inventory(f.scope)).toHaveLength(100);
  f.snapshot.sourceVersion.commit = "d".repeat(40);
  await expect(f.store.publishSubmission(f.publish(1), 2)).rejects.toThrow(
    "review slot",
  );
  expect(
    (await f.store.withdrawSubmission(withdraw(f, pub.record, 1), 3)).created,
  ).toBe(true);
});

test("UTF8 byte capacity refuses legacy upgrade before installing an anchor or changing history", async () => {
  const f = await fixture();
  const candidates = legacyRecords(f, 99, true);
  const records = candidates.filter(
    (_, index) =>
      Buffer.byteLength(
        JSON.stringify({
          version: 1,
          activeRequestId: null,
          records: candidates.slice(0, index + 1),
        }),
      ) <=
      2 * 1024 * 1024 - 16384,
  );
  expect(records.length).toBeLessThan(99);
  plantLegacy(f, records);
  const before = readFileSync(fileFor(f), "utf8");
  expect(f.store.inventory(f.scope)).toHaveLength(records.length);
  await expect(f.store.publishSubmission(f.publish(), 1)).rejects.toThrow(
    "full",
  );
  expect(readFileSync(fileFor(f), "utf8")).toBe(before);
  expect(() => readFileSync(anchorFor(f))).toThrow();
});

test("the final source transaction slot stays available for withdrawal and full history stays readable", async () => {
  const f = await fixture();
  let last: ProjectCheckpointSubmissionRecord | null = null;
  for (let generation = 0; generation < 98; generation += 2) {
    const pub = await f.store.publishSubmission(
      f.publish(generation),
      generation + 1,
    );
    await f.store.withdrawSubmission(
      withdraw(f, pub.record, generation + 1),
      generation + 2,
    );
  }
  last = (await f.store.publishSubmission(f.publish(98), 99)).record;
  expect(f.store.submissionInventory(f.scope).items).toHaveLength(99);
  const original = withdraw(f, last, 99);
  const result = await f.store.withdrawSubmission(original, 100);
  expect(f.store.submissionInventory(f.scope)).toMatchObject({
    generation: 100,
    currentRequestId: null,
  });
  expect(f.store.submissionInventory(f.scope).items).toHaveLength(100);
  const before = readFileSync(fileFor(f), "utf8");
  await expect(f.store.publishSubmission(f.publish(100), 101)).rejects.toThrow(
    "full",
  );
  expect(readFileSync(fileFor(f), "utf8")).toBe(before);
  expect(await f.store.withdrawSubmission(original, 102)).toEqual({
    created: false,
    record: result.record,
  });
});

test("publication holds the real mutex through admission and rejects an older concurrent review", async () => {
  const f = await fixture();
  let release = () => {};
  let entered = () => {};
  const hold = new Promise<void>((resolveHold) => {
    release = resolveHold;
  });
  const observed = new Promise<void>((resolveObserved) => {
    entered = resolveObserved;
  });
  const publisher = createProjectCheckpointReviewStore({
    ...f.options,
    submission: {
      resolveSnapshot: async () => {
        entered();
        await hold;
        return structuredClone(f.snapshot);
      },
    },
  });
  const pending = publisher.publishSubmission(f.publish(), 1);
  await observed;
  const preparation = f.store.prepare(f.review(), 2).then(
    () => true,
    () => false,
  );
  release();
  expect((await pending).created).toBe(true);
  expect(await preparation).toBe(false);
  expect(f.store.inventory(f.scope)).toEqual([]);
});

test("reserved complete-review growth permits large multibyte review and exact readback before withdrawal", async () => {
  const f = await fixture();
  f.binding.checkout = "界".repeat(4096);
  const candidates = legacyRecords(f, 99, true);
  const records = candidates.filter(
    (_, index) =>
      Buffer.byteLength(
        JSON.stringify({
          version: 1,
          activeRequestId: null,
          records: candidates.slice(0, index + 1),
        }),
      ) <=
      2 * 1024 * 1024 - 180000,
  );
  plantLegacy(f, records);
  const pub = await f.store.publishSubmission(f.publish(), 1);
  const original = f.review(await current(f), "request-changes");
  original.note = "界".repeat(2000);
  original.commentText = projectCheckpointReviewCommentText(original);
  original.intentHash = digest(projectCheckpointReviewIntentJson(original));
  await f.store.prepare(original, 2);
  const claimed = await f.store.claim(
    f.scope,
    original.requestId,
    original.intentHash,
    3,
  );
  if (claimed.kind !== "claimed") throw Error("Expected claim");
  const id = "c".repeat(256);
  await f.store.finish(
    claimed.permit,
    { kind: "unknown", reportedCommentId: id },
    Number.MAX_SAFE_INTEGER,
  );
  const readback = await f.store.recordReadback(
    f.scope,
    original.requestId,
    original.intentHash,
    { kind: "found", commentId: id, body: original.commentText },
    Number.MAX_SAFE_INTEGER,
  );
  expect(readback.receipt.state).toBe("confirmed");
  expect(
    (await f.store.withdrawSubmission(withdraw(f, pub.record, 1), 4)).created,
  ).toBe(true);
  expect(
    Buffer.byteLength(readFileSync(fileFor(f), "utf8")),
  ).toBeLessThanOrEqual(2 * 1024 * 1024);
});

test("hardlinked or non-file source data and anchors are refused without touching their targets", async () => {
  for (const targetKind of ["data", "anchor", "directory"] as const) {
    const f = await fixture();
    await f.store.publishSubmission(f.publish(), 1);
    const target = targetKind === "anchor" ? anchorFor(f) : fileFor(f);
    const safe = join(f.base, "retained-target.json");
    const text = readFileSync(target, "utf8");
    writeOwnerOnly(safe, text);
    removeOwned(f.base, target);
    if (targetKind === "directory") mkdirSync(target);
    else linkSync(safe, target);
    expect(() => f.store.submissionInventory(f.scope)).toThrow();
    expect(readFileSync(safe, "utf8")).toBe(text);
    expect(() =>
      readProjectCheckpointReviewInventory(f.home, [fileFor(f)], f.projectId),
    ).toThrow();
  }
});

test("exact Publish and Withdraw replay recover unchanged originals without consulting a failed clock", async () => {
  const f = await fixture();
  const original = f.publish();
  const published = await f.store.publishSubmission(original, 1);
  const withdrawal = withdraw(f, published.record, 1);
  const withdrawn = await f.store.withdrawSubmission(withdrawal, 2);
  const before = readFileSync(fileFor(f), "utf8");
  let clocks = 0;
  const restarted = createProjectCheckpointReviewStore({
    ...f.options,
    now: () => {
      clocks++;
      throw Error("private clock sentinel");
    },
  });
  expect(await restarted.publishSubmission(original, 3)).toEqual({
    created: false,
    record: published.record,
  });
  expect(await restarted.withdrawSubmission(withdrawal, 4)).toEqual({
    created: false,
    record: withdrawn.record,
  });
  expect(clocks).toBe(0);
  await expect(restarted.publishSubmission(f.publish(2), 5)).rejects.toThrow(
    "clock is unavailable",
  );
  const invalid = createProjectCheckpointReviewStore({
    ...f.options,
    now: () => new Date(Number.NaN),
  });
  await expect(invalid.publishSubmission(f.publish(2), 6)).rejects.toThrow(
    "clock is unavailable",
  );
  expect(clocks).toBe(1);
  expect(readFileSync(fileFor(f), "utf8")).toBe(before);
});
