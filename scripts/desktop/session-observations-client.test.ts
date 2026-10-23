import { expect, test } from "bun:test";
import { createSessionObservationsClient } from "../../apps/desktop/src/session-observations-client";
import type {
  ProjectSessionObservations,
  SessionObservationDetail,
} from "../../types/session-observations";

const alpha = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46",
  beta = "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
  stamp = "2026-10-23T17:00:00.000Z";
function index(
  projectId = alpha,
  workspace = "/alpha",
  id = "external-alpha",
): ProjectSessionObservations {
  return {
    projectId,
    workspace,
    asOf: stamp,
    observations: [
      { sessionId: id, workspace, kind: "interactive", lastEventAt: stamp },
    ],
    observationsComplete: true,
    ownership: { available: true, records: [], reason: null },
    problems: [],
  };
}
function page(
  source: ProjectSessionObservations,
  after = 0,
  count = 1,
  more = false,
): SessionObservationDetail {
  const observation = source.observations[0];
  if (!observation) throw Error("Missing fixture observation");
  return {
    projectId: source.projectId,
    workspace: source.workspace,
    asOf: stamp,
    sessionId: observation.sessionId,
    observation,
    owner: null,
    ownershipAvailable: true,
    ownershipReason: null,
    parent: null,
    after,
    nextAfter: after + count,
    more,
    activity: Array.from({ length: count }, (_, n) => ({
      id: after + n + 1,
      at: stamp,
      kind: "tool.called" as const,
      tool: "Read",
      durationMs: null,
      exitCode: null,
    })),
    problems: [],
  };
}
function held<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!complete) throw Error("Missing deferred read");
      complete(value);
    },
  };
}
async function settle() {
  await Bun.sleep(0);
  await Bun.sleep(0);
}

test("deferred index and activity replies cannot paint another project or a later selection", async () => {
  const a = index(),
    b = index(beta, "/beta", "external-beta"),
    oldIndex = held<unknown>(),
    oldDetail = held<unknown>();
  const client = createSessionObservationsClient({
    refetch: { windowMs: 0 },
    index: async (id) => (id === alpha ? oldIndex.promise : b),
    detail: async (id) => (id === alpha ? oldDetail.promise : page(b)),
  });
  client.activate(alpha, "external-alpha", "/alpha");
  client.activate(beta, "external-beta", "/beta");
  await settle();
  oldIndex.resolve(a);
  oldDetail.resolve(page(a));
  await settle();
  expect(client.project(beta).data?.projectId).toBe(beta);
  expect(client.detail(beta, "external-beta").activity).toHaveLength(1);
  expect(client.detail(beta, "external-beta").error).toBe("");
  expect(client.project(alpha).data).toBeNull();
  expect(client.detail(alpha, "external-alpha").data).toBeNull();
  client.dispose();
});

test("failed or malformed later metadata keeps known ownership and activity with an explicit error", async () => {
  const source = index();
  source.ownership = {
    available: true,
    reason: null,
    records: [
      {
        record: {
          projectId: alpha,
          id: "session-78d55e8f-4521-40bc-a45a-cd8e68e575ae",
          requestId: "825f49e8-14b5-46d2-80f5-a143ae120bed",
          requestHash: "a".repeat(64),
          createdAt: stamp,
          workspace: "/alpha",
          repository: "/alpha",
          worktree: "/alpha",
          provider: "claude",
          mode: "chat",
          smith: "claude-journeyman",
          requestedModel: "sonnet",
          requestedEffort: null,
        },
        origin: null,
      },
    ],
  };
  let fail = false;
  const client = createSessionObservationsClient({
    refetch: { windowMs: 0 },
    index: async () => {
      if (fail) throw Error("Ownership read unavailable");
      return source;
    },
    detail: async (_id, _session, after) =>
      fail
        ? { ...page(source, after), sessionId: "foreign" }
        : page(source, after),
  });
  client.activate(alpha, "external-alpha", "/alpha");
  await settle();
  const original = client.detail(alpha, "external-alpha").activity;
  fail = true;
  client.refreshIndex();
  client.refreshDetail();
  await settle();
  expect(client.rows(alpha).find((row) => row.owner)?.ownership).toBe("owned");
  expect(client.rows(alpha).find((row) => row.owner)?.reason).toContain(
    "Ownership read unavailable",
  );
  expect(client.detail(alpha, "external-alpha").activity).toEqual(original);
  expect(client.detail(alpha, "external-alpha").nextAfter).toBe(1);
  expect(client.detail(alpha, "external-alpha").error).toContain(
    "does not match",
  );
  client.dispose();
});

test("explicit metadata pagination updates a late verified parent and never recreates prior activity", async () => {
  const source = index(),
    asked: number[] = [];
  const client = createSessionObservationsClient({
    refetch: { windowMs: 0 },
    index: async () => source,
    detail: async (_id, _session, after) => {
      asked.push(after);
      return {
        ...page(source, after, 1, after === 0),
        parent: { id: "late-parent", available: after > 0 },
      };
    },
  });
  client.activate(alpha, "external-alpha", "/alpha");
  await settle();
  expect(client.detail(alpha, "external-alpha").data?.parent?.available).toBe(
    false,
  );
  client.refreshDetail();
  await settle();
  expect(asked).toEqual([0, 1]);
  expect(
    client.detail(alpha, "external-alpha").activity.map((row) => row.id),
  ).toEqual([1, 2]);
  expect(client.detail(alpha, "external-alpha").data?.parent).toEqual({
    id: "late-parent",
    available: true,
  });
  client.dispose();
});

test("an accumulated activity ceiling keeps prior pages and stops further reads without claiming complete history", async () => {
  const source = index();
  let reads = 0;
  const client = createSessionObservationsClient({
    refetch: { windowMs: 0 },
    index: async () => source,
    detail: async (_id, _session, after) => {
      reads++;
      return page(source, after, 100, true);
    },
  });
  client.activate(alpha, "external-alpha", "/alpha");
  await settle();
  for (let n = 1; n < 11; n++) {
    client.refreshDetail();
    await settle();
  }
  const view = client.detail(alpha, "external-alpha");
  expect(view.activity).toHaveLength(1000);
  expect(view.capped).toBe(true);
  expect(view.more).toBe(true);
  expect(view.error).toContain("limit");
  const before = reads;
  client.refreshDetail();
  client.changed();
  await settle();
  expect(reads).toBe(before);
  client.dispose();
});

test("a verified workspace change clears prior owners and rejects a deferred page from its earlier cursor", async () => {
  const a = index(),
    b = index(alpha, "/other", "external-alpha"),
    deferred = held<unknown>();
  let changed = false;
  const client = createSessionObservationsClient({
    refetch: { windowMs: 0 },
    index: async () => (changed ? b : a),
    detail: async (_id, _session, after) =>
      after === 0 && !changed ? page(a) : deferred.promise,
  });
  client.activate(alpha, "external-alpha", null);
  await settle();
  client.refreshDetail();
  await settle();
  changed = true;
  client.refreshIndex();
  await settle();
  deferred.resolve(page(a, 1));
  await settle();
  expect(client.project(alpha).workspace).toBe("/other");
  expect(client.detail(alpha, "external-alpha").activity).toEqual([]);
  expect(client.detail(alpha, "external-alpha").error).toContain(
    "does not match",
  );
  client.dispose();
});

test("retained ownership has an aggregate ceiling and overflow cannot poison earlier verified identities", async () => {
  const source = index();
  const owner = (n: number) => ({
    record: {
      projectId: alpha,
      id: `session-00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
      requestId: `00000000-0000-4000-8000-${(n + 2000).toString(16).padStart(12, "0")}`,
      requestHash: "a".repeat(64),
      createdAt: stamp,
      workspace: "/alpha",
      repository: "/alpha",
      worktree: "/alpha",
      provider: "claude" as const,
      mode: "chat" as const,
      smith: "claude-journeyman",
      requestedModel: "sonnet",
      requestedEffort: null,
    },
    origin: null,
  });
  source.ownership = {
    available: true,
    reason: null,
    records: Array.from({ length: 1000 }, (_, n) => owner(n)),
  };
  let overflow = false;
  const client = createSessionObservationsClient({
    refetch: { windowMs: 0 },
    index: async () =>
      overflow
        ? {
            ...source,
            ownership: {
              available: true,
              reason: null,
              records: [owner(1001)],
            },
          }
        : source,
    detail: async () => page(source),
  });
  client.activate(alpha, null, "/alpha");
  await settle();
  expect(client.project(alpha).owners).toHaveLength(1000);
  overflow = true;
  client.refreshIndex();
  await settle();
  expect(client.project(alpha).owners).toHaveLength(1000);
  expect(client.project(alpha).owners[0]?.record.id).toBe(owner(0).record.id);
  expect(client.project(alpha).error).toContain("limit");
  expect(client.rows(alpha).every((row) => row.ownership === "owned")).toBe(
    false,
  );
  expect(
    client.rows(alpha).filter((row) => row.ownership === "owned"),
  ).toHaveLength(1000);
  client.dispose();
});

test("a null initial workspace waits for this generation's index and refuses another workspace's first detail", async () => {
  for (const detailAlreadyReady of [false, true]) {
    const source = index(),
      foreign = index(alpha, "/other"),
      indexReply = held<unknown>(),
      detailReply = held<unknown>();
    let reads = 0;
    if (detailAlreadyReady) detailReply.resolve(page(foreign));
    const client = createSessionObservationsClient({
      refetch: { windowMs: 0 },
      index: async () => indexReply.promise,
      detail: async () => {
        reads++;
        return detailReply.promise;
      },
    });
    client.activate(alpha, "external-alpha", null);
    await settle();
    expect(reads).toBe(0);
    expect(client.detail(alpha, "external-alpha").data).toBeNull();
    indexReply.resolve(source);
    await settle();
    if (!detailAlreadyReady) detailReply.resolve(page(foreign));
    await settle();
    expect(reads).toBe(1);
    expect(client.project(alpha).workspace).toBe("/alpha");
    expect(client.detail(alpha, "external-alpha").activity).toEqual([]);
    expect(client.detail(alpha, "external-alpha").error).toContain(
      "does not match",
    );
    client.dispose();
  }
});

test("a stream burst queued before a paged reply cannot consume the next page without explicit Load more", async () => {
  const source = index(),
    first = held<unknown>();
  let reads = 0;
  const client = createSessionObservationsClient({
    refetch: { windowMs: 0 },
    index: async () => source,
    detail: async (_project, _session, after) => {
      reads++;
      return after === 0 ? first.promise : page(source, after);
    },
  });
  client.activate(alpha, "external-alpha", "/alpha");
  await settle();
  client.changed();
  client.changed();
  first.resolve(page(source, 0, 100, true));
  await settle();
  await settle();
  expect(reads).toBe(1);
  expect(client.detail(alpha, "external-alpha").activity).toHaveLength(100);
  client.refreshDetail();
  await settle();
  expect(reads).toBe(2);
  expect(client.detail(alpha, "external-alpha").activity).toHaveLength(101);
  client.dispose();
});
