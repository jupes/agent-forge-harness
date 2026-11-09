import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  KeeperBriefCard,
  KeeperScheduleStatusView,
} from "../../apps/desktop/src/KeeperBrief";
import type {
  KeeperScheduleContext,
  KeeperScheduleSource,
} from "../../apps/desktop/src/keeper-client";
import { createKeeperClient } from "../../apps/desktop/src/keeper-client";
import { ProjectKeeperSettings } from "../../apps/desktop/src/ProjectKeeperSettings";
import { ProjectSettings } from "../../apps/desktop/src/ProjectSettings";
import { projectBudgetsSpec } from "../../apps/desktop/src/project-budgets-client";
import { createProjectCreateApi } from "../../apps/desktop/src/project-create-api";
import { ProjectDefaultsSettingsOwner } from "../../apps/desktop/src/project-defaults-client";
import { ProjectGeneralSettingsOwner } from "../../apps/desktop/src/project-general-settings-client";
import { ProjectKeeperSettingsOwner } from "../../apps/desktop/src/project-keeper-settings-client";
import { projectNotificationsSpec } from "../../apps/desktop/src/project-notifications-client";
import { ProjectValueSettingsOwner } from "../../apps/desktop/src/project-value-settings-client";
import { openProject } from "../../apps/desktop/src/projects-model";
import {
  bindKeeperScheduleSources,
  readKeeperSchedule,
} from "../../apps/desktop/src/use-keeper";
import { actionOutcome } from "../../docs/js/action-outcome";
import {
  createOperatorClient,
  NotSent,
  type OperatorPost,
} from "../../docs/js/operator";
import type { StreamHandlers } from "../../docs/js/use-stream";
import { fetchTransport } from "../../docs/js/use-stream";
import type { KeeperScheduleStatus } from "../../types/keeper-brief";
import { createConversationStore } from "../conversations/store";
import type { ConversationTransport } from "../conversations/transport";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";
import type { KeeperScheduleClock } from "../hearth/keeper-brief-scheduler";
import { TOKEN_ROUTE } from "../hearth/paths";
import { startTestHearth } from "../hearth/testing";
import { keeperBriefs } from "../keeper/brief-model";
import {
  keeperBriefIntentMetadataSchema,
  keeperBriefIntentOriginalSchema,
  keeperScheduleStatusSchema,
} from "../keeper/brief-protocol";
import type {
  KeeperScheduleInput,
  KeeperScheduleSaved,
} from "../keeper/brief-schedule";
import { keeperScheduleWindow } from "../keeper/brief-schedule";
import { keeperReadiness } from "../keeper/readiness";
import { projectKeeperMutationWithScheduleRequestSchema } from "../projects/project-keeper-protocol";
import { createProjectStore } from "../projects/store";
import {
  FIXTURE_PROJECT_ID as id,
  projectCatalogFixture,
} from "../projects/testing";

const firstTime = "2026-11-08T09:00:00.000Z",
  laterTime = "2026-11-09T09:00:00.000Z";
const daily = (
  atUtc = "09:30",
  generation: string = randomUUID(),
  activatedAt = firstTime,
): KeeperScheduleSaved => ({ kind: "daily", atUtc, generation, activatedAt });
function catalog(
  revision: number,
  fields: Record<string, unknown> = {},
): unknown {
  const value = projectCatalogFixture("/served");
  return {
    ...value,
    revision,
    projects: value.projects.map((project) => ({
      ...project,
      keeperSmith: "saved-smith",
      keeperAutonomy: "suggest-only",
      keeperVisibility: "project-metadata",
      updatedAt: firstTime,
      ...fields,
    })),
  };
}
function deferred() {
  let release: () => void = () => {};
  const wait = new Promise<void>((done) => {
    release = done;
  });
  return { wait, release };
}
function fixture(
  initial: unknown = catalog(1),
  restored: Record<string, number> = {},
) {
  let current = initial,
    pending = { ...restored };
  let readHook: (() => Promise<unknown>) | undefined,
    postHook: OperatorPost | undefined;
  let failWriteAt = 0;
  const calls = {
    reads: 0,
    posts: [] as Array<{ path: string; body: unknown }>,
    writes: 0,
    home: 0,
  };
  const dependencies = {
    read: async () => {
      calls.reads++;
      return readHook ? readHook() : current;
    },
    post: (async (path, body) => {
      calls.posts.push({ path, body });
      if (!postHook) throw Error("Lost fixture response");
      return postHook(path, body);
    }) satisfies OperatorPost,
    readPending: () => ({ ...pending }),
    writePending: (next: Record<string, number>) => {
      calls.writes++;
      if (calls.writes === failWriteAt) throw Error("Storage unavailable");
      pending = { ...next };
    },
    refreshHome: async () => {
      calls.home++;
    },
  };
  const owner = new ProjectKeeperSettingsOwner(dependencies);
  owner.adopt(id, current);
  return {
    owner,
    calls,
    dependencies,
    state: () => {
      const value = owner.snapshot().projects[id];
      if (!value) throw Error("Missing owner project");
      return value;
    },
    pending: () => ({ ...pending }),
    current: (next: unknown) => {
      current = next;
    },
    read: (next: () => Promise<unknown>) => {
      readHook = next;
    },
    post: (next: OperatorPost) => {
      postHook = next;
    },
    failStorage: (at: number) => {
      failWriteAt = at;
    },
    accept: (next: unknown) => {
      current = next;
      return Response.json({ ok: true, data: next, error: null });
    },
  };
}

test("Keeper schedule owner distinguishes raw defaults and owns only valid semantic drafts without I/O", async () => {
  const f = fixture(),
    saved = daily();
  expect(Object.hasOwn(f.state().catalog ?? {}, "keeperSchedule")).toBe(false);
  const draft = { kind: "daily" as const, atUtc: "10:15" };
  f.owner.setScheduleDraft(id, draft);
  draft.atUtc = "12:00";
  f.owner.adopt(id, catalog(1, { keeperSchedule: { kind: "off" } }));
  expect(f.state().needsReview).toBe(true);
  expect(f.state().catalog?.keeperSchedule).toEqual({ kind: "off" });
  expect(f.state().scheduleDraft).toEqual({ kind: "daily", atUtc: "10:15" });
  f.owner.adopt(id, catalog(2, { keeperSchedule: saved }));
  expect(f.state().catalog?.keeperSchedule).toEqual(saved);
  f.owner.adopt(
    id,
    catalog(3, { keeperSchedule: { kind: "daily", atUtc: "10:15" } }),
  );
  expect(f.state().catalog?.keeperSchedule).toEqual(saved);
  expect(f.state().checked).toBe(false);
  const bad = { kind: "off" as const, generation: randomUUID() };
  f.owner.setScheduleDraft(id, bad);
  expect(f.state().scheduleDraft).toEqual({ kind: "daily", atUtc: "10:15" });
  await f.owner.saveSchedule(id);
  expect(f.calls).toEqual({ reads: 0, posts: [], writes: 0, home: 0 });
  const invalidOnly = fixture();
  invalidOnly.owner.setScheduleDraft(id, bad);
  await invalidOnly.owner.saveSchedule(id);
  expect(invalidOnly.state().scheduleDraft).toBeNull();
  expect(invalidOnly.calls.posts).toEqual([]);
});

test("Keeper schedule strict saves verify enable, no-op, change, off and re-enable server transitions", async () => {
  const original = daily(),
    changed = daily("10:15"),
    reenabled = daily("09:30");
  const rows: Array<{
    before?: KeeperScheduleSaved;
    input: KeeperScheduleInput;
    after: KeeperScheduleSaved;
    updatedAt: string;
  }> = [
    {
      input: { kind: "daily", atUtc: "09:30" },
      after: original,
      updatedAt: firstTime,
    },
    {
      before: original,
      input: { kind: "daily", atUtc: "09:30" },
      after: original,
      updatedAt: laterTime,
    },
    {
      before: original,
      input: { kind: "daily", atUtc: "10:15" },
      after: changed,
      updatedAt: firstTime,
    },
    {
      before: original,
      input: { kind: "off" },
      after: { kind: "off" },
      updatedAt: laterTime,
    },
    {
      before: { kind: "off" },
      input: { kind: "daily", atUtc: "09:30" },
      after: reenabled,
      updatedAt: firstTime,
    },
  ];
  for (const row of rows) {
    const f = fixture(
      catalog(1, row.before ? { keeperSchedule: row.before } : {}),
    );
    f.owner.setDraft(id, "unsaved-smith");
    f.owner.setAutonomyDraft(id, "propose-for-approval");
    f.owner.setVisibilityDraft(id, "conversation-only");
    f.owner.setScheduleDraft(id, row.input);
    f.post(async () =>
      f.accept(
        catalog(2, { keeperSchedule: row.after, updatedAt: row.updatedAt }),
      ),
    );
    await f.owner.saveSchedule(id);
    expect(f.calls.posts).toEqual([
      {
        path: "/__agent-forge/projects/" + id + "/settings/keeper",
        body: {
          expectedRevision: 1,
          kind: "schedule",
          keeperSchedule: row.input,
        },
      },
    ]);
    expect(
      projectKeeperMutationWithScheduleRequestSchema.parse(
        f.calls.posts[0]?.body,
      ),
    ).toEqual({
      expectedRevision: 1,
      kind: "schedule",
      keeperSchedule: row.input,
    });
    expect(f.state()).toMatchObject({
      catalog: {
        revision: 2,
        keeperSmith: "saved-smith",
        keeperAutonomy: "suggest-only",
        keeperVisibility: "project-metadata",
        keeperSchedule: row.after,
      },
      draft: "unsaved-smith",
      autonomyDraft: "propose-for-approval",
      visibilityDraft: "conversation-only",
      scheduleDraft: null,
      needsReview: false,
    });
    expect(f.pending()).toEqual({});
    expect(f.calls.reads).toBe(2);
  }
});

test("Keeper schedule receipts reject missing stamps, forged transitions and unrelated field drift as unknown", async () => {
  const old = daily(),
    input: KeeperScheduleInput = { kind: "daily", atUtc: "10:15" };
  if (old.kind !== "daily") throw Error("Missing daily fixture");
  const rows = [
    {},
    { keeperSchedule: { kind: "daily", atUtc: "10:15" } },
    { keeperSchedule: { ...old, atUtc: "10:15" } },
    { keeperSchedule: daily("10:15"), updatedAt: laterTime },
    { keeperSchedule: daily("11:00") },
    { keeperSchedule: daily("10:15"), keeperSmith: "wrong-smith" },
    { keeperSchedule: { kind: "off", activatedAt: firstTime } },
  ];
  for (const fields of rows) {
    const f = fixture(catalog(1, { keeperSchedule: old }));
    f.owner.setScheduleDraft(id, input);
    f.post(async () =>
      Response.json({ ok: true, data: catalog(2, fields), error: null }),
    );
    await f.owner.saveSchedule(id);
    expect(f.calls.posts).toHaveLength(1);
    expect(f.pending()).toEqual({ [id]: 1 });
    expect(f.state().message).toContain("unknown");
    expect(f.state().needsReview).toBe(true);
    expect(f.state().scheduleDraft).toEqual(input);
    expect(f.state().catalog?.revision).toBe(1);
  }
  for (const after of [daily(), daily("09:30", old.generation, laterTime)]) {
    const f = fixture(catalog(1, { keeperSchedule: old }));
    f.owner.setScheduleDraft(id, { kind: "daily", atUtc: "09:30" });
    f.post(async () => f.accept(catalog(2, { keeperSchedule: after })));
    await f.owner.saveSchedule(id);
    expect(f.state().message).toContain("unknown");
    expect(f.pending()).toEqual({ [id]: 1 });
  }
});

test("Keeper schedule raw preflight drift refuses POST and legacy arms preserve schedule plus its draft", async () => {
  const saved = daily();
  const stale = fixture();
  stale.owner.setScheduleDraft(id, { kind: "off" });
  stale.current(catalog(1, { keeperSchedule: { kind: "off" } }));
  await stale.owner.saveSchedule(id);
  expect(stale.calls.posts).toEqual([]);
  expect(stale.state().needsReview).toBe(true);
  for (const kind of ["keeper", "visibility"] as const) {
    const f = fixture(catalog(1, { keeperSchedule: saved }));
    f.owner.setScheduleDraft(id, { kind: "off" });
    f.owner.setDraft(id, "new-smith");
    f.owner.setVisibilityDraft(id, "conversation-only");
    f.post(async () =>
      f.accept(
        catalog(2, {
          keeperSchedule: saved,
          ...(kind === "keeper"
            ? { keeperSmith: "new-smith" }
            : { keeperVisibility: "conversation-only" }),
        }),
      ),
    );
    await (kind === "keeper" ? f.owner.save(id) : f.owner.saveVisibility(id));
    expect(f.state().catalog?.keeperSchedule).toEqual(saved);
    expect(f.state().scheduleDraft).toEqual({ kind: "off" });
    expect(f.state().needsReview).toBe(false);
    expect(f.calls.posts[0]?.body).toEqual(
      kind === "keeper"
        ? { expectedRevision: 1, keeper: { keeperSmith: "new-smith" } }
        : {
            expectedRevision: 1,
            kind: "visibility",
            keeperVisibility: "conversation-only",
          },
    );
  }
});

test("Keeper schedule busy and accepted-readback drift preserve newer evidence and every unrelated draft", async () => {
  for (const staleReadback of [false, true]) {
    const f = fixture(),
      entered = deferred(),
      release = deferred();
    f.owner.setScheduleDraft(id, { kind: "off" });
    f.owner.setVisibilityDraft(id, "conversation-only");
    f.post(async () => {
      entered.release();
      await release.wait;
      return Response.json({
        ok: true,
        data: catalog(2, { keeperSchedule: { kind: "off" } }),
        error: null,
      });
    });
    const saving = f.owner.saveSchedule(id);
    try {
      await entered.wait;
      expect(f.owner.snapshot().busy).toBe(id);
      f.owner.setScheduleDraft(id, { kind: "daily", atUtc: "01:00" });
      f.owner.setDraft(id, "ignored-busy");
      await f.owner.saveVisibility(id);
      const latest = catalog(3, { keeperSchedule: daily() });
      f.current(
        staleReadback
          ? catalog(2, { keeperSchedule: { kind: "off" } })
          : latest,
      );
      f.owner.adopt(id, latest);
      release.release();
      await saving;
      expect(f.calls.posts).toHaveLength(1);
      expect(f.state().catalog?.revision).toBe(3);
      expect(f.state().scheduleDraft).toEqual({ kind: "off" });
      expect(f.state().visibilityDraft).toBe("conversation-only");
      expect(f.state().draft).toBeNull();
      expect(f.state().needsReview).toBe(true);
      expect(f.owner.snapshot().busy).toBeNull();
    } finally {
      release.release();
      await saving;
    }
  }
});

test("Keeper schedule lost and malformed answers restore unknown state before deliberate cross-arm same-revision CAS", async () => {
  for (const lost of [true, false]) {
    const f = fixture();
    f.owner.setScheduleDraft(id, { kind: "off" });
    if (!lost) f.post(async () => new Response("broken", { status: 200 }));
    await f.owner.saveSchedule(id);
    expect(f.state().message).toContain("unknown");
    expect(f.pending()).toEqual({ [id]: 1 });
    const restarted = new ProjectKeeperSettingsOwner(f.dependencies);
    restarted.adopt(id, catalog(1));
    expect(restarted.snapshot().projects[id]?.scheduleDraft).toBeNull();
    expect(restarted.snapshot().projects[id]?.needsReview).toBe(true);
    restarted.setVisibilityDraft(id, "conversation-only");
    await restarted.saveVisibility(id);
    expect(f.calls.posts).toHaveLength(1);
    await restarted.review(id);
    expect(restarted.snapshot().projects[id]?.message).toContain(
      "proves current state only",
    );
    expect(f.pending()).toEqual({ [id]: 1 });
    restarted.confirmReview(id);
    f.post(async () =>
      f.accept(catalog(2, { keeperVisibility: "conversation-only" })),
    );
    await restarted.saveVisibility(id);
    expect(f.calls.posts).toHaveLength(2);
    expect(f.calls.posts[1]?.body).toEqual({
      expectedRevision: 1,
      kind: "visibility",
      keeperVisibility: "conversation-only",
    });
    expect(f.pending()).toEqual({});
    expect(restarted.snapshot().projects[id]?.needsReview).toBe(false);
  }
});

test("Keeper schedule NotSent and refusal retain older pending evidence in either cross-arm direction", async () => {
  for (const older of ["schedule", "visibility", "keeper"] as const) {
    for (const response of ["not-sent", "refused"] as const) {
      const f = fixture();
      f.owner.setScheduleDraft(id, { kind: "off" });
      f.owner.setVisibilityDraft(id, "conversation-only");
      if (older === "keeper") f.owner.setDraft(id, "new-smith");
      await (older === "schedule"
        ? f.owner.saveSchedule(id)
        : older === "visibility"
          ? f.owner.saveVisibility(id)
          : f.owner.save(id));
      expect(f.pending()).toEqual({ [id]: 1 });
      await f.owner.review(id);
      f.owner.confirmReview(id);
      f.post(async () => {
        if (response === "not-sent") throw new NotSent("Nothing sent");
        return new Response(null, { status: 409 });
      });
      await (older === "schedule"
        ? f.owner.saveVisibility(id)
        : f.owner.saveSchedule(id));
      expect(f.pending()).toEqual({ [id]: 1 });
      expect(f.state().needsReview).toBe(true);
      expect(f.state().scheduleDraft).toEqual({ kind: "off" });
      expect(f.state().visibilityDraft).toBe("conversation-only");
      expect(f.calls.posts).toHaveLength(2);
    }
  }
});

test("Keeper schedule accepted storage or readback failures stay accepted and retain draft/review", async () => {
  for (const failure of ["storage", "readback"] as const) {
    const f = fixture();
    f.owner.setScheduleDraft(id, { kind: "off" });
    f.post(async () => {
      const next = catalog(2, { keeperSchedule: { kind: "off" } });
      if (failure === "readback")
        f.read(async () => {
          throw Error("Unavailable readback");
        });
      return f.accept(next);
    });
    if (failure === "storage") f.failStorage(2);
    await f.owner.saveSchedule(id);
    expect(f.state().message).toContain("Save accepted at revision 2");
    expect(f.state().message).not.toContain("outcome is unknown");
    expect(f.state().needsReview).toBe(true);
    expect(f.state().scheduleDraft).toEqual({ kind: "off" });
    expect(f.calls.posts).toHaveLength(1);
  }
  const foreign = "project-00000000-0000-4000-8000-000000000000";
  const f = fixture(catalog(1), { [foreign]: 1 });
  f.owner.setScheduleDraft(id, { kind: "off" });
  await f.owner.saveSchedule(id);
  expect(f.calls.posts).toEqual([]);
  expect(f.state().message).toContain("other project");
  const blocked = fixture();
  blocked.failStorage(1);
  blocked.owner.setScheduleDraft(id, { kind: "off" });
  await blocked.owner.saveSchedule(id);
  expect(blocked.calls.posts).toEqual([]);
  expect(blocked.state().message).toContain("not sent");
  const recovery = new ProjectKeeperSettingsOwner({
    read: async () => catalog(1),
    post: async () => {
      throw Error("Storage hold must block POST");
    },
    readPending: () => {
      throw Error("Restoration unavailable");
    },
  });
  recovery.adopt(id, catalog(1));
  recovery.setScheduleDraft(id, { kind: "off" });
  await recovery.saveSchedule(id);
  expect(recovery.writesBlocked(id)).toBe(true);
  expect(recovery.snapshot().projects[id]?.message).toContain(
    "could not be restored",
  );
});

test("Keeper schedule retains incomplete daily edits instead of saving an older valid time", async () => {
  const f = fixture();
  f.owner.setScheduleDraft(id, { kind: "daily", atUtc: "09:30" });
  for (const atUtc of ["", "09:", "24:00", "invalid"]) {
    f.owner.setScheduleDraft(id, { kind: "daily", atUtc });
    expect(f.state().scheduleDraft).toEqual({ kind: "daily", atUtc });
    await f.owner.saveSchedule(id);
    expect(f.calls.posts).toEqual([]);
    expect(f.state().scheduleDraft).toEqual({ kind: "daily", atUtc });
    expect(f.state().message).toContain("valid daily UTC schedule");
  }
  f.owner.setScheduleDraft(id, { kind: "daily", atUtc: "10:15" });
  const saved = daily("10:15");
  f.post(async () => f.accept(catalog(2, { keeperSchedule: saved })));
  await f.owner.saveSchedule(id);
  expect(f.calls.posts).toHaveLength(1);
  expect(f.calls.posts[0]?.body).toEqual({
    expectedRevision: 1,
    kind: "schedule",
    keeperSchedule: { kind: "daily", atUtc: "10:15" },
  });
  expect(f.state().catalog?.keeperSchedule).toEqual(saved);
  expect(f.state().scheduleDraft).toBeNull();
});

test("Keeper schedule legacy discovery cannot replace an unresolved reviewed exact original", async () => {
  const x = keeperBriefIntentOriginalSchema.parse({
    version: 1,
    requestId: randomUUID(),
    projectId: id,
    conversationId: "keeper-" + id,
    expectedRevision: 0,
    origin: {
      kind: "overview",
      projectId: id,
      workspace: "/served",
      catalogRevision: 1,
    },
    selection: {
      name: "fixture",
      provider: "claude",
      model: "fixture",
      effort: "",
      enabled: true,
      tags: [],
    },
    purpose: "brief",
    intentHash: "a".repeat(64),
    text: "Exact retained X source",
    about: [],
    snapshot: {
      version: 1,
      projectId: id,
      projectName: "Alpha",
      workspace: "/served",
      catalogRevision: 1,
      asOf: firstTime,
      since: firstTime,
      scope: {
        label: "project:alpha",
        epicIds: [],
        epicCount: 0,
        repositoryCount: 1,
      },
      observed: { beads: 0, queue: 0, sessions: 0, runs: 0, activity: 0 },
      complete: false,
      limitations: ["Hermetic legacy original fixture"],
      facts: [],
    },
    createdAt: firstTime,
    state: "reserved",
    preparedTurnHash: "b".repeat(64),
  });
  const y = keeperBriefIntentOriginalSchema.parse({
    ...x,
    requestId: randomUUID(),
    intentHash: "c".repeat(64),
    preparedTurnHash: "d".repeat(64),
    text: "Different observed Y source",
  });
  const metadata = (value: typeof x) =>
    keeperBriefIntentMetadataSchema.parse(
      Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => !["text", "about", "snapshot"].includes(key),
        ),
      ),
    );
  const metadataX = metadata(x),
    metadataY = metadata(y);
  const entered = deferred(),
    release = deferred(),
    initialSettled = deferred();
  const reads = {
    discovery: 0,
    exact: [] as string[],
    posts: 0,
    uuids: 0,
    closedStreams: 0,
  };
  const client = createKeeperClient({
    canWrite: () => true,
    requestId: () => {
      reads.uuids++;
      return randomUUID();
    },
    stream: () => () => ({
      close() {
        reads.closedStreams++;
      },
    }),
    timers: { set: (run, ms) => ({ run, ms }), clear: () => {} },
    read: async () => ({
      version: 1,
      projectId: id,
      conversationId: "keeper-" + id,
      revision: 0,
      binding: null,
      turns: [],
      frames: [],
      more: false,
      nextCursor: 0,
      lastSequence: 0,
      request: null,
      controllable: false,
    }),
    readBriefIntent: async (_projectId, requestId) => {
      if (requestId) {
        reads.exact.push(requestId);
        return requestId === x.requestId ? x : y;
      }
      reads.discovery++;
      if (reads.discovery === 2) {
        entered.release();
        await release.wait;
        return metadataY;
      }
      return metadataX;
    },
    post: async () => {
      reads.posts++;
      return { state: "unknown", message: "No action expected" };
    },
  });
  let sawLoading = false;
  const unsubscribe = client.subscribe(() => {
    const state = client.get(id).briefIntentState;
    if (state === "loading") sawLoading = true;
    else if (sawLoading) initialSettled.release();
  });
  let checking: Promise<void> | undefined;
  try {
    client.activate(id);
    await initialSettled.wait;
    expect(sawLoading).toBe(true);
    expect(client.get(id).briefIntent).toEqual(metadataX);
    await client.reviewBrief(id);
    expect(client.get(id).briefOriginal).toEqual(x);
    expect(reads.exact).toEqual([x.requestId]);
    checking = client.checkBriefIntent(id);
    await entered.wait;
    await client.reviewBrief(id);
    expect(client.get(id).briefIntent).toEqual(metadataX);
    expect(client.get(id).briefOriginal).toEqual(x);
    expect(reads.exact).toEqual([x.requestId, x.requestId]);
    release.release();
    await checking;
    expect(reads.discovery).toBe(2);
    expect({ posts: reads.posts, uuids: reads.uuids }).toEqual({
      posts: 0,
      uuids: 0,
    });
    expect(["reserved", "unknown"]).toContain(client.get(id).briefIntentState);
    expect(client.get(id).briefIntent).toEqual(metadataX);
    expect(client.get(id).briefOriginal).toEqual(x);
  } finally {
    release.release();
    try {
      await checking;
    } finally {
      unsubscribe();
      client.dispose();
    }
  }
});

function scheduleHarness() {
  const saved = daily();
  if (saved.kind !== "daily") throw Error("Missing daily source fixture");
  const original = keeperBriefIntentOriginalSchema.parse({
    version: 1,
    requestId: randomUUID(),
    projectId: id,
    conversationId: "keeper-" + id,
    expectedRevision: 0,
    origin: {
      kind: "scheduled",
      projectId: id,
      workspace: "/served",
      catalogRevision: 1,
      scheduleGeneration: saved.generation,
      dueAt: "2026-11-08T09:30:00.000Z",
    },
    selection: {
      name: "fixture",
      provider: "claude",
      model: "fixture",
      effort: "",
      enabled: true,
      tags: [],
    },
    purpose: "brief",
    intentHash: "a".repeat(64),
    preparedTurnHash: "b".repeat(64),
    state: "reserved",
    createdAt: firstTime,
    text: "Exact scheduled source",
    about: [],
    snapshot: {
      version: 1,
      projectId: id,
      projectName: "Alpha",
      workspace: "/served",
      catalogRevision: 1,
      asOf: "2026-11-08T09:31:00.000Z",
      since: firstTime,
      scope: {
        label: "project:alpha",
        epicIds: [],
        epicCount: 0,
        repositoryCount: 1,
      },
      observed: { beads: 0, queue: 0, sessions: 0, runs: 0, activity: 0 },
      complete: false,
      limitations: ["Hermetic scheduled source"],
      facts: [],
    },
  });
  const ticket = keeperBriefIntentMetadataSchema.parse(
    Object.fromEntries(
      Object.entries(original).filter(
        ([key]) => !["text", "about", "snapshot"].includes(key),
      ),
    ),
  );
  const source: KeeperScheduleSource = {
    routeKey: "#/project/alpha",
    status: "live",
    foreground: true,
  };
  const context: KeeperScheduleContext = {
    projectId: id,
    workspace: "/served",
    catalogRevision: 1,
    schedule: saved,
    routeKey: source.routeKey,
    ready: true,
    archived: false,
  };
  const requests: Array<{
    id: string;
    signal: AbortSignal;
    resolve(value: unknown): void;
    promise: Promise<unknown>;
  }> = [];
  const calls = {
    exact: [] as string[],
    posts: [] as Array<{ action: string; body: unknown }>,
    uuids: 0,
    leaves: 0,
  };
  const timers = new Set<{ run(): void; ms: number }>(),
    retained: Array<() => void> = [];
  const events = {
    status: new Set<() => void>(),
    hash: new Set<() => void>(),
    foreground: new Set<() => void>(),
  };
  const retainedEvents: Array<() => void> = [];
  let handlers: StreamHandlers | undefined,
    exactHook: (() => Promise<unknown>) | undefined,
    discoveryHook: (() => Promise<unknown>) | undefined;
  const client = createKeeperClient({
    canWrite: () => true,
    requestId: () => {
      calls.uuids++;
      return randomUUID();
    },
    scheduleSource: () => ({ ...source }),
    readSchedule: (projectId, signal) => {
      let resolve: (value: unknown) => void = () => {};
      const promise = new Promise<unknown>((done) => {
        resolve = done;
      });
      requests.push({ id: projectId, signal, resolve, promise });
      return promise;
    },
    readBriefIntent: async (_id, requestId) => {
      if (!requestId) return discoveryHook ? discoveryHook() : null;
      calls.exact.push(requestId);
      return exactHook ? exactHook() : original;
    },
    stream: () => (_after, next) => {
      handlers = next;
      return { close() {} };
    },
    timers: {
      set(run, ms) {
        const timer = { run, ms };
        timers.add(timer);
        retained.push(run);
        return timer;
      },
      clear(handle) {
        for (const timer of timers) if (timer === handle) timers.delete(timer);
      },
    },
    read: async () => ({
      version: 1,
      projectId: id,
      conversationId: "keeper-" + id,
      revision: 0,
      binding: null,
      turns: [],
      frames: [],
      more: false,
      nextCursor: 0,
      lastSequence: 0,
      request: null,
      controllable: false,
    }),
    post: async (_id, action, body) => {
      calls.posts.push({ action, body });
      return { state: "unknown", message: "Reply lost" };
    },
  });
  const wire = (patch: Partial<KeeperScheduleStatus> = {}) => {
    const schedule = patch.schedule === undefined ? saved : patch.schedule;
    return keeperScheduleStatusSchema.parse({
      projectId: id,
      workspace: "/served",
      conversationId: "keeper-" + id,
      catalogRevision: 1,
      schedule,
      asOf: "2026-11-08T09:31:00.000Z",
      owner: "active",
      phase: "ready-for-review",
      reason: "Exact source ready",
      ...(schedule
        ? keeperScheduleWindow(schedule, Date.parse("2026-11-08T09:31:00.000Z"))
        : { latestDueAt: null, nextDueAt: null }),
      attempt: null,
      ticket,
      ...patch,
    });
  };
  const on = (kind: keyof typeof events, listener: () => void) => {
    events[kind].add(listener);
    retainedEvents.push(listener);
    return () => {
      calls.leaves++;
      events[kind].delete(listener);
    };
  };
  return {
    client,
    context,
    source,
    requests,
    calls,
    timers,
    wire,
    original,
    ticket,
    bind: () =>
      bindKeeperScheduleSources(client, {
        onStatus: (listener) => on("status", listener),
        onHash: (listener) => on("hash", listener),
        onForeground: (listener) => on("foreground", listener),
      }),
    emit: (kind: keyof typeof events) => {
      for (const listener of [...events[kind]]) listener();
    },
    deliver: async (index: number, value: unknown) => {
      const request = requests[index];
      if (!request) throw Error("Missing reached status request");
      request.resolve(value);
      await request.promise;
    },
    page: () =>
      handlers?.onMessage({
        event: "conversation",
        id: "0",
        data: JSON.stringify({
          version: 1,
          projectId: id,
          conversationId: "keeper-" + id,
          revision: 0,
          binding: null,
          turns: [],
          frames: [],
          more: false,
          nextCursor: 0,
          lastSequence: 0,
          request: null,
          controllable: false,
        }),
      }),
    tick: () => {
      const timer = [...timers].find((row) => row.ms === 60_000);
      if (!timer) throw Error("Missing bounded status timer");
      timers.delete(timer);
      timer.run();
    },
    retain: () => {
      for (const listener of retainedEvents) listener();
      for (const run of retained) run();
    },
    exact: (hook: () => Promise<unknown>) => {
      exactHook = hook;
    },
    discovery: (hook: () => Promise<unknown>) => {
      discoveryHook = hook;
    },
    close: () => {
      client.dispose();
      for (const request of requests) request.resolve(null);
    },
  };
}

test("Keeper schedule polling coalesces and only explicit exact review and Send act on a prepared source", async () => {
  const f = scheduleHarness();
  try {
    expect(f.requests).toHaveLength(0);
    f.client.adoptScheduleContext(f.context);
    expect(f.requests).toHaveLength(0);
    f.client.activate(id);
    f.page();
    const reading = f.client.flushSchedule();
    const again = f.client.refreshSchedule(id);
    void f.client.refreshSchedule(id);
    expect(f.requests).toHaveLength(1);
    await f.deliver(0, f.wire());
    await reading;
    await again;
    expect(f.requests).toHaveLength(2);
    await f.deliver(1, f.wire());
    expect([...f.timers].filter((row) => row.ms === 60_000)).toHaveLength(1);
    expect(f.client.get(id).scheduleCurrent).toBe(true);
    expect(f.calls).toMatchObject({ posts: [], uuids: 0, exact: [] });
    await f.client.reviewScheduledBrief(id);
    expect(f.calls.exact).toEqual([f.ticket.requestId]);
    expect(f.client.get(id).briefOriginal).toEqual(f.original);
    expect(f.client.canCommitBrief(id)).toBe(true);
    await f.client.commitBrief(id);
    expect(f.calls.posts).toEqual([
      {
        action: "briefs",
        body: {
          requestId: f.ticket.requestId,
          expectedRevision: 0,
          intentHash: f.ticket.intentHash,
        },
      },
    ]);
    expect(f.calls.uuids).toBe(0);
    f.tick();
    await f.deliver(2, f.wire());
    expect(f.client.get(id).briefIntentState).toBe("unknown");
    expect(f.client.canCommitBrief(id)).toBe(false);
    expect(f.calls.posts).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("Keeper schedule A-B-A and raw reconnect epochs reject obsolete answers and stale finally ownership", async () => {
  const f = scheduleHarness(),
    beta = "project-b5832fa0-7a21-403b-8184-44892f0d8d86";
  f.client.adoptScheduleContext(f.context);
  f.client.activate(id);
  const unbind = f.bind();
  try {
    expect(f.requests).toHaveLength(1);
    f.source.routeKey = "#/project/beta";
    f.emit("hash");
    f.client.adoptScheduleContext({
      ...f.context,
      projectId: beta,
      routeKey: f.source.routeKey,
    });
    f.client.activate(beta);
    void f.client.flushSchedule();
    expect(f.requests).toHaveLength(2);
    f.source.routeKey = f.context.routeKey;
    f.emit("hash");
    f.client.adoptScheduleContext(f.context);
    f.client.activate(id);
    void f.client.flushSchedule();
    expect(f.requests).toHaveLength(3);
    expect(f.requests.slice(0, 2).every((row) => row.signal.aborted)).toBe(
      true,
    );
    await f.deliver(0, f.wire());
    expect(f.client.get(id).scheduleLoading).toBe(true);
    expect(f.client.get(id).scheduleCurrent).toBe(false);
    await f.deliver(2, f.wire());
    await f.deliver(1, f.wire());
    expect(f.client.get(id).scheduleCurrent).toBe(true);
    f.emit("status");
    expect(f.requests).toHaveLength(3);
    f.source.status = "off";
    f.emit("status");
    f.source.status = "live";
    f.emit("status");
    expect(f.client.get(id).scheduleCurrent).toBe(false);
    expect(f.requests).toHaveLength(4);
    await f.deliver(3, f.wire());
    expect(f.client.get(id).scheduleCurrent).toBe(true);
  } finally {
    unbind();
    f.close();
  }
});

test("Keeper schedule foreground source binding resumes once and terminal teardown defeats retained callbacks", async () => {
  const f = scheduleHarness();
  f.client.adoptScheduleContext(f.context);
  f.client.activate(id);
  f.source.foreground = false;
  const unbind = f.bind();
  try {
    expect(f.requests).toHaveLength(0);
    f.source.foreground = true;
    f.emit("foreground");
    expect(f.requests).toHaveLength(1);
    await f.deliver(0, f.wire());
    f.emit("foreground");
    expect(f.requests).toHaveLength(2);
    f.source.foreground = false;
    f.emit("foreground");
    expect(f.requests[1]?.signal.aborted).toBe(true);
    expect([...f.timers].filter((row) => row.ms === 60_000)).toEqual([]);
    unbind();
    unbind();
    f.retain();
    expect(f.calls.leaves).toBe(3);
    expect(f.requests).toHaveLength(2);
    expect(f.client.get(id).scheduleCurrent).toBe(false);
  } finally {
    unbind();
    f.close();
  }
});

test("Keeper schedule historical off, old-generation, archived or unavailable originals remain read-only reviewable", async () => {
  const f = scheduleHarness();
  try {
    f.client.adoptScheduleContext(f.context);
    f.client.activate(id);
    f.page();
    void f.client.flushSchedule();
    await f.deliver(0, f.wire());
    await f.client.reviewScheduledBrief(id);
    const newer = daily();
    const rows = [
      {
        context: { ...f.context, schedule: { kind: "off" as const } },
        patch: { schedule: { kind: "off" as const }, phase: "off" as const },
      },
      {
        context: { ...f.context, schedule: newer },
        patch: { schedule: newer, phase: "blocked-existing-work" as const },
      },
      {
        context: { ...f.context, archived: true },
        patch: { phase: "policy-paused" as const },
      },
    ];
    let index = 1;
    for (const row of rows) {
      f.client.adoptScheduleContext(row.context);
      void f.client.flushSchedule();
      await f.deliver(index++, f.wire(row.patch));
      expect(f.client.canCommitBrief(id)).toBe(false);
      expect(f.client.canReviewScheduledBrief(id)).toBe(true);
      await f.client.reviewScheduledBrief(id);
      expect(f.client.get(id).briefOriginal).toEqual(f.original);
    }
    f.client.adoptScheduleContext(f.context);
    void f.client.flushSchedule();
    await f.deliver(index, null);
    expect(f.client.get(id).scheduleCurrent).toBe(false);
    await f.client.reviewScheduledBrief(id);
    expect(f.client.get(id).briefOriginal).toEqual(f.original);
    expect(f.client.canCommitBrief(id)).toBe(false);
    f.source.routeKey = "#/elsewhere";
    const before = f.calls.exact.length;
    await f.client.reviewScheduledBrief(id);
    expect(f.calls.exact).toHaveLength(before);
    expect(f.calls.posts).toEqual([]);
  } finally {
    f.close();
  }
});

test("Keeper schedule stale exact reads and conflicting status tickets retain the held original identity", async () => {
  const f = scheduleHarness(),
    held = deferred();
  try {
    f.client.adoptScheduleContext(f.context);
    f.client.activate(id);
    void f.client.flushSchedule();
    await f.deliver(0, f.wire());
    await f.client.reviewScheduledBrief(id);
    f.exact(async () => {
      await held.wait;
      return f.original;
    });
    const reading = f.client.reviewScheduledBrief(id);
    f.client.scheduleSourceChanged("hash");
    void f.client.flushSchedule();
    const other = {
      ...f.ticket,
      requestId: randomUUID(),
      intentHash: "c".repeat(64),
    };
    await f.deliver(1, f.wire({ ticket: other }));
    held.release();
    await reading;
    expect(f.client.get(id).briefIntent).toEqual(f.ticket);
    expect(f.client.get(id).briefOriginal).toEqual(f.original);
    expect(f.client.get(id).briefIntentState).toBe("unknown");
    expect(f.calls.posts).toEqual([]);
    for (const patch of [
      { projectId: "foreign" },
      { catalogRevision: 2 },
      { schedule: daily() },
      { workspace: "/foreign" },
    ]) {
      const check = f.client.refreshSchedule(id);
      await f.deliver(f.requests.length - 1, { ...f.wire(), ...patch });
      await check;
      expect(f.client.get(id).scheduleCurrent).toBe(false);
      expect(f.client.get(id).briefOriginal).toEqual(f.original);
    }
  } finally {
    held.release();
    f.close();
  }
});

test("Keeper schedule actual protected adapter cancels 65537 receiving bytes before whole-body decoding", async () => {
  let cancelled = 0,
    decoded = 0;
  const client = createOperatorClient(
    async (url) => {
      if (url === TOKEN_ROUTE)
        return Response.json({
          ok: true,
          data: { token: "held" },
          error: null,
        });
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(32768));
            controller.enqueue(new Uint8Array(32768));
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            cancelled++;
          },
        }),
      );
      response.json = async () => {
        decoded++;
        return null;
      };
      response.text = async () => {
        decoded++;
        return "";
      };
      response.arrayBuffer = async () => {
        decoded++;
        return new ArrayBuffer(0);
      };
      return response;
    },
    { sessionKeys: { get: () => null, set: () => {} } },
  );
  await expect(
    readKeeperSchedule(client.read, id, new AbortController().signal),
  ).rejects.toThrow("exceeds its byte limit");
  expect(cancelled).toBe(1);
  expect(decoded).toBe(0);
  for (const raw of [
    { ok: true, error: null },
    { ok: true, data: {}, error: null, extra: true },
    { ok: false, data: {}, error: null },
  ]) {
    await expect(
      readKeeperSchedule(
        async () => Response.json(raw),
        id,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unverified schedule read");
  }
});

test("Keeper schedule obsolete exact and discovery errors cannot clobber a fresh same-project reconnect", async () => {
  for (const kind of ["exact", "discovery"] as const) {
    const f = scheduleHarness(),
      entered = deferred(),
      release = deferred();
    let old: Promise<void> | undefined;
    try {
      f.client.adoptScheduleContext(f.context);
      f.client.activate(id);
      void f.client.flushSchedule();
      await f.deliver(0, f.wire());
      await f.client.reviewScheduledBrief(id);
      const failure = async () => {
        entered.release();
        await release.wait;
        throw Error("Obsolete read failed");
      };
      if (kind === "exact") f.exact(failure);
      else f.discovery(failure);
      old =
        kind === "exact"
          ? f.client.reviewScheduledBrief(id)
          : f.client.checkBriefIntent(id);
      await entered.wait;
      f.source.status = "off";
      f.client.scheduleSourceChanged("status");
      f.source.status = "live";
      f.client.scheduleSourceChanged("status");
      void f.client.flushSchedule();
      await f.deliver(1, f.wire());
      f.exact(async () => f.original);
      await f.client.reviewScheduledBrief(id);
      const before = {
        state: f.client.get(id).briefIntentState,
        error: f.client.get(id).briefIntentError,
        metadata: f.client.get(id).briefIntent,
        original: f.client.get(id).briefOriginal,
      };
      release.release();
      await old;
      expect({
        state: f.client.get(id).briefIntentState,
        error: f.client.get(id).briefIntentError,
        metadata: f.client.get(id).briefIntent,
        original: f.client.get(id).briefOriginal,
      }).toEqual(before);
      expect(f.client.get(id).briefOriginal).toEqual(f.original);
      expect(f.calls.posts).toEqual([]);
    } finally {
      release.release();
      try {
        await old;
      } finally {
        f.close();
      }
    }
  }
});

test("Keeper schedule legacy null discovery cannot erase an unresolved original while exact review is loading", async () => {
  const fixture = scheduleHarness();
  const x = keeperBriefIntentOriginalSchema.parse({
    ...fixture.original,
    origin: {
      kind: "overview",
      projectId: id,
      workspace: "/served",
      catalogRevision: 1,
    },
  });
  const metadata = keeperBriefIntentMetadataSchema.parse(
    Object.fromEntries(
      Object.entries(x).filter(
        ([key]) => !["text", "about", "snapshot"].includes(key),
      ),
    ),
  );
  const initial = deferred(),
    discoveryEntered = deferred(),
    discoveryRelease = deferred(),
    exactEntered = deferred(),
    exactRelease = deferred();
  let discoveries = 0,
    exactReads = 0,
    posts = 0,
    uuids = 0,
    sawLoading = false;
  const client = createKeeperClient({
    canWrite: () => true,
    requestId: () => {
      uuids++;
      return randomUUID();
    },
    stream: () => () => ({ close() {} }),
    timers: { set: () => null, clear: () => {} },
    read: async () => null,
    readBriefIntent: async (_id, requestId) => {
      if (requestId) {
        exactReads++;
        if (exactReads === 2) {
          exactEntered.release();
          await exactRelease.wait;
        }
        return x;
      }
      discoveries++;
      if (discoveries === 2) {
        discoveryEntered.release();
        await discoveryRelease.wait;
        return null;
      }
      return metadata;
    },
    post: async () => {
      posts++;
      return { state: "unknown", message: "No action expected" };
    },
  });
  const leave = client.subscribe(() => {
    if (client.get(id).briefIntentState === "loading") sawLoading = true;
    else if (sawLoading) initial.release();
  });
  let checking: Promise<void> | undefined, reading: Promise<void> | undefined;
  try {
    client.activate(id);
    await initial.wait;
    expect(client.get(id).briefIntent).toEqual(metadata);
    await client.reviewBrief(id);
    expect(client.get(id).briefOriginal).toEqual(x);
    checking = client.checkBriefIntent(id);
    await discoveryEntered.wait;
    reading = client.reviewBrief(id);
    await exactEntered.wait;
    expect(client.get(id).briefIntentState).toBe("loading");
    discoveryRelease.release();
    await checking;
    expect({ posts, uuids, discoveries, exactReads }).toEqual({
      posts: 0,
      uuids: 0,
      discoveries: 2,
      exactReads: 2,
    });
    expect(client.get(id).briefIntent).toEqual(metadata);
    expect(client.get(id).briefOriginal).toEqual(x);
  } finally {
    discoveryRelease.release();
    exactRelease.release();
    try {
      await Promise.allSettled([checking, reading]);
    } finally {
      leave();
      client.dispose();
      fixture.close();
    }
  }
});

test("Keeper schedule old ready metadata cannot send an exact original already verified retired", async () => {
  const f = scheduleHarness();
  try {
    f.client.adoptScheduleContext(f.context);
    f.client.activate(id);
    f.page();
    void f.client.flushSchedule();
    await f.deliver(0, f.wire());
    f.exact(async () => ({ ...f.original, state: "retired" }));
    await f.client.reviewScheduledBrief(id);
    expect(f.client.get(id).briefOriginal?.state).toBe("retired");
    const read = f.client.refreshSchedule(id);
    await f.deliver(1, f.wire());
    await read;
    expect(f.client.get(id).briefOriginal?.state).toBe("retired");
    expect(f.client.canCommitBrief(id)).toBe(false);
    expect(await f.client.commitBrief(id)).toBe(false);
    expect(f.calls.posts).toEqual([]);
  } finally {
    f.close();
  }
});

test("Keeper schedule obsolete admitted outcome read cannot complete a newer reviewed original", async () => {
  const fixture = scheduleHarness();
  const x = keeperBriefIntentOriginalSchema.parse({
    ...fixture.original,
    state: "admitted",
    origin: {
      kind: "overview",
      projectId: id,
      workspace: "/served",
      catalogRevision: 1,
    },
  });
  const y = keeperBriefIntentOriginalSchema.parse({
    ...x,
    state: "reserved",
    requestId: randomUUID(),
    intentHash: "c".repeat(64),
    preparedTurnHash: "d".repeat(64),
    text: "Newer reviewed Y source",
  });
  const metadata = (value: typeof x) =>
    keeperBriefIntentMetadataSchema.parse(
      Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => !["text", "about", "snapshot"].includes(key),
        ),
      ),
    );
  const metadataX = metadata(x),
    metadataY = metadata(y);
  const turn = {
    requestId: x.requestId,
    hash: x.preparedTurnHash,
    phase: "completed",
    createdAt: firstTime,
    updatedAt: firstTime,
    reason: null,
    owner: null,
  };
  const completed = {
    version: 1,
    projectId: id,
    conversationId: "keeper-" + id,
    revision: 1,
    binding: null,
    turns: [turn],
    frames: [],
    more: false,
    nextCursor: 0,
    lastSequence: 0,
    request: null,
    controllable: false,
  };
  const initial = deferred(),
    entered = deferred(),
    release = deferred();
  let handlers: StreamHandlers | undefined,
    discoveries = 0,
    posts = 0,
    uuids = 0,
    sawLoading = false;
  const currentHandlers = (): StreamHandlers | undefined => handlers;
  const specific: Array<{ projectId: string; requestId: string | null }> = [],
    exact: string[] = [];
  const client = createKeeperClient({
    canWrite: () => true,
    requestId: () => {
      uuids++;
      return randomUUID();
    },
    stream: () => (_after, next) => {
      handlers = next;
      return { close() {} };
    },
    timers: { set: () => null, clear: () => {} },
    readBriefIntent: async (_id, requestId) => {
      if (requestId) {
        exact.push(requestId);
        return requestId === y.requestId ? y : x;
      }
      discoveries++;
      return discoveries <= 2 ? metadataX : metadataY;
    },
    read: async (projectId, query) => {
      specific.push({ projectId, requestId: query.requestId ?? null });
      entered.release();
      await release.wait;
      return completed;
    },
    post: async () => {
      posts++;
      return { state: "unknown", message: "No action expected" };
    },
  });
  const leave = client.subscribe(() => {
    if (client.get(id).briefIntentState === "loading") sawLoading = true;
    else if (sawLoading) initial.release();
  });
  let checking: Promise<void> | undefined;
  try {
    client.activate(id);
    await initial.wait;
    expect(client.get(id).briefIntent).toEqual(metadataX);
    expect(client.get(id).briefIntentState).toBe("admitted");
    checking = client.checkBriefIntent(id);
    await entered.wait;
    expect(specific).toEqual([{ projectId: id, requestId: x.requestId }]);
    const channel = currentHandlers();
    if (!channel) throw Error("Expected actual existing conversation stream");
    channel.onMessage({
      event: "conversation",
      id: "0",
      data: JSON.stringify(completed),
    });
    expect(client.get(id).briefIntentState).toBe("complete");
    await client.checkBriefIntent(id);
    expect(client.get(id).briefIntent).toEqual(metadataY);
    await client.reviewBrief(id);
    expect(client.get(id).briefIntentState).toBe("reserved");
    expect(client.get(id).briefOriginal).toEqual(y);
    expect(exact).toEqual([y.requestId]);
    release.release();
    await checking;
    expect({ posts, uuids, discoveries }).toEqual({
      posts: 0,
      uuids: 0,
      discoveries: 3,
    });
    expect(client.get(id).briefIntentState).toBe("reserved");
    expect(client.get(id).briefIntent).toEqual(metadataY);
    expect(client.get(id).briefOriginal).toEqual(y);
  } finally {
    release.release();
    try {
      await checking;
    } finally {
      leave();
      client.dispose();
      fixture.close();
    }
  }
});

function acceptedOutcomeHarness() {
  const fixture = scheduleHarness(),
    x = fixture.original,
    metadataX = fixture.ticket;
  const y = keeperBriefIntentOriginalSchema.parse({
    ...x,
    requestId: randomUUID(),
    intentHash: "c".repeat(64),
    preparedTurnHash: "d".repeat(64),
    text: "New reserved Y original",
    origin: {
      kind: "overview",
      projectId: id,
      workspace: "/served",
      catalogRevision: 1,
    },
  });
  const metadataY = keeperBriefIntentMetadataSchema.parse(
    Object.fromEntries(
      Object.entries(y).filter(
        ([key]) => !["text", "about", "snapshot"].includes(key),
      ),
    ),
  );
  const retired = keeperBriefIntentMetadataSchema.parse({
    ...metadataX,
    state: "retired",
  });
  const turn = {
    requestId: x.requestId,
    hash: x.preparedTurnHash,
    phase: "completed" as const,
    createdAt: firstTime,
    updatedAt: firstTime,
    reason: null,
    owner: null,
  };
  const page = (phase: "running" | "completed") => ({
    version: 1,
    projectId: id,
    conversationId: "keeper-" + id,
    revision: 1,
    binding: null,
    turns: [{ ...turn, phase }],
    frames: [],
    more: false,
    nextCursor: 0,
    lastSequence: 0,
    request: null,
    controllable: false,
  });
  const initial = deferred(),
    entered = deferred(),
    release = deferred();
  let discovery = metadataX,
    status: unknown = fixture.wire(),
    handlers: StreamHandlers | undefined,
    loading = false,
    uuids = 0;
  const currentHandlers = (): StreamHandlers | undefined => handlers;
  const posts: Array<{ action: string; body: unknown }> = [];
  const client = createKeeperClient({
    canWrite: () => true,
    requestId: () => {
      uuids++;
      return randomUUID();
    },
    scheduleSource: () => ({ ...fixture.source }),
    readSchedule: async () => status,
    stream: () => (_after, next) => {
      handlers = next;
      return { close() {} };
    },
    timers: { set: () => null, clear: () => {} },
    readBriefIntent: async (_id, requestId) =>
      requestId ? (requestId === y.requestId ? y : x) : discovery,
    read: async () => page("running"),
    post: async (_id, action, body) => {
      posts.push({ action, body });
      entered.release();
      await release.wait;
      return {
        state: "done",
        data:
          action === "brief-intents/retire"
            ? retired
            : { conversationId: "keeper-" + id, revision: 1, turn },
      };
    },
  });
  const leave = client.subscribe(() => {
    if (client.get(id).briefIntentState === "loading") loading = true;
    else if (loading) initial.release();
  });
  return {
    client,
    x,
    y,
    metadataY,
    entered,
    release,
    posts,
    uuids: () => uuids,
    async start() {
      client.adoptScheduleContext(fixture.context);
      client.activate(id);
      await initial.wait;
      const channel = currentHandlers();
      if (!channel) throw Error("Missing actual stream for accepted outcome");
      channel.onMessage({
        event: "conversation",
        id: "0",
        data: JSON.stringify({ ...page("running"), revision: 0, turns: [] }),
      });
      await client.reviewBrief(id);
      await client.refreshSchedule(id);
    },
    async terminal(action: "retire" | "commit") {
      if (action === "retire") {
        status = fixture.wire({ phase: "waiting", ticket: retired });
        await client.refreshSchedule(id);
      } else {
        discovery = { ...metadataX, state: "admitted" };
        await client.checkBriefIntent(id);
        const channel = currentHandlers();
        if (!channel) throw Error("Missing terminal SSE fixture");
        channel.onMessage({
          event: "conversation",
          id: "0",
          data: JSON.stringify(page("completed")),
        });
      }
    },
    discoverY: async () => {
      discovery = metadataY;
      await client.checkBriefIntent(id);
    },
    close: () => {
      release.release();
      leave();
      client.dispose();
      fixture.close();
    },
  };
}

for (const action of ["retire", "commit"] as const) {
  test(
    "Keeper schedule late accepted " +
      action +
      " preserves a newer known reserved ticket",
    async () => {
      const f = acceptedOutcomeHarness();
      let acting: Promise<boolean> | undefined;
      try {
        await f.start();
        expect(f.client.get(id).briefOriginal).toEqual(f.x);
        acting =
          action === "retire"
            ? f.client.retireBrief(id)
            : f.client.commitBrief(id);
        await f.entered.wait;
        expect(f.posts).toHaveLength(1);
        await f.terminal(action);
        expect(f.client.get(id).briefIntentState).toBe(
          action === "retire" ? "retired" : "complete",
        );
        await f.discoverY();
        expect(f.client.get(id).briefIntent).toEqual(f.metadataY);
        expect(f.client.get(id).briefIntentState).toBe("reserved");
        f.release.release();
        expect(await acting).toBe(true);
        expect(f.uuids()).toBe(0);
        expect(f.posts).toHaveLength(1);
        expect(f.client.get(id).briefIntent).toEqual(f.metadataY);
        expect(f.client.get(id).briefIntentState).toBe("reserved");
      } finally {
        f.release.release();
        try {
          await acting;
        } finally {
          f.close();
        }
      }
    },
  );
}

test("Keeper schedule retained retirement after disposal issues no POST", async () => {
  const f = acceptedOutcomeHarness();
  let acting: Promise<boolean> | undefined;
  try {
    await f.start();
    expect(f.client.get(id).briefIntentState).toBe("reserved");
    f.client.dispose();
    acting = f.client.retireBrief(id);
    f.release.release();
    await acting;
    expect(f.uuids()).toBe(0);
    expect(f.posts).toEqual([]);
  } finally {
    f.release.release();
    try {
      await acting;
    } finally {
      f.close();
    }
  }
});

test("Keeper schedule completed X does not complete a different admitted Y status", async () => {
  const fixture = scheduleHarness(),
    x = { ...fixture.ticket, state: "admitted" as const };
  const y = keeperBriefIntentMetadataSchema.parse({
    ...x,
    requestId: randomUUID(),
    intentHash: "c".repeat(64),
    preparedTurnHash: "d".repeat(64),
    origin: {
      kind: "overview",
      projectId: id,
      workspace: "/served",
      catalogRevision: 1,
    },
  });
  const initial = deferred();
  let loading = false,
    posts = 0,
    uuids = 0;
  const client = createKeeperClient({
    canWrite: () => true,
    requestId: () => {
      uuids++;
      return randomUUID();
    },
    scheduleSource: () => ({ ...fixture.source }),
    readSchedule: async () =>
      fixture.wire({ phase: "blocked-existing-work", ticket: y }),
    stream: () => () => ({ close() {} }),
    timers: { set: () => null, clear: () => {} },
    readBriefIntent: async () => x,
    read: async () => ({
      version: 1,
      projectId: id,
      conversationId: "keeper-" + id,
      revision: 1,
      binding: null,
      turns: [
        {
          requestId: x.requestId,
          hash: x.preparedTurnHash,
          phase: "completed",
          createdAt: firstTime,
          updatedAt: firstTime,
          reason: null,
          owner: null,
        },
      ],
      frames: [],
      more: false,
      nextCursor: 0,
      lastSequence: 0,
      request: null,
      controllable: false,
    }),
    post: async () => {
      posts++;
      return { state: "unknown", message: "No action expected" };
    },
  });
  const leave = client.subscribe(() => {
    if (client.get(id).briefIntentState === "loading") loading = true;
    else if (loading) initial.release();
  });
  try {
    client.adoptScheduleContext(fixture.context);
    client.activate(id);
    await initial.wait;
    expect(client.get(id).briefIntent).toEqual(x);
    await client.checkBriefIntent(id);
    expect(client.get(id).briefIntentState).toBe("complete");
    await client.refreshSchedule(id);
    expect(client.get(id).briefIntent).toEqual(y);
    expect(["admitted", "unknown"]).toContain(client.get(id).briefIntentState);
    expect(client.get(id).briefIntentState).not.toBe("complete");
    expect({ posts, uuids }).toEqual({ posts: 0, uuids: 0 });
  } finally {
    leave();
    client.dispose();
    fixture.close();
  }
});

function scheduleSettingsView(
  owner: ProjectKeeperSettingsOwner,
  keeper: ReturnType<typeof createKeeperClient>,
  flags: {
    archived?: boolean;
    writesAllowed?: boolean;
    projectId?: string;
  } = {},
) {
  return ProjectKeeperSettings({
    projectId: id,
    archived: false,
    writesAllowed: true,
    settings: { ...owner.snapshot(), owner },
    smiths: { client: null, view: null },
    keeper,
    ...flags,
  });
}
const scheduleForm = (tree: ReturnType<typeof scheduleSettingsView>) =>
  findAll(tree, "form").find(
    (node) => attrs(node)["aria-label"] === "Keeper source schedule",
  );
function invokeNode(
  node: Parameters<typeof attrs>[0],
  event: string,
  value: unknown,
) {
  const handler = attrs(node)[event];
  if (typeof handler !== "function")
    throw Error("Missing real VNode action " + event);
  return handler(value);
}

test("Keeper schedule actual UTC form keeps raw edits and verifies a strict save without Smith configuration", async () => {
  const f = fixture(),
    live = scheduleHarness();
  const render = () => scheduleSettingsView(f.owner, live.client);
  try {
    let tree = render();
    expect(textOf(tree)).toContain("Saved schedule: Off");
    expect(textOf(tree)).toContain("default policy");
    const select = findAll(tree, "select").find(
      (node) => attrs(node)["aria-label"] === "Keeper source preparation",
    );
    invokeNode(select, "onChange", { currentTarget: { value: "automatic" } });
    expect(f.state().scheduleDraft).toBeNull();
    invokeNode(select, "onChange", { currentTarget: { value: "daily" } });
    expect(f.state().scheduleDraft).toEqual({ kind: "daily", atUtc: "" });
    tree = render();
    expect(attrs(findAll(scheduleForm(tree), "button")[0])["disabled"]).toBe(
      true,
    );
    const input = findAll(tree, "input").find(
      (node) => attrs(node)["aria-label"] === "Daily preparation time (UTC)",
    );
    expect(attrs(input)["type"]).toBe("time");
    invokeNode(input, "onInput", { currentTarget: { value: "09:30" } });
    tree = render();
    expect(attrs(findAll(scheduleForm(tree), "button")[0])["disabled"]).toBe(
      false,
    );
    expect(
      attrs(
        findAll(tree, "button").find((node) =>
          textOf(node).includes("Save Keeper settings"),
        ),
      )["disabled"],
    ).toBe(true);
    const saved = daily();
    f.post(async () => f.accept(catalog(2, { keeperSchedule: saved })));
    let busy = false;
    const settled = deferred();
    const leave = f.owner.subscribe((state) => {
      if (state.busy === id) busy = true;
      else if (busy) settled.release();
    });
    try {
      invokeNode(scheduleForm(tree), "onSubmit", { preventDefault() {} });
      expect(busy).toBe(true);
      await settled.wait;
    } finally {
      leave();
    }
    expect(f.calls.posts[0]?.body).toEqual({
      expectedRevision: 1,
      kind: "schedule",
      keeperSchedule: { kind: "daily", atUtc: "09:30" },
    });
    expect(f.state().scheduleDraft).toBeNull();
    expect(textOf(render())).toContain("Daily at 09:30 UTC");
    expect(textOf(render())).toContain(
      saved.kind === "daily" ? saved.generation : "missing",
    );
    expect(textOf(render())).toContain("latest due occurrence");
    expect(textOf(render())).toContain("never starts a model");
  } finally {
    live.close();
  }
});

test("Keeper schedule form shares archive, connection, recovery and review holds without defaulting missing provenance", async () => {
  const live = scheduleHarness();
  const foreign = "project-00000000-0000-4000-8000-000000000000";
  try {
    for (const flag of [
      { archived: true },
      { writesAllowed: false },
      { projectId: foreign },
    ]) {
      const f = fixture();
      f.owner.setScheduleDraft(id, { kind: "off" });
      const tree = scheduleSettingsView(f.owner, live.client, flag),
        form = scheduleForm(tree);
      expect(attrs(findAll(form, "button")[0])["disabled"]).toBe(true);
      invokeNode(form, "onSubmit", { preventDefault() {} });
      expect(f.calls.posts).toEqual([]);
      if (flag.projectId)
        expect(textOf(tree)).toContain("Saved schedule: Unavailable");
    }
    const cases = [fixture(catalog(1), { [foreign]: 1 }), fixture()];
    cases[1]?.owner.setScheduleDraft(id, { kind: "off" });
    if (!cases[1]) throw Error("Missing unknown fixture");
    await cases[1].owner.saveSchedule(id);
    for (const f of cases) {
      f.owner.setScheduleDraft(id, { kind: "off" });
      const before = f.calls.posts.length,
        tree = scheduleSettingsView(f.owner, live.client);
      expect(attrs(findAll(scheduleForm(tree), "button")[0])["disabled"]).toBe(
        true,
      );
      invokeNode(scheduleForm(tree), "onSubmit", { preventDefault() {} });
      expect(f.calls.posts).toHaveLength(before);
    }
    const foreignOwner = cases[0];
    if (!foreignOwner) throw Error("Missing foreign pending fixture");
    expect(
      textOf(scheduleSettingsView(foreignOwner.owner, live.client)),
    ).toContain("Resolve earlier Keeper changes");
    const busy = fixture(),
      entered = deferred(),
      release = deferred();
    busy.owner.setScheduleDraft(id, { kind: "off" });
    busy.read(async () => {
      entered.release();
      await release.wait;
      return catalog(1);
    });
    const checking = busy.owner.review(id);
    try {
      await entered.wait;
      const tree = scheduleSettingsView(busy.owner, live.client);
      invokeNode(scheduleForm(tree), "onSubmit", { preventDefault() {} });
      expect(busy.calls.posts).toEqual([]);
      expect(attrs(findAll(scheduleForm(tree), "button")[0])["disabled"]).toBe(
        true,
      );
    } finally {
      release.release();
      await checking;
    }
    const empty = new ProjectKeeperSettingsOwner({
      read: async () => null,
      post: async () => {
        throw Error("No catalog must not POST");
      },
    });
    expect(textOf(scheduleSettingsView(empty, live.client))).toContain(
      "Saved schedule: Unavailable",
    );
    const missing = KeeperScheduleStatusView({ projectId: id });
    expect(textOf(missing)).toContain("Current schedule status unavailable");
    expect(
      findAll(missing, "Button").every(
        (node) => attrs(node)["disabled"] === true,
      ),
    ).toBe(true);
  } finally {
    live.close();
  }
});

test("Keeper schedule status renders every closed phase and its retained source facts truthfully", async () => {
  const f = scheduleHarness();
  const rows: Array<{ phase: KeeperScheduleStatus["phase"]; label: string }> = [
    { phase: "off", label: "Off" },
    { phase: "waiting", label: "Waiting for the next UTC occurrence" },
    { phase: "preparing", label: "Preparing sources" },
    { phase: "ready-for-review", label: "Prepared source ready for review" },
    { phase: "blocked-existing-work", label: "Paused by existing work" },
    { phase: "policy-paused", label: "Paused by project policy" },
    { phase: "capacity-paused", label: "Paused at an existing capacity limit" },
    { phase: "unavailable", label: "Unavailable" },
  ];
  try {
    f.client.activate(id);
    for (const row of rows) {
      const schedule =
        row.phase === "off" ? { kind: "off" as const } : f.context.schedule;
      f.client.adoptScheduleContext({ ...f.context, schedule });
      const read = f.client.refreshSchedule(id);
      await f.deliver(
        f.requests.length - 1,
        f.wire({
          schedule,
          phase: row.phase,
          reason: "Exact pause explanation",
          ...(row.phase === "preparing"
            ? {
                attempt: {
                  dueAt: "2026-11-08T09:30:00.000Z",
                  startedAt: "2026-11-08T09:31:00.000Z",
                  problem: null,
                },
              }
            : {}),
        }),
      );
      await read;
      const tree = KeeperScheduleStatusView({
        projectId: id,
        client: f.client,
      });
      expect(textOf(tree)).toContain(row.label);
      expect(textOf(tree)).toContain("Exact pause explanation");
      expect(textOf(tree)).toContain(f.ticket.requestId);
      expect(textOf(tree)).toContain(f.ticket.intentHash);
      expect(textOf(tree)).toContain("2026-11-08T09:31:00.000Z");
    }
    const read = f.client.refreshSchedule(id);
    await f.deliver(f.requests.length - 1, null);
    await read;
    expect(
      textOf(KeeperScheduleStatusView({ projectId: id, client: f.client })),
    ).toContain("Last reported:");
    expect(
      textOf(KeeperScheduleStatusView({ projectId: id, client: f.client })),
    ).toContain("do not enable sending");
    expect(f.calls.posts).toEqual([]);
  } finally {
    f.close();
  }
});

test("Keeper schedule Settings exact Review exposes the real Keeper path only after the read settles", async () => {
  const f = scheduleHarness(),
    entered = deferred(),
    release = deferred();
  try {
    f.client.adoptScheduleContext(f.context);
    f.client.activate(id);
    void f.client.flushSchedule();
    await f.deliver(0, f.wire());
    f.exact(async () => {
      entered.release();
      await release.wait;
      return f.original;
    });
    const render = () =>
      KeeperScheduleStatusView({
        projectId: id,
        client: f.client,
        reviewLink: true,
      });
    const action = findAll(render(), "Button").find(
      (node) => textOf(node) === "Review prepared source",
    );
    expect(attrs(action)["disabled"]).toBe(false);
    const reviewing = Promise.resolve(invokeNode(action, "onClick", {}));
    try {
      await entered.wait;
      expect(
        findAll(render(), "Button").some(
          (node) => attrs(node)["href"] === openProject(id, "keeper"),
        ),
      ).toBe(false);
      release.release();
      await reviewing;
      const link = findAll(render(), "Button").find(
        (node) => attrs(node)["href"] === openProject(id, "keeper"),
      );
      expect(textOf(link)).toContain("review and Send");
      expect(f.client.get(id).briefOriginal).toEqual(f.original);
      expect(f.calls.posts).toEqual([]);
    } finally {
      release.release();
      await reviewing;
    }
  } finally {
    release.release();
    f.close();
  }
});

test("Keeper schedule actual ProjectSettings forwards the same root client and shared owner to the leaf", () => {
  const live = scheduleHarness(),
    f = fixture(),
    raw = projectCatalogFixture("/served"),
    project = raw.projects[0];
  if (!project) throw Error("Missing real Settings project");
  const deps = {
    read: async () => raw,
    post: (async () => {
      throw Error("Forwarding must not write");
    }) satisfies OperatorPost,
  };
  const general = new ProjectGeneralSettingsOwner(deps),
    defaults = new ProjectDefaultsSettingsOwner(deps);
  const budgets = new ProjectValueSettingsOwner(projectBudgetsSpec, deps),
    notifications = new ProjectValueSettingsOwner(
      projectNotificationsSpec,
      deps,
    );
  general.adopt(id, raw);
  try {
    const tree = ProjectSettings({
      projectId: id,
      project,
      catalog: general.snapshot().catalog,
      initialRevision: 1,
      loading: false,
      error: null,
      stale: false,
      writesAllowed: true,
      owner: general,
      state: general.snapshot(),
      keeperSettings: { ...f.owner.snapshot(), owner: f.owner },
      keeper: live.client,
      defaultsSettings: { ...defaults.snapshot(), owner: defaults },
      budgetsSettings: { ...budgets.snapshot(), owner: budgets },
      notificationsSettings: {
        ...notifications.snapshot(),
        owner: notifications,
      },
      smiths: { client: null, view: null },
      onRefresh() {},
      repositories: {
        key: null,
        projectId: null,
        requestedRevision: null,
        phase: "idle",
        data: null,
        error: null,
        responseRevision: null,
      },
      onRefreshRepositories() {},
      onReconcileRepositories() {},
    });
    const leaf = findAll(tree, "ProjectKeeperSettings")[0];
    expect(attrs(leaf)["keeper"]).toBe(live.client);
    expect(attrs(leaf)["settings"]).toMatchObject({ owner: f.owner });
    expect(attrs(leaf)["projectId"]).toBe(id);
    const nested = findAll(
      scheduleSettingsView(f.owner, live.client),
      "KeeperScheduleStatusView",
    )[0];
    expect(attrs(nested)["client"]).toBe(live.client);
    expect(attrs(nested)["reviewLink"]).toBe(true);
  } finally {
    live.close();
  }
});

test("Keeper schedule real Settings save prepares one reviewable source, then explicit Send survives off and exact replay", async () => {
  let wall = Date.parse(firstTime),
    wake: (() => void) | undefined,
    armed = deferred();
  const currentWake = (): (() => void) | undefined => wake;
  const clock: KeeperScheduleClock = {
    now: () => wall,
    setTimer(run) {
      wake = run;
      armed.release();
      return () => {
        wake = undefined;
      };
    },
  };
  const providerEntered = deferred(),
    providerRelease = deferred();
  let runs = 0,
    probes = 0,
    uuids = 0;
  const transport: ConversationTransport = {
    provider: "claude",
    async run(request, persist) {
      runs++;
      providerEntered.release();
      await providerRelease.wait;
      await persist({
        kind: "identity",
        provider: "claude",
        sessionId: "fixture-" + request.project.id,
        version: "fixture",
      });
      await persist({
        kind: "text",
        text: JSON.stringify({
          summary: "One reviewed scheduled source.",
          moving: [],
          waiting: [],
          stuck: [],
        }),
      });
      return { phase: "completed", reason: null };
    },
  };
  const selection = {
    name: "fixture",
    provider: "claude" as const,
    model: "fixture",
    effort: "",
    enabled: true,
    tags: [],
  };
  const h = await startTestHearth({
    api: {
      keeperScheduleClock: clock,
      conversationTransport: transport,
      keeperRuntime: {
        catalog: () => ({ defaultSmith: selection.name, smiths: [selection] }),
        transport: () => transport,
        async readiness() {
          probes++;
          return keeperReadiness({ checked: true, adapter: true });
        },
      },
    },
  });
  let client: ReturnType<typeof createKeeperClient> | undefined;
  try {
    await armed.wait;
    h.bd.answer = (args) =>
      args[0] === "export"
        ? {
            status: 0,
            stdout: JSON.stringify({
              id: "scheduled-epic",
              title: "Scheduled source epic",
              labels: ["project:scheduled-project"],
              status: "open",
              issue_type: "epic",
              priority: 2,
              created_at: firstTime,
              updated_at: firstTime,
            }),
            stderr: "",
          }
        : undefined;
    const store = createProjectStore(h.home, () => new Date(wall));
    const created = await store.create(
      {
        name: "Scheduled project",
        slug: "scheduled-project",
        description: "Explicit scheduled source scope",
        icon: "S",
        workspaces: [
          {
            root: h.workspace,
            repositories: [h.workspace],
            epicIds: ["scheduled-epic"],
          },
        ],
      },
      store.read().revision,
    );
    const project = created.projects[0];
    if (!project) throw Error("Missing actually created project");
    const operator = createOperatorClient(
      async (path, init) => {
        if (path === TOKEN_ROUTE)
          return Response.json({
            ok: true,
            data: { token: h.hearth.token },
            error: null,
          });
        const headers = new Headers(init?.headers);
        headers.set("Origin", h.hearth.url);
        return fetch(h.hearth.url + path, { ...init, headers });
      },
      { sessionKeys: { get: () => null, set: () => {} } },
    );
    const api = createProjectCreateApi(operator);
    const owner = new ProjectKeeperSettingsOwner({
      read: () => api.catalog(),
      post: operator.post,
    });
    owner.adopt(project.id, await api.catalog());
    let rawRoute = openProject(project.id, "project-settings");
    const data = async (path: string) => {
      const response = await operator.read(path);
      const raw: unknown = await response.json();
      if (
        !response.ok ||
        !raw ||
        typeof raw !== "object" ||
        !("ok" in raw) ||
        raw.ok !== true ||
        !("data" in raw) ||
        !("error" in raw) ||
        raw.error !== null
      )
        throw Error("Expected real protected read");
      return raw.data;
    };
    client = createKeeperClient({
      canWrite: () => true,
      requestId: () => {
        uuids++;
        return randomUUID();
      },
      scheduleSource: () => ({
        status: "live",
        routeKey: rawRoute,
        foreground: true,
      }),
      readSchedule: (id, signal) =>
        readKeeperSchedule(operator.read, id, signal),
      stream: (id) =>
        fetchTransport("/__agent-forge/projects/" + id + "/keeper/events", {
          fetch: operator.read,
        }),
      timers: { set: () => null, clear: () => {} },
      readBriefs: (id) =>
        data("/__agent-forge/projects/" + id + "/keeper/briefs"),
      read: (id, query) =>
        data(
          "/__agent-forge/projects/" +
            id +
            "/keeper?after=" +
            query.after +
            "&limit=100" +
            (query.requestId ? "&requestId=" + query.requestId : ""),
        ),
      readBriefIntent: (id, requestId) =>
        data(
          "/__agent-forge/projects/" +
            id +
            "/keeper/brief-intents" +
            (requestId ? "/" + requestId : ""),
        ),
      post: (id, action, body) =>
        actionOutcome(
          () =>
            operator.post(
              "/__agent-forge/projects/" + id + "/keeper/" + action,
              body,
            ),
          "Check the exact original.",
        ),
    });
    const keeper = client;
    const render = () =>
      ProjectKeeperSettings({
        projectId: project.id,
        archived: false,
        writesAllowed: true,
        settings: { ...owner.snapshot(), owner },
        smiths: { client: null, view: null },
        keeper,
      });
    const save = async () => {
      let entered = false;
      const settled = deferred(),
        leave = owner.subscribe((state) => {
          if (state.busy === project.id) entered = true;
          else if (entered) settled.release();
        });
      try {
        invokeNode(scheduleForm(render()), "onSubmit", { preventDefault() {} });
        expect(entered).toBe(true);
        await settled.wait;
      } finally {
        leave();
      }
    };
    let tree = render();
    invokeNode(
      findAll(tree, "select").find(
        (node) => attrs(node)["aria-label"] === "Keeper source preparation",
      ),
      "onChange",
      { currentTarget: { value: "daily" } },
    );
    tree = render();
    invokeNode(
      findAll(tree, "input").find(
        (node) => attrs(node)["aria-label"] === "Daily preparation time (UTC)",
      ),
      "onInput",
      { currentTarget: { value: "09:30" } },
    );
    await save();
    const current = await api.catalog(),
      saved = current.projects.find(
        (row) => row.id === project.id,
      )?.keeperSchedule;
    if (saved?.kind !== "daily")
      throw Error("Real schedule save was not verified");
    expect(saved.activatedAt).toBe(firstTime);
    expect(textOf(render())).toContain("Daily at 09:30 UTC");
    wall = Date.parse("2026-11-08T09:31:00.000Z");
    const tick = currentWake();
    if (!tick) throw Error("Missing actual acquired producer tick");
    armed = deferred();
    tick();
    await armed.wait;
    keeper.adoptScheduleContext({
      projectId: project.id,
      workspace: h.workspace,
      catalogRevision: current.revision,
      schedule: saved,
      routeKey: rawRoute,
      ready: true,
      archived: false,
    });
    const feedReady = deferred();
    const leaveFeed = keeper.subscribe(() => {
      if (keeper.get(project.id).live && keeper.get(project.id).loaded)
        feedReady.release();
    });
    keeper.activate(project.id);
    await keeper.flushSchedule();
    try {
      await feedReady.wait;
    } finally {
      leaveFeed();
    }
    const ticket = keeper.get(project.id).schedule?.ticket;
    if (!ticket) throw Error("Missing real due source ticket");
    expect(ticket.origin).toMatchObject({
      kind: "scheduled",
      dueAt: "2026-11-08T09:30:00.000Z",
      scheduleGeneration: saved.generation,
    });
    expect({ runs, probes, uuids }).toEqual({ runs: 0, probes: 0, uuids: 0 });
    const status = () =>
      KeeperScheduleStatusView({
        projectId: project.id,
        client: keeper,
        reviewLink: true,
      });
    await invokeNode(
      findAll(status(), "Button").find(
        (node) => textOf(node) === "Review prepared source",
      ),
      "onClick",
      {},
    );
    const original = keeper.get(project.id).briefOriginal;
    if (!original) throw Error("Missing exact original after actual Review");
    expect(original.requestId).toBe(ticket.requestId);
    expect(original.intentHash).toBe(ticket.intentHash);
    expect(original.snapshot.observed.beads).toBe(1);
    const link = findAll(status(), "Button").find(
      (node) => attrs(node)["href"] === openProject(project.id, "keeper"),
    );
    expect(textOf(link)).toContain("review and Send");
    rawRoute = openProject(project.id, "keeper");
    keeper.scheduleSourceChanged("hash");
    keeper.adoptScheduleContext({
      projectId: project.id,
      workspace: h.workspace,
      catalogRevision: current.revision,
      schedule: saved,
      routeKey: rawRoute,
      ready: true,
      archived: false,
    });
    await keeper.flushSchedule();
    expect(keeper.canCommitBrief(project.id)).toBe(true);
    expect(await keeper.commitBrief(project.id)).toBe(true);
    await providerEntered.wait;
    expect(runs).toBe(1);
    expect(uuids).toBe(0);
    invokeNode(
      findAll(render(), "select").find(
        (node) => attrs(node)["aria-label"] === "Keeper source preparation",
      ),
      "onChange",
      { currentTarget: { value: "off" } },
    );
    await save();
    const offCatalog = await api.catalog();
    keeper.adoptScheduleContext({
      projectId: project.id,
      workspace: h.workspace,
      catalogRevision: offCatalog.revision,
      schedule: { kind: "off" },
      routeKey: rawRoute,
      ready: true,
      archived: false,
    });
    await keeper.flushSchedule();
    expect(keeper.get(project.id).schedule?.phase).toBe("off");
    expect(keeper.canCommitBrief(project.id)).toBe(false);
    await keeper.reviewScheduledBrief(project.id);
    expect(keeper.get(project.id).briefOriginal?.intentHash).toBe(
      ticket.intentHash,
    );
    const probeCount = probes;
    const replay = await operator.post(
      "/__agent-forge/projects/" + project.id + "/keeper/briefs",
      {
        requestId: ticket.requestId,
        expectedRevision: ticket.expectedRevision,
        intentHash: ticket.intentHash,
      },
    );
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      ok: true,
      data: {
        turn: { requestId: ticket.requestId, hash: ticket.preparedTurnHash },
      },
      error: null,
    });
    expect({ runs, probes, uuids }).toEqual({
      runs: 1,
      probes: probeCount,
      uuids: 0,
    });
    const terminal = deferred();
    const leaveTerminal = keeper.subscribe(() => {
      const state = keeper.get(project.id),
        turn = state.page?.turns.find(
          (row) => row.requestId === ticket.requestId,
        );
      if (
        turn &&
        !["accepted", "running", "cancelling"].includes(turn.phase) &&
        !state.briefsLoading
      )
        terminal.release();
    });
    try {
      providerRelease.release();
      await terminal.wait;
    } finally {
      leaveTerminal();
    }
    expect(
      keeper
        .get(project.id)
        .page?.turns.find((row) => row.requestId === ticket.requestId)?.phase,
    ).toBe("completed");
    keeper.dispose();
    await h.hearth.close();
    const persisted = createConversationStore(h.home).read(project.id),
      generated = keeperBriefs(persisted).latest;
    expect(persisted.turns).toHaveLength(1);
    expect(persisted.turns[0]?.phase).toBe("completed");
    if (!generated)
      throw Error("Missing confirmed generated brief after deliberate Send");
    expect(
      textOf(KeeperBriefCard({ brief: generated, client: keeper })),
    ).toContain("One reviewed scheduled source.");
    expect(
      createProjectStore(h.home)
        .read()
        .projects.find((row) => row.id === project.id)?.keeperSchedule,
    ).toEqual({ kind: "off" });
  } finally {
    providerRelease.release();
    client?.dispose();
    await h.close();
  }
});
