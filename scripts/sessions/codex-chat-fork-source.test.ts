import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PreparedCodexChat } from "../../types/codex-chat";
import type { CodexChatOwnedRecord } from "../../types/codex-owned-chat";
import type { ConversationObject } from "../../types/conversation";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import {
  FIXTURE_CHAT_DECISION,
  FIXTURE_CHAT_SESSION,
  seedChatDecision,
} from "../hearth/routes/codex-chat-fixture";
import { startTestHearth } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { workspaceKey } from "../projects/scope";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import {
  createCodexChatForkCoordinator,
  resolveCodexChatForkPrefix,
} from "./codex-chat-fork-coordinator";
import { createCodexChatForkJournal } from "./codex-chat-fork-journal";
import { resolveCodexChatForkSource } from "./codex-chat-fork-source";
import {
  ownedCodingEventSchema,
  ownedCodingStateSchema,
} from "./codex-owned-journal";
import { codexChatOwnedSessionSchema } from "./codex-owned-metadata";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";
import { createSessionRegistry, sessionRegistryFile } from "./registry";

const version = "0.163.0-alpha.10.2";
const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const nativeTurnId = "0199a213-81c0-7800-8aa1-bbab2a035a54";

function originalRequestHash(
  owner: CodexChatOwnedRecord,
  prepared: PreparedCodexChat,
  about: ConversationObject[],
  includeAbout = true,
) {
  const { cwd: _cwd, context: _context, ...launch } = prepared.launch;
  return createHash("sha256")
    .update(
      canonicalOwnedSessionStart({
        requestId: owner.requestId,
        provider: "codex",
        smith: owner.smith,
        repository: owner.repository,
        worktree: owner.worktree,
        ...(owner.beadId ? { beadId: owner.beadId } : {}),
        ...(includeAbout ? { about } : {}),
        launch,
      }),
    )
    .digest("hex");
}

function conversationTurnHash(input: {
  text: string;
  about: ConversationObject[];
  codexChat: PreparedCodexChat;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: input.text,
        about: input.about,
        codexChat: input.codexChat,
      }),
    )
    .digest("hex");
}

async function completeSource(
  h: Awaited<ReturnType<typeof startTestHearth>>,
  beadId?: string,
) {
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
        turnId: nativeTurnId,
        observedModel: null,
        usage: null,
        exitCode: 0,
        stopped: false,
        timedOut: false,
      },
    },
  });
  let state = ownedCodingStateSchema.parse({
    ...original,
    revision: frames.length,
    frames,
  });
  if (beadId) {
    const originalUser = state.frames.find(
      (frame) => frame.turnId === requestId && frame.event.kind === "user",
    )?.event;
    if (
      originalUser?.kind !== "user" ||
      !("codexChat" in originalUser) ||
      !originalUser.codexChat
    )
      throw Error("Missing original private Chat request.");
    const prepared = originalUser.codexChat,
      context = prepared.launch.context;
    if (!context) throw Error("Missing source context for bead fixture.");
    originalUser.codexChat = {
      ...prepared,
      launch: {
        ...prepared.launch,
        context: { ...context, beadId },
      },
    };
    state = ownedCodingStateSchema.parse(state);
  }
  const originalUser = state.frames.find(
    (frame) => frame.turnId === requestId && frame.event.kind === "user",
  )?.event;
  if (
    originalUser?.kind !== "user" ||
    !("codexChat" in originalUser) ||
    !originalUser.codexChat
  )
    throw Error("Missing normalized original private Chat request.");
  if (beadId) {
    const selectedTurn = state.turns.find(
      (turn) => turn.requestId === requestId,
    );
    if (!selectedTurn) throw Error("Missing source turn for bead fixture.");
    selectedTurn.hash = conversationTurnHash({
      text: originalUser.text,
      about: originalUser.about,
      codexChat: originalUser.codexChat,
    });
  }
  state = ownedCodingStateSchema.parse(state);
  const owner = createSessionRegistry(h.home, "codex", "chat").read(
    FIXTURE_PROJECT_ID,
    FIXTURE_CHAT_SESSION,
  );
  const finalOwner = {
    ...owner,
    ...(beadId ? { beadId } : {}),
    requestHash: originalRequestHash(
      { ...owner, ...(beadId ? { beadId } : {}) },
      originalUser.codexChat,
      originalUser.about,
    ),
  };
  return {
    state: ownedCodingStateSchema.parse(state),
    workspace: h.workspace,
    requestId,
    owner: finalOwner,
  };
}

function persistCoordinatorSource(
  h: Awaited<ReturnType<typeof startTestHearth>>,
  source: Awaited<ReturnType<typeof completeSource>>,
) {
  const parent = codexChatOwnedSessionSchema.parse(source.owner),
    registry = createSessionRegistry(h.home),
    records = registry.listAll(FIXTURE_PROJECT_ID);
  writeOwnerOnly(
    sessionRegistryFile(h.home),
    JSON.stringify({
      version: 1,
      records: records.map((record) =>
        record.id === parent.id ? parent : record,
      ),
    }),
  );
  writeOwnerOnly(
    conversationFile(h.home, FIXTURE_PROJECT_ID, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: parent.id,
    }),
    `${JSON.stringify(source.state)}\n`,
  );
  return parent;
}

test("Fork source requires explicit tier evidence while preserving known null and strings", async () => {
  const h = await startTestHearth();
  try {
    const source = await completeSource(h),
      resolve = (state: unknown, owner = source.owner) =>
        resolveCodexChatForkSource({
          owner,
          state,
          projectId: FIXTURE_PROJECT_ID,
          conversationId: FIXTURE_CHAT_SESSION,
          workspaceKey: source.workspace,
          selectedTurnRequestId: source.requestId,
        });
    const eligible = resolve(source.state);
    expect(source.owner.beadId).toBeUndefined();
    expect(eligible).toMatchObject({
      eligible: true,
      parent: { provider: "codex", threadId, version },
      selectedTurnRequestId: source.requestId,
      lastTurnId: nativeTurnId,
      sourceSettings: { modelProvider: "openai", serviceTier: null },
    });
    if (!eligible.eligible) throw Error("Missing prepared source evidence.");
    const omittedAboutOwner = {
      ...source.owner,
      requestHash: originalRequestHash(
        source.owner,
        eligible.prepared,
        [],
        false,
      ),
    };
    expect(resolve(source.state, omittedAboutOwner).eligible).toBe(true);

    const nestedIdentity = structuredClone(source.state),
      terminalIndex = nestedIdentity.frames.findIndex(
        (frame) =>
          frame.turnId === source.requestId &&
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "outcome",
      ),
      selectedFrame = nestedIdentity.frames.find(
        (frame) => frame.turnId === source.requestId,
      );
    if (terminalIndex < 0 || !selectedFrame)
      throw Error("Missing selected turn for identity-conflict fixture.");
    nestedIdentity.frames.splice(terminalIndex, 0, {
      seq: terminalIndex + 1,
      turnId: source.requestId,
      at: selectedFrame.at,
      event: ownedCodingEventSchema.parse({
        kind: "coding-chat",
        provider: "codex",
        version,
        event: { kind: "identity", provider: "codex", threadId, version },
      }),
    });
    nestedIdentity.frames.forEach((frame, index) => {
      frame.seq = index + 1;
    });
    nestedIdentity.revision = nestedIdentity.frames.length;
    const parsedNestedIdentity =
      ownedCodingStateSchema.safeParse(nestedIdentity);
    if (!parsedNestedIdentity.success)
      throw Error("Identity-conflict fixture is not a valid owned state.");
    expect(resolve(parsedNestedIdentity.data)).toEqual({
      eligible: false,
      reason: "source-incomplete",
    });

    const changedTurnHash = structuredClone(source.state);
    if (!changedTurnHash.turns[0]) throw Error("Missing selected app turn.");
    changedTurnHash.turns[0].hash = "c".repeat(64);
    expect(resolve(changedTurnHash)).toEqual({
      eligible: false,
      reason: "turn-hash-mismatch",
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

    const unsupportedEffort = structuredClone(source.state),
      unsupportedConfig = unsupportedEffort.frames.find(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "configuration",
      );
    if (
      unsupportedConfig?.event.kind !== "coding-chat" ||
      unsupportedConfig.event.event.kind !== "configuration"
    )
      throw Error("Missing selected configuration evidence.");
    unsupportedConfig.event.event.effort = "medium";
    expect(ownedCodingStateSchema.safeParse(unsupportedEffort).success).toBe(
      true,
    );
    expect(resolve(unsupportedEffort)).toEqual({
      eligible: false,
      reason: "unsupported-source",
    });

    const beadSource = await completeSource(h, "alpha-1"),
      beadResult = resolveCodexChatForkSource({
        owner: beadSource.owner,
        state: beadSource.state,
        projectId: FIXTURE_PROJECT_ID,
        conversationId: FIXTURE_CHAT_SESSION,
        workspaceKey: beadSource.workspace,
        selectedTurnRequestId: beadSource.requestId,
      });
    expect(beadSource.owner.beadId).toBe("alpha-1");
    expect(beadResult).toMatchObject({
      eligible: true,
      lastTurnId: nativeTurnId,
    });
  } finally {
    await h.close();
  }
});

test("the filesystem coordinator captures once, adopts the exact child and resolves only the saved prefix", async () => {
  const h = await startTestHearth();
  try {
    const source = await completeSource(h),
      parent = persistCoordinatorSource(h, source),
      verifiedSource = resolveCodexChatForkSource({
        owner: parent,
        state: source.state,
        projectId: FIXTURE_PROJECT_ID,
        conversationId: parent.id,
        workspaceKey: h.workspace,
        selectedTurnRequestId: source.requestId,
      });
    if (!verifiedSource.eligible)
      throw Error("Fixture source is not Fork eligible.");
    const childNativeThreadId = "0199a213-81c0-7800-8aa1-bbab2a035a61",
      selectedRequestId = randomUUID();
    let runtimeCalls = 0,
      auditCalls = 0;
    const coordinator = createCodexChatForkCoordinator({
      root: h.root,
      home: h.home,
      runtime: {
        async fork() {
          runtimeCalls++;
          return {
            parentThreadId: threadId,
            lastTurnId: nativeTurnId,
            threadId: childNativeThreadId,
            forkedFromId: threadId,
            cliVersion: version,
            status: "idle" as const,
            canAcceptDirectInput: true as const,
            settings: {
              model: verifiedSource.prepared.launch.model,
              modelProvider: verifiedSource.sourceSettings.modelProvider,
              serviceTier: verifiedSource.sourceSettings.serviceTier,
              cwd: verifiedSource.prepared.canonicalCwd,
              approvalPolicy: verifiedSource.prepared.launch.approvalPolicy,
              approvalsReviewer: "user" as const,
              sandbox: verifiedSource.prepared.launch.sandbox,
              reasoningEffort: verifiedSource.sourceSettings.reasoningEffort,
            },
            runtimeWorkspaceRoots: [h.workspace],
            writableRoots: [],
          };
        },
      },
      async validateScope(record) {
        if (
          record.projectId !== FIXTURE_PROJECT_ID ||
          workspaceKey(record.workspace) !== workspaceKey(h.workspace)
        )
          throw Error("Fixture scope changed.");
      },
      async appendAudit() {
        auditCalls++;
      },
    });
    const request = {
        requestId: selectedRequestId,
        throughTurnRequestId: source.requestId,
      },
      input = {
        projectId: FIXTURE_PROJECT_ID,
        parentSessionId: parent.id,
        request,
      },
      [first, concurrent] = await Promise.all([
        coordinator.fork(input),
        coordinator.fork(input),
      ]);
    expect(first.state).toBe("linked");
    expect(concurrent).toEqual(first);
    expect(runtimeCalls).toBe(1);
    expect(auditCalls).toBe(1);
    if (first.state !== "linked") throw Error("The Fork was not linked.");
    const selectedTurn = source.state.turns[0];
    if (!selectedTurn) throw Error("Missing selected source turn.");
    expect(first.origin.parentTurnHash).toBe(selectedTurn.hash);
    const journal = createCodexChatForkJournal({ home: h.home, root: h.root }),
      original = journal.read(FIXTURE_PROJECT_ID, selectedRequestId);
    expect(original?.state).toBe("linked");
    if (original?.state !== "linked")
      throw Error("Missing linked Fork original.");
    const child = createSessionRegistry(h.home, "codex", "chat").read(
      FIXTURE_PROJECT_ID,
      first.childSessionId,
    );
    expect(child).toMatchObject({
      id: original?.childAppSessionId,
      requestId: selectedRequestId,
      requestHash: original?.requestHash,
      origin: first.origin,
    });
    const childStore = createConversationStore(h.home, undefined, {
        kind: "session",
        projectId: FIXTURE_PROJECT_ID,
        sessionId: child.id,
      }),
      initialChild = childStore.read(FIXTURE_PROJECT_ID);
    expect(initialChild).toMatchObject({
      binding: { provider: "codex", sessionId: childNativeThreadId, version },
      turns: [],
      frames: [],
    });
    await childStore.accept(FIXTURE_PROJECT_ID, {
      requestId: randomUUID(),
      expectedRevision: 0,
      text: "Later child-local turn",
      about: [],
    });
    const repeated = await coordinator.fork({
      projectId: FIXTURE_PROJECT_ID,
      parentSessionId: parent.id,
      request,
    });
    expect(repeated).toEqual(first);
    expect(runtimeCalls).toBe(1);
    expect(childStore.read(FIXTURE_PROJECT_ID).turns).toHaveLength(1);

    const parentStore = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: parent.id,
    });
    await parentStore.accept(FIXTURE_PROJECT_ID, {
      requestId: randomUUID(),
      expectedRevision: source.state.revision,
      text: "Later parent turn",
      about: [],
    });
    const later = parentStore.read(FIXTURE_PROJECT_ID).turns.at(-1);
    if (!later) throw Error("Missing later parent turn.");
    await parentStore.start(
      FIXTURE_PROJECT_ID,
      later.requestId,
      "fixture-owner",
    );
    const prefix = resolveCodexChatForkPrefix({
      origin: first.origin,
      parent,
      parentState: parentStore.read(FIXTURE_PROJECT_ID),
      original:
        journal.read(FIXTURE_PROJECT_ID, selectedRequestId) ??
        (() => {
          throw Error("Missing linked Fork original.");
        })(),
      child,
      childState: childStore.read(FIXTURE_PROJECT_ID),
    });
    expect(prefix.throughTurnRequestId).toBe(source.requestId);
    expect(prefix.turns.map((turn) => turn.requestId)).toEqual([
      source.requestId,
    ]);
    expect(prefix.frames).toEqual(source.state.frames);
    expect(
      await coordinator.fork({
        projectId: FIXTURE_PROJECT_ID,
        parentSessionId: parent.id,
        request,
      }),
    ).toEqual(first);
    expect(runtimeCalls).toBe(1);
  } finally {
    await h.close();
  }
});

test("audit refusal and mismatched inert Fork results do not publish a child", async () => {
  const h = await startTestHearth();
  try {
    const source = await completeSource(h),
      parent = persistCoordinatorSource(h, source),
      verifiedSource = resolveCodexChatForkSource({
        owner: parent,
        state: source.state,
        projectId: FIXTURE_PROJECT_ID,
        conversationId: parent.id,
        workspaceKey: h.workspace,
        selectedTurnRequestId: source.requestId,
      });
    if (!verifiedSource.eligible)
      throw Error("Fixture source is not Fork eligible.");
    let runtimeCalls = 0;
    const makeRuntime = (parentThreadId: string) => ({
      async fork() {
        runtimeCalls++;
        return {
          parentThreadId,
          lastTurnId: nativeTurnId,
          threadId: "0199a213-81c0-7800-8aa1-bbab2a035a62",
          forkedFromId: threadId,
          cliVersion: version,
          status: "idle" as const,
          canAcceptDirectInput: true as const,
          settings: {
            model: verifiedSource.prepared.launch.model,
            modelProvider: verifiedSource.sourceSettings.modelProvider,
            serviceTier: verifiedSource.sourceSettings.serviceTier,
            cwd: verifiedSource.prepared.canonicalCwd,
            approvalPolicy: verifiedSource.prepared.launch.approvalPolicy,
            approvalsReviewer: "user" as const,
            sandbox: verifiedSource.prepared.launch.sandbox,
            reasoningEffort: verifiedSource.sourceSettings.reasoningEffort,
          },
          runtimeWorkspaceRoots: [h.workspace],
          writableRoots: [],
        };
      },
    });
    const auditRequestId = randomUUID(),
      auditJournal = createCodexChatForkJournal({ home: h.home, root: h.root }),
      auditRefused = createCodexChatForkCoordinator({
        root: h.root,
        home: h.home,
        runtime: makeRuntime(threadId),
        async validateScope() {},
        async appendAudit() {
          throw Error("Fixture audit refusal.");
        },
      });
    await expect(
      auditRefused.fork({
        projectId: FIXTURE_PROJECT_ID,
        parentSessionId: parent.id,
        request: {
          requestId: auditRequestId,
          throughTurnRequestId: source.requestId,
        },
      }),
    ).rejects.toThrow("Fixture audit refusal");
    expect(auditJournal.read(FIXTURE_PROJECT_ID, auditRequestId)).toBeNull();
    expect(runtimeCalls).toBe(0);

    const mismatchRequestId = randomUUID(),
      mismatchJournal = createCodexChatForkJournal({
        home: h.home,
        root: h.root,
      }),
      mismatch = createCodexChatForkCoordinator({
        root: h.root,
        home: h.home,
        runtime: makeRuntime("0199a213-81c0-7800-8aa1-bbab2a035a63"),
        async validateScope() {},
        async appendAudit() {},
      });
    expect(
      await mismatch.fork({
        projectId: FIXTURE_PROJECT_ID,
        parentSessionId: parent.id,
        request: {
          requestId: mismatchRequestId,
          throughTurnRequestId: source.requestId,
        },
      }),
    ).toEqual({ state: "held", reason: "invalid-native-outcome" });
    const held = mismatchJournal.read(FIXTURE_PROJECT_ID, mismatchRequestId);
    expect(held?.state).toBe("held");
    expect(
      createSessionRegistry(h.home)
        .listAll(FIXTURE_PROJECT_ID)
        .some((record) => record.id === held?.childAppSessionId),
    ).toBe(false);
    expect(runtimeCalls).toBe(1);
  } finally {
    await h.close();
  }
});

test("Fork source resolves only the exact selected completed turn and refuses scope or contradictory evidence", async () => {
  const h = await startTestHearth();
  try {
    const source = await completeSource(h),
      resolve = (
        state: unknown,
        selectedTurnRequestId = source.requestId,
        owner = source.owner,
      ) =>
        resolveCodexChatForkSource({
          owner,
          state,
          projectId: FIXTURE_PROJECT_ID,
          conversationId: FIXTURE_CHAT_SESSION,
          workspaceKey: source.workspace,
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
        owner: source.owner,
        state: source.state,
        projectId: randomUUID(),
        conversationId: FIXTURE_CHAT_SESSION,
        workspaceKey: source.workspace,
        selectedTurnRequestId: source.requestId,
      }),
    ).toEqual({ eligible: false, reason: "scope-mismatch" });
    expect(
      resolve(source.state, source.requestId, {
        ...source.owner,
        requestHash: "a".repeat(64),
      }),
    ).toEqual({ eligible: false, reason: "owner-mismatch" });
    expect(
      resolve(source.state, source.requestId, {
        ...source.owner,
        requestId: randomUUID(),
      }),
    ).toEqual({ eligible: false, reason: "owner-mismatch" });

    const separateWorktree = join(source.workspace, "fork-checkout"),
      worktreeState = structuredClone(source.state);
    for (const frame of worktreeState.frames) {
      if (
        frame.event.kind === "user" &&
        "codexChat" in frame.event &&
        frame.event.codexChat
      ) {
        const prepared = frame.event.codexChat,
          context = prepared.launch.context;
        if (!context) throw Error("Missing prepared Chat context.");
        frame.event.codexChat = {
          ...prepared,
          cwd: separateWorktree,
          canonicalCwd: separateWorktree,
          launch: {
            ...prepared.launch,
            cwd: separateWorktree,
            context: { ...context, worktree: separateWorktree },
          },
        };
      } else if (
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "configuration"
      ) {
        frame.event.event.cwd = separateWorktree;
      }
    }
    const separateUser = worktreeState.frames.find(
      (frame) =>
        frame.turnId === source.requestId &&
        frame.event.kind === "user" &&
        "codexChat" in frame.event &&
        frame.event.codexChat,
    );
    if (
      separateUser?.event.kind !== "user" ||
      !("codexChat" in separateUser.event) ||
      !separateUser.event.codexChat
    )
      throw Error("Missing re-scoped source Chat.");
    const separateOwner = {
      ...source.owner,
      worktree: separateWorktree,
      requestHash: originalRequestHash(
        { ...source.owner, worktree: separateWorktree },
        separateUser.event.codexChat,
        separateUser.event.about,
      ),
    };
    const separateTurn = worktreeState.turns.find(
        (turn) => turn.requestId === source.requestId,
      ),
      separateUserFrame = worktreeState.frames.find(
        (frame) =>
          frame.turnId === source.requestId &&
          frame.event.kind === "user" &&
          "codexChat" in frame.event &&
          frame.event.codexChat,
      );
    if (
      !separateTurn ||
      separateUserFrame?.event.kind !== "user" ||
      !("codexChat" in separateUserFrame.event) ||
      !separateUserFrame.event.codexChat
    )
      throw Error("Missing re-scoped selected turn.");
    separateTurn.hash = conversationTurnHash({
      text: separateUserFrame.event.text,
      about: separateUserFrame.event.about,
      codexChat: separateUserFrame.event.codexChat,
    });
    expect(ownedCodingStateSchema.safeParse(worktreeState).success).toBe(true);
    expect(
      resolveCodexChatForkSource({
        owner: separateOwner,
        state: worktreeState,
        projectId: FIXTURE_PROJECT_ID,
        conversationId: FIXTURE_CHAT_SESSION,
        workspaceKey: source.workspace,
        selectedTurnRequestId: source.requestId,
      }),
    ).toMatchObject({ eligible: true, lastTurnId: nativeTurnId });
    expect(
      resolveCodexChatForkSource({
        owner: source.owner,
        state: source.state,
        projectId: FIXTURE_PROJECT_ID,
        conversationId: FIXTURE_CHAT_SESSION,
        workspaceKey: `${source.workspace}-other`,
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

    for (const phase of ["running", "unknown"] as const) {
      const otherTurn = structuredClone(withLater),
        laterTurn = otherTurn.turns[1];
      if (!laterTurn) throw Error("Missing later fixture turn.");
      laterTurn.phase = phase;
      expect(ownedCodingStateSchema.safeParse(otherTurn).success).toBe(true);
      expect(resolve(otherTurn)).toEqual({
        eligible: false,
        reason: "conversation-active",
      });
    }

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
      event: ownedCodingEventSchema.parse({
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

    const pendingOtherTurn = structuredClone(withLater),
      laterOutcomeIndex = pendingOtherTurn.frames.findIndex(
        (frame) =>
          frame.turnId === laterRequestId &&
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "outcome",
      ),
      laterLastFrame = pendingOtherTurn.frames.at(-1);
    if (laterOutcomeIndex < 0 || !laterLastFrame)
      throw Error("Missing later fixture outcome or timestamp.");
    const otherApproval = {
      seq: laterOutcomeIndex + 1,
      turnId: laterRequestId,
      at: laterLastFrame.at,
      event: ownedCodingEventSchema.parse({
        kind: "coding-chat",
        provider: "codex",
        version,
        event: {
          kind: "approval-request",
          approval: {
            id: randomUUID(),
            provider: "codex",
            processId: 2_000_000_000,
            nativeRequestId: 2,
            nativeApprovalId: null,
            threadId,
            turnId: laterNativeTurnId,
            itemId: "later-pending-command",
            kind: "command",
            command: "inert later fixture command",
            cwd: source.workspace,
            reason: null,
            availableDecisions: ["decline"],
          },
        },
      }),
    };
    pendingOtherTurn.frames.splice(laterOutcomeIndex, 0, otherApproval);
    pendingOtherTurn.frames.forEach((frame, index) => {
      frame.seq = index + 1;
    });
    pendingOtherTurn.revision = pendingOtherTurn.frames.length;
    expect(ownedCodingStateSchema.safeParse(pendingOtherTurn).success).toBe(
      true,
    );
    expect(resolve(pendingOtherTurn)).toEqual({
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
    expect(ownedCodingStateSchema.safeParse(duplicated).success).toBe(false);
    expect(resolve(duplicated)).toEqual({
      eligible: false,
      reason: "invalid-state",
    });
  } finally {
    await h.close();
  }
});
