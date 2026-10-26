import { expect, test } from "bun:test";
import {
  createSmithEditApi,
  type SmithEditPostResult,
} from "../../apps/desktop/src/smith-edit-api";
import { createSmithConfigEditClient } from "../../apps/desktop/src/smith-edit-client";
import {
  createSmithEditIdentities,
  SMITH_EDIT_IDENTITIES,
  smithConfigEditInputHash,
} from "../../apps/desktop/src/smith-edit-identities";
import { NotSent } from "../../docs/js/operator";
import type {
  SmithConfigEditPreview,
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
  const identities = createSmithEditIdentities({
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
  let postResult: SmithEditPostResult = {
    state: "unknown",
    message: "uncertain",
  };
  let previewGate: Promise<unknown> | null = null;
  const client = createSmithConfigEditClient({
    identities: () => identities,
    scope: () => scope,
    canWrite: () => writable,
    requestId: () => `e630e793-e617-4c93-bdaf-b1e30ba706e${++nextId}`,
    preview: async () => previewGate ?? preview,
    post: async (request) => {
      expect(identities.read(request.requestId)).not.toBeNull();
      postCalls++;
      posted = structuredClone(request);
      return postResult;
    },
    readOriginal: async () => original,
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

test("immutable name and any candidate, target, or selection change invalidate preview", async () => {
  const f = fixture();
  await f.client.preview();
  expect(f.client.get().preview).not.toBeNull();
  f.client.setDraft("workspace", "renamed", { ...smith, name: "renamed" });
  expect(f.client.get().preview).toBeNull();
  await f.client.preview();
  expect(f.client.get().preview).toBeNull();
  expect(f.client.get().notice).toContain("immutable");
  f.client.setDraft("user", smith.name, smith);
  expect(f.client.get().preview).toBeNull();
});

test("verified NotSent can settle; unknown transport outcome stays held", async () => {
  const f = fixture();
  await f.client.preview();
  const proof = await createSmithEditApi({
    post: async () => {
      throw new NotSent("The request was not dispatched.");
    },
    read: async () => new Response(null, { status: 404 }),
  }).edit({
    requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e1",
    target: "workspace",
    name: smith.name,
    smith,
    expectedRevision: revision,
  });
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
