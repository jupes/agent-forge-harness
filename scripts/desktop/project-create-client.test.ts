import { expect, test } from "bun:test";
import { createProjectCreateClient } from "../../apps/desktop/src/project-create-client";
import {
  type ProjectCreateOptions,
  projectCreateOptionsSchema,
} from "../projects/create-options-protocol";
import {
  type ProjectCreateDiscovery,
  type ProjectCreateIdentity,
  projectCreateIdentitySchema,
} from "../projects/create-protocol";
import { workspaceKey } from "../projects/scope";

const workspace = "/fixture/workspace";
const requestId = "ab847e06-4f01-4dd3-a425-47bf9053e006";
const requestHash = "a".repeat(64);
const original = {
  slug: "saved-project",
  name: "Saved project",
  description: "A durable original",
  icon: "P",
  keeperSmith: "Enabled keeper",
  workspaces: [
    { root: workspace, repositories: [workspace], epicIds: ["epic-a"] },
  ],
};
const identity: ProjectCreateIdentity = projectCreateIdentitySchema.parse({
  requestId,
  requestHash,
  original,
  baseRevision: 4,
  scopeHash: "b".repeat(64),
  scopeCount: 1,
  state: "reserved",
  projectId: null,
  createdRevision: null,
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
});
const row: ProjectCreateDiscovery["operations"][number] = {
  requestId,
  requestHash,
  state: "reserved",
  scopeCount: identity.scopeCount,
  projectId: null,
  createdAt: identity.createdAt,
  updatedAt: identity.updatedAt,
};
const options: ProjectCreateOptions = projectCreateOptionsSchema.parse({
  complete: true,
  workspace: { path: workspace, key: workspaceKey(workspace) },
  repositories: [
    {
      path: workspace,
      key: workspaceKey(workspace),
      name: "workspace",
      served: true,
    },
  ],
  epics: [{ id: "epic-a", title: "Epic A", parentId: null }],
});
const discovery = (...operations: ProjectCreateDiscovery["operations"]) => ({
  complete: true as const,
  operations,
});

function client(
  overrides: {
    workspace?: string | null;
    options?: () => Promise<ProjectCreateOptions>;
    discovery?: () => Promise<ProjectCreateDiscovery>;
    original?: (id: string) => Promise<ProjectCreateIdentity>;
  } = {},
) {
  return createProjectCreateClient({
    workspace:
      overrides.workspace === undefined ? workspace : overrides.workspace,
    options: overrides.options ?? (async () => options),
    discovery: overrides.discovery ?? (async () => discovery()),
    original: overrides.original ?? (async () => identity),
    changed() {},
  });
}

test("complete empty server discovery enables a new project", async () => {
  const owner = client();
  await owner.recover();
  expect(owner.get()).toMatchObject({ phase: "ready", entries: [], error: "" });
  owner.dispose();
});

test("reserved recovery requires the exact protected original and workspace", async () => {
  const owner = client({ discovery: async () => discovery(row) });
  await owner.recover();
  expect(owner.get()).toMatchObject({
    phase: "ready",
    entries: [{ identity, original }],
  });
  owner.dispose();

  const wrongHash = client({
    discovery: async () => discovery(row),
    original: async () => ({ ...identity, requestHash: "c".repeat(64) }),
  });
  await wrongHash.recover();
  expect(wrongHash.get()).toMatchObject({
    phase: "unavailable",
    entries: [],
  });
  wrongHash.dispose();
});

test("missing or unavailable exact originals stay held", async () => {
  const missing = client({
    discovery: async () => discovery(row),
    original: async () => {
      throw Error("404");
    },
  });
  await missing.recover();
  expect(missing.get()).toMatchObject({ phase: "unavailable", entries: [] });
  missing.dispose();

  const untrustedScope = client({ workspace: "/other/workspace" });
  await untrustedScope.recover();
  expect(untrustedScope.get()).toMatchObject({
    phase: "unavailable",
    entries: [],
  });
  untrustedScope.dispose();
});

test("a stale reserved-original read cannot replace a newer empty discovery", async () => {
  let resolveOriginal: ((value: ProjectCreateIdentity) => void) | undefined;
  let reads = 0;
  const owner = client({
    discovery: async () => {
      reads++;
      return discovery(...(reads === 1 ? [row] : []));
    },
    original: () =>
      new Promise((resolve) => {
        resolveOriginal = resolve;
      }),
  });
  const stale = owner.recover();
  while (!resolveOriginal) await Promise.resolve();
  await owner.recover();
  resolveOriginal(identity);
  await stale;
  expect(owner.get()).toMatchObject({ phase: "ready", entries: [] });
  owner.dispose();
});
