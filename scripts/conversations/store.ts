import { createHash } from "node:crypto";
import type {
  ConversationEvent,
  ConversationReceipt,
  ConversationState,
  OwnedConversationAddress,
  PreparedConversationSend,
} from "../../types/conversation";
import {
  ensurePrivateHome,
  MAX_SESSION_TRANSCRIPT_BYTES,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import { ConversationError } from "./error";
import {
  conversationFile,
  conversationId,
  conversationWriteLockFile,
} from "./paths";

import {
  eventSchema,
  parsePreparedConversationSend,
  stateSchema,
} from "./protocol";

export { ConversationError } from "./error";
export { isConversationRequestId, parseConversationSend } from "./protocol";

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
    const parsed = stateSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.projectId !== projectId ||
      parsed.data.conversationId !== conversationId(projectId, address) ||
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
    const valid = stateSchema.safeParse(state);
    const content = `${JSON.stringify(state)}\n`;
    if (
      !valid.success ||
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
    async start(projectId: string, requestId: string, owner: string) {
      return change(projectId, (state) => {
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
    ) {
      const parsed = eventSchema.safeParse(event);
      if (!parsed.success || event.kind === "user")
        throw new ConversationError(400, "Expected a bounded provider frame.");
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
    ): Promise<ConversationReceipt> {
      const request = parsePreparedConversationSend(input);
      if (request.brief && request.brief.projectId !== projectId)
        throw new ConversationError(
          400,
          "The brief snapshot belongs to another project.",
        );
      const hash = createHash("sha256")
        .update(
          JSON.stringify({
            text: request.text,
            about: request.about,
            ...(request.brief ? { brief: request.brief } : {}),
          }),
        )
        .digest("hex");
      const lock = conversationWriteLockFile(home, projectId, address);
      ensurePrivateHome(home);
      const result = await withQueueLock(
        lock,
        async () => {
          const state = read(projectId);
          const previous = state.turns.find(
            (item) => item.requestId === request.requestId,
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
