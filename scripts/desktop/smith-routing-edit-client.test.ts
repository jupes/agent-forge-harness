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
import { canonicalSmithRoutingEditRequest } from "../config/smith-routing-edit-protocol";

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
const preview: SmithRoutingEditPreview = {
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
};
function fixture(
  result: SmithRoutingEditPostResult,
  read: () => Promise<unknown> = async () => {
    throw Error("404");
  },
) {
  const saved = new Map<string, SmithRoutingEditIdentity>();
  let posts = 0,
    reads = 0,
    reserves = 0;
  const identities: SmithRoutingEditIdentityStore = {
    list: () => [...saved.values()],
    reserve: async (identity) => {
      reserves++;
      saved.set(identity.requestId, identity);
      return { identity, created: true };
    },
    retire: async (identity, retirement) => {
      const updated = { ...identity, retired: true, retirement };
      saved.set(identity.requestId, updated);
      return updated;
    },
  };
  const client = createSmithRoutingEditClient({
    identities: () => identities,
    scope: () => "workspace-A",
    canWrite: () => true,
    requestId: () => request.requestId,
    preview: async () => preview,
    post: async () => {
      posts++;
      return result;
    },
    readOriginal: async () => {
      reads++;
      return await read();
    },
  });
  client.setDraft("workspace", change);
  return { client, saved, counts: () => ({ posts, reads, reserves }) };
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
  await f.client.recover();
  expect(f.counts()).toEqual({ posts: 1, reads: 1, reserves: 1 });
  expect(f.client.get().entries[0]?.state).toBe("held");
});
