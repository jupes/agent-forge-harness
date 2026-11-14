import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { OperatorRead } from "../../../docs/js/operator";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import {
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../../scripts/projects/run-protocol";
import { projectCheckpointInboxContextReadSchema } from "../../../types/project-checkpoint-inbox-context";
import {
  projectCheckpointReviewInventoryJson,
  projectCheckpointReviewInventoryReadSchema,
} from "../../../types/project-checkpoint-review-inventory";
import {
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalReadSchema,
} from "../../../types/project-checkpoint-reviews";
import { projectCheckpointSubmissionOriginalJson } from "../../../types/project-checkpoint-submissions";
import {
  createInboxCheckpointClient,
  createInboxCheckpointReads,
} from "./inbox-checkpoint-client";

const projectId = "project-12345678-1234-4234-8234-123456789abc";
test("checkpoint source reads use only the fixed protected routes and explicit receiving caps", async () => {
  const calls: {
    url: string;
    method: string;
    bytes: number | undefined;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const reader: OperatorRead = async (url, init, limits) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      bytes: limits?.maxBodyBytes,
      signal: init?.signal,
    });
    return new Response(
      JSON.stringify({ ok: true, data: { observed: true }, error: null }),
    );
  };
  const reads = createInboxCheckpointReads(projectId, reader),
    controller = new AbortController();
  expect(await reads.retained(controller.signal)).toEqual({ observed: true });
  expect(calls).toEqual([
    {
      url: "/__agent-forge/projects/" + projectId + "/checkpoint-reviews",
      method: "GET",
      bytes: 4 * 1024 * 1024,
      signal: controller.signal,
    },
  ]);
  await reads.detail("demo", controller.signal);
  expect(calls[1]?.url).toBe(
    "/__agent-forge/projects/" + projectId + "/runs/demo",
  );
  expect(calls[1]?.bytes).toBe(512 * 1024 + 1024);
  await expect(reads.detail("../other", controller.signal)).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

const stamp = "2026-11-13T00:00:00.000Z",
  hash = (text: string) => createHash("sha256").update(text).digest("hex");
function sources(id = projectId, workspace = "/served/workspace") {
  const context = {
    projectId: id,
    workspace,
    catalogRevision: 1,
    archived: false,
    active: true,
  };
  const run = {
    slug: "demo",
    feature: "Checkpoint",
    epic: "forge-test",
    mode: "gated",
    health: "attention",
    phases: ["research", "plan", "implement", "ship"].map((phase, i) => ({
      id: phase,
      state: i < 2 ? "complete" : i === 2 ? "active" : "locked",
      artifact: null,
      artifactMissing: false,
    })),
    status: { kind: "awaiting-review", phase: "implement" },
    completedCount: 2,
    totalPhases: 4,
    gatePassed: null,
    reviewRounds: 0,
    latestVerdict: null,
    updatedAt: stamp,
    complete: false,
  };
  const header = {
    version: 1,
    projectId: id,
    workspace,
    checkout: "/served/checkout",
    asOf: stamp,
    coverage: "served-checkout-only",
    problems: [],
  };
  const page = projectRunsPageSchema.parse({ ...header, runs: [run] }),
    detail = projectRunDetailSchema.parse({
      ...header,
      run,
      reviews: [],
      gateHistory: [],
      gateHistoryDays: 30,
      earlierGateLimit: 10,
    });
  const bead = (
    beadId: string,
    type: string,
    parent: string | null,
    status: string,
  ) => ({
    id: beadId,
    title: beadId,
    type,
    status,
    priority: 2,
    parent,
    assignee: status === "in_progress" ? "worker" : null,
    owner: null,
    labels: [],
    createdAt: stamp,
    updatedAt: stamp,
    due: null,
    description: "",
    acceptanceCriteria: "",
    estimate: null,
    spent: null,
    ready: false,
    blocked: false,
    blockers: [],
    unavailableBlockers: 0,
    queue: null,
    smith: null,
    comments: [],
    commentsComplete: true,
    detailsLoaded: true,
  });
  const beads = projectBeadsPageSchema.parse({
    projectId: id,
    workspace,
    asOf: stamp,
    complete: true,
    problems: [],
    beads: [
      bead("forge-test", "epic", null, "open"),
      bead("forge-test.1", "task", "forge-test", "in_progress"),
    ],
    dependencies: [],
  });
  const target = {
      projectId: id,
      workspacePath: workspace,
      checkout: header.checkout,
      runSlug: run.slug,
      epicId: run.epic,
      beadId: "forge-test.1",
      runUpdatedAt: stamp,
    },
    binding = { ...target, catalogRevision: 1, scopeHash: "a".repeat(64) },
    sourceVersion = {
      kind: "committed-git-snapshot" as const,
      commit: "b".repeat(40),
      tree: "c".repeat(40),
    };
  const original = {
      schemaVersion: 1 as const,
      kind: "publish" as const,
      requestId: randomUUID(),
      binding,
      sourceVersion,
      expectedSubmissionGeneration: 0,
    },
    originalHash = hash(projectCheckpointSubmissionOriginalJson(original)),
    reviewScopeHash = hash(
      JSON.stringify({
        family: "checkpoint-source-submission",
        originalHash,
        schemaVersion: 1,
      }),
    );
  const association = projectCheckpointInboxContextReadSchema.parse({
    available: true,
    schemaVersion: 1,
    context: {
      state: "current",
      generation: 1,
      continuity: "anchored",
      baseBinding: binding,
      sourceVersion,
      reviewBinding: { ...binding, scopeHash: reviewScopeHash },
      foreign: null,
      record: {
        original,
        originalHash,
        receipt: {
          schemaVersion: 1,
          requestId: original.requestId,
          originalHash,
          scope: {
            projectId: id,
            workspacePath: workspace,
            runSlug: run.slug,
            beadId: target.beadId,
          },
          state: "applied",
          observedGeneration: 0,
          resultingGeneration: 1,
          auditEventId: 1,
          appliedAt: stamp,
          reviewScopeHash,
        },
      },
    },
    association: { complete: true, blockedElsewhere: false, records: [] },
  });
  const oldBinding = {
      ...binding,
      runSlug: "missing-old-run",
      beadId: "forge-test.2",
    },
    review = {
      schemaVersion: 1 as const,
      requestId: randomUUID(),
      binding: oldBinding,
      decision: "approve" as const,
      note: "",
      createdAt: stamp,
      commentText: "",
      intentHash: "0".repeat(64),
    };
  review.commentText = projectCheckpointReviewCommentText(review);
  review.intentHash = hash(projectCheckpointReviewIntentJson(review));
  const originalRead = projectCheckpointReviewOriginalReadSchema.parse({
    original: review,
    metadata: {
      schemaVersion: 1,
      requestId: review.requestId,
      intentHash: review.intentHash,
      scope: {
        projectId: id,
        workspacePath: workspace,
        runSlug: oldBinding.runSlug,
        beadId: oldBinding.beadId,
      },
      state: "unknown",
      commentId: null,
      createdAt: stamp,
      updatedAt: stamp,
    },
    receipt: {
      schemaVersion: 1,
      requestId: review.requestId,
      intentHash: review.intentHash,
      state: "unknown",
      commentId: null,
      reportedCommentId: null,
      readback: "not-checked",
      auditEventId: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  const retainedScope = { projectId: id, workspacePath: workspace },
    retained = projectCheckpointReviewInventoryReadSchema.parse({
      available: true,
      schemaVersion: 1,
      scope: retainedScope,
      coverage: "retained-review-records",
      records: [originalRead],
      observationRevision: hash(
        projectCheckpointReviewInventoryJson(retainedScope, [originalRead]),
      ),
    });
  return { context, page, detail, beads, association, retained, target, bead };
}
function readsFor(f: ReturnType<typeof sources>) {
  return {
    runs: async () => structuredClone(f.page),
    detail: async () => structuredClone(f.detail),
    beads: async () => structuredClone(f.beads),
    association: async () => structuredClone(f.association),
    retained: async () => structuredClone(f.retained),
  };
}
test("the actual source owner discovers current publications and missing-Run retained uncertainty independently", async () => {
  const api = await import("./inbox-checkpoint-client");
  expect(api.createInboxCheckpointClient).toBeFunction();
  const f = sources(),
    client = api.createInboxCheckpointClient(f.context, {
      reads: () => readsFor(f),
    });
  try {
    await client.refresh();
    const view = client.get();
    expect(view.publications.coverage.complete).toBe(true);
    expect(view.retained?.coverage.complete).toBe(true);
    expect(view.facts).toHaveLength(2);
    expect(view.complete).toBe(true);
    expect(view.facts.every((fact) => fact.resolved === false)).toBe(true);
  } finally {
    await client.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function turns() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}
function matchReview(
  f: ReturnType<typeof sources>,
  state: "prepared" | "unknown" | "confirmed" = "unknown",
) {
  if (
    !f.association.available ||
    !f.association.context.reviewBinding ||
    !f.retained.available
  )
    throw Error("Missing fixture proof");
  const previous = f.retained.records[0];
  if (!previous) throw Error("Missing fixture Review");
  const row = structuredClone(previous),
    bound = f.association.context.reviewBinding;
  row.original.binding = structuredClone(bound);
  row.original.commentText = projectCheckpointReviewCommentText(row.original);
  row.original.intentHash = hash(
    projectCheckpointReviewIntentJson(row.original),
  );
  row.metadata.intentHash = row.original.intentHash;
  row.receipt.intentHash = row.original.intentHash;
  row.metadata.scope = {
    projectId: bound.projectId,
    workspacePath: bound.workspacePath,
    runSlug: bound.runSlug,
    beadId: bound.beadId,
  };
  row.metadata.state = state;
  row.receipt.state = state;
  row.metadata.commentId = state === "confirmed" ? "exact-comment" : null;
  row.receipt.commentId = row.metadata.commentId;
  row.receipt.readback = state === "confirmed" ? "found" : "not-checked";
  return projectCheckpointReviewOriginalReadSchema.parse(row);
}
function retainedRows(
  f: ReturnType<typeof sources>,
  records: Parameters<typeof projectCheckpointReviewInventoryJson>[1],
) {
  if (!f.retained.available) throw Error("Missing fixture inventory");
  f.retained = projectCheckpointReviewInventoryReadSchema.parse({
    ...f.retained,
    records,
    observationRevision: hash(
      projectCheckpointReviewInventoryJson(f.retained.scope, records),
    ),
  });
}
test("bounded reads decode split UTF8 and reject malformed envelopes without retry", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ok: true, data: "Böromi", error: null }),
  );
  const reader: OperatorRead = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (let n = 0; n < bytes.length; n++)
            controller.enqueue(bytes.slice(n, n + 1));
          controller.close();
        },
      }),
      { headers: { "Content-Length": "1" } },
    );
  expect(
    await createInboxCheckpointReads(projectId, reader).retained(
      new AbortController().signal,
    ),
  ).toBe("Böromi");
  for (const value of [
    { ok: true, error: null },
    { ok: false, data: null, error: "refused" },
    { ok: true, data: {}, error: "bad" },
    { ok: true, data: {}, error: null, extra: true },
  ]) {
    let calls = 0;
    const invalid: OperatorRead = async () => {
      calls++;
      return new Response(JSON.stringify(value));
    };
    await expect(
      createInboxCheckpointReads(projectId, invalid).retained(
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
test("actual stream bounds and cancellation reject oversized, invalid UTF8 and aborted bodies", async () => {
  let cancelled = 0;
  const huge: OperatorRead = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelled++;
        },
      }),
    );
  await expect(
    createInboxCheckpointReads(projectId, huge).retained(
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(cancelled).toBe(1);
  const invalid: OperatorRead = async () => new Response(new Uint8Array([255]));
  await expect(
    createInboxCheckpointReads(projectId, invalid).retained(
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  let aborted = 0;
  const held: OperatorRead = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          aborted++;
        },
      }),
    );
  const signal = new AbortController(),
    pending = createInboxCheckpointReads(projectId, held).retained(
      signal.signal,
    );
  await turns();
  signal.abort();
  await expect(pending).rejects.toThrow();
  expect(aborted).toBe(1);
});
test("publication failure cannot hide retained attention and each whole prior family stays stale", async () => {
  const f = sources();
  let failRuns = false,
    failSaved = false;
  const base = readsFor(f),
    client = createInboxCheckpointClient(f.context, {
      reads: () => ({
        ...base,
        runs: async () => {
          if (failRuns) throw Error("Run source failed");
          return base.runs();
        },
        retained: async () => {
          if (failSaved) throw Error("Retained source failed");
          return base.retained();
        },
      }),
    });
  try {
    await client.refresh();
    const original = client.get();
    failRuns = true;
    await client.refresh();
    let view = client.get();
    expect(view.publications.coverage.complete).toBe(false);
    expect(view.publications.facts[0]?.fresh).toBe(false);
    expect(view.retained?.coverage.fresh).toBe(true);
    expect(view.retained?.facts[0]?.stableItemId).toBe(
      original.retained?.facts[0]?.stableItemId,
    );
    expect(view.complete).toBe(false);
    failSaved = true;
    await client.refresh();
    view = client.get();
    expect(view.retained?.facts[0]).toMatchObject({
      fresh: false,
      complete: false,
      reviewStatus: "unknown",
    });
    expect(view.retained?.history).toEqual(original.retained?.history);
  } finally {
    await client.close();
  }
});
test("archived and inactive scopes preserve uncertainty without admitting current-publication reads", async () => {
  const f = sources();
  f.context.archived = true;
  let currentCalls = 0;
  const noCurrent = async () => {
      currentCalls++;
      throw Error("Archived current read");
    },
    client = createInboxCheckpointClient(f.context, {
      reads: () => ({
        ...readsFor(f),
        runs: noCurrent,
        beads: noCurrent,
        detail: noCurrent,
        association: noCurrent,
      }),
    });
  try {
    await client.refresh();
    expect(currentCalls).toBe(0);
    expect(client.get().publications.coverage).toMatchObject({
      applicable: false,
      complete: true,
    });
    expect(client.get().retained?.facts).toHaveLength(1);
    client.setContext({ ...f.context, active: false });
    await client.refresh();
    expect(client.get().retained?.facts[0]).toMatchObject({
      fresh: false,
      resolved: false,
    });
    expect(client.get().complete).toBe(false);
    expect(currentCalls).toBe(0);
  } finally {
    await client.close();
  }
});
test("recognized noncurrent targets complete enumeration without fabricating fresh checkpoint facts", async () => {
  for (const state of ["unbound", "withdrawn", "foreign", "stale"] as const) {
    const f = sources();
    if (!f.association.available) throw Error("Missing fixture context");
    const data = f.association;
    data.context.state = state;
    data.context.reviewBinding = null;
    data.association.complete = false;
    if (state !== "stale") data.context.record = null;
    else data.context.sourceVersion.commit = "d".repeat(40);
    if (state === "unbound") {
      data.context.generation = 0;
      data.context.continuity = "legacy-unverified";
    }
    if (state === "foreign")
      data.context.foreign = {
        projectId,
        runSlug: "other",
        beadId: "forge-test.1",
      };
    const client = createInboxCheckpointClient(f.context, {
      reads: () => readsFor(f),
    });
    try {
      await client.refresh();
      expect(client.get().publications.coverage.complete).toBe(true);
      expect(client.get().publications.facts).toEqual([]);
      expect(client.get().retained?.facts).toHaveLength(1);
    } finally {
      await client.close();
    }
  }
});
test("catalog mismatch, missing stamps and unsupported target count keep discovery incomplete", async () => {
  for (const mode of ["catalog", "stamp", "targets"] as const) {
    const f = sources();
    let associationCalls = 0;
    if (mode === "catalog") f.context.catalogRevision = 2;
    if (mode === "stamp") {
      const run = f.page.runs[0];
      if (!run) throw Error("Missing fixture Run");
      run.updatedAt = null;
      f.detail.run.updatedAt = null;
    }
    if (mode === "targets")
      f.beads = projectBeadsPageSchema.parse({
        ...f.beads,
        beads: [
          f.beads.beads[0],
          ...Array.from({ length: 257 }, (_, i) =>
            f.bead(
              "forge-test." + (i + 1),
              "task",
              "forge-test",
              "in_progress",
            ),
          ),
        ],
      });
    const base = readsFor(f),
      client = createInboxCheckpointClient(f.context, {
        reads: () => ({
          ...base,
          association: async () => {
            associationCalls++;
            return base.association();
          },
        }),
      });
    try {
      await client.refresh();
      expect(client.get().publications.coverage.complete).toBe(false);
      expect(client.get().retained?.facts).toHaveLength(1);
      if (mode !== "catalog") expect(associationCalls).toBe(0);
    } finally {
      await client.close();
    }
  }
});
test("full receipt equality folds recovery while contradictory receipts preserve attention and revoke combined coverage", async () => {
  for (const conflict of [false, true]) {
    const f = sources(),
      uncertain = matchReview(f);
    if (!f.association.available) throw Error("Missing fixture context");
    f.association.association.records = [
      conflict ? matchReview(f, "confirmed") : uncertain,
    ];
    retainedRows(f, [uncertain]);
    const client = createInboxCheckpointClient(f.context, {
      reads: () => readsFor(f),
    });
    try {
      await client.refresh();
      const view = client.get();
      expect(view.retained?.facts).toHaveLength(1);
      expect(view.facts).toHaveLength(conflict ? 2 : 1);
      expect(view.complete).toBe(!conflict);
      if (conflict)
        expect(view.diagnostics.join(" ")).toContain(
          "different saved receipts",
        );
      else
        expect(view.facts[0]?.stableItemId).toBe(
          view.publications.facts[0]?.stableItemId,
        );
    } finally {
      await client.close();
    }
  }
});
test("eligibility changes during discovery retain only the previous complete publication bundle", async () => {
  const f = sources(),
    base = readsFor(f);
  let change = false,
    calls = 0;
  const client = createInboxCheckpointClient(f.context, {
    reads: () => ({
      ...base,
      beads: async () => {
        calls++;
        const value = await base.beads();
        if (change && calls % 2 === 0) {
          const leaf = value.beads[1];
          if (!leaf) throw Error("Missing fixture leaf");
          leaf.status = "closed";
        }
        return value;
      },
    }),
  });
  try {
    await client.refresh();
    const first = client.get().publications.facts;
    change = true;
    calls = 0;
    await client.refresh();
    expect(client.get().publications.coverage.complete).toBe(false);
    expect(
      client.get().publications.facts.map((fact) => fact.stableItemId),
    ).toEqual(first.map((fact) => fact.stableItemId));
    expect(client.get().publications.facts[0]?.fresh).toBe(false);
    expect(client.get().retained?.coverage.fresh).toBe(true);
  } finally {
    await client.close();
  }
});
test("a superseded A-B-A read and reentrant listener cannot replace the current source frame", async () => {
  const a = sources(),
    b = sources(
      "project-12345678-1234-4234-8234-123456789abd",
      "/other/workspace",
    ),
    held = deferred<unknown>(),
    entered = deferred<void>();
  let hold = true;
  const client = createInboxCheckpointClient(a.context, {
    reads: (id) => {
      const base = readsFor(id === projectId ? a : b);
      return id === projectId
        ? {
            ...base,
            association: async () => {
              if (hold) {
                hold = false;
                entered.resolve();
                return held.promise;
              }
              return base.association();
            },
          }
        : base;
    },
  });
  const first = client.refresh();
  try {
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw Error("Owner finished before held read");
      }),
    ]);
    client.setContext(b.context);
    await client.refresh();
    expect(client.get().context?.projectId).toBe(b.context.projectId);
    client.setContext(a.context);
    await client.refresh();
    const current = client.get();
    expect(current.complete).toBe(true);
    held.resolve(null);
    await first;
    expect(client.get()).toEqual(current);
  } finally {
    held.resolve(null);
    await first;
    await client.close();
  }
  const calls: string[] = [],
    reentrant = createInboxCheckpointClient(a.context, {
      reads: (id) => {
        calls.push(id);
        return readsFor(id === projectId ? a : b);
      },
    });
  let nested: Promise<void> | null = null,
    once = true;
  reentrant.subscribe(() => {
    if (once && reentrant.get().loading) {
      once = false;
      reentrant.setContext(b.context);
      nested = reentrant.refresh();
    }
  });
  try {
    await reentrant.refresh();
    await nested;
    expect(calls).toEqual([b.context.projectId]);
    expect(reentrant.get().complete).toBe(true);
  } finally {
    await reentrant.close();
  }
});
test("superseded uncooperative reads retain all four slots until actual settlement", async () => {
  const f = sources(),
    started = deferred<void>(),
    held: { box: ReturnType<typeof deferred<unknown>>; value: unknown }[] = [];
  let active = 0,
    maximum = 0;
  f.page = projectRunsPageSchema.parse({
    ...f.page,
    runs: Array.from({ length: 4 }, (_, i) => ({
      ...f.detail.run,
      slug: "demo-" + i,
    })),
  });
  const park = (value: unknown) => {
    const box = deferred<unknown>();
    held.push({ box, value });
    maximum = Math.max(maximum, ++active);
    if (held.length === 4) started.resolve();
    return box.promise.finally(() => {
      active--;
    });
  };
  const base = readsFor(f),
    client = createInboxCheckpointClient(f.context, {
      reads: () => ({
        ...base,
        detail: async (slug) =>
          park({ ...f.detail, run: { ...f.detail.run, slug } }),
        retained: async () => park(f.retained),
      }),
    });
  const first = client.refresh();
  let second: Promise<void> | null = null,
    closing: Promise<void> | null = null,
    settled = false;
  try {
    await Promise.race([
      started.promise,
      first.then(() => {
        throw Error("Reads did not reach bounded occupancy");
      }),
    ]);
    client.invalidate();
    second = client.refresh();
    await turns();
    expect(held).toHaveLength(4);
    closing = client.close().then(() => {
      settled = true;
    });
    await turns();
    expect(settled).toBe(false);
    expect(client.get().complete).toBe(false);
    for (const item of held) item.box.resolve(item.value);
    await first;
    await second;
    await closing;
    expect(maximum).toBe(4);
    expect(held).toHaveLength(4);
  } finally {
    for (const item of held) item.box.resolve(item.value);
    await first;
    await second;
    await client.close();
  }
});
test("nested source DTOs and context are captured before digest awaits and final eligibility reads", async () => {
  const f = sources(),
    after = deferred<unknown>(),
    entered = deferred<void>(),
    initialPage = structuredClone(f.page),
    originalId = f.association.available
      ? f.association.context.record?.original.requestId
      : null;
  if (originalId === null || originalId === undefined)
    throw Error("Missing fixture publication");
  let runReads = 0;
  const base = readsFor(f),
    client = createInboxCheckpointClient(f.context, {
      reads: () => ({
        ...base,
        runs: async () => {
          if (++runReads === 2) {
            entered.resolve();
            return after.promise;
          }
          return f.page;
        },
        association: async () => f.association,
        retained: async () => f.retained,
      }),
    });
  const pending = client.refresh();
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw Error("Final source check was not reached");
      }),
    ]);
    f.context.workspace = "/changed";
    f.context.catalogRevision = 8;
    if (
      !f.association.available ||
      !f.association.context.record ||
      !f.retained.available
    )
      throw Error("Missing fixture proof");
    f.association.context.record.original.requestId = randomUUID();
    const row = f.retained.records[0];
    if (!row) throw Error("Missing fixture Review");
    row.original.note = "changed";
    after.resolve(initialPage);
    await pending;
    expect(client.get().complete).toBe(true);
    expect(client.get().context?.workspace).toBe("/served/workspace");
    expect(
      client.get().publications.facts[0]?.sourceIdentity.publication.original
        .requestId,
    ).toBe(originalId);
    expect(
      client.get().retained?.facts[0]?.sourceIdentity.originalRead.original
        .note,
    ).toBe("");
  } finally {
    after.resolve(initialPage);
    await pending;
    await client.close();
  }
});

test("a read-factory failure settles the incomplete source view without throwing synchronous work", async () => {
  const f = sources(),
    client = createInboxCheckpointClient(f.context, {
      reads: () => {
        throw Error("Connection unavailable");
      },
    });
  try {
    await expect(client.refresh()).resolves.toBeUndefined();
    expect(client.get().loading).toBe(false);
    expect(client.get().complete).toBe(false);
    expect(client.get().publications.coverage.settled).toBe(true);
    expect(client.get().retained?.coverage.settled).toBe(true);
  } finally {
    await client.close();
  }
});
test("an oversized Run inventory never starts a truncated set of detail reads", async () => {
  const f = sources(),
    base = readsFor(f);
  let details = 0;
  const client = createInboxCheckpointClient(f.context, {
    reads: () => ({
      ...base,
      runs: async () => ({
        ...f.page,
        runs: Array.from({ length: 129 }, (_, i) => ({
          ...f.detail.run,
          slug: "run-" + i,
        })),
      }),
      detail: async () => {
        details++;
        return f.detail;
      },
    }),
  });
  try {
    await client.refresh();
    expect(details).toBe(0);
    expect(client.get().publications.coverage.complete).toBe(false);
    expect(client.get().retained?.facts).toHaveLength(1);
  } finally {
    await client.close();
  }
});
test("unavailable and corrupt noncurrent publication reads remain incomplete rather than empty-complete", async () => {
  for (const mode of ["unavailable", "bad-stale-hash"] as const) {
    const f = sources(),
      base = readsFor(f);
    if (mode === "bad-stale-hash") {
      if (!f.association.available || !f.association.context.record)
        throw Error("Missing fixture publication");
      f.association.context.state = "stale";
      f.association.context.reviewBinding = null;
      f.association.association.complete = false;
      f.association.context.sourceVersion.commit = "d".repeat(40);
      f.association.context.record.originalHash = "f".repeat(64);
      f.association.context.record.receipt.originalHash = "f".repeat(64);
    }
    const client = createInboxCheckpointClient(f.context, {
      reads: () => ({
        ...base,
        association: async () =>
          mode === "unavailable"
            ? {
                available: false,
                error:
                  "The checkpoint source and review association is unavailable. Read retained originals before trying again.",
              }
            : f.association,
      }),
    });
    try {
      await client.refresh();
      expect(client.get().publications.coverage.complete).toBe(false);
      expect(client.get().publications.facts).toEqual([]);
      expect(client.get().retained?.facts).toHaveLength(1);
    } finally {
      await client.close();
    }
  }
});

test("a detail for A returned to the request for B cannot complete the Run inventory", async () => {
  const f = sources(),
    client = createInboxCheckpointClient(f.context, {
      reads: () => readsFor(f),
    });
  try {
    await client.refresh();
    const before = client.get().publications.facts;
    f.page.runs.push({ ...f.detail.run, slug: "other-run" });
    await client.refresh();
    expect(client.get().publications.coverage.complete).toBe(false);
    expect(
      client.get().publications.facts.map((fact) => fact.stableItemId),
    ).toEqual(before.map((fact) => fact.stableItemId));
    expect(client.get().publications.facts[0]?.fresh).toBe(false);
    expect(client.get().retained?.coverage.fresh).toBe(true);
  } finally {
    await client.close();
  }
});
test("abort callbacks observe revoked freshness before another refresh starts", async () => {
  const f = sources(),
    held = deferred<unknown>(),
    ready = deferred<void>();
  let entered = false,
    hold = true,
    observed: boolean | undefined,
    newer: Promise<void> | null = null;
  const client = createInboxCheckpointClient(f.context, {
    reads: () => ({
      ...readsFor(f),
      association: async (_target, signal) => {
        if (!hold) return f.association;
        hold = false;
        entered = true;
        signal.addEventListener(
          "abort",
          () => {
            observed = client.get().retained?.coverage.fresh;
          },
          { once: true },
        );
        if (client.get().retained?.coverage.fresh) ready.resolve();
        return held.promise;
      },
    }),
  });
  client.subscribe(() => {
    if (entered && client.get().retained?.coverage.fresh) ready.resolve();
  });
  const first = client.refresh();
  try {
    await Promise.race([
      ready.promise,
      first.then(() => {
        throw Error("Expected an owned pending read");
      }),
    ]);
    expect(client.get().retained?.coverage.fresh).toBe(true);
    newer = client.refresh();
    expect(observed).toBe(false);
    await newer;
  } finally {
    held.resolve(null);
    await first;
    await newer;
    await client.close();
  }
});
test("an abort callback's newer context and refresh cannot be superseded by the older caller", async () => {
  const a = sources(),
    b = sources(
      "project-12345678-1234-4234-8234-123456789abd",
      "/other/workspace",
    ),
    held = deferred<unknown>(),
    ready = deferred<void>(),
    factories: string[] = [];
  let hold = true,
    entered = false,
    nested: Promise<void> | null = null,
    outer: Promise<void> | null = null;
  const client = createInboxCheckpointClient(a.context, {
    reads: (id) => {
      factories.push(id);
      const f = id === projectId ? a : b;
      return {
        ...readsFor(f),
        association: async (_target, signal) => {
          if (id !== projectId || !hold) return f.association;
          hold = false;
          entered = true;
          signal.addEventListener(
            "abort",
            () => {
              client.setContext(b.context);
              nested = client.refresh();
            },
            { once: true },
          );
          if (client.get().retained?.coverage.fresh) ready.resolve();
          return held.promise;
        },
      };
    },
  });
  client.subscribe(() => {
    if (entered && client.get().retained?.coverage.fresh) ready.resolve();
  });
  const first = client.refresh();
  try {
    await Promise.race([
      ready.promise,
      first.then(() => {
        throw Error("Expected an owned pending read");
      }),
    ]);
    outer = client.refresh();
    await outer;
    await nested;
    expect(factories.filter((id) => id === b.context.projectId)).toHaveLength(
      1,
    );
    expect(client.get().context?.projectId).toBe(b.context.projectId);
    expect(client.get().complete).toBe(true);
  } finally {
    held.resolve(null);
    await first;
    await outer;
    await nested;
    await client.close();
  }
});
test("close retains stream-cancellation ownership until the original underlying cancel settles", async () => {
  const f = sources(),
    gate = deferred<void>();
  f.context.archived = true;
  let cancellations = 0,
    closed = false;
  const reader: OperatorRead = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancellations++;
          return gate.promise;
        },
      }),
    );
  const client = createInboxCheckpointClient(f.context, {
      reads: (id) => createInboxCheckpointReads(id, reader),
    }),
    pending = client.refresh();
  await turns();
  const closing = client.close().then(() => {
    closed = true;
  });
  try {
    await turns();
    expect(cancellations).toBe(1);
    expect(closed).toBe(false);
  } finally {
    gate.resolve();
    await pending;
    await closing;
  }
});
