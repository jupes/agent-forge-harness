import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOwnerOnly } from "../hearth/token";
import { nativePhysicalPath } from "../native-realpath";
import { completeFixtureModel } from "./complete-tracker-test-model";
import { projectWorkspaceRef } from "./connected-source-common";
import { createWorkspaceSourceInstance } from "./connected-source-instance";
import { createConnectedSources } from "./connected-source-service";
import { type ScopeSave, scopeSaveSchema } from "./scope-settings-protocol";
import { createScopeSettings } from "./scope-settings-service";
import { createProjectStore, projectCatalogPath } from "./store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "./testing";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
async function fixture(duplicate = false) {
  const home = mkdtempSync(join(tmpdir(), "scope-save-"));
  homes.push(home);
  for (const name of ["local", "remote"]) mkdirSync(join(home, name));
  const local = nativePhysicalPath(join(home, "local")),
    remote = nativePhysicalPath(join(home, "remote")),
    catalog = projectCatalogFixture(local);
  catalog.projects[0]!.workspaces.push({
    root: remote,
    repositories: [remote],
    epicIds: ["alpha-epic"],
  });
  writeOwnerOnly(projectCatalogPath(home), JSON.stringify(catalog));
  const store = createProjectStore(home);
  let hold: Promise<void> | undefined,
    changed = false,
    live = true,
    sourceReads = 0;
  const snapshot = (foreign: boolean) => {
    const model = completeFixtureModel({
      status: 0,
      stderr: "",
      stdout: [
        "alpha-epic",
        "beta-epic",
        ...(changed && foreign ? ["extra"] : []),
      ]
        .map((id) =>
          JSON.stringify({
            id,
            title: id,
            status: "open",
            issue_type: id === "extra" ? "task" : "epic",
            labels: ["project:alpha"],
            ...(id === "extra"
              ? {
                  dependencies: [
                    {
                      issue_id: id,
                      depends_on_id: "beta-epic",
                      type: "parent-child",
                    },
                  ],
                }
              : {}),
          }),
        )
        .join("\n"),
    });
    return {
      ...model,
      identity: {
        database: foreign ? "remote" : "local",
        projectId:
          foreign && !duplicate
            ? "22222222-2222-4222-8222-222222222222"
            : "11111111-1111-4111-8111-111111111111",
      },
    };
  };
  const own = createWorkspaceSourceInstance({
      root: local,
      catalog: store.read,
      complete: async () => snapshot(false),
    }),
    foreign = createWorkspaceSourceInstance({
      root: remote,
      catalog: store.read,
      complete: async () => {
        sourceReads++;
        await hold;
        return snapshot(true);
      },
    });
  const sources = createConnectedSources({
    root: local,
    catalog: store.read,
    own,
    pick: async () => remote,
    connect: async () => {
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
    receipt = await sources.authorize(FIXTURE_PROJECT_ID, {
      requestId: randomUUID(),
      workspaceRef: ref,
      expectedRevision: 1,
    });
  expect(receipt.state).toBe("authorized");
  const service = createScopeSettings(home, sources);
  const reviewed = async (): Promise<ScopeSave> => {
    const list = sources.list(FIXTURE_PROJECT_ID);
    const proofs = await Promise.all(
      list.workspaces.map((workspace) =>
        sources.preview(
          FIXTURE_PROJECT_ID,
          workspace.workspaceRef,
          list.catalogRevision,
          ["beta-epic"],
        ),
      ),
    );
    return scopeSaveSchema.parse({
      requestId: randomUUID(),
      expectedRevision: list.catalogRevision,
      controllerId: list.controllerId,
      workspaces: proofs.map((proof) => ({
        workspaceRef: proof.workspaceRef,
        epicIds: proof.epicIds,
        grantId: proof.grantId,
        sourceInstanceId: proof.instance.instanceId,
        trackerId: proof.instance.tracker.projectId,
        scopeCount: proof.scopeCount,
        scopeHash: proof.scopeHash,
      })),
    });
  };
  return {
    home,
    store,
    sources,
    service,
    ref,
    receipt,
    reviewed,
    hold: (value: Promise<void> | undefined) => {
      hold = value;
    },
    change: () => {
      changed = true;
    },
    live: (value: boolean) => {
      live = value;
    },
    reads: () => sourceReads,
  };
}
test("Scope Save persists every freshly reviewed workspace once, coalesces UUIDs and retains the exact original", async () => {
  const f = await fixture(),
    input = await f.reviewed(),
    before = f.store.read();
  const one = f.service.save(FIXTURE_PROJECT_ID, input),
    two = f.service.save(FIXTURE_PROJECT_ID, {
      ...input,
      workspaces: [...input.workspaces].reverse(),
    });
  expect(two).toBe(one);
  expect((await one).state).toBe("saved");
  const after = f.store.read();
  expect(after.revision).toBe(2);
  expect(
    after.projects[0]!.workspaces.map((workspace) => workspace.epicIds),
  ).toEqual([["beta-epic"], ["beta-epic"]]);
  expect(
    after.projects[0]!.workspaces.map((workspace) => [
      workspace.root,
      workspace.repositories,
    ]),
  ).toEqual(
    before.projects[0]!.workspaces.map((workspace) => [
      workspace.root,
      workspace.repositories,
    ]),
  );
  expect(f.service.original(FIXTURE_PROJECT_ID, input.requestId)).toEqual(
    await one,
  );
  expect(await f.service.save(FIXTURE_PROJECT_ID, input)).toEqual(await one);
  expect(f.store.read()).toEqual(after);
  expect(() =>
    f.service.save(FIXTURE_PROJECT_ID, { ...input, expectedRevision: 2 }),
  ).toThrow("already bound");
});
test("Scope Save refuses missing workspaces, duplicate tracker identities and empty epic selections", async () => {
  const f = await fixture(),
    input = await f.reviewed();
  expect(
    (
      await f.service.save(FIXTURE_PROJECT_ID, {
        ...input,
        workspaces: input.workspaces.slice(0, 1),
      })
    ).state,
  ).toBe("unavailable");
  expect(f.store.read().revision).toBe(1);
  expect(
    scopeSaveSchema.safeParse({
      ...input,
      workspaces: [input.workspaces[0], input.workspaces[0]],
    }).success,
  ).toBe(false);
  expect(
    scopeSaveSchema.safeParse({
      ...input,
      workspaces: input.workspaces.map((value) => ({ ...value, epicIds: [] })),
    }).success,
  ).toBe(false);
  const d = await fixture(true);
  expect(
    (await d.service.save(FIXTURE_PROJECT_ID, await d.reviewed())).reason,
  ).toContain("same tracker");
  expect(d.store.read().revision).toBe(1);
});
test("Scope Save refuses changed membership, stale catalog and revoked/unavailable sources without partial writes", async () => {
  for (const kind of ["membership", "catalog", "revoke", "unavailable"]) {
    const f = await fixture(),
      input = await f.reviewed();
    if (kind === "membership") f.change();
    if (kind === "catalog")
      await f.store.preferences(FIXTURE_PROJECT_ID, 1, { pinned: true });
    if (kind === "revoke")
      f.sources.revoke(FIXTURE_PROJECT_ID, f.ref, f.receipt.grantId!);
    if (kind === "unavailable") f.live(false);
    const before = f.store.read();
    expect((await f.service.save(FIXTURE_PROJECT_ID, input)).state).toBe(
      "unavailable",
    );
    expect(f.store.read()).toEqual(before);
  }
});
test("Scope Save pending originals do not wait or replay, and revocation/close fence a held final read", async () => {
  for (const close of [false, true]) {
    const f = await fixture(),
      input = await f.reviewed();
    let release!: () => void;
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const before = f.reads(),
      pending = f.service.save(FIXTURE_PROJECT_ID, input);
    const deadline = Date.now() + 1000;
    while (f.reads() === before && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(f.reads()).toBeGreaterThan(before);
    expect(f.service.original(FIXTURE_PROJECT_ID, input.requestId).state).toBe(
      "pending",
    );
    if (close) f.service.deactivate();
    else f.sources.revoke(FIXTURE_PROJECT_ID, f.ref, f.receipt.grantId!);
    f.hold(undefined);
    release();
    expect((await pending).state).toBe("unavailable");
    expect(f.store.read().revision).toBe(1);
  }
});
