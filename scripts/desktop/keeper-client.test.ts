import { expect, test } from "bun:test";
import { createKeeperClient } from "../../apps/desktop/src/keeper-client";
import type { ActionOutcome } from "../../docs/js/action-outcome";
import type { StreamHandlers } from "../../docs/js/use-stream";
import type {
  ConversationPage,
  ConversationSend,
} from "../../types/conversation";
import type {
  KeeperBriefIntent,
  KeeperBriefIntentMetadata,
  KeeperBriefs,
} from "../../types/keeper-brief";

const alpha = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const beta = "project-b5832fa0-7a21-403b-8184-44892f0d8d86";
const requestId = "1a5832fa-7a21-403b-8184-44892f0d8d86";
const at = "2026-10-22T00:00:00.000Z";
const turn = {
  requestId,
  hash: "0".repeat(64),
  phase: "completed" as const,
  createdAt: at,
  updatedAt: at,
  reason: null,
  owner: null,
};
const page = (projectId = alpha): ConversationPage => ({
  version: 1,
  projectId,
  conversationId: `keeper-${projectId}`,
  revision: 0,
  binding: null,
  turns: [],
  frames: [],
  more: false,
  nextCursor: 0,
  lastSequence: 0,
  request: null,
  controllable: false,
});
function fixture(
  readObjects?: (
    projectId: string,
    query: import("../../types/keeper").KeeperReadQuery,
  ) => Promise<unknown>,
) {
  const opened: Array<{
    projectId: string;
    after: number | null;
    handlers: StreamHandlers;
    closed: boolean;
  }> = [];
  const posts: Array<{
    projectId: string;
    action: string;
    body: unknown;
  }> = [];
  let reply: ActionOutcome | Promise<ActionOutcome> = {
    state: "unknown",
    message: "Reply lost",
  };
  let postFailure: Error | null = null;
  let read: unknown = page();
  let briefIntentRead: unknown = null;
  let briefOriginalRead: unknown = null;
  const client = createKeeperClient({
    readObjects,
    canWrite: () => true,
    requestId: () => requestId,
    stream: (projectId) => (after, handlers) => {
      const connection = { projectId, after, handlers, closed: false };
      opened.push(connection);
      return {
        close() {
          connection.closed = true;
        },
      };
    },
    read: async () => read,
    readBriefIntent: async (_projectId, requestedId) =>
      requestedId ? briefOriginalRead : briefIntentRead,
    post: async (projectId, action, body) => {
      if (postFailure) throw postFailure;
      posts.push({ projectId, action, body });
      return reply;
    },
  });
  const deliver = (value: ConversationPage, index = opened.length - 1) =>
    opened[index]?.handlers.onMessage({
      event: "conversation",
      id: String(value.nextCursor),
      data: JSON.stringify(value),
    });
  return {
    client,
    opened,
    posts,
    deliver,
    reply(value: ActionOutcome | Promise<ActionOutcome>) {
      reply = value;
    },
    read(value: unknown) {
      read = value;
    },
    readBriefIntent(value: unknown) {
      briefIntentRead = value;
    },
    readBriefOriginal(value: unknown) {
      briefOriginalRead = value;
    },
    failPost() {
      postFailure = new Error("synthetic lost response");
    },
  };
}

function keeperBriefOriginal(projectId = alpha): KeeperBriefIntent {
  return {
    version: 1,
    requestId,
    projectId,
    conversationId: `keeper-${projectId}`,
    expectedRevision: 0,
    origin: {
      kind: "overview",
      projectId,
      workspace: "C:/workspace",
      catalogRevision: 1,
    },
    selection: {
      name: "Keeper",
      provider: "anthropic",
      model: "claude-fixture",
      effort: "high",
      enabled: true,
      tags: [],
    },
    purpose: "brief",
    intentHash: "a".repeat(64),
    text: "The exact prepared prompt.",
    about: [],
    snapshot: {
      version: 1,
      projectId,
      projectName: "Alpha",
      workspace: "C:/workspace",
      catalogRevision: 1,
      asOf: at,
      since: at,
      scope: {
        label: "project:alpha",
        epicIds: [],
        epicCount: 0,
        repositoryCount: 0,
      },
      observed: {
        beads: 0,
        queue: 0,
        sessions: 0,
        runs: 0,
        activity: 0,
      },
      complete: true,
      limitations: [],
      facts: [],
    },
    createdAt: at,
    state: "reserved",
    preparedTurnHash: "b".repeat(64),
  };
}

function keeperBriefMetadata(
  original: KeeperBriefIntent,
): KeeperBriefIntentMetadata {
  const {
    version,
    requestId: id,
    projectId,
    conversationId,
    expectedRevision,
    origin,
    selection,
    purpose,
    intentHash,
    createdAt,
    state,
    preparedTurnHash,
  } = original;
  return {
    version,
    requestId: id,
    projectId,
    conversationId,
    expectedRevision,
    origin,
    selection,
    purpose,
    intentHash,
    createdAt,
    state,
    preparedTurnHash,
  };
}

test("an unanswered brief reservation stays held and never retries or commits under a new identity", async () => {
  const f = fixture();
  f.client.activate(alpha);
  f.deliver(page());
  await f.client.checkBriefIntent(alpha);
  f.client.draft(alpha, "Keep this human question");
  await f.client.refreshBrief(alpha);
  expect(f.client.get(alpha).draft).toBe("Keep this human question");
  expect(f.client.get(alpha).briefIntentState).toBe("unknown");
  expect(f.client.canSend(alpha)).toBe(false);
  f.client.draft(alpha, "A later question");
  await f.client.refreshBrief(alpha);
  await f.client.retryOriginal(alpha);
  expect(f.posts).toEqual([
    {
      projectId: alpha,
      action: "brief-intents/reserve",
      body: { expectedRevision: 0, origin: { kind: "overview" } },
    },
  ]);
  expect(f.posts.some((post) => post.action === "briefs")).toBe(false);
  expect(f.client.get(alpha).draft).toBe("A later question");
  expect(f.client.get(alpha).briefIntentState).toBe("unknown");
  f.client.dispose();
});

test("an exact-original read rejects changed frozen selection or origin fields", async () => {
  const original = keeperBriefOriginal();
  const metadata = keeperBriefMetadata(original);
  const f = fixture();
  f.readBriefIntent(metadata);
  f.readBriefOriginal({
    ...original,
    selection: { ...original.selection, model: "changed-model" },
  });
  f.client.activate(alpha);
  await Promise.resolve();
  f.deliver(page());
  await f.client.reviewBrief(alpha);
  expect(f.client.get(alpha).briefIntentState).toBe("unknown");
  expect(f.client.get(alpha).briefOriginal).toBeNull();
  expect(f.client.canCommitBrief(alpha)).toBe(false);
  expect(f.posts).toEqual([]);
  f.client.dispose();
});

test("discovery rejects a ticket associated with another conversation", async () => {
  const original = keeperBriefOriginal();
  const f = fixture();
  f.readBriefIntent({
    ...keeperBriefMetadata(original),
    conversationId: `keeper-${beta}`,
  });
  f.readBriefOriginal(original);
  f.client.activate(alpha);
  await Promise.resolve();
  expect(f.client.get(alpha).briefIntentState).toBe("unknown");
  expect(f.client.get(alpha).briefIntent).toBeNull();
  expect(f.client.get(alpha).briefOriginal).toBeNull();
  f.client.dispose();
});

test("a commit receipt with the right request id but wrong frozen frame hash stays held", async () => {
  const original = keeperBriefOriginal();
  const f = fixture();
  f.readBriefIntent(keeperBriefMetadata(original));
  f.readBriefOriginal(original);
  f.client.activate(alpha);
  await Promise.resolve();
  f.deliver(page());
  await f.client.reviewBrief(alpha);
  f.reply({
    state: "done",
    data: {
      conversationId: `keeper-${alpha}`,
      revision: 1,
      turn: { ...turn, hash: "c".repeat(64) },
    },
  });
  expect(await f.client.commitBrief(alpha)).toBe(false);
  expect(f.client.get(alpha).briefIntentState).toBe("unknown");
  expect(f.client.get(alpha).briefIntentError).toContain(
    "could not be matched",
  );
  expect(f.client.get(alpha).admitted).toBeNull();
  expect(f.posts.map((post) => post.action)).toEqual(["briefs"]);
  f.client.dispose();
});

test("a lost retirement reply clears posting but keeps the saved original held", async () => {
  const original = keeperBriefOriginal();
  const f = fixture();
  f.readBriefIntent(keeperBriefMetadata(original));
  f.readBriefOriginal(original);
  f.client.activate(alpha);
  await Promise.resolve();
  f.deliver(page());
  await f.client.reviewBrief(alpha);
  f.failPost();
  expect(await f.client.retireBrief(alpha)).toBe(false);
  expect(f.client.get(alpha).posting).toBe(false);
  expect(f.client.get(alpha).briefIntentState).toBe("unknown");
  expect(f.client.get(alpha).briefOriginal).toEqual(original);
  expect(f.client.canSend(alpha)).toBe(false);
  f.client.dispose();
});

test("session-list Stop requires the exact owned provider session and turn, and an old selection cannot stop a later resumed turn", async () => {
  const f = fixture();
  f.client.activate(alpha);
  const binding = {
    provider: "claude" as const,
    sessionId: "actual-owned-session",
    version: "fixture",
  };
  const running = { ...turn, phase: "running" as const };
  const owned = {
    ...page(),
    binding,
    revision: 2,
    controllable: true,
    turns: [running],
    frames: [
      {
        seq: 1,
        turnId: requestId,
        at,
        event: { kind: "identity" as const, ...binding },
      },
    ],
    nextCursor: 1,
    lastSequence: 1,
  };
  f.deliver(owned);
  await f.client.stopSession(alpha, {
    sessionId: "foreign-observation",
    requestId,
  });
  expect(f.posts).toHaveLength(0);
  await f.client.stopSession(alpha, {
    sessionId: binding.sessionId,
    requestId,
  });
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]).toMatchObject({ action: "stop", body: { requestId } });
  f.deliver({
    ...owned,
    revision: 3,
    turns: [{ ...running, phase: "cancelling" }],
  });
  await f.client.stopSession(
    alpha,
    { sessionId: binding.sessionId, requestId },
    true,
  );
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]?.body).toEqual(f.posts[0]?.body);
  f.deliver({ ...owned, revision: 4, turns: [turn] });
  const next = "1a5832fa-7a21-403b-8184-44892f0d8d87";
  f.deliver({
    ...owned,
    revision: 5,
    turns: [turn, { ...running, requestId: next }],
    frames: [
      ...owned.frames,
      { seq: 2, turnId: next, at, event: { kind: "identity", ...binding } },
    ],
    nextCursor: 2,
    lastSequence: 2,
  });
  await f.client.stopSession(
    alpha,
    { sessionId: binding.sessionId, requestId },
    true,
  );
  expect(f.posts).toHaveLength(2);
  expect(f.client.get(alpha).notice).toContain("original turn");
  f.client.dispose();
});

test("brief reads coalesce, catch a completion during a read and preserve verified state after a foreign reply", async () => {
  const reads: Array<{ id: string; resolve(value: unknown): void }> = [];
  const client = createKeeperClient({
    canWrite: () => true,
    requestId: () => requestId,
    stream: () => () => ({ close() {} }),
    read: async () => page(),
    post: async () => ({ state: "refused", message: "No model in this test" }),
    readBriefs: (id) => new Promise((resolve) => reads.push({ id, resolve })),
  });
  const empty = (revision: number, projectId = alpha): KeeperBriefs => ({
    projectId,
    revision,
    latest: null,
    earlier: [],
    refresh: null,
  });
  const first = client.loadBriefs(alpha);
  void client.loadBriefs(alpha);
  void client.loadBriefs(alpha, true);
  expect(reads).toHaveLength(1);
  reads[0]?.resolve(empty(1));
  await first;
  expect(reads).toHaveLength(2);
  reads[1]?.resolve(empty(2));
  await Promise.resolve();
  await Promise.resolve();
  expect(client.get(alpha).briefs?.revision).toBe(2);
  const wrong = client.loadBriefs(alpha, true);
  reads[2]?.resolve(empty(3, beta));
  await wrong;
  expect(client.get(alpha).briefs?.revision).toBe(2);
  expect(client.get(alpha).briefsError).toContain("could not be verified");
  expect(client.get(beta).briefs).toBeNull();
  client.dispose();
});

test("unresolved and foreign About references hold Send; removal fences late reads and retries keep the original snapshot", async () => {
  const reads: Array<{ projectId: string; resolve(value: unknown): void }> = [];
  const f = fixture(
    (projectId) => new Promise((resolve) => reads.push({ projectId, resolve })),
  );
  f.client.activate(alpha);
  f.deliver(page());
  f.client.draft(alpha, "Explain this");
  const first = f.client.attach(alpha, { kind: "bead", id: "one" });
  expect(f.client.canSend(alpha)).toBe(false);
  f.client.removeAbout(alpha, { kind: "bead", id: "one" });
  const second = f.client.attach(alpha, { kind: "bead", id: "one" });
  const result = (projectId: string, id: string) => ({
    scope: {
      projectId,
      name: "Alpha",
      slug: "alpha",
      catalogRevision: 1,
      workspace: "/fixture",
      repositories: [],
      epicIds: [],
      repositoryCount: 0,
      epicCount: 0,
      detailsComplete: true,
      detailsReason: null,
      label: "project:alpha",
      unavailableWorkspaces: 0,
    },
    kind: "beads",
    mode: "detail",
    source: "Scoped fixture",
    asOf: at,
    complete: true,
    reason: null,
    records: [{ id, data: { title: "Scoped bead" }, truncated: false }],
    totalKnown: 1,
    nextCursor: null,
  });
  reads[0]?.resolve(result(alpha, "one"));
  await first;
  expect(f.client.get(alpha).about[0]?.status).toBe("loading");
  reads[1]?.resolve(result(beta, "one"));
  await second;
  expect(f.client.get(alpha).about[0]?.status).toBe("error");
  expect(f.client.canSend(alpha)).toBe(false);
  const third = f.client.attach(alpha, { kind: "bead", id: "one" }, true);
  reads[2]?.resolve(result(alpha, "one"));
  await third;
  expect(f.client.canSend(alpha)).toBe(true);
  await f.client.send(alpha);
  f.client.removeAbout(alpha, { kind: "bead", id: "one" });
  await f.client.retryOriginal(alpha);
  expect(f.posts.map((post) => post.body)).toEqual([
    {
      requestId,
      expectedRevision: 0,
      text: "Explain this",
      about: [{ kind: "bead", id: "one" }],
    },
    {
      requestId,
      expectedRevision: 0,
      text: "Explain this",
      about: [{ kind: "bead", id: "one" }],
    },
  ]);
  expect(f.client.get(beta).about).toEqual([]);
  f.client.dispose();
});

test("project changes fence late body events, retain separate drafts and never stop a provider", () => {
  const f = fixture();
  f.client.activate(alpha);
  f.deliver(page());
  f.client.draft(alpha, "Alpha draft");
  f.client.activate(beta);
  f.deliver(page(beta));
  f.client.draft(beta, "Beta draft");
  f.deliver(
    {
      ...page(),
      revision: 1,
      frames: [
        {
          seq: 1,
          turnId: requestId,
          at,
          event: { kind: "text", text: "FOREIGN_REPLY" },
        },
      ],
      nextCursor: 1,
      lastSequence: 1,
    },
    0,
  );
  expect(f.opened[0]?.closed).toBe(true);
  expect(f.client.get(beta).page?.frames).toEqual([]);
  expect(f.client.get(beta).draft).toBe("Beta draft");
  f.client.activate(alpha);
  expect(f.client.get(alpha).draft).toBe("Alpha draft");
  expect(f.opened.at(-1)?.after).toBe(0);
  f.client.dispose();
  expect(f.posts).toEqual([]);
});

test("a lost send stays held when lookup finds no receipt, and explicit retry preserves the original id and message", async () => {
  const f = fixture();
  f.client.activate(alpha);
  f.deliver(page());
  await f.client.checkBriefIntent(alpha);
  f.client.draft(alpha, "Original message");
  await f.client.send(alpha);
  expect(f.posts).toHaveLength(1);
  expect(f.client.get(alpha).pending?.requestId).toBe(requestId);
  expect(f.client.canSend(alpha)).toBe(false);
  await f.client.check(alpha);
  expect(f.client.get(alpha).pending?.text).toBe("Original message");
  f.client.draft(alpha, "New draft retained");
  await f.client.send(alpha);
  expect(f.posts).toHaveLength(1);
  f.reply({
    state: "done",
    data: { conversationId: `keeper-${alpha}`, revision: 2, turn },
  });
  await f.client.retryOriginal(alpha);
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]?.body).toEqual(f.posts[0]?.body);
  expect(f.client.get(alpha).pending).toBeNull();
  expect(f.client.get(alpha).draft).toBe("New draft retained");
  f.client.dispose();
});

test("replay appends once, rejects gaps and keeps partial text when a packet is malformed or foreign", () => {
  const f = fixture();
  f.client.activate(alpha);
  const first: ConversationPage = {
    ...page(),
    revision: 2,
    turns: [turn],
    frames: [
      {
        seq: 1,
        turnId: requestId,
        at,
        event: { kind: "text", text: "First partial reply" },
      },
    ],
    nextCursor: 1,
    lastSequence: 1,
  };
  f.deliver(first);
  f.deliver(first);
  expect(f.client.get(alpha).page?.frames).toHaveLength(1);
  f.deliver({
    ...first,
    revision: 4,
    frames: [
      {
        seq: 3,
        turnId: requestId,
        at,
        event: { kind: "text", text: "Must not skip" },
      },
    ],
    nextCursor: 3,
    lastSequence: 3,
  });
  expect(f.client.get(alpha).page?.frames).toHaveLength(1);
  expect(f.client.get(alpha).live).toBe(false);
  expect(f.client.get(alpha).notice).toContain("Reload");
  expect(f.client.canSend(alpha)).toBe(false);
  f.client.dispose();
});

test("an admitted streamed receipt resolves a lost send while active and unknown turns still prevent another start", async () => {
  const f = fixture();
  f.client.activate(alpha);
  f.deliver(page());
  await f.client.checkBriefIntent(alpha);
  f.client.draft(alpha, "Question");
  await f.client.send(alpha);
  f.deliver({
    ...page(),
    revision: 2,
    turns: [{ ...turn, phase: "running" }],
    controllable: true,
  });
  expect(f.client.get(alpha).pending).toBeNull();
  f.client.draft(alpha, "Next question");
  expect(f.client.canSend(alpha)).toBe(false);
  f.deliver({
    ...page(),
    revision: 3,
    turns: [{ ...turn, phase: "unknown" }],
    controllable: false,
  });
  expect(f.client.canSend(alpha)).toBe(false);
  expect(f.posts).toHaveLength(1);
  f.client.dispose();
});

test("a delayed partial read cannot undo a more complete replay at the same revision", async () => {
  const f = fixture();
  f.client.activate(alpha);
  const frames: ConversationPage["frames"] = [1, 2].map((seq) => ({
    seq,
    turnId: requestId,
    at,
    event: { kind: "text", text: `Part ${seq}` },
  }));
  f.deliver({ ...page(), revision: 5, frames, nextCursor: 2, lastSequence: 2 });
  f.read({
    ...page(),
    revision: 5,
    frames: frames.slice(0, 1),
    nextCursor: 1,
    lastSequence: 2,
    more: true,
  });
  await f.client.check(alpha);
  expect(f.client.get(alpha).loaded).toBe(true);
  expect(f.client.get(alpha).page?.nextCursor).toBe(2);
  expect(f.client.get(alpha).page?.frames).toHaveLength(2);
  f.client.dispose();
});

test("a late Stop receipt cannot regress a streamed terminal turn to cancelling", async () => {
  const f = fixture();
  f.client.activate(alpha);
  f.deliver(page());
  await f.client.checkBriefIntent(alpha);
  f.client.draft(alpha, "Question");
  f.reply({
    state: "done",
    data: {
      conversationId: `keeper-${alpha}`,
      revision: 2,
      turn: { ...turn, phase: "accepted" },
    },
  });
  await f.client.send(alpha);
  f.deliver({
    ...page(),
    revision: 3,
    turns: [{ ...turn, phase: "running" }],
    controllable: true,
  });
  let resolve: (value: ActionOutcome) => void = () => {};
  f.reply(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const stopped = f.client.stop(alpha);
  f.deliver({ ...page(), revision: 5, turns: [turn] });
  f.client.draft(alpha, "Next question");
  resolve({
    state: "done",
    data: {
      conversationId: `keeper-${alpha}`,
      revision: 4,
      turn: { ...turn, phase: "cancelling" },
    },
  });
  await stopped;
  expect(f.client.get(alpha).stopping).toBeNull();
  expect(f.client.canSend(alpha)).toBe(true);
  f.client.dispose();
});

test("a completed HTTP receipt holds the next send until its revision has reached the replay", async () => {
  const f = fixture();
  f.client.activate(alpha);
  f.deliver(page());
  await f.client.checkBriefIntent(alpha);
  f.client.draft(alpha, "Question");
  f.reply({
    state: "done",
    data: { conversationId: `keeper-${alpha}`, revision: 5, turn },
  });
  await f.client.send(alpha);
  f.client.draft(alpha, "Next question");
  expect(f.client.canSend(alpha)).toBe(false);
  f.deliver({ ...page(), revision: 5, turns: [turn] });
  expect(f.client.canSend(alpha)).toBe(true);
  f.client.dispose();
});

test("live connection failures stop after bounded retries and never submit a provider turn", () => {
  const pending = new Set<{ run(): void; ms: number }>();
  const handlers: StreamHandlers[] = [];
  let posts = 0;
  const client = createKeeperClient({
    canWrite: () => true,
    requestId: () => requestId,
    read: async () => page(),
    post: async () => {
      posts++;
      return { state: "unknown", message: "Unexpected post" };
    },
    stream: () => (_after, callback) => {
      handlers.push(callback);
      return { close() {} };
    },
    timers: {
      set(run, ms) {
        const timer = { run, ms };
        pending.add(timer);
        return timer;
      },
      clear(handle) {
        for (const timer of pending)
          if (timer === handle) pending.delete(timer);
      },
    },
  });
  client.activate(alpha);
  for (let index = 0; index < 6; index++) {
    handlers.at(-1)?.onEnd("failed");
    const next = [...pending][0];
    if (next) {
      pending.delete(next);
      next.run();
    }
  }
  expect(handlers).toHaveLength(6);
  expect(pending.size).toBe(0);
  expect(client.get(alpha).live).toBe(false);
  expect(client.get(alpha).notice).toContain("Reload");
  expect(posts).toBe(0);
  client.dispose();
});

test("an uncertain Stop can be retried explicitly against the same turn without starting another provider", async () => {
  const f = fixture();
  f.client.activate(alpha);
  f.deliver({
    ...page(),
    revision: 3,
    turns: [{ ...turn, phase: "running" }],
    controllable: true,
  });
  await f.client.stop(alpha);
  expect(f.client.get(alpha).stopUnknown).toBe(true);
  f.reply({
    state: "done",
    data: {
      conversationId: `keeper-${alpha}`,
      revision: 4,
      turn: { ...turn, phase: "cancelling" },
    },
  });
  await f.client.stop(alpha, true);
  expect(f.posts.map((post) => post.action)).toEqual(["stop", "stop"]);
  expect(f.posts[1]?.body).toEqual(f.posts[0]?.body);
  expect(f.client.get(alpha).stopping).toBe(requestId);
  expect(f.client.get(alpha).stopUnknown).toBe(false);
  f.deliver({
    ...page(),
    revision: 5,
    turns: [{ ...turn, phase: "cancelled" }],
  });
  expect(f.client.get(alpha).stopping).toBeNull();
  f.client.dispose();
});
