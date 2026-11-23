/** Strict, browser-safe projections for reviewing a Codex Fork's saved source. */
import { z } from "zod";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./identity-protocol";

export const CODEX_CHAT_FORK_REVIEW_LIMITS = Object.freeze({
  pageItems: 50,
  pages: 40,
  textBytes: 8_192,
  responseBytes: 65_536,
});

const boundedText = z.string().max(CODEX_CHAT_FORK_REVIEW_LIMITS.textBytes);
const aboutItem = z
  .object({
    kind: z.enum(["bead", "session", "run", "event"]),
    id: z.string().min(1).max(256),
  })
  .strict();

const visibleFrame = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user"),
      seq: z.number().int().positive(),
      turnId: sessionRequestIdSchema,
      at: z.string().datetime(),
      text: boundedText,
      about: z.array(aboutItem).max(40),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      seq: z.number().int().positive(),
      turnId: sessionRequestIdSchema,
      at: z.string().datetime(),
      text: boundedText,
    })
    .strict(),
]);

const sourcePage = z
  .object({
    version: z.literal(1),
    projectId: sessionProjectIdSchema,
    parentSessionId: ownedSessionIdSchema,
    requestId: sessionRequestIdSchema.nullable(),
    throughTurnRequestId: sessionRequestIdSchema,
    selectedTurnHash: z.string().regex(/^[a-f0-9]{64}$/),
    target: z
      .object({
        smith: z.string().min(1).max(256),
        repository: z.string().min(1).max(1_024),
        worktree: z.string().min(1).max(1_024),
        beadId: z.string().min(1).max(256).nullable(),
      })
      .strict(),
    settings: z
      .object({
        model: z.string().min(1).max(256),
        provider: z.string().min(1).max(256),
        serviceTier: z
          .object({
            present: z.literal(true),
            value: z.string().max(128).nullable(),
          })
          .strict(),
        effort: z.string().max(128).nullable(),
        approvalPolicy: z.enum(["never", "on-request"]),
        sandbox: z
          .object({
            mode: z.enum(["read-only", "workspace-write"]),
            networkAccess: z.literal("not-reported"),
          })
          .strict(),
      })
      .strict(),
    provenance: z
      .object({
        turn: z.literal("saved-completed-parent-turn"),
        configuration: z.literal("captured-native-configuration"),
      })
      .strict(),
    frames: z.array(visibleFrame).max(CODEX_CHAT_FORK_REVIEW_LIMITS.pageItems),
    nextCursor: z.number().int().nonnegative().nullable(),
    complete: z.boolean(),
  })
  .strict();

/** A fully assembled review may span bounded wire pages; each wire page remains capped at 50. */
export const codexChatForkCompleteSourceSchema = sourcePage.extend({
  frames: z
    .array(visibleFrame)
    .max(
      CODEX_CHAT_FORK_REVIEW_LIMITS.pageItems *
        CODEX_CHAT_FORK_REVIEW_LIMITS.pages,
    ),
});

const contextPage = z
  .object({
    version: z.literal(1),
    available: z.boolean(),
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    parentSessionId: ownedSessionIdSchema,
    throughTurnRequestId: sessionRequestIdSchema,
    state: z.enum([
      "reserved",
      "attempted",
      "captured",
      "linked",
      "held",
      "retired",
    ]),
    reason: z.enum(["source-unavailable", "source-mismatch"]).nullable(),
    source: sourcePage.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available !== (value.source !== null))
      context.addIssue({
        code: "custom",
        message: "Source availability does not match its projection.",
      });
    if (value.available && value.reason !== null)
      context.addIssue({
        code: "custom",
        message: "Available source cannot have an unavailable reason.",
      });
    if (!value.available && value.reason === null)
      context.addIssue({
        code: "custom",
        message: "Unavailable source requires a reason.",
      });
    if (
      value.source &&
      ((value.requestId !== null &&
        value.source.requestId !== value.requestId) ||
        value.source.parentSessionId !== value.parentSessionId ||
        value.source.throughTurnRequestId !== value.throughTurnRequestId)
    )
      context.addIssue({
        code: "custom",
        message: "Source projection does not match its original.",
      });
  });

export type CodexChatForkSourcePage = z.infer<typeof sourcePage>;
export type CodexChatForkContextPage = z.infer<typeof contextPage>;

export const codexChatForkSourcePageSchema = sourcePage;
export const codexChatForkContextPageSchema = contextPage;

export function assertForkReviewEnvelopeBound(value: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    CODEX_CHAT_FORK_REVIEW_LIMITS.responseBytes
  )
    throw new Error("The Fork source review exceeds the safe response limit.");
}
