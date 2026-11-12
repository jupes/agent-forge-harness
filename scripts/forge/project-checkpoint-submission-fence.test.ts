import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  captureProjectCheckpointReviewActions,
  createProjectCheckpointReviewOwner,
  type ProjectCheckpointReviewTarget,
} from "../../apps/desktop/src/project-checkpoint-review-client";
import type { ProjectCheckpointReviewTransport } from "../../apps/desktop/src/project-checkpoint-review-transport";
import { selectProjectCheckpointReviewView } from "../../apps/desktop/src/use-project-checkpoint-review";
import {
  type ProjectCheckpointReviewBinding,
  type ProjectCheckpointReviewOriginalRead,
  type ProjectCheckpointReviewPrepareRequest,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalSchema,
  projectCheckpointReviewPrepareRequestSchema,
} from "../../types/project-checkpoint-reviews";
import { withProjectAdmission } from "../projects/admission";
import { createProjectStore } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import { createProjectCheckpointReviewService } from "./project-checkpoint-review-service";
import { createProjectCheckpointReviewStore } from "./project-checkpoint-review-store";

const bases: string[] = [];
afterEach(() => {
  for (const allocated of bases.splice(0)) {
    const checked = resolve(allocated);
    if (
      dirname(checked) !== resolve(tmpdir()) ||
      !basename(checked).startsWith("checkpoint-fence-")
    )
      throw Error("Unexpected allocated fixture root");
    rmSync(checked, { recursive: true, force: true, maxRetries: 3 });
  }
});
const stamp = "2026-11-11T22:00:00.000Z";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "checkpoint-fence-"));
  bases.push(base);
  const home = join(base, "home"),
    workspacePath = join(base, "workspace");
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  const projects = createProjectStore(home);
  const catalog = await projects.create(
    {
      slug: "fence",
      name: "Fence",
      description: "",
      icon: "F",
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
  const scope = {
    projectId: catalog.projects[0]!.id,
    workspacePath,
    runSlug: "fence",
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
  const store = createProjectCheckpointReviewStore({
    home,
    withQueueLock,
    now: () => new Date(stamp),
    admit: <T>(id: string, work: () => T | Promise<T>) =>
      withProjectAdmission(home, id, work),
    submission: { resolveSnapshot: async () => structuredClone(snapshot) },
  });
  const authority = { current: binding };
  const calls: string[][] = [];
  const comments: Array<{
    id: string;
    issue_id: string;
    author: string;
    text: string;
    created_at: string;
  }> = [];
  const service = createProjectCheckpointReviewService({
    store,
    workspace: workspacePath,
    resolveAuthority: async () => structuredClone(authority.current),
    now: () => new Date(stamp),
    readCommentCount: async () => comments.length,
    appendEvent: () => ({ ok: true, id: 1, ulid: "fixture-event" }),
    runBd: async (args) => {
      calls.push([...args]);
      if (args[0] === "comments" && args[1] === "add") {
        const id = "comment-" + (comments.length + 1);
        comments.push({
          id,
          issue_id: scope.beadId,
          author: "fixture",
          text: args.at(-1) ?? "",
          created_at: stamp,
        });
        return {
          status: 0,
          stdout: JSON.stringify({ id, issue_id: scope.beadId }),
          stderr: "",
        };
      }
      if (args[0] === "--readonly" && args[1] === "comments")
        return { status: 0, stdout: JSON.stringify(comments), stderr: "" };
      throw Error("Unexpected inert command");
    },
  });
  const request = (expected?: string) => ({
    projectId: scope.projectId,
    runSlug: scope.runSlug,
    beadId: scope.beadId,
    request: {
      requestId: randomUUID(),
      expectedEpicId: binding.epicId,
      expectedRunUpdatedAt: binding.runUpdatedAt,
      decision: "approve" as const,
      note: "",
      ...(expected === undefined
        ? {}
        : { expectedSubmissionScopeHash: expected }),
    },
  });
  const review = () => {
    const value = {
      schemaVersion: 1 as const,
      requestId: randomUUID(),
      binding: structuredClone(binding),
      decision: "approve" as const,
      note: "",
      commentText: "",
      intentHash: "0".repeat(64),
      createdAt: stamp,
    };
    value.commentText = projectCheckpointReviewCommentText(value);
    value.intentHash = hash(projectCheckpointReviewIntentJson(value));
    return projectCheckpointReviewOriginalSchema.parse(value);
  };
  const publish = async () => {
    const original = {
      schemaVersion: 1 as const,
      kind: "publish" as const,
      requestId: randomUUID(),
      binding: structuredClone(binding),
      sourceVersion: structuredClone(snapshot.sourceVersion),
      expectedSubmissionGeneration: 0,
    };
    const saved = await store.publishSubmission(original, 1);
    const context = await store.submissionContext(scope);
    if (!context.reviewBinding)
      throw Error("Expected actual submitted binding");
    authority.current = context.reviewBinding;
    return saved;
  };
  return {
    base,
    home,
    scope,
    binding,
    snapshot,
    store,
    service,
    authority,
    calls,
    comments,
    request,
    review,
    publish,
  };
}

test("a positively retained v1 journal preserves explicit legacy preparation", async () => {
  const f = await fixture();
  const legacy = f.review();
  await f.store.prepare(legacy, 1);
  await f.store.retire(f.scope, legacy.requestId, legacy.intentHash, 2);
  expect((await f.service.prepare(f.request(), 3)).state).toBe("prepared");
  expect(f.calls).toEqual([]);
});

test("a missing journal cannot authorize omission of the checked source fence", async () => {
  const f = await fixture();
  await expect(f.service.prepare(f.request(), 1)).rejects.toThrow();
  expect(f.store.inventory(f.scope)).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("an ever-bound source cannot silently prepare against an unseen current hash", async () => {
  const f = await fixture();
  await f.publish();
  await expect(f.service.prepare(f.request(), 2)).rejects.toThrow();
  await expect(
    f.service.prepare(f.request("d".repeat(64)), 3),
  ).rejects.toThrow();
  expect(f.store.inventory(f.scope)).toEqual([]);
  expect(f.calls).toEqual([]);
});

function clientFixture(responseHash?: string) {
  const binding: ProjectCheckpointReviewBinding = {
    projectId: "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12",
    workspacePath: "C:/forge/checked",
    checkout: "C:/forge/checked",
    runSlug: "checked",
    epicId: "forge-test",
    beadId: "forge-test.1",
    runUpdatedAt: stamp,
    catalogRevision: 1,
    scopeHash: "d".repeat(64),
  };
  const {
    projectId,
    workspacePath,
    checkout,
    runSlug,
    epicId,
    beadId,
    runUpdatedAt,
  } = binding;
  const target: ProjectCheckpointReviewTarget & {
    expectedSubmissionScopeHash: string;
  } = {
    projectId,
    workspacePath,
    checkout,
    runSlug,
    epicId,
    beadId,
    runUpdatedAt,
    expectedSubmissionScopeHash: binding.scopeHash,
  };
  const scope = { projectId, workspacePath, runSlug, beadId };
  const calls: string[] = [];
  const requests: ProjectCheckpointReviewPrepareRequest[] = [];
  let saved: ProjectCheckpointReviewOriginalRead | null = null;
  const transition = (state: "confirmed" | "retired") => {
    if (!saved) throw Error("No exact saved fixture original");
    const receipt = {
      ...saved.receipt,
      state,
      commentId: state === "confirmed" ? "comment-exact" : null,
      reportedCommentId: state === "confirmed" ? "comment-exact" : null,
      readback:
        state === "confirmed" ? ("found" as const) : ("not-checked" as const),
    };
    saved = {
      original: saved.original,
      receipt,
      metadata: { ...saved.metadata, state, commentId: receipt.commentId },
    };
    return receipt;
  };
  const transport: ProjectCheckpointReviewTransport = {
    metadata: async () => ({
      schemaVersion: 1,
      scope,
      blocked: false,
      activeRequestId:
        saved?.metadata.state === "prepared" ||
        saved?.metadata.state === "unknown"
          ? saved.metadata.requestId
          : null,
      items: saved ? [saved.metadata] : [],
    }),
    prepare: async (_scope, request) => {
      calls.push("prepare");
      requests.push(structuredClone(request));
      const value = {
        schemaVersion: 1 as const,
        requestId: request.requestId,
        binding: {
          ...binding,
          scopeHash: responseHash ?? target.expectedSubmissionScopeHash,
        },
        decision: request.decision,
        note: request.note,
        commentText: "",
        intentHash: "0".repeat(64),
        createdAt: stamp,
      };
      value.commentText = projectCheckpointReviewCommentText(value);
      value.intentHash = hash(projectCheckpointReviewIntentJson(value));
      const original = projectCheckpointReviewOriginalSchema.parse(value);
      const metadata = {
        schemaVersion: 1 as const,
        requestId: original.requestId,
        intentHash: original.intentHash,
        scope,
        state: "prepared" as const,
        commentId: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      saved = {
        original,
        metadata,
        receipt: {
          schemaVersion: 1,
          requestId: original.requestId,
          intentHash: original.intentHash,
          state: "prepared",
          commentId: null,
          reportedCommentId: null,
          readback: "not-checked",
          auditEventId: 1,
          createdAt: stamp,
          updatedAt: stamp,
        },
      };
      return metadata;
    },
    original: async () => {
      calls.push("original");
      if (!saved) throw Error("Missing original");
      return structuredClone(saved);
    },
    commit: async () => {
      calls.push("commit");
      return transition("confirmed");
    },
    retire: async () => {
      calls.push("retire");
      return transition("retired");
    },
    readback: async () => {
      calls.push("readback");
      return transition("confirmed");
    },
  };
  const owner = createProjectCheckpointReviewOwner(target, transport);
  return {
    owner,
    target,
    binding,
    scope,
    calls,
    requests,
    transport,
    saved: () => structuredClone(saved),
    restore: (read: ProjectCheckpointReviewOriginalRead) => {
      saved = structuredClone(read);
    },
  };
}

test("source-fenced direct submission requires its exact observed view before Prepare", async () => {
  const c = clientFixture();
  try {
    await c.owner.refresh();
    await c.owner.submit("approve");
    expect(c.calls).toEqual([]);
  } finally {
    c.owner.dispose();
  }
});

test("a checked gesture sends its captured hash and rejects another canonical prepared binding", async () => {
  const c = clientFixture("e".repeat(64));
  try {
    await c.owner.refresh();
    const observed = c.owner.get();
    await c.owner.submit("approve", observed);
    expect(c.requests[0]?.expectedSubmissionScopeHash).toBe(
      c.target.expectedSubmissionScopeHash,
    );
    expect(c.calls).not.toContain("commit");
    expect(c.owner.get().phase).toBe("held");
  } finally {
    c.owner.dispose();
  }
});

test("a source-hash-only target change invalidates the old rendered view with Run.updatedAt unchanged", async () => {
  const c = clientFixture();
  try {
    await c.owner.refresh();
    const observed = c.owner.get();
    const next = { ...c.target, expectedSubmissionScopeHash: "e".repeat(64) };
    c.owner.setTarget(next);
    await c.owner.refresh();
    expect(c.owner.get().target.expectedSubmissionScopeHash).toBe(
      next.expectedSubmissionScopeHash,
    );
    await c.owner.submit("approve", observed);
    expect(c.calls).toEqual([]);
  } finally {
    c.owner.dispose();
  }
});

test("the optional wire fence is strict and every supplied fence must match even in legacy context", async () => {
  const f = await fixture();
  const request = f.request(f.binding.scopeHash);
  expect(
    projectCheckpointReviewPrepareRequestSchema.safeParse(request.request)
      .success,
  ).toBe(true);
  for (const invalid of [
    null,
    1,
    "A".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
  ])
    expect(
      projectCheckpointReviewPrepareRequestSchema.safeParse({
        ...request.request,
        expectedSubmissionScopeHash: invalid,
      }).success,
    ).toBe(false);
  expect(f.store.submissionInventory(f.scope).legacySource).toBe(
    "missing-context",
  );
  await expect(
    f.service.prepare(f.request("e".repeat(64)), 1),
  ).rejects.toThrow();
  const prepared = await f.service.prepare(request, 2);
  expect(prepared.state).toBe("prepared");
  expect(f.store.submissionInventory(f.scope).legacySource).toBe("verified-v1");
  await f.store.retire(f.scope, prepared.requestId, prepared.intentHash, 3);
  await expect(
    f.service.prepare(f.request("e".repeat(64)), 4),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test("service captures location, decision, note and source fence before its admission await", async () => {
  const f = await fixture();
  await f.publish();
  const expected = f.authority.current.scopeHash;
  const input: Parameters<typeof f.service.prepare>[0] = f.request(expected);
  const pending = f.service.prepare(input, 2);
  input.request.expectedSubmissionScopeHash = "e".repeat(64);
  input.request.decision = "request-changes";
  input.request.note = "private caller mutation";
  input.runSlug = "another-run";
  const metadata = await pending;
  const retained = await f.store.original(f.scope, metadata.requestId);
  expect(retained?.original).toMatchObject({
    decision: "approve",
    note: "",
    binding: { scopeHash: expected, runSlug: f.scope.runSlug },
  });
  expect(f.calls).toEqual([]);
});

test("withdrawn v2 context still requires a fence and cannot prepare a new decision", async () => {
  const f = await fixture();
  const pub = await f.publish();
  await f.store.withdrawSubmission(
    {
      schemaVersion: 1,
      kind: "withdraw",
      requestId: randomUUID(),
      scope: f.scope,
      targetSubmissionRequestId: pub.record.original.requestId,
      targetOriginalHash: pub.record.originalHash,
      expectedSubmissionGeneration: 1,
    },
    2,
  );
  expect(f.store.submissionInventory(f.scope)).toMatchObject({
    everBound: true,
    legacySource: null,
  });
  await expect(f.service.prepare(f.request(), 3)).rejects.toThrow();
  await expect(
    f.service.prepare(f.request(f.authority.current.scopeHash), 4),
  ).rejects.toThrow();
  expect(f.store.inventory(f.scope)).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("a correctly fenced service comment retains the same exact original and historical recovery", async () => {
  const f = await fixture();
  await f.publish();
  const input = f.request(f.authority.current.scopeHash);
  const prepared = await f.service.prepare(input, 2);
  f.snapshot.sourceVersion.commit = "e".repeat(40);
  await expect(
    f.service.commit(
      {
        ...f.scope,
        requestId: prepared.requestId,
        intentHash: prepared.intentHash,
      },
      3,
    ),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(
    (
      await f.service.retire(
        f.scope,
        prepared.requestId,
        prepared.intentHash,
        4,
      )
    ).state,
  ).toBe("retired");
  expect(
    (await f.service.original(f.scope, prepared.requestId))?.original.binding
      .scopeHash,
  ).toBe(input.request.expectedSubmissionScopeHash);
});

test("a current captured review gesture prepares and commits one exact checked original", async () => {
  const c = clientFixture();
  try {
    await c.owner.refresh();
    const first = captureProjectCheckpointReviewActions(
      c.owner,
      c.owner.get(),
      c.target,
      () => true,
      { active: true, writable: true },
    );
    first.setNote(" Ready for the exact source ");
    const current = captureProjectCheckpointReviewActions(
      c.owner,
      c.owner.get(),
      c.target,
      () => true,
      { active: true, writable: true },
    );
    await current.submit("request-changes");
    expect(c.calls).toEqual(["prepare", "original", "commit"]);
    expect(c.requests[0]).toMatchObject({
      expectedSubmissionScopeHash: c.target.expectedSubmissionScopeHash,
      decision: "request-changes",
      note: "Ready for the exact source",
    });
    expect(c.owner.get().phase).toBe("confirmed");
    expect(c.owner.get().original?.original.binding.scopeHash).toBe(
      c.target.expectedSubmissionScopeHash,
    );
  } finally {
    c.owner.dispose();
  }
});

test("stale render frames, target mismatch, note changes, readonly and inactive callbacks have no write effects", async () => {
  for (const change of [
    "target",
    "note",
    "hash",
    "a-b-a",
    "unmount",
    "readonly",
    "inactive",
    "owner",
    "owner-a-b-a",
  ] as const) {
    const c = clientFixture();
    const other = clientFixture();
    try {
      await c.owner.refresh();
      let live = true;
      const frame = { owner: c.owner };
      let selectedFrame = frame;
      const rendered =
        change === "target"
          ? { ...c.target, beadId: "forge-test.2" }
          : c.target;
      const callbacks = captureProjectCheckpointReviewActions(
        c.owner,
        c.owner.get(),
        rendered,
        () => live && selectedFrame === frame,
        { active: change !== "inactive", writable: change !== "readonly" },
      );
      if (change === "note") c.owner.setNote("new current note");
      if (change === "hash")
        c.owner.setTarget({
          ...c.target,
          expectedSubmissionScopeHash: "e".repeat(64),
        });
      if (change === "a-b-a") {
        c.owner.setTarget({ ...c.target, beadId: "forge-test.2" });
        c.owner.setTarget(c.target);
      }
      if (change === "unmount") live = false;
      if (change === "owner" || change === "owner-a-b-a")
        selectedFrame = { owner: other.owner };
      if (change === "owner-a-b-a") selectedFrame = { owner: c.owner };
      await callbacks.submit("approve");
      callbacks.setNote("stale callback note");
      await callbacks.recordSaved();
      await callbacks.retirePrepared();
      await callbacks.checkRecordedComment();
      expect(c.calls).toEqual([]);
      if (change === "note")
        expect(c.owner.get().note).toBe("new current note");
    } finally {
      c.owner.dispose();
      other.owner.dispose();
    }
  }
});

test("same-owner cached views cannot reappear after an A to B to A transition", async () => {
  const c = clientFixture();
  try {
    await c.owner.refresh();
    const snapshot = { owner: c.owner, view: c.owner.get() };
    c.owner.setTarget({ ...c.target, beadId: "forge-test.2" });
    c.owner.setTarget(c.target);
    c.owner.setNote("current after return");
    const selected = selectProjectCheckpointReviewView(c.owner, snapshot);
    expect(selected).toBe(c.owner.get());
    expect(selected).not.toBe(snapshot.view);
    expect(selected.note).toBe("current after return");
  } finally {
    c.owner.dispose();
  }
});

test("a source-only target change during Prepare retains the exact original without autoCommit", async () => {
  const c = clientFixture();
  try {
    await c.owner.refresh();
    const initial = c.transport.prepare;
    let release = () => {};
    let entered = () => {};
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const observed = new Promise<void>((resolveObserved) => {
      entered = resolveObserved;
    });
    c.transport.prepare = async (scope, request) => {
      const metadata = await initial(scope, request);
      entered();
      await hold;
      return metadata;
    };
    const pending = c.owner.submit("approve", c.owner.get());
    await observed;
    c.owner.setTarget({
      ...c.target,
      expectedSubmissionScopeHash: "e".repeat(64),
    });
    release();
    await pending;
    expect(c.calls).not.toContain("commit");
    expect(c.saved()?.metadata.state).toBe("prepared");
    expect(c.saved()?.original.binding.scopeHash).toBe(
      c.target.expectedSubmissionScopeHash,
    );
  } finally {
    c.owner.dispose();
  }
});

test("historical prepared retirement and unknown exact readback remain available after the target fence changes", async () => {
  for (const state of ["prepared", "unknown"] as const) {
    const c = clientFixture();
    try {
      const request = {
        requestId: randomUUID(),
        expectedEpicId: c.binding.epicId,
        expectedRunUpdatedAt: c.binding.runUpdatedAt,
        expectedSubmissionScopeHash: c.target.expectedSubmissionScopeHash,
        decision: "approve" as const,
        note: "",
      };
      await c.transport.prepare(c.scope, request);
      const retained = c.saved();
      if (!retained) throw Error("Expected retained original");
      if (state === "unknown")
        c.restore({
          ...retained,
          metadata: { ...retained.metadata, state },
          receipt: { ...retained.receipt, state },
        });
      c.owner.setTarget({
        ...c.target,
        expectedSubmissionScopeHash: "e".repeat(64),
      });
      await c.owner.refresh();
      await c.owner.openSaved(request.requestId);
      c.calls.length = 0;
      const actions = captureProjectCheckpointReviewActions(
        c.owner,
        c.owner.get(),
        c.owner.get().target,
        () => true,
        { active: false, writable: true },
      );
      if (state === "prepared") await actions.retirePrepared();
      else await actions.checkRecordedComment();
      expect(c.calls).toEqual([state === "prepared" ? "retire" : "readback"]);
      expect(c.owner.get().original?.original.intentHash).toBe(
        retained.original.intentHash,
      );
      expect(c.owner.get().original?.original.binding.scopeHash).toBe(
        c.target.expectedSubmissionScopeHash,
      );
    } finally {
      c.owner.dispose();
    }
  }
});

test("stale and readonly saved-decision callbacks cannot commit, retire or read back another live view", async () => {
  for (const action of [
    "recordSaved",
    "retirePrepared",
    "checkRecordedComment",
  ] as const) {
    for (const reason of ["changed-view", "readonly", "unmounted"] as const) {
      const c = clientFixture();
      try {
        const request = {
          requestId: randomUUID(),
          expectedEpicId: c.binding.epicId,
          expectedRunUpdatedAt: c.binding.runUpdatedAt,
          expectedSubmissionScopeHash: c.target.expectedSubmissionScopeHash,
          decision: "approve" as const,
          note: "",
        };
        await c.transport.prepare(c.scope, request);
        const retained = c.saved();
        if (!retained) throw Error("Expected retained original");
        if (action === "checkRecordedComment")
          c.restore({
            ...retained,
            metadata: { ...retained.metadata, state: "unknown" },
            receipt: { ...retained.receipt, state: "unknown" },
          });
        await c.owner.refresh();
        await c.owner.openSaved(request.requestId);
        c.calls.length = 0;
        const callbacks = captureProjectCheckpointReviewActions(
          c.owner,
          c.owner.get(),
          c.target,
          () => reason !== "unmounted",
          { active: true, writable: reason !== "readonly" },
        );
        if (reason === "changed-view")
          c.owner.setNote("different rendered note");
        await callbacks[action]();
        expect(c.calls).toEqual([]);
        expect(c.saved()?.metadata.state).toBe(
          action === "checkRecordedComment" ? "unknown" : "prepared",
        );
      } finally {
        c.owner.dispose();
      }
    }
  }
});

test("a correctly fenced v2 service decision records one exact comment and terminal replay remains historical", async () => {
  const f = await fixture();
  await f.publish();
  const input = f.request(f.authority.current.scopeHash);
  const metadata = await f.service.prepare(input, 2);
  const command = {
    ...f.scope,
    requestId: metadata.requestId,
    intentHash: metadata.intentHash,
  };
  const receipt = await f.service.commit(command, 3);
  expect(receipt).toMatchObject({ state: "confirmed", readback: "found" });
  expect(f.comments).toHaveLength(1);
  expect(
    f.calls.filter((args) => args[0] === "comments" && args[1] === "add"),
  ).toHaveLength(1);
  f.authority.current = { ...f.authority.current, scopeHash: "e".repeat(64) };
  expect(await f.service.commit(command, 4)).toEqual(receipt);
  expect(f.comments).toHaveLength(1);
  expect(
    (await f.service.original(f.scope, metadata.requestId))?.original.binding
      .scopeHash,
  ).toBe(input.request.expectedSubmissionScopeHash);
});

test("a disposed retained owner cannot dispatch a saved-decision callback", async () => {
  for (const action of [
    "recordSaved",
    "retirePrepared",
    "checkRecordedComment",
  ] as const) {
    const c = clientFixture();
    try {
      const request = {
        requestId: randomUUID(),
        expectedEpicId: c.binding.epicId,
        expectedRunUpdatedAt: c.binding.runUpdatedAt,
        expectedSubmissionScopeHash: c.target.expectedSubmissionScopeHash,
        decision: "approve" as const,
        note: "",
      };
      await c.transport.prepare(c.scope, request);
      const retained = c.saved();
      if (!retained) throw Error("Expected retained original");
      if (action === "checkRecordedComment")
        c.restore({
          ...retained,
          metadata: { ...retained.metadata, state: "unknown" },
          receipt: { ...retained.receipt, state: "unknown" },
        });
      await c.owner.refresh();
      await c.owner.openSaved(request.requestId);
      c.calls.length = 0;
      const callbacks = captureProjectCheckpointReviewActions(
        c.owner,
        c.owner.get(),
        c.target,
        () => true,
        { active: true, writable: true },
      );
      c.owner.dispose();
      await callbacks[action]();
      expect(c.calls).toEqual([]);
    } finally {
      c.owner.dispose();
    }
  }
});
