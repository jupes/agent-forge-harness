import { expect, test } from "bun:test";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import { sessionStartHash } from "../../apps/desktop/src/session-start-identities";
import type { SessionStartIdentityServer } from "../../apps/desktop/src/session-start-identity-server";
import type { ActionOutcome } from "../../docs/js/action-outcome";
import type { StreamHandlers } from "../../docs/js/use-stream";
import type { OwnedSessionRecord } from "../../types/owned-session";
import type { SessionStartRequest } from "../../types/session-requests";
import { sessionStartFixture } from "./session-start-fixture";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  requestId = "18da5c95-3218-439c-a33d-e5662465f505",
  id = "session-2d5ed741-5528-424c-a927-263348778dad",
  at = "2026-10-23T03:00:00.000Z";
const record: OwnedSessionRecord = {
  id,
  projectId,
  requestId,
  requestHash: "a".repeat(64),
  mode: "chat",
  provider: "claude",
  workspace: "/repo",
  repository: "/repo",
  worktree: "/repo",
  smith: "claude-journeyman",
  requestedModel: "sonnet",
  requestedEffort: null,
  createdAt: at,
};
const turn = {
  requestId,
  hash: "a".repeat(64),
  phase: "running" as const,
  createdAt: at,
  updatedAt: at,
  reason: null,
  owner: requestId,
};
const page = {
  version: 1,
  projectId,
  conversationId: id,
  revision: 2,
  binding: null,
  turns: [turn],
  frames: [
    {
      seq: 1,
      turnId: requestId,
      at,
      event: { kind: "user", text: "Original prompt", about: [] },
    },
  ],
  more: false,
  nextCursor: 1,
  lastSequence: 1,
  request: turn,
  controllable: true,
};
const input = {
  smith: record.smith,
  repository: "/repo",
  worktree: "/repo",
  launch: { mode: "chat" as const, model: "sonnet", prompt: "Original prompt" },
};
record.requestHash = await sessionStartHash({ ...input, requestId });

test("server-backed Start buffers identity reads across reserve and the ordinary Start effect", async () => {
  const scope = { projectId, workspace: "/repo", generation: 1 };
  let listCount = 0,
    reserveCount = 0,
    startCount = 0,
    client: ReturnType<typeof createSessionsClient>;
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      listCount++;
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identities: [],
      };
    },
    async reserve(current, original) {
      reserveCount++;
      const requestHash = await sessionStartHash(original);
      return {
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identity: {
          version: 1,
          requestId: original.requestId,
          requestHash,
          provider: "claude",
          mode: "chat",
          state: "reserved",
        },
        request: original,
        requestHash,
      };
    },
    async retire() {
      throw Error("Unexpected retirement");
    },
  };
  client = createSessionsClient({
    identityServer,
    identityScope: () => scope,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async (_project, _session, action, body) => {
      if (action !== "start") throw Error("Unexpected action");
      startCount++;
      expect(listCount).toBe(1);
      expect(reserveCount).toBe(1);
      expect((body as SessionStartRequest).requestId).toBe(requestId);
      await client.refreshIdentities(projectId);
      expect(listCount).toBe(1);
      return { state: "unknown", message: "Keep the original held" };
    },
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  await client.start(projectId, input);

  expect({ listCount, reserveCount, startCount }).toEqual({
    listCount: 2,
    reserveCount: 1,
    startCount: 1,
  });
  expect(client.project(projectId).pendingStart?.requestId).toBe(requestId);
  expect(client.project(projectId).identityPage?.identities).toEqual([]);
  client.dispose();
});

test("a failed identity reserve releases the mutation gate for an explicit read without retrying Start", async () => {
  const scope = { projectId, workspace: "/repo", generation: 1 };
  let listCount = 0,
    startCount = 0;
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      listCount++;
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identities: [],
      };
    },
    async reserve() {
      throw Error("Reserve reply was lost");
    },
    async retire() {
      throw Error("Unexpected retirement");
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => scope,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async () => {
      startCount++;
      return { state: "unknown", message: "Unexpected Start" };
    },
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  await client.start(projectId, input);
  const afterReserveFailure = listCount;
  expect(startCount).toBe(0);
  await client.refreshIdentities(projectId);

  expect(listCount).toBe(afterReserveFailure + 1);
  expect(startCount).toBe(0);
  client.dispose();
});

test("an explicit retry preserves a server not-sent generation and sends the same original once", async () => {
  const scope = { projectId, workspace: "/repo", generation: 1 };
  let state: "empty" | "reserved" | "not-sent" = "empty",
    listCount = 0,
    reserveCount = 0;
  const posts: SessionStartRequest[] = [];
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      listCount++;
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identities:
          state === "empty"
            ? []
            : [
                {
                  version: 1,
                  requestId,
                  requestHash: await sessionStartHash({ ...input, requestId }),
                  provider: "claude",
                  mode: "chat",
                  state,
                },
              ],
      };
    },
    async reserve(current, original) {
      reserveCount++;
      const requestHash = await sessionStartHash(original);
      if (state === "empty") state = "reserved";
      const resultingState = state;
      return {
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identity: {
          version: 1,
          requestId: original.requestId,
          requestHash,
          provider: "claude",
          mode: "chat",
          state: resultingState,
        },
        request: original,
        requestHash,
      };
    },
    async retire() {
      throw Error("Unexpected retirement");
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => scope,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async (_project, _session, action, body) => {
      if (action !== "start") throw Error("Unexpected action");
      posts.push(body as SessionStartRequest);
      if (posts.length === 1) {
        state = "not-sent";
        return {
          state: "refused",
          message: "Provider was not reached",
          notSent: true,
        };
      }
      return { state: "unknown", message: "Keep the retry held" };
    },
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  await client.start(projectId, input);
  await client.retryStart(projectId);

  expect(reserveCount).toBe(2);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts.at(1)?.requestId).toBe(requestId);
  expect(listCount).toBeGreaterThanOrEqual(3);
  client.dispose();
});

test("a failed private feed reads the selected saved pages without claiming live status or dispatching a provider", async () => {
  let handlers: StreamHandlers | undefined;
  const reads: number[] = [],
    posts: string[] = [];
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [record],
    read: async (_project, _session, query) => {
      reads.push(query.after);
      return query.after === 0
        ? { ...page, more: true, lastSequence: 2 }
        : {
            ...page,
            frames: [
              {
                ...page.frames[0],
                seq: 2,
                event: { kind: "text", text: "Saved private reply" },
              },
            ],
            nextCursor: 2,
            lastSequence: 2,
          };
    },
    post: async (_project, _session, action) => {
      posts.push(action);
      return { state: "unknown", message: "Unexpected write" };
    },
    stream: () => (_after, next) => {
      handlers = next;
      return { close() {} };
    },
  });
  client.activate(projectId, id);
  if (!handlers) throw Error("Missing private feed");
  handlers.onEnd("failed");
  await Bun.sleep(0);
  expect(reads).toEqual([0, 1]);
  expect(client.session(projectId, id)).toMatchObject({
    loaded: true,
    live: false,
    feedInterrupted: true,
    readError: "",
  });
  expect(client.session(projectId, id).page?.frames).toHaveLength(2);
  expect(posts).toEqual([]);
  client.dispose();
});

test("late fallback reads cannot refill a closed project cache or replace a newer selection", async () => {
  let handlers: StreamHandlers | undefined,
    finish: ((value: unknown) => void) | undefined;
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [record],
    read: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    post: async () => {
      throw Error("A saved read cannot write");
    },
    stream: () => (_after, next) => {
      handlers = next;
      return { close() {} };
    },
  });
  client.activate(projectId, id);
  if (!handlers) throw Error("Missing private feed");
  handlers.onEnd("failed");
  expect(finish).toBeDefined();
  client.activate("project-other", "session-other");
  finish?.(page);
  await Bun.sleep(0);
  expect(client.session(projectId, id).page).toBeNull();
  expect(client.session("project-other", "session-other").page).toBeNull();
  client.dispose();
});

test("saved fallback has a deadline and ignores late data after it, with no provider retry", async () => {
  let handlers: StreamHandlers | undefined,
    finish: ((value: unknown) => void) | undefined;
  const scheduled = new Set<{ run(): void; ms: number }>();
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [record],
    read: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    post: async () => {
      throw Error("A saved read cannot write");
    },
    stream: () => (_after, next) => {
      handlers = next;
      return { close() {} };
    },
    timers: {
      set(run, ms) {
        const item = { run, ms };
        scheduled.add(item);
        return item;
      },
      clear(handle) {
        for (const item of scheduled)
          if (item === handle) scheduled.delete(item);
      },
    },
  });
  client.activate(projectId, id);
  if (!handlers) throw Error("Missing private feed");
  handlers.onEnd("failed");
  const deadline = [...scheduled].find((item) => item.ms === 5000);
  expect(deadline).toBeDefined();
  deadline?.run();
  expect(client.session(projectId, id).readError).toContain("time limit");
  finish?.(page);
  await Bun.sleep(0);
  expect(client.session(projectId, id).page).toBeNull();
  client.dispose();
  expect(scheduled.size).toBe(0);
});

for (const limit of ["pages", "bytes", "malformed"] as const) {
  test(`saved fallback enforces ${limit} limits and keeps its earlier verified frames`, async () => {
    let handlers: StreamHandlers | undefined,
      reads = 0;
    const client = createSessionsClient({
      identities: sessionStartFixture().identities,
      canWrite: () => true,
      requestId: () => requestId,
      list: async () => [record],
      read: async (_project, _session, query) => {
        reads++;
        const count = limit === "bytes" ? 100 : 1;
        const nextCursor = query.after + count;
        return {
          ...page,
          revision: reads + 1,
          more: true,
          nextCursor,
          lastSequence: 1000,
          frames: Array.from({ length: count }, (_, index) => ({
            seq:
              query.after +
              index +
              1 +
              (limit === "malformed" && reads > 1 ? 1 : 0),
            turnId: requestId,
            at,
            event: {
              kind: "text",
              text: limit === "bytes" ? "x".repeat(16_384) : "Saved partial",
            },
          })),
        };
      },
      post: async () => {
        throw Error("A saved read cannot write");
      },
      stream: () => (_after, next) => {
        handlers = next;
        return { close() {} };
      },
    });
    try {
      client.activate(projectId, id);
      if (!handlers) throw Error("Missing private feed");
      handlers.onEnd("failed");
      await Bun.sleep(0);
      const saved = client.session(projectId, id);
      expect(saved.readError).not.toBe("");
      expect(saved.page?.frames.length).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(JSON.stringify(saved.page?.frames)).byteLength,
      ).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(saved.live).toBe(false);
      expect(saved.loaded).toBe(false);
      expect(reads).toBe(limit === "pages" ? 200 : limit === "bytes" ? 6 : 2);
    } finally {
      client.dispose();
    }
  });
}

test("a verified proposal admission is adopted without an ordinary Start, clearing another draft or triggering its navigation", () => {
  let posts = 0,
    identityOperations = 0;
  const identityServer: SessionStartIdentityServer = {
    async list() {
      identityOperations++;
      return {
        version: 1,
        scope: { family: "owned-session-start", projectId, workspace: "/repo" },
        identities: [],
      };
    },
    async reserve() {
      identityOperations++;
      throw Error("Keeper adoption must not reserve an ordinary identity");
    },
    async retire() {
      identityOperations++;
      throw Error("Keeper adoption must not retire an ordinary identity");
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => ({ projectId, workspace: "/repo", generation: 1 }),
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async () => {
      posts++;
      return { state: "unknown", message: "No dispatch" };
    },
    stream: () => () => ({ close() {} }),
  });
  client.editComposer(projectId, {
    prompt: "Keep the normal new-session draft",
  });
  client.chooseComposerProvider(projectId, "gemini");
  client.chooseGeminiMode(projectId, "chat");
  client.editGeminiChatComposer(projectId, { model: "explicit-gemini-model" });
  const original = { ...input, requestId };
  expect(
    client.adoptStartReceipt(projectId, original, {
      session: record,
      receipt: { conversationId: id, revision: 2, turn },
    }),
  ).toBe(true);
  expect(client.project(projectId).records).toEqual([record]);
  expect(client.project(projectId).composer.prompt).toBe(
    "Keep the normal new-session draft",
  );
  expect(client.project(projectId).lastStarted).toBeNull();
  expect(client.project(projectId).composerProvider).toBe("gemini");
  expect(client.project(projectId).geminiMode).toBe("chat");
  expect(client.project(projectId).geminiChatComposer.model).toBe(
    "explicit-gemini-model",
  );
  expect(client.session(projectId, id).receiptRevision).toBe(2);
  expect(
    client.adoptStartReceipt("project-other", original, {
      session: record,
      receipt: { conversationId: id, revision: 2, turn },
    }),
  ).toBe(false);
  expect(posts).toBe(0);
  expect(identityOperations).toBe(0);
  client.dispose();
});

test("proposal admission cannot adopt a valid managed Shift receipt into ordinary session controls", () => {
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async () => ({ state: "unknown", message: "No dispatch" }),
    stream: () => () => ({ close() {} }),
  });
  const task = {
    ...input,
    requestId,
    beadId: "alpha-1",
    launch: { ...input.launch, mode: "task" as const },
  };
  const managed = {
    ...record,
    mode: "task",
    beadId: task.beadId,
    origin: {
      kind: "shift",
      projectId,
      originalRequestId: requestId,
      shiftId: "shift-20261023-080000-1234",
      runId: "bounded-run-1",
      beadId: task.beadId,
      attempt: 1,
    },
  };
  expect(
    client.adoptStartReceipt(projectId, task, {
      session: managed,
      receipt: { conversationId: id, revision: 2, turn },
    }),
  ).toBe(false);
  expect(client.project(projectId).records).toEqual([]);
  client.dispose();
});

test("lost Start responses retain the immutable original until its actual admitted turn is found; reads never start another provider", async () => {
  const sent: SessionStartRequest[] = [];
  let listed = false,
    admitted = false;
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => (listed ? [record] : []),
    read: async () => ({
      ...page,
      request: admitted ? turn : null,
      turns: admitted ? [turn] : [],
      frames: admitted ? page.frames : [],
      nextCursor: admitted ? 1 : 0,
      lastSequence: admitted ? 1 : 0,
    }),
    post: async (_project, _session, action, body): Promise<ActionOutcome> => {
      if (action === "start") sent.push(body as SessionStartRequest);
      return { state: "unknown", message: "Lost response" };
    },
    stream: () => () => ({ close() {} }),
  });
  await client.start(projectId, input);
  expect(client.project(projectId).pendingStart?.requestId).toBe(requestId);
  listed = true;
  await client.refresh(projectId);
  expect(client.project(projectId).pendingStart?.requestId).toBe(requestId);
  await client.start(projectId, {
    ...input,
    launch: { ...input.launch, prompt: "Changed" },
  });
  expect(sent).toHaveLength(1);
  await client.retryStart(projectId);
  expect(sent[1]).toEqual(sent[0]);
  admitted = true;
  await client.refresh(projectId);
  expect(client.project(projectId).pendingStart).toBeNull();
  expect(client.project(projectId).lastStarted).toBe(id);
  expect(sent).toHaveLength(2);
  client.dispose();
});

test("Start confirmation preserves attachments and About context edited while its original response is unknown", async () => {
  let admitted = false;
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [record],
    read: async () => ({
      ...page,
      request: admitted ? turn : null,
      turns: admitted ? [turn] : [],
    }),
    post: async () => ({ state: "unknown", message: "Lost" }),
    stream: () => () => ({ close() {} }),
  });
  client.editComposer(projectId, { prompt: input.launch.prompt });
  await client.start(projectId, input);
  const attachments = [
      {
        kind: "text" as const,
        name: "later.txt",
        text: "Keep this new attachment",
      },
    ],
    about = [{ kind: "bead" as const, id: "later-bead" }];
  client.editComposer(projectId, { attachments, about });
  admitted = true;
  await client.refresh(projectId);
  expect(client.project(projectId).composer.prompt).toBe("");
  expect(client.project(projectId).composer.attachments).toEqual(attachments);
  expect(client.project(projectId).composer.about).toEqual(about);
  expect(client.project(projectId).pendingStart).toBeNull();
  client.dispose();
});

test("terminal stream confirmation wins over a delayed malformed Stop receipt, and closing an observer sends no Stop", async () => {
  let handlers: StreamHandlers | null = null,
    finish: ((value: ActionOutcome) => void) | undefined;
  const posts: string[] = [];
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [record],
    read: async () => page,
    post: async (_project, _session, action) => {
      posts.push(action);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    stream: () => (_cursor, value) => {
      handlers = value;
      return { close() {} };
    },
  });
  await client.refresh(projectId);
  client.activate(projectId, id);
  const deliver = (value: unknown) => {
    if (!handlers) throw new Error("Missing observer");
    handlers.onMessage({
      event: "conversation",
      id: "1",
      data: JSON.stringify(value),
    });
  };
  deliver(page);
  const stopping = client.stop(projectId, id);
  deliver({
    ...page,
    revision: 3,
    turns: [{ ...turn, phase: "cancelled" }],
    request: { ...turn, phase: "cancelled" },
    frames: [],
  });
  finish?.({ state: "done", data: { malformed: true } });
  await stopping;
  expect(client.session(projectId, id).stopUnknown).toBe(false);
  expect(client.session(projectId, id).stopping).toBeNull();
  expect(client.session(projectId, id).notice).toBe("Stop confirmed.");
  client.activate(null, null);
  expect(posts).toEqual(["stop"]);
  client.dispose();
});

test("a delayed malformed message receipt cannot overwrite stream confirmation or erase the next draft, and stale project streams stay private", async () => {
  const observers: StreamHandlers[] = [],
    posts: unknown[] = [];
  let finish: ((value: ActionOutcome) => void) | undefined;
  const nextId = "18da5c95-3218-439c-a33d-e5662465f506";
  const ready = {
    ...page,
    binding: { provider: "claude", sessionId: "native-id", version: "fixture" },
    turns: [{ ...turn, phase: "completed" }],
    request: null,
  };
  const client = createSessionsClient({
    identities: sessionStartFixture().identities,
    canWrite: () => true,
    requestId: () => nextId,
    list: async (scope) => (scope === projectId ? [record] : []),
    read: async () => ready,
    post: async (_project, _session, _action, body) => {
      posts.push(body);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    stream: () => (_cursor, handlers) => {
      observers.push(handlers);
      return { close() {} };
    },
  });
  const deliver = (value: unknown, index = 0) =>
    observers[index]?.onMessage({
      event: "conversation",
      id: "1",
      data: JSON.stringify(value),
    });
  await client.refresh(projectId);
  client.activate(projectId, id);
  deliver(ready);
  client.draft(projectId, id, "Exact follow-up");
  client.editMessage(projectId, id, {
    attachments: [{ kind: "text", name: "first.txt", text: "first" }],
    about: [{ kind: "bead", id: "alpha-epic" }],
  });
  const sending = client.send(projectId, id);
  expect(posts[0]).toMatchObject({
    requestId: nextId,
    text: "Exact follow-up",
    attachments: [{ name: "first.txt" }],
    about: [{ id: "alpha-epic" }],
  });
  client.draft(projectId, id, "Later draft");
  client.editMessage(projectId, id, {
    attachments: [{ kind: "text", name: "later.txt", text: "later" }],
    about: [],
  });
  const confirmed = {
    ...ready,
    revision: 3,
    frames: [],
    turns: [...ready.turns, { ...turn, requestId: nextId, phase: "completed" }],
    request: null,
  };
  deliver(confirmed);
  finish?.({ state: "done", data: { malformed: true } });
  await sending;
  expect(client.session(projectId, id).notice).toBe(
    "The original message is recorded in this session.",
  );
  expect(client.session(projectId, id).draft).toBe("Later draft");
  expect(client.session(projectId, id).attachments[0]?.name).toBe("later.txt");
  client.activate("project-beta", "session-beta");
  deliver(confirmed);
  expect(client.session(projectId, id).page).toBeNull();
  expect(client.session("project-beta", "session-beta").page).toBeNull();
  expect(posts).toHaveLength(1);
  client.dispose();
});
