import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, unlinkSync } from "node:fs";
import type {
  CodexChatOwnerLifecycleFact,
  ConversationEvent,
  ConversationReceipt,
  ConversationState,
  OwnedConversationAddress,
  PreparedConversationSend,
} from "../../types/conversation";
import type { KeeperContinuationRequest } from "../../types/keeper-recovery";
import {
  ensurePrivateHome,
  MAX_SESSION_TRANSCRIPT_BYTES,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { keeperContinuationSchema } from "../keeper/recovery-protocol";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  ownedCodingEventSchema,
  ownedCodingStateSchema,
  parseOwnedPreparedConversationSend,
} from "../sessions/codex-owned-journal";
import { privatePacketHash } from "../sessions/private-packet";
import { ConversationError } from "./error";
import {
  conversationFile,
  conversationId,
  conversationWriteLockFile,
} from "./paths";

import {
  eventSchema,
  isConversationRequestId,
  parsePreparedConversationSend,
  stateSchema,
} from "./protocol";

export { ConversationError } from "./error";
export { isConversationRequestId, parseConversationSend } from "./protocol";

function assertCurrentOwner(isCurrent?: () => boolean) {
  if (isCurrent && !isCurrent())
    throw new ConversationError(
      409,
      "This private turn owner is no longer active.",
    );
}

function validShiftInputs(state: ConversationState): boolean {
  return state.frames.every((frame) => {
    const event = frame.event;
    if (event.kind !== "user" || !event.shift) return true;
    const turn = state.turns.find((row) => row.requestId === frame.turnId);
    const users = state.frames.filter(
      (row) => row.turnId === frame.turnId && row.event.kind === "user",
    );
    return (
      users.length === 1 &&
      turn?.hash ===
        createHash("sha256")
          .update(
            JSON.stringify({
              text: event.text,
              about: event.about,
              shift: event.shift,
            }),
          )
          .digest("hex")
    );
  });
}

/** Hash verification belongs to the trusted reader/writer, not the browser's pure wire codec. */
function validGeminiChatIntents(state: ConversationState): boolean {
  return state.frames.every(({ event }) => {
    if (event.kind !== "coding-gemini-chat-decision") return true;
    const {
      projectId,
      sessionId,
      requestId,
      turnRequestId,
      approvalId,
      optionId,
    } = event.receipt;
    return (
      event.requestHash ===
      privatePacketHash({
        projectId,
        sessionId,
        requestId,
        turnRequestId,
        approvalId,
        optionId,
      })
    );
  });
}

function validKeeperRecovery(state: ConversationState): boolean {
  const recovery = state.keeperRecovery;
  if (!recovery) return true;
  const last = recovery.records.at(-1);
  return (
    !!last &&
    recovery.generation === recovery.records.length &&
    recovery.smith === last.smith &&
    JSON.stringify(recovery.continuation) === JSON.stringify(last) &&
    new Set(recovery.records.map((item) => item.requestId)).size ===
      recovery.records.length &&
    recovery.records.every((item, index) => {
      const hash = createHash("sha256")
        .update(
          JSON.stringify({
            requestId: item.requestId,
            expectedRevision: item.expectedRevision,
            mode: item.mode,
            smith: item.smith,
            summary: item.summary,
          }),
        )
        .digest("hex");
      return (
        item.generation === index + 1 &&
        item.hash === hash &&
        item.sourceSequence <= state.frames.length &&
        item.expectedRevision < item.revision &&
        item.revision <= state.revision &&
        (index === 0 ||
          item.revision > (recovery.records[index - 1]?.revision ?? 0)) &&
        !state.turns.some((turn) => turn.requestId === item.requestId)
      );
    })
  );
}

/** A lease-free observation; producing this view never writes the transcript. */
export function interruptedConversation(
  state: ConversationState,
  at?: string,
): ConversationState {
  return {
    ...state,
    turns: state.turns.map((selected) => {
      if (!["accepted", "running", "cancelling"].includes(selected.phase))
        return selected;
      const dispatched = selected.phase !== "accepted";
      return {
        ...selected,
        phase: dispatched ? "unknown" : "failed",
        reason: dispatched
          ? "The hearth was interrupted after dispatch. Provider delivery is unknown; this turn was not resent."
          : "The hearth stopped before dispatch. No provider was started for this turn.",
        updatedAt: at ?? selected.updatedAt,
      };
    }),
  };
}
export function createConversationStore(
  home: string,
  now: () => Date = () => new Date(),
  address?: OwnedConversationAddress,
) {
  const stateCodec = address ? ownedCodingStateSchema : stateSchema;
  const eventCodec = address ? ownedCodingEventSchema : eventSchema;
  const fileFor = (projectId: string) =>
    conversationFile(home, projectId, address);
  const read = (projectId: string): ConversationState => {
    const found = readSessionTranscript(home, fileFor(projectId));
    if (found.problem)
      throw new ConversationError(
        503,
        "The private conversation could not be read. Its saved data has been kept.",
      );
    if (found.text === null)
      return {
        version: 1,
        projectId,
        conversationId: conversationId(projectId, address),
        revision: 0,
        binding: null,
        turns: [],
        frames: [],
      };
    let raw: unknown;
    try {
      raw = JSON.parse(found.text);
    } catch {
      throw new ConversationError(
        503,
        "The saved conversation is not valid JSON. Its saved data has been kept.",
      );
    }
    const parsed = stateCodec.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.projectId !== projectId ||
      parsed.data.conversationId !== conversationId(projectId, address) ||
      !validKeeperRecovery(parsed.data) ||
      !validShiftInputs(parsed.data) ||
      !validGeminiChatIntents(parsed.data) ||
      parsed.data.frames.some(
        (frame, index) =>
          frame.seq !== index + 1 ||
          !parsed.data.turns.some((item) => item.requestId === frame.turnId),
      ) ||
      new Set(parsed.data.turns.map((item) => item.requestId)).size !==
        parsed.data.turns.length
    )
      throw new ConversationError(
        503,
        "The saved conversation is invalid or uses an unsupported version. Its saved data has been kept.",
      );
    return parsed.data;
  };
  const save = (state: ConversationState) => {
    const valid = stateCodec.safeParse(state);
    const content = `${JSON.stringify(state)}\n`;
    if (
      !valid.success ||
      !validKeeperRecovery(state) ||
      !validShiftInputs(state) ||
      !validGeminiChatIntents(state) ||
      Buffer.byteLength(content) > MAX_SESSION_TRANSCRIPT_BYTES
    )
      throw new ConversationError(
        503,
        "The conversation store is full or invalid. The change was not written.",
      );
    writeOwnerOnly(fileFor(state.projectId), content);
  };
  const change = async <T>(
    projectId: string,
    update: (state: ConversationState) => T,
  ): Promise<T> => {
    const lock = conversationWriteLockFile(home, projectId, address);
    ensurePrivateHome(home);
    const result = await withQueueLock(
      lock,
      async () => {
        const state = read(projectId);
        const value = update(state);
        state.revision++;
        save(state);
        return value;
      },
      { waitMs: 1000 },
    );
    if (!result.ok)
      throw new ConversationError(
        503,
        "The conversation is busy or unavailable. Read the original request before retrying.",
      );
    return result.value;
  };
  return {
    read,
    /** Publish only the exact empty, native-bound child journal without replacing an existing path. */
    async bootstrapCodexForkChild(
      projectId: string,
      nativeSessionId: string,
      version: string,
    ): Promise<ConversationState> {
      if (
        !address ||
        address.kind !== "session" ||
        address.projectId !== projectId ||
        address.sessionId !== conversationId(projectId, address)
      )
        throw new ConversationError(
          400,
          "Expected an owned Fork child address.",
        );
      const expected: ConversationState = {
        version: 1,
        projectId,
        conversationId: address.sessionId,
        revision: 0,
        binding: { provider: "codex", sessionId: nativeSessionId, version },
        turns: [],
        frames: [],
      };
      const parsedExpected = ownedCodingStateSchema.safeParse(expected);
      if (!parsedExpected.success)
        throw new ConversationError(
          400,
          "The empty Fork child state is invalid.",
        );
      const file = fileFor(projectId),
        lock = conversationWriteLockFile(home, projectId, address);
      ensurePrivateHome(home);
      const published = await withQueueLock(
        lock,
        async () => {
          const readExactExisting = (): ConversationState => {
            const before = lstatSync(file);
            if (
              before.isSymbolicLink() ||
              !before.isFile() ||
              before.nlink !== 1
            )
              throw new ConversationError(
                409,
                "A conflicting child conversation file exists and was kept.",
              );
            const existing = read(projectId),
              after = lstatSync(file);
            if (
              after.isSymbolicLink() ||
              !after.isFile() ||
              after.nlink !== 1 ||
              before.dev !== after.dev ||
              before.ino !== after.ino
            )
              throw new ConversationError(
                409,
                "The child conversation changed during bootstrap and was kept.",
              );
            if (JSON.stringify(existing) !== JSON.stringify(expected))
              throw new ConversationError(
                409,
                "A non-empty or conflicting child conversation exists and was kept.",
              );
            return existing;
          };
          try {
            lstatSync(file);
            return readExactExisting();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const stage = `${file}.${randomUUID()}.fork.tmp`;
          let ownsStage = false;
          try {
            writeOwnerOnly(stage, `${JSON.stringify(expected)}\n`);
            ownsStage = true;
            // Hard-link publication is atomic and fails if any destination already exists.
            linkSync(stage, file);
            unlinkSync(stage);
            ownsStage = false;
            const confirmed = read(projectId);
            if (JSON.stringify(confirmed) !== JSON.stringify(expected))
              throw new ConversationError(
                503,
                "The new Fork child state did not match its verified bootstrap.",
              );
            return confirmed;
          } catch (error) {
            if (ownsStage) {
              try {
                unlinkSync(stage);
              } catch {
                // Keep the original publication error; the stage path is unique and private.
              }
            }
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              return readExactExisting();
            }
            throw error;
          }
        },
        { waitMs: 1000 },
      );
      if (!published.ok)
        throw new ConversationError(503, "The child conversation is busy.");
      return published.value;
    },
    /** The service holds the dispatch lease and has freshly checked the selected smith. */
    async continueKeeper(
      projectId: string,
      raw: KeeperContinuationRequest,
      provider: string,
    ) {
      if (address)
        throw new ConversationError(
          400,
          "Keeper recovery cannot change an owned session.",
        );
      const parsed = keeperContinuationSchema.safeParse(raw);
      if (!parsed.success)
        throw new ConversationError(
          400,
          "Expected an explicit smith, revision and reviewed summary.",
        );
      const request = parsed.data;
      const hash = createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex");
      const lock = conversationWriteLockFile(home, projectId, address);
      ensurePrivateHome(home);
      const changed = await withQueueLock(
        lock,
        async () => {
          const state = read(projectId);
          const previous = state.keeperRecovery?.records.find(
            (item) => item.requestId === request.requestId,
          );
          if (previous) {
            if (previous.hash !== hash)
              throw new ConversationError(
                409,
                "This request id already names different content.",
              );
            return previous;
          }
          if (state.turns.some((item) => item.requestId === request.requestId))
            throw new ConversationError(
              409,
              "This request id already names a conversation turn.",
            );
          if (state.revision !== request.expectedRevision)
            throw new ConversationError(
              409,
              "The conversation changed. Review it again before changing its Keeper.",
            );
          if (
            state.turns.some((item) =>
              ["accepted", "running", "cancelling", "unknown"].includes(
                item.phase,
              ),
            )
          )
            throw new ConversationError(
              409,
              "A turn is active or its outcome is unknown. Its Keeper cannot be changed.",
            );
          const generation = (state.keeperRecovery?.generation ?? 0) + 1;
          if (generation > 100)
            throw new ConversationError(
              503,
              "Keeper continuation history is full. Its saved context has been kept.",
            );
          const resumed =
            request.mode === "switch" &&
            state.binding !== null &&
            state.binding.provider === provider;
          if (!resumed && state.frames.length && !request.summary.trim())
            throw new ConversationError(
              400,
              "Review and retain a summary before starting a new provider conversation.",
            );
          const record = {
            ...request,
            hash,
            revision: state.revision + 1,
            generation,
            sourceSequence: state.frames.length,
            at: now().toISOString(),
            previousBinding: state.binding,
            resumed,
          };
          state.keeperRecovery = {
            smith: request.smith,
            generation,
            continuation: record,
            records: [...(state.keeperRecovery?.records ?? []), record],
          };
          if (!resumed) state.binding = null;
          state.revision++;
          save(state);
          return record;
        },
        { waitMs: 1000 },
      );
      if (!changed.ok)
        throw new ConversationError(
          503,
          "The conversation is busy. Check the original continuation before retrying.",
        );
      return changed.value;
    },
    async start(
      projectId: string,
      requestId: string,
      owner: string,
      isCurrent?: () => boolean,
    ) {
      return change(projectId, (state) => {
        assertCurrentOwner(isCurrent);
        const selected = state.turns.find(
          (item) => item.requestId === requestId,
        );
        if (!selected || selected.phase !== "accepted")
          throw new ConversationError(
            409,
            "This turn is not waiting for dispatch.",
          );
        selected.phase = "running";
        selected.owner = owner;
        selected.updatedAt = now().toISOString();
      });
    },
    async append(
      projectId: string,
      requestId: string,
      owner: string,
      event: ConversationEvent,
      isCurrent?: () => boolean,
    ) {
      const parsed = eventCodec.safeParse(event);
      if (!parsed.success || event.kind === "user")
        throw new ConversationError(400, "Expected a bounded provider frame.");
      return change(projectId, (state) => {
        assertCurrentOwner(isCurrent);
        const selected = state.turns.find(
          (item) => item.requestId === requestId,
        );
        if (!selected || !["running", "cancelling"].includes(selected.phase))
          throw new ConversationError(409, "This turn is no longer active.");
        if (selected.owner !== owner)
          throw new ConversationError(
            409,
            "This turn belongs to another owner.",
          );
        if (event.kind === "identity") {
          if (
            state.binding &&
            (state.binding.provider !== event.provider ||
              state.binding.sessionId !== event.sessionId)
          )
            throw new ConversationError(
              409,
              "The provider did not resume the saved conversation identity.",
            );
          state.binding = {
            provider: event.provider,
            sessionId: event.sessionId,
            version: event.version,
          };
        }
        const at = now().toISOString();
        selected.updatedAt = at;
        state.frames.push({
          seq: state.frames.length + 1,
          turnId: requestId,
          at,
          event: parsed.data,
        });
      });
    },
    /** Private application fact; never a provider frame or public conversation event. */
    async recordCodexChatOwnerGenerationStarted(
      projectId: string,
      requestId: string,
      owner: string,
      generationId: string,
      isCurrent?: () => boolean,
    ) {
      if (
        !address ||
        address.kind !== "session" ||
        address.projectId !== projectId ||
        !isConversationRequestId(requestId) ||
        !isConversationRequestId(generationId)
      )
        throw new ConversationError(400, "Expected an owned Chat generation.");
      return change(projectId, (state) => {
        assertCurrentOwner(isCurrent);
        const selected = state.turns.find(
            (item) => item.requestId === requestId,
          ),
          original = state.frames.find(
            (item) =>
              item.turnId === requestId &&
              item.event.kind === "user" &&
              item.event.codexChat !== undefined,
          )?.event;
        if (
          !selected ||
          !["running", "cancelling"].includes(selected.phase) ||
          selected.owner !== owner ||
          original?.kind !== "user" ||
          original.codexChat?.launch.mode !== "chat"
        )
          throw new ConversationError(
            409,
            "The private Chat generation no longer owns an ordinary active turn.",
          );
        const facts = state.codexChatOwnerLifecycle ?? [];
        if (
          facts.length >= 2000 ||
          facts.some(
            (fact) =>
              fact.requestId === requestId ||
              fact.generationId === generationId,
          )
        )
          throw new ConversationError(
            409,
            "The private Chat generation identity is already recorded.",
          );
        const fact: CodexChatOwnerLifecycleFact = {
          kind: "generation-started",
          requestId,
          generationId,
          afterSequence: state.frames.length,
          revision: state.revision + 1,
        };
        state.codexChatOwnerLifecycle = [...facts, fact];
      });
    },
    /** Positive supervisor release is bound to the exact persisted native thread and turn. */
    async recordCodexChatOwnerGenerationReleased(
      projectId: string,
      requestId: string,
      owner: string,
      generationId: string,
      binding: {
        provider: "codex";
        sessionId: string;
        version: string;
        turnId: string;
      },
      isCurrent?: () => boolean,
    ) {
      if (
        !address ||
        address.kind !== "session" ||
        address.projectId !== projectId ||
        !isConversationRequestId(requestId) ||
        !isConversationRequestId(generationId) ||
        !isConversationRequestId(binding.sessionId) ||
        !isConversationRequestId(binding.turnId) ||
        !binding.version.trim() ||
        binding.version.length > 100
      )
        throw new ConversationError(400, "Expected a bound Chat release.");
      return change(projectId, (state) => {
        assertCurrentOwner(isCurrent);
        const selected = state.turns.find(
            (item) => item.requestId === requestId,
          ),
          facts = state.codexChatOwnerLifecycle ?? [],
          begun = facts.find(
            (fact) =>
              fact.kind === "generation-started" &&
              fact.requestId === requestId,
          ),
          alreadyReleased = facts.some(
            (fact) =>
              fact.kind === "generation-released" &&
              fact.requestId === requestId,
          ),
          identity = state.frames.find(
            (frame) =>
              frame.turnId === requestId && frame.event.kind === "identity",
          )?.event,
          nativeTurn = state.frames.find(
            (frame) =>
              frame.turnId === requestId &&
              frame.event.kind === "coding-chat" &&
              frame.event.event.kind === "turn",
          )?.event;
        if (
          !selected ||
          !["running", "cancelling"].includes(selected.phase) ||
          selected.owner !== owner ||
          !begun ||
          begun.generationId !== generationId ||
          alreadyReleased ||
          state.binding?.provider !== "codex" ||
          state.binding.sessionId !== binding.sessionId ||
          state.binding.version !== binding.version ||
          identity?.kind !== "identity" ||
          identity.provider !== "codex" ||
          identity.sessionId !== binding.sessionId ||
          identity.version !== binding.version ||
          nativeTurn?.kind !== "coding-chat" ||
          nativeTurn.event.kind !== "turn" ||
          nativeTurn.event.threadId !== binding.sessionId ||
          nativeTurn.event.turnId !== binding.turnId
        )
          throw new ConversationError(
            409,
            "The private Chat release does not match its active native turn.",
          );
        if (facts.length >= 2000)
          throw new ConversationError(
            503,
            "The private Chat lifecycle journal is full.",
          );
        const fact: CodexChatOwnerLifecycleFact = {
          kind: "generation-released",
          requestId,
          generationId,
          afterSequence: state.frames.length,
          revision: state.revision + 1,
          binding,
        };
        state.codexChatOwnerLifecycle = [...facts, fact];
      });
    },
    async requestStop(projectId: string, requestId: string) {
      return change(projectId, (state) => {
        const selected = state.turns.find(
          (item) => item.requestId === requestId,
        );
        if (!selected)
          throw new ConversationError(
            404,
            "This turn is not in the conversation.",
          );
        if (selected.phase === "accepted") selected.phase = "cancelled";
        else if (selected.phase === "running") selected.phase = "cancelling";
        selected.updatedAt = now().toISOString();
      });
    },
    /** The caller has observed supervised process termination before settling a turn. */
    async finish(
      projectId: string,
      requestId: string,
      owner: string,
      phase: "completed" | "cancelled" | "failed" | "unknown",
      reason: string | null,
      isCurrent?: () => boolean,
    ) {
      return change(projectId, (state) => {
        const selected = state.turns.find(
          (item) => item.requestId === requestId,
        );
        if (!selected || !["running", "cancelling"].includes(selected.phase))
          throw new ConversationError(409, "This turn is no longer active.");
        if (selected.owner !== owner)
          throw new ConversationError(
            409,
            "This turn belongs to another owner.",
          );
        if (selected.phase === "cancelling") phase = "cancelled";
        if (isCurrent && !isCurrent()) {
          phase = "unknown";
          reason =
            "The private turn owner was interrupted before completion was recorded.";
        }
        if (
          phase === "completed" &&
          !state.frames.some(
            (frame) =>
              frame.turnId === requestId && frame.event.kind === "identity",
          )
        ) {
          phase = "unknown";
          reason =
            "The provider did not confirm this turn's conversation identity. Continuity is unknown.";
        }
        selected.phase = phase;
        selected.reason = reason;
        selected.updatedAt = now().toISOString();
      });
    },
    /** Called only after the service has acquired the dispatch lease. Never retries a turn. */
    async recover(projectId: string) {
      const current = read(projectId);
      if (
        !current.turns.some((item) =>
          ["accepted", "running", "cancelling"].includes(item.phase),
        )
      )
        return;
      return change(projectId, (state) => {
        state.turns = interruptedConversation(state, now().toISOString()).turns;
      });
    },
    async accept(
      projectId: string,
      input: PreparedConversationSend,
      isCurrent?: () => boolean,
    ): Promise<ConversationReceipt> {
      const request = address
        ? parseOwnedPreparedConversationSend(input)
        : parsePreparedConversationSend(input);
      if (
        request.session &&
        (!address ||
          (request.session.launch.context &&
            request.session.launch.context.projectId !== projectId))
      )
        throw new ConversationError(
          400,
          "The prepared launch does not belong to this owned session.",
        );
      if (request.brief && request.brief.projectId !== projectId)
        throw new ConversationError(
          400,
          "The brief snapshot belongs to another project.",
        );
      if (
        request.codexTask &&
        (!address || request.codexTask.launch.context?.projectId !== projectId)
      )
        throw new ConversationError(
          400,
          "The private Codex Task does not belong to this owned session.",
        );
      if (
        request.codexChat &&
        (!address || request.codexChat.launch.context?.projectId !== projectId)
      )
        throw new ConversationError(
          400,
          "The private Codex Chat does not belong to this owned session.",
        );
      if (
        request.geminiTask &&
        (!address || request.geminiTask.launch.context?.projectId !== projectId)
      )
        throw new ConversationError(
          400,
          "The private Gemini Task does not belong to this owned session.",
        );
      if (
        request.geminiChat &&
        (!address || request.geminiChat.launch.context?.projectId !== projectId)
      )
        throw new ConversationError(
          400,
          "The private Gemini Chat does not belong to this owned session.",
        );
      if (
        request.shift &&
        (!address ||
          request.shift.projectId !== projectId ||
          request.shift.conversationId !== address.sessionId ||
          request.shift.turnId !== request.requestId)
      )
        throw new ConversationError(
          400,
          "The private shift attempt does not belong to this owned session.",
        );
      const hash = createHash("sha256")
        .update(
          JSON.stringify({
            text: request.text,
            about: request.about,
            ...(request.brief ? { brief: request.brief } : {}),
            ...(request.session ? { session: request.session } : {}),
            ...(request.codexTask ? { codexTask: request.codexTask } : {}),
            ...(request.codexChat ? { codexChat: request.codexChat } : {}),
            ...(request.geminiTask ? { geminiTask: request.geminiTask } : {}),
            ...(request.geminiChat ? { geminiChat: request.geminiChat } : {}),
            ...(request.shift ? { shift: request.shift } : {}),
          }),
        )
        .digest("hex");
      const lock = conversationWriteLockFile(home, projectId, address);
      ensurePrivateHome(home);
      const result = await withQueueLock(
        lock,
        async () => {
          const state = read(projectId);
          assertCurrentOwner(isCurrent);
          const previous = state.turns.find(
            (item) => item.requestId === request.requestId,
          );
          if (
            state.keeperRecovery?.records.some(
              (item) => item.requestId === request.requestId,
            )
          )
            throw new ConversationError(
              409,
              "This request id already names a Keeper continuation.",
            );
          if (previous) {
            if (previous.hash !== hash)
              throw new ConversationError(
                409,
                "This request id already names different content. Read the original request before sending again.",
              );
            return {
              conversationId: state.conversationId,
              revision: state.revision,
              turn: previous,
            };
          }
          if (
            state.turns.some((item) =>
              ["accepted", "running", "cancelling", "unknown"].includes(
                item.phase,
              ),
            )
          )
            throw new ConversationError(
              409,
              "A turn is active or its outcome is unknown. Read its outcome before sending another.",
            );
          if (state.revision !== request.expectedRevision)
            throw new ConversationError(
              409,
              "The conversation changed. Read it again before sending.",
            );
          const at = now().toISOString();
          const accepted = {
            requestId: request.requestId,
            hash,
            phase: "accepted" as const,
            createdAt: at,
            updatedAt: at,
            reason: null,
            owner: null,
          };
          state.revision++;
          state.turns.push(accepted);
          state.frames.push({
            seq: state.frames.length + 1,
            turnId: request.requestId,
            at,
            event: {
              kind: "user",
              text: request.text,
              about: request.about,
              ...(request.brief ? { brief: request.brief } : {}),
              ...(request.session ? { session: request.session } : {}),
              ...(request.codexTask ? { codexTask: request.codexTask } : {}),
              ...(request.codexChat ? { codexChat: request.codexChat } : {}),
              ...(request.geminiTask ? { geminiTask: request.geminiTask } : {}),
              ...(request.geminiChat ? { geminiChat: request.geminiChat } : {}),
              ...(request.shift ? { shift: request.shift } : {}),
            },
          });
          save(state);
          return {
            conversationId: state.conversationId,
            revision: state.revision,
            turn: accepted,
          };
        },
        { waitMs: 1000 },
      );
      if (!result.ok)
        throw new ConversationError(
          503,
          "The conversation is busy or unavailable. Read the original request before retrying.",
        );
      return result.value;
    },
  };
}
