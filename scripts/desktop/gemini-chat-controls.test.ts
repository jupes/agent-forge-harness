import { expect, test } from "bun:test";
import { geminiChatPermissionAddress } from "../../apps/desktop/src/gemini-chat-authority";
import {
  createGeminiChatDecisionIdentities,
  GEMINI_CHAT_DECISION_IDENTITIES,
} from "../../apps/desktop/src/gemini-chat-decision-identities";
import { createGeminiChatDecisions } from "../../apps/desktop/src/gemini-chat-decisions";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import { ownedSessionControls } from "../../apps/desktop/src/session-controls";
import type { ConversationPage } from "../../types/conversation";
import type { PreparedGeminiChat } from "../../types/gemini-chat-runtime";
import type { GeminiChatOwnedRecord } from "../../types/gemini-owned-chat";
import { sessionStartFixture } from "./session-start-fixture";

const requestId = "925f49e8-14b5-46d2-80f5-a143ae120bed",
  at = "2026-10-23T00:00:00Z";
const record: GeminiChatOwnedRecord = {
  id: `session-${requestId}`,
  requestId,
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  requestHash: "a".repeat(64),
  createdAt: at,
  provider: "gemini",
  route: "gemini-cli",
  mode: "chat",
  smith: "gemini",
  requestedModel: null,
  requestedEffort: null,
  workspace: "/repo",
  repository: "/repo",
  worktree: "/repo",
};
const snapshot: PreparedGeminiChat = {
  version: 1,
  provider: "gemini",
  smith: "gemini",
  canonicalRoot: "/repo",
  canonicalCwd: "/repo",
  command: ["/native/gemini"],
  paths: [],
  capabilities: { version: "0.65.0", flags: ["--acp"] },
  launch: {
    route: "gemini-cli",
    mode: "chat",
    cwd: "/repo",
    prompt: "PRIVATE",
  },
};
const page: ConversationPage = {
  version: 1,
  projectId: record.projectId,
  conversationId: record.id,
  revision: 1,
  binding: { provider: "gemini", sessionId: "native", version: "0.65.0" },
  frames: [
    {
      seq: 1,
      turnId: requestId,
      at,
      event: { kind: "user", text: "PRIVATE", about: [], geminiChat: snapshot },
    },
  ],
  turns: [
    {
      requestId,
      hash: "a".repeat(64),
      phase: "completed",
      createdAt: at,
      updatedAt: at,
      reason: null,
      owner: null,
    },
  ],
  more: false,
  nextCursor: 1,
  lastSequence: 1,
  request: null,
  controllable: false,
};
const input = {
  record,
  page,
  loaded: true,
  live: true,
  pending: false,
  stopping: false,
};
test("Gemini Chat uses its actual ACP preview and exact native binding, never Task serialization", () => {
  const controls = ownedSessionControls(input);
  expect(controls.commandPreview).toContain("--acp");
  expect(controls.commandPreview).not.toContain("--output-format");
  expect(controls.commandPreview).not.toContain("PRIVATE");
  expect(controls.resume.available).toBe(true);
  expect(controls.permissions.inline).toBe(true);
  expect([controls.fork.available, controls.terminal.available]).toEqual([
    false,
    false,
  ]);
  for (const delta of [
    { live: false },
    { loaded: false },
    { pending: true },
    { stopping: true },
    { readError: "failed" },
    { feedInterrupted: true },
    { page: { ...page, projectId: "foreign" } },
    { page: { ...page, binding: null } },
    {
      page: {
        ...page,
        binding: {
          provider: "gemini" as const,
          sessionId: "native",
          version: "different",
        },
      },
    },
    { page: { ...page, frames: [] } },
  ])
    expect(ownedSessionControls({ ...input, ...delta }).resume.available).toBe(
      false,
    );
});
test("a saved native terminal withdraws Stop and permission controls before generic finalization", () => {
  const active = {
    ...page,
    controllable: true,
    turns: page.turns.map((turn) => ({ ...turn, phase: "running" as const })),
  };
  expect(
    ownedSessionControls({ ...input, page: active }).permissions.available,
  ).toBe(true);
  expect(ownedSessionControls({ ...input, page: active }).stop.available).toBe(
    true,
  );
  const ended: ConversationPage = {
    ...active,
    frames: [
      ...active.frames,
      {
        seq: 2,
        turnId: requestId,
        at,
        event: {
          kind: "coding-gemini-chat",
          provider: "gemini",
          version: "0.65.0",
          event: {
            kind: "outcome",
            outcome: {
              phase: "completed",
              sessionId: "native",
              reason: null,
              stopReason: "end_turn",
              usage: null,
            },
            exitCode: 0,
            stopped: false,
            timedOut: false,
            stderr: { text: "", truncated: false },
          },
        },
      },
    ],
  };
  const controls = ownedSessionControls({ ...input, page: ended });
  expect([
    controls.stop.available,
    controls.permissions.available,
    controls.resume.available,
  ]).toEqual([false, false, false]);
});

function liveOwner(
  options: { beforeLock?: () => Promise<void>; afterLock?: () => void } = {},
) {
  const fixture = sessionStartFixture(),
    client = createSessionsClient({
      identities: fixture.identities,
      canWrite: () => true,
      requestId: () => crypto.randomUUID(),
      list: async () => [],
      read: async () => null,
      post: async () => ({ state: "unknown", message: "Unexpected" }),
      stream: () => () => ({ close() {} }),
    });
  client.project(record.projectId).records = [record];
  const view = client.session(record.projectId, record.id);
  view.page = structuredClone({
    ...page,
    controllable: true,
    turns: page.turns.map((turn) => ({ ...turn, phase: "running" as const })),
  });
  view.live = true;
  view.loaded = true;
  const current = () =>
    geminiChatPermissionAddress({
      client,
      projectId: record.projectId,
      sessionId: record.id,
      writesAllowed: true,
      archived: false,
    });
  const approvalId = "fa5c45ae-8487-4c61-84a5-e22ab343c227";
  let mints = 0,
    posts = 0,
    writes = 0;
  const owner = createGeminiChatDecisions({
    identities: createGeminiChatDecisionIdentities({
      storage: {
        getItem: fixture.storage.getItem,
        setItem: (key, value) => {
          writes++;
          fixture.storage.setItem(key, value);
        },
      },
      withLock: async (work) => {
        await options.beforeLock?.();
        const result = await fixture.withLock(work);
        options.afterLock?.();
        return result;
      },
    }),
    canWrite: () => true,
    current,
    requestId: () => {
      mints++;
      return "93eb33c3-9386-4dda-a4d4-4b26d04d869a";
    },
    read: async (_p, _s, original) =>
      original
        ? {
            pending: [],
            receipt: {
              projectId: record.projectId,
              sessionId: record.id,
              requestId: original,
              turnRequestId: requestId,
              approvalId,
              optionId: "allow",
              state: "recorded",
              recordedAt: at,
            },
          }
        : {
            pending: [
              {
                turnRequestId: requestId,
                actionable: true,
                approval: {
                  id: approvalId,
                  detailsComplete: true,
                  detail: { json: '{"command":"PRIVATE"}', truncated: false },
                  options: [
                    {
                      optionId: "allow",
                      name: "Allow once",
                      kind: "allow_once",
                    },
                  ],
                },
              },
            ],
            receipt: null,
          },
    post: async () => {
      posts++;
      return { state: "unknown", message: "Lost answer" };
    },
  });
  owner.activate(current());
  return {
    fixture,
    client,
    view,
    owner,
    current,
    approvalId,
    counts: () => ({ mints, posts }),
    writes: () => writes,
  };
}
test("first render of accepted turn B cannot project or dispatch turn A's cards before activation effects", async () => {
  const f = liveOwner();
  try {
    await f.owner.refreshPending();
    expect(f.owner.view()?.pending).toHaveLength(1);
    const next = "18da5c95-3218-439c-a33d-e5662465f505";
    f.view.page!.turns.push({
      ...f.view.page!.turns[0]!,
      requestId: next,
      phase: "running",
    });
    expect(f.current().actionable).toBe(true);
    // No activate/render effect has run for B. Presentation and dispatch must read fresh scope.
    expect(f.owner.view()?.pending).toEqual([]);
    await f.owner.decide(f.approvalId, "allow");
    expect(f.counts()).toEqual({ mints: 0, posts: 0 });
    expect(
      f.fixture.storage.getItem(GEMINI_CHAT_DECISION_IDENTITIES),
    ).toBeNull();
  } finally {
    f.owner.dispose();
    f.client.dispose();
  }
});

test("a native terminal during origin-lock wait is rechecked before mint/save, and after-save withdrawal is checked before POST", async () => {
  let grant = () => {};
  const waiting = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const before = liveOwner({ beforeLock: () => waiting });
  try {
    await before.owner.refreshPending();
    const deciding = before.owner.decide(before.approvalId, "allow");
    before.view.stopUnknown = true;
    grant();
    await deciding;
    expect(before.counts()).toEqual({ mints: 0, posts: 0 });
    expect(before.writes()).toBe(0);
    expect(
      before.fixture.storage.getItem(GEMINI_CHAT_DECISION_IDENTITIES),
    ).toBeNull();
  } finally {
    grant();
    before.owner.dispose();
    before.client.dispose();
  }
  const after = liveOwner({
    afterLock: () => {
      after.view.stopUnknown = true;
    },
  });
  try {
    await after.owner.refreshPending();
    await after.owner.decide(after.approvalId, "allow");
    expect(after.counts()).toEqual({ mints: 1, posts: 0 });
    expect(after.writes()).toBe(2); // verified reservation, then release of this proven-unsent identity only
    expect(
      createGeminiChatDecisionIdentities({
        storage: after.fixture.storage,
        withLock: after.fixture.withLock,
      }).read(record.projectId, record.id),
    ).toBeNull();
  } finally {
    after.owner.dispose();
    after.client.dispose();
  }
});

test("a same-scope held original remains reconcilable after a new turn replaces all live authority", async () => {
  const f = liveOwner();
  try {
    await f.owner.refreshPending();
    await f.owner.decide(f.approvalId, "allow");
    expect(f.counts()).toEqual({ mints: 1, posts: 1 });
    f.view.page!.turns.push({
      ...f.view.page!.turns[0]!,
      requestId: "18da5c95-3218-439c-a33d-e5662465f505",
      phase: "running",
    });
    expect(f.owner.view()?.pending).toEqual([]);
    expect(f.owner.view()?.identity?.turnRequestId).toBe(requestId);
    await f.owner.checkOriginal();
    expect(f.owner.view()?.identity).toBeNull();
    expect(f.owner.view()?.receipt?.turnRequestId).toBe(requestId);
    expect(f.counts()).toEqual({ mints: 1, posts: 1 });
  } finally {
    f.owner.dispose();
    f.client.dispose();
  }
});
test("private terminal, read loss or Stop before paint blocks a new decision before saving its identity", async () => {
  for (const change of [
    "outcome",
    "read-error",
    "feed-lost",
    "stop",
    "owner-lost",
  ]) {
    const f = liveOwner();
    try {
      await f.owner.refreshPending();
      if (change === "outcome")
        f.view.page!.frames.push({
          seq: 2,
          turnId: requestId,
          at,
          event: {
            kind: "coding-gemini-chat",
            provider: "gemini",
            version: "0.65.0",
            event: {
              kind: "outcome",
              outcome: {
                phase: "completed",
                sessionId: "native",
                reason: null,
                stopReason: "end_turn",
                usage: null,
              },
              exitCode: 0,
              stopped: false,
              timedOut: false,
              stderr: { text: "", truncated: false },
            },
          },
        });
      if (change === "read-error") f.view.readError = "Protected read failed";
      if (change === "feed-lost") f.view.feedInterrupted = true;
      if (change === "stop") f.view.stopUnknown = true;
      if (change === "owner-lost") f.view.page!.controllable = false;
      // Neither hook activation nor the old actionable render has changed.
      await f.owner.decide(f.approvalId, "allow");
      expect(f.counts()).toEqual({ mints: 0, posts: 0 });
      expect(
        f.fixture.storage.getItem(GEMINI_CHAT_DECISION_IDENTITIES),
      ).toBeNull();
      expect(f.owner.view()?.pending).toEqual([]);
    } finally {
      f.owner.dispose();
      f.client.dispose();
    }
  }
});
