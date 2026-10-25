import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  createSmithConfigCreateClient,
  type SmithCreatePostResult,
} from "../../apps/desktop/src/smith-create-client";
import {
  createSmithCreateIdentities,
  SMITH_CREATE_IDENTITIES,
  smithConfigCreateInputHash,
} from "../../apps/desktop/src/smith-create-identities";
import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateRequest,
  SmithConfigPreview,
  SmithConfigPreviewRequest,
} from "../../types/smith-config-create";

const scope = "http://127.0.0.1:8888",
  ids = [
    "18da5c95-3218-439c-a33d-e5662465f505",
    "28da5c95-3218-439c-a33d-e5662465f506",
  ];
const smith = {
  name: "codex-new-smith",
  provider: "codex",
  model: "gpt-example-exact",
  effort: "high",
  enabled: true,
  tags: ["reviewed"],
};
const revision = {
  version: 1 as const,
  user: "a".repeat(64),
  workspace: "b".repeat(64),
};
const file = "C:\\fixture\\agent-forge.toml";
function preview(input: SmithConfigPreviewRequest): SmithConfigPreview {
  return {
    version: 1,
    target: input.target,
    file,
    expectedRevision: revision,
    candidate: { sha256: "c".repeat(64), byteLength: 100, created: false },
    review: {
      before: null,
      after: structuredClone(input.smith),
      provenance: {
        provider: file,
        model: file,
        effort: file,
        enabled: file,
        tags: file,
      },
    },
  };
}
async function receipt(
  request: SmithConfigCreateRequest,
  result: SmithConfigCreateReceipt["result"] = {
    phase: "confirmed",
    completedAt: "2026-10-25T20:00:00.000Z",
    preview: preview(request),
    publication: { file, created: false, sha256: "c".repeat(64) },
  },
): Promise<SmithConfigCreateReceipt> {
  return {
    version: 1,
    requestId: request.requestId,
    ownerScopeHash: "d".repeat(64),
    inputHash: await smithConfigCreateInputHash(request),
    createdAt: "2026-10-25T19:59:00.000Z",
    original: structuredClone(request),
    result,
  };
}
function setup(
  options: {
    canWrite?: () => boolean;
    post?: (
      request: SmithConfigCreateRequest,
    ) => Promise<SmithCreatePostResult>;
    preview?: (input: SmithConfigPreviewRequest) => Promise<unknown>;
    readOriginal?: (requestId: string) => Promise<unknown>;
  } = {},
) {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  let locked = false,
    nextId = 0;
  const identities = createSmithCreateIdentities({
    scope,
    storage,
    withLock: async <T>(work: () => T | Promise<T>) => {
      if (locked) throw Error("lock was not serialized");
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
      }
    },
  });
  const posted: SmithConfigCreateRequest[] = [],
    readIds: string[] = [];
  const client = createSmithConfigCreateClient({
    identities,
    canWrite: options.canWrite ?? (() => true),
    requestId: () => ids[nextId++] ?? ids[ids.length - 1]!,
    preview: options.preview ?? (async (input) => preview(input)),
    post: async (request) => {
      posted.push(structuredClone(request));
      return (
        options.post?.(request) ??
        Promise.resolve({ state: "sent", value: await receipt(request) })
      );
    },
    readOriginal: async (requestId) => {
      readIds.push(requestId);
      return options.readOriginal?.(requestId) ?? null;
    },
  });
  return { client, identities, storage, posted, readIds };
}

test("create requires a current reviewed preview and an identity that read-backs before the one POST", async () => {
  const value = setup();
  value.client.setDraft("workspace", smith);
  await value.client.create();
  expect(value.posted).toHaveLength(0);
  await value.client.preview();
  expect(value.client.get().preview?.file).toBe(file);
  await value.client.create();
  expect(value.posted).toHaveLength(1);
  const posted = value.posted[0];
  if (!posted) throw Error("Missing create request");
  expect(value.identities.read(posted.requestId)).toMatchObject({
    requestId: posted.requestId,
    target: "workspace",
    scope,
    inputHash: await smithConfigCreateInputHash(posted),
  });
  expect(value.client.get().entries[0]).toMatchObject({
    state: "confirmed",
    receipt: { original: posted, result: { phase: "confirmed" } },
  });
  value.client.dispose();
});

test("editing during a pending preview clears its stale busy state", async () => {
  let releaseFirst: ((value: unknown) => void) | undefined,
    previewCalls = 0;
  const value = setup({
    preview: async (input) => {
      previewCalls++;
      if (previewCalls === 1)
        return await new Promise<unknown>((resolve) => {
          releaseFirst = resolve;
        });
      return preview(input);
    },
  });
  value.client.setDraft("workspace", smith);
  const pending = value.client.preview();
  expect(value.client.get().previewing).toBe(true);
  const changed = { ...smith, model: "edited-while-reviewing" };
  value.client.setDraft("workspace", changed);
  if (!releaseFirst) throw Error("The first preview was not deferred");
  releaseFirst(preview({ target: "workspace", smith }));
  await pending;

  expect(value.client.get()).toMatchObject({
    previewing: false,
    preview: null,
    smith: changed,
  });
  await value.client.preview();
  expect(previewCalls).toBe(2);
  expect(value.client.get().preview?.review.after).toEqual(changed);
  value.client.dispose();
});

test("a confirmed original remains while a later explicit create uses a new UUID", async () => {
  const value = setup();
  value.client.setDraft("workspace", smith);
  await value.client.preview();
  await value.client.create();
  const first = value.client.get().entries[0];
  if (!first) throw Error("Missing first confirmed receipt");

  const nextSmith = { ...smith, name: "codex-next-smith" };
  value.client.setDraft("workspace", nextSmith);
  await value.client.preview();
  await value.client.create();

  expect(value.posted.map((request) => request.requestId)).toEqual(ids);
  expect(value.client.get().entries).toMatchObject([
    {
      identity: { requestId: ids[0] },
      state: "confirmed",
      receipt: first.receipt,
    },
    {
      identity: { requestId: ids[1] },
      state: "confirmed",
      request: { smith: nextSmith },
    },
  ]);
  value.client.dispose();
});

test("editing invalidates preview and a lost response stays held after a missing-original GET", async () => {
  const first = setup({
    post: async () => ({
      state: "sent",
      value: { ok: false, error: "unavailable" },
    }),
    readOriginal: async () => {
      throw Error("404 No saved original");
    },
  });
  first.client.setDraft("workspace", smith);
  await first.client.preview();
  first.client.setDraft("workspace", { ...smith, model: "changed-model" });
  expect(first.client.get().preview).toBeNull();
  await first.client.create();
  expect(first.posted).toHaveLength(0);
  await first.client.preview();
  await first.client.create();
  expect(first.posted).toHaveLength(1);
  const heldId = first.posted[0]?.requestId;
  if (!heldId) throw Error("Missing held request id");
  expect(first.client.get().entries[0]?.state).toBe("held");
  first.client.dispose();

  let recoveryPreviewCalls = 0;
  const restarted = createSmithConfigCreateClient({
    identities: first.identities,
    canWrite: () => true,
    requestId: () => ids[1]!,
    preview: async () => {
      recoveryPreviewCalls++;
      throw Error("Recovery must not prepare a new preview");
    },
    post: async () => {
      throw Error("Recovery must never resend a create");
    },
    readOriginal: async (requestId) => {
      first.readIds.push(requestId);
      throw Error("404 No saved original");
    },
  });
  await restarted.recover();
  expect(first.readIds).toEqual([heldId]);
  expect(first.posted).toHaveLength(1);
  expect(restarted.get().activeRequestId).toBeNull();
  expect(restarted.get().entries).toMatchObject([
    { identity: { requestId: heldId }, request: null, state: "held" },
  ]);
  restarted.setDraft("workspace", { ...smith, model: "after-unknown" });
  await restarted.preview();
  await restarted.create();
  expect(recoveryPreviewCalls).toBe(0);
  expect(first.posted).toHaveLength(1);
  expect(first.identities.list()).toHaveLength(1);
  expect(first.identities.read(heldId)?.retired).toBe(false);
  expect(restarted.canStart()).toBe(false);
  restarted.dispose();
});

test("only an exact correlated preattempt refusal permits a new explicit UUID", async () => {
  let calls = 0;
  const value = setup({
    post: async (request) => {
      calls++;
      return {
        state: "sent",
        value:
          calls === 1
            ? await receipt(request, {
                phase: "refused",
                refusedAt: "2026-10-25T20:00:00.000Z",
                reason: "stale-revision",
                preview: preview(request),
              })
            : await receipt(request),
      };
    },
  });
  value.client.setDraft("workspace", smith);
  await value.client.preview();
  await value.client.create();
  expect(value.client.get().entries[0]?.state).toBe("refused");
  await value.client.preview();
  await value.client.create();
  expect(value.posted.map((request) => request.requestId)).toEqual(ids);
  expect(value.client.get().entries.map((entry) => entry.state)).toEqual([
    "refused",
    "confirmed",
  ]);
  value.client.dispose();
});

test("NotSent is distinct and never turns a later generic response into a refusal", async () => {
  const value = setup({
    post: async () => ({
      state: "not-sent",
      message: "Operator token unavailable.",
    }),
  });
  value.client.setDraft("workspace", smith);
  await value.client.preview();
  await value.client.create();
  expect(value.client.get().entries[0]).toMatchObject({ state: "not-sent" });
  expect(value.client.get().entries[0]?.notice).toContain(
    "No request was sent",
  );
  expect(value.identities.read(ids[0]!)?.retired).toBe(true);
  expect(value.posted).toHaveLength(1);
  value.client.dispose();
});

test("a proven NotSent settlement survives reload and permits a later explicit create", async () => {
  const first = setup({
    post: async () => ({
      state: "not-sent",
      message: "Operator token unavailable.",
    }),
  });
  first.client.setDraft("workspace", smith);
  await first.client.preview();
  await first.client.create();
  expect(first.identities.read(ids[0]!)?.retired).toBe(true);
  first.client.dispose();

  const restarted = createSmithConfigCreateClient({
    identities: first.identities,
    canWrite: () => true,
    requestId: () => ids[1]!,
    preview: async (input) => preview(input),
    post: async (request) => {
      first.posted.push(structuredClone(request));
      return { state: "sent", value: await receipt(request) };
    },
    readOriginal: async (requestId) => {
      first.readIds.push(requestId);
      throw Error("A retired request must not be recovered from the server.");
    },
  });
  await restarted.recover();
  expect(restarted.canStart()).toBe(true);
  expect(restarted.get().entries).toMatchObject([
    {
      identity: { requestId: ids[0], retired: true },
      state: "not-sent",
    },
  ]);
  expect(first.readIds).toEqual([]);

  const nextSmith = { ...smith, name: "codex-next-after-not-sent" };
  restarted.setDraft("workspace", nextSmith);
  await restarted.preview();
  await restarted.create();
  expect(first.posted.map((request) => request.requestId)).toEqual(ids);
  expect(restarted.get().entries.map((entry) => entry.state)).toEqual([
    "not-sent",
    "confirmed",
  ]);
  restarted.dispose();
});

test("a refusal receipt is retired durably and does not strand the next create after reload", async () => {
  let refusal: SmithConfigCreateReceipt | null = null;
  let originalReads = 0;
  const first = setup({
    post: async (request) => {
      refusal = await receipt(request, {
        phase: "refused",
        refusedAt: "2026-10-25T20:00:00.000Z",
        reason: "stale-revision",
        preview: preview(request),
      });
      return { state: "sent", value: refusal };
    },
  });
  first.client.setDraft("workspace", smith);
  await first.client.preview();
  await first.client.create();
  expect(first.identities.read(ids[0]!)).toMatchObject({
    retired: true,
    retirement: "correlated-refusal",
  });
  first.client.dispose();

  const restarted = createSmithConfigCreateClient({
    identities: first.identities,
    canWrite: () => true,
    requestId: () => ids[1]!,
    preview: async (input) => preview(input),
    post: async (request) => ({ state: "sent", value: await receipt(request) }),
    readOriginal: async (requestId) => {
      first.readIds.push(requestId);
      if (originalReads++ === 0)
        throw Error("404 The protected original is temporarily missing.");
      return refusal;
    },
  });
  await restarted.recover();
  expect(restarted.canStart()).toBe(true);
  expect(restarted.get().entries[0]).toMatchObject({
    identity: { requestId: ids[0], retired: true },
    state: "refused",
    receipt: null,
  });
  expect(first.readIds).toEqual([ids[0]!]);
  expect(restarted.get().entries[0]?.notice).toContain(
    "saved outcome remains verified",
  );
  await restarted.check(ids[0]!);
  expect(first.readIds).toEqual([ids[0]!, ids[0]!]);
  expect(restarted.get().entries[0]).toMatchObject({
    identity: { requestId: ids[0], retirement: "correlated-refusal" },
    state: "refused",
    receipt: {
      requestId: ids[0],
      original: { smith: { name: smith.name } },
      result: { phase: "refused", reason: "stale-revision" },
    },
  });
  restarted.setDraft("workspace", { ...smith, name: "after-refusal" });
  await restarted.preview();
  await restarted.create();
  expect(restarted.get().entries.map((entry) => entry.state)).toEqual([
    "refused",
    "confirmed",
  ]);
  restarted.dispose();
});

test("disposing during an identity reservation durably retires the proven-undispatched UUID", async () => {
  const value = setup();
  let release: (() => void) | undefined;
  const pendingReservation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reserve = value.identities.reserve.bind(value.identities);
  value.identities.reserve = async (request) => {
    await pendingReservation;
    return reserve(request);
  };
  value.client.setDraft("workspace", smith);
  await value.client.preview();
  const pending = value.client.create();
  value.client.dispose();
  if (!release) throw Error("Reservation was not deferred");
  release();
  await pending;
  expect(value.posted).toHaveLength(0);
  expect(value.identities.read(ids[0]!)).toMatchObject({
    retired: true,
    retirement: "operator-not-sent",
  });
});

test("a verified NotSent response still retires after disposal while storage readback failure stays held", async () => {
  let releasePost: ((value: SmithCreatePostResult) => void) | undefined,
    started: (() => void) | undefined;
  const postStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = setup({
    post: async () => {
      started?.();
      return await new Promise<SmithCreatePostResult>((resolve) => {
        releasePost = resolve;
      });
    },
  });
  pending.client.setDraft("workspace", smith);
  await pending.client.preview();
  const create = pending.client.create();
  await postStarted;
  pending.client.dispose();
  releasePost?.({ state: "not-sent", message: "Operator access was refused." });
  await create;
  expect(pending.identities.read(ids[0]!)?.retired).toBe(true);

  const failure = setup({
    post: async () => ({
      state: "not-sent",
      message: "Operator token unavailable.",
    }),
  });
  failure.identities.retire = async () => {
    throw Error("Readback failed.");
  };
  failure.client.setDraft("workspace", smith);
  await failure.client.preview();
  await failure.client.create();
  expect(failure.identities.read(ids[0]!)).toMatchObject({ retired: false });
  expect(failure.client.get().entries[0]?.state).toBe("held");
  expect(failure.client.canStart()).toBe(false);
  failure.client.dispose();
});

test("unreadable identity metadata fails closed before review or create", async () => {
  const storage = new Map([[SMITH_CREATE_IDENTITIES, "not-json"]]);
  const identities = createSmithCreateIdentities({
    scope,
    storage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
    },
    withLock: async (work) => work(),
  });
  const client = createSmithConfigCreateClient({
    identities,
    canWrite: () => true,
    requestId: () => ids[0]!,
    preview: async () => preview({ target: "workspace", smith }),
    post: async () => ({ state: "unknown", message: "must not post" }),
    readOriginal: async () => null,
  });

  expect(client.canStart()).toBe(false);
  await client.preview();
  await client.create();
  expect(client.get().preview).toBeNull();
  expect(client.get().notice).toContain("could not be verified");
  client.dispose();
});

test("the renderer create dependency graph bundles for a browser without server journal or Node filesystem modules", async () => {
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../apps/desktop/src/smith-create-client.ts"),
    ],
    target: "browser",
  });
  expect(result.success).toBe(true);
  const bundle = (
    await Promise.all(result.outputs.map((output) => output.text()))
  ).join("\n");
  expect(bundle).not.toMatch(/node:(?:crypto|fs|path|sqlite)/);
  expect(bundle).not.toContain("smith-create-journal");
});
