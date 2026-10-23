import { expect, test } from "bun:test";
import { join } from "node:path";
import { createProjectShiftsClient } from "../../apps/desktop/src/project-shift-client";
import {
  createProjectShiftIdentities,
  PROJECT_SHIFT_IDENTITIES,
} from "../../apps/desktop/src/project-shift-identities";
import type { ProjectShiftReceipt } from "../../types/project-shifts";
import { projectShiftRequestHash } from "../shifts/registry";
import { sessionStartFixture } from "./session-start-fixture";

const scope = {
    projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
    workspace: "/fixture/workspace",
  },
  requestId = "2230bb02-1119-4c69-adad-c44116b375c1",
  shiftId = "shift-20261023-180000-1234",
  now = Date.parse("2026-10-23T18:00:00.000Z"),
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
function receipt(): ProjectShiftReceipt {
  const request = { ...structuredClone(input), requestId };
  return {
    intent: {
      ...scope,
      shiftId,
      request,
      requestHash: projectShiftRequestHash(
        scope.projectId,
        scope.workspace,
        request,
      ),
      createdAt: new Date(now).toISOString(),
      attemptedAt: new Date(now).toISOString(),
    },
    observation: {
      shiftId,
      requestId,
      phase: "unknown",
      reason: "Original outcome unknown",
      actual: null,
    },
  };
}
function actual(
  phase: "running" | "stopping" | "stopped" | "needs-recovery",
): ProjectShiftReceipt {
  const original = receipt();
  return {
    ...original,
    observation: {
      ...original.observation,
      phase,
      actual: {
        startedAt: new Date(now).toISOString(),
        endedAt:
          phase === "stopped" ? new Date(now + 1000).toISOString() : null,
        deadline: new Date(now + 7_200_000).toISOString(),
        concurrency: 2,
        forMs: 7_200_000,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 3,
        throttle: 0.85,
        base: "master",
        epic: null,
        smith: null,
        runTimeoutMs: null,
        spentUsd: 0,
        unpriced: 0,
        admitted: 0,
        reviewed: 0,
        running: 0,
        halted: 0,
      },
    },
  };
}
function fixture() {
  const store = sessionStartFixture(),
    posts: Array<{ path: string; body: unknown }> = [];
  let current: unknown = null,
    list: unknown[] = [],
    canWrite = true,
    body: unknown = null,
    respond: (() => Promise<Response>) | null = null,
    optionsAvailable = true;
  const options = {
    ...scope,
    catalogRevision: 7,
    asOf: new Date(now).toISOString(),
    defaults: {
      for: { value: "2h", source: "builtin" },
      concurrency: { value: 2, source: "builtin" },
      maxBeads: { value: 4, source: "builtin" },
      maxUsd: { value: 10, source: "builtin" },
      repairs: { value: 3, source: "builtin" },
      base: { value: "master", source: "shift CLI" },
      runTimeout: { value: null, source: "remaining shift time" },
    },
    limits: {
      durationMs: [1, 86_400_000],
      concurrency: [1, 8],
      maxBeads: [1, 100],
      maxUsd: 1000,
      repairs: [0, 10],
    },
    epics: [{ id: "alpha-epic", title: "Scoped epic" }],
    smiths: { names: ["claude-journeyman"], defaultSmith: "claude-journeyman" },
    availability: { start: true, reason: null },
  };
  const make = () =>
    createProjectShiftsClient({
      identities: createProjectShiftIdentities(store),
      canWrite: () => canWrite,
      mint: () => requestId,
      now: () => now,
      changed: () => {},
      read: async (path) => {
        if (path.endsWith("/options")) {
          if (!optionsAvailable) throw Error("Private config failure");
          return options;
        }
        if (path.includes("/requests/")) {
          if (current === null) throw Error("Protected404 before admission");
          return current;
        }
        return {
          projectId: scope.projectId,
          asOf: new Date(now).toISOString(),
          items: list,
        };
      },
      post: async (path, request) => {
        expect(store.storage.getItem(PROJECT_SHIFT_IDENTITIES)).toContain(
          requestId,
        );
        posts.push({ path, body: structuredClone(request) });
        body = request;
        if (respond) return respond();
        throw Error("Lost POST after possible persistence");
      },
    });
  return {
    store,
    posts,
    make,
    options,
    setOriginal: (value: unknown) => {
      current = value;
    },
    setList: (value: unknown[]) => {
      list = value;
    },
    setWrite: (value: boolean) => {
      canWrite = value;
    },
    setOptions: (value: boolean) => {
      optionsAvailable = value;
    },
    reply: (work: () => Promise<Response>) => {
      respond = work;
    },
    body: () => body,
  };
}

test("a held pre-admission POST survives another window and protected404 without a new identity or any replay", async () => {
  const f = fixture(),
    first = f.make();
  await first.refresh(scope);
  await first.loadOptions(scope);
  let entered = () => {},
    release = () => {};
  const entering = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.reply(async () => {
    entered();
    await held;
    f.setOriginal(receipt());
    throw Error("Lost original reply");
  });
  const starting = first.start(scope, input);
  await entering;
  const reload = f.make();
  await reload.refresh(scope);
  await reload.loadOptions(scope);
  expect(reload.get(scope).identity?.requestId).toBe(requestId);
  await reload.start(scope, {
    ...input,
    options: { ...input.options, maxBeads: 7 },
  });
  expect(f.posts).toHaveLength(1);
  expect(reload.get(scope).notice).toContain("original");
  release();
  await starting;
  await reload.check(scope);
  expect(reload.get(scope).original?.intent.request).toEqual({
    ...input,
    requestId,
  });
  expect(reload.get(scope).identity?.requestId).toBe(requestId);
  await reload.start(scope, input);
  expect(f.posts).toHaveLength(1);
  expect(f.body()).toEqual({ ...input, requestId });
  expect(f.store.storage.getItem(PROJECT_SHIFT_IDENTITIES)).not.toContain(
    "options",
  );
});

test("a full hash and original scope are required before adoption; only a verified stopped original releases its identity", async () => {
  const f = fixture(),
    client = f.make();
  await client.refresh(scope);
  await client.loadOptions(scope);
  await client.start(scope, input);
  const changed = receipt();
  changed.intent.request.options.maxBeads = 9;
  f.setOriginal(changed);
  await client.check(scope);
  expect(client.get(scope).original).toBeNull();
  expect(client.get(scope).identity?.requestId).toBe(requestId);
  f.setOriginal({
    ...receipt(),
    intent: { ...receipt().intent, workspace: "/foreign" },
  });
  await client.check(scope);
  expect(client.get(scope).original).toBeNull();
  f.setOriginal(actual("running"));
  await client.check(scope);
  expect(client.get(scope).original?.observation.phase).toBe("running");
  expect(client.get(scope).identity?.requestId).toBe(requestId);
  f.setOriginal(actual("stopped"));
  await client.check(scope);
  expect(client.get(scope).identity).toBeNull();
  expect(f.posts).toHaveLength(1);
});

test("Stop and Recover keep unknown outcomes until a protected original read and survive mutable configuration unavailability", async () => {
  const f = fixture(),
    client = f.make();
  await client.refresh(scope);
  await client.loadOptions(scope);
  await client.start(scope, input);
  f.setOriginal(actual("running"));
  f.setList([actual("running")]);
  await client.refresh(scope);
  f.setOptions(false);
  await client.loadOptions(scope);
  f.reply(async () => {
    f.setOriginal(actual("stopping"));
    throw Error("Lost Stop response");
  });
  await client.control(scope, requestId, "stop");
  expect(client.get(scope).pendingControl?.kind).toBe("stop");
  expect(client.get(scope).notice).toContain("original");
  await client.check(scope);
  expect(client.get(scope).original?.observation.phase).toBe("stopping");
  expect(client.get(scope).pendingControl).toBeNull();
  f.setOriginal(actual("needs-recovery"));
  await client.check(scope);
  f.reply(async () =>
    Response.json({ ok: true, data: actual("stopped"), error: null }),
  );
  await client.control(scope, requestId, "recover");
  expect(client.get(scope).identity).toBeNull();
  expect(f.posts.map((post) => post.path)).toEqual([
    `/__agent-forge/projects/${scope.projectId}/shifts`,
    `/__agent-forge/projects/${scope.projectId}/shifts/${shiftId}/stop`,
    `/__agent-forge/projects/${scope.projectId}/shifts/${shiftId}/recover`,
  ]);
});

test("Starting Stop uses the exact original, retains a lost result across reload, and releases only a verified startup settlement", async () => {
  const f = fixture(),
    client = f.make();
  await client.refresh(scope);
  await client.loadOptions(scope);
  await client.start(scope, input);
  const starting = receipt();
  starting.observation.phase = "starting";
  f.setOriginal(starting);
  await client.check(scope);
  const pending = structuredClone(starting);
  pending.intent.startupStop = {
    requestedAt: new Date(now + 100).toISOString(),
    completedAt: null,
  };
  pending.observation.phase = "stopping";
  f.reply(async () => {
    f.setOriginal(pending);
    throw Error("Lost startup Stop response");
  });
  await client.control(scope, requestId, "stop");
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]).toEqual({
    path: `/__agent-forge/projects/${scope.projectId}/shifts/${shiftId}/stop`,
    body: {},
  });
  expect(client.get(scope).pendingControl?.kind).toBe("stop");
  const reopened = f.make();
  await reopened.refresh(scope);
  expect(reopened.get(scope).identity?.requestId).toBe(requestId);
  expect(reopened.get(scope).original?.observation.phase).toBe("stopping");
  await reopened.control(scope, requestId, "stop");
  await reopened.start(scope, input);
  expect(f.posts).toHaveLength(2);
  const falseCompletion = structuredClone(starting);
  falseCompletion.observation.phase = "stopped";
  f.setOriginal(falseCompletion);
  await reopened.check(scope);
  expect(reopened.get(scope).identity?.requestId).toBe(requestId);
  expect(reopened.get(scope).original?.observation.phase).toBe("stopping");
  const completed = structuredClone(pending);
  if (!completed.intent.startupStop)
    throw Error("Missing startup Stop fixture");
  completed.intent.startupStop.completedAt = new Date(now + 200).toISOString();
  completed.observation.phase = "stopped";
  f.setOriginal(completed);
  await reopened.check(scope);
  expect(reopened.get(scope).identity).toBeNull();
  expect(reopened.get(scope).original?.observation.actual).toBeNull();
  expect(f.posts).toHaveLength(2);
});

test("stale or invalid reviewed options and unavailable identity storage refuse before POST, while foreign pages never replace scoped data", async () => {
  const f = fixture(),
    client = f.make();
  await client.refresh(scope);
  await client.loadOptions(scope);
  for (const bad of [
    { ...input, expectedCatalogRevision: 8 },
    { ...input, options: { ...input.options, base: "--unsafe" } },
    { ...input, options: { ...input.options, for: "25h" } },
  ])
    await client.start(scope, bad);
  expect(f.posts).toEqual([]);
  expect(f.store.storage.getItem(PROJECT_SHIFT_IDENTITIES)).toBeNull();
  f.store.storage.setItem(PROJECT_SHIFT_IDENTITIES, "{corrupt");
  await client.start(scope, input);
  expect(f.posts).toEqual([]);
  expect(f.store.storage.getItem(PROJECT_SHIFT_IDENTITIES)).toBe("{corrupt");
  const foreign = actual("running");
  foreign.intent.workspace = "/foreign";
  f.setList([foreign]);
  await client.refresh(scope);
  expect(client.get(scope).page?.items ?? []).toEqual([]);
  expect(client.get(scope).error).not.toBeNull();
});

test("a held background list cannot replace a newer explicit Start receipt", async () => {
  const store = sessionStartFixture();
  let release = (_value: unknown) => {},
    entered = () => {};
  const held = new Promise<unknown>((resolve) => {
      release = resolve;
    }),
    entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const f = fixture(),
    client = createProjectShiftsClient({
      identities: createProjectShiftIdentities(store),
      canWrite: () => true,
      mint: () => requestId,
      now: () => now,
      changed: () => {},
      read: async (path) => {
        if (path.endsWith("/options")) return f.options;
        if (path.includes("/requests/")) throw Error("Read held separately");
        entered();
        return held;
      },
      post: async () =>
        Response.json({ ok: true, data: actual("running"), error: null }),
    });
  await client.loadOptions(scope);
  const loading = client.refresh(scope);
  await entering;
  await client.start(scope, input);
  release({
    projectId: scope.projectId,
    asOf: new Date(now - 1000).toISOString(),
    items: [],
  });
  await loading;
  expect(
    client.get(scope).page?.items.map((row) => row.intent.request.requestId),
  ).toEqual([requestId]);
  expect(client.get(scope).original?.observation.phase).toBe("running");
});

test("a mismatched control receipt cannot settle the held original or clear an unknown action", async () => {
  const f = fixture(),
    client = f.make();
  await client.refresh(scope);
  await client.loadOptions(scope);
  await client.start(scope, input);
  f.setOriginal(actual("running"));
  await client.check(scope);
  const foreign = actual("stopped");
  foreign.intent.request.requestId = "8230bb02-1119-4c69-adad-c44116b375c1";
  foreign.intent.requestHash = projectShiftRequestHash(
    scope.projectId,
    scope.workspace,
    foreign.intent.request,
  );
  foreign.observation.requestId = foreign.intent.request.requestId;
  f.reply(async () => Response.json({ ok: true, data: foreign, error: null }));
  await client.control(scope, requestId, "stop");
  expect(client.get(scope).identity?.requestId).toBe(requestId);
  expect(client.get(scope).original?.observation.phase).toBe("running");
  expect(client.get(scope).pendingControl?.kind).toBe("stop");
});

test("the shift coordinator imports no filesystem, native launcher or private store into the browser", async () => {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "../../apps/desktop/src/project-shift-client.ts"),
    ],
    target: "browser",
  });
  expect(built.success).toBe(true);
  const text = await built.outputs[0]?.text();
  for (const forbidden of [
    "node:fs",
    "bun:sqlite",
    "createProjectShiftRegistry",
    "runExec",
    "createOwnedProjectShiftLauncher",
  ])
    expect(text).not.toContain(forbidden);
});
