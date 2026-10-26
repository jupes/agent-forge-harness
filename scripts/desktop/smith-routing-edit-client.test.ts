import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createSmithRoutingEditApi,
  type SmithRoutingEditPostResult,
} from "../../apps/desktop/src/smith-routing-edit-api";
import { createSmithRoutingEditClient } from "../../apps/desktop/src/smith-routing-edit-client";
import {
  createSmithRoutingEditIdentities,
  type SmithRoutingEditIdentities,
  type SmithRoutingEditIdentity,
  smithRoutingEditInputHash,
} from "../../apps/desktop/src/smith-routing-edit-identities";
import {
  NotSent,
  type operatorPost,
  type operatorRead,
} from "../../docs/js/operator";
import type {
  SmithRoutingEditChange,
  SmithRoutingEditPreview,
  SmithRoutingEditPreviewRequest,
  SmithRoutingEditReceipt,
  SmithRoutingEditRequest,
} from "../../types/smith-routing-edit";
import {
  canonicalSmithRoutingEditRequest,
  smithRoutingEditPreviewSchema,
  smithRoutingEditReceiptSchema,
} from "../config/smith-routing-edit-protocol";

const revision = {
  version: 1 as const,
  user: "a".repeat(64),
  workspace: "b".repeat(64),
};
const change: SmithRoutingEditChange = {
  kind: "bench",
  bench: "low",
  entries: [
    { smith: "custom", weight: 0.5 },
    { smith: "custom", weight: 1.25 },
  ],
};
const request: SmithRoutingEditRequest = {
  requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e5",
  target: "workspace",
  change,
  expectedRevision: revision,
};
const preview: SmithRoutingEditPreview = smithRoutingEditPreviewSchema.parse({
  version: 1,
  target: "workspace",
  file: "C:/workspace/agent-forge.toml",
  expectedRevision: revision,
  candidate: { sha256: "c".repeat(64), byteLength: 100, created: false },
  review: {
    change,
    targetBefore: null,
    targetAfter: change.entries,
    effectiveBefore: change.entries,
    effectiveAfter: change.entries,
    provenanceBefore: "builtin",
    provenanceAfter: "workspace",
  },
});
function previewFor(
  input: SmithRoutingEditPreviewRequest,
): SmithRoutingEditPreview {
  const reviewedValue =
    input.change.kind === "default" ? input.change.smith : input.change.entries;
  return smithRoutingEditPreviewSchema.parse({
    ...preview,
    target: input.target,
    review: {
      ...preview.review,
      change: input.change,
      targetAfter: reviewedValue,
      effectiveAfter: reviewedValue,
    },
  });
}
async function receiptFor(
  original: SmithRoutingEditRequest,
  phase: "confirmed" | "refused" | "held" = "confirmed",
  inputHash?: string,
): Promise<SmithRoutingEditReceipt> {
  const originalPreview = smithRoutingEditPreviewSchema.parse({
    ...previewFor({ target: original.target, change: original.change }),
    expectedRevision: original.expectedRevision,
  });
  const result =
    phase === "confirmed"
      ? {
          phase,
          completedAt: "2026-10-26T12:00:00.000Z",
          preview: originalPreview,
          publication: {
            file: originalPreview.file,
            created: originalPreview.candidate.created,
            sha256: originalPreview.candidate.sha256,
          },
        }
      : phase === "refused"
        ? {
            phase,
            refusedAt: "2026-10-26T12:00:00.000Z",
            reason: "stale-revision" as const,
          }
        : { phase, stage: "attempted" as const, preview: originalPreview };
  return smithRoutingEditReceiptSchema.parse({
    version: 1,
    requestId: original.requestId,
    ownerScopeHash: "d".repeat(64),
    inputHash: inputHash ?? (await smithRoutingEditInputHash(original)),
    createdAt: "2026-10-26T12:00:00.000Z",
    original,
    result,
  });
}
function fixture(
  result:
    | SmithRoutingEditPostResult
    | ((
        request: SmithRoutingEditRequest,
        reservation: { scope: string; inputHash: string },
      ) => Promise<SmithRoutingEditPostResult>),
  read: () => Promise<unknown> = async () => {
    throw Error("404");
  },
) {
  const saved = new Map<string, SmithRoutingEditIdentity>();
  let posts = 0,
    reads = 0,
    reserves = 0,
    scope = "workspace-A",
    reserveGate: Promise<void> | null = null,
    reserveEntered: (() => void) | null = null,
    requestIdValue = request.requestId,
    writable = true,
    failRetire = false,
    created = 0,
    previewer: (value: SmithRoutingEditPreviewRequest) => Promise<unknown> =
      async (value) => previewFor(value),
    posted: SmithRoutingEditRequest | null = null;
  const identities: SmithRoutingEditIdentities = {
    read: (id) => saved.get(id) ?? null,
    list: () => [...saved.values()],
    reserve: async (value, selector, inputHash) => {
      reserves++;
      reserveEntered?.();
      const identity: SmithRoutingEditIdentity = {
        requestId: value.requestId,
        scope,
        target: value.target,
        selector,
        inputHash,
        retired: false,
      };
      const previous = saved.get(identity.requestId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(identity))
        throw Error("UUID conflict");
      if (
        !previous &&
        [...saved.values()].some(
          (item) => item.scope === scope && !item.retired,
        )
      )
        throw Error("unresolved original");
      saved.set(identity.requestId, identity);
      if (!previous) created++;
      if (reserveGate) await reserveGate;
      return { identity: saved.get(identity.requestId)!, created: !previous };
    },
    retire: async (identity, retirement) => {
      if (failRetire) throw Error("readback refusal");
      const updated = { ...identity, retired: true, retirement };
      saved.set(identity.requestId, updated);
      return updated;
    },
  };
  const createClient = (requestIdOverride?: string) => {
    const client = createSmithRoutingEditClient({
      identities: () => identities,
      scope: () => scope,
      canWrite: () => writable,
      requestId: () => requestIdOverride ?? requestIdValue,
      preview: async (value) => previewer(value),
      post: async (value, reservation) => {
        posts++;
        posted = structuredClone(value);
        return typeof result === "function"
          ? result(value, reservation)
          : result;
      },
      readOriginal: async () => {
        reads++;
        return await read();
      },
    });
    client.setDraft("workspace", change);
    return client;
  };
  return {
    client: createClient(),
    createClient,
    saved,
    counts: () => ({ posts, reads, reserves }),
    createdCount: () => created,
    get posted() {
      return posted;
    },
    set scope(value: string) {
      scope = value;
    },
    holdReserve(gate: Promise<void>, entered: () => void) {
      reserveGate = gate;
      reserveEntered = entered;
    },
    setRequestId(value: string) {
      requestIdValue = value;
    },
    setWritable(value: boolean) {
      writable = value;
    },
    setRetireFailure(value: boolean) {
      failRetire = value;
    },
    setPreviewer(
      value: (input: SmithRoutingEditPreviewRequest) => Promise<unknown>,
    ) {
      previewer = value;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

test("browser hash matches producer canonical bytes and preserves duplicate fractional ordered rows", async () => {
  const expected = createHash("sha256")
    .update(canonicalSmithRoutingEditRequest(request))
    .digest("hex");
  expect(await smithRoutingEditInputHash(request)).toBe(expected);
  expect(
    await smithRoutingEditInputHash({
      ...request,
      change: { ...change, entries: [...change.entries].reverse() },
    }),
  ).not.toBe(expected);
});

test("transport uses fixed routing routes and treats original 404 as unknown, never NotSent", async () => {
  const postPaths: string[] = [];
  const readPaths: string[] = [];
  const post: typeof operatorPost = async (path) => {
    postPaths.push(path);
    return path.endsWith("/preview")
      ? new Response(JSON.stringify({ ok: true, data: preview, error: null }), {
          status: 200,
        })
      : new Response(
          JSON.stringify({ ok: false, data: null, error: "missing" }),
          { status: 404 },
        );
  };
  const read: typeof operatorRead = async (path) => {
    readPaths.push(path);
    return new Response(
      JSON.stringify({ ok: false, data: null, error: "missing" }),
      { status: 404 },
    );
  };
  const api = createSmithRoutingEditApi({
    post,
    read,
    scope: () => "workspace-A",
    canWrite: () => true,
  });
  await api.preview({ target: request.target, change: request.change });
  const result = await api.edit(request, {
    scope: "workspace-A",
    inputHash: await smithRoutingEditInputHash(request),
  });
  expect(result.state).toBe("unknown");
  await expect(api.original(request.requestId)).rejects.toThrow();
  expect(postPaths).toEqual([
    "/__agent-forge/config/smiths/routing-edits/preview",
    "/__agent-forge/config/smiths/routing-edits",
  ]);
  expect(readPaths).toEqual([
    `/__agent-forge/smiths/routing-edits/${request.requestId}`,
  ]);
});

test("exact confirmed and refused receipts install with their terminal state", async () => {
  const confirmed = await receiptFor(request, "confirmed");
  const confirmedFixture = fixture({
    state: "sent",
    value: { ok: true, data: confirmed, error: null },
  });
  await confirmedFixture.client.preview();
  await confirmedFixture.client.save();
  expect(confirmedFixture.client.get().entries[0]).toMatchObject({
    state: "confirmed",
    identity: { retirement: "confirmed", retired: true },
    receipt: confirmed,
  });

  const refused = await receiptFor(request, "refused");
  const refusedFixture = fixture({
    state: "sent",
    value: { ok: true, data: refused, error: null },
  });
  await refusedFixture.client.preview();
  await refusedFixture.client.save();
  expect(refusedFixture.client.get().entries[0]).toMatchObject({
    state: "refused",
    identity: { retirement: "refused", retired: true },
    receipt: refused,
  });
});

test("recreated clients recover confirmed and refused originals without changing terminal state", async () => {
  for (const phase of ["confirmed", "refused"] as const) {
    const receipt = await receiptFor(request, phase);
    const f = fixture(
      { state: "sent", value: { ok: true, data: receipt, error: null } },
      async () => receipt,
    );
    await f.client.preview();
    await f.client.save();
    expect(f.client.get().entries[0]).toMatchObject({
      state: phase,
      receipt,
    });
    f.client.dispose();

    const reopened = f.createClient();
    await reopened.recover();
    const recovered = reopened.get().entries[0];
    expect(f.counts()).toEqual({ posts: 1, reads: 1, reserves: 1 });
    expect(recovered).toMatchObject({
      state: phase,
      identity: { requestId: request.requestId, retired: true },
      request,
      receipt,
    });
    expect(recovered?.receipt?.original).toEqual(request);
    expect(recovered?.receipt?.inputHash).toBe(
      await smithRoutingEditInputHash(request),
    );
    await reopened.recover();
    expect(reopened.get().entries[0]?.state).toBe(phase);
    expect(f.counts().posts).toBe(1);
    reopened.dispose();
  }
});

test("malformed, hash-mismatched, and paired-revision-mismatched receipts stay held", async () => {
  const mismatchedRevision: SmithRoutingEditRequest = {
    ...request,
    expectedRevision: {
      version: 1,
      user: "e".repeat(64),
      workspace: "f".repeat(64),
    },
  };
  const receipts: unknown[] = [
    { version: 1, requestId: request.requestId },
    await receiptFor(request, "confirmed", "e".repeat(64)),
    await receiptFor(mismatchedRevision),
  ];
  for (const value of receipts) {
    const f = fixture({
      state: "sent",
      value: { ok: true, data: value, error: null },
    });
    await f.client.preview();
    await f.client.save();
    expect(f.client.get().entries[0]?.state).toBe("held");
    expect(f.saved.get(request.requestId)?.retired).toBe(false);
  }
});

test("confirmed receipt with the wrong HTTP status is not accepted by transport", async () => {
  const receipt = await receiptFor(request, "confirmed");
  const post: typeof operatorPost = async () =>
    new Response(JSON.stringify({ ok: true, data: receipt, error: null }), {
      status: 202,
    });
  const read: typeof operatorRead = async () =>
    new Response(null, { status: 404 });
  const api = createSmithRoutingEditApi({
    post,
    read,
    scope: () => "workspace-A",
    canWrite: () => true,
  });
  const result = await api.edit(request, {
    scope: "workspace-A",
    inputHash: await smithRoutingEditInputHash(request),
  });
  expect(result.state).toBe("unknown");
});

test("preview receives a detached draft so dependency mutation cannot alter saved hash input", async () => {
  const f = fixture({ state: "unknown", message: "unused" });
  f.setPreviewer(async (input) => {
    if (input.change.kind === "bench") input.change.entries[0]!.weight = 90;
    return preview;
  });
  await f.client.preview();
  expect(f.client.get().preview).toEqual(preview);
  await f.client.save();
  expect(f.counts().posts).toBe(1);
  expect(f.posted?.change).toEqual(change);
});

test("a stale preview completion cannot leave the changed draft busy or install its candidate", async () => {
  const f = fixture({ state: "unknown", message: "unused" });
  const oldResponse = deferred<unknown>();
  f.setPreviewer(async () => oldResponse.promise);
  const oldPreview = f.client.preview();
  f.client.setDraft("workspace", {
    ...change,
    entries: [...change.entries, { smith: "next", weight: 0.75 }],
  });
  try {
    oldResponse.resolve(
      previewFor({
        target: "workspace",
        change,
      }),
    );
    await oldPreview;
    expect(f.client.get().previewing).toBe(false);
    expect(f.client.get().preview).toBeNull();
  } finally {
    oldResponse.resolve(preview);
  }
});

test("an older preview completion preserves the busy flag and candidate of the latest draft", async () => {
  const f = fixture({ state: "unknown", message: "unused" });
  const oldResponse = deferred<unknown>();
  const currentResponse = deferred<unknown>();
  let calls = 0;
  f.setPreviewer(async () =>
    ++calls === 1 ? oldResponse.promise : currentResponse.promise,
  );
  const oldPreview = f.client.preview();
  const latestChange: SmithRoutingEditChange = {
    ...change,
    entries: [...change.entries, { smith: "latest", weight: 0.75 }],
  };
  f.client.setDraft("workspace", latestChange);
  const latestPreview = f.client.preview();
  try {
    oldResponse.resolve(previewFor({ target: "workspace", change }));
    await oldPreview;
    expect(f.client.get().previewing).toBe(true);
    expect(f.client.get().preview).toBeNull();
    currentResponse.resolve(
      previewFor({ target: "workspace", change: latestChange }),
    );
    await latestPreview;
    expect(f.client.get().previewing).toBe(false);
    expect(f.client.get().preview?.review.change).toEqual(latestChange);
  } finally {
    oldResponse.resolve(preview);
    currentResponse.resolve(preview);
  }
});

test("a stale scope save cannot clear the busy flag of a new scope save", async () => {
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const firstResult = deferred<SmithRoutingEditPostResult>();
  const secondResult = deferred<SmithRoutingEditPostResult>();
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) {
      firstStarted.resolve();
      return firstResult.promise;
    }
    secondStarted.resolve();
    return secondResult.promise;
  });
  await f.client.preview();
  const oldSave = f.client.save();
  try {
    await firstStarted.promise;
    f.scope = "workspace-B";
    f.client.get();
    f.setRequestId("f730e793-e617-4c93-bdaf-b1e30ba706e5");
    f.client.setDraft("workspace", change);
    await f.client.preview();
    const newSave = f.client.save();
    await secondStarted.promise;
    firstResult.resolve({ state: "unknown", message: "old scope uncertain" });
    await oldSave;
    expect(f.client.get().saving).toBe(true);
    secondResult.resolve({ state: "unknown", message: "new scope uncertain" });
    await newSave;
    expect(f.client.get().saving).toBe(false);
  } finally {
    firstResult.resolve({ state: "unknown", message: "release first" });
    secondResult.resolve({ state: "unknown", message: "release second" });
  }
});

test("lost submit reply and protected 404 stay held after recovery without another POST", async () => {
  const f = fixture({ state: "unknown", message: "lost reply" });
  await f.client.preview();
  await f.client.save();
  f.client.dispose();
  const restored = f.createClient();
  await restored.recover();
  expect(f.counts()).toEqual({ posts: 1, reads: 1, reserves: 1 });
  expect(restored.get().entries[0]?.state).toBe("held");
});

test("verified NotSent is durable across a fresh client without reading or reposting", async () => {
  const scope = "workspace-A";
  const post: typeof operatorPost = async () => {
    throw new NotSent("not dispatched");
  };
  const read: typeof operatorRead = async () =>
    new Response(null, { status: 404 });
  const api = createSmithRoutingEditApi({
    post,
    read,
    scope: () => scope,
    canWrite: () => true,
  });
  const f = fixture(
    (value, reservation) => api.edit(value, reservation),
    async () => null,
  );
  await f.client.preview();
  await f.client.save();
  f.client.dispose();
  await f.createClient().recover();
  expect(f.counts()).toEqual({ posts: 1, reads: 0, reserves: 1 });
  expect(f.saved.get(request.requestId)).toMatchObject({
    retired: true,
    retirement: "verified-not-sent",
  });
});

test("overlapping saves share one reservation and one submit", async () => {
  const f = fixture({ state: "unknown", message: "uncertain" });
  const second = f.createClient();
  await Promise.all([f.client.preview(), second.preview()]);
  await Promise.all([f.client.save(), second.save()]);
  expect(f.counts()).toMatchObject({ posts: 1, reserves: 2 });
  expect(f.createdCount()).toBe(1);
  expect(f.saved.size).toBe(1);
});

test("independent clients racing different UUIDs create one active original and one effect", async () => {
  const f = fixture({ state: "unknown", message: "uncertain" });
  const second = f.createClient("f730e793-e617-4c93-bdaf-b1e30ba706e5");
  await Promise.all([f.client.preview(), second.preview()]);
  await Promise.all([f.client.save(), second.save()]);
  expect(f.counts()).toMatchObject({ posts: 1, reserves: 2 });
  expect(f.createdCount()).toBe(1);
  expect(f.saved.size).toBe(1);
});

test("retirement readback failure stays held and a protected mismatch never retires", async () => {
  const scope = "workspace-A";
  const post: typeof operatorPost = async () => {
    throw new NotSent("not dispatched");
  };
  const read: typeof operatorRead = async () =>
    new Response(null, { status: 404 });
  const api = createSmithRoutingEditApi({
    post,
    read,
    scope: () => scope,
    canWrite: () => true,
  });
  const f = fixture((value, reservation) => api.edit(value, reservation));
  f.setRetireFailure(true);
  await f.client.preview();
  await f.client.save();
  expect(f.client.get().entries[0]?.state).toBe("held");
  expect(f.saved.get(request.requestId)?.retired).toBe(false);

  const mismatch = fixture({
    state: "sent",
    value: { ok: true, data: { version: 1 }, error: null },
  });
  await mismatch.client.preview();
  await mismatch.client.save();
  expect(mismatch.client.get().entries[0]?.state).toBe("held");
  expect(mismatch.saved.get(request.requestId)?.retired).toBe(false);
});

test("a source-branded NotSent for a different scope cannot retire this reservation", async () => {
  const post: typeof operatorPost = async () => {
    throw new NotSent("not dispatched");
  };
  const read: typeof operatorRead = async () =>
    new Response(null, { status: 404 });
  const api = createSmithRoutingEditApi({
    post,
    read,
    scope: () => "workspace-B",
    canWrite: () => true,
  });
  const f = fixture((value, reservation) =>
    api.edit(value, { ...reservation, scope: "workspace-B" }),
  );
  await f.client.preview();
  await f.client.save();
  expect(f.client.get().entries[0]?.state).toBe("held");
  expect(f.saved.get(request.requestId)?.retired).toBe(false);
});

test("only a verified NotSent retirement permits a later explicit new UUID", async () => {
  const scope = "workspace-A";
  let apiPosts = 0;
  const post: typeof operatorPost = async () => {
    apiPosts++;
    if (apiPosts === 1) throw new NotSent("not dispatched");
    throw Error("ambiguous transport failure");
  };
  const read: typeof operatorRead = async () =>
    new Response(null, { status: 404 });
  const api = createSmithRoutingEditApi({
    post,
    read,
    scope: () => scope,
    canWrite: () => true,
  });
  const f = fixture((value, reservation) => api.edit(value, reservation));
  await f.client.preview();
  await f.client.save();
  f.setRequestId("f730e793-e617-4c93-bdaf-b1e30ba706e5");
  f.client.setDraft("workspace", {
    ...change,
    entries: [...change.entries, { smith: "new", weight: 0.75 }],
  });
  await f.client.preview();
  await f.client.save();
  expect(f.counts()).toMatchObject({ posts: 2, reserves: 2 });
  expect([...f.saved.values()].map((item) => item.retirement)).toEqual([
    "verified-not-sent",
    undefined,
  ]);
});

test("scope/write loss after preview prevents reservation and POST", async () => {
  const f = fixture({ state: "unknown", message: "uncertain" });
  await f.client.preview();
  f.setWritable(false);
  await f.client.save();
  expect(f.counts()).toEqual({ posts: 0, reads: 0, reserves: 0 });
});

test("permission loss during reservation is durably recorded as pre-dispatch NotSent", async () => {
  const f = fixture({ state: "unknown", message: "must not be sent" });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holdReserve(gate, entered);
  await f.client.preview();
  const saving = f.client.save();
  try {
    await started;
    f.setWritable(false);
  } finally {
    release();
  }
  await saving;
  expect(f.counts().posts).toBe(0);
  expect(f.saved.get(request.requestId)).toMatchObject({
    retired: true,
    retirement: "verified-not-sent",
  });
});

test("scope change during reservation fences POST and hashes the frozen request", async () => {
  const f = fixture({ state: "unknown", message: "uncertain" }),
    draft = structuredClone(change),
    original = { ...request, change: structuredClone(draft) };
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.holdReserve(gate, entered);
  f.client.setDraft("workspace", draft);
  await f.client.preview();
  const saving = f.client.save();
  try {
    await started;
    draft.entries[0]!.weight = 9;
    f.scope = "workspace-B";
  } finally {
    release();
  }
  await saving;
  expect(f.counts().posts).toBe(0);
  expect([...f.saved.values()][0]?.inputHash).toBe(
    await smithRoutingEditInputHash(original),
  );
  expect([...f.saved.values()][0]).toMatchObject({
    retired: true,
    retirement: "verified-not-sent",
  });
});

test("a matching NotSent response settles after the workspace presentation changes", async () => {
  let activeScope = "workspace-A";
  let changeFixtureScope = () => {};
  const post: typeof operatorPost = async () => {
    activeScope = "workspace-B";
    changeFixtureScope();
    return new Response(null, { status: 403 });
  };
  const read: typeof operatorRead = async () =>
    new Response(null, { status: 404 });
  const api = createSmithRoutingEditApi({
    post,
    read,
    scope: () => activeScope,
    canWrite: () => true,
  });
  const f = fixture((value, reservation) => api.edit(value, reservation));
  changeFixtureScope = () => {
    f.scope = activeScope;
  };
  await f.client.preview();
  await f.client.save();
  expect(f.counts()).toMatchObject({ posts: 1, reserves: 1 });
  expect(f.saved.get(request.requestId)).toMatchObject({
    scope: "workspace-A",
    retired: true,
    retirement: "verified-not-sent",
  });
});

test("disposal after reservation durably retires the never-dispatched UUID for recovery", async () => {
  const f = fixture({ state: "unknown", message: "must not be sent" });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holdReserve(gate, entered);
  await f.client.preview();
  const saving = f.client.save();
  try {
    await started;
    f.client.dispose();
  } finally {
    release();
  }
  await saving;
  expect(f.counts().posts).toBe(0);
  expect(f.saved.get(request.requestId)).toMatchObject({
    retired: true,
    retirement: "verified-not-sent",
  });
  const restored = f.createClient();
  await restored.recover();
  expect(f.counts()).toEqual({ posts: 0, reads: 0, reserves: 1 });
  f.setRequestId("f730e793-e617-4c93-bdaf-b1e30ba706e5");
  restored.setDraft("workspace", change);
  await restored.preview();
  await restored.save();
  expect(f.counts()).toEqual({ posts: 1, reads: 0, reserves: 2 });
});

test("two identity-store instances serialize reservations and refuse an unresolved second UUID", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  let tail = Promise.resolve();
  const withLock = async <T>(work: () => T | Promise<T>): Promise<T> => {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await work();
    } finally {
      release();
    }
  };
  const first = createSmithRoutingEditIdentities({
    scope: "workspace-A",
    storage,
    withLock,
  });
  const second = createSmithRoutingEditIdentities({
    scope: "workspace-A",
    storage,
    withLock,
  });
  const hash = await smithRoutingEditInputHash(request);
  const [left, right] = await Promise.all([
    first.reserve(request, "low", hash),
    second.reserve(request, "low", hash),
  ]);
  expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
  const other = {
    ...request,
    requestId: "f730e793-e617-4c93-bdaf-b1e30ba706e5",
  };
  await expect(
    second.reserve(other, "low", await smithRoutingEditInputHash(other)),
  ).rejects.toThrow(/unresolved/);
  expect(first.read(request.requestId)).toMatchObject({
    inputHash: hash,
    retired: false,
  });
});

test("identity metadata corruption and oversize fail closed without replacing saved bytes", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  const identities = createSmithRoutingEditIdentities({
    scope: "workspace-A",
    storage,
    withLock: async (work) => work(),
  });
  const inputHash = await smithRoutingEditInputHash(request);
  await identities.reserve(request, "low", inputHash);
  const original = values.get("agent-forge.smith-routing-edit-identities.v1")!;
  values.set("agent-forge.smith-routing-edit-identities.v1", "{");
  expect(() => identities.list()).toThrow(/verified/);
  expect(values.get("agent-forge.smith-routing-edit-identities.v1")).toBe("{");
  values.set(
    "agent-forge.smith-routing-edit-identities.v1",
    "x".repeat(65_537),
  );
  expect(() => identities.list()).toThrow(/limit/);
  expect(values.get("agent-forge.smith-routing-edit-identities.v1")).not.toBe(
    original,
  );
});
