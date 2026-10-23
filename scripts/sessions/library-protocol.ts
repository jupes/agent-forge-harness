import { z } from "zod";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type { ConversationState } from "../../types/conversation";
import type {
  SessionArchiveReceipt,
  SessionArchiveRequest,
  SessionLibraryEntry,
  SessionLibraryList,
  SessionLibraryRead,
  SessionTranscriptExport,
} from "../../types/session-library";
import { stateSchema } from "../conversations/protocol";
import { ownedCodingStateSchema } from "./codex-owned-journal";
import {
  codexChatOwnedSessionSchema,
  codexOwnedSessionSchema,
} from "./codex-owned-metadata";
import { geminiOwnedSessionSchema } from "./gemini-owned-metadata";
import {
  ownedSessionIdSchema,
  ownedSessionSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./protocol";

if (typeof window !== "undefined") z.config({ jitless: true });

/** Matches the private journal's existing ceiling; an export is never truncated. */
export const MAX_SESSION_EXPORT_BYTES = 8 * 1024 * 1024;

const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const identity = {
  projectId: sessionProjectIdSchema,
  sessionId: ownedSessionIdSchema,
  startRequestId: sessionRequestIdSchema,
  startRequestHash: sessionRequestHashSchema,
};
export const sessionLibraryEntrySchema: z.ZodType<SessionLibraryEntry> = z
  .object({
    ...identity,
    revision,
    archived: z.boolean(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((value) =>
    value.revision === 0
      ? !value.archived && value.updatedAt === null
      : value.updatedAt !== null,
  );
export const sessionArchiveRequestSchema: z.ZodType<SessionArchiveRequest> = z
  .object({
    requestId: sessionRequestIdSchema,
    expectedRevision: revision,
    archived: z.boolean(),
  })
  .strict();
export const sessionArchiveReceiptSchema: z.ZodType<SessionArchiveReceipt> = z
  .object({
    ...identity,
    original: sessionArchiveRequestSchema,
    outcome: z.enum(["applied", "refused"]),
    revision,
    archived: z.boolean(),
    at: z.iso.datetime(),
    reason: z.string().min(1).max(1000).nullable(),
  })
  .strict()
  .refine((value) =>
    value.outcome === "applied"
      ? value.reason === null &&
        value.archived === value.original.archived &&
        value.revision === value.original.expectedRevision + 1
      : value.reason !== null &&
        value.revision !== value.original.expectedRevision,
  );
export const sessionLibraryReadSchema: z.ZodType<SessionLibraryRead> = z
  .object({
    entry: sessionLibraryEntrySchema,
    receipt: sessionArchiveReceiptSchema.nullable(),
  })
  .strict()
  .refine(
    ({ entry, receipt }) =>
      !receipt ||
      (receipt.projectId === entry.projectId &&
        receipt.sessionId === entry.sessionId &&
        receipt.startRequestId === entry.startRequestId &&
        receipt.startRequestHash === entry.startRequestHash &&
        receipt.revision <= entry.revision &&
        (receipt.revision !== entry.revision ||
          receipt.archived === entry.archived)),
  );
export const sessionLibraryListSchema: z.ZodType<SessionLibraryList> = z
  .object({
    projectId: sessionProjectIdSchema,
    entries: z.array(sessionLibraryEntrySchema).max(1000),
  })
  .strict()
  .refine(
    (value) =>
      value.entries.every((entry) => entry.projectId === value.projectId) &&
      new Set(value.entries.map((entry) => entry.sessionId)).size ===
        value.entries.length,
  );

export function originalSessionLaunchMatches(
  session: OwnedCodingSessionRecord,
  state: ConversationState,
): boolean {
  const first = state.frames[0];
  if (
    !first ||
    first.seq !== 1 ||
    first.turnId !== session.requestId ||
    first.event.kind !== "user" ||
    state.turns[0]?.requestId !== session.requestId
  )
    return false;
  if (session.provider === "gemini") {
    const snapshot = first.event.geminiTask;
    return (
      !!snapshot &&
      snapshot.provider === "gemini" &&
      snapshot.smith === session.smith &&
      snapshot.launch.cwd === session.worktree &&
      (snapshot.launch.model ?? null) === session.requestedModel &&
      state.turns.length === 1 &&
      state.frames.every(({ event }) => {
        if (event.kind !== "user") return true;
        const saved = event.geminiTask;
        return (
          saved?.smith === session.smith &&
          saved.launch.cwd === session.worktree &&
          saved.launch.context?.projectId === session.projectId &&
          saved.launch.context.repository === session.repository &&
          saved.launch.context.worktree === session.worktree &&
          saved.launch.context.beadId === session.beadId
        );
      })
    );
  }
  const snapshot =
    first.event.session ?? first.event.codexTask ?? first.event.codexChat;
  return (
    !!snapshot &&
    snapshot.provider === session.provider &&
    snapshot.smith === session.smith &&
    snapshot.cwd === session.worktree &&
    snapshot.launch.mode === session.mode &&
    snapshot.launch.model === session.requestedModel &&
    (snapshot.launch.effort ?? null) === session.requestedEffort &&
    state.frames.every(({ event }) => {
      if (event.kind !== "user") return true;
      const saved = event.session ?? event.codexTask ?? event.codexChat;
      return (
        saved?.provider === session.provider &&
        saved.smith === session.smith &&
        saved.cwd === session.worktree &&
        saved.launch.context?.projectId === session.projectId &&
        saved.launch.context.repository === session.repository &&
        saved.launch.context.worktree === session.worktree &&
        saved.launch.context.beadId === session.beadId
      );
    })
  );
}

export const sessionTranscriptExportSchema: z.ZodType<SessionTranscriptExport> =
  z
    .object({
      format: z.literal("agent-forge.session-transcript"),
      version: z.literal(1),
      complete: z.literal(true),
      exportedAt: z.iso.datetime(),
      session: z.union([
        ownedSessionSchema,
        codexOwnedSessionSchema,
        codexChatOwnedSessionSchema,
        geminiOwnedSessionSchema,
      ]),
      lastSequence: z.number().int().nonnegative().max(20_000),
      conversation: z
        .object({
          conversationId: stateSchema.shape.conversationId,
          revision: stateSchema.shape.revision,
          binding: stateSchema.shape.binding,
          turns: z
            .array(stateSchema.shape.turns.element.omit({ owner: true }))
            .max(1000),
          frames: ownedCodingStateSchema.shape.frames,
        })
        .strict(),
    })
    .strict()
    .refine(
      (value) => {
        const state = {
          ...value.conversation,
          version: 1 as const,
          projectId: value.session.projectId,
          turns: value.conversation.turns.map((turn) => ({
            ...turn,
            owner: null,
          })),
        };
        return (
          value.conversation.conversationId === value.session.id &&
          value.lastSequence === value.conversation.frames.length &&
          value.conversation.frames.every(
            (frame, index) =>
              frame.seq === index + 1 &&
              value.conversation.turns.some(
                (turn) => turn.requestId === frame.turnId,
              ),
          ) &&
          ownedCodingStateSchema.safeParse(state).success &&
          originalSessionLaunchMatches(value.session, state)
        );
      },
      {
        message:
          "The export is incomplete or belongs to a different private session.",
      },
    );
