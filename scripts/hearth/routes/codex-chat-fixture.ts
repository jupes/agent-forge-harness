import { randomUUID } from "node:crypto";
import type {
  CodexChatDecisionReceipt,
  CodexChatOwnedRecord,
} from "../../../types/codex-owned-chat";
import { createConversationStore } from "../../conversations/store";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import { privatePacketHash } from "../../sessions/private-packet";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../../sessions/registry";
import type { TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

export const FIXTURE_CHAT_SESSION =
  "session-e2772860-2001-4ac0-88ca-56d81f7c518a";
export const FIXTURE_CHAT_DECISION = {
  requestId: "053567e4-1b60-47ea-aa1b-c4e05a4819b8",
  turnRequestId: "023834ee-4c0f-48d2-a360-77bf938661a2",
  approvalId: "8eaf6b78-7fb5-4c0a-ad01-19ad9660789b",
  decision: "decline" as const,
};
/** Historical receipt only. No fake PID is ever used to dispatch or stop a process. */
export async function seedChatDecision(h: TestHearth) {
  const registry = createSessionRegistry(h.home),
    projectId = FIXTURE_PROJECT_ID,
    sessionId = FIXTURE_CHAT_SESSION;
  const existing = registry.listAll(projectId);
  if (!existing.some((item) => item.id === sessionId)) {
    const record: CodexChatOwnedRecord = {
      provider: "codex",
      mode: "chat",
      projectId,
      id: sessionId,
      requestId: FIXTURE_CHAT_DECISION.turnRequestId,
      requestHash: "b".repeat(64),
      createdAt: new Date().toISOString(),
      workspace: h.workspace,
      repository: h.workspace,
      worktree: h.workspace,
      smith: "codex-journeyman",
      requestedModel: "exact-model",
      requestedEffort: null,
    };
    writeOwnerOnly(
      sessionRegistryFile(h.home),
      JSON.stringify({ version: 1, records: [...existing, record] }),
    );
  }
  const store = createConversationStore(h.home, undefined, {
    kind: "session",
    projectId,
    sessionId,
  });
  const original = store
    .read(projectId)
    .frames.find((frame) => frame.event.kind === "coding-chat-decision")?.event;
  if (original?.kind === "coding-chat-decision") return original.receipt;
  const version = "0.163.0-alpha.10.2",
    threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53",
    turnId = "0199a213-81c0-7800-8aa1-bbab2a035a54";
  await store.accept(projectId, {
    requestId: FIXTURE_CHAT_DECISION.turnRequestId,
    expectedRevision: 0,
    text: "Private approval fixture",
    about: [],
    codexChat: {
      version: 1,
      provider: "codex",
      smith: "codex-journeyman",
      cwd: h.workspace,
      canonicalCwd: h.workspace,
      capabilities: { version, flags: ["--stdio"] },
      launch: {
        mode: "chat",
        model: "exact-model",
        cwd: h.workspace,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        prompt: "Private approval fixture",
        context: {
          projectId,
          repository: h.workspace,
          worktree: h.workspace,
          about: [],
        },
      },
    },
  });
  const owner = randomUUID();
  await store.start(projectId, FIXTURE_CHAT_DECISION.turnRequestId, owner);
  await store.append(projectId, FIXTURE_CHAT_DECISION.turnRequestId, owner, {
    kind: "process",
    pid: 2_000_000_000,
    smith: "codex-journeyman",
    requestedModel: "exact-model",
    requestedEffort: "default",
  });
  await store.append(projectId, FIXTURE_CHAT_DECISION.turnRequestId, owner, {
    kind: "identity",
    provider: "codex",
    sessionId: threadId,
    version,
  });
  await store.append(projectId, FIXTURE_CHAT_DECISION.turnRequestId, owner, {
    kind: "coding-chat",
    provider: "codex",
    version,
    event: { kind: "turn", threadId, turnId },
  });
  await store.append(projectId, FIXTURE_CHAT_DECISION.turnRequestId, owner, {
    kind: "coding-chat",
    provider: "codex",
    version,
    event: {
      kind: "approval-request",
      approval: {
        id: FIXTURE_CHAT_DECISION.approvalId,
        provider: "codex",
        processId: 2_000_000_000,
        nativeRequestId: 1,
        nativeApprovalId: null,
        threadId,
        turnId,
        itemId: "command-a",
        kind: "command",
        command: "private fixture command",
        cwd: h.workspace,
        reason: null,
        availableDecisions: ["accept", "decline", "cancel"],
      },
    },
  });
  const receipt: CodexChatDecisionReceipt = {
    ...FIXTURE_CHAT_DECISION,
    projectId,
    sessionId,
    state: "recorded",
    recordedAt: new Date().toISOString(),
  };
  await store.append(projectId, FIXTURE_CHAT_DECISION.turnRequestId, owner, {
    kind: "coding-chat-decision",
    provider: "codex",
    version,
    receipt,
    requestHash: privatePacketHash({
      projectId,
      sessionId,
      ...FIXTURE_CHAT_DECISION,
    }),
  });
  await store.finish(
    projectId,
    FIXTURE_CHAT_DECISION.turnRequestId,
    owner,
    "completed",
    null,
  );
  return receipt;
}
