import { afterEach, expect, test } from "bun:test";
import { ownedSessionControls } from "../../apps/desktop/src/session-controls";
import type { PreparedCodexChat } from "../../types/codex-chat";
import type { CodexChatOwnedRecord } from "../../types/codex-owned-chat";
import type { ConversationPage } from "../../types/conversation";
import type { GeminiOwnedSessionRecord } from "../../types/gemini-owned-task";
import type { PreparedGeminiTask } from "../../types/gemini-task-runtime";
import { createConversationStore } from "../conversations/store";
import { seedOwnedSession } from "../hearth/routes/session-fixture";
import { startTestHearth, type TestHearth } from "../hearth/testing";
import {
  CODEX_APP_SERVER_VERSION,
  serializeCodexChat,
} from "../sessions/codex-app-server-protocol";
import { serializeGeminiTask } from "../sessions/gemini-task";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("native Chat actions use its original snapshot and exact binding without inventing another turn or authority", () => {
  const requestId = "925f49e8-14b5-46d2-80f5-a143ae120bed";
  const record: CodexChatOwnedRecord = {
    id: `session-${requestId}`,
    requestId,
    projectId: "project-fixture",
    requestHash: "a".repeat(64),
    createdAt: "2026-10-23T00:00:00Z",
    provider: "codex",
    mode: "chat",
    smith: "codex-fixture",
    requestedModel: "exact-model",
    requestedEffort: null,
    repository: "/repo",
    workspace: "/repo",
    worktree: "/repo",
  };
  const snapshot: PreparedCodexChat = {
    version: 1,
    provider: "codex",
    smith: record.smith,
    cwd: "/repo",
    canonicalCwd: "/repo",
    capabilities: { version: CODEX_APP_SERVER_VERSION, flags: ["--stdio"] },
    launch: {
      mode: "chat",
      cwd: "/repo",
      model: "exact-model",
      prompt: "PRIVATE original",
      sandbox: "read-only",
      approvalPolicy: "on-request",
    },
  };
  const page: ConversationPage = {
    version: 1,
    projectId: record.projectId,
    conversationId: record.id,
    revision: 1,
    binding: {
      provider: "codex",
      sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      version: CODEX_APP_SERVER_VERSION,
    },
    frames: [
      {
        seq: 1,
        turnId: requestId,
        at: record.createdAt,
        event: {
          kind: "user",
          text: snapshot.launch.prompt,
          about: [],
          codexChat: snapshot,
        },
      },
    ],
    turns: [
      {
        requestId,
        hash: "a".repeat(64),
        phase: "completed",
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
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
  const controls = ownedSessionControls(input);
  expect(controls.resume.available).toBe(true);
  expect(controls.resume.reason).toContain("same confirmed Codex");
  const serialized = serializeCodexChat(snapshot.launch, snapshot.capabilities);
  expect(controls.commandPreview).toBe(
    `${serialized.equivalentCommand}\n\n${serialized.stdinNote}`,
  );
  expect(controls.commandPreview).not.toContain(snapshot.launch.prompt);
  expect([controls.fork.available, controls.terminal.available]).toEqual([
    false,
    false,
  ]);
  for (const changed of [
    { live: false },
    { pending: true },
    { stopping: true },
    { feedInterrupted: true },
    { readError: "unverified" },
    { page: { ...page, binding: null } },
    {
      page: {
        ...page,
        binding: {
          provider: "claude" as const,
          sessionId: "other",
          version: CODEX_APP_SERVER_VERSION,
        },
      },
    },
    {
      page: {
        ...page,
        binding: {
          provider: "codex" as const,
          sessionId: "native",
          version: "other-version",
        },
      },
    },
    { page: { ...page, projectId: "foreign" } },
    { page: { ...page, conversationId: "session-foreign" } },
    {
      page: {
        ...page,
        turns: page.turns.map((turn) => ({
          ...turn,
          phase: "unknown" as const,
        })),
      },
    },
  ])
    expect(
      ownedSessionControls({ ...input, ...changed }).resume.available,
    ).toBe(false);
  expect(
    ownedSessionControls({ ...input, page: { ...page, projectId: "foreign" } })
      .commandPreview,
  ).toBeNull();
  const active = {
    ...page,
    controllable: true,
    turns: page.turns.map((turn) => ({ ...turn, phase: "running" as const })),
  };
  expect(
    ownedSessionControls({ ...input, page: active }).permissions,
  ).toMatchObject({
    available: true,
    reason: expect.stringContaining("inline"),
  });
  const endedBeforeFinalStatus: ConversationPage = {
    ...active,
    frames: [
      ...active.frames,
      {
        seq: 2,
        turnId: requestId,
        at: record.createdAt,
        event: {
          kind: "coding-chat",
          provider: "codex",
          version: CODEX_APP_SERVER_VERSION,
          event: {
            kind: "outcome",
            outcome: {
              phase: "completed",
              reason: "Completed",
              threadId: page.binding!.sessionId,
              turnId: "0199a214-81c0-7800-8aa1-bbab2a035a53",
              observedModel: null,
              usage: null,
              exitCode: 0,
              stopped: false,
              timedOut: false,
            },
          },
        },
      },
    ],
  };
  const terminalControls = ownedSessionControls({
    ...input,
    page: endedBeforeFinalStatus,
  });
  expect(terminalControls.stop.available).toBe(false);
  expect(terminalControls.permissions.available).toBe(false);
  expect(terminalControls.resume.available).toBe(false);
  expect(
    ownedSessionControls({ ...input, page: active, stopping: true }).permissions
      .available,
  ).toBe(false);
  const never = {
    ...snapshot,
    launch: { ...snapshot.launch, approvalPolicy: "never" as const },
  };
  const withoutRequests = ownedSessionControls({
    ...input,
    page: {
      ...active,
      frames: active.frames.map((frame) => ({
        ...frame,
        event: {
          kind: "user",
          text: never.launch.prompt,
          about: [],
          codexChat: never,
        },
      })),
    },
  });
  expect(withoutRequests.permissions.available).toBe(false);
  expect(withoutRequests.permissions.reason).toContain("requests disabled");
});

test("Gemini uses its exact native Task preview and cannot borrow Chat continuation or permissions", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const original = await seedOwnedSession(h);
  const record: GeminiOwnedSessionRecord = {
    ...original,
    provider: "gemini",
    route: "gemini-cli",
    mode: "task",
    requestedModel: null,
    requestedEffort: null,
  };
  const state = createConversationStore(h.home, undefined, {
    kind: "session",
    projectId: record.projectId,
    sessionId: record.id,
  }).read(record.projectId);
  const snapshot: PreparedGeminiTask = {
    version: 1,
    provider: "gemini",
    smith: record.smith,
    canonicalRoot: record.workspace,
    canonicalCwd: record.worktree,
    command: ["gemini"],
    paths: [],
    capabilities: { version: "0.65.0", flags: ["--output-format"] },
    launch: {
      route: "gemini-cli",
      mode: "task",
      cwd: record.worktree,
      prompt: "PRIVATE native stdin",
    },
  };
  const page: ConversationPage = {
    ...state,
    binding: { provider: "gemini", sessionId: "native", version: "0.65.0" },
    frames: state.frames.map((frame) =>
      frame.event.kind === "user"
        ? {
            ...frame,
            event: {
              kind: "user",
              text: snapshot.launch.prompt,
              about: [],
              geminiTask: snapshot,
            },
          }
        : frame,
    ),
    more: false,
    nextCursor: state.frames.length,
    lastSequence: state.frames.length,
    request: null,
    controllable: false,
  };
  const controls = ownedSessionControls({
    record,
    page,
    loaded: true,
    live: true,
    pending: false,
    stopping: false,
  });
  const serialized = serializeGeminiTask(
    snapshot.launch,
    snapshot.capabilities,
  );
  expect(controls.commandPreview).toBe(
    `${serialized.equivalentCommand}\n\n${serialized.stdinNote}`,
  );
  expect(controls.commandPreview).not.toContain(snapshot.launch.prompt);
  expect(controls.resume.available).toBe(false);
  expect(controls.resume.reason).toContain("Gemini");
  expect(controls.resume.reason.includes("Codex")).toBe(false);
  expect(controls.permissions.inline).toBe(false);
  expect(controls.permissions.available).toBe(false);
});

test("controls offer terminal handoff only for an eligible Claude Chat and preserve other control guards", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const record = await seedOwnedSession(h);
  const state = createConversationStore(h.home, undefined, {
    kind: "session",
    projectId: record.projectId,
    sessionId: record.id,
  }).read(record.projectId);
  const page = {
    ...state,
    more: false,
    nextCursor: state.frames.length,
    lastSequence: state.frames.length,
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
  const idle = ownedSessionControls(input);
  expect(idle.resume.available).toBe(true);
  expect(idle.stop.available).toBe(false);
  expect(idle.commandPreview).toContain("--print");
  expect(idle.commandPreview).not.toContain("Historical private fixture");
  expect(idle.terminal.available).toBe(true);
  expect(idle.terminal.reason).toContain("Review the saved source input");
  expect([
    idle.fork.available,
    idle.permissions.available,
  ]).toEqual([false, false]);

  const running = {
    ...page,
    controllable: true,
    turns: page.turns.map((turn) => ({ ...turn, phase: "running" as const })),
  };
  for (const { changed, reason } of [
    {
      changed: { record: { ...record, mode: "task" as const } },
      reason: "Only a completed Claude Chat",
    },
    {
      changed: { record: { ...record, provider: "codex" as const } },
      reason: "only for a verified Claude Chat",
    },
    {
      changed: { record: { ...record, provider: "gemini" as const } },
      reason: "only for a verified Claude Chat",
    },
    {
      changed: { page: { ...page, binding: null } },
      reason: "confirmed Claude conversation id",
    },
    {
      changed: {
        page: {
          ...page,
          binding: { ...page.binding!, provider: "codex" as const },
        },
      },
      reason: "confirmed Claude conversation id and matching CLI version",
    },
    {
      changed: { page: { ...page, projectId: "foreign" } },
      reason: "does not match an ordinary session",
    },
    {
      changed: { page: { ...page, conversationId: "session-foreign" } },
      reason: "does not match an ordinary session",
    },
    {
      changed: {
        page: {
          ...page,
          turns: page.turns.map((turn) => ({
            ...turn,
            phase: "unknown" as const,
          })),
        },
      },
      reason: "Check the current turn and pending changes",
    },
    {
      changed: { page: running },
      reason: "current turn has not completed",
    },
    { changed: { live: false }, reason: "Reconnect the private conversation" },
    {
      changed: { pending: true },
      reason: "Check the current turn and pending changes",
    },
    {
      changed: { stopping: true },
      reason: "Check the current turn and pending changes",
    },
    {
      changed: { feedInterrupted: true },
      reason: "Reconnect the private conversation",
    },
    {
      changed: { readError: "unverified" },
      reason: "Reconnect the private conversation",
    },
  ]) {
    const terminal = ownedSessionControls({ ...input, ...changed }).terminal;
    expect(terminal.available).toBe(false);
    expect(terminal.reason).toContain(reason);
  }

  expect(ownedSessionControls({ ...input, live: false }).resume.available).toBe(
    false,
  );
  expect(
    ownedSessionControls({ ...input, page: { ...page, binding: null } }).resume
      .available,
  ).toBe(false);
  expect(
    ownedSessionControls({ ...input, pending: true }).resume.available,
  ).toBe(false);
  expect(
    ownedSessionControls({ ...input, record: { ...record, mode: "task" } })
      .resume.available,
  ).toBe(false);
  expect(
    ownedSessionControls({
      ...input,
      record: { ...record, provider: "codex", mode: "task" },
    }).resume.reason,
  ).toContain("one-turn Tasks");
  expect(ownedSessionControls({ ...input, page: running }).stop.available).toBe(
    true,
  );
  expect(
    ownedSessionControls({ ...input, page: running }).resume.available,
  ).toBe(false);
  expect(
    ownedSessionControls({ ...input, page: running, stopping: true }).stop
      .reason,
  ).toContain("pending");
  expect(
    ownedSessionControls({
      ...input,
      page: { ...running, controllable: false },
    }).stop.available,
  ).toBe(false);
});
