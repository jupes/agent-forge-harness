import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createSmithEditIdentities,
  SMITH_EDIT_IDENTITIES,
  smithConfigEditInputHash,
} from "../../apps/desktop/src/smith-edit-identities";
import type { SmithConfigEditRequest } from "../../types/smith-config-edit";
import { canonicalSmithConfigEditRequest } from "../config/smith-edit-protocol";

const request: SmithConfigEditRequest = {
  requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e5",
  target: "workspace",
  name: "claude-master",
  smith: {
    name: "claude-master",
    provider: "claude",
    model: "private model text",
    effort: "custom",
    enabled: true,
    tags: ["rank:master"],
  },
  expectedRevision: {
    version: 1,
    user: "a".repeat(64),
    workspace: "b".repeat(64),
  },
};

function storageFixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  return { storage, values };
}

test("edit identity uses browser-safe canonical bytes and keeps a separate metadata-only namespace", async () => {
  const { storage, values } = storageFixture();
  const identities = createSmithEditIdentities({
    scope: "trusted-scope",
    storage,
    withLock: (work) => Promise.resolve(work()),
  });
  const expected = createHash("sha256")
    .update(canonicalSmithConfigEditRequest(request), "utf8")
    .digest("hex");
  expect(await smithConfigEditInputHash(request)).toBe(expected);
  const reserved = await identities.reserve(request);
  expect(reserved.created).toBe(true);
  expect(reserved.identity).toMatchObject({
    requestId: request.requestId,
    scope: "trusted-scope",
    target: "workspace",
    name: request.name,
    inputHash: expected,
    retired: false,
  });
  const savedText = values.get(SMITH_EDIT_IDENTITIES)!;
  expect(savedText).toContain(request.requestId);
  expect(savedText).toContain(expected);
  expect(savedText).not.toContain("private model text");
  expect(savedText).not.toContain("expectedRevision");
  expect([...values.keys()]).toEqual([SMITH_EDIT_IDENTITIES]);
});

test("unavailable, malformed, oversized, or unverifiable metadata never admits a new edit", async () => {
  const locked = async <T>(work: () => T | Promise<T>): Promise<T> =>
    await work();
  const unavailable = createSmithEditIdentities({
    scope: "s",
    storage: null,
    withLock: locked,
  });
  await expect(unavailable.reserve(request)).rejects.toThrow(
    "storage is unavailable",
  );

  const malformed = storageFixture();
  malformed.storage.setItem(SMITH_EDIT_IDENTITIES, "{");
  const malformedStore = createSmithEditIdentities({
    scope: "s",
    ...malformed,
    withLock: locked,
  });
  await expect(malformedStore.reserve(request)).rejects.toThrow(
    "could not be verified",
  );

  const oversized = storageFixture();
  oversized.storage.setItem(SMITH_EDIT_IDENTITIES, " ".repeat(65_537));
  const oversizedStore = createSmithEditIdentities({
    scope: "s",
    ...oversized,
    withLock: locked,
  });
  await expect(oversizedStore.reserve(request)).rejects.toThrow(
    "storage limit",
  );

  const changedReadback = storageFixture();
  let writes = 0;
  const lyingStorage = {
    getItem: changedReadback.storage.getItem,
    setItem(key: string, value: string) {
      writes++;
      changedReadback.storage.setItem(key, value);
      if (writes > 0)
        changedReadback.storage.setItem(key, '{"version":1,"records":[]}');
    },
  };
  const unverifiable = createSmithEditIdentities({
    scope: "s",
    storage: lyingStorage,
    withLock: locked,
  });
  await expect(unverifiable.reserve(request)).rejects.toThrow(
    "could not be saved and verified",
  );
});

test("a duplicate UUID is immutable and only exact proof can settle its reservation", async () => {
  const { storage } = storageFixture();
  const identities = createSmithEditIdentities({
    scope: "s",
    storage,
    withLock: (work) => Promise.resolve(work()),
  });
  const reserved = await identities.reserve(request);
  expect((await identities.reserve(request)).created).toBe(false);
  await expect(
    identities.reserve({
      ...request,
      smith: { ...request.smith, model: "changed" },
    }),
  ).rejects.toThrow("different original");
  const retired = await identities.retire(
    reserved.identity,
    "verified-not-sent",
  );
  expect(retired).toMatchObject({
    retired: true,
    retirement: "verified-not-sent",
  });
  await expect(
    identities.retire(reserved.identity, "correlated-refusal"),
  ).rejects.toThrow("different settlement proof");
});
