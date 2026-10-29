import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES,
  PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS,
  type ProjectCheckpointReviewOriginal,
  type ProjectCheckpointReviewScope,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalSchema,
} from "../../types/project-checkpoint-reviews";
import { ConversationError } from "../conversations/error";
import { privateTempDir } from "../hearth/testing";
import { withQueueLock } from "../scheduler/queue-lock";
import { createProjectCheckpointReviewStore } from "./project-checkpoint-review-store";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const projectId = "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12";
const beadId = "agent-forge-harness-cla5.7.1.4";
const epicId = "agent-forge-harness-cla5.7";
const createdAt = "2026-10-29T18:00:00.000Z";
const updatedAt = "2026-10-29T17:59:00.000Z";
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function fixture() {
  const home = privateTempDir("checkpoint-review-store-");
  homes.push(home);
  const workspacePath = resolve(home, "workspace");
  const scope: ProjectCheckpointReviewScope = {
    projectId,
    workspacePath,
    runSlug: "feat-run-checkpoints",
    beadId,
  };
  const binding = {
    ...scope,
    checkout: workspacePath,
    epicId,
    runUpdatedAt: updatedAt,
    catalogRevision: 4,
    scopeHash: "a".repeat(64),
  };
  const store = createProjectCheckpointReviewStore({ home, withQueueLock });
  const original = (
    overrides: Partial<
      Pick<
        ProjectCheckpointReviewOriginal,
        "requestId" | "decision" | "note" | "createdAt" | "binding"
      >
    > = {},
  ): ProjectCheckpointReviewOriginal => {
    const base = {
      schemaVersion: 1 as const,
      requestId: (overrides.requestId ?? randomUUID()).toLowerCase(),
      binding: overrides.binding ?? binding,
      decision: overrides.decision ?? "approve",
      note: overrides.note ?? "",
      createdAt: overrides.createdAt ?? createdAt,
      commentText: "",
      intentHash: "0".repeat(64),
    };
    base.commentText = projectCheckpointReviewCommentText(base);
    base.intentHash = digest(projectCheckpointReviewIntentJson(base));
    return projectCheckpointReviewOriginalSchema.parse(base);
  };
  const scoped = (
    overrides: Partial<ProjectCheckpointReviewScope> = {},
  ): ProjectCheckpointReviewScope => ({ ...scope, ...overrides });
  return { home, workspacePath, scope, scoped, original, store };
}

function journalFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
}

test("a prepared immutable original is private, exact-retry idempotent, and globally keyed by workspace and bead", async () => {
  const { home, scope, original, store } = fixture();
  const saved = original({ note: "Private checkpoint note sentinel." });
  const first = await store.prepare(saved, 1);
  expect(first.created).toBe(true);
  expect(first.metadata).toMatchObject({
    requestId: saved.requestId,
    intentHash: saved.intentHash,
    scope,
    state: "prepared",
  });
  expect(first.receipt).toMatchObject({
    requestId: saved.requestId,
    intentHash: saved.intentHash,
    state: "prepared",
    auditEventId: 1,
  });
  expect((await store.original(scope, saved.requestId))?.original).toEqual(
    saved,
  );
  const retry = await store.prepare(saved, 2);
  expect(retry.created).toBe(false);
  expect(retry.original).toEqual(saved);
  expect(retry.receipt).toEqual(first.receipt);

  const files = journalFiles(join(home, "checkpoint-reviews"));
  expect(files).toHaveLength(1);
  expect(files[0]).not.toContain(scope.workspacePath);
  expect(files[0]).not.toContain(scope.beadId);
  expect(JSON.stringify(first.metadata)).not.toContain(saved.note);
});

test("request ID reuse with changed immutable content is refused", async () => {
  const { original, store } = fixture();
  const saved = original({ requestId: randomUUID().toLowerCase() });
  await store.prepare(saved, 10);
  const changed = original({
    requestId: saved.requestId,
    decision: "request-changes",
    note: "Describe the missing test.",
    createdAt: "2026-10-29T18:01:00.000Z",
  });
  await expect(store.prepare(changed, 11)).rejects.toBeInstanceOf(
    ConversationError,
  );
});

test("original creation time and full comment text are both hash-bound", async () => {
  const { original, store, scope } = fixture();
  const saved = original({
    decision: "request-changes",
    note: "Add one focused test.",
  });
  await store.prepare(saved, 12);
  const changed = {
    ...saved,
    createdAt: "2026-10-29T18:02:00.000Z",
  };
  changed.intentHash = digest(projectCheckpointReviewIntentJson(changed));
  await expect(store.prepare(changed, 13)).rejects.toBeInstanceOf(
    ConversationError,
  );
  expect((await store.original(scope, saved.requestId))?.original).toEqual(
    saved,
  );
});

test("one cross-instance claim wins, persists dispatching before use, and its permit cannot be reconstructed after restart", async () => {
  const { home, scope, original, store } = fixture();
  const saved = original();
  await store.prepare(saved, 20);
  const other = createProjectCheckpointReviewStore({ home, withQueueLock });
  const claims = await Promise.all([
    store.claim(scope, saved.requestId, saved.intentHash, 21),
    other.claim(scope, saved.requestId, saved.intentHash, 22),
  ]);
  expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
  expect(claims.filter((claim) => claim.kind === "held")).toHaveLength(1);
  expect((await other.metadata(scope)).items[0]?.state).toBe("unknown");
  expect(
    (await other.claim(scope, saved.requestId, saved.intentHash, 23)).kind,
  ).toBe("held");
});

test("a restarted store can settle a dispatching claim only from explicit readback", async () => {
  const { home, scope, original, store } = fixture();
  const saved = original();
  await store.prepare(saved, 24);
  const claim = await store.claim(scope, saved.requestId, saved.intentHash, 25);
  if (claim.kind !== "claimed") throw new Error("Expected the first claim.");
  const restarted = createProjectCheckpointReviewStore({ home, withQueueLock });
  const absent = await restarted.recordReadback(scope, saved.requestId, saved.intentHash, { kind: "absent" }, 26);
  expect(absent.receipt).toMatchObject({ state: "unknown", readback: "absent" });
  expect((await restarted.metadata(scope)).activeRequestId).toBe(saved.requestId);
  expect((await restarted.claim(scope, saved.requestId, saved.intentHash, 27)).kind).toBe("held");
  const confirmed = await restarted.recordReadback(
    scope,
    saved.requestId,
    saved.intentHash,
    { kind: "found", commentId: "comment-after-restart", body: saved.commentText },
    28,
  );
  expect(confirmed.receipt).toMatchObject({ state: "confirmed", readback: "found" });
});

test("only the current claim permit can finish, and an unknown delivery keeps the global bead held", async () => {
  const { home, scope, original, store } = fixture();
  const saved = original();
  await store.prepare(saved, 30);
  const claim = await store.claim(scope, saved.requestId, saved.intentHash, 31);
  if (claim.kind !== "claimed") throw new Error("Expected the first claim.");
  const other = createProjectCheckpointReviewStore({ home, withQueueLock });
  await expect(
    other.finish(claim.permit, {
      kind: "unknown",
      reportedCommentId: "comment-17",
    }, 32),
  ).rejects.toBeInstanceOf(ConversationError);
  const unknown = await store.finish(
    claim.permit,
    { kind: "unknown", reportedCommentId: "comment-17" },
    33,
  );
  expect(unknown.receipt).toMatchObject({
    state: "unknown",
    commentId: null,
    reportedCommentId: "comment-17",
  });
  const foreignScope = {
    ...scope,
    projectId: "project-3b4f8e0a-76f1-4c29-972e-4aee9c216d12",
    runSlug: "another-run",
  };
  const foreignBinding = {
    ...saved.binding,
    projectId: foreignScope.projectId,
    runSlug: foreignScope.runSlug,
  };
  const foreignStore = createProjectCheckpointReviewStore({
    home,
    withQueueLock,
  });
  const blocked = await foreignStore.metadata(foreignScope);
  expect(blocked.blocked).toBe(true);
  expect(blocked.activeRequestId).toBeNull();
  expect(JSON.stringify(blocked)).not.toContain(saved.requestId);
  expect(await foreignStore.original(foreignScope, saved.requestId)).toBeNull();
  await expect(
    foreignStore.prepare(
      original({ binding: foreignBinding, requestId: randomUUID().toLowerCase() }),
      34,
    ),
  ).rejects.toThrow();
});

test("a known pre-dispatch refusal is terminal and releases only its own active slot", async () => {
  const { scope, original, store } = fixture();
  const refusedOriginal = original();
  await store.prepare(refusedOriginal, 35);
  const claim = await store.claim(
    scope,
    refusedOriginal.requestId,
    refusedOriginal.intentHash,
    36,
  );
  if (claim.kind !== "claimed") throw new Error("Expected the first claim.");
  const refused = await store.finish(
    claim.permit,
    { kind: "refused-before-dispatch" },
    37,
  );
  expect(refused.receipt).toMatchObject({
    state: "refused",
    readback: "not-checked",
    commentId: null,
    reportedCommentId: null,
  });
  const later = original({ requestId: randomUUID().toLowerCase() });
  expect((await store.prepare(later, 38)).created).toBe(true);
});

test("explicit exact comment readback confirms, while missing or incomplete reads remain unknown", async () => {
  const { scope, original, store } = fixture();
  const saved = original();
  await store.prepare(saved, 40);
  const claim = await store.claim(scope, saved.requestId, saved.intentHash, 41);
  if (claim.kind !== "claimed") throw new Error("Expected the first claim.");
  await store.finish(
    claim.permit,
    { kind: "unknown", reportedCommentId: "comment-18" },
    42,
  );
  const absent = await store.recordReadback(
    scope,
    saved.requestId,
    saved.intentHash,
    { kind: "absent" },
    43,
  );
  expect(absent.receipt).toMatchObject({ state: "unknown", readback: "absent" });
  const incomplete = await store.recordReadback(
    scope,
    saved.requestId,
    saved.intentHash,
    { kind: "incomplete" },
    44,
  );
  expect(incomplete.receipt).toMatchObject({ state: "unknown", readback: "incomplete" });
  const wrongBody = await store.recordReadback(
    scope,
    saved.requestId,
    saved.intentHash,
    { kind: "found", commentId: "comment-18", body: `${saved.commentText}\nextra` },
    45,
  );
  expect(wrongBody.receipt).toMatchObject({ state: "unknown", readback: "mismatch" });
  const confirmed = await store.recordReadback(
    scope,
    saved.requestId,
    saved.intentHash,
    { kind: "found", commentId: "comment-18", body: saved.commentText },
    46,
  );
  expect(confirmed.receipt).toMatchObject({
    state: "confirmed",
    readback: "found",
    commentId: "comment-18",
    reportedCommentId: "comment-18",
  });
});

test("reported comment identity mismatch cannot confirm an attempt", async () => {
  const { scope, original, store } = fixture();
  const saved = original();
  await store.prepare(saved, 50);
  const claim = await store.claim(scope, saved.requestId, saved.intentHash, 51);
  if (claim.kind !== "claimed") throw new Error("Expected the first claim.");
  await store.finish(
    claim.permit,
    { kind: "unknown", reportedCommentId: "comment-19" },
    52,
  );
  const mismatch = await store.recordReadback(
    scope,
    saved.requestId,
    saved.intentHash,
    { kind: "found", commentId: "comment-20", body: saved.commentText },
    53,
  );
  expect(mismatch.receipt).toMatchObject({
    state: "unknown",
    readback: "mismatch",
    commentId: null,
    reportedCommentId: "comment-19",
  });
});

test("retiring a prepared attempt and claiming it have one CAS winner", async () => {
  const { scope, original, store, home } = fixture();
  const saved = original();
  await store.prepare(saved, 60);
  const other = createProjectCheckpointReviewStore({ home, withQueueLock });
  const results = await Promise.allSettled([
    store.retire(scope, saved.requestId, saved.intentHash, 61),
    other.claim(scope, saved.requestId, saved.intentHash, 62),
  ]);
  const retired = results.find(
    (result) => result.status === "fulfilled" && result.value.metadata.state === "retired",
  );
  const claimed = results.find(
    (result) => result.status === "fulfilled" && "kind" in result.value && result.value.kind === "claimed",
  );
  expect(Boolean(retired) !== Boolean(claimed)).toBe(true);
  if (claimed?.status === "fulfilled" && "kind" in claimed.value && claimed.value.kind === "claimed")
    expect(
      (
        await other.finish(
          claimed.value.permit,
          { kind: "unknown", reportedCommentId: null },
          63,
        )
      )
        .receipt.state,
    ).toBe("unknown");
});

test("the journal stops at its record cap without evicting historical tombstones", async () => {
  const { scope, original, store } = fixture();
  for (let index = 0; index < PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS; index++) {
    const saved = original({ requestId: randomUUID().toLowerCase() });
    await store.prepare(saved, index + 1);
    const retired = await store.retire(
      scope,
      saved.requestId,
      saved.intentHash,
      index + 101,
    );
    expect(retired.metadata.state).toBe("retired");
  }
  const before = await store.metadata(scope);
  expect(before.items).toHaveLength(PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS);
  await expect(
    store.prepare(original({ requestId: randomUUID().toLowerCase() }), 500),
  ).rejects.toBeInstanceOf(ConversationError);
  expect((await store.metadata(scope)).items).toEqual(before.items);
});

test("old terminal readback cannot change a newer active attempt", async () => {
  const { scope, original, store } = fixture();
  const first = original();
  await store.prepare(first, 70);
  const claim = await store.claim(scope, first.requestId, first.intentHash, 71);
  if (claim.kind !== "claimed") throw new Error("Expected the first claim.");
  await store.finish(
    claim.permit,
    { kind: "unknown", reportedCommentId: null },
    72,
  );
  const confirmed = await store.recordReadback(
    scope,
    first.requestId,
    first.intentHash,
    { kind: "found", commentId: "comment-21", body: first.commentText },
    73,
  );
  const second = original({ requestId: randomUUID().toLowerCase() });
  await store.prepare(second, 74);
  const replay = await store.recordReadback(
    scope,
    first.requestId,
    first.intentHash,
    { kind: "mismatch" },
    75,
  );
  expect(replay).toEqual(confirmed);
  expect((await store.metadata(scope)).activeRequestId).toBe(second.requestId);
  expect((await store.metadata(scope)).items.find((item) => item.requestId === first.requestId)?.state).toBe("confirmed");
});

test("invalid journal bytes fail closed without deleting or replacing the file", async () => {
  const { home, scope, original, store } = fixture();
  const saved = original();
  await store.prepare(saved, 80);
  const directory = join(home, "checkpoint-reviews");
  const name = journalFiles(directory)[0];
  if (!name) throw new Error("The private journal file was not created.");
  const file = join(directory, name);
  const corrupt = `corrupt-${randomUUID()}`;
  writeFileSync(file, corrupt);
  await expect(store.metadata(scope)).rejects.toBeInstanceOf(ConversationError);
  expect(readFileSync(file, "utf8")).toBe(corrupt);
});

test("oversized journal files fail closed before parsing or replacing saved bytes", async () => {
  const { home, scope, original, store } = fixture();
  await store.prepare(original(), 90);
  const directory = join(home, "checkpoint-reviews");
  const name = journalFiles(directory)[0];
  if (!name) throw new Error("The private journal file was not created.");
  const file = join(directory, name);
  const oversized = "x".repeat(PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES + 1);
  writeFileSync(file, oversized);
  await expect(store.metadata(scope)).rejects.toBeInstanceOf(ConversationError);
  expect(readFileSync(file, "utf8").length).toBe(oversized.length);
});

test("a linked journal directory is refused without writing through it", async () => {
  const { home, original, store } = fixture();
  const target = privateTempDir("checkpoint-review-target-");
  homes.push(target);
  const directory = join(home, "checkpoint-reviews");
  mkdirSync(target, { recursive: true });
  symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir");
  await expect(store.prepare(original(), 100)).rejects.toBeInstanceOf(
    ConversationError,
  );
  expect(readdirSync(target)).toEqual([]);
});

test("Windows case, separator, and trailing-slash aliases share the same global bead fence", async () => {
  const { home, original, store } = fixture();
  const windowsPath = "C:\\Repos\\Agent\\";
  const canonical = original({
    binding: { ...original().binding, workspacePath: windowsPath, checkout: windowsPath },
  });
  await store.prepare(canonical, 105);
  const aliasPath = "c:/repos/agent";
  const alias = original({
    binding: { ...canonical.binding, workspacePath: aliasPath, checkout: aliasPath },
  });
  const aliasScope = {
    projectId: alias.binding.projectId,
    workspacePath: alias.binding.workspacePath,
    runSlug: alias.binding.runSlug,
    beadId: alias.binding.beadId,
  };
  const aliasStore = createProjectCheckpointReviewStore({ home, withQueueLock });
  expect(await aliasStore.metadata(aliasScope)).toMatchObject({
    blocked: true,
    activeRequestId: null,
    items: [],
  });
  await expect(aliasStore.prepare(alias, 106)).rejects.toThrow();
});

test("a malformed active pointer and duplicate UUIDs fail closed", async () => {
  const { home, scope, original, store } = fixture();
  const saved = original();
  await store.prepare(saved, 110);
  const directory = join(home, "checkpoint-reviews");
  const name = journalFiles(directory)[0];
  if (!name) throw new Error("The private journal file was not created.");
  const file = join(directory, name);
  const validText = readFileSync(file, "utf8");
  const valid: unknown = JSON.parse(validText);
  if (!isRecord(valid) || !Array.isArray(valid.records))
    throw new Error("The saved journal shape is invalid in the test.");

  const malformed = { ...valid, activeRequestId: randomUUID().toLowerCase() };
  writeFileSync(file, JSON.stringify(malformed));
  const malformedBytes = readFileSync(file, "utf8");
  await expect(store.metadata(scope)).rejects.toBeInstanceOf(ConversationError);
  expect(readFileSync(file, "utf8")).toBe(malformedBytes);

  const first = valid.records[0];
  if (first === undefined) throw new Error("The saved record is missing.");
  const duplicate = { ...valid, records: [...valid.records, first] };
  writeFileSync(file, JSON.stringify(duplicate));
  const duplicateBytes = readFileSync(file, "utf8");
  await expect(store.metadata(scope)).rejects.toBeInstanceOf(ConversationError);
  expect(readFileSync(file, "utf8")).toBe(duplicateBytes);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
