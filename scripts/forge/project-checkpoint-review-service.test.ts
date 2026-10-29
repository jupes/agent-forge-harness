import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import type { AppendResult } from "../ledger/append";
import {
  type ProjectCheckpointReviewBinding,
  type ProjectCheckpointReviewOriginal,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalSchema,
} from "../../types/project-checkpoint-reviews";
import { privateTempDir } from "../hearth/testing";
import { withQueueLock } from "../scheduler/queue-lock";
import { createProjectCheckpointReviewStore } from "./project-checkpoint-review-store";
import { createProjectCheckpointReviewService } from "./project-checkpoint-review-service";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const projectId = "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12";
const beadId = "agent-forge-harness-cla5.7.1.4";
const epicId = "agent-forge-harness-cla5.7";
const stamp = "2026-10-29T18:00:00.000Z";
const scopeHash = "a".repeat(64);

function fixture(
  appendEvent: (event: LedgerEventInput) => AppendResult = () => ({
    ok: true,
    id: 1,
    ulid: "fixture-event",
  }),
) {
  const home = privateTempDir("checkpoint-review-service-");
  homes.push(home);
  const workspacePath = resolve(home, "workspace");
  const binding: ProjectCheckpointReviewBinding = {
    projectId,
    workspacePath,
    checkout: workspacePath,
    runSlug: "feat-run-checkpoints",
    epicId,
    beadId,
    runUpdatedAt: stamp,
    catalogRevision: 4,
    scopeHash,
  };
  const scope = {
    projectId,
    workspacePath,
    runSlug: binding.runSlug,
    beadId,
  };
  const original = (requestId = randomUUID().toLowerCase()): ProjectCheckpointReviewOriginal => {
    const value = {
      schemaVersion: 1 as const,
      requestId,
      binding,
      decision: "approve" as const,
      note: "",
      createdAt: stamp,
      commentText: "",
      intentHash: "0".repeat(64),
    };
    value.commentText = projectCheckpointReviewCommentText(value);
    value.intentHash = createHash("sha256")
      .update(projectCheckpointReviewIntentJson(value), "utf8")
      .digest("hex");
    return projectCheckpointReviewOriginalSchema.parse(value);
  };
  const commands: string[][] = [];
  const comments = new Map<string, unknown[]>();
  const counts = new Map<string, number>();
  const store = createProjectCheckpointReviewStore({ home, withQueueLock });
  const eventDeps = {
    workspace: workspacePath,
    appendEvent,
  };
  const service = createProjectCheckpointReviewService({
    store,
    ...eventDeps,
    resolveAuthority: async () => binding,
    readCommentCount: async (_projectId, target) => counts.get(target) ?? null,
    runBd: async (args) => {
      commands.push(args);
      if (args[0] === "comments" && args[1] === "add") {
        const body = args.at(-1) ?? "";
        const commentId = `comment-${commands.length}`;
        const rows = comments.get(beadId) ?? [];
        rows.push({
          id: commentId,
          issue_id: beadId,
          author: "fixture",
          text: body,
          created_at: stamp,
        });
        comments.set(beadId, rows);
        counts.set(beadId, rows.length);
        return {
          status: 0,
          stdout: JSON.stringify({ id: commentId, issue_id: beadId }),
          stderr: "",
        };
      }
      if (args[0] === "--readonly" && args[1] === "comments")
        return {
          status: 0,
          stdout: JSON.stringify(comments.get(args[2] ?? "") ?? []),
          stderr: "",
        };
      throw new Error("Unexpected tracker command.");
    },
    now: () => new Date(stamp),
  });
  const request = (requestId = randomUUID().toLowerCase(), note = "") => ({
    projectId,
    workspacePath,
    runSlug: binding.runSlug,
    beadId,
    request: {
      requestId,
      expectedEpicId: epicId,
      expectedRunUpdatedAt: stamp,
      decision: "approve" as const,
      note,
    },
  });
  return { home, binding, scope, original, store, service, commands, comments, counts, request, eventDeps };
}

test("prepare returns metadata only and exact UUID replay retains its original timestamp", async () => {
  const { service, request, scope, store } = fixture();
  const input = request(randomUUID().toLowerCase(), "Private checkpoint note sentinel.");
  const first = await service.prepare(input, 1);
  const saved = await store.original(scope, input.request.requestId);
  if (!saved) throw new Error("The prepared original was not retained.");
  expect(JSON.stringify(first)).not.toContain(saved.original.commentText);
  expect(JSON.stringify(first)).not.toContain(saved.original.note);
  const replay = await service.prepare(input, 2);
  const replayed = await store.original(scope, input.request.requestId);
  expect(replay).toEqual(first);
  expect(replayed?.original.createdAt).toBe(saved.original.createdAt);
  expect(replayed?.original.intentHash).toBe(saved.original.intentHash);
});

test("commit sends one exact review comment, then confirms only its full readback", async () => {
  const { service, request, commands, scope, store, binding, eventDeps } = fixture();
  const input = request();
  const prepared = await service.prepare(input, 10);
  const receipt = await service.commit(
    { ...input, requestId: input.request.requestId, intentHash: prepared.intentHash },
    11,
  );
  const saved = await store.original(scope, input.request.requestId);
  if (!saved) throw new Error("The original disappeared after commit.");
  expect(commands.filter((args) => args[0] === "comments" && args[1] === "add"))
    .toEqual([["comments", "add", "--json", "--", beadId, saved.original.commentText]]);
  expect(receipt).toMatchObject({ state: "confirmed", readback: "found" });
  expect(receipt.commentId).toBeTruthy();
  const changedAuthority = createProjectCheckpointReviewService({
    store,
    ...eventDeps,
    resolveAuthority: async () => ({ ...binding, runUpdatedAt: "2026-10-29T18:01:00.000Z" }),
    readCommentCount: async () => null,
    runBd: async () => { throw new Error("A completed replay must not write another comment."); },
  });
  expect(await changedAuthority.commit(
    { ...input, requestId: input.request.requestId, intentHash: prepared.intentHash },
    12,
  )).toEqual(receipt);
  expect(commands.filter((args) => args[0] === "comments" && args[1] === "add")).toHaveLength(1);
});

test("ledger failure after exact comment confirmation never repeats the comment or changes the receipt", async () => {
  const failures: Array<(event: LedgerEventInput) => AppendResult> = [
    () => ({ ok: false, error: "ledger unavailable" }),
    () => { throw new Error("ledger unavailable"); },
  ];
  for (const appendFailure of failures) {
    let appendCalls = 0;
    const f = fixture((event) => {
      appendCalls++;
      return appendFailure(event);
    });
    const input = f.request();
    const prepared = await f.service.prepare(input, 15);
    const args = { ...input, requestId: input.request.requestId, intentHash: prepared.intentHash };
    const confirmed = await f.service.commit(args, 16);
    expect(confirmed).toMatchObject({ state: "confirmed", readback: "found" });
    expect(appendCalls).toBe(1);
    expect(f.commands.filter((row) => row[0] === "comments" && row[1] === "add")).toHaveLength(1);
    expect(await f.service.readback(f.scope, input.request.requestId, prepared.intentHash, 17)).toEqual(confirmed);
    expect(appendCalls).toBe(1);
    expect(f.commands.filter((row) => row[0] === "comments" && row[1] === "add")).toHaveLength(1);
  }
});

test("a changed run authority after the durable claim refuses before starting bd", async () => {
  const f = fixture();
  const input = f.request();
  const prepared = await f.service.prepare(input, 20);
  let reads = 0;
  const other = createProjectCheckpointReviewService({
    store: f.store,
    ...f.eventDeps,
    resolveAuthority: async () => {
      reads++;
      return reads === 1 ? f.binding : { ...f.binding, runUpdatedAt: "2026-10-29T18:01:00.000Z" };
    },
    readCommentCount: async () => 0,
    runBd: async () => {
      throw new Error("The tracker effect must not start after authority changed.");
    },
  });
  const receipt = await other.commit(
    { ...input, requestId: input.request.requestId, intentHash: prepared.intentHash },
    21,
  );
  expect(receipt.state).toBe("refused");
  expect((await f.store.metadata(f.scope)).activeRequestId).toBeNull();
});

test("an uncertain started write is held and explicit readback can confirm without retrying it", async () => {
  const f = fixture();
  const input = f.request();
  const prepared = await f.service.prepare(input, 30);
  let addCalls = 0;
  const uncertain = createProjectCheckpointReviewService({
    store: f.store,
    ...f.eventDeps,
    resolveAuthority: async () => f.binding,
    readCommentCount: async () => 1,
    runBd: async (args) => {
      if (args[0] === "comments" && args[1] === "add") {
        addCalls++;
        return { status: 1, stdout: "", stderr: "write outcome unknown" };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{
          id: "comment-existing",
          issue_id: beadId,
          author: "fixture",
          text: (await f.store.original(f.scope, input.request.requestId))?.original.commentText ?? "",
          created_at: stamp,
        }]),
        stderr: "",
      };
    },
  });
  const first = await uncertain.commit(
    { ...input, requestId: input.request.requestId, intentHash: prepared.intentHash },
    31,
  );
  expect(first.state).toBe("unknown");
  const held = await uncertain.commit(
    { ...input, requestId: input.request.requestId, intentHash: prepared.intentHash },
    32,
  );
  expect(held.state).toBe("unknown");
  const verified = await uncertain.readback(f.scope, input.request.requestId, prepared.intentHash, 33);
  expect(verified).toMatchObject({ state: "confirmed", readback: "found" });
  expect(addCalls).toBe(1);
});

test("a thrown tracker runner after claim is unknown and never dispatched twice", async () => {
  const f = fixture();
  const input = f.request();
  const prepared = await f.service.prepare(input, 34);
  let calls = 0;
  const uncertain = createProjectCheckpointReviewService({
    store: f.store,
    ...f.eventDeps,
    resolveAuthority: async () => f.binding,
    readCommentCount: async () => null,
    runBd: async () => {
      calls++;
      throw new Error("The runner lost its response after dispatch.");
    },
  });
  const args = { ...input, requestId: input.request.requestId, intentHash: prepared.intentHash };
  expect((await uncertain.commit(args, 35)).state).toBe("unknown");
  expect((await uncertain.commit(args, 36)).state).toBe("unknown");
  expect(calls).toBe(1);
});

test("wrong issue, duplicated UUID markers, and unstable comment IDs keep readback unknown", async () => {
  for (const scenario of ["absent", "count-mismatch", "wrong-issue", "duplicate-marker", "reported-id-mismatch"] as const) {
    const f = fixture();
    const input = f.request();
    const prepared = await f.service.prepare(input, 37);
    const saved = await f.store.original(f.scope, input.request.requestId);
    if (!saved) throw new Error("Missing prepared original for readback test.");
    let addCalls = 0;
    const rows = scenario === "absent"
      ? []
      : scenario === "duplicate-marker"
      ? ["a", "b"].map((id) => ({ id, issue_id: beadId, author: "fixture", text: saved.original.commentText, created_at: stamp }))
      : [{
          id: scenario === "reported-id-mismatch" ? "other-comment" : "comment-a",
          issue_id: scenario === "wrong-issue" ? "other-bead" : beadId,
          author: "fixture",
          text: saved.original.commentText,
          created_at: stamp,
        }];
    const uncertain = createProjectCheckpointReviewService({
      store: f.store,
      ...f.eventDeps,
      resolveAuthority: async () => f.binding,
      readCommentCount: async () => rows.length + (scenario === "count-mismatch" ? 1 : 0),
      runBd: async (args) => {
        if (args[0] === "comments" && args[1] === "add") {
          addCalls++;
          return { status: 0, stdout: JSON.stringify({ id: "reported-comment", issue_id: beadId }), stderr: "" };
        }
        return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
      },
    });
    const receipt = await uncertain.commit(
      { ...input, requestId: input.request.requestId, intentHash: prepared.intentHash },
      38,
    );
    expect(receipt.state).toBe("unknown");
    expect(addCalls).toBe(1);
    const checked = await uncertain.readback(f.scope, input.request.requestId, prepared.intentHash, 39);
    expect(checked.state).toBe("unknown");
    expect(addCalls).toBe(1);
  }
});

test("service close fences new admission and drains a pending authority read", async () => {
  const f = fixture();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const service = createProjectCheckpointReviewService({
    store: f.store,
    ...f.eventDeps,
    resolveAuthority: async () => {
      entered();
      await waiting;
      return f.binding;
    },
    readCommentCount: async () => null,
    runBd: async () => ({ status: 0, stdout: "[]", stderr: "" }),
  });
  const pending = service.prepare(f.request(), 40);
  await started;
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await Promise.all([pending, closing]);
  expect(closed).toBe(true);
  await expect(service.prepare(f.request(), 41)).rejects.toThrow();
});
