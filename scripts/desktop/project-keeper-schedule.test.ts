import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ProjectKeeperSettingsOwner } from "../../apps/desktop/src/project-keeper-settings-client";
import { NotSent, type OperatorPost } from "../../docs/js/operator";
import type {
  KeeperScheduleInput,
  KeeperScheduleSaved,
} from "../keeper/brief-schedule";
import { projectKeeperMutationWithScheduleRequestSchema } from "../projects/project-keeper-protocol";
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
