import { expect, test } from "bun:test";
import { createProjectActivityClient } from "../../apps/desktop/src/project-activity-client";
import type {
  ProjectActivityEvent,
  ProjectActivityFilters,
  ProjectActivityPage,
} from "../../types/project-activity";

const alpha = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46",
  beta = "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
  at = "2026-10-23T12:00:00.000Z";
const filters: ProjectActivityFilters = {
  kinds: [],
  provider: null,
  beadId: null,
  sessionId: null,
  runId: null,
  shiftId: null,
  since: null,
  until: null,
};
function event(id: number): ProjectActivityEvent {
  return {
    id,
    ulid: "01M5N34RC8EKH2SZKG14P4W4AK",
    at,
    kind: "tool.called",
    actor: null,
    beadId: "alpha-epic",
    sessionId: "fixture",
    runId: null,
    summary: `Read ${id}`,
    metadata: [{ key: "tool", value: "Read" }],
  };
}
function page(
  after = 0,
  ids = [after + 1],
  nextAfter = ids.at(-1) ?? after,
  more = false,
  projectId = alpha,
  workspace = "/alpha",
): ProjectActivityPage {
  return {
    projectId,
    workspace,
    asOf: at,
    filters,
    after,
    nextAfter,
    more,
    events: ids.map(event),
    membershipComplete: true,
    problems: [],
  };
}
function held<T>() {
  let done: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    done = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!done) throw Error("Missing deferred reader");
      done(value);
    },
  };
}
async function settle() {
  await Bun.sleep(0);
  await Bun.sleep(0);
}

test("the scoped reader continues across a suppressed empty page and exposes only validated project metadata", async () => {
  const calls: number[] = [];
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    read: async (after) => {
      calls.push(after);
      return after === 0 ? page(0, [], 2, true) : page(2, [3]);
    },
    detail: async () => {
      throw Error("No selected event");
    },
  });
  client.refresh();
  await settle();
  expect(calls).toEqual([0, 2]);
  expect(client.get().events.map((row) => row.id)).toEqual([3]);
  expect(client.get()).toMatchObject({
    loading: false,
    loaded: true,
    more: false,
    nextAfter: 3,
    error: "",
  });
  client.dispose();
});

test("disposing an old scope fences its late page; filters and workspace must match the active immutable scope", async () => {
  const old = held<unknown>();
  let paints = 0;
  const a = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    read: () => old.promise,
    detail: async () => null,
  });
  a.subscribe(() => {
    paints++;
  });
  a.refresh();
  a.dispose();
  const before = paints;
  const b = createProjectActivityClient({
    projectId: beta,
    workspace: "/beta",
    filters,
    refetch: { windowMs: 0 },
    read: async () => page(0, [7], 7, false, beta, "/beta"),
    detail: async () => null,
  });
  b.refresh();
  await settle();
  old.resolve(page());
  await settle();
  expect(paints).toBe(before);
  expect(b.get().events.map((row) => row.id)).toEqual([7]);
  expect(a.get().events).toEqual([]);
  b.dispose();
});

test("a resync during an in-flight follow read rebuilds history rather than continuing from a potentially incomplete cursor", async () => {
  const pending = held<unknown>(),
    calls: number[] = [];
  let starts = 0;
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    read: async (after) => {
      calls.push(after);
      if (after === 0) return page(0, ++starts === 1 ? [1] : [1, 2, 3]);
      if (after === 1) return pending.promise;
      return page(after, []);
    },
    detail: async () => null,
  });
  client.refresh();
  await settle();
  client.changed();
  await settle();
  client.changed("resync");
  pending.resolve(page(1, [2]));
  await settle();
  await settle();
  expect(calls).toEqual([0, 1, 0]);
  expect(client.get().events.map((row) => row.id)).toEqual([1, 2, 3]);
  client.dispose();
});

test("a bounded partial scan labels remaining history, retains only the newest capped rows and needs explicit continuation", async () => {
  const calls: number[] = [];
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    limits: { pages: 2, rows: 3 },
    read: async (after) => {
      calls.push(after);
      return page(after, [after + 1, after + 2], after + 2, true);
    },
    detail: async () => null,
  });
  client.refresh();
  await settle();
  expect(calls).toEqual([0, 2]);
  expect(client.get()).toMatchObject({
    more: true,
    paused: true,
    cut: true,
    loading: false,
    nextAfter: 4,
  });
  expect(client.get().events.map((row) => row.id)).toEqual([2, 3, 4]);
  client.changed();
  await settle();
  expect(calls).toEqual([0, 2]);
  client.loadMore();
  await settle();
  expect(calls).toEqual([0, 2, 4, 6]);
  expect(client.get().events.map((row) => row.id)).toEqual([6, 7, 8]);
  client.dispose();
});

test("whole-pass timeout and late replies keep earlier verified events and stop loading", async () => {
  const pending = held<unknown>(),
    timers = new Map<unknown, () => void>();
  let first = true;
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    timers: {
      set(work) {
        const id = {};
        timers.set(id, work);
        return id;
      },
      clear(id) {
        timers.delete(id);
      },
    },
    read: async () => {
      if (first) {
        first = false;
        return page();
      }
      return pending.promise;
    },
    detail: async () => null,
  });
  client.refresh();
  await settle();
  client.changed();
  await settle();
  expect(timers.size).toBe(1);
  for (const expire of [...timers.values()]) expire();
  await settle();
  expect(client.get().loading).toBe(false);
  expect(client.get().error).toContain("bounded read");
  pending.resolve(page(1, [2]));
  await settle();
  expect(client.get().events.map((row) => row.id)).toEqual([1]);
  expect(timers.size).toBe(0);
  client.dispose();
});

test("malformed or mismatched refreshes retain earlier events without accepting a new source", async () => {
  for (const fault of [
    "workspace",
    "project",
    "filters",
    "cursor",
    "private",
  ]) {
    let first = true;
    const client = createProjectActivityClient({
      projectId: alpha,
      workspace: "/alpha",
      filters,
      refetch: { windowMs: 0 },
      read: async () => {
        if (first) {
          first = false;
          return page();
        }
        const changed = page();
        if (fault === "workspace") changed.workspace = "/other";
        if (fault === "project") changed.projectId = beta;
        if (fault === "filters")
          changed.filters = { ...filters, provider: "foreign" };
        if (fault === "cursor") changed.after = 5;
        return fault === "private"
          ? { ...changed, frames: [{ text: "PRIVATE" }] }
          : changed;
      },
      detail: async () => null,
    });
    client.refresh();
    await settle();
    client.refresh();
    await settle();
    expect(client.get().events.map((row) => row.id)).toEqual([1]);
    expect(client.get().workspace).toBe("/alpha");
    expect(client.get().error).toContain("invalid metadata");
    client.dispose();
  }
});

test("selected metadata waits for verified source and a late prior selection cannot overwrite the current event", async () => {
  const feed = held<unknown>(),
    old = held<unknown>(),
    calls: number[] = [];
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: null,
    filters,
    refetch: { windowMs: 0 },
    read: () => feed.promise,
    detail: async (id) => {
      calls.push(id);
      return id === 1
        ? old.promise
        : { projectId: alpha, workspace: "/alpha", asOf: at, event: event(id) };
    },
  });
  client.select(1);
  client.refresh();
  await settle();
  expect(calls).toEqual([]);
  feed.resolve(page());
  await settle();
  expect(calls).toEqual([1]);
  client.select(2);
  await settle();
  old.resolve({
    projectId: alpha,
    workspace: "/other",
    asOf: at,
    event: event(1),
  });
  await settle();
  expect(client.get().detail?.event.id).toBe(2);
  expect(client.get().detail?.workspace).toBe("/alpha");
  expect(client.get().detailError).toBe("");
  client.dispose();
});

test("finishing a bounded continuation clears its earlier remaining-history notice", async () => {
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    limits: { pages: 1 },
    read: async (after) => (after === 0 ? page(0, [1], 1, true) : page(1, [2])),
    detail: async () => null,
  });
  client.refresh();
  await settle();
  expect(client.get().notice).toContain("More history remains");
  client.loadMore();
  await settle();
  expect(client.get().more).toBe(false);
  expect(client.get().paused).toBe(false);
  expect(client.get().notice).toBe("");
  client.dispose();
});

test("a failed selected-event refresh preserves its last verified metadata", async () => {
  let fail = false;
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    read: async () => page(),
    detail: async (id) => {
      if (fail) throw Error("Fixture selected source unavailable");
      return {
        projectId: alpha,
        workspace: "/alpha",
        asOf: at,
        event: event(id),
      };
    },
  });
  client.refresh();
  await settle();
  client.select(1);
  await settle();
  fail = true;
  client.refreshDetail();
  await settle();
  expect(client.get().detail?.event.id).toBe(1);
  expect(client.get().detailError).toContain(
    "Fixture selected source unavailable",
  );
  expect(client.get().detailLoading).toBe(false);
  client.dispose();
});

test("membership resync retains last verified selected metadata with a recheck notice until an explicit successful detail refresh", async () => {
  const refresh = held<unknown>();
  let reads = 0,
    details = 0;
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    read: async () => (++reads === 1 ? page() : refresh.promise),
    detail: async (id) => {
      details++;
      return {
        projectId: alpha,
        workspace: "/alpha",
        asOf: at,
        event: event(id),
      };
    },
  });
  client.refresh();
  await settle();
  client.select(1);
  await settle();
  expect(client.get().detailStale).toBe(false);
  client.changed("resync");
  await settle();
  expect(client.get().loading).toBe(true);
  expect(client.get().detail?.event.id).toBe(1);
  expect(client.get().detailStale).toBe(true);
  expect(details).toBe(1);
  refresh.resolve(page(0, []));
  await settle();
  expect(client.get().events).toEqual([]);
  expect(client.get().detail?.event.id).toBe(1);
  expect(client.get().detailStale).toBe(true);
  expect(details).toBe(1);
  client.refreshDetail();
  await settle();
  expect(client.get().detailStale).toBe(false);
  expect(details).toBe(2);
  client.dispose();
});

test("a detail already in flight before membership resync cannot clear the later recheck notice", async () => {
  const detail = held<unknown>(),
    refresh = held<unknown>();
  let reads = 0;
  const client = createProjectActivityClient({
    projectId: alpha,
    workspace: "/alpha",
    filters,
    refetch: { windowMs: 0 },
    read: async () => (++reads === 1 ? page() : refresh.promise),
    detail: () => detail.promise,
  });
  client.refresh();
  await settle();
  client.select(1);
  await settle();
  client.changed("resync");
  await settle();
  detail.resolve({
    projectId: alpha,
    workspace: "/alpha",
    asOf: at,
    event: event(1),
  });
  await settle();
  expect(client.get().detail?.event.id).toBe(1);
  expect(client.get().detailStale).toBe(true);
  refresh.resolve(page());
  await settle();
  expect(client.get().detailStale).toBe(true);
  client.dispose();
});
