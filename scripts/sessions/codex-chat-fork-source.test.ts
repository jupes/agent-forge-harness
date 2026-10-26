import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eventSchema } from "../conversations/protocol";
import { createConversationStore } from "../conversations/store";
import {
  FIXTURE_CHAT_DECISION,
  FIXTURE_CHAT_SESSION,
  seedChatDecision,
} from "../hearth/routes/codex-chat-fixture";
import { startTestHearth } from "../hearth/testing";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { resolveCodexChatForkSource } from "./codex-chat-fork-source";
import { ownedCodingStateSchema } from "./codex-owned-journal";

const version = "0.163.0-alpha.10.2";
const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const nativeTurnId = "0199a213-81c0-7800-8aa1-bbab2a035a54";

async function completeSource(h: Awaited<ReturnType<typeof startTestHearth>>) {
  await seedChatDecision(h);
  const store = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: FIXTURE_CHAT_SESSION,
    }),
    original = store.read(FIXTURE_PROJECT_ID),
    requestId = FIXTURE_CHAT_DECISION.turnRequestId,
    frames = original.frames.filter(
      (frame) =>
        !(
          frame.event.kind === "coding-chat-decision" ||
          (frame.event.kind === "coding-chat" &&
            frame.event.event.kind === "approval-request")
        ),
    );
  const at = frames.at(-1)?.at;
  if (!at) throw Error("Missing app-owned source turn.");
  const append = (event: unknown) => {
    frames.push({
      seq: frames.length + 1,
      turnId: requestId,
      at,
      event: eventSchema.parse(event),
    });
  };
  append({
    kind: "coding-chat",
    provider: "codex",
    version,
    event: {
      kind: "identity",
      provider: "codex",
      threadId,
      version,
    },
  });
  append({
    kind: "coding-chat",
    provider: "codex",
    version,
    event: {
      kind: "configuration",
      model: "exact-model",
      modelProvider: "openai",
      serviceTier: null,
      effort: null,
      cwd: h.workspace,
    },
  });
  append({
    kind: "coding-chat",
    provider: "codex",
    version,
    event: {
      kind: "outcome",
      outcome: {
        phase: "completed",
        reason: null,
        threadId,
        turnId: nativeTurnId,
        observedModel: null,
        usage: null,
        exitCode: null,
        stopped: false,
        timedOut: false,
      },
    },
  });
  return {
    state: ownedCodingStateSchema.parse({
      ...original,
      revision: frames.length,
      frames,
    }),
    workspace: h.workspace,
    requestId,
  };
}

test("Fork source requires explicit tier evidence while preserving known null and strings", async () => {
  const h = await startTestHearth();
  try {
    const source = await completeSource(h),
      resolve = (state: unknown) =>
        resolveCodexChatForkSource({
          state,
          projectId: FIXTURE_PROJECT_ID,
          conversationId: FIXTURE_CHAT_SESSION,
          workspace: source.workspace,
          selectedTurnRequestId: source.requestId,
        });
    const eligible = resolve(source.state);
    expect(eligible).toMatchObject({
      eligible: true,
      parent: { provider: "codex", threadId, version },
      selectedTurnRequestId: source.requestId,
      lastTurnId: nativeTurnId,
      sourceSettings: { modelProvider: "openai", serviceTier: null },
    });

    const config = source.state.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "configuration",
    );
    if (
      config?.event.kind !== "coding-chat" ||
      config.event.event.kind !== "configuration"
    )
      throw Error("Missing selected configuration evidence.");
    const legacy = structuredClone(source.state);
    const legacyConfig = legacy.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "configuration",
    );
    if (
      legacyConfig?.event.kind !== "coding-chat" ||
      legacyConfig.event.event.kind !== "configuration"
    )
      throw Error("Missing legacy configuration evidence.");
    delete legacyConfig.event.event.serviceTier;
    expect(ownedCodingStateSchema.safeParse(legacy).success).toBe(true);
    expect(resolve(legacy)).toEqual({
      eligible: false,
      reason: "service-tier-unknown",
    });

    const stringTier = structuredClone(source.state);
    const stringConfig = stringTier.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "configuration",
    );
    if (
      stringConfig?.event.kind !== "coding-chat" ||
      stringConfig.event.event.kind !== "configuration"
    )
      throw Error("Missing selected configuration evidence.");
    stringConfig.event.event.serviceTier = "priority";
    expect(resolve(stringTier)).toMatchObject({
      eligible: true,
      sourceSettings: { serviceTier: "priority" },
    });

    const malformedTier = structuredClone(source.state),
      malformedConfig = malformedTier.frames.find(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "configuration",
      );
    if (
      malformedConfig?.event.kind !== "coding-chat" ||
      malformedConfig.event.event.kind !== "configuration"
    )
      throw Error("Missing selected configuration evidence.");
    Object.assign(malformedConfig.event.event, { serviceTier: 123 });
    expect(resolve(malformedTier)).toEqual({
      eligible: false,
      reason: "invalid-state",
    });
  } finally {
    await h.close();
  }
});

test("Fork source resolves only the exact selected completed turn and refuses scope or contradictory evidence", async () => {
  const h = await startTestHearth();
  try {
    const source = await completeSource(h),
      resolve = (state: unknown, selectedTurnRequestId = source.requestId) =>
        resolveCodexChatForkSource({
          state,
          projectId: FIXTURE_PROJECT_ID,
          conversationId: FIXTURE_CHAT_SESSION,
          workspace: source.workspace,
          selectedTurnRequestId,
        }),
      selected = resolve(source.state);
    expect(selected.eligible).toBe(true);
    expect(resolve(source.state, randomUUID())).toEqual({
      eligible: false,
      reason: "turn-not-completed",
    });
    expect(
      resolveCodexChatForkSource({
        state: source.state,
        projectId: randomUUID(),
        conversationId: FIXTURE_CHAT_SESSION,
        workspace: source.workspace,
        selectedTurnRequestId: source.requestId,
      }),
    ).toEqual({ eligible: false, reason: "scope-mismatch" });
    expect(
      resolveCodexChatForkSource({
        state: source.state,
        projectId: FIXTURE_PROJECT_ID,
        conversationId: FIXTURE_CHAT_SESSION,
        workspace: `${source.workspace}-other`,
        selectedTurnRequestId: source.requestId,
      }),
    ).toEqual({ eligible: false, reason: "scope-mismatch" });

    const laterRequestId = randomUUID(),
      laterNativeTurnId = randomUUID(),
      laterFrames = structuredClone(source.state.frames).map((frame, index) => {
        const copy = { ...frame, seq: source.state.frames.length + index + 1 };
        copy.turnId = laterRequestId;
        if (
          copy.event.kind === "coding-chat" &&
          copy.event.event.kind === "turn"
        )
          copy.event.event.turnId = laterNativeTurnId;
        else if (
          copy.event.kind === "coding-chat" &&
          copy.event.event.kind === "outcome"
        )
          copy.event.event.outcome.turnId = laterNativeTurnId;
        else if (
          copy.event.kind === "coding-chat" &&
          copy.event.event.kind === "configuration"
        ) {
          copy.event.event.modelProvider = "later-provider";
          copy.event.event.serviceTier = "later-tier";
        }
        return copy;
      }),
      firstTurn = source.state.turns[0];
    if (!firstTurn) throw Error("Missing original app turn.");
    const withLater = ownedCodingStateSchema.parse({
      ...source.state,
      revision: source.state.frames.length + laterFrames.length,
      turns: [
        ...source.state.turns,
        { ...firstTurn, requestId: laterRequestId },
      ],
      frames: [...source.state.frames, ...laterFrames],
    });
    expect(resolve(withLater)).toMatchObject({
      eligible: true,
      selectedTurnRequestId: source.requestId,
      lastTurnId: nativeTurnId,
      sourceSettings: { modelProvider: "openai", serviceTier: null },
    });

    const active = structuredClone(source.state);
    if (!active.turns[0]) throw Error("Missing original app turn.");
    active.turns[0].phase = "running";
    expect(resolve(active)).toEqual({
      eligible: false,
      reason: "turn-not-completed",
    });

    const pendingApproval = structuredClone(source.state),
      outcomeIndex = pendingApproval.frames.findIndex(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "outcome",
      ),
      previousFrame = pendingApproval.frames.at(-1);
    if (outcomeIndex < 0 || !previousFrame)
      throw Error("Missing fixture outcome or timestamp.");
    const approvalFrame = {
      seq: outcomeIndex + 1,
      turnId: source.requestId,
      at: previousFrame.at,
      event: eventSchema.parse({
        kind: "coding-chat",
        provider: "codex",
        version,
        event: {
          kind: "approval-request",
          approval: {
            id: randomUUID(),
            provider: "codex",
            processId: 2_000_000_000,
            nativeRequestId: 1,
            nativeApprovalId: null,
            threadId,
            turnId: nativeTurnId,
            itemId: "pending-command",
            kind: "command",
            command: "inert fixture command",
            cwd: source.workspace,
            reason: null,
            availableDecisions: ["decline"],
          },
        },
      }),
    };
    pendingApproval.frames.splice(outcomeIndex, 0, approvalFrame);
    pendingApproval.frames.forEach((frame, index) => {
      frame.seq = index + 1;
    });
    pendingApproval.revision = pendingApproval.frames.length;
    expect(resolve(pendingApproval)).toEqual({
      eligible: false,
      reason: "approval-pending",
    });

    const duplicated = structuredClone(source.state),
      configFrame = source.state.frames.find(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "configuration",
      );
    if (!configFrame) throw Error("Missing config frame.");
    duplicated.frames.push({
      ...structuredClone(configFrame),
      seq: duplicated.frames.length + 1,
    });
    duplicated.revision = duplicated.frames.length;
    expect(resolve(duplicated)).toEqual({
      eligible: false,
      reason: "source-incomplete",
    });
  } finally {
    await h.close();
  }
});
