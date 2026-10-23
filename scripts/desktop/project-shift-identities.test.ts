import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  createProjectShiftIdentities,
  PROJECT_SHIFT_IDENTITIES,
  projectShiftInputHash,
} from "../../apps/desktop/src/project-shift-identities";
import { projectShiftRequestHash } from "../shifts/registry";
import { sessionStartFixture } from "./session-start-fixture";

const scope = {
    projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
    workspace: "C:/Fixture/Workspace/",
  },
  requestId = "2230bb02-1119-4c69-adad-c44116b375c1",
  input = {
    expectedCatalogRevision: 7,
    options: {
      for: "2h",
      concurrency: 2,
      maxBeads: 4,
      maxUsd: 10,
      repairs: 3,
      base: "master",
    },
  };

test("the browser shift hash preserves literal pre-extraction version-1 bytes and canonical workspace spelling", async () => {
  const request = { ...input, requestId },
    golden = "87198cd34129711fb1f16c1a133ab2df5e453eb1a56b0a49e8343fda4613e2db";
  expect(
    projectShiftRequestHash(scope.projectId, scope.workspace, request),
  ).toBe(golden);
  expect(await projectShiftInputHash(scope, request)).toBe(golden);
  expect(
    await projectShiftInputHash(
      { ...scope, workspace: "c:\\fixture\\workspace" },
      request,
    ),
  ).toBe(golden);
});

test("two windows retain one original full-bound hash before POST and recreate metadata without storing a private body or workspace", async () => {
  const f = sessionStartFixture(),
    make = () => createProjectShiftIdentities(f);
  let minted = 0;
  const mint = () => {
    minted++;
    return requestId;
  };
  const [one, two] = await Promise.all([
    make().reserve(scope, input, mint),
    make().reserve(
      scope,
      { ...input, options: { ...input.options, base: "PRIVATE-OTHER-BRANCH" } },
      mint,
    ),
  ]);
  expect([one.created, two.created]).toEqual([true, false]);
  expect(minted).toBe(1);
  expect(two.request).toBeNull();
  expect(one.request).toEqual({ ...input, requestId });
  expect(await make().read(scope)).toEqual(one.identity);
  const bytes = f.storage.getItem(PROJECT_SHIFT_IDENTITIES);
  expect(bytes).not.toContain("PRIVATE");
  expect(bytes).not.toContain("Fixture");
  expect(bytes).not.toContain("options");
  await expect(
    make().release({ ...one.identity, requestHash: "f".repeat(64) }),
  ).rejects.toThrow("different original");
  expect(f.storage.getItem(PROJECT_SHIFT_IDENTITIES)).toBe(bytes);
  await make().release(one.identity);
  expect(await make().read(scope)).toBeNull();
});

test("different served workspaces hold independent identities for the same project", async () => {
  const f = sessionStartFixture(),
    ids = createProjectShiftIdentities(f);
  const one = await ids.reserve(scope, input, () => requestId),
    foreign = { ...scope, workspace: "C:/Foreign/Workspace" };
  const two = await ids.reserve(
    foreign,
    input,
    () => "8230bb02-1119-4c69-adad-c44116b375c1",
  );
  expect(one.identity.scope).not.toBe(two.identity.scope);
  expect(await ids.read(scope)).toEqual(one.identity);
  await ids.release(two.identity);
  expect(await ids.read(scope)).toEqual(one.identity);
});

test("corrupt, future, conflicting and full identity journals refuse before a new UUID or write and preserve exact saved bytes", async () => {
  const f = sessionStartFixture(),
    ids = createProjectShiftIdentities(f),
    one = await ids.reserve(scope, input, () => requestId);
  const full = Array.from({ length: 256 }, (_, index) => ({
    ...one.identity,
    scope: index.toString(16).padStart(64, "0"),
    requestId: `${index.toString(16).padStart(8, "0")}-1119-4c69-adad-c44116b375c1`,
  }));
  for (const text of [
    "{corrupt",
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [one.identity, one.identity] }),
    JSON.stringify({ version: 1, records: full }),
  ]) {
    f.storage.setItem(PROJECT_SHIFT_IDENTITIES, text);
    let minted = 0;
    await expect(
      ids.reserve(scope, input, () => {
        minted++;
        return requestId;
      }),
    ).rejects.toThrow();
    expect(minted).toBe(0);
    expect(f.storage.getItem(PROJECT_SHIFT_IDENTITIES)).toBe(text);
  }
});

test("unavailable storage, failed origin lock or failed readback cannot grant a new Start", async () => {
  const f = sessionStartFixture();
  for (const ids of [
    createProjectShiftIdentities({ ...f, storage: null }),
    createProjectShiftIdentities({
      ...f,
      withLock: async () => {
        throw Error("No lock");
      },
    }),
    createProjectShiftIdentities({
      ...f,
      storage: { getItem: () => null, setItem: () => {} },
    }),
  ])
    await expect(ids.reserve(scope, input, () => requestId)).rejects.toThrow();
});

test("the original shift identity protocol is browser-safe and imports no registry, filesystem or model runtime", async () => {
  const built = await Bun.build({
    entrypoints: [
      join(
        import.meta.dir,
        "../../apps/desktop/src/project-shift-identities.ts",
      ),
    ],
    target: "browser",
  });
  expect(built.success).toBe(true);
  const text = await built.outputs[0]?.text();
  expect(text).toBeDefined();
  for (const forbidden of [
    "node:fs",
    "bun:sqlite",
    "writeOwnerOnly",
    "createProjectShiftRegistry",
    "runExec",
  ])
    expect(text).not.toContain(forbidden);
});
