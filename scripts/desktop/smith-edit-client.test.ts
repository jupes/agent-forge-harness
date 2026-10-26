import { expect, test } from "bun:test";
import {
  createSmithEditApi,
  isVerifiedSmithEditNotSent,
  type SmithEditPostResult,
} from "../../apps/desktop/src/smith-edit-api";
import { createSmithConfigEditClient } from "../../apps/desktop/src/smith-edit-client";
import {
  createSmithEditIdentities,
  SMITH_EDIT_IDENTITIES,
  type SmithEditIdentities,
  smithConfigEditInputHash,
} from "../../apps/desktop/src/smith-edit-identities";
import { NotSent } from "../../docs/js/operator";
import type {
  SmithConfigEditPreview,
  SmithConfigEditReceipt,
  SmithConfigEditRequest,
} from "../../types/smith-config-edit";

const smith = {
  name: "claude-master",
  provider: "claude",
  model: "model-a",
  effort: "high",
  enabled: true,
  tags: ["rank:master"],
};
const revision = {
  version: 1 as const,
  user: "a".repeat(64),
  workspace: "b".repeat(64),
};

function fixture(
  withLock: <T>(work: () => T | Promise<T>) => Promise<T> = async <T>(
    work: () => T | Promise<T>,
  ) => await work(),
  sharedIdentities?: SmithEditIdentities,
  fixedRequestId?: string,
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
  const identities =
    sharedIdentities ??
    createSmithEditIdentities({
      scope: "trusted-scope",
      storage,
      withLock,
    });
  const preview: SmithConfigEditPreview = {
    version: 1,
    target: "workspace",
    file: "C:/workspace/agent-forge.toml",
    expectedRevision: revision,
    candidate: { sha256: "c".repeat(64), byteLength: 200, created: false },
    review: {
      name: smith.name,
      targetBefore: { model: "old-model" },
      targetAfter: smith,
      effectiveBefore: { ...smith, model: "old-model" },
      effectiveAfter: smith,
      provenanceBefore: {
        provider: "builtin",
        model: "C:/user/agent-forge.toml",
        effort: "builtin",
        enabled: "C:/workspace/agent-forge.toml",
        tags: "builtin",
      },
      provenanceAfter: {
        provider: "C:/workspace/agent-forge.toml",
        model: "C:/workspace/agent-forge.toml",
        effort: "C:/workspace/agent-forge.toml",
        enabled: "C:/workspace/agent-forge.toml",
        tags: "C:/workspace/agent-forge.toml",
      },
    },
  };
  let scope = "trusted-scope";
  let writable = true;
  let nextId = 0;
  let posted: SmithConfigEditRequest | null = null;
  let postCalls = 0;
  let original: unknown = null;
  let postGate: Promise<void> | null = null;
  let postStarted: (() => void) | null = null;
  let postResult: SmithEditPostResult = {
    state: "unknown",
    message: "uncertain",
  };
  let previewGate: Promise<unknown> | null = null;
  const client = createSmithConfigEditClient({
    identities: () => identities,
    scope: () => scope,
    canWrite: () => writable,
    requestId: () =>
      fixedRequestId ?? `e630e793-e617-4c93-bdaf-b1e30ba706e${++nextId}`,
    preview: async () => previewGate ?? preview,
    post: async (request) => {
      expect(identities.read(request.requestId)).not.toBeNull();
      postCalls++;
      posted = structuredClone(request);
      postStarted?.();
      if (postGate) await postGate;
      return postResult;
    },
    readOriginal: async () =>
      typeof original === "function" ? await original() : original,
  });
  client.setDraft("workspace", smith.name, smith);
  return {
    client,
    identities,
    values,
    preview,
    get posted() {
      return posted;
    },
    get postCalls() {
      return postCalls;
    },
    set original(value: unknown) {
      original = value;
    },
    set postGate(value: Promise<void> | null) {
      postGate = value;
    },
    onPostStarted(callback: () => void) {
      postStarted = callback;
    },
    set postResult(value: SmithEditPostResult) {
      postResult = value;
    },
    set previewGate(value: Promise<unknown> | null) {
      previewGate = value;
    },
    set scope(value: string) {
      scope = value;
    },
    set writable(value: boolean) {
      writable = value;
    },
  };
}

function serialLock() {
  let tail = Promise.resolve();
  return async <T>(work: () => T | Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

async function verifiedNotSent(request: SmithConfigEditRequest) {
  return createSmithEditApi({
    post: async () => {
      throw new NotSent("The request was not dispatched.");
    },
    read: async () => new Response(null, { status: 404 }),
    scope: () => "trusted-scope",
    canWrite: () => true,
  }).edit(request, {
    scope: "trusted-scope",
    inputHash: await smithConfigEditInputHash(request),
  });
}

function uncertain503(request: SmithConfigEditRequest) {
  return createSmithEditApi({
    post: async () => new Response("service unavailable", { status: 503 }),
    read: async () => new Response(null, { status: 404 }),
    scope: () => "trusted-scope",
    canWrite: () => true,
  }).edit(request, { scope: "trusted-scope", inputHash: "f".repeat(64) });
}

test("save requires the exact reviewed candidate and reserves metadata before POST", async () => {
  const f = fixture();
  await f.client.preview();
  expect(f.client.get().preview).toEqual(f.preview);
  await f.client.save();
  expect(f.posted).toMatchObject({
    name: smith.name,
    target: "workspace",
    smith,
    expectedRevision: revision,
  });
  const record = JSON.parse(f.values.get(SMITH_EDIT_IDENTITIES)!);
  expect(record.records).toHaveLength(1);
  expect(JSON.stringify(record)).not.toContain(smith.model);
  expect(f.client.get().entries[0]?.state).toBe("held");
});

test("immutable selected name cannot change; a new selected Smith invalidates preview", async () => {
  const f = fixture();
  await f.client.preview();
  expect(f.client.get().preview).not.toBeNull();
  f.client.setDraft("workspace", smith.name, { ...smith, name: "renamed" });
  expect(f.client.get().preview).toBeNull();
  await f.client.preview();
  expect(f.client.get().preview).toBeNull();
  expect(f.client.get().notice).toContain("immutable");
  f.client.setDraft("user", "other-existing-smith", {
    ...smith,
    name: "other-existing-smith",
  });
  expect(f.client.get().preview).toBeNull();
});

test("verified NotSent can settle; unknown transport outcome stays held", async () => {
  const f = fixture();
  await f.client.preview();
  const notSentRequest = {
    requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e1",
    target: "workspace" as const,
    name: smith.name,
    smith,
    expectedRevision: revision,
  };
  const proof = await verifiedNotSent(notSentRequest);
  const expectedProof = {
    requestId: notSentRequest.requestId,
    scope: "trusted-scope",
    inputHash: await smithConfigEditInputHash(notSentRequest),
  };
  expect(isVerifiedSmithEditNotSent(proof, expectedProof)).toBe(true);
  expect(
    isVerifiedSmithEditNotSent(proof, {
      ...expectedProof,
      scope: "other-scope",
    }),
  ).toBe(false);
  expect(
    isVerifiedSmithEditNotSent(proof, {
      ...expectedProof,
      inputHash: await smithConfigEditInputHash({
        ...notSentRequest,
        smith: { ...notSentRequest.smith, model: "different-body" },
      }),
    }),
  ).toBe(false);
  expect(
    isVerifiedSmithEditNotSent(proof, {
      ...expectedProof,
      inputHash: await smithConfigEditInputHash({
        ...notSentRequest,
        target: "user",
      }),
    }),
  ).toBe(false);
  expect(
    isVerifiedSmithEditNotSent(proof, {
      ...expectedProof,
      requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e2",
    }),
  ).toBe(false);
  f.postResult = proof;
  await f.client.save();
  expect(f.client.get().entries[0]?.state).toBe("not-sent");

  const other = fixture();
  await other.client.preview();
  other.postResult = { state: "unknown", message: "A generic failure." };
  await other.client.save();
  expect(other.client.get().entries[0]?.state).toBe("held");
  expect(other.identities.list()[0]?.retired).toBe(false);
});

test("NotSent proof cannot reuse a same-UUID reservation hash for another request", async () => {
  const original = {
    requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e1",
    target: "workspace" as const,
    name: smith.name,
    smith,
    expectedRevision: revision,
  };
  const changed = {
    ...original,
    target: "user" as const,
    smith: { ...smith, model: "different-model" },
  };
  let postCalls = 0;
  const outcome = await createSmithEditApi({
    post: async () => {
      postCalls++;
      throw new NotSent("This path must not be reached.");
    },
    read: async () => new Response(null, { status: 404 }),
    scope: () => "trusted-scope",
    canWrite: () => true,
  }).edit(changed, {
    scope: "trusted-scope",
    inputHash: await smithConfigEditInputHash(original),
  });
  expect(outcome.state).toBe("unknown");
  expect(postCalls).toBe(0);
  expect(
    isVerifiedSmithEditNotSent(outcome, {
      requestId: original.requestId,
      scope: "trusted-scope",
      inputHash: await smithConfigEditInputHash(original),
    }),
  ).toBe(false);
});

test("API rechecks live scope after the canonical hash await before dispatch", async () => {
  const request = {
    requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e1",
    target: "workspace" as const,
    name: smith.name,
    smith,
    expectedRevision: revision,
  };
  const reservation = {
    scope: "trusted-scope",
    inputHash: await smithConfigEditInputHash(request),
  };
  let scopeReads = 0;
  let postCalls = 0;
  const outcome = await createSmithEditApi({
    post: async () => {
      postCalls++;
      throw new NotSent("This path must not be reached.");
    },
    read: async () => new Response(null, { status: 404 }),
    scope: () => (scopeReads++ === 0 ? "trusted-scope" : "new-scope"),
    canWrite: () => true,
  }).edit(request, reservation);
  expect(scopeReads).toBe(2);
  expect(postCalls).toBe(0);
  expect(
    isVerifiedSmithEditNotSent(outcome, {
      requestId: request.requestId,
      ...reservation,
    }),
  ).toBe(true);
});

test("API freezes request bytes synchronously before hashing and posting", async () => {
  const request: SmithConfigEditRequest = {
    requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e1",
    target: "workspace",
    name: smith.name,
    smith: structuredClone(smith),
    expectedRevision: revision,
  };
  const original = structuredClone(request);
  const reservation = {
    scope: "trusted-scope",
    inputHash: await smithConfigEditInputHash(original),
  };
  const posted: unknown[] = [];
  const api = createSmithEditApi({
    post: async (_url, body) => {
      posted.push(structuredClone(body));
      return new Response(
        JSON.stringify({ ok: false, data: null, error: "refused" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    },
    read: async () => new Response(null, { status: 404 }),
    scope: () => "trusted-scope",
    canWrite: () => true,
  });
  const pending = api.edit(request, reservation);
  request.smith.model = "mutated while request hash is pending";
  request.target = "user";
  const outcome = await pending;
  expect(posted).toEqual([original]);
  expect(
    isVerifiedSmithEditNotSent(outcome, {
      requestId: original.requestId,
      ...reservation,
    }),
  ).toBe(true);
});

test("exact original recovery is GET-only and a terminal receipt cannot regress", async () => {
  const f = fixture();
  await f.client.preview();
  await f.client.save();
  const original = f.posted!;
  const hash = await smithConfigEditInputHash(original);
  const preview = f.preview;
  const confirmed = {
    version: 1,
    requestId: original.requestId,
    ownerScopeHash: "e".repeat(64),
    inputHash: hash,
    createdAt: "2026-10-25T12:00:00.000Z",
    original,
    result: {
      phase: "confirmed",
      completedAt: "2026-10-25T12:00:01.000Z",
      preview,
      publication: {
        file: preview.file,
        created: preview.candidate.created,
        sha256: preview.candidate.sha256,
      },
    },
  };
  f.original = { ok: true, data: confirmed, error: null };
  await f.client.check(original.requestId);
  expect(f.client.get().entries[0]?.state).toBe("confirmed");
  expect(f.postCalls).toBe(1);

  f.original = {
    ok: true,
    data: {
      ...confirmed,
      result: {
        phase: "refused",
        refusedAt: "2026-10-25T12:00:02.000Z",
        reason: "stale-revision",
        preview,
      },
    },
    error: null,
  };
  await f.client.check(original.requestId);
  expect(f.client.get().entries[0]?.state).toBe("confirmed");
  expect(f.client.get().entries[0]?.notice).toContain("conflicts");
  expect(f.postCalls).toBe(1);
});

test("original GET rejects a wrong UUID, hash, immutable name, or target independently", async () => {
  const mutations: Array<{
    label: string;
    apply(receipt: SmithConfigEditReceipt): Promise<SmithConfigEditReceipt>;
  }> = [
    {
      label: "UUID",
      apply: async (receipt) => ({
        ...receipt,
        requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e2",
      }),
    },
    {
      label: "hash",
      apply: async (receipt) => ({ ...receipt, inputHash: "0".repeat(64) }),
    },
    {
      label: "name",
      apply: async (receipt) => {
        if (receipt.result.phase !== "confirmed")
          throw Error("Expected confirmed receipt fixture.");
        const name = "different-name";
        const smithValue = { ...receipt.original.smith, name };
        const original = { ...receipt.original, name, smith: smithValue };
        const preview = {
          ...receipt.result.preview!,
          review: {
            ...receipt.result.preview!.review,
            name,
            targetAfter: smithValue,
            effectiveBefore: {
              ...receipt.result.preview!.review.effectiveBefore,
              name,
            },
            effectiveAfter: smithValue,
          },
        };
        const inputHash = await smithConfigEditInputHash(original);
        return {
          ...receipt,
          inputHash,
          original,
          result: { ...receipt.result, preview },
        };
      },
    },
    {
      label: "target",
      apply: async (receipt) => {
        if (receipt.result.phase !== "confirmed")
          throw Error("Expected confirmed receipt fixture.");
        const original = { ...receipt.original, target: "user" as const };
        const preview = {
          ...receipt.result.preview!,
          target: "user" as const,
          file: "C:/user/agent-forge.toml",
        };
        const inputHash = await smithConfigEditInputHash(original);
        return {
          ...receipt,
          inputHash,
          original,
          result: {
            ...receipt.result,
            preview,
            publication: { ...receipt.result.publication, file: preview.file },
          },
        };
      },
    },
  ];

  for (const mutation of mutations) {
    const f = fixture();
    await f.client.preview();
    await f.client.save();
    const original = f.posted!;
    const preview = f.preview;
    const valid: SmithConfigEditReceipt = {
      version: 1,
      requestId: original.requestId,
      ownerScopeHash: "e".repeat(64),
      inputHash: await smithConfigEditInputHash(original),
      createdAt: "2026-10-25T12:00:00.000Z",
      original,
      result: {
        phase: "confirmed",
        completedAt: "2026-10-25T12:00:01.000Z",
        preview,
        publication: {
          file: preview.file,
          created: preview.candidate.created,
          sha256: preview.candidate.sha256,
        },
      },
    };
    f.original = { ok: true, data: await mutation.apply(valid), error: null };
    await f.client.check(original.requestId);
    expect(f.client.get().entries[0]?.state, mutation.label).toBe("held");
    expect(f.postCalls).toBe(1);
  }
});

test("generic 503 followed by original 404 stays held and never posts again", async () => {
  const f = fixture();
  await f.client.preview();
  const unknown = await uncertain503({
    requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e1",
    target: "workspace",
    name: smith.name,
    smith,
    expectedRevision: revision,
  });
  f.postResult = unknown;
  await f.client.save();
  expect(f.client.get().entries[0]?.state).toBe("held");
  const postCount = f.postCalls;
  f.original = async () =>
    await createSmithEditApi({
      post: async () => new Response(null, { status: 503 }),
      read: async () => new Response(null, { status: 404 }),
      scope: () => "trusted-scope",
      canWrite: () => true,
    }).original("e630e793-e617-4c93-bdaf-b1e30ba706e1");
  await f.client.check("e630e793-e617-4c93-bdaf-b1e30ba706e1");
  expect(f.client.get().entries[0]?.state).toBe("held");
  expect(f.postCalls).toBe(postCount);
  expect(f.identities.list()[0]?.retired).toBe(false);
});

test("live scope change while reservation is pending settles without a stale POST", async () => {
  let entered!: () => void;
  let release!: () => void;
  const lockEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const lockGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async <T>(work: () => T | Promise<T>) => {
    entered();
    await lockGate;
    return await work();
  });
  await f.client.preview();
  const saving = f.client.save();
  await lockEntered;
  f.scope = "changed-scope";
  release();
  await saving;
  expect(f.posted).toBeNull();
  expect(f.identities.list()[0]).toMatchObject({
    retired: true,
    retirement: "verified-not-sent",
  });
});

test("a matching NotSent arriving after scope loss still settles only its original metadata", async () => {
  const f = fixture();
  await f.client.preview();
  const request = {
    requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e1",
    target: "workspace" as const,
    name: smith.name,
    smith,
    expectedRevision: revision,
  };
  f.postResult = await verifiedNotSent(request);
  let started!: () => void;
  const postStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.onPostStarted(started);
  f.postGate = pending;
  const saving = f.client.save();
  await postStarted;
  f.scope = "new-scope";
  f.writable = false;
  release();
  await saving;
  expect(f.postCalls).toBe(1);
  expect(f.identities.read(request.requestId)).toMatchObject({
    scope: "trusted-scope",
    retired: true,
    retirement: "verified-not-sent",
  });
  expect(f.client.get().entries).toEqual([]);
});

test("a NotSent after disposal is durable and a recovered client may review a new UUID", async () => {
  const f = fixture();
  await f.client.preview();
  f.postResult = await verifiedNotSent({
    requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e1",
    target: "workspace",
    name: smith.name,
    smith,
    expectedRevision: revision,
  });
  let started!: () => void;
  const postStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.onPostStarted(started);
  f.postGate = pending;
  const saving = f.client.save();
  await postStarted;
  f.client.dispose();
  release();
  await saving;
  expect(
    f.identities.read("e630e793-e617-4c93-bdaf-b1e30ba706e1"),
  ).toMatchObject({
    retired: true,
    retirement: "verified-not-sent",
  });

  const nextPosted: SmithConfigEditRequest[] = [];
  const recovered = createSmithConfigEditClient({
    identities: () => f.identities,
    scope: () => "trusted-scope",
    canWrite: () => true,
    requestId: () => "e630e793-e617-4c93-bdaf-b1e30ba706e2",
    preview: async () => f.preview,
    post: async (request) => {
      nextPosted.push(structuredClone(request));
      return { state: "unknown", message: "second request held" };
    },
    readOriginal: async () => null,
  });
  recovered.setDraft("workspace", smith.name, smith);
  await recovered.recover();
  await recovered.preview();
  await recovered.save();
  expect(nextPosted[0]?.requestId).toBe("e630e793-e617-4c93-bdaf-b1e30ba706e2");
  expect(
    f.identities.list().filter((identity) => !identity.retired),
  ).toHaveLength(1);
});

test("two clients sharing the identity lock can admit only one unresolved edit", async () => {
  const withLock = serialLock();
  const first = fixture(withLock);
  const second = fixture(
    withLock,
    first.identities,
    "e630e793-e617-4c93-bdaf-b1e30ba706e2",
  );
  await Promise.all([first.client.preview(), second.client.preview()]);
  await Promise.all([first.client.save(), second.client.save()]);
  expect(first.postCalls + second.postCalls).toBe(1);
  expect(
    first.identities.list().filter((identity) => !identity.retired),
  ).toHaveLength(1);
  expect(
    [first.client.get().notice, second.client.get().notice].some(
      (notice) =>
        notice.includes("already held") || notice.includes("unresolved"),
    ),
  ).toBe(true);
});
