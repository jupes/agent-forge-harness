import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createSmithRoutingEditClient,
  type SmithRoutingEditIdentity,
  type SmithRoutingEditIdentityStore,
  type SmithRoutingEditPostResult,
} from "../../apps/desktop/src/smith-routing-edit-client";
import { smithRoutingEditInputHash } from "../../apps/desktop/src/smith-routing-edit-identities";
import type {
  SmithRoutingEditChange,
  SmithRoutingEditPreview,
  SmithRoutingEditRequest,
} from "../../types/smith-routing-edit";
import {
  canonicalSmithRoutingEditRequest,
  smithRoutingEditPreviewSchema,
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
function fixture(
  result: SmithRoutingEditPostResult,
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
    posted: SmithRoutingEditRequest | null = null;
  const identities: SmithRoutingEditIdentityStore = {
    list: () => [...saved.values()],
    reserve: async (identity) => {
      reserves++;
      reserveEntered?.();
      const previous = saved.get(identity.requestId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(identity))
        throw Error("UUID conflict");
      saved.set(identity.requestId, identity);
      if (reserveGate) await reserveGate;
      return { identity: saved.get(identity.requestId)!, created: !previous };
    },
    retire: async (identity, retirement) => {
      const updated = { ...identity, retired: true, retirement };
      saved.set(identity.requestId, updated);
      return updated;
    },
  };
  const createClient = () => {
    const client = createSmithRoutingEditClient({
      identities: () => identities,
      scope: () => scope,
      canWrite: () => true,
      requestId: () => request.requestId,
      preview: async () => preview,
      post: async (value) => {
        posts++;
        posted = structuredClone(value);
        return result;
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
  };
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
  const inputHash = await smithRoutingEditInputHash(request);
  const f = fixture(
    {
      state: "not-sent",
      requestId: request.requestId,
      scope: "workspace-A",
      inputHash,
      message: "not dispatched",
    },
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
  await f.client.preview();
  await Promise.all([f.client.save(), f.client.save()]);
  expect(f.counts()).toMatchObject({ posts: 1, reserves: 1 });
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
  await started;
  draft.entries[0]!.weight = 9;
  f.scope = "workspace-B";
  release();
  await saving;
  expect(f.counts().posts).toBe(0);
  expect([...f.saved.values()][0]?.inputHash).toBe(
    await smithRoutingEditInputHash(original),
  );
});
