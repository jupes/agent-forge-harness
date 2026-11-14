import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProjectCheckpointReviewMetadata } from "../../../types/project-checkpoint-reviews";
import { projectCheckpointSourceContextReadSchema } from "../../../types/project-checkpoint-source-context";
import { projectCheckpointSubmissionOriginalJson } from "../../../types/project-checkpoint-submissions";
import { createProjectCheckpointReviewOwner } from "./project-checkpoint-review-client";
import type { ProjectCheckpointReviewTransport } from "./project-checkpoint-review-transport";
import {
  captureProjectCheckpointSourceReview,
  createProjectCheckpointSourceOwner,
  focusProjectCheckpointReviewEntry,
  readProjectCheckpointSourceContext,
} from "./project-checkpoint-source-client";

const target = {
  projectId: "project-12345678-1234-4234-8234-123456789abc",
  workspacePath: "/served/workspace",
  checkout: "/served/workspace",
  runSlug: "demo",
  epicId: "forge-demo",
  beadId: "forge-demo.1",
  runUpdatedAt: "2026-11-13T00:00:00.000Z",
};
test("source refresh revokes readiness before awaiting and ignores unavailable evidence", async () => {
  let revoked = 0;
  const owner = createProjectCheckpointSourceOwner(target, {
    read: async () => ({
      available: false,
      error:
        "The checkpoint source context is unavailable. Read saved source records before trying again.",
    }),
    onRevoke: () => {
      revoked++;
    },
  });
  const pending = owner.refresh();
  expect(owner.get().ready).toBe(false);
  expect(revoked).toBe(1);
  await pending;
  expect(owner.get().ready).toBe(false);
  owner.dispose();
});

function currentSource() {
  const binding = { ...target, catalogRevision: 1, scopeHash: "a".repeat(64) };
  const sourceVersion = {
    kind: "committed-git-snapshot" as const,
    commit: "b".repeat(40),
    tree: "c".repeat(40),
  };
  const original = {
    schemaVersion: 1 as const,
    kind: "publish" as const,
    requestId: "12345678-1234-4234-8234-123456789abc",
    binding,
    sourceVersion,
    expectedSubmissionGeneration: 0,
  };
  const originalHash = createHash("sha256")
    .update(projectCheckpointSubmissionOriginalJson(original))
    .digest("hex");
  const reviewScopeHash = createHash("sha256")
    .update(
      JSON.stringify({
        family: "checkpoint-source-submission",
        originalHash,
        schemaVersion: 1,
      }),
    )
    .digest("hex");
  const scope = {
    projectId: target.projectId,
    workspacePath: target.workspacePath,
    runSlug: target.runSlug,
    beadId: target.beadId,
  };
  const record = {
    original,
    originalHash,
    receipt: {
      schemaVersion: 1,
      requestId: original.requestId,
      originalHash,
      scope,
      state: "applied",
      observedGeneration: 0,
      resultingGeneration: 1,
      auditEventId: 1,
      appliedAt: target.runUpdatedAt,
      reviewScopeHash,
    },
  };
  return projectCheckpointSourceContextReadSchema.parse({
    available: true,
    context: {
      state: "current",
      generation: 1,
      continuity: "anchored",
      baseBinding: binding,
      sourceVersion,
      reviewBinding: { ...binding, scopeHash: reviewScopeHash },
      record,
      foreign: null,
    },
  });
}
test("refresh is already revoked inside its synchronous revocation callback", async () => {
  const checks: boolean[] = [];
  const owner = createProjectCheckpointSourceOwner(target, {
    read: async () => currentSource(),
    onRevoke: () => {
      checks.push(owner.isCurrent(target));
    },
  });
  await owner.refresh();
  expect(owner.get().ready).toBe(true);
  await owner.refresh();
  expect(checks).toEqual([false, false]);
  owner.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test("source refresh cancels an actual existing-owner pending Prepare before autoCommit", async () => {
  let review: ReturnType<typeof createProjectCheckpointReviewOwner> | undefined;
  const source = createProjectCheckpointSourceOwner(target, {
    read: async () => currentSource(),
    onRevoke: () => review?.invalidatePending(),
  });
  await source.refresh();
  const rendered = captureProjectCheckpointSourceReview(source, target, {
    active: true,
    writable: true,
  });
  const held = deferred<ProjectCheckpointReviewMetadata>(),
    entered = deferred<void>();
  const scope = {
    projectId: target.projectId,
    workspacePath: target.workspacePath,
    runSlug: target.runSlug,
    beadId: target.beadId,
  };
  let requestId = "",
    prepares = 0,
    commits = 0,
    originals = 0;
  const transport: ProjectCheckpointReviewTransport = {
    metadata: async () => ({
      schemaVersion: 1,
      scope,
      activeRequestId: null,
      blocked: false,
      items: [],
    }),
    original: async () => {
      originals++;
      throw Error("Original must not be fetched automatically");
    },
    prepare: async (_scope, request) => {
      prepares++;
      requestId = request.requestId;
      expect(request.expectedSubmissionScopeHash).toBe(
        rendered.target.expectedSubmissionScopeHash,
      );
      entered.resolve();
      return held.promise;
    },
    commit: async () => {
      commits++;
      throw Error("Must not autoCommit after source refresh");
    },
    retire: async () => {
      throw Error("Unused");
    },
    readback: async () => {
      throw Error("Unused");
    },
  };
  review = createProjectCheckpointReviewOwner(rendered.target, transport);
  await review.refresh();
  review.setNote("Keep this note");
  const pending = review.submit("approve", review.get());
  await entered.promise;
  const refreshed = source.refresh();
  expect(source.get().ready).toBe(false);
  expect(rendered.isSourceCurrent()).toBe(false);
  expect(review.get().phase).toBe("held");
  held.resolve({
    schemaVersion: 1,
    requestId,
    intentHash: "d".repeat(64),
    scope,
    state: "prepared",
    commentId: null,
    createdAt: target.runUpdatedAt,
    updatedAt: target.runUpdatedAt,
  });
  await pending;
  await refreshed;
  expect(prepares).toBe(1);
  expect(commits).toBe(0);
  expect(originals).toBe(0);
  expect(review.get().note).toBe("Keep this note");
  expect(rendered.isSourceCurrent()).toBe(false);
  source.dispose();
  review.dispose();
});
test("late A-to-B-to-A responses cannot restore readiness", async () => {
  const held = deferred<ReturnType<typeof currentSource>>();
  let reads = 0;
  const owner = createProjectCheckpointSourceOwner(target, {
    read: async () => (++reads === 1 ? held.promise : currentSource()),
  });
  const old = owner.refresh();
  owner.setTarget(
    { ...target, beadId: "forge-demo.2" },
    { active: true, writable: true },
  );
  owner.setTarget(target, { active: true, writable: true });
  await owner.refresh();
  const current = owner.get();
  held.resolve(currentSource());
  await old;
  expect(owner.get()).toBe(current);
  expect(owner.get().ready).toBe(true);
  owner.dispose();
});
test("permission loss and disposal revoke immediately and ignore late completion", async () => {
  const held = deferred<ReturnType<typeof currentSource>>();
  let signal: AbortSignal | undefined;
  const owner = createProjectCheckpointSourceOwner(target, {
    read: async (_target, captured) => {
      signal = captured;
      return held.promise;
    },
  });
  const pending = owner.refresh();
  owner.setTarget(target, { active: true, writable: false });
  expect(owner.isCurrent(target)).toBe(false);
  expect(signal?.aborted).toBe(true);
  owner.dispose();
  held.resolve(currentSource());
  await pending;
  expect(owner.get().ready).toBe(false);
  await owner.refresh();
  expect(owner.get().ready).toBe(false);
});
test("valid-but-stale source and forged source digests cannot enable new decisions", async () => {
  const current = currentSource();
  if (!current.available || !current.context.record)
    throw Error("Missing fixture source");
  for (const value of [
    {
      ...current,
      context: {
        ...current.context,
        state: "stale",
        reviewBinding: null,
        sourceVersion: {
          ...current.context.sourceVersion,
          commit: "d".repeat(40),
        },
      },
    },
    {
      ...current,
      context: {
        ...current.context,
        record: {
          ...current.context.record,
          originalHash: "d".repeat(64),
          receipt: {
            ...current.context.record.receipt,
            originalHash: "d".repeat(64),
          },
        },
      },
    },
    {
      ...current,
      context: {
        ...current.context,
        baseBinding: {
          ...current.context.baseBinding,
          checkout: "/another/checkout",
        },
        state: "stale",
        reviewBinding: null,
      },
    },
  ]) {
    const owner = createProjectCheckpointSourceOwner(target, {
      read: async () => projectCheckpointSourceContextReadSchema.parse(value),
    });
    await owner.refresh();
    expect(owner.get().ready).toBe(false);
    owner.dispose();
  }
});

test("reentrant refresh cannot give an older call the newer generation", async () => {
  const held = deferred<ReturnType<typeof currentSource>>();
  let revokes = 0,
    reads = 0,
    nested: Promise<void> | undefined;
  const owner = createProjectCheckpointSourceOwner(target, {
    read: async () => {
      reads++;
      return held.promise;
    },
    onRevoke: () => {
      if (++revokes === 1) nested = owner.refresh();
    },
  });
  const outer = owner.refresh();
  try {
    expect(reads).toBe(1);
  } finally {
    owner.dispose();
    held.resolve(currentSource());
    await outer;
    await nested;
  }
});

test("invalid UTF8 cancels the actual bounded source-response reader", async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([255]));
    },
    cancel() {
      cancelled++;
    },
  });
  await expect(
    readProjectCheckpointSourceContext(
      target,
      new AbortController().signal,
      async () => new Response(body),
    ),
  ).rejects.toThrow();
  expect(cancelled).toBe(1);
});

test("actual response reader preserves protected URL, signal and byte receiving cap", async () => {
  const controller = new AbortController();
  const result = await readProjectCheckpointSourceContext(
    target,
    controller.signal,
    async (path, options, bounds) => {
      expect(path).toBe(
        "/__agent-forge/projects/" +
          target.projectId +
          "/runs/demo/checkpoints/forge-demo.1/source-context",
      );
      expect(options?.signal).toBe(controller.signal);
      expect(bounds?.maxBodyBytes).toBe(128 * 1024);
      return new Response(
        JSON.stringify({ ok: true, data: currentSource(), error: null }),
      );
    },
  );
  expect(result.available).toBe(true);
});
test("oversized source responses cancel and malformed envelopes refuse", async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(128 * 1024 + 1));
    },
    cancel() {
      cancelled++;
    },
  });
  await expect(
    readProjectCheckpointSourceContext(
      target,
      new AbortController().signal,
      async () => new Response(body),
    ),
  ).rejects.toThrow();
  expect(cancelled).toBe(1);
  for (const text of [
    "invalid",
    JSON.stringify({ ok: false, data: null, error: "private" }),
    JSON.stringify({ ok: true, data: { available: true }, error: null }),
  ])
    await expect(
      readProjectCheckpointSourceContext(
        target,
        new AbortController().signal,
        async () => new Response(text),
      ),
    ).rejects.toThrow();
});
test("late canonical and derived digest completions cannot restore revoked readiness", async () => {
  for (const stage of [1, 2]) {
    const entered = deferred<void>(),
      held = deferred<string>();
    let hashes = 0,
      delayedText = "";
    const owner = createProjectCheckpointSourceOwner(target, {
      read: async () => currentSource(),
      digest: async (text) => {
        if (++hashes === stage) {
          delayedText = text;
          entered.resolve();
          return held.promise;
        }
        return createHash("sha256").update(text).digest("hex");
      },
    });
    const pending = owner.refresh();
    await entered.promise;
    owner.setTarget(target, { active: true, writable: false });
    const revoked = owner.get();
    held.resolve(createHash("sha256").update(delayedText).digest("hex"));
    await pending;
    expect(owner.get()).toBe(revoked);
    expect(owner.get().ready).toBe(false);
    owner.dispose();
  }
});
test("unbound, withdrawn and foreign source contexts never authorize a new decision", async () => {
  const current = currentSource();
  if (!current.available) throw Error("Missing fixture");
  for (const state of ["unbound", "withdrawn", "foreign"] as const) {
    const response = projectCheckpointSourceContextReadSchema.parse({
      available: true,
      context: {
        ...current.context,
        state,
        generation: state === "unbound" ? 0 : 2,
        continuity: state === "unbound" ? "legacy-unverified" : "anchored",
        reviewBinding: null,
        record: null,
        foreign:
          state === "foreign"
            ? {
                projectId: "project-22345678-1234-4234-8234-123456789abc",
                runSlug: "other",
                beadId: target.beadId,
              }
            : null,
      },
    });
    const owner = createProjectCheckpointSourceOwner(target, {
      read: async () => response,
    });
    await owner.refresh();
    expect(owner.get().context?.state).toBe(state);
    expect(owner.isCurrent(target)).toBe(false);
    owner.dispose();
  }
});
test("late read errors and stale rendered refresh callbacks do not affect a newer view", async () => {
  const held = deferred<ReturnType<typeof currentSource>>();
  let reads = 0;
  const owner = createProjectCheckpointSourceOwner(target, {
    read: async () => (++reads === 1 ? held.promise : currentSource()),
  });
  const old = owner.refresh();
  const oldFrame = captureProjectCheckpointSourceReview(owner, target, {
    active: true,
    writable: true,
  });
  await owner.refresh();
  const current = owner.get();
  held.reject(Error("old private failure"));
  await old;
  await oldFrame.refresh();
  expect(owner.get()).toBe(current);
  expect(reads).toBe(2);
  expect(owner.get().error).toBe("");
  expect(oldFrame.isSourceCurrent()).toBe(false);
  owner.dispose();
});

test("every routed source target field is checked before readiness", async () => {
  for (const next of [
    { ...target, projectId: "project-22345678-1234-4234-8234-123456789abc" },
    { ...target, workspacePath: "/other/workspace" },
    { ...target, checkout: "/other/checkout" },
    { ...target, runSlug: "other" },
    { ...target, epicId: "forge-other" },
    { ...target, beadId: "forge-demo.2" },
    { ...target, runUpdatedAt: "2026-11-14T00:00:00.000Z" },
  ]) {
    const owner = createProjectCheckpointSourceOwner(next, {
      read: async () => currentSource(),
    });
    await owner.refresh();
    expect(owner.isCurrent(next)).toBe(false);
    owner.dispose();
  }
});
test("inactive checkpoints do not request source capture", async () => {
  let reads = 0;
  const owner = createProjectCheckpointSourceOwner(target, {
    active: false,
    read: async () => {
      reads++;
      return currentSource();
    },
  });
  await owner.refresh();
  expect(reads).toBe(0);
  owner.setTarget(target, { active: true, writable: true });
  await owner.refresh();
  expect(reads).toBe(1);
  expect(owner.isCurrent(target)).toBe(true);
  owner.dispose();
});

test("explicit handoff skips disabled controls and verifies the chosen inert target", () => {
  for (const controlEnabled of [true, false]) {
    let focused: unknown = null,
      disabledCalls = 0;
    const note = {
      disabled: true,
      focus: () => {
        disabledCalls++;
      },
    };
    const control = {
      disabled: !controlEnabled,
      focus: () => {
        focused = control;
      },
    };
    const section = {
      focus: () => {
        focused = section;
      },
    };
    expect(
      focusProjectCheckpointReviewEntry(
        [note, control, section],
        () => focused,
      ),
    ).toBe(true);
    expect(focused).toBe(controlEnabled ? control : section);
    expect(disabledCalls).toBe(0);
  }
  expect(focusProjectCheckpointReviewEntry([{ focus() {} }], () => null)).toBe(
    false,
  );
});
