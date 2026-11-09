import { expect, test } from "bun:test";
import type {
  HaltNotification,
  NotificationCatalog,
} from "../../apps/desktop/src/notification-delivery";
import { emptyActivityFilters } from "../../apps/desktop/src/project-activity-model";
import {
  createProjectEventNotifications,
  NOTIFICATION_ACTIVITY_KINDS,
  notificationEventKind,
} from "../../apps/desktop/src/project-event-notifications";
import type { ProjectActivityEvent } from "../../types/project-activity";
import type { ProjectBead } from "../../types/project-beads";
import { NO_PROJECT_NOTIFICATIONS } from "../projects/project-notifications-protocol";

const scope = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: "/fixture/workspace",
};
const iso = "2026-11-09T18:00:00.000Z";
function event(
  id: number,
  kind: ProjectActivityEvent["kind"] = "gate.ran",
  value: string | boolean = false,
): ProjectActivityEvent {
  return {
    id,
    ulid: String(id).padStart(26, "0"),
    at: iso,
    kind,
    actor: null,
    beadId: "epic.1",
    sessionId: null,
    runId: null,
    summary: "Fixture event",
    metadata: [
      {
        key:
          kind === "gate.ran"
            ? "passed"
            : kind === "council.run.finished"
              ? "outcome"
              : "to",
        value,
      },
    ],
  };
}
const bead: ProjectBead = {
  id: "epic.1",
  title: "Approve me",
  type: "task",
  status: "open",
  priority: 2,
  parent: null,
  assignee: null,
  owner: null,
  labels: ["project:example"],
  createdAt: iso,
  updatedAt: iso,
  due: null,
  description: "",
  acceptanceCriteria: "",
  estimate: null,
  spent: null,
  ready: false,
  blocked: false,
  blockers: [],
  unavailableBlockers: 0,
  queue: "proposed",
  smith: null,
  comments: [],
  commentsComplete: false,
  detailsLoaded: false,
  fileMap: null,
  fileMapReason: null,
  reservations: null,
  activity: null,
  activityComplete: false,
};
function fixture() {
  let events: ProjectActivityEvent[] = [],
    cursor = 10,
    current = true,
    fail = false,
    wrong = "",
    closed = 0;
  let hold: Promise<void> | null = null;
  const project = {
    id: scope.projectId,
    name: "Example",
    archived: false,
    workspaces: [{ root: scope.workspace }],
    notifications: {
      ...NO_PROJECT_NOTIFICATIONS,
      "failed-gate": true,
      "council-verdict": true,
      "bead-approval": true,
    },
  };
  const catalog: NotificationCatalog = { projects: [project] },
    beads = [structuredClone(bead)];
  const sends: HaltNotification[] = [],
    paths: string[] = [],
    navigations: string[] = [],
    messages: string[] = [];
  const delivery = createProjectEventNotifications({
    scope,
    current: () => current,
    streamCursor: () => cursor,
    catalog: async () => catalog,
    read: async (path) => {
      paths.push(path);
      if (hold) await hold;
      if (fail) throw Error("Unavailable");
      if (path.endsWith("/beads"))
        return {
          projectId: scope.projectId,
          workspace: scope.workspace,
          asOf: iso,
          complete: true,
          problems: [],
          beads,
          dependencies: [],
        };
      const last = path.split("/").at(-1)!;
      if (/^\d+$/.test(last) && wrong === "detail")
        throw Error("Source membership was revoked");
      if (/^\d+$/.test(last))
        return {
          projectId: scope.projectId,
          workspace: wrong === "workspace" ? "/foreign" : scope.workspace,
          asOf: iso,
          event: events.find((row) => row.id === Number(last)),
        };
      const after = Number(
        new URL(path, "http://fixture").searchParams.get("after"),
      );
      return {
        projectId: wrong === "project" ? "other" : scope.projectId,
        workspace: wrong === "workspace" ? "/foreign" : scope.workspace,
        asOf: iso,
        filters: {
          ...emptyActivityFilters(),
          kinds: wrong === "filters" ? [] : [...NOTIFICATION_ACTIVITY_KINDS],
        },
        after: wrong === "cursor" ? after + 1 : after,
        nextAfter: events.filter((row) => row.id > after).at(-1)?.id ?? after,
        more: wrong === "overflow",
        events: events.filter((row) => row.id > after),
        membershipComplete: true,
        problems: [],
      };
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
    project,
    catalog,
    beads,
    sends,
    paths,
    navigations,
    messages,
    get closed() {
      return closed;
    },
    events: (rows: ProjectActivityEvent[]) => {
      events = rows;
    },
    cursor: (id: number) => {
      cursor = id;
    },
    current: (value: boolean) => {
      current = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    wrong: (value: string) => {
      wrong = value;
    },
    hold: (value: Promise<void> | null) => {
      hold = value;
    },
  };
}
test("three canonical event kinds use native consumer, deduplicate, and Open exact source only", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.events([
    event(11),
    event(12, "council.run.finished", "pass"),
    event(13, "bead.transitioned", "proposed"),
  ]);
  await f.delivery.refresh();
  await f.delivery.refresh();
  expect(f.sends.map((row) => row.title)).toEqual([
    "Agent Forge · Gate failed",
    "Agent Forge · Council verdict",
    "Agent Forge · Bead awaiting approval",
  ]);
  await f.sends[0]!.open();
  await f.sends[2]!.open();
  expect(f.paths).toContain(`/projects/${scope.projectId}/activity/11`);
  expect(f.navigations[0]).toContain("selectionId=11");
  expect(f.navigations[1]).toContain("selectionId=epic.1");
  f.delivery.dispose();
  expect(f.closed).toBe(3);
});
test("historical events and reconnects establish stream cursor baseline", async () => {
  const f = fixture();
  f.events([event(9)]);
  await f.delivery.refresh(true);
  expect(f.sends).toHaveLength(0);
  f.events([event(11)]);
  f.cursor(20);
  await f.delivery.refresh(true);
  expect(f.sends).toHaveLength(0);
});
test("event classification rejects pass chatter cancellations and malformed metadata", () => {
  expect(notificationEventKind(event(11, "gate.ran", true))).toBeNull();
  expect(
    notificationEventKind(event(11, "council.run.finished", "cancelled")),
  ).toBeNull();
  expect(
    notificationEventKind(event(11, "bead.transitioned", "approved")),
  ).toBeNull();
  expect(notificationEventKind(event(11, "tool.called", false))).toBeNull();
  for (const outcome of ["pass", "fail", "unreadable"])
    expect(
      notificationEventKind(event(11, "council.run.finished", outcome)),
    ).toBe("council-verdict");
});
for (const wrong of ["project", "workspace", "filters", "cursor", "overflow"])
  test(`${wrong} source is unavailable without native publication`, async () => {
    const f = fixture();
    await f.delivery.refresh(true);
    f.events([event(11)]);
    f.wrong(wrong);
    await f.delivery.refresh();
    expect(f.sends).toHaveLength(0);
    expect(f.messages.at(-1)).toContain("unavailable");
  });
test("project preference opt-out consumes events and does not replay after enabling", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.project.notifications["failed-gate"] = false;
  f.events([event(11)]);
  await f.delivery.refresh();
  f.project.notifications["failed-gate"] = true;
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(0);
});
test("archived missing and foreign membership suppress native publication", async () => {
  for (const mode of ["archived", "deleted", "foreign"]) {
    const f = fixture();
    await f.delivery.refresh(true);
    f.events([event(11)]);
    if (mode === "archived") f.project.archived = true;
    if (mode === "deleted") f.catalog.projects = [];
    if (mode === "foreign") f.project.workspaces = [{ root: "/other" }];
    await f.delivery.refresh();
    expect(f.sends).toHaveLength(0);
  }
});
test("approval delivery and Open require a currently backed proposed queue item", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.events([event(11, "bead.transitioned", "proposed")]);
  f.beads[0]!.queue = "approved";
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(0);
  const g = fixture();
  await g.delivery.refresh(true);
  g.events([event(11, "bead.transitioned", "proposed")]);
  await g.delivery.refresh();
  expect(g.sends).toHaveLength(1);
  g.beads[0]!.queue = null;
  await g.sends[0]!.open();
  expect(g.navigations).toHaveLength(0);
});
test("Open refuses mutated exact event, late source, and disposed owner", async () => {
  for (const mode of ["mutated", "late", "closed"]) {
    const f = fixture();
    await f.delivery.refresh(true);
    f.events([event(11)]);
    await f.delivery.refresh();
    expect(f.sends).toHaveLength(1);
    if (mode === "mutated") f.events([{ ...event(11), ulid: "0".repeat(26) }]);
    if (mode === "closed") f.delivery.dispose();
    let release!: () => void;
    if (mode === "late")
      f.hold(
        new Promise<void>((r) => {
          release = r;
        }),
      );
    const open = f.sends[0]!.open();
    if (mode === "late") {
      f.current(false);
      release();
    }
    await open;
    expect(f.navigations).toHaveLength(0);
  }
});
test("overlapping reads are coalesced and resync invalidates a held batch", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.events([event(11)]);
  let release!: () => void;
  f.hold(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const pending = f.delivery.refresh();
  f.cursor(20);
  const resync = f.delivery.refresh(true);
  f.hold(null);
  release();
  await Promise.all([pending, resync]);
  expect(f.sends).toHaveLength(0);
  expect(f.paths.length).toBe(3);
});
test("error recovery does not replay missed events", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.fail(true);
  await f.delivery.refresh();
  f.fail(false);
  f.events([event(11)]);
  f.cursor(11);
  await f.delivery.refresh();
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(0);
});
test("duplicate ULIDs and invalid metadata cannot publish", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.events([event(11), { ...event(12), ulid: event(11).ulid }]);
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(0);
  const g = fixture();
  await g.delivery.refresh(true);
  g.events([
    {
      ...event(11),
      metadata: [
        { key: "passed", value: false },
        { key: "passed", value: true },
      ],
    },
  ]);
  await g.delivery.refresh();
  expect(g.sends).toHaveLength(0);
});

test("fresh exact-source refusal prevents a staged event from notifying", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.events([event(11)]);
  let release!: () => void;
  f.hold(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const pending = f.delivery.refresh();
  f.wrong("detail");
  f.hold(null);
  release();
  await pending;
  expect(f.sends).toHaveLength(0);
  expect(f.messages.at(-1)).toContain("unavailable");
});
test("a changed backed approval queue before delivery suppresses its interruption", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.events([event(11, "bead.transitioned", "proposed")]);
  let release!: () => void;
  f.hold(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const pending = f.delivery.refresh();
  f.beads[0]!.queue = "approved";
  f.hold(null);
  release();
  await pending;
  expect(f.sends).toHaveLength(0);
});
test("more than32 eligible interruptions fails closed without a native burst", async () => {
  const f = fixture();
  await f.delivery.refresh(true);
  f.events(Array.from({ length: 33 }, (_, i) => event(i + 11)));
  await f.delivery.refresh();
  expect(f.sends).toHaveLength(0);
  expect(f.messages.at(-1)).toContain("unavailable");
});
