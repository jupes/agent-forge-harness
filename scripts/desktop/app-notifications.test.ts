import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createAppNotificationClient,
  createAppNotificationSender,
} from "../../apps/desktop/src/app-notifications-client";
import { writeOwnerOnly } from "../hearth/token";
import {
  appInterruptionAllowed,
  appNotificationPolicySchema,
} from "../projects/app-notifications-protocol";
import {
  appNotificationSettingsPath,
  createAppNotificationStore,
} from "../projects/app-notifications-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!basename(root).startsWith("forge-app-notifications-"))
      throw Error("Unexpected fixture root");
    rmSync(root, { recursive: true, force: true });
  }
});
function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-app-notifications-"));
  roots.push(root);
  const home = join(root, "home");
  return { home, store: createAppNotificationStore(home) };
}
const policy = { enabled: true, quietHours: null };
const settings = (revision = 0, enabled = true) => ({
  version: 1 as const,
  revision,
  policy: { enabled, quietHours: null },
  source: revision === 0 ? ("default" as const) : ("machine" as const),
});
test("app quiet hours are half-open local intervals including overnight", () => {
  const local = (minute: number) =>
    new Date(2026, 10, 9, Math.floor(minute / 60), minute % 60);
  const daytime = {
    enabled: true,
    quietHours: { startMinute: 600, endMinute: 720 },
  };
  for (const [time, allowed] of [
    [599, true],
    [600, false],
    [719, false],
    [720, true],
  ] as const)
    expect(appInterruptionAllowed(daytime, local(time))).toBe(allowed);
  const overnight = {
    enabled: true,
    quietHours: { startMinute: 1320, endMinute: 480 },
  };
  for (const [time, allowed] of [
    [1319, true],
    [1320, false],
    [0, false],
    [479, false],
    [480, true],
  ] as const)
    expect(appInterruptionAllowed(overnight, local(time))).toBe(allowed);
  expect(appInterruptionAllowed({ enabled: false, quietHours: null })).toBe(
    false,
  );
  expect(appInterruptionAllowed(policy, new Date(NaN))).toBe(false);
  expect(
    appNotificationPolicySchema.safeParse({
      enabled: true,
      quietHours: { startMinute: 12, endMinute: 12 },
    }).success,
  ).toBe(false);
});
test("machine policy survives reopen and stale or concurrent writes cannot overwrite", async () => {
  const { home, store } = storeFixture();
  expect(store.read()).toEqual(settings());
  const saved = await store.write({
    expectedRevision: 0,
    policy: {
      enabled: false,
      quietHours: { startMinute: 1320, endMinute: 480 },
    },
  });
  expect(saved.revision).toBe(1);
  expect(createAppNotificationStore(home).read()).toEqual(saved);
  const bytes = readFileSync(appNotificationSettingsPath(home), "utf8");
  await expect(
    store.write({ expectedRevision: 0, policy }),
  ).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(appNotificationSettingsPath(home), "utf8")).toBe(bytes);
  const writes = await Promise.allSettled([
    store.write({ expectedRevision: 1, policy }),
    createAppNotificationStore(home).write({
      expectedRevision: 1,
      policy: { enabled: false, quietHours: null },
    }),
  ]);
  expect(writes.map((v) => v.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(store.read().revision).toBe(2);
});
test("missing initialized or malformed policy never becomes default-on", async () => {
  for (const mode of ["missing", "malformed", "provenance"]) {
    const { home, store } = storeFixture();
    await store.write({
      expectedRevision: 0,
      policy: { enabled: false, quietHours: null },
    });
    if (mode === "missing") rmSync(appNotificationSettingsPath(home));
    if (mode === "malformed")
      writeOwnerOnly(appNotificationSettingsPath(home), "{");
    if (mode === "provenance")
      writeOwnerOnly(
        appNotificationSettingsPath(home),
        JSON.stringify(settings()),
      );
    expect(() => store.read()).toThrow();
    await expect(
      store.write({ expectedRevision: 1, policy }),
    ).rejects.toMatchObject({ status: 503 });
  }
});
test("client confirms exact save and readback before clearing its draft", async () => {
  let value = settings(),
    posts = 0;
  const client = createAppNotificationClient({
    canWrite: () => true,
    changed: () => {},
    read: async () => value,
    post: async (raw) => {
      posts++;
      const body = raw as { expectedRevision: number; policy: typeof policy };
      value = { ...settings(1), policy: body.policy };
      return Response.json({ ok: true, data: value, error: null });
    },
  });
  await client.check();
  client.edit({ enabled: false, quietHours: null });
  await client.save();
  expect(posts).toBe(1);
  expect(client.state.current?.revision).toBe(1);
  expect(client.state.draft).toBeNull();
  expect(client.state.unknownRevision).toBeNull();
});
test("lost save stays held until newer revision fences the old CAS", async () => {
  let value = settings(),
    posts = 0;
  const client = createAppNotificationClient({
    canWrite: () => true,
    changed: () => {},
    read: async () => value,
    post: async () => {
      posts++;
      throw Error("Lost");
    },
  });
  await client.check();
  client.edit({ enabled: false, quietHours: null });
  await client.save();
  await client.save();
  expect(posts).toBe(1);
  await client.check();
  expect(client.state.unknownRevision).toBe(0);
  value = settings(1, false);
  await client.check();
  expect(client.state.unknownRevision).toBeNull();
  expect(client.state.draft?.enabled).toBe(false);
});
test("invalid draft or stale receipt cannot dispatch or clear a pending draft", async () => {
  let posts = 0;
  const client = createAppNotificationClient({
    canWrite: () => true,
    changed: () => {},
    read: async () => settings(),
    post: async () => {
      posts++;
      return Response.json({ ok: true, data: settings(), error: null });
    },
  });
  await client.check();
  client.edit({ enabled: true, quietHours: { startMinute: 0, endMinute: 0 } });
  await client.save();
  expect(posts).toBe(0);
  client.edit({ enabled: false, quietHours: null });
  await client.save();
  expect(posts).toBe(1);
  expect(client.state.unknownRevision).toBe(0);
  expect(client.state.draft?.enabled).toBe(false);
});
test("real delivery sender holds off quiet unavailable or late policy and only calls native when permitted", async () => {
  let raw: unknown = settings(),
    current = true,
    sends = 0,
    resolve!: (value: unknown) => void,
    read = () => Promise.resolve(raw);
  const notices: string[] = [];
  const send = createAppNotificationSender({
    read: () => read(),
    current: () => current,
    status: (text) => notices.push(text),
    sendNative: () => {
      sends++;
      return () => {};
    },
    now: () => new Date(2026, 10, 9, 23, 0),
  });
  const notification = {
    title: "Fixture",
    body: "Inspect",
    tag: "id",
    open: async () => {},
    beforeNative: async () => true,
  };
  raw = settings(1, false);
  expect(await send(notification)).toBeNull();
  raw = {
    ...settings(1),
    policy: {
      enabled: true,
      quietHours: { startMinute: 1320, endMinute: 480 },
    },
  };
  expect(await send(notification)).toBeNull();
  raw = { bad: true };
  expect(await send(notification)).toBeNull();
  expect(sends).toBe(0);
  raw = settings(2, true);
  expect(await send(notification)).toBeFunction();
  expect(sends).toBe(1);
  read = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = send(notification);
  current = false;
  resolve(settings(2, true));
  expect(await pending).toBeNull();
  expect(sends).toBe(1);
  expect(notices.some((text) => text.includes("unavailable"))).toBe(true);
});

test("actual policy sender revalidates project opt-out archive and removed source after a held read", async () => {
  const { createProjectEventNotifications } = await import(
    "../../apps/desktop/src/project-event-notifications"
  );
  const { emptyActivityFilters } = await import(
    "../../apps/desktop/src/project-activity-model"
  );
  for (const mode of ["off", "archive", "source", "allowed"]) {
    const scope = {
      projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
      workspace: "/fixture/workspace",
    };
    const project = {
      id: scope.projectId,
      name: "Fixture",
      archived: false,
      workspaces: [{ root: scope.workspace }],
      notifications: {
        "stopped-shift": true,
        "failed-gate": true,
        "council-verdict": true,
        "bead-approval": true,
      },
    };
    const event = {
      id: 11,
      ulid: "00000000000000000000000011",
      at: "2026-11-09T18:00:00.000Z",
      kind: "gate.ran" as const,
      actor: null,
      beadId: "epic.1",
      sessionId: null,
      runId: null,
      summary: "Gate failed",
      metadata: [{ key: "passed", value: false }],
    };
    let ready = false,
      sourceGone = false,
      native = 0,
      detailReads = 0,
      release!: (value: unknown) => void,
      started!: () => void;
    const policyStarted = new Promise<void>((r) => {
      started = r;
    });
    const send = createAppNotificationSender({
      read: () => {
        started();
        return new Promise((r) => {
          release = r;
        });
      },
      current: () => true,
      status: () => {},
      sendNative: () => {
        native++;
        return () => {};
      },
    });
    const owner = createProjectEventNotifications({
      scope,
      current: () => true,
      streamCursor: () => 10,
      catalog: async () => ({ projects: [project] }),
      send,
      navigate: () => {},
      status: () => {},
      read: async (path) => {
        if (path.endsWith("/11")) {
          detailReads++;
          if (sourceGone) throw Error("Membership revoked");
          return { ...scope, asOf: event.at, event };
        }
        return {
          ...scope,
          asOf: event.at,
          filters: {
            ...emptyActivityFilters(),
            kinds: ["gate.ran", "council.run.finished", "bead.transitioned"],
          },
          after: 10,
          nextAfter: ready ? 11 : 10,
          more: false,
          events: ready ? [event] : [],
          membershipComplete: true,
          problems: [],
        };
      },
    });
    await owner.refresh(true);
    ready = true;
    const pending = owner.refresh();
    await policyStarted;
    expect(detailReads).toBe(1);
    expect(native).toBe(0);
    if (mode === "off") project.notifications["failed-gate"] = false;
    if (mode === "archive") project.archived = true;
    if (mode === "source") sourceGone = true;
    release(settings(1, true));
    await pending;
    expect(native).toBe(mode === "allowed" ? 1 : 0);
    expect(detailReads).toBe(2);
    owner.dispose();
  }
});
test("inconsistent policy source revision or default values cannot permit native delivery", async () => {
  const { appNotificationSettingsSchema } = await import(
    "../projects/app-notifications-protocol"
  );
  for (const raw of [
    { ...settings(), revision: 1 },
    { ...settings(), policy: { enabled: false, quietHours: null } },
    { ...settings(1), revision: 0 },
  ])
    expect(appNotificationSettingsSchema.safeParse(raw).success).toBe(false);
});
