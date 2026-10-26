import { expect, test } from "bun:test";
import {
  codexChatStartBody,
  newCodexChatDraft,
} from "../../apps/desktop/src/codex-chat-composer";
import {
  codexTaskStartBody,
  newCodexTaskDraft,
} from "../../apps/desktop/src/codex-session-composer";
import {
  geminiChatStartBody,
  newGeminiChatDraft,
} from "../../apps/desktop/src/gemini-chat-composer";
import {
  geminiTaskStartBody,
  newGeminiTaskDraft,
} from "../../apps/desktop/src/gemini-task-composer";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import {
  newSessionDraft,
  sessionStartBody,
} from "../../apps/desktop/src/session-composer";
import { sessionStartHash } from "../../apps/desktop/src/session-start-identities";
import type { SessionStartIdentityServer } from "../../apps/desktop/src/session-start-identity-server";
import type { ActionOutcome } from "../../docs/js/action-outcome";
import type { StreamHandlers } from "../../docs/js/use-stream";
import { canonicalOwnedSessionStart } from "../../scripts/sessions/codex-owned-protocol";
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

const sharedDraft = {
  ...newSessionDraft(),
  repository: "/repo",
  worktree: "/repo",
  prompt: "Exact original prompt",
};
const sixStartInputs = [
  {
    name: "Claude Task",
    input: sessionStartBody({
      ...sharedDraft,
      mode: "task",
      smith: "claude-task",
      model: "sonnet",
    }),
  },
  {
    name: "Claude Chat",
    input: sessionStartBody({
      ...sharedDraft,
      mode: "chat",
      smith: "claude-chat",
      model: "sonnet",
    }),
  },
  {
    name: "Codex Task",
    input: codexTaskStartBody(sharedDraft, {
      ...newCodexTaskDraft(),
      initialized: true,
      smith: "codex-task",
      model: "gpt-5-codex",
      sandbox: "read-only",
    }),
  },
  {
    name: "Codex Chat",
    input: codexChatStartBody(sharedDraft, {
      ...newCodexChatDraft(),
      initialized: true,
      smith: "codex-chat",
      model: "gpt-5-codex",
      approvalPolicy: "on-request",
    }),
  },
  {
    name: "Gemini Task",
    input: geminiTaskStartBody(sharedDraft, {
      ...newGeminiTaskDraft(),
      initialized: true,
      smith: "gemini-task",
      model: "gemini-model",
    }),
  },
  {
    name: "Gemini Chat",
    input: geminiChatStartBody(sharedDraft, {
      ...newGeminiChatDraft(),
      initialized: true,
      smith: "gemini-chat",
      model: "gemini-model",
    }),
  },
] as const;

for (const item of sixStartInputs) {
  test(`${item.name} reserves the exact request before one ordinary Start`, async () => {
    const scope = { projectId, workspace: "/repo", generation: 1 };
    const order: string[] = [],
      posted: SessionStartRequest[] = [];
    const identityServer: SessionStartIdentityServer = {
      async list(current) {
        order.push("identity-get");
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
        order.push("identity-reserve");
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
            provider: "provider" in original ? original.provider : "claude",
            mode: original.launch.mode,
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
    const client = createSessionsClient({
      identityServer,
      identityScope: () => scope,
      canWrite: () => true,
      requestId: () => requestId,
      list: async () => [],
      read: async () => page,
      post: async (_project, _session, action, body) => {
        if (action !== "start") throw Error("Unexpected action");
        order.push("ordinary-start");
        posted.push(body as SessionStartRequest);
        return { state: "unknown", message: "Keep exact original held" };
      },
      stream: () => () => ({ close() {} }),
    });

    await client.refreshIdentities(projectId);
    await client.start(projectId, item.input);

    expect(order.slice(0, 3)).toEqual([
      "identity-get",
      "identity-reserve",
      "ordinary-start",
    ]);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.requestId).toBe(requestId);
    expect(canonicalOwnedSessionStart(posted[0])).toBe(
      canonicalOwnedSessionStart({ ...item.input, requestId }),
    );
    client.dispose();
  });
}

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

for (const heldState of ["reserved", "not-sent"] as const) {
  test(`body re-entry compares the canonical original before reserve and resumes only that UUID from ${heldState}`, async () => {
    const scope = { projectId, workspace: "/repo", generation: 1 },
      originalRequest = { ...input, requestId },
      requestHash = await sessionStartHash(originalRequest);
    let reserveCount = 0,
      startCount = 0;
    const identityServer: SessionStartIdentityServer = {
      async list(current) {
        return {
          version: 1,
          scope: {
            family: "owned-session-start",
            projectId: current.projectId,
            workspace: current.workspace,
          },
          identities: [
            {
              version: 1,
              requestId,
              requestHash,
              provider: "claude",
              mode: "chat",
              state: heldState,
            },
          ],
        };
      },
      async reserve(current, original) {
        reserveCount++;
        return {
          scope: {
            family: "owned-session-start",
            projectId: current.projectId,
            workspace: current.workspace,
          },
          identity: {
            version: 1,
            requestId,
            requestHash,
            provider: "claude",
            mode: "chat",
            state: heldState,
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
      requestId: () => "b8ca8cbb-85d4-42a8-a464-a04aec0474d8",
      list: async () => [],
      read: async () => page,
      post: async (_project, _session, action, body) => {
        if (action !== "start") throw Error("Unexpected action");
        startCount++;
        expect(body).toMatchObject({ requestId });
        return { state: "unknown", message: "Keep exact original held" };
      },
      stream: () => () => ({ close() {} }),
    });

    await client.refreshIdentities(projectId);
    await client.resumeStart(projectId, {
      ...input,
      launch: { ...input.launch, prompt: "Changed original" },
    });
    expect(reserveCount).toBe(0);
    expect(startCount).toBe(0);
    await client.resumeStart(projectId, input);

    expect(reserveCount).toBe(1);
    expect(startCount).toBe(1);
    expect(client.project(projectId).pendingStart?.requestId).toBe(requestId);
    client.dispose();
  });
}

test("reserved-only retirement passes the current verified row and requires tombstone readback", async () => {
  const scope = { projectId, workspace: "/repo", generation: 1 },
    reserved = {
      version: 1 as const,
      requestId,
      requestHash: "c".repeat(64),
      provider: "claude" as const,
      mode: "chat" as const,
      state: "reserved" as const,
    };
  let state: "reserved" | "retired" | "attempted" = "reserved",
    retireCalls = 0;
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identities: [{ ...reserved, state }],
      };
    },
    async reserve() {
      throw Error("Unexpected reserve");
    },
    async retire(current, row) {
      retireCalls++;
      expect(row).toMatchObject(reserved);
      state = "retired";
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identity: { ...reserved, state: "retired" },
      };
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => scope,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async () => ({ state: "unknown", message: "Unexpected write" }),
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  expect(await client.retireIdentity(projectId, requestId)).toBe(true);
  expect(client.project(projectId).identityPage?.identities[0]?.state).toBe(
    "retired",
  );
  expect(await client.retireIdentity(projectId, requestId)).toBe(false);
  expect(retireCalls).toBe(1);
  state = "attempted";
  await client.refreshIdentities(projectId);
  expect(await client.retireIdentity(projectId, requestId)).toBe(false);
  expect(retireCalls).toBe(1);
  client.dispose();
});

test("confirmed retirement clears only the matching in-memory original request", async () => {
  const scope = { projectId, workspace: "/repo", generation: 1 };
  let state: "empty" | "reserved" | "retired" = "empty";
  let starts = 0;
  let requestHash = "";
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
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
                  requestHash,
                  provider: "claude",
                  mode: "chat",
                  state,
                },
              ],
      };
    },
    async reserve(current, original) {
      requestHash = await sessionStartHash(original);
      state = "reserved";
      return {
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identity: {
          version: 1,
          requestId,
          requestHash,
          provider: "claude",
          mode: "chat",
          state,
        },
        request: original,
        requestHash,
      };
    },
    async retire(current, reserved) {
      expect(reserved.requestId).toBe(requestId);
      state = "retired";
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identity: {
          version: 1,
          requestId,
          requestHash,
          provider: "claude",
          mode: "chat",
          state,
        },
      };
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => scope,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async (_project, _session, action) => {
      if (action !== "start") throw Error("Unexpected action");
      starts++;
      return { state: "unknown", message: "The original remains held." };
    },
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  await client.start(projectId, input);
  expect(starts).toBe(1);
  expect(client.project(projectId).pendingStart?.requestId).toBe(requestId);
  expect(await client.retireIdentity(projectId, requestId)).toBe(true);
  expect(client.project(projectId).pendingStart).toBeNull();
  expect(client.project(projectId).identityPage?.identities[0]?.state).toBe(
    "retired",
  );
  client.dispose();
});

test("identity mutations do not post when writing is disabled or the client is disposed", async () => {
  const scope = { projectId, workspace: "/repo", generation: 1 };
  let canWrite = true;
  let retireCalls = 0;
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identities: [
          {
            version: 1,
            requestId,
            requestHash: record.requestHash,
            provider: "claude",
            mode: "chat",
            state: "reserved",
          },
        ],
      };
    },
    async reserve() {
      throw Error("Unexpected reserve");
    },
    async retire() {
      retireCalls++;
      throw Error("Retire must not be sent");
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => scope,
    canWrite: () => canWrite,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async () => ({ state: "unknown", message: "Unexpected write" }),
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  canWrite = false;
  expect(await client.retireIdentity(projectId, requestId)).toBe(false);
  expect(retireCalls).toBe(0);

  canWrite = true;
  client.dispose();
  expect(await client.retireIdentity(projectId, requestId)).toBe(false);
  expect(retireCalls).toBe(0);
});

test("admitted identity inspection reads only the exact matching original and never posts", async () => {
  const scope = { projectId, workspace: "/repo", generation: 1 };
  let originalReads = 0,
    writes = 0;
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identities: [
          {
            version: 1,
            requestId,
            requestHash: record.requestHash,
            provider: "claude",
            mode: "chat",
            state: "admitted",
          },
        ],
      };
    },
    async reserve() {
      writes++;
      throw Error("Inspection must not reserve");
    },
    async retire() {
      writes++;
      throw Error("Inspection must not retire");
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => scope,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [record],
    read: async (_project, sessionId, query) => {
      expect(sessionId).toBe(id);
      expect(query.requestId).toBe(requestId);
      originalReads++;
      const originalTurn = { ...turn, hash: record.requestHash };
      return {
        ...page,
        request: originalTurn,
        turns: [originalTurn],
      };
    },
    post: async () => {
      writes++;
      return { state: "unknown", message: "Inspection must not post" };
    },
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  await client.refresh(projectId);
  expect(originalReads).toBe(0);
  expect(await client.inspectIdentity(projectId, requestId)).toBe(true);
  expect(originalReads).toBe(1);
  expect(writes).toBe(0);
  expect(client.project(projectId).identityInspection).toEqual({
    requestId,
    state: "verified",
    sessionId: id,
  });
  client.dispose();
});

for (const mismatch of ["turn-hash", "conversation-id"] as const) {
  test(`admitted inspection rejects a ${mismatch} mismatch without caching private session data`, async () => {
    const scope = { projectId, workspace: "/repo", generation: 1 };
    const identityServer: SessionStartIdentityServer = {
      async list(current) {
        return {
          version: 1,
          scope: {
            family: "owned-session-start",
            projectId: current.projectId,
            workspace: current.workspace,
          },
          identities: [
            {
              version: 1,
              requestId,
              requestHash: record.requestHash,
              provider: "claude",
              mode: "chat",
              state: "admitted",
            },
          ],
        };
      },
      async reserve() {
        throw Error("Inspection must not reserve");
      },
      async retire() {
        throw Error("Inspection must not retire");
      },
    };
    const client = createSessionsClient({
      identityServer,
      identityScope: () => scope,
      canWrite: () => true,
      requestId: () => requestId,
      list: async () => [record],
      read: async () => {
        const originalTurn = {
          ...turn,
          hash: mismatch === "turn-hash" ? "e".repeat(64) : record.requestHash,
        };
        return {
          ...page,
          ...(mismatch === "conversation-id"
            ? { conversationId: "session-other" }
            : {}),
          request: originalTurn,
          turns: [originalTurn],
        };
      },
      post: async () => ({
        state: "unknown",
        message: "Inspection is read-only",
      }),
      stream: () => () => ({ close() {} }),
    });

    await client.refreshIdentities(projectId);
    expect(await client.inspectIdentity(projectId, requestId)).toBe(false);
    expect(client.session(projectId, id).page).toBeNull();
    expect(client.project(projectId).identityInspection).toMatchObject({
      requestId,
      state: "unavailable",
      sessionId: null,
    });
    client.dispose();
  });
}

test("scope invalidation during an original read cannot publish stale inspection data", async () => {
  let scope = { projectId, workspace: "/repo", generation: 1 },
    finishRead: ((value: unknown) => void) | undefined,
    readStarted!: () => void;
  const readStartedSignal = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      return {
        version: 1,
        scope: {
          family: "owned-session-start",
          projectId: current.projectId,
          workspace: current.workspace,
        },
        identities: [
          {
            version: 1,
            requestId,
            requestHash: record.requestHash,
            provider: "claude",
            mode: "chat",
            state: "admitted",
          },
        ],
      };
    },
    async reserve() {
      throw Error("Inspection must not reserve");
    },
    async retire() {
      throw Error("Inspection must not retire");
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => scope,
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [record],
    read: async () =>
      new Promise((resolve) => {
        finishRead = resolve;
        readStarted();
      }),
    post: async () => ({
      state: "unknown",
      message: "Inspection is read-only",
    }),
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  const inspecting = client.inspectIdentity(projectId, requestId);
  await readStartedSignal;
  scope = { ...scope, workspace: "/other-repo" };
  client.identityScopeChanged();
  finishRead?.({
    ...page,
    request: { ...turn, hash: record.requestHash },
    turns: [{ ...turn, hash: record.requestHash }],
  });

  expect(await inspecting).toBe(false);
  expect(client.project(projectId).identityInspection).toBeNull();
  expect(client.session(projectId, id).page).toBeNull();
  client.dispose();
});

test("an unmatched read-only legacy hint keeps fresh Start held without clearing browser storage", async () => {
  let reserveCalls = 0,
    startCalls = 0;
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
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
      reserveCalls++;
      throw Error("Mismatched local hint must hold Start");
    },
    async retire() {
      throw Error("Unexpected retirement");
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => ({ projectId, workspace: "/repo", generation: 1 }),
    legacyHint: () => ({
      projectId,
      requestId,
      requestHash: "d".repeat(64),
      provider: "claude",
    }),
    canWrite: () => true,
    requestId: () => "b8ca8cbb-85d4-42a8-a464-a04aec0474d8",
    list: async () => [],
    read: async () => page,
    post: async () => {
      startCalls++;
      return { state: "unknown", message: "Unexpected Start" };
    },
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  await client.start(projectId, input);

  expect(client.project(projectId).legacyIdentityHint?.requestId).toBe(
    requestId,
  );
  expect(client.project(projectId).legacyIdentityError).not.toBe("");
  expect(reserveCalls).toBe(0);
  expect(startCalls).toBe(0);
  client.dispose();
});

test("identity hydration is GET-only and app construction does not reserve or post", async () => {
  let lists = 0,
    reserves = 0,
    retires = 0,
    posts = 0;
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      lists++;
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
      reserves++;
      throw Error("Hydration cannot reserve");
    },
    async retire() {
      retires++;
      throw Error("Hydration cannot retire");
    },
  };
  const client = createSessionsClient({
    identityServer,
    identityScope: () => ({ projectId, workspace: "/repo", generation: 1 }),
    canWrite: () => true,
    requestId: () => requestId,
    list: async () => [],
    read: async () => page,
    post: async () => {
      posts++;
      return { state: "unknown", message: "Hydration cannot Start" };
    },
    stream: () => () => ({ close() {} }),
  });

  client.project(projectId);
  expect(lists + reserves + retires + posts).toBe(0);
  await client.refreshIdentities(projectId);

  expect(lists).toBe(1);
  expect(reserves + retires + posts).toBe(0);
  client.dispose();
});

test("a readiness scope change while reserve is pending prevents the ordinary Start effect", async () => {
  let scope = { projectId, workspace: "/repo", generation: 1 },
    finishReserve:
      | ((
          value: Awaited<ReturnType<SessionStartIdentityServer["reserve"]>>,
        ) => void)
      | undefined,
    startPosts = 0,
    listCount = 0;
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
    reserve(_current, _original) {
      return new Promise((resolve) => {
        finishReserve = resolve;
      });
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
      startPosts++;
      return { state: "unknown", message: "No Start after scope change" };
    },
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  const starting = client.start(projectId, input);
  await Promise.resolve();
  scope = { ...scope, workspace: "/other-repo", generation: 2 };
  finishReserve?.({
    scope: {
      family: "owned-session-start",
      projectId,
      workspace: "/repo",
    },
    identity: {
      version: 1,
      requestId,
      requestHash: await sessionStartHash({ ...input, requestId }),
      provider: "claude",
      mode: "chat",
      state: "reserved",
    },
    request: { ...input, requestId },
    requestHash: await sessionStartHash({ ...input, requestId }),
  });
  await starting;

  expect(startPosts).toBe(0);
  expect(listCount).toBe(2);
  client.dispose();
});

test("disposal while reserve is pending prevents Start and performs no post-disposal identity read", async () => {
  const scope = { projectId, workspace: "/repo", generation: 1 };
  let finishReserve:
      | ((
          value: Awaited<ReturnType<SessionStartIdentityServer["reserve"]>>,
        ) => void)
      | undefined,
    lists = 0,
    starts = 0;
  const identityServer: SessionStartIdentityServer = {
    async list(current) {
      lists++;
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
    reserve() {
      return new Promise((resolve) => {
        finishReserve = resolve;
      });
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
      starts++;
      return { state: "unknown", message: "Disposed Start cannot post" };
    },
    stream: () => () => ({ close() {} }),
  });

  await client.refreshIdentities(projectId);
  const starting = client.start(projectId, input);
  await Promise.resolve();
  client.dispose();
  const requestHash = await sessionStartHash({ ...input, requestId });
  finishReserve?.({
    scope: {
      family: "owned-session-start",
      projectId,
      workspace: "/repo",
    },
    identity: {
      version: 1,
      requestId,
      requestHash,
      provider: "claude",
      mode: "chat",
      state: "reserved",
    },
    request: { ...input, requestId },
    requestHash,
  });
  await starting;

  expect(starts).toBe(0);
  expect(lists).toBe(1);
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
