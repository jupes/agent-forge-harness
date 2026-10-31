import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InboxDispositionOriginal,
  inboxDispositionStoreSchema,
} from "../../types/inbox";
import { writeOwnerOnly } from "../hearth/token";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createProjectStore, projectCatalogPath } from "../projects/store";
import { projectCatalogFixture, projectFixture } from "../projects/testing";
import {
  createInboxDispositionStore,
  MAX_INBOX_DISPOSITION_ENTRIES,
  MAX_INBOX_DISPOSITION_ORIGINALS,
} from "./disposition-store";

const homes: string[] = [];
const PROJECT = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const OTHER_PROJECT = "project-b5832fa0-7a21-403b-8184-44892f0d8d86";
const REQUEST = "77c37127-1c22-4a2a-8e7d-69cc74ff1299";
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function fixture(options: { afterWrite?: () => void; now?: () => Date } = {}) {
  const home = mkdtempSync(join(tmpdir(), "forge-inbox-disposition-"));
  homes.push(home);
  const workspace = workspaceKey(resolveCheckout(home).workspace);
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify(projectCatalogFixture(workspace)),
  );
  const original: InboxDispositionOriginal = {
    requestId: REQUEST,
    expectedCatalogRevision: 1,
    workspace,
    item: {
      sourceKind: "unknown-bead-write",
      stableItemId: "bead-write:fixture",
      sourceRevision: "notice-1",
    },
    expectedRevision: 0,
    operation: "snooze-1h",
  };
  return {
    home,
    original,
    store: createInboxDispositionStore(home, options),
  };
}

function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the storage operation to refuse");
}

test("reservation and apply replay retain one exact snooze receipt", async () => {
  let instant = new Date("2026-10-31T12:00:00.000Z");
  const { store, original } = fixture({ now: () => instant });
  const reserved = await store.reserve(PROJECT, original.workspace, original);
  expect(reserved).toMatchObject({
    entry: null,
    receipt: {
      original: { ...original, projectId: PROJECT },
      phase: "reserved",
    },
  });
  expect(await store.reserve(PROJECT, original.workspace, original)).toEqual(
    reserved,
  );
  const changed = { ...original, operation: "done" as const };
  await expect(
    store.reserve(PROJECT, original.workspace, changed),
  ).rejects.toMatchObject({ status: 409, code: "request-id-reused" });
  await expect(
    store.apply(PROJECT, original.workspace, changed),
  ).rejects.toMatchObject({
    status: 409,
    code: "original-mismatch",
  });
  await expect(
    store.discard(PROJECT, REQUEST, original.workspace, changed),
  ).rejects.toMatchObject({
    status: 409,
    code: "original-mismatch",
  });
  expect(store.original(PROJECT, REQUEST, original.workspace)).toEqual(
    reserved,
  );
  await expect(
    store.apply(PROJECT, original.workspace, {
      ...original,
      requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1286",
    }),
  ).rejects.toMatchObject({ status: 409, code: "reservation-missing" });
  const applied = await store.apply(PROJECT, original.workspace, original);
  expect(applied).toMatchObject({
    entry: { operation: "snooze-1h", revision: 1 },
    receipt: {
      phase: "applied",
      outcome: "applied",
      resultingRevision: 1,
      snoozedUntil: "2026-10-31T13:00:00.000Z",
    },
  });
  instant = new Date("2026-10-31T14:00:00.000Z");
  expect(await store.apply(PROJECT, original.workspace, original)).toEqual(
    applied,
  );
  expect(await store.reserve(PROJECT, original.workspace, original)).toEqual(
    applied,
  );
  expect(inboxDispositionStoreSchema.safeParse(store.read()).success).toBe(
    true,
  );
  expect(store.collection(PROJECT, original.workspace).receipts).toHaveLength(
    1,
  );
});

test("complete recovery retains receipts across removed projects and workspaces", async () => {
  const { home, store, original } = fixture();
  const oldWorkspace = `${original.workspace}/old-workspace`;
  const catalog = createProjectStore(home).read();
  catalog.projects[0]!.workspaces.push({
    root: oldWorkspace,
    repositories: [oldWorkspace],
    epicIds: ["old-epic"],
  });
  catalog.projects.push(
    projectFixture(original.workspace, {
      id: OTHER_PROJECT,
      slug: "beta",
    }),
  );
  writeOwnerOnly(projectCatalogPath(home), JSON.stringify(catalog));

  const current = await store.reserve(PROJECT, original.workspace, original);
  const oldScopeOriginal = {
    ...original,
    requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1298",
    workspace: oldWorkspace,
    item: { ...original.item, stableItemId: "bead-write:old-workspace" },
  };
  const oldScope = await store.reserve(PROJECT, oldWorkspace, oldScopeOriginal);
  const otherProjectOriginal = {
    ...original,
    requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1297",
    item: { ...original.item, stableItemId: "bead-write:other-project" },
  };
  const otherProject = await store.reserve(
    OTHER_PROJECT,
    original.workspace,
    otherProjectOriginal,
  );

  const archived = await createProjectStore(home).preferences(PROJECT, 1, {
    archived: true,
  });
  archived.projects[0]!.workspaces = [archived.projects[0]!.workspaces[1]!];
  archived.projects = archived.projects.filter((item) => item.id === PROJECT);
  writeOwnerOnly(projectCatalogPath(home), JSON.stringify(archived));

  expect(store.recovery()).toEqual({
    version: 1,
    complete: true,
    receipts: [
      current.receipt,
      oldScope.receipt,
      otherProject.receipt,
    ],
  });
});

test("a pending identity fences source revision changes", async () => {
  const { home, store, original } = fixture();
  const changed = {
    ...original,
    requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1288",
    item: { ...original.item, sourceRevision: "notice-2" },
  };
  const attempts = await Promise.allSettled([
    store.reserve(PROJECT, original.workspace, original),
    store.reserve(PROJECT, changed.workspace, changed),
  ]);
  expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
  const refused = attempts.find((item) => item.status === "rejected");
  expect(refused?.status === "rejected" ? refused.reason : null).toMatchObject({
    status: 409,
    code: "pending-original",
  });
  expect(store.collection(PROJECT, original.workspace).receipts).toHaveLength(
    1,
  );
});

test("an acknowledgment for one source revision never carries into the next", async () => {
  const { store, original } = fixture();
  await store.reserve(PROJECT, original.workspace, original);
  await store.apply(PROJECT, original.workspace, original);
  const next = {
    ...original,
    requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1287",
    item: { ...original.item, sourceRevision: "notice-2" },
  };
  expect(
    store.original(PROJECT, original.requestId, original.workspace)?.entry,
  ).toMatchObject({
    item: { sourceRevision: "notice-1" },
  });
  expect(await store.reserve(PROJECT, next.workspace, next)).toMatchObject({
    entry: null,
  });
  expect(await store.apply(PROJECT, next.workspace, next)).toMatchObject({
    entry: { item: { sourceRevision: "notice-2" }, revision: 1 },
  });
  expect(store.collection(PROJECT, original.workspace).entries).toHaveLength(2);
});

test("discard and apply serialize to one immutable terminal receipt", async () => {
  const { store, original } = fixture();
  await store.reserve(PROJECT, original.workspace, original);
  const [applied, discarded] = await Promise.all([
    store.apply(PROJECT, original.workspace, original),
    store.discard(PROJECT, REQUEST, original.workspace, original),
  ]);
  const saved = store.original(PROJECT, REQUEST, original.workspace);
  if (!saved)
    throw new Error("The terminal disposition receipt was not retained");
  expect(saved.receipt.phase).toMatch(/^(applied|refused)$/);
  expect([applied.receipt, discarded.receipt]).toContainEqual(saved.receipt);
  expect(await store.apply(PROJECT, original.workspace, original)).toEqual(
    saved,
  );
  expect(
    await store.discard(PROJECT, REQUEST, original.workspace, original),
  ).toEqual(saved);
});

test("an apply arriving after explicit discard cannot create an entry", async () => {
  const { store, original } = fixture();
  await store.reserve(PROJECT, original.workspace, original);
  const discarded = await store.discard(
    PROJECT,
    original.requestId,
    original.workspace,
    original,
  );
  const lateApply = await store.apply(PROJECT, original.workspace, original);
  expect(lateApply).toEqual(discarded);
  expect(lateApply).toMatchObject({
    entry: null,
    receipt: { phase: "refused", refusalCode: "discarded" },
  });
});

test("a write that throws after rename is confirmed by exact readback", async () => {
  let first = true;
  const { home, store, original } = fixture({
    afterWrite() {
      if (first) {
        first = false;
        throw new Error("injected post-write failure");
      }
    },
  });
  const saved = await store.reserve(PROJECT, original.workspace, original);
  expect(store.original(PROJECT, REQUEST, original.workspace)).toEqual(saved);
  expect(
    readFileSync(join(home, "inbox-dispositions", "state.json"), "utf8"),
  ).toContain('"phase": "reserved"');
});

test("an apply that throws after persisting its entry returns the confirmed exact receipt", async () => {
  let writes = 0;
  const { store, original } = fixture({
    afterWrite() {
      writes++;
      if (writes === 2) throw new Error("injected after apply persistence");
    },
  });
  await store.reserve(PROJECT, original.workspace, original);
  const applied = await store.apply(PROJECT, original.workspace, original);
  expect(writes).toBe(2);
  expect(applied).toMatchObject({
    entry: { operation: "snooze-1h", revision: 1 },
    receipt: {
      original: { requestId: original.requestId },
      phase: "applied",
      outcome: "applied",
    },
  });
  expect(
    store.original(PROJECT, original.requestId, original.workspace),
  ).toEqual(applied);
});

test("an apply with an unconfirmable post-write outcome stays uncertain with 504", async () => {
  let writes = 0;
  let stateFile = "";
  const { home, store, original } = fixture({
    afterWrite() {
      writes++;
      if (writes === 2) {
        rmSync(stateFile, { force: true });
        throw new Error("injected unreadable apply persistence");
      }
    },
  });
  stateFile = join(home, "inbox-dispositions", "state.json");
  await store.reserve(PROJECT, original.workspace, original);
  await expect(
    store.apply(PROJECT, original.workspace, original),
  ).rejects.toMatchObject({
    status: 504,
    code: "write-uncertain",
  });
  expect(writes).toBe(2);
});

test("a changed project catalog becomes a retained refusal with no app entry", async () => {
  const { home, store, original } = fixture();
  await store.reserve(PROJECT, original.workspace, original);
  await createProjectStore(home).preferences(PROJECT, 1, { pinned: true });
  const saved = await store.apply(PROJECT, original.workspace, original);
  expect(saved).toMatchObject({
    entry: null,
    receipt: { phase: "refused", refusalCode: "catalog-changed" },
  });
  await createProjectStore(home).preferences(PROJECT, 2, { archived: true });
  expect(
    store.original(PROJECT, original.requestId, original.workspace),
  ).toEqual(saved);
});

test("a stale apply retains the newer entry and its original request", async () => {
  const { home, store, original } = fixture();
  await store.reserve(PROJECT, original.workspace, original);
  await store.apply(PROJECT, original.workspace, original);
  const next = {
    ...original,
    requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1289",
    expectedRevision: 1,
    operation: "snooze-1h" as const,
  };
  await store.reserve(PROJECT, next.workspace, next);
  const current = store.read();
  const newer = {
    projectId: current.entries[0]!.projectId,
    workspace: current.entries[0]!.workspace,
    item: current.entries[0]!.item,
    revision: 2,
    operation: "done" as const,
    updatedAt: "2026-10-31T13:00:00.000Z",
  };
  writeOwnerOnly(
    join(home, "inbox-dispositions", "state.json"),
    JSON.stringify({ ...current, entries: [newer] }),
  );
  const refused = await store.apply(PROJECT, next.workspace, next);
  expect(refused).toMatchObject({
    entry: { revision: 2, operation: "done" },
    receipt: { phase: "refused", refusalCode: "entry-revision-changed" },
  });
});

test("entry and original limits refuse without evicting retained records", async () => {
  const { home, store, original } = fixture();
  await store.reserve(PROJECT, original.workspace, original);
  const withEntries = {
    ...store.read(),
    entries: Array.from(
      { length: MAX_INBOX_DISPOSITION_ENTRIES },
      (_, index) => ({
        projectId: PROJECT,
        workspace: original.workspace,
        item: {
          sourceKind: "unknown-bead-write" as const,
          stableItemId: `bead-write:${index}`,
          sourceRevision: "bounded-fixture",
        },
        revision: 1,
        operation: "done" as const,
        updatedAt: "2026-10-31T12:00:00.000Z",
      }),
    ),
  };
  writeOwnerOnly(
    join(home, "inbox-dispositions", "state.json"),
    JSON.stringify(withEntries),
  );
  const before = store.read();
  const next = {
    ...original,
    requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1290",
    item: { ...original.item, stableItemId: "bead-write:new" },
  };
  await store.reserve(PROJECT, next.workspace, next);
  const beforeApply = store.read();
  await expect(
    store.apply(PROJECT, next.workspace, next),
  ).rejects.toMatchObject({ code: "entry-limit" });
  expect(store.read()).toEqual(beforeApply);
  expect(store.read().entries).toEqual(before.entries);

  const receipts = Array.from(
    { length: MAX_INBOX_DISPOSITION_ORIGINALS },
    (_, index) => ({
      original: {
        ...original,
        projectId: PROJECT,
        requestId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        item: {
          ...original.item,
          stableItemId: `bead-write:retained-${index}`,
        },
      },
      phase: "reserved" as const,
      reservedAt: "2026-10-31T12:00:00.000Z",
    }),
  );
  const full = { version: 1 as const, entries: [], receipts };
  writeOwnerOnly(
    join(home, "inbox-dispositions", "state.json"),
    JSON.stringify(full),
  );
  await expect(
    store.reserve(PROJECT, original.workspace, {
      ...original,
      requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1291",
      item: { ...original.item, stableItemId: "bead-write:extra" },
    }),
  ).rejects.toMatchObject({ code: "original-limit" });
  expect(store.read().receipts).toHaveLength(MAX_INBOX_DISPOSITION_ORIGINALS);
});

test("semantically duplicate retained entries or pending fences fail closed", async () => {
  const { home, store, original } = fixture();
  await store.reserve(PROJECT, original.workspace, original);
  const reserved = store.read();
  const duplicatePending = {
    ...reserved,
    receipts: [
      ...reserved.receipts,
      {
        ...reserved.receipts[0]!,
        original: {
          ...reserved.receipts[0]!.original,
          requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1292",
          workspace: `${reserved.receipts[0]!.original.workspace}/`,
          item: {
            ...reserved.receipts[0]!.original.item,
            sourceRevision: "notice-2",
          },
        },
      },
    ],
  };
  writeOwnerOnly(
    join(home, "inbox-dispositions", "state.json"),
    JSON.stringify(duplicatePending),
  );
  expect(thrown(() => store.read())).toMatchObject({
    code: "storage-duplicate-identity",
  });

  const appliedStore = fixture();
  const saved = await appliedStore.store.reserve(
    PROJECT,
    appliedStore.original.workspace,
    appliedStore.original,
  );
  await appliedStore.store.apply(
    PROJECT,
    appliedStore.original.workspace,
    appliedStore.original,
  );
  const state = appliedStore.store.read();
  writeOwnerOnly(
    join(appliedStore.home, "inbox-dispositions", "state.json"),
    JSON.stringify({
      ...state,
      entries: [
        state.entries[0],
        { ...state.entries[0], workspace: `${state.entries[0]!.workspace}/` },
      ],
    }),
  );
  expect(thrown(() => appliedStore.store.read())).toMatchObject({
    code: "storage-duplicate-identity",
  });
  expect(saved.receipt.phase).toBe("reserved");
});

test("missing or corrupt initialized storage refuses instead of returning empty", async () => {
  const { home, store, original } = fixture();
  await store.reserve(PROJECT, original.workspace, original);
  const file = join(home, "inbox-dispositions", "state.json");
  rmSync(join(home, "inbox-dispositions"), { recursive: true, force: true });
  expect(thrown(() => store.read())).toMatchObject({ status: 503 });
  expect(thrown(() => store.recovery())).toMatchObject({ status: 503 });
  writeOwnerOnly(file, "{");
  expect(thrown(() => store.read())).toMatchObject({ status: 503 });
  expect(thrown(() => store.recovery())).toMatchObject({ status: 503 });
  writeOwnerOnly(file, "x".repeat(4 * 1024 * 1024 + 1));
  expect(thrown(() => store.read())).toMatchObject({ status: 503 });
  expect(thrown(() => store.recovery())).toMatchObject({ status: 503 });
});

test("a hearth cannot reserve, apply, discard, or recover another workspace's original", async () => {
  const { home, store, original } = fixture();
  const served = original.workspace;
  const foreign = `${served}/another-workspace`;
  const catalog = projectCatalogFixture(served);
  catalog.projects[0]!.workspaces.push({
    root: foreign,
    repositories: [foreign],
    epicIds: ["beta-epic"],
  });
  writeOwnerOnly(projectCatalogPath(home), JSON.stringify(catalog));
  const retained = await store.reserve(PROJECT, served, original);
  const foreignOriginal = {
    ...original,
    requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1293",
    workspace: foreign,
    item: { ...original.item, stableItemId: "bead-write:foreign-workspace" },
  };
  const saved = store.read();
  writeOwnerOnly(
    join(home, "inbox-dispositions", "state.json"),
    JSON.stringify({
      ...saved,
      receipts: [
        ...saved.receipts,
        {
          original: { ...foreignOriginal, projectId: PROJECT },
          phase: "reserved",
          reservedAt: "2026-10-31T12:00:00.000Z",
        },
      ],
    }),
  );
  await expect(
    store.reserve(PROJECT, served, { ...original, workspace: foreign }),
  ).rejects.toMatchObject({ code: "workspace-not-served" });
  await expect(
    store.apply(PROJECT, served, foreignOriginal),
  ).rejects.toMatchObject({ code: "workspace-not-served" });
  await expect(
    store.discard(PROJECT, foreignOriginal.requestId, served, foreignOriginal),
  ).rejects.toMatchObject({ code: "workspace-not-served" });
  expect(store.original(PROJECT, foreignOriginal.requestId, served)).toBeNull();
  expect(store.original(PROJECT, REQUEST, served)).toEqual(retained);
  expect(store.collection(PROJECT, served).receipts).toHaveLength(1);
});
