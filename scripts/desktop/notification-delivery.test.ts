import { afterEach, expect, test } from "bun:test";
import { managedShiftSelection } from "../../apps/desktop/src/managed-shift-navigation";
import {
  createHaltNotificationDelivery,
  type HaltNotification,
  sendWebNotification,
} from "../../apps/desktop/src/notification-delivery";
import { projectShiftInputHash } from "../../apps/desktop/src/project-shift-identities";
import type {
  ProjectShiftReceipt,
  ProjectShiftsPage,
} from "../../types/project-shifts";
import type { ProjectCatalog } from "../../types/projects";
import { NO_PROJECT_NOTIFICATIONS } from "../projects/project-notifications-protocol";

const scope = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: "/fixture/workspace",
};
const iso = "2026-11-09T01:00:00.000Z";
async function receipt(
  phase: "running" | "stopped" = "running",
  reason: string | null = null,
): Promise<ProjectShiftReceipt> {
  const request = {
    requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
    expectedCatalogRevision: 1,
    options: {
      for: "2h",
      concurrency: 1,
      maxBeads: 2,
      maxUsd: 5,
      repairs: 1,
      base: "master",
    },
  };
  return {
    intent: {
      ...scope,
      shiftId: "shift-20261109-010000-1234",
      request,
      requestHash: await projectShiftInputHash(scope, request),
      createdAt: iso,
      attemptedAt: iso,
    },
    observation: {
      shiftId: "shift-20261109-010000-1234",
      requestId: request.requestId,
      phase,
      reason,
      actual: {
        startedAt: iso,
        endedAt: phase === "stopped" ? iso : null,
        deadline: iso,
        concurrency: 1,
        forMs: 7200000,
        maxBeads: 2,
        maxUsd: 5,
        repairs: 1,
        throttle: null,
        base: "master",
        epic: null,
        smith: null,
        runTimeoutMs: null,
        spentUsd: 0,
        unpriced: 0,
        admitted: 0,
        reviewed: 0,
        running: 0,
        halted: phase === "stopped" ? 1 : 0,
      },
    },
  };
}
async function fixture() {
  let page: ProjectShiftsPage = {
    projectId: scope.projectId,
    asOf: iso,
    items: [await receipt()],
  };
  let current = true,
    throws = false,
    closed = 0;
  let hold: Promise<void> | null = null;
  const catalog: ProjectCatalog = {
    version: 1,
    revision: 1,
    projects: [
      {
        id: scope.projectId,
        slug: "example",
        name: "Example",
        description: "",
        icon: "anvil",
        workspaces: [{ root: scope.workspace, repositories: [], epicIds: [] }],
        notifications: { ...NO_PROJECT_NOTIFICATIONS, "stopped-shift": true },
        pinned: false,
        archived: false,
        createdAt: iso,
        updatedAt: iso,
      },
    ],
  };
  const sends: HaltNotification[] = [],
    paths: string[] = [],
    messages: string[] = [],
    navigations: string[] = [];
  const delivery = createHaltNotificationDelivery({
    scope,
    current: () => current,
    catalog: async () => {
      if (hold) await hold;
      if (throws) throw Error("unavailable");
      return structuredClone(catalog);
    },
    read: async (path) => {
      paths.push(path);
      return structuredClone(
        path.includes("/requests/") ? page.items[0] : page,
      );
    },
    send: (n) => {
      sends.push(n);
      return () => {
        closed++;
      };
    },
    navigate: (href) => navigations.push(href),
    status: (text) => messages.push(text),
  });
  return {
    delivery,
    catalog,
    sends,
    paths,
    messages,
    navigations,
    get closed() {
      return closed;
    },
    setPage: (value: ProjectShiftsPage) => {
      page = value;
    },
    halt: async (reason = "halted") => {
      page.items = [await receipt("stopped", reason)];
    },
    current: (value: boolean) => {
      current = value;
    },
    fail: (value: boolean) => {
      throws = value;
    },
    hold: (value: Promise<void> | null) => {
      hold = value;
    },
  };
}
test("canonical running to halted transition delivers once and Open verifies exact original before navigation", async () => {
  const f = await fixture();
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(0);
  await f.halt();
  await f.delivery.refresh();
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0]?.body).toContain("Example");
  await f.sends[0]!.open();
  expect(f.paths.at(-1)).toEndWith(
    "/requests/2230bb02-1119-4c69-adad-c44116b375c1",
  );
  expect(managedShiftSelection(f.navigations[0]!).selection).toEqual({
    projectId: scope.projectId,
    requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
    sessionId: null,
  });
  f.delivery.dispose();
  expect(f.closed).toBe(1);
});
test("initial and reconnect reads baseline historical halts without delivery", async () => {
  const f = await fixture();
  await f.halt();
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(0);
  const g = await fixture();
  await g.delivery.refresh();
  await g.halt();
  await g.delivery.refresh(true);
  expect(g.sends).toHaveLength(0);
});
for (const mode of [
  "off",
  "archived",
  "foreign-workspace",
  "normal-stop",
  "foreign-page",
  "changed-hash",
] as const) {
  test(`${mode} cannot generate an interruption`, async () => {
    const f = await fixture();
    await f.delivery.refresh();
    await f.halt();
    if (mode === "off")
      f.catalog.projects[0]!.notifications!["stopped-shift"] = false;
    if (mode === "archived") f.catalog.projects[0]!.archived = true;
    if (mode === "foreign-workspace")
      f.catalog.projects[0]!.workspaces[0]!.root = "/another";
    if (mode === "normal-stop") await f.halt("completed");
    if (mode === "foreign-page")
      f.setPage({ projectId: "other", asOf: iso, items: [] });
    if (mode === "changed-hash") {
      const row = await receipt("stopped", "halted");
      row.intent.requestHash = "a".repeat(64);
      f.setPage({ projectId: scope.projectId, asOf: iso, items: [row] });
    }
    await f.delivery.refresh();
    expect(f.sends).toHaveLength(0);
    if (mode === "off") {
      f.catalog.projects[0]!.notifications!["stopped-shift"] = true;
      await f.delivery.refresh();
      expect(f.sends).toHaveLength(0);
    }
  });
}
test("disposal and raw connection invalidation fence late catalog reads", async () => {
  for (const dispose of [true, false]) {
    const f = await fixture();
    await f.delivery.refresh();
    await f.halt();
    let release!: () => void;
    f.hold(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const pending = f.delivery.refresh();
    if (dispose) f.delivery.dispose();
    else f.current(false);
    release();
    await pending;
    expect(f.sends).toHaveLength(0);
  }
});
test("read failures recover with a baseline and never replay the missed halt", async () => {
  const f = await fixture();
  await f.delivery.refresh();
  f.fail(true);
  await f.halt();
  await f.delivery.refresh();
  expect(f.messages.at(-1)).toContain("verified project data");
  f.fail(false);
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(0);
});
test("Open refuses changed or unavailable targets and paused owners", async () => {
  for (const mode of ["changed", "deleted", "paused"]) {
    const f = await fixture();
    await f.delivery.refresh();
    await f.halt();
    await f.delivery.refresh();
    if (mode === "changed") {
      const row = await receipt("stopped", "halted");
      row.intent.shiftId = row.observation.shiftId =
        "shift-20261109-020000-5678";
      f.setPage({ projectId: scope.projectId, asOf: iso, items: [row] });
    }
    if (mode === "deleted") f.catalog.projects = [];
    if (mode === "paused") f.current(false);
    await f.sends[0]!.open();
    expect(f.navigations).toHaveLength(0);
  }
});
const originalNotification = Object.getOwnPropertyDescriptor(
  globalThis,
  "Notification",
);
afterEach(() => {
  if (originalNotification)
    Object.defineProperty(globalThis, "Notification", originalNotification);
  else Reflect.deleteProperty(globalThis, "Notification");
});
test("production adapter calls native constructor and treats requested, shown, error and click separately", async () => {
  let opened = 0;
  const statuses: string[] = [],
    constructions: unknown[] = [];
  class FakeNative {
    static permission = "granted";
    onshow: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclick: (() => void) | null = null;
    closes = 0;
    constructor(title: string, options: unknown) {
      constructions.push([title, options]);
      instance = this;
    }
    close() {
      this.closes++;
    }
  }
  let instance!: FakeNative;
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: FakeNative,
  });
  const close = sendWebNotification(
    {
      title: "Halted",
      body: "Inspect",
      tag: "id",
      open: async () => {
        opened++;
      },
    },
    (text) => statuses.push(text),
  );
  expect(constructions).toEqual([["Halted", { body: "Inspect", tag: "id" }]]);
  expect(statuses.at(-1)).toContain("requested");
  instance.onshow!();
  expect(statuses.at(-1)).toContain("reported");
  instance.onerror!();
  expect(statuses.at(-1)).toContain("unconfirmed");
  instance.onclick!();
  expect(opened).toBe(1);
  close();
  expect(instance.onclick).toBeNull();
  expect(instance.closes).toBe(2);
  FakeNative.permission = "denied";
  expect(() =>
    sendWebNotification(
      { title: "", body: "", tag: "", open: async () => {} },
      () => {},
    ),
  ).toThrow();
  expect(constructions).toHaveLength(1);
});

test("raw source binder permanently retires held reads and Open on A to B to A", async () => {
  const { bindNotificationSources, createNotificationEpoch } = await import(
    "../../apps/desktop/src/notification-delivery"
  );
  for (const kind of ["hash", "status", "pause"]) {
    const fence = createNotificationEpoch();
    fence.adopt("A");
    const f = await fixture();
    const owned = fence.capture();
    // The same production capture is checked by the owner current gate.
    const pendingNative: HaltNotification[] = [];
    let page = {
      projectId: scope.projectId,
      asOf: iso,
      items: [await receipt()],
    };
    const owner = createHaltNotificationDelivery({
      scope,
      current: owned,
      catalog: async () => f.catalog,
      read: async () => page,
      send: (n) => {
        pendingNative.push(n);
        return () => {};
      },
      navigate: () => {},
      status: () => {},
    });
    let hash!: () => void,
      stream!: () => void,
      state = "live",
      leaves = 0;
    const unbind = bindNotificationSources(
      {
        status: () => state,
        onHash: (cb) => {
          hash = cb;
          return () => {
            leaves++;
          };
        },
        onStatus: (cb) => {
          stream = cb;
          return () => {
            leaves++;
          };
        },
      },
      () => fence.invalidate(),
    );
    await owner.refresh();
    page = { ...page, items: [await receipt("stopped", "halted")] };
    const pending = owner.refresh();
    if (kind === "hash") {
      hash();
      hash();
    }
    if (kind === "status") {
      state = "reconnecting";
      stream();
      state = "live";
      stream();
    }
    if (kind === "pause") {
      fence.invalidate();
      fence.adopt("paused");
      fence.adopt("A");
    }
    await pending;
    expect(owned()).toBe(false);
    expect(pendingNative).toHaveLength(0);
    unbind();
    expect(leaves).toBe(2);
    const next = fence.capture();
    hash();
    stream();
    expect(next()).toBe(true);
    owner.dispose();
  }
});
test("held permission answers cannot enable a paused or replaced window scope", async () => {
  const { createNotificationEpoch, requestNotificationPermission } =
    await import("../../apps/desktop/src/notification-delivery");
  const fence = createNotificationEpoch();
  fence.adopt("A");
  let requests = 0,
    resolve!: (permission: NotificationPermission) => void;
  const permission = requestNotificationPermission(
    {
      permission: "default",
      requestPermission: () => {
        requests++;
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    fence.capture(),
  );
  fence.adopt("B");
  fence.adopt("A");
  resolve("granted");
  expect(await permission).toBeNull();
  expect(requests).toBe(1);
  expect(
    await requestNotificationPermission(
      {
        permission: "denied",
        requestPermission: async () => {
          requests++;
          return "granted";
        },
      },
      fence.capture(),
    ),
  ).toBe("denied");
  expect(requests).toBe(1);
});
test("production bounded-read wrapper rejects an oversized receiving body before parsing", async () => {
  const { createNotificationRead } = await import(
    "../../apps/desktop/src/use-notification-delivery"
  );
  const { createOperatorClient } = await import("../../docs/js/operator");
  let cancelled = 0;
  const client = createOperatorClient(
    async (path) => {
      if (path.endsWith("/token"))
        return Response.json({
          ok: true,
          data: { token: "fixture" },
          error: null,
        });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1_048_577));
          },
          cancel() {
            cancelled++;
          },
        }),
      );
    },
    { sessionKeys: { get: () => null, set: () => {} }, timeoutMs: 1000 },
  );
  await expect(
    createNotificationRead(client.read)("/__agent-forge/projects"),
  ).rejects.toThrow("byte limit");
  expect(cancelled).toBe(1);
});

test("an Open already reading cannot navigate after scope ABA", async () => {
  const { createNotificationEpoch } = await import(
    "../../apps/desktop/src/notification-delivery"
  );
  const fence = createNotificationEpoch();
  fence.adopt("A");
  const current = fence.capture();
  const f = await fixture();
  let row = await receipt();
  let release!: () => void;
  let hold: Promise<void> | null = null;
  const sends: HaltNotification[] = [],
    navigations: string[] = [];
  const owner = createHaltNotificationDelivery({
    scope,
    current,
    catalog: async () => f.catalog,
    read: async (path) => {
      if (path.includes("/requests/")) {
        if (hold) await hold;
        return row;
      }
      return { projectId: scope.projectId, asOf: iso, items: [row] };
    },
    send: (n) => {
      sends.push(n);
      return () => {};
    },
    navigate: (href) => navigations.push(href),
    status: () => {},
  });
  await owner.refresh();
  row = await receipt("stopped", "halted");
  await owner.refresh();
  expect(sends).toHaveLength(1);
  hold = new Promise<void>((r) => {
    release = r;
  });
  const open = sends[0]!.open();
  fence.adopt("B");
  fence.adopt("A");
  release();
  await open;
  expect(navigations).toHaveLength(0);
  owner.dispose();
});
