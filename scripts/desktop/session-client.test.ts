import { expect, test } from "bun:test";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import type { ActionOutcome } from "../../docs/js/action-outcome";
import type { StreamHandlers } from "../../docs/js/use-stream";
import type { OwnedSessionRecord } from "../../types/owned-session";
import type { SessionStartRequest } from "../../types/session-requests";

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

test("lost Start responses retain the immutable original until its actual admitted turn is found; reads never start another provider", async () => {
  const sent: SessionStartRequest[] = [];
  let listed = false,
    admitted = false;
  const client = createSessionsClient({
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
