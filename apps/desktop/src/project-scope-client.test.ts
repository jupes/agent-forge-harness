import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { NotSent } from "../../../docs/js/operator";
import {
  type SourceAuthorizationReceipt,
  type SourceList,
  sourceAuthorizeSchema,
} from "../../../scripts/projects/connected-source-protocol";
import {
  canonicalScopeSave,
  scopeSaveSchema,
} from "../../../scripts/projects/scope-settings-protocol";
import { FIXTURE_PROJECT_ID } from "../../../scripts/projects/testing";
import { ProjectScopeOwner, scopeAggregate } from "./project-scope-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const controller = randomUUID(),
    localRef = "a".repeat(64),
    remoteRef = "b".repeat(64);
  let stored: unknown = null,
    lost = false,
    notSent = false,
    malformed = false,
    duplicate = false,
    readHold: Promise<void> | undefined;
  const list: SourceList = {
    projectId: FIXTURE_PROJECT_ID,
    catalogRevision: 1,
    controllerId: controller,
    nativeAuthorizationAvailable: true,
    remainingAuthorizationRequests: 64,
    workspaces: [
      {
        workspaceRef: localRef,
        root: "/local",
        epicIds: ["alpha-epic"],
        authority: "served",
        grantId: controller,
      },
      {
        workspaceRef: remoteRef,
        root: "/remote",
        epicIds: ["alpha-epic"],
        authority: "not-authorized",
        grantId: null,
      },
    ],
  };
  const posts: Array<{ path: string; body: unknown }> = [],
    reads: string[] = [],
    authorizations = new Map<string, SourceAuthorizationReceipt>(),
    saves = new Map<string, unknown>();
  const instanceIds = [randomUUID(), randomUUID()];
  const deps = {
    read: async (path: string, signal?: AbortSignal): Promise<unknown> => {
      reads.push(path);
      await readHold;
      if (signal?.aborted) throw Error("aborted");
      if (path.endsWith("/settings/sources")) return structuredClone(list);
      if (path.includes("/settings/scope/requests/")) {
        const value = saves.get(path.split("/").at(-1)!);
        if (!value) throw Error("404");
        return structuredClone(value);
      }
      if (path.includes("/requests/")) {
        const value = authorizations.get(path.split("/").at(-1)!);
        if (!value) throw Error("404");
        return structuredClone(value);
      }
      if (path.includes("/preview?")) {
        const ref = path.split("/").at(-2)!,
          index = list.workspaces.findIndex((row) => row.workspaceRef === ref),
          row = list.workspaces[index]!;
        if (!row.grantId) throw Error("unauthorized");
        const epicIds = new URL("http://fixture" + path).searchParams
          .getAll("epicId")
          .sort();
        return {
          projectId: FIXTURE_PROJECT_ID,
          catalogRevision: list.catalogRevision,
          workspaceRef: ref,
          grantId: row.grantId,
          epicIds,
          scopeCount: epicIds.includes("beta-epic") ? 2 : 1,
          scopeHash: "c".repeat(64),
          sourceAsOf: "2026-11-09T00:00:00Z",
          epics: [
            { id: "alpha-epic", title: "Alpha" },
            { id: "beta-epic", title: "Beta" },
          ],
          instance: {
            version: 1,
            instanceId: instanceIds[index],
            pid: 123,
            root: row.root,
            tracker: {
              database: "fixture",
              projectId:
                index === 0 || duplicate
                  ? "11111111-1111-4111-8111-111111111111"
                  : "22222222-2222-4222-8222-222222222222",
            },
          },
        };
      }
      throw Error("Unexpected read");
    },
    post: async (path: string, body: unknown): Promise<unknown> => {
      if (notSent) throw new NotSent("No token");
      posts.push({ path, body: structuredClone(body) });
      let result: unknown;
      if (path.endsWith("/authorize")) {
        const request = sourceAuthorizeSchema.parse(body),
          row = list.workspaces.find(
            (row) => row.workspaceRef === request.workspaceRef,
          )!;
        row.authority = "authorized";
        row.grantId = randomUUID();
        const receipt: SourceAuthorizationReceipt = {
          projectId: FIXTURE_PROJECT_ID,
          requestId: request.requestId,
          workspaceRef: request.workspaceRef,
          state: "authorized",
          grantId: row.grantId,
          reason: null,
        };
        authorizations.set(request.requestId, receipt);
        result = receipt;
      } else if (path.endsWith("/settings/scope")) {
        const request = canonicalScopeSave(scopeSaveSchema.parse(body));
        list.catalogRevision++;
        for (const selected of request.workspaces)
          list.workspaces.find(
            (row) => row.workspaceRef === selected.workspaceRef,
          )!.epicIds = selected.epicIds;
        const receipt = {
          projectId: FIXTURE_PROJECT_ID,
          requestId: request.requestId,
          controllerId: request.controllerId,
          inputHash: createHash("sha256")
            .update(JSON.stringify(request))
            .digest("hex"),
          state: "saved",
          catalogRevision: list.catalogRevision,
          reason: null,
        };
        saves.set(request.requestId, receipt);
        result = receipt;
      } else if (path.endsWith("/revoke")) {
        const row = list.workspaces.find((row) =>
            path.includes(row.workspaceRef),
          )!,
          grantId = row.grantId;
        row.authority = "not-authorized";
        row.grantId = null;
        result = {
          projectId: FIXTURE_PROJECT_ID,
          workspaceRef: row.workspaceRef,
          grantId,
          state: "revoked",
        };
      } else throw Error("Unexpected action");
      if (lost) throw Error("lost reply");
      return malformed ? { wrong: true } : structuredClone(result);
    },
    readPending: () => structuredClone(stored),
    writePending: (value: unknown) => {
      stored = structuredClone(value);
    },
    refreshHome: async () => undefined,
  };
  const owner = new ProjectScopeOwner(FIXTURE_PROJECT_ID, deps);
  owner.observeRevision(1);
  owner.setEnabled(true);
  return {
    owner,
    list,
    posts,
    reads,
    localRef,
    remoteRef,
    deps,
    stored: () => stored,
    lost: (value: boolean) => {
      lost = value;
    },
    notSent: (value: boolean) => {
      notSent = value;
    },
    malformed: (value: boolean) => {
      malformed = value;
    },
    duplicate: () => {
      duplicate = true;
    },
    hold: (value: Promise<void> | undefined) => {
      readHold = value;
    },
  };
}
async function reviewed() {
  const f = fixture();
  await f.owner.load();
  await f.owner.authorize(f.remoteRef);
  await f.owner.preview();
  expect(f.owner.canSave()).toBe(true);
  return f;
}
test("Scope client stays unknown until every explicitly authorized workspace has a complete matching preview", async () => {
  const f = fixture();
  await f.owner.load();
  expect(f.posts).toHaveLength(0);
  expect(scopeAggregate(f.owner.snapshot()).count).toBe(null);
  await f.owner.preview();
  expect(scopeAggregate(f.owner.snapshot()).count).toBe(null);
  expect(f.posts).toHaveLength(0);
  await f.owner.authorize(f.remoteRef);
  await f.owner.preview();
  expect(f.posts).toHaveLength(1);
  expect(scopeAggregate(f.owner.snapshot()).count).toBe(2);
  f.owner.edit(f.localRef, ["beta-epic"]);
  expect(f.owner.canSave()).toBe(false);
  await f.owner.preview();
  expect(scopeAggregate(f.owner.snapshot()).count).toBe(3);
  f.owner.edit(f.remoteRef, []);
  expect(f.owner.canSave()).toBe(false);
  await f.owner.preview();
  expect(f.owner.canSave()).toBe(false);
});
test("Scope client refuses duplicate tracker totals and stale catalog or disconnected preview publication", async () => {
  const f = await reviewed();
  f.duplicate();
  await f.owner.preview();
  expect(scopeAggregate(f.owner.snapshot()).count).toBe(null);
  expect(f.owner.canSave()).toBe(false);
  f.owner.observeRevision(2);
  expect(f.owner.canChange()).toBe(false);
  expect(scopeAggregate(f.owner.snapshot()).count).toBe(null);
  const g = await reviewed(),
    held = deferred<void>();
  g.hold(held.promise);
  const pending = g.owner.preview();
  g.owner.setEnabled(false);
  g.owner.setEnabled(true);
  g.hold(undefined);
  held.resolve();
  await pending;
  expect(scopeAggregate(g.owner.snapshot()).count).toBe(null);
  expect(g.owner.canSave()).toBe(false);
});
test("lost authorization reply persists across remount; exact recovery reads never open another chooser", async () => {
  const f = fixture();
  await f.owner.load();
  f.lost(true);
  await f.owner.authorize(f.remoteRef);
  expect(f.stored()).not.toBe(null);
  await f.owner.authorize(f.remoteRef);
  expect(f.posts).toHaveLength(1);
  f.owner.dispose();
  const replacement = new ProjectScopeOwner(FIXTURE_PROJECT_ID, f.deps);
  replacement.observeRevision(1);
  replacement.setEnabled(true);
  await replacement.load();
  expect(replacement.canChange()).toBe(false);
  await replacement.check();
  expect(f.posts).toHaveLength(1);
  expect(replacement.snapshot().pending).toBe(null);
  expect(f.stored()).toBe(null);
  expect(replacement.canSave()).toBe(false);
  expect(replacement.snapshot().notice).toContain("authorized for this launch");
});
test("lost Scope Save is held and exact original recovery confirms without reposting", async () => {
  const f = await reviewed();
  f.owner.edit(f.localRef, ["beta-epic"]);
  await f.owner.preview();
  f.lost(true);
  await f.owner.save();
  expect(f.posts).toHaveLength(2);
  expect(f.owner.snapshot().pending?.kind).toBe("save");
  await f.owner.save();
  expect(f.posts).toHaveLength(2);
  await f.owner.check();
  expect(f.posts).toHaveLength(2);
  expect(f.owner.snapshot().pending).toBe(null);
  expect(f.owner.snapshot().notice).toContain(
    "confirmed at catalog revision 2",
  );
  expect(f.owner.snapshot().list!.workspaces[0]!.epicIds).toEqual([
    "beta-epic",
  ]);
  expect(f.owner.canSave()).toBe(false);
});
test("404 and matching current Scope never confirm an old original after receiving Hearth restart", async () => {
  const f = await reviewed();
  f.malformed(true);
  await f.owner.save();
  expect(f.owner.snapshot().pending?.kind).toBe("save");
  f.list.controllerId = randomUUID();
  f.list.workspaces[0]!.grantId = f.list.controllerId;
  f.list.workspaces[1]!.authority = "not-authorized";
  f.list.workspaces[1]!.grantId = null;
  const oldRead = f.deps.read;
  f.deps.read = async (path, signal) => {
    if (path.includes("/requests/")) throw Error("404");
    return oldRead(path, signal);
  };
  await f.owner.load();
  await f.owner.check();
  expect(f.owner.snapshot().pending?.kind).toBe("save");
  expect(f.owner.canSave()).toBe(false);
  f.owner.reviewNewController();
  expect(f.owner.snapshot().pending).toBe(null);
  expect(f.owner.snapshot().notice).toContain(
    "original delivery remains unknown",
  );
  expect(f.owner.snapshot().notice).not.toContain("confirmed");
  expect(f.posts).toHaveLength(2);
  expect(f.owner.canSave()).toBe(false);
});
test("known NotSent and corrupt pending metadata cannot issue or repeat an action", async () => {
  const f = await reviewed();
  f.notSent(true);
  await f.owner.save();
  expect(f.posts).toHaveLength(1);
  expect(f.owner.snapshot().pending).toBe(null);
  expect(f.owner.snapshot().notice).toContain("was not sent");
  const blocked = new ProjectScopeOwner(FIXTURE_PROJECT_ID, {
    ...f.deps,
    readPending: () => ({ bad: true }),
  });
  blocked.observeRevision(1);
  blocked.setEnabled(true);
  await blocked.load();
  await blocked.authorize(f.remoteRef);
  expect(blocked.snapshot().storageError).toBe(true);
  expect(f.posts).toHaveLength(1);
});

test("a catalog revision change permanently fences a held preview and archived projects retain read-only original recovery", async () => {
  const f = await reviewed(),
    held = deferred<void>();
  f.hold(held.promise);
  const read = f.owner.preview();
  f.owner.observeRevision(2);
  f.hold(undefined);
  held.resolve();
  await read;
  expect(scopeAggregate(f.owner.snapshot()).count).toBe(null);
  expect(f.owner.snapshot().previews).toEqual({});
  const g = await reviewed();
  g.lost(true);
  await g.owner.save();
  g.owner.setArchived(true);
  await g.owner.check();
  expect(g.owner.snapshot().pending).toBe(null);
  expect(g.owner.snapshot().notice).toContain(
    "confirmed at catalog revision 2",
  );
  expect(g.owner.canChange()).toBe(false);
  expect(g.posts).toHaveLength(2);
});
