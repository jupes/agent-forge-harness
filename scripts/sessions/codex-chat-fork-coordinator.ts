/** Coordinates one exact, durable native Codex Fork and local child adoption. */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CodexChatLaunch } from "../../types/codex-chat";
import type {
  CodexChatForkOrigin,
  CodexChatForkOriginal,
} from "../../types/codex-chat-fork";
import type { CodexChatOwnedRecord } from "../../types/codex-owned-chat";
import type {
  ConversationObject,
  ConversationState,
} from "../../types/conversation";
import type { ClaudeSessionLaunch } from "../../types/session-launch";
import { ConversationError } from "../conversations/error";
import { conversationLeaseFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  codexNativeUuidSchema,
  preparedCodexChatSchema,
} from "./codex-app-server-protocol";
import { createCodexChatForkJournal } from "./codex-chat-fork-journal";
import {
  CODEX_CHAT_FORK_PROTOCOL_VERSION,
  codexChatForkCaptureHash,
  codexChatForkIntentSchema,
  codexChatForkOriginalHash,
  codexChatForkOriginalHashInput,
  codexChatForkOriginSchema,
  codexChatForkSourceSettingsHash,
} from "./codex-chat-fork-protocol";
import {
  assertForkReviewEnvelopeBound,
  CODEX_CHAT_FORK_REVIEW_LIMITS,
  type CodexChatForkContextPage,
  type CodexChatForkSourcePage,
  codexChatForkContextPageSchema,
  codexChatForkSourcePageSchema,
} from "./codex-chat-fork-review-protocol";
import {
  type CodexChatForkSourceResult,
  resolveCodexChatForkSource,
} from "./codex-chat-fork-source";
import type { createCodexChatRuntime } from "./codex-chat-runtime";
import { ownedCodingStateSchema } from "./codex-owned-journal";
import { canonicalSessionInput } from "./preparation";
import { createSessionRegistry } from "./registry";

export interface CodexChatForkCoordinatorOptions {
  root: string;
  home: string;
  runtime: Pick<ReturnType<typeof createCodexChatRuntime>, "fork"> &
    Partial<Pick<ReturnType<typeof createCodexChatRuntime>, "prepare">>;
  /** Rechecks the current server-derived project/worktree scope. */
  validateScope(
    parent: CodexChatOwnedRecord,
    about?: ConversationObject[],
    launch?: ClaudeSessionLaunch,
  ): Promise<void>;
  /** A local wait only. The coordinator still acquires and revalidates under the real lease. */
  settled?(projectId: string, parentSessionId: string): Promise<void>;
  now?: () => string;
}

export type CodexChatForkCoordinatorResult =
  | { state: "linked"; childSessionId: string; origin: CodexChatForkOrigin }
  | {
      state: "held";
      reason: "unknown-native-outcome" | "invalid-native-outcome";
    }
  | { state: "retired" };

/** A known immutable UUID/source collision, distinct from uncertain failures. */
export class CodexChatForkOriginalConflict extends Error {
  constructor() {
    super("This Fork UUID belongs to another immutable source.");
    this.name = "CodexChatForkOriginalConflict";
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedRequestHash(input: {
  projectId: string;
  workspace: string;
  parentSessionId: string;
  request: { requestId: string; throughTurnRequestId: string };
}) {
  return codexChatForkOriginalHash(
    codexChatForkOriginalHashInput({
      projectId: input.projectId,
      workspaceKey: input.workspace,
      parentSessionId: input.parentSessionId,
      throughTurnRequestId: input.request.throughTurnRequestId,
      requestId: input.request.requestId,
      protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
    }),
  );
}

function exactOriginal(
  original: CodexChatForkOriginal | null,
  input: {
    projectId: string;
    workspace: string;
    parentSessionId: string;
    request: { requestId: string; throughTurnRequestId: string };
  },
): original is CodexChatForkOriginal {
  return Boolean(
    original &&
      original.projectId === input.projectId &&
      original.workspaceKey === input.workspace &&
      original.parentSessionId === input.parentSessionId &&
      original.throughTurnRequestId === input.request.throughTurnRequestId &&
      original.requestHash === expectedRequestHash(input),
  );
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
    ...(original.reservationKind === undefined
      ? {}
      : { reservationKind: original.reservationKind }),
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
    const turns = state.turns.slice(0, index + 1),
      includedTurnIds = new Set(turns.map((turn) => turn.requestId));
    const selectedFrames = state.frames.filter(
        (frame) => frame.turnId === last.requestId,
      ),
      boundary = selectedFrames.at(-1)?.seq ?? 0;
    state = {
      ...state,
      turns,
      frames: state.frames.filter((frame) => frame.seq <= boundary),
      ...(state.codexChatOwnerLifecycle
        ? {
            codexChatOwnerLifecycle: state.codexChatOwnerLifecycle.filter(
              (fact) => includedTurnIds.has(fact.requestId),
            ),
          }
        : {}),
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

  const sourcePage = (input: {
    projectId: string;
    parent: CodexChatOwnedRecord;
    state: ConversationState;
    source: Extract<CodexChatForkSourceResult, { eligible: true }>;
    requestId: string | null;
    after: number;
    limit: number;
  }): CodexChatForkSourcePage => {
    const selectedIndex = input.state.turns.findIndex(
        (turn) => turn.requestId === input.source.selectedTurnRequestId,
      ),
      selectedTurn = input.state.turns[selectedIndex];
    if (!selectedTurn || selectedIndex < 0)
      throw new ConversationError(
        409,
        "The exact completed Fork source turn is unavailable.",
      );
    const boundary =
        input.state.frames
          .filter((frame) => frame.turnId === selectedTurn.requestId)
          .at(-1)?.seq ?? 0,
      prefixFrames = input.state.frames.filter(
        (frame) => frame.seq <= boundary,
      ),
      cursorValid =
        input.after === 0 ||
        prefixFrames.some(
          (frame) =>
            frame.seq === input.after &&
            (frame.event.kind === "user" || frame.event.kind === "text"),
        );
    if (!cursorValid || input.after > boundary)
      throw new ConversationError(
        400,
        "The Fork source review cursor is invalid for this boundary.",
      );
    const projected: CodexChatForkSourcePage["frames"] = [];
    for (const frame of prefixFrames) {
      if (frame.seq <= input.after) continue;
      if (frame.event.kind === "user")
        projected.push({
          kind: "user",
          seq: frame.seq,
          turnId: frame.turnId,
          at: frame.at,
          text: frame.event.text,
          about: [...frame.event.about],
        });
      else if (frame.event.kind === "text")
        projected.push({
          kind: "text",
          seq: frame.seq,
          turnId: frame.turnId,
          at: frame.at,
          text: frame.event.text,
        });
    }
    if (
      prefixFrames.length >
        CODEX_CHAT_FORK_REVIEW_LIMITS.pageItems *
          CODEX_CHAT_FORK_REVIEW_LIMITS.pages ||
      prefixFrames.some(
        (frame) =>
          (frame.event.kind === "user" || frame.event.kind === "text") &&
          new TextEncoder().encode(frame.event.text).byteLength >
            CODEX_CHAT_FORK_REVIEW_LIMITS.textBytes,
      )
    )
      throw new ConversationError(
        413,
        "The exact Fork source exceeds the safe review limits.",
      );
    const frames = projected.slice(0, input.limit),
      hasMore = projected.length > frames.length,
      page: CodexChatForkSourcePage = {
        version: 1,
        projectId: input.projectId,
        parentSessionId: input.parent.id,
        requestId: input.requestId,
        throughTurnRequestId: selectedTurn.requestId,
        selectedTurnHash: selectedTurn.hash,
        target: {
          smith: input.parent.smith,
          repository: input.parent.repository,
          worktree: input.parent.worktree,
          beadId: input.parent.beadId ?? null,
        },
        settings: {
          model: input.source.prepared.launch.model,
          provider: input.source.sourceSettings.modelProvider,
          serviceTier: {
            present: true,
            value: input.source.sourceSettings.serviceTier,
          },
          effort: input.source.sourceSettings.reasoningEffort,
          approvalPolicy: input.source.prepared.launch.approvalPolicy,
          sandbox: {
            mode: input.source.prepared.launch.sandbox,
            networkAccess: "not-reported",
          },
        },
        provenance: {
          turn: "saved-completed-parent-turn",
          configuration: "captured-native-configuration",
        },
        frames,
        nextCursor: hasMore ? (frames.at(-1)?.seq ?? input.after) : null,
        complete: !hasMore,
      };
    const parsed = codexChatForkSourcePageSchema.parse(page);
    try {
      assertForkReviewEnvelopeBound({ ok: true, data: parsed, error: null });
    } catch {
      throw new ConversationError(
        413,
        "The Fork source review exceeds the safe response limit.",
      );
    }
    return parsed;
  };

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
    async reservePreflight(raw: {
      projectId: string;
      parentSessionId: string;
      request: unknown;
      auditEventId: number;
    }): Promise<CodexChatForkOriginal> {
      if (!Number.isSafeInteger(raw.auditEventId) || raw.auditEventId <= 0)
        throw new Error("A confirmed operator audit receipt is required.");
      const parsed = codexChatForkIntentSchema.safeParse(raw.request);
      if (!parsed.success) throw new CodexChatForkOriginalConflict();
      const intent = parsed.data,
        scope = {
          projectId: raw.projectId,
          workspace,
          parentSessionId: raw.parentSessionId,
          request: intent,
        },
        previous = journal.read(raw.projectId, intent.requestId);
      if (previous) {
        if (!exactOriginal(previous, scope))
          throw new CodexChatForkOriginalConflict();
        return previous;
      }
      await options.settled?.(raw.projectId, raw.parentSessionId);
      const lease = conversationLeaseFile(options.home, raw.projectId, {
        kind: "session",
        projectId: raw.projectId,
        sessionId: raw.parentSessionId,
      });
      const result = await withQueueLock(
        lease,
        async () => {
          const existing = journal.read(raw.projectId, intent.requestId);
          if (existing) {
            if (!exactOriginal(existing, scope))
              throw new CodexChatForkOriginalConflict();
            return existing;
          }
          const parent = registry.read(raw.projectId, raw.parentSessionId);
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
            source = sourceFor({
              parent,
              state,
              projectId: raw.projectId,
              selectedTurnRequestId: intent.throughTurnRequestId,
              workspace,
              admission: true,
            });
          if (!source.eligible)
            throw new Error(
              `The selected Codex source is not Fork eligible (${source.reason}).`,
            );
          const selected = state.turns.find(
            (turn) => turn.requestId === intent.throughTurnRequestId,
          );
          if (!selected)
            throw new Error("The selected source turn disappeared.");
          const sourceSeal = sourceSealFor(parent, selected.hash, source),
            sourceAbout = [...(source.prepared.launch.context?.about ?? [])];
          await options.validateScope(parent, sourceAbout);
          return journal.reserve(
            raw.projectId,
            parent.id,
            intent,
            sourceSeal,
            "preflight-v1",
          );
        },
        { waitMs: 1000 },
      );
      if (!result.ok)
        throw new Error(
          "The parent conversation is busy; no Fork reservation was accepted.",
        );
      return result.value;
    },
    async retirePreflight(raw: {
      projectId: string;
      parentSessionId: string;
      requestId: string;
      requestHash: string;
      auditEventId: number;
    }): Promise<CodexChatForkOriginal> {
      if (!Number.isSafeInteger(raw.auditEventId) || raw.auditEventId <= 0)
        throw new Error("A confirmed operator audit receipt is required.");
      const existing = journal.read(raw.projectId, raw.requestId);
      if (!existing) throw new CodexChatForkOriginalConflict();
      if (
        existing.workspaceKey !== workspace ||
        existing.parentSessionId !== raw.parentSessionId ||
        existing.requestHash !== raw.requestHash ||
        existing.reservationKind !== "preflight-v1" ||
        !exactOriginal(existing, {
          projectId: raw.projectId,
          workspace,
          parentSessionId: raw.parentSessionId,
          request: {
            requestId: raw.requestId,
            throughTurnRequestId: existing.throughTurnRequestId,
          },
        })
      )
        throw new CodexChatForkOriginalConflict();
      return journal.retirePreflight(originalRef(existing));
    },
    async fork(raw: {
      projectId: string;
      parentSessionId: string;
      request: unknown;
      /** Trusted receipt from the common operator action runner, never request data. */
      auditEventId: number;
    }): Promise<CodexChatForkCoordinatorResult> {
      if (!Number.isSafeInteger(raw.auditEventId) || raw.auditEventId <= 0)
        throw new Error("A confirmed operator audit receipt is required.");
      const intent = codexChatForkIntentSchema.safeParse(raw.request);
      if (!intent.success)
        throw new Error("Expected a bounded Codex Fork request.");
      const requestScope = {
          projectId: raw.projectId,
          workspace,
          parentSessionId: raw.parentSessionId,
          request: intent.data,
        },
        prior = journal.read(raw.projectId, intent.data.requestId);
      if (prior && !exactOriginal(prior, requestScope))
        throw new CodexChatForkOriginalConflict();
      if (prior?.state === "retired") return { state: "retired" };
      if (prior?.state === "reserved" && prior.reservationKind === undefined)
        return { state: "held", reason: "unknown-native-outcome" };
      if (
        !prior ||
        (prior.state !== "captured" &&
          prior.state !== "linked" &&
          prior.reservationKind !== "preflight-v1")
      )
        await options.settled?.(raw.projectId, raw.parentSessionId);
      const lease = conversationLeaseFile(options.home, raw.projectId, {
        kind: "session",
        projectId: raw.projectId,
        sessionId: raw.parentSessionId,
      });
      const result = await withQueueLock(
        lease,
        async () => {
          const existing = journal.read(raw.projectId, intent.data.requestId);
          if (existing && !exactOriginal(existing, requestScope))
            throw new CodexChatForkOriginalConflict();
          if (existing?.state === "retired")
            return { state: "retired" } as const;
          if (
            existing?.state === "reserved" &&
            existing.reservationKind === undefined
          )
            return {
              state: "held",
              reason: "unknown-native-outcome",
            } as const;
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
          const sourceAbout = [
            ...(source.prepared.launch.context?.about ?? []),
          ];
          await options.validateScope(parent, sourceAbout);
          let original: CodexChatForkOriginal =
            existing ??
            (await journal.reserve(
              raw.projectId,
              parent.id,
              intent.data,
              sourceSeal,
              "direct-v1",
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
              await options.validateScope(parent, sourceAbout);
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
      if (!result.ok) {
        const afterBusy = journal.read(raw.projectId, intent.data.requestId);
        if (
          exactOriginal(afterBusy, requestScope) &&
          afterBusy.state === "retired"
        )
          return { state: "retired" };
        throw new Error(
          "The parent conversation is busy; no Fork was accepted.",
        );
      }
      return result.value;
    },
    readOriginal(projectId: string, requestId: string) {
      return journal.read(projectId, requestId);
    },
    async readSourceReview(input: {
      projectId: string;
      parentSessionId: string;
      throughTurnRequestId: string;
      after: number;
      limit: number;
    }) {
      const parent = registry.read(input.projectId, input.parentSessionId);
      if (
        parent.provider !== "codex" ||
        parent.mode !== "chat" ||
        parent.origin !== undefined ||
        parent.projectId !== input.projectId ||
        workspaceKey(parent.workspace) !== workspace
      )
        throw new ConversationError(
          409,
          "Fork source review requires a trusted root Codex Chat session.",
        );
      const state = storeFor(parent.id, parent.projectId).read(
          parent.projectId,
        ),
        source = sourceFor({
          parent,
          state,
          projectId: input.projectId,
          selectedTurnRequestId: input.throughTurnRequestId,
          workspace,
          admission: false,
        });
      if (!source.eligible)
        throw new ConversationError(
          409,
          "The exact completed Fork source is unavailable for review.",
        );
      await options.validateScope(parent, [
        ...(source.prepared.launch.context?.about ?? []),
      ]);
      return sourcePage({
        projectId: input.projectId,
        parent,
        state,
        source,
        requestId: null,
        after: input.after,
        limit: input.limit,
      });
    },
    async readOriginalContext(input: {
      projectId: string;
      requestId: string;
      after: number;
      limit: number;
    }): Promise<CodexChatForkContextPage> {
      const original = journal.read(input.projectId, input.requestId);
      if (!original)
        throw new ConversationError(
          404,
          "The exact Codex Fork original is not present in this trusted workspace.",
        );
      const unavailable = (
        reason: "source-unavailable" | "source-mismatch",
      ): CodexChatForkContextPage => ({
        version: 1,
        available: false,
        requestId: original.requestId,
        requestHash: original.requestHash,
        parentSessionId: original.parentSessionId,
        throughTurnRequestId: original.throughTurnRequestId,
        state: original.state,
        reason,
        source: null,
      });
      if (
        (original.state !== "reserved" && original.state !== "linked") ||
        original.reservationKind === undefined ||
        original.sourceSeal === undefined ||
        original.projectId !== input.projectId
      )
        return unavailable("source-unavailable");

      let parent: CodexChatOwnedRecord, state: ConversationState;
      try {
        parent = registry.read(input.projectId, original.parentSessionId);
        if (
          parent.provider !== "codex" ||
          parent.mode !== "chat" ||
          parent.origin !== undefined ||
          parent.projectId !== original.projectId ||
          workspaceKey(parent.workspace) !== original.workspaceKey ||
          original.workspaceKey !== workspace
        )
          return unavailable("source-unavailable");
        state = storeFor(parent.id, parent.projectId).read(parent.projectId);
      } catch {
        return unavailable("source-unavailable");
      }
      const source = sourceFor({
        parent,
        state,
        projectId: original.projectId,
        selectedTurnRequestId: original.throughTurnRequestId,
        workspace,
        admission: false,
      });
      const selected = state.turns.find(
        (turn) => turn.requestId === original.throughTurnRequestId,
      );
      if (!source.eligible || !selected)
        return unavailable("source-unavailable");
      if (
        !same(original.sourceSeal, sourceSealFor(parent, selected.hash, source))
      )
        return unavailable("source-mismatch");
      try {
        await options.validateScope(parent, [
          ...(source.prepared.launch.context?.about ?? []),
        ]);
      } catch {
        return unavailable("source-unavailable");
      }

      if (original.state === "linked") {
        try {
          const linked = linkedResult(original);
          if (linked.state !== "linked") return unavailable("source-mismatch");
          const child = registry.read(
              original.projectId,
              original.childAppSessionId,
            ),
            childState = storeFor(child.id, child.projectId).read(
              child.projectId,
            );
          resolveCodexChatForkPrefix({
            origin: linked.origin,
            parent,
            parentState: state,
            original,
            child,
            childState,
          });
        } catch {
          return unavailable("source-unavailable");
        }
      }
      const page = sourcePage({
        projectId: input.projectId,
        parent,
        state,
        source,
        requestId: original.requestId,
        after: input.after,
        limit: input.limit,
      });
      const context: CodexChatForkContextPage = {
        version: 1,
        available: true,
        requestId: original.requestId,
        requestHash: original.requestHash,
        parentSessionId: original.parentSessionId,
        throughTurnRequestId: original.throughTurnRequestId,
        state: original.state,
        reason: null,
        source: page,
      };
      const parsed = codexChatForkContextPageSchema.parse(context);
      try {
        assertForkReviewEnvelopeBound({ ok: true, data: parsed, error: null });
      } catch {
        throw new ConversationError(
          413,
          "The Fork source context exceeds the safe response limit.",
        );
      }
      return parsed;
    },
    /** Verify the saved link and captured child binding without consulting mutable parent history. */
    readLinkedChild(projectId: string, childSessionId: string) {
      const child = registry.read(projectId, childSessionId);
      if (
        child.provider !== "codex" ||
        child.mode !== "chat" ||
        child.projectId !== projectId ||
        child.origin?.kind !== "codex-chat-fork" ||
        workspaceKey(child.workspace) !== workspace
      )
        throw new ConversationError(
          409,
          "Only a registered Codex Fork child has this read-only transcript.",
        );
      const original = journal.read(projectId, child.requestId);
      if (
        !original ||
        original.state !== "linked" ||
        original.requestId !== child.requestId ||
        original.requestHash !== child.requestHash ||
        original.childAppSessionId !== child.id ||
        !original.sourceSeal ||
        original.link.childAppSessionId !== child.id ||
        original.link.childRequestId !== child.requestId ||
        original.link.childRequestHash !== child.requestHash ||
        original.sourceSeal.parentNativeThreadId !==
          original.capture.parentNativeThreadId ||
        original.sourceSeal.throughNativeTurnId !==
          original.capture.throughNativeTurnId ||
        original.capture.protocolVersion !== original.protocolVersion ||
        original.link.captureHash !== codexChatForkCaptureHash(original.capture)
      )
        throw new ConversationError(
          409,
          "The saved Fork child link is unavailable or does not match this session.",
        );
      const expectedOrigin = codexChatForkOriginSchema.parse({
        kind: "codex-chat-fork",
        projectId: original.projectId,
        parentSessionId: original.parentSessionId,
        throughTurnRequestId: original.throughTurnRequestId,
        parentTurnHash: original.sourceSeal.parentTurnHash,
        parentNativeThreadId: original.capture.parentNativeThreadId,
        throughNativeTurnId: original.capture.throughNativeTurnId,
        childNativeThreadId: original.capture.childNativeThreadId,
        captureHash: codexChatForkCaptureHash(original.capture),
        protocolVersion: original.protocolVersion,
      });
      if (!same(child.origin, expectedOrigin))
        throw new ConversationError(
          409,
          "The registered Fork child does not match its captured original.",
        );
      const childState = storeFor(child.id, child.projectId).read(projectId);
      if (
        childState.binding?.provider !== "codex" ||
        childState.binding.sessionId !== child.origin.childNativeThreadId ||
        childState.binding.version !== child.origin.protocolVersion
      )
        throw new ConversationError(
          409,
          "The Fork child transcript does not match its captured native binding.",
        );
      return child;
    },
    async prepareLinkedChildTurn(input: {
      projectId: string;
      childSessionId: string;
      message: import("../../types/session-turn").SessionMessage;
      validateScope(
        child: CodexChatOwnedRecord,
        about: ConversationObject[],
      ): Promise<void>;
    }) {
      try {
        const child = registry.read(input.projectId, input.childSessionId);
        if (
          child.provider !== "codex" ||
          child.mode !== "chat" ||
          child.projectId !== input.projectId ||
          child.origin?.kind !== "codex-chat-fork" ||
          workspaceKey(child.workspace) !== workspace
        )
          throw new Error("The selected session is not a trusted Fork child.");
        const original = journal.read(input.projectId, child.requestId);
        if (
          !original ||
          original.state !== "linked" ||
          original.requestId !== child.requestId ||
          original.requestHash !== child.requestHash ||
          original.childAppSessionId !== child.id
        )
          throw new Error("The exact linked Fork original is unavailable.");
        const linked = linkedResult(original);
        if (
          linked.state !== "linked" ||
          linked.childSessionId !== child.id ||
          !same(linked.origin, child.origin)
        )
          throw new Error("The linked Fork child identity changed.");
        const parent = registry.read(input.projectId, original.parentSessionId);
        if (parent.origin !== undefined)
          throw new Error("The saved Fork parent is no longer a root session.");
        const parentState = storeFor(parent.id, parent.projectId).read(
            parent.projectId,
          ),
          childState = storeFor(child.id, child.projectId).read(
            child.projectId,
          ),
          selected = parentState.turns.find(
            (turn) => turn.requestId === original.throughTurnRequestId,
          ),
          source = sourceFor({
            parent,
            state: parentState,
            projectId: input.projectId,
            selectedTurnRequestId: original.throughTurnRequestId,
            workspace,
            admission: false,
          });
        if (
          !selected ||
          !source.eligible ||
          selected.hash !== child.origin.parentTurnHash ||
          source.parent.threadId !== child.origin.parentNativeThreadId ||
          source.lastTurnId !== child.origin.throughNativeTurnId ||
          source.prepared.capabilities.version !==
            child.origin.protocolVersion ||
          source.prepared.launch.model !== child.requestedModel ||
          (source.prepared.launch.effort ?? null) !== child.requestedEffort ||
          source.prepared.launch.cwd !== child.worktree ||
          !same(
            original.sourceSeal,
            sourceSealFor(parent, selected.hash, source),
          ) ||
          childState.binding?.provider !== "codex" ||
          childState.binding.sessionId !== child.origin.childNativeThreadId ||
          childState.binding.version !== child.origin.protocolVersion
        )
          throw new Error("The linked Fork source seal could not be verified.");
        if (
          input.message.requestId === original.requestId ||
          input.message.requestId === original.throughTurnRequestId
        )
          throw new ConversationError(
            409,
            "A Fork child turn requires a new request UUID distinct from its Fork source.",
          );
        await input.validateScope(parent, [
          ...(source.prepared.launch.context?.about ?? []),
        ]);
        const attachments = input.message.attachments?.map((item) => {
          if (item.kind !== "text")
            throw new ConversationError(
              400,
              "Codex Chat image staging is unavailable.",
            );
          return { kind: "text" as const, name: item.name, text: item.text };
        });
        const {
            attachments: _sourceAttachments,
            effort: _sourceEffort,
            ...selection
          } = source.prepared.launch,
          launch: CodexChatLaunch = {
            ...selection,
            ...(source.sourceSettings.reasoningEffort === null
              ? {}
              : { effort: source.sourceSettings.reasoningEffort }),
            prompt: input.message.text,
            ...(attachments === undefined ? {} : { attachments }),
            context: {
              projectId: child.projectId,
              repository: child.repository,
              worktree: child.worktree,
              ...(child.beadId ? { beadId: child.beadId } : {}),
              about: input.message.about,
            },
          };
        await input.validateScope(child, input.message.about);
        if (!options.runtime.prepare)
          throw new ConversationError(
            503,
            "The Codex Chat runtime cannot prepare a Fork child turn.",
          );
        let prepared: import("../../types/codex-chat").PreparedCodexChat;
        try {
          prepared = await options.runtime.prepare({
            smith: child.smith,
            launch: structuredClone(launch),
          });
        } catch {
          throw new ConversationError(
            503,
            "The Fork child runtime could not prepare this new request. No turn was accepted.",
          );
        }
        const verified = preparedCodexChatSchema.safeParse(prepared);
        if (
          !verified.success ||
          verified.data.smith !== child.smith ||
          verified.data.cwd !== child.worktree ||
          verified.data.canonicalCwd !== source.prepared.canonicalCwd ||
          verified.data.capabilities.version !== child.origin.protocolVersion ||
          canonicalSessionInput(verified.data.launch) !==
            canonicalSessionInput(launch)
        )
          throw new ConversationError(
            503,
            "The source-sealed Fork child launch could not be verified. No turn was accepted.",
          );
        await input.validateScope(parent, [
          ...(source.prepared.launch.context?.about ?? []),
        ]);
        await input.validateScope(child, input.message.about);
        return {
          prepared: verified.data,
          resumeSettings: {
            modelProvider: source.sourceSettings.modelProvider,
            serviceTier: source.sourceSettings.serviceTier,
            reasoningEffort: source.sourceSettings.reasoningEffort,
          },
        };
      } catch (error) {
        if (error instanceof ConversationError) throw error;
        throw new ConversationError(
          409,
          "The exact linked Fork child source could not be verified. No turn was accepted.",
        );
      }
    },
    listOriginals(projectId: string) {
      return journal.list(projectId);
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
