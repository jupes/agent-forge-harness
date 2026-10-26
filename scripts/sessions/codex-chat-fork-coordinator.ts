/** Coordinates one exact, durable native Codex Fork and local child adoption. */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CodexChatForkOrigin,
  CodexChatForkOriginal,
} from "../../types/codex-chat-fork";
import type { CodexChatOwnedRecord } from "../../types/codex-owned-chat";
import type { ConversationState } from "../../types/conversation";
import { conversationLeaseFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { withQueueLock } from "../scheduler/queue-lock";
import { codexNativeUuidSchema } from "./codex-app-server-protocol";
import { createCodexChatForkJournal } from "./codex-chat-fork-journal";
import {
  codexChatForkCaptureHash,
  codexChatForkIntentSchema,
  codexChatForkOriginSchema,
  codexChatForkSourceSettingsHash,
} from "./codex-chat-fork-protocol";
import {
  type CodexChatForkSourceResult,
  resolveCodexChatForkSource,
} from "./codex-chat-fork-source";
import type { createCodexChatRuntime } from "./codex-chat-runtime";
import { ownedCodingStateSchema } from "./codex-owned-journal";
import { createSessionRegistry } from "./registry";

export interface CodexChatForkCoordinatorOptions {
  root: string;
  home: string;
  runtime: Pick<ReturnType<typeof createCodexChatRuntime>, "fork">;
  /** Rechecks the current server-derived project/worktree scope. */
  validateScope(parent: CodexChatOwnedRecord): Promise<void>;
  /** Appends metadata only; it must reject before any Fork original is reserved. */
  appendAudit(input: {
    projectId: string;
    parentSessionId: string;
    requestId: string;
    throughTurnRequestId: string;
  }): Promise<void>;
  /** A local wait only. The coordinator still acquires and revalidates under the real lease. */
  settled?(projectId: string, parentSessionId: string): Promise<void>;
  now?: () => string;
}

export type CodexChatForkCoordinatorResult =
  | { state: "linked"; childSessionId: string; origin: CodexChatForkOrigin }
  | {
      state: "held";
      reason: "unknown-native-outcome" | "invalid-native-outcome";
    };

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifiedCaptureForSource(
  raw: Awaited<ReturnType<CodexChatForkCoordinatorOptions["runtime"]["fork"]>>,
  source: Extract<CodexChatForkSourceResult, { eligible: true }>,
) {
  const capture = {
    parentNativeThreadId: raw.parentThreadId,
    childNativeThreadId: raw.threadId,
    throughNativeTurnId: raw.lastTurnId,
    protocolVersion: raw.cliVersion,
  };
  if (
    !codexNativeUuidSchema.safeParse(raw.threadId).success ||
    raw.threadId === source.parent.threadId ||
    raw.parentThreadId !== source.parent.threadId ||
    raw.forkedFromId !== source.parent.threadId ||
    raw.lastTurnId !== source.lastTurnId ||
    raw.cliVersion !== source.prepared.capabilities.version ||
    raw.status !== "idle" ||
    raw.canAcceptDirectInput !== true ||
    raw.settings.model !== source.prepared.launch.model ||
    raw.settings.modelProvider !== source.sourceSettings.modelProvider ||
    raw.settings.serviceTier !== source.sourceSettings.serviceTier ||
    workspaceKey(raw.settings.cwd) !==
      workspaceKey(source.prepared.canonicalCwd) ||
    raw.settings.approvalPolicy !== source.prepared.launch.approvalPolicy ||
    raw.settings.approvalsReviewer !== "user" ||
    raw.settings.sandbox !== source.prepared.launch.sandbox ||
    raw.settings.reasoningEffort !== source.sourceSettings.reasoningEffort ||
    !Array.isArray(raw.runtimeWorkspaceRoots) ||
    raw.runtimeWorkspaceRoots.length > 20 ||
    !Array.isArray(raw.writableRoots) ||
    raw.writableRoots.length > 20 ||
    [...raw.runtimeWorkspaceRoots, ...raw.writableRoots].some((path) => {
      try {
        const rel = relative(
          resolve(source.prepared.canonicalCwd),
          resolve(path),
        );
        return (
          !isAbsolute(path) ||
          rel === ".." ||
          rel.startsWith(`..${sep}`) ||
          isAbsolute(rel)
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      "The native Fork result did not match the exact saved source.",
    );
  return capture;
}

function originalRef(original: CodexChatForkOriginal) {
  return {
    projectId: original.projectId,
    workspaceKey: original.workspaceKey,
    requestId: original.requestId,
    requestHash: original.requestHash,
    parentSessionId: original.parentSessionId,
    throughTurnRequestId: original.throughTurnRequestId,
    protocolVersion: original.protocolVersion,
    childAppSessionId: original.childAppSessionId,
    ...(original.sourceSeal === undefined
      ? {}
      : { sourceSeal: original.sourceSeal }),
  };
}

function sourceSealFor(
  parent: CodexChatOwnedRecord,
  selectedTurnHash: string,
  source: Extract<CodexChatForkSourceResult, { eligible: true }>,
) {
  return {
    parentRequestHash: parent.requestHash,
    parentTurnHash: selectedTurnHash,
    parentNativeThreadId: source.parent.threadId,
    throughNativeTurnId: source.lastTurnId,
    sourceSettingsHash: codexChatForkSourceSettingsHash(source.sourceSettings),
  };
}

function sourceFor(input: {
  parent: CodexChatOwnedRecord;
  state: ConversationState;
  projectId: string;
  selectedTurnRequestId: string;
  workspace: string;
  admission: boolean;
}): CodexChatForkSourceResult {
  let state = input.state;
  if (!input.admission) {
    // Local recovery/prefix reads validate only the saved historical boundary.
    // Later parent activity is outside that immutable prefix and is not admission authority.
    const index = state.turns.findIndex(
      (turn) => turn.requestId === input.selectedTurnRequestId,
    );
    if (index < 0) return { eligible: false, reason: "turn-not-completed" };
    const last = state.turns[index];
    if (!last) return { eligible: false, reason: "turn-not-completed" };
    const selectedFrames = state.frames.filter(
        (frame) => frame.turnId === last.requestId,
      ),
      boundary = selectedFrames.at(-1)?.seq ?? 0;
    state = {
      ...state,
      turns: state.turns.slice(0, index + 1),
      frames: state.frames.filter((frame) => frame.seq <= boundary),
    };
  }
  return resolveCodexChatForkSource({
    owner: input.parent,
    state,
    projectId: input.projectId,
    conversationId: input.parent.id,
    workspaceKey: input.workspace,
    selectedTurnRequestId: input.selectedTurnRequestId,
  });
}

function originFor(
  original: CodexChatForkOriginal,
  parentTurnHash: string,
): CodexChatForkOrigin {
  if (original.state !== "captured" && original.state !== "linked")
    throw new Error("The native Fork has no durable capture.");
  return codexChatForkOriginSchema.parse({
    kind: "codex-chat-fork",
    projectId: original.projectId,
    parentSessionId: original.parentSessionId,
    throughTurnRequestId: original.throughTurnRequestId,
    parentTurnHash,
    parentNativeThreadId: original.capture.parentNativeThreadId,
    throughNativeTurnId: original.capture.throughNativeTurnId,
    childNativeThreadId: original.capture.childNativeThreadId,
    captureHash: codexChatForkCaptureHash(original.capture),
    protocolVersion: original.protocolVersion,
  });
}

/** The first Fork slice owns source admission, one-shot dispatch and child discoverability. */
export function createCodexChatForkCoordinator(
  options: CodexChatForkCoordinatorOptions,
) {
  const workspace = workspaceKey(resolveCheckout(options.root).workspace),
    registry = createSessionRegistry(options.home, "codex", "chat"),
    journal = createCodexChatForkJournal({
      home: options.home,
      root: options.root,
      ...(options.now ? { now: options.now } : {}),
    }),
    storeFor = (sessionId: string, projectId: string) =>
      createConversationStore(options.home, undefined, {
        kind: "session",
        projectId,
        sessionId,
      });

  const linkedResult = (
    original: CodexChatForkOriginal,
  ): CodexChatForkCoordinatorResult => {
    if (original.state !== "linked")
      throw new Error("Expected a linked Fork original.");
    const parent = registry.read(original.projectId, original.parentSessionId);
    if (parent.provider !== "codex" || parent.mode !== "chat")
      throw new Error("The Fork parent is not an owned Codex Chat.");
    if (
      parent.origin !== undefined ||
      workspaceKey(parent.workspace) !== original.workspaceKey
    )
      throw new Error(
        "The saved Fork parent scope does not match its original.",
      );
    const parentState = storeFor(parent.id, parent.projectId).read(
        parent.projectId,
      ),
      selected = parentState.turns.filter(
        (turn) => turn.requestId === original.throughTurnRequestId,
      );
    if (selected.length !== 1 || !selected[0])
      throw new Error("The saved Fork source turn is missing or ambiguous.");
    const origin = originFor(original, selected[0].hash),
      child = registry.read(original.projectId, original.childAppSessionId);
    const source = sourceFor({
      parent,
      state: parentState,
      projectId: parent.projectId,
      selectedTurnRequestId: original.throughTurnRequestId,
      workspace: original.workspaceKey,
      admission: false,
    });
    if (
      !source.eligible ||
      source.parent.threadId !== origin.parentNativeThreadId ||
      source.lastTurnId !== origin.throughNativeTurnId ||
      !original.sourceSeal ||
      !same(
        original.sourceSeal,
        sourceSealFor(parent, selected[0].hash, source),
      )
    )
      throw new Error(
        "The linked Fork no longer matches its exact saved parent source.",
      );
    if (
      child.provider !== "codex" ||
      child.mode !== "chat" ||
      child.workspace !== parent.workspace ||
      child.repository !== parent.repository ||
      child.worktree !== parent.worktree ||
      child.beadId !== parent.beadId ||
      child.smith !== parent.smith ||
      child.requestedModel !== parent.requestedModel ||
      child.requestedEffort !== parent.requestedEffort ||
      !same(child.origin, origin) ||
      child.requestId !== original.requestId ||
      child.requestHash !== original.requestHash ||
      child.createdAt !== original.createdAt ||
      original.link.childAppSessionId !== child.id ||
      original.link.childRequestId !== child.requestId ||
      original.link.childRequestHash !== child.requestHash ||
      original.link.captureHash !== origin.captureHash
    )
      throw new Error(
        "The linked Fork child registry proof does not match its original.",
      );
    const childState = storeFor(child.id, child.projectId).read(
      child.projectId,
    );
    if (
      childState.binding?.provider !== "codex" ||
      childState.binding.sessionId !== origin.childNativeThreadId ||
      childState.binding.version !== origin.protocolVersion
    )
      throw new Error(
        "The linked Fork child binding does not match its native capture.",
      );
    return { state: "linked", childSessionId: child.id, origin };
  };

  return {
    async fork(raw: {
      projectId: string;
      parentSessionId: string;
      request: unknown;
    }): Promise<CodexChatForkCoordinatorResult> {
      const intent = codexChatForkIntentSchema.safeParse(raw.request);
      if (!intent.success)
        throw new Error("Expected a bounded Codex Fork request.");
      const prior = journal.read(raw.projectId, intent.data.requestId);
      if (!prior || (prior.state !== "captured" && prior.state !== "linked"))
        await options.settled?.(raw.projectId, raw.parentSessionId);
      const lease = conversationLeaseFile(options.home, raw.projectId, {
        kind: "session",
        projectId: raw.projectId,
        sessionId: raw.parentSessionId,
      });
      const result = await withQueueLock(
        lease,
        async () => {
          let parent = registry.read(raw.projectId, raw.parentSessionId);
          if (
            parent.provider !== "codex" ||
            parent.mode !== "chat" ||
            parent.origin !== undefined
          )
            throw new Error(
              "The selected parent is not an ordinary owned Codex Chat source.",
            );
          if (workspaceKey(parent.workspace) !== workspace)
            throw new Error("The Codex Chat belongs to another workspace.");
          await options.validateScope(parent);
          const state = storeFor(parent.id, parent.projectId).read(
              parent.projectId,
            ),
            existing = journal.read(raw.projectId, intent.data.requestId);
          if (
            existing &&
            (existing.parentSessionId !== parent.id ||
              existing.throughTurnRequestId !==
                intent.data.throughTurnRequestId)
          )
            throw new Error(
              "This Fork UUID belongs to another immutable source.",
            );
          if (existing?.state === "linked") return linkedResult(existing);
          if (existing?.state === "held")
            return { state: "held", reason: existing.heldReason } as const;
          if (existing?.state === "attempted") {
            if (!existing.sourceSeal)
              return {
                state: "held",
                reason: "unknown-native-outcome",
              } as const;
            await journal.hold(originalRef(existing), "unknown-native-outcome");
            return { state: "held", reason: "unknown-native-outcome" } as const;
          }
          if (existing && !existing.sourceSeal)
            throw new Error(
              "This legacy Fork original has no source seal and cannot be dispatched or adopted.",
            );
          const admission = existing?.state !== "captured",
            source = sourceFor({
              parent,
              state,
              projectId: raw.projectId,
              selectedTurnRequestId: intent.data.throughTurnRequestId,
              workspace,
              admission,
            });
          if (!source.eligible)
            throw new Error(
              `The selected Codex source is not Fork eligible (${source.reason}).`,
            );
          const selected = state.turns.find(
            (turn) => turn.requestId === intent.data.throughTurnRequestId,
          );
          if (!selected)
            throw new Error("The selected source turn disappeared.");
          const sourceSeal = sourceSealFor(parent, selected.hash, source);
          if (existing?.sourceSeal && !same(existing.sourceSeal, sourceSeal))
            throw new Error(
              "The saved Fork source changed after its original was reserved.",
            );
          if (!existing || existing.state === "reserved") {
            await options.validateScope(parent);
            await options.appendAudit({
              projectId: raw.projectId,
              parentSessionId: parent.id,
              requestId: intent.data.requestId,
              throughTurnRequestId: intent.data.throughTurnRequestId,
            });
          }
          let original: CodexChatForkOriginal =
            existing ??
            (await journal.reserve(
              raw.projectId,
              parent.id,
              intent.data,
              sourceSeal,
            ));
          if (original.state === "reserved") {
            const attempt = await journal.markAttempted(originalRef(original));
            original = attempt.record;
            if (!attempt.mayDispatch)
              return {
                state: "held",
                reason: "unknown-native-outcome",
              } as const;
            let captured: Awaited<ReturnType<typeof options.runtime.fork>>;
            try {
              await options.validateScope(parent);
              captured = await options.runtime.fork({
                prepared: source.prepared,
                parent: source.parent,
                lastTurnId: source.lastTurnId,
                sourceSettings: source.sourceSettings,
              });
            } catch {
              await journal.hold(
                originalRef(original),
                "unknown-native-outcome",
              );
              return {
                state: "held",
                reason: "unknown-native-outcome",
              } as const;
            }
            let verifiedCapture: ReturnType<typeof verifiedCaptureForSource>;
            try {
              verifiedCapture = verifiedCaptureForSource(captured, source);
            } catch {
              await journal.hold(
                originalRef(original),
                "invalid-native-outcome",
              );
              return {
                state: "held",
                reason: "invalid-native-outcome",
              } as const;
            }
            try {
              original = await journal.capture(
                originalRef(original),
                verifiedCapture,
              );
              if (original.state !== "captured" && original.state !== "linked")
                return {
                  state: "held",
                  reason: "invalid-native-outcome",
                } as const;
            } catch {
              const recovered = journal.read(
                raw.projectId,
                intent.data.requestId,
              );
              if (
                recovered?.state === "captured" ||
                recovered?.state === "linked"
              )
                original = recovered;
              else if (recovered?.state === "attempted") {
                await journal.hold(
                  originalRef(recovered),
                  "unknown-native-outcome",
                );
                return {
                  state: "held",
                  reason: "unknown-native-outcome",
                } as const;
              } else
                throw new Error(
                  "The captured Fork result could not be verified.",
                );
            }
          }
          if (original.state !== "captured" && original.state !== "linked")
            return { state: "held", reason: "unknown-native-outcome" } as const;
          const rereadParent = registry.read(
            raw.projectId,
            raw.parentSessionId,
          );
          if (
            rereadParent.provider !== "codex" ||
            rereadParent.mode !== "chat" ||
            rereadParent.origin !== undefined
          )
            throw new Error(
              "The parent owner changed before child registration.",
            );
          parent = rereadParent;
          const origin = originFor(original, selected.hash),
            child: CodexChatOwnedRecord = {
              provider: "codex",
              mode: "chat",
              workspace: parent.workspace,
              repository: parent.repository,
              worktree: parent.worktree,
              ...(parent.beadId === undefined ? {} : { beadId: parent.beadId }),
              smith: parent.smith,
              requestedModel: parent.requestedModel,
              requestedEffort: parent.requestedEffort,
              origin,
              projectId: original.projectId,
              id: original.childAppSessionId,
              requestId: original.requestId,
              requestHash: original.requestHash,
              createdAt: original.createdAt,
            };
          const childStore = storeFor(child.id, child.projectId);
          const adopted = await registry.adoptForkChild(
            child,
            parent,
            original,
            async () => {
              const childState = await childStore.bootstrapCodexForkChild(
                child.projectId,
                origin.childNativeThreadId,
                origin.protocolVersion,
              );
              if (
                childState.binding?.provider !== "codex" ||
                childState.binding.sessionId !== origin.childNativeThreadId
              )
                throw new Error(
                  "The Fork child bootstrap did not preserve its captured binding.",
                );
            },
          );
          const childState = childStore.read(child.projectId);
          if (
            childState.binding?.provider !== "codex" ||
            childState.binding.sessionId !== origin.childNativeThreadId ||
            childState.binding.version !== origin.protocolVersion
          )
            throw new Error(
              "The adopted Fork child binding does not match its capture.",
            );
          const linked = await journal.markLinked(originalRef(original), {
            childAppSessionId: adopted.id,
            childRequestId: adopted.requestId,
            childRequestHash: adopted.requestHash,
            captureHash: origin.captureHash,
          });
          if (linked.state !== "linked")
            throw new Error("The Fork child link was not durably confirmed.");
          return linkedResult(linked);
        },
        { waitMs: 1000 },
      );
      if (!result.ok)
        throw new Error(
          "The parent conversation is busy; no Fork was accepted.",
        );
      return result.value;
    },
  };
}

/** Resolve a bounded read-only parent prefix; it never changes child history or admission state. */
export function resolveCodexChatForkPrefix(input: {
  origin: CodexChatForkOrigin;
  parent: CodexChatOwnedRecord;
  parentState: ConversationState;
  original: CodexChatForkOriginal;
  child: CodexChatOwnedRecord;
  childState: ConversationState;
}) {
  const origin = codexChatForkOriginSchema.parse(input.origin),
    original = input.original;
  if (
    original.state !== "linked" ||
    input.parent.provider !== "codex" ||
    input.parent.mode !== "chat" ||
    input.parent.origin !== undefined ||
    input.parent.id !== origin.parentSessionId ||
    input.parent.projectId !== origin.projectId ||
    workspaceKey(input.parent.workspace) !==
      workspaceKey(input.child.workspace) ||
    input.child.provider !== "codex" ||
    input.child.mode !== "chat" ||
    input.child.workspace !== input.parent.workspace ||
    input.child.repository !== input.parent.repository ||
    input.child.worktree !== input.parent.worktree ||
    input.child.beadId !== input.parent.beadId ||
    input.child.smith !== input.parent.smith ||
    input.child.requestedModel !== input.parent.requestedModel ||
    input.child.requestedEffort !== input.parent.requestedEffort ||
    input.child.projectId !== origin.projectId ||
    input.child.id !== original.childAppSessionId ||
    input.child.createdAt !== original.createdAt ||
    input.child.origin?.kind !== "codex-chat-fork" ||
    !same(input.child.origin, origin) ||
    original.projectId !== origin.projectId ||
    original.parentSessionId !== origin.parentSessionId ||
    original.protocolVersion !== origin.protocolVersion ||
    original.sourceSeal === undefined ||
    original.workspaceKey !== workspaceKey(input.parent.workspace) ||
    original.throughTurnRequestId !== origin.throughTurnRequestId ||
    original.state !== "linked" ||
    original.link.captureHash !== origin.captureHash ||
    original.link.childAppSessionId !== input.child.id ||
    input.child.requestId !== original.requestId ||
    input.child.requestHash !== original.requestHash ||
    original.link.childRequestId !== input.child.requestId ||
    original.link.childRequestHash !== input.child.requestHash ||
    original.capture.parentNativeThreadId !== origin.parentNativeThreadId ||
    original.capture.childNativeThreadId !== origin.childNativeThreadId ||
    original.capture.throughNativeTurnId !== origin.throughNativeTurnId ||
    codexChatForkCaptureHash(original.capture) !== origin.captureHash ||
    input.childState.projectId !== input.child.projectId ||
    input.childState.conversationId !== input.child.id ||
    input.childState.binding?.provider !== "codex" ||
    input.childState.binding.sessionId !== origin.childNativeThreadId ||
    input.childState.binding.version !== origin.protocolVersion
  )
    throw new Error("The saved Fork prefix linkage is invalid or conflicting.");
  const source = sourceFor({
    parent: input.parent,
    state: ownedCodingStateSchema.parse(input.parentState),
    projectId: origin.projectId,
    selectedTurnRequestId: origin.throughTurnRequestId,
    workspace: workspaceKey(input.parent.workspace),
    admission: false,
  });
  ownedCodingStateSchema.parse(input.childState);
  if (
    !source.eligible ||
    source.parent.threadId !== origin.parentNativeThreadId ||
    source.lastTurnId !== origin.throughNativeTurnId
  )
    throw new Error(
      "The saved Fork parent boundary no longer matches its origin.",
    );
  const selected = input.parentState.turns.find(
    (turn) => turn.requestId === origin.throughTurnRequestId,
  );
  if (!selected || selected.hash !== origin.parentTurnHash)
    throw new Error(
      "The saved Fork parent turn hash does not match its origin.",
    );
  if (
    !same(
      original.sourceSeal,
      sourceSealFor(input.parent, selected.hash, source),
    )
  )
    throw new Error("The saved Fork source seal no longer matches its origin.");
  const boundary =
    input.parentState.frames
      .filter((frame) => frame.turnId === origin.throughTurnRequestId)
      .at(-1)?.seq ?? 0;
  return {
    throughTurnRequestId: origin.throughTurnRequestId,
    parentTurnHash: origin.parentTurnHash,
    turns: input.parentState.turns.slice(
      0,
      input.parentState.turns.findIndex(
        (turn) => turn.requestId === origin.throughTurnRequestId,
      ) + 1,
    ),
    frames: input.parentState.frames.filter((frame) => frame.seq <= boundary),
  };
}
