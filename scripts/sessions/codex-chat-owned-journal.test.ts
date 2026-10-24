import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eventSchema } from "../conversations/protocol";
import { createConversationStore } from "../conversations/store";
import {
  FIXTURE_CHAT_SESSION,
  seedChatDecision,
} from "../hearth/routes/codex-chat-fixture";
import { startTestHearth } from "../hearth/testing";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import {
  codexChatPrivateEventSchema,
  codexChatReasoningSummarySchema,
} from "./codex-chat-owned-journal";
import {
  ownedCodingPageSchema,
  ownedCodingStateSchema,
} from "./codex-owned-journal";

test("explicit summary codecs refuse raw fields, source/index confusion, incoherent closure and unbounded snapshot text", () => {
  const summary = {
    kind: "reasoning-summary",
    source: "item/started",
    threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    itemId: "reasoning",
    partial: true,
    update: {
      kind: "snapshot",
      summary: [],
      truncated: false,
      closure: "open",
      turnStatus: null,
    },
  };
  expect(codexChatReasoningSummarySchema.safeParse(summary).success).toBe(true);
  const delta = {
    ...summary,
    source: "item/reasoning/summaryTextDelta",
    update: {
      kind: "delta",
      summaryIndex: 0,
      content: { text: "Visible summary", truncated: false },
      prefixMissing: true,
    },
  };
  expect(codexChatReasoningSummarySchema.safeParse(delta).success).toBe(true);
  for (const change of [
    { source: "item/reasoning/textDelta" },
    { source: "codex.item.updated" },
    { partial: false },
    { content: "raw" },
    { encrypted_content: "raw" },
    { update: { ...delta.update, summaryIndex: 128 } },
    { update: { ...delta.update, contentIndex: 0 } },
    {
      update: {
        ...delta.update,
        content: { text: "🌱".repeat(4097), truncated: false },
      },
    },
    { update: { ...delta.update, content: { text: "\0", truncated: false } } },
  ])
    expect(
      codexChatReasoningSummarySchema.safeParse({ ...delta, ...change })
        .success,
    ).toBe(false);
  for (const update of [
    { ...summary.update, closure: "turn-ended", turnStatus: "completed" },
    { ...summary.update, summary: [{ text: "x", truncated: true }] },
    {
      ...summary.update,
      summary: Array.from({ length: 129 }, () => ({
        text: "",
        truncated: false,
      })),
    },
    {
      ...summary.update,
      summary: [
        { text: "x".repeat(16_384), truncated: false },
        { text: "y", truncated: false },
      ],
    },
  ])
    expect(
      codexChatReasoningSummarySchema.safeParse({ ...summary, update }).success,
    ).toBe(false);
  expect(
    codexChatPrivateEventSchema.safeParse({
      kind: "coding-chat",
      provider: "codex",
      version: "0.163.0-alpha.10.2",
      event: delta,
    }).success,
  ).toBe(true);
  expect(
    eventSchema.safeParse({
      kind: "coding-chat",
      provider: "codex",
      version: "0.163.0-alpha.10.2",
      event: delta,
    }).success,
  ).toBe(false);
});

test("private native approvals stay correlated with their exact Chat intent and native identity, and Keeper stays closed", async () => {
  const h = await startTestHearth();
  try {
    await seedChatDecision(h);
    const state = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: FIXTURE_CHAT_SESSION,
    }).read(FIXTURE_PROJECT_ID);
    expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
    const request = state.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "approval-request",
    );
    if (
      request?.event.kind !== "coding-chat" ||
      request.event.event.kind !== "approval-request"
    )
      throw Error("No native request fixture");
    expect(eventSchema.safeParse(request.event).success).toBe(false);
    const foreign = structuredClone(state),
      frame = foreign.frames.find((item) => item.seq === request.seq);
    if (
      frame?.event.kind !== "coding-chat" ||
      frame.event.event.kind !== "approval-request"
    )
      throw Error("No copied request");
    frame.event.event.approval.threadId = randomUUID();
    expect(ownedCodingStateSchema.safeParse(foreign).success).toBe(false);
    for (const change of [
      { processId: 123 },
      { turnId: randomUUID() },
      { id: randomUUID() },
    ]) {
      const altered = structuredClone(state),
        target = altered.frames.find((item) => item.seq === request.seq);
      if (
        target?.event.kind !== "coding-chat" ||
        target.event.event.kind !== "approval-request"
      )
        throw Error("No copied native request");
      Object.assign(target.event.event.approval, change);
      expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
    }
  } finally {
    await h.close();
  }
});

test("private Chat terminal reports are closed, one per accepted turn, and bound to its exact native identity on complete and partial reads", async () => {
  const h = await startTestHearth();
  try {
    await seedChatDecision(h);
    const state = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: FIXTURE_CHAT_SESSION,
    }).read(FIXTURE_PROJECT_ID);
    const turn = state.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" && frame.event.event.kind === "turn",
    );
    if (
      !state.binding ||
      turn?.event.kind !== "coding-chat" ||
      turn.event.event.kind !== "turn"
    )
      throw Error("No exact native fixture identity");
    const outcome = {
      phase: "completed",
      reason: null,
      threadId: state.binding.sessionId,
      turnId: turn.event.event.turnId,
      observedModel: null,
      usage: null,
      exitCode: 0,
      stopped: false,
      timedOut: false,
    } as const;
    const terminal = {
      seq: state.frames.length + 1,
      turnId: turn.turnId,
      at: turn.at,
      event: {
        kind: "coding-chat",
        provider: "codex",
        version: "0.163.0-alpha.10.2",
        event: { kind: "outcome", outcome },
      },
    } as const;
    const complete = {
      ...state,
      revision: state.revision + 1,
      frames: [...state.frames, terminal],
    };
    expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
    expect(ownedCodingStateSchema.safeParse(complete).success).toBe(true);
    for (const kind of ["user", "process", "identity"] as const) {
      const original = state.frames.find(
        (frame) => frame.turnId === turn.turnId && frame.event.kind === kind,
      );
      if (!original) throw Error(`Missing original ${kind} fixture`);
      expect(
        ownedCodingStateSchema.safeParse({
          ...complete,
          revision: complete.revision + 1,
          frames: [...complete.frames, { ...original, seq: terminal.seq + 1 }],
        }).success,
      ).toBe(false);
    }
    expect(
      ownedCodingStateSchema.safeParse({
        ...complete,
        revision: complete.revision + 1,
        frames: [
          ...complete.frames,
          {
            ...terminal,
            seq: terminal.seq + 1,
            event: { kind: "text", text: "Late untrusted provider output" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(eventSchema.safeParse(terminal.event).success).toBe(false);
    expect(
      ownedCodingStateSchema.safeParse({
        ...complete,
        frames: [...complete.frames, { ...terminal, seq: terminal.seq + 1 }],
      }).success,
    ).toBe(false);
    for (const changed of [
      { ...outcome, threadId: randomUUID() },
      { ...outcome, turnId: randomUUID() },
      { ...outcome, timedOut: true },
      { ...outcome, stopped: true },
      { ...outcome, observedModel: "invented execution model" },
      {
        ...outcome,
        usage: { lastResponse: { inputTokens: -1 }, threadTotal: {} },
      },
      { ...outcome, exitCode: "0" },
      { ...outcome, command: ["caller-selected-executable"] },
    ]) {
      const forged = {
        ...terminal,
        event: {
          ...terminal.event,
          event: { kind: "outcome", outcome: changed },
        },
      };
      expect(
        ownedCodingStateSchema.safeParse({
          ...complete,
          frames: [...state.frames, forged],
        }).success,
      ).toBe(false);
    }
    const page = {
      ...complete,
      frames: [terminal],
      more: false,
      nextCursor: terminal.seq,
      lastSequence: terminal.seq,
      request: state.turns[0],
      controllable: false,
    };
    expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
    expect(
      ownedCodingPageSchema.safeParse({
        ...page,
        binding: { ...state.binding, sessionId: randomUUID() },
      }).success,
    ).toBe(false);
    expect(
      codexChatPrivateEventSchema.safeParse({
        ...terminal.event,
        event: {
          kind: "outcome",
          outcome: {
            ...outcome,
            phase: "unknown",
            threadId: null,
            turnId: null,
            exitCode: null,
            usage: null,
          },
        },
      }).success,
    ).toBe(true);
  } finally {
    await h.close();
  }
});

test("a partial pre-identity Chat page can retain its already-saved actual process without treating it as native identity", async () => {
  const h = await startTestHearth();
  try {
    await seedChatDecision(h);
    const state = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: FIXTURE_CHAT_SESSION,
    }).read(FIXTURE_PROJECT_ID);
    const savedProcess = state.frames.find(
      (frame) => frame.event.kind === "process",
    );
    if (savedProcess?.event.kind !== "process")
      throw Error("No saved process fixture");
    const processFrame = {
      ...savedProcess,
      event: {
        kind: "coding-chat",
        provider: "codex",
        version: "0.163.0-alpha.10.2",
        event: {
          kind: "process",
          pid: savedProcess.event.pid,
          wrapperPid: 1_999_999_999,
          smith: "codex-journeyman",
          requestedModel: "exact-model",
          requestedEffort: null,
        },
      },
    };
    const page = {
      ...state,
      binding: null,
      frames: [processFrame],
      more: true,
      nextCursor: processFrame.seq,
      lastSequence: state.frames.length,
      request: state.turns[0],
      controllable: true,
    };
    expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
    const nativeFrame = {
      ...processFrame,
      event: {
        ...processFrame.event,
        event: {
          kind: "configuration",
          model: "exact-model",
          modelProvider: "openai",
          effort: null,
          cwd: h.workspace,
        },
      },
    };
    expect(
      ownedCodingPageSchema.safeParse({ ...page, frames: [nativeFrame] })
        .success,
    ).toBe(false);
    expect(
      ownedCodingStateSchema.safeParse({
        ...state,
        binding: null,
        frames: [processFrame],
      }).success,
    ).toBe(false);
    expect(eventSchema.safeParse(processFrame.event).success).toBe(false);
  } finally {
    await h.close();
  }
});
