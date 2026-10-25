import { expect, test } from "bun:test";
import {
  createSmithCreateIdentities,
  SMITH_CREATE_IDENTITIES,
  smithConfigCreateInputHash,
} from "../../apps/desktop/src/smith-create-identities";
import type { SmithConfigCreateRequest } from "../../types/smith-config-create";

const scope = "http://127.0.0.1:8888",
  requestId = "18da5c95-3218-439c-a33d-e5662465f505",
  otherRequestId = "28da5c95-3218-439c-a33d-e5662465f506",
  thirdRequestId = "38da5c95-3218-439c-a33d-e5662465f507";
function request(
  name = "PRIVATE SMITH NAME",
  id = requestId,
): SmithConfigCreateRequest {
  return {
    requestId: id,
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
    retired: false,
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

test("settlement retirement is serialized, durable, and cannot reuse its UUID", async () => {
  const value = fixture();
  const reservation = await value.identities.reserve(request());
  const retired = await value.identities.retire(
    reservation.identity,
    "operator-not-sent",
  );
  expect(retired).toMatchObject({
    retired: true,
    retirement: "operator-not-sent",
  });
  expect(value.make().read(requestId)).toEqual(retired);
  expect(value.storage.getItem(SMITH_CREATE_IDENTITIES)).toContain(
    '"retirement":"operator-not-sent"',
  );
  await expect(value.identities.reserve(request())).resolves.toMatchObject({
    created: false,
    identity: { requestId, retired: true },
  });
  await expect(
    value.identities.retire(reservation.identity, "correlated-refusal"),
  ).rejects.toThrow("different settlement proof");
  expect(reservation.created).toBe(true);
});

test("concurrent reserve and retirement read back one settled identity", async () => {
  const value = fixture();
  const [first, second] = await Promise.all([
    value.identities.reserve(request()),
    value.make().reserve(request()),
  ]);
  const settled = await value.identities.retire(
    first.identity,
    "correlated-refusal",
  );
  expect([first.created, second.created].sort()).toEqual([false, true]);
  expect(value.make().read(requestId)).toEqual(settled);
  expect(value.identities.list()).toEqual([settled]);
});

test("settlement readback cannot release a replacement identity with a changed immutable hash", async () => {
  const values = new Map<string, string>();
  let writes = 0,
    changedAfterWrite = false,
    readsAfterWrite = 0;
  const storage = {
    getItem(key: string) {
      const text = values.get(key) ?? null;
      if (!changedAfterWrite || text === null) return text;
      readsAfterWrite++;
      if (readsAfterWrite < 2) return text;
      const parsed = JSON.parse(text) as {
        records: { inputHash: string }[];
      };
      parsed.records[0]!.inputHash = "f".repeat(64);
      return JSON.stringify(parsed);
    },
    setItem(key: string, text: string) {
      values.set(key, text);
      writes++;
      changedAfterWrite = writes > 1;
      if (changedAfterWrite) readsAfterWrite = 0;
    },
  };
  const identities = createSmithCreateIdentities({
    scope,
    storage,
    withLock: async (work) => work(),
  });
  const reservation = await identities.reserve(request());
  await expect(
    identities.retire(reservation.identity, "operator-not-sent"),
  ).rejects.toThrow("could not be verified");
  expect(reservation.identity.retired).toBe(false);
});

test("legacy v1 reservations stay held and block a different unresolved UUID", async () => {
  const value = fixture();
  const legacy = {
    version: 1,
    records: [
      {
        requestId,
        scope,
        target: "workspace",
        inputHash: await smithConfigCreateInputHash(request()),
      },
    ],
  };
  value.storage.setItem(SMITH_CREATE_IDENTITIES, JSON.stringify(legacy));
  expect(value.identities.read(requestId)).toMatchObject({ retired: false });

  await expect(
    value.make().reserve(request("PRIVATE SMITH NAME", otherRequestId)),
  ).rejects.toThrow("unresolved in this workspace");
  expect(value.identities.list()).toHaveLength(1);
  expect(value.identities.read(requestId)?.retired).toBe(false);
  expect(value.identities.read(otherRequestId)).toBeNull();
});

test("separate identity owners cannot concurrently reserve different unresolved UUIDs", async () => {
  const value = fixture();
  const attempts = await Promise.allSettled([
    value.identities.reserve(request("FIRST", otherRequestId)),
    value.make().reserve(request("SECOND", thirdRequestId)),
  ]);
  expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
  expect(value.identities.list()).toHaveLength(1);
  expect(value.identities.list()[0]?.retired).toBe(false);
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
