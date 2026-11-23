import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativePhysicalPath } from "../native-realpath";
import { completeTrackerFixture } from "./complete-tracker-fixture";
import {
  type CompleteBeadRow,
  parseCompleteTracker,
} from "./complete-tracker-source";
import { projectWorkspaceRef } from "./connected-source-common";
import { createWorkspaceSourceInstance } from "./connected-source-instance";
import { SOURCE_MAX_REQUESTS } from "./connected-source-protocol";
import { createConnectedSources } from "./connected-source-service";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "./testing";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const bead = (id: string, parent?: string): CompleteBeadRow => ({
  id,
  title: id,
  status: "open",
  issue_type: parent ? "task" : "epic",
  priority: 2,
  description: "Private full body",
  acceptance_criteria: "AC",
  notes: "Notes",
  created_at: "2026-11-09T01:00:00Z",
  updated_at: "2026-11-09T02:00:00Z",
  labels: ["project:alpha"],
  dependencies: parent
    ? [{ issue_id: id, depends_on_id: parent, type: "parent-child" }]
    : [],
  metadata: {},
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "connected-sources-"));
  roots.push(root);
  mkdirSync(join(root, "local"));
  mkdirSync(join(root, "remote"));
  const local = nativePhysicalPath(join(root, "local")),
    remote = nativePhysicalPath(join(root, "remote"));
  const catalog = projectCatalogFixture(local);
  catalog.projects[0]!.workspaces.push({
    root: remote,
    repositories: [remote],
    epicIds: ["remote-epic"],
  });
  const id = {
      database: "fixture",
      projectId: "11111111-1111-4111-8111-111111111111",
    },
    remoteId = {
      database: "remote",
      projectId: "22222222-2222-4222-8222-222222222222",
    };
  const snapshot = () => structuredClone(catalog);
  let hold: Promise<void> | undefined,
    live = true,
    choice: string | null = remote,
    pickHold: Promise<string | null> | undefined;
  let pickerCalls = 0,
    connections = 0,
    remoteReads = 0;
  const own = createWorkspaceSourceInstance({
    root: local,
    catalog: snapshot,
    complete: async () =>
      parseCompleteTracker(
        completeTrackerFixture(id, [
          bead("alpha-epic"),
          bead("alpha-task", "alpha-epic"),
        ]),
        id,
      ),
  });
  const foreign = createWorkspaceSourceInstance({
    root: remote,
    catalog: snapshot,
    complete: async () => {
      remoteReads++;
      await hold;
      return parseCompleteTracker(
        completeTrackerFixture(remoteId, [
          bead("remote-epic"),
          bead("remote-task", "remote-epic"),
        ]),
        remoteId,
      );
    },
  });
  const service = createConnectedSources({
    root: local,
    catalog: snapshot,
    own,
    pick: async () => {
      pickerCalls++;
      return pickHold ? pickHold : choice;
    },
    connect: async (root) => {
      connections++;
      expect(root).toBe(remote);
      const identity = await foreign.identity();
      return {
        identity,
        current: () => live,
        preview: (input) =>
          foreign.preview({
            ...input,
            instanceId: identity.instanceId,
            trackerId: identity.tracker.projectId,
          }),
      };
    },
  });
  const ref = projectWorkspaceRef(FIXTURE_PROJECT_ID, remote),
    localRef = projectWorkspaceRef(FIXTURE_PROJECT_ID, local);
  const input = () => ({
    requestId: randomUUID(),
    workspaceRef: ref,
    expectedRevision: catalog.revision,
  });
  return {
    root,
    local,
    remote,
    own,
    foreign,
    service,
    catalog,
    ref,
    localRef,
    input,
    counts: () => ({ pickerCalls, connections, remoteReads }),
    choice: (value: string | null) => {
      choice = value;
    },
    pickHold: (value: Promise<string | null> | undefined) => {
      pickHold = value;
    },
    hold: (value: Promise<void> | undefined) => {
      hold = value;
    },
    live: (value: boolean) => {
      live = value;
    },
  };
}
test("catalog listing and unapproved preview never discover or read a foreign source", async () => {
  const f = fixture();
  expect(
    f.service.list(FIXTURE_PROJECT_ID).workspaces.map((w) => w.authority),
  ).toEqual(["served", "not-authorized"]);
  await expect(
    f.service.preview(FIXTURE_PROJECT_ID, f.ref, 1, ["remote-epic"]),
  ).rejects.toThrow("Authorize");
  expect(f.counts()).toEqual({
    pickerCalls: 0,
    connections: 0,
    remoteReads: 0,
  });
  expect(
    (await f.service.preview(FIXTURE_PROJECT_ID, f.localRef, 1, ["alpha-epic"]))
      .scopeCount,
  ).toBe(2);
  expect(f.counts().connections).toBe(0);
});
test("one explicit consent authorizes exact remote preview; original recovery never reopens it", async () => {
  const f = fixture(),
    input = f.input(),
    receipt = await f.service.authorize(FIXTURE_PROJECT_ID, input);
  expect(receipt.state).toBe("authorized");
  expect(f.service.original(FIXTURE_PROJECT_ID, input.requestId)).toEqual(
    receipt,
  );
  expect(await f.service.authorize(FIXTURE_PROJECT_ID, input)).toEqual(receipt);
  const preview = await f.service.preview(FIXTURE_PROJECT_ID, f.ref, 1, [
    "remote-epic",
  ]);
  expect(preview).toMatchObject({
    projectId: FIXTURE_PROJECT_ID,
    workspaceRef: f.ref,
    scopeCount: 2,
    grantId: receipt.grantId,
  });
  expect(JSON.stringify(preview)).not.toContain("Private full body");
  expect(f.counts().pickerCalls).toBe(1);
  expect(f.counts().connections).toBe(1);
});
test("pending receipt reads and duplicate UUIDs only inspect the same chooser", async () => {
  const f = fixture(),
    pick = deferred<string | null>();
  f.pickHold(pick.promise);
  const input = f.input(),
    one = f.service.authorize(FIXTURE_PROJECT_ID, input),
    two = f.service.authorize(FIXTURE_PROJECT_ID, input);
  expect(f.service.original(FIXTURE_PROJECT_ID, input.requestId)).toMatchObject(
    { state: "pending", grantId: null },
  );
  expect(f.counts().pickerCalls).toBe(1);
  const busy = await f.service.authorize(FIXTURE_PROJECT_ID, f.input());
  expect(busy.state).toBe("unavailable");
  expect(f.counts().pickerCalls).toBe(1);
  pick.resolve(f.remote);
  expect(await one).toEqual(await two);
  expect(() =>
    f.service.authorize(FIXTURE_PROJECT_ID, { ...input, expectedRevision: 2 }),
  ).toThrow();
});
test("cancelled wrong-folder and stale consent add no read authority", async () => {
  for (const mode of ["cancel", "folder", "revision"]) {
    const f = fixture();
    if (mode === "cancel") f.choice(null);
    if (mode === "folder") f.choice(f.local);
    let input = f.input();
    if (mode === "revision") {
      const pick = deferred<string | null>();
      f.pickHold(pick.promise);
      const pending = f.service.authorize(FIXTURE_PROJECT_ID, input);
      f.catalog.revision++;
      pick.resolve(f.remote);
      expect((await pending).state).toBe("unavailable");
    } else
      expect((await f.service.authorize(FIXTURE_PROJECT_ID, input)).state).toBe(
        mode === "cancel" ? "cancelled" : "unavailable",
      );
    expect(f.counts().connections).toBe(0);
    expect(f.service.list(FIXTURE_PROJECT_ID).workspaces[1]?.authority).toBe(
      "not-authorized",
    );
  }
});
test("revocation fences a held preview and a new grant cannot revive the old read", async () => {
  const f = fixture(),
    receipt = await f.service.authorize(FIXTURE_PROJECT_ID, f.input());
  const held = deferred<void>();
  f.hold(held.promise);
  const read = f.service.preview(FIXTURE_PROJECT_ID, f.ref, 1, ["remote-epic"]);
  f.service.revoke(FIXTURE_PROJECT_ID, f.ref, receipt.grantId!);
  f.hold(undefined);
  const newer = await f.service.authorize(FIXTURE_PROJECT_ID, f.input());
  held.resolve();
  await expect(read).rejects.toThrow();
  expect(newer.grantId).not.toBe(receipt.grantId);
  expect(
    (await f.service.preview(FIXTURE_PROJECT_ID, f.ref, 1, ["remote-epic"]))
      .grantId,
  ).toBe(newer.grantId!);
});
test("observed source loss retires its grant even if the old source returns", async () => {
  const f = fixture();
  await f.service.authorize(FIXTURE_PROJECT_ID, f.input());
  f.live(false);
  await expect(
    f.service.preview(FIXTURE_PROJECT_ID, f.ref, 1, ["remote-epic"]),
  ).rejects.toThrow();
  f.live(true);
  await expect(
    f.service.preview(FIXTURE_PROJECT_ID, f.ref, 1, ["remote-epic"]),
  ).rejects.toThrow("Authorize");
  expect(f.counts().connections).toBe(1);
});
test("workspace registration changes and shutdown cannot publish a late grant", async () => {
  for (const mode of ["registration", "shutdown"]) {
    const f = fixture(),
      pick = deferred<string | null>();
    f.pickHold(pick.promise);
    const pending = f.service.authorize(FIXTURE_PROJECT_ID, f.input());
    if (mode === "registration") {
      f.catalog.projects[0]!.workspaces[1]!.repositories = [];
      f.catalog.revision++;
    } else f.service.deactivate();
    pick.resolve(f.remote);
    expect((await pending).state).toBe("unavailable");
    expect(f.counts().connections).toBe(0);
  }
});
test("request capacity refuses new UUIDs without evicting cancelled originals", async () => {
  const f = fixture();
  f.choice(null);
  const first = f.input();
  await f.service.authorize(FIXTURE_PROJECT_ID, first);
  for (let n = 1; n < SOURCE_MAX_REQUESTS; n++)
    await f.service.authorize(FIXTURE_PROJECT_ID, f.input());
  expect(() => f.service.authorize(FIXTURE_PROJECT_ID, f.input())).toThrow(
    "retained authorization request limit",
  );
  expect(await f.service.authorize(FIXTURE_PROJECT_ID, first)).toMatchObject({
    state: "cancelled",
  });
  expect(f.service.original(FIXTURE_PROJECT_ID, first.requestId)).toMatchObject(
    { state: "cancelled" },
  );
  expect(f.counts().pickerCalls).toBe(SOURCE_MAX_REQUESTS);
});

test("observed archive deletion or registration loss is absorbing across restore without foreign probes", async () => {
  for (const kind of ["archive", "delete", "registration"]) {
    const f = fixture();
    await f.service.authorize(FIXTURE_PROJECT_ID, f.input());
    const saved = structuredClone(f.catalog.projects[0]!);
    if (kind === "archive") f.catalog.projects[0]!.archived = true;
    else if (kind === "delete") f.catalog.projects = [];
    else f.catalog.projects[0]!.workspaces[1]!.repositories = [];
    f.catalog.revision++;
    if (kind === "registration")
      expect(f.service.list(FIXTURE_PROJECT_ID).workspaces[1]?.authority).toBe(
        "not-authorized",
      );
    else expect(() => f.service.list(FIXTURE_PROJECT_ID)).toThrow();
    f.catalog.projects = [saved];
    f.catalog.revision++;
    await expect(
      f.service.preview(FIXTURE_PROJECT_ID, f.ref, f.catalog.revision, [
        "remote-epic",
      ]),
    ).rejects.toThrow("Authorize");
    expect(f.counts()).toMatchObject({
      pickerCalls: 1,
      connections: 1,
      remoteReads: 1,
    });
  }
});
test("an observed archive retires pending consent even when project is restored before native result", async () => {
  const f = fixture(),
    pick = deferred<string | null>();
  f.pickHold(pick.promise);
  const pending = f.service.authorize(FIXTURE_PROJECT_ID, f.input());
  f.catalog.projects[0]!.archived = true;
  f.catalog.revision++;
  expect(() => f.service.list(FIXTURE_PROJECT_ID)).toThrow();
  f.catalog.projects[0]!.archived = false;
  f.catalog.revision++;
  pick.resolve(f.remote);
  expect((await pending).state).toBe("unavailable");
  expect(f.counts().connections).toBe(0);
  expect(f.service.list(FIXTURE_PROJECT_ID).workspaces[1]?.authority).toBe(
    "not-authorized",
  );
});
