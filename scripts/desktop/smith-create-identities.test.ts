import { expect, test } from "bun:test";
import {
  createSmithCreateIdentities,
  SMITH_CREATE_IDENTITIES,
  smithConfigCreateInputHash,
} from "../../apps/desktop/src/smith-create-identities";
import type { SmithConfigCreateRequest } from "../../types/smith-config-create";

const scope = "http://127.0.0.1:8888",
  requestId = "18da5c95-3218-439c-a33d-e5662465f505";
function request(name = "PRIVATE SMITH NAME"): SmithConfigCreateRequest {
  return {
    requestId,
    target: "workspace",
    smith: {
      name,
      provider: "codex",
      model: "private-model-name",
      effort: "high",
      enabled: true,
      tags: ["private-tag"],
    },
    expectedRevision: {
      version: 1,
      user: "a".repeat(64),
      workspace: "b".repeat(64),
    },
  };
}
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  let active = false;
  const withLock = async <T>(work: () => T | Promise<T>) => {
    while (active) await Promise.resolve();
    active = true;
    try {
      return await work();
    } finally {
      active = false;
    }
  };
  return {
    storage,
    identities: createSmithCreateIdentities({ scope, storage, withLock }),
    make: (otherScope = scope) =>
      createSmithCreateIdentities({ scope: otherScope, storage, withLock }),
  };
}

test("metadata is read-back verified, concurrent reservations keep one exact identity, and no Smith body is stored", async () => {
  const value = fixture();
  const [first, second] = await Promise.all([
    value.identities.reserve(request()),
    value.make().reserve(request()),
  ]);
  expect([first.created, second.created].sort()).toEqual([false, true]);
  expect(first.identity).toEqual(second.identity);
  expect(first.identity).toEqual({
    requestId,
    scope,
    target: "workspace",
    inputHash: await smithConfigCreateInputHash(request()),
  });
  const saved = value.storage.getItem(SMITH_CREATE_IDENTITIES);
  expect(saved).not.toBeNull();
  expect(saved).not.toContain("PRIVATE SMITH NAME");
  expect(saved).not.toContain("private-model-name");
  expect(saved).not.toContain("private-tag");
  expect(value.make("http://127.0.0.1:9999").read(requestId)).toBeNull();
  expect(value.make("http://127.0.0.1:9999").list()).toEqual([]);
});

test("a reused UUID with changed input or scope refuses without changing saved metadata", async () => {
  const value = fixture();
  const held = await value.identities.reserve(request());
  const before = value.storage.getItem(SMITH_CREATE_IDENTITIES);
  await expect(
    value.identities.reserve(request("Changed Smith")),
  ).rejects.toThrow("different original");
  await expect(
    value.make("http://127.0.0.1:9999").reserve(request()),
  ).rejects.toThrow("different original");
  expect(value.storage.getItem(SMITH_CREATE_IDENTITIES)).toBe(before);
  expect(value.identities.read(requestId)).toEqual(held.identity);
});

test("corrupt, future, duplicate, oversized, unavailable, unlocked, and unverified metadata never reserve an identity", async () => {
  const savedTexts = [
    "{broken",
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({
      version: 1,
      records: [
        { requestId, scope, target: "user", inputHash: "x" },
        { requestId, scope, target: "user", inputHash: "x" },
      ],
    }),
    "x".repeat(65_537),
  ];
  for (const text of savedTexts) {
    const value = fixture();
    value.storage.setItem(SMITH_CREATE_IDENTITIES, text);
    await expect(value.identities.reserve(request())).rejects.toThrow();
    expect(value.storage.getItem(SMITH_CREATE_IDENTITIES)).toBe(text);
  }
  const value = fixture();
  await expect(
    createSmithCreateIdentities({
      scope,
      storage: null,
      withLock: async (work) => work(),
    }).reserve(request()),
  ).rejects.toThrow("unavailable");
  await expect(
    createSmithCreateIdentities({
      scope,
      storage: value.storage,
      withLock: async () => {
        throw Error("Origin lock unavailable");
      },
    }).reserve(request()),
  ).rejects.toThrow("Origin lock");
  const ignoresWrite = createSmithCreateIdentities({
    scope,
    storage: { getItem: () => null, setItem: () => {} },
    withLock: async (work) => work(),
  });
  await expect(ignoresWrite.reserve(request())).rejects.toThrow("verified");
});
