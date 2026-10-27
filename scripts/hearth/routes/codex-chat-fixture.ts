import { createHash, randomUUID } from "node:crypto";
import type {
  CodexChatDecisionReceipt,
  CodexChatOwnedRecord,
} from "../../../types/codex-owned-chat";
import { conversationFile } from "../../conversations/paths";
import { createConversationStore } from "../../conversations/store";
import { workspaceKey } from "../../projects/scope";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import {
  ownedCodingEventSchema,
  ownedCodingStateSchema,
} from "../../sessions/codex-owned-journal";
import { codexChatOwnedSessionSchema } from "../../sessions/codex-owned-metadata";
import { canonicalOwnedSessionStart } from "../../sessions/codex-owned-protocol";
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
export interface CodexChatFixtureIdentity {
  sessionId: string;
  requestId: string;
  turnRequestId: string;
  approvalId: string;
  threadId: string;
  turnId: string;
}
const DEFAULT_CHAT_IDENTITY: CodexChatFixtureIdentity = {
  sessionId: FIXTURE_CHAT_SESSION,
  ...FIXTURE_CHAT_DECISION,
  threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
};
/** Historical receipt only. No fake PID is ever used to dispatch or stop a process. */
export async function seedChatDecision(
  h: TestHearth,
  identity: CodexChatFixtureIdentity = DEFAULT_CHAT_IDENTITY,
) {
  const registry = createSessionRegistry(h.home),
    projectId = FIXTURE_PROJECT_ID,
    sessionId = identity.sessionId;
  const existing = registry.listAll(projectId);
  if (!existing.some((item) => item.id === sessionId)) {
    const record: CodexChatOwnedRecord = {
      provider: "codex",
      mode: "chat",
      projectId,
      id: sessionId,
      requestId: identity.turnRequestId,
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
    .frames.find(
      (frame) =>
        frame.event.kind === "coding-chat-decision" &&
        frame.event.receipt.requestId === identity.requestId,
    )?.event;
  if (original?.kind === "coding-chat-decision") return original.receipt;
  const version = "0.163.0-alpha.10.2",
    threadId = identity.threadId,
    turnId = identity.turnId;
  await store.accept(projectId, {
    requestId: identity.turnRequestId,
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
  await store.start(projectId, identity.turnRequestId, owner);
  await store.append(projectId, identity.turnRequestId, owner, {
    kind: "process",
    pid: 2_000_000_000,
    smith: "codex-journeyman",
    requestedModel: "exact-model",
    requestedEffort: "default",
  });
  await store.append(projectId, identity.turnRequestId, owner, {
    kind: "identity",
    provider: "codex",
    sessionId: threadId,
    version,
  });
  await store.append(projectId, identity.turnRequestId, owner, {
    kind: "coding-chat",
    provider: "codex",
    version,
    event: { kind: "turn", threadId, turnId },
  });
  await store.append(projectId, identity.turnRequestId, owner, {
    kind: "coding-chat",
    provider: "codex",
    version,
    event: {
      kind: "approval-request",
      approval: {
        id: identity.approvalId,
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
    requestId: identity.requestId,
    turnRequestId: identity.turnRequestId,
    approvalId: identity.approvalId,
    decision: "decline",
    projectId,
    sessionId,
    state: "recorded",
    recordedAt: new Date().toISOString(),
  };
  await store.append(projectId, identity.turnRequestId, owner, {
    kind: "coding-chat-decision",
    provider: "codex",
    version,
    receipt,
    requestHash: privatePacketHash({
      projectId,
      sessionId,
      requestId: identity.requestId,
      turnRequestId: identity.turnRequestId,
      approvalId: identity.approvalId,
      decision: "decline",
    }),
  });
  await store.finish(
    projectId,
    identity.turnRequestId,
    owner,
    "completed",
    null,
  );
  return receipt;
}

/** A complete inert completed-source record for Fork route inventory fixtures. */
export async function seedForkableCodexChatSource(
  h: TestHearth,
  identity: CodexChatFixtureIdentity = DEFAULT_CHAT_IDENTITY,
) {
  await seedChatDecision(h, identity);
  const projectId = FIXTURE_PROJECT_ID,
    sessionId = identity.sessionId,
    requestId = identity.turnRequestId,
    version = "0.163.0-alpha.10.2",
    threadId = identity.threadId,
    turnId = identity.turnId,
    store = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId,
      sessionId,
    }),
    original = store.read(projectId),
    frames = original.frames.filter(
      (frame) =>
        frame.event.kind !== "coding-chat-decision" &&
        !(
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "approval-request"
        ),
    );
  const at = frames.at(-1)?.at;
  if (!at) throw Error("Missing app-owned source turn.");
  const append = (event: unknown) => {
    frames.push({
      seq: frames.length + 1,
      turnId: requestId,
      at,
      event: ownedCodingEventSchema.parse(event),
    });
  };
  if (
    !frames.some(
      (frame) => frame.turnId === requestId && frame.event.kind === "identity",
    )
  )
    frames.push({
      seq: frames.length + 1,
      turnId: requestId,
      at,
      event: {
        kind: "identity",
        provider: "codex",
        sessionId: threadId,
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
        turnId,
        observedModel: null,
        usage: null,
        exitCode: 0,
        stopped: false,
        timedOut: false,
      },
    },
  });
  const state = ownedCodingStateSchema.parse({
      ...original,
      revision: frames.length,
      frames,
    }),
    user = state.frames.find(
      (frame) => frame.turnId === requestId && frame.event.kind === "user",
    )?.event;
  if (user?.kind !== "user" || !("codexChat" in user) || !user.codexChat)
    throw Error("Missing normalized original private Chat request.");
  const registry = createSessionRegistry(h.home, "codex", "chat"),
    owner = registry.read(projectId, sessionId),
    { cwd: _cwd, context: _context, ...launch } = user.codexChat.launch,
    requestHash = createHash("sha256")
      .update(
        canonicalOwnedSessionStart({
          requestId: owner.requestId,
          provider: "codex",
          smith: owner.smith,
          repository: owner.repository,
          worktree: owner.worktree,
          ...(owner.beadId ? { beadId: owner.beadId } : {}),
          about: user.about,
          launch,
        }),
      )
      .digest("hex"),
    selectedOwner = codexChatOwnedSessionSchema.parse({
      ...owner,
      requestHash,
    }),
    records = registry.listAll(projectId);
  writeOwnerOnly(
    sessionRegistryFile(h.home),
    JSON.stringify({
      version: 1,
      records: records.map((record) =>
        record.id === sessionId ? selectedOwner : record,
      ),
    }),
  );
  writeOwnerOnly(
    conversationFile(h.home, projectId, {
      kind: "session",
      projectId,
      sessionId,
    }),
    `${JSON.stringify(state)}\n`,
  );
  return {
    projectId,
    parentSessionId: sessionId,
    throughTurnRequestId: requestId,
    workspace: workspaceKey(h.workspace),
  };
}
