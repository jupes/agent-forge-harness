import { z } from "zod";
import type {
  OwnedSessionMetadata,
  OwnedSessionRecord,
} from "../../types/owned-session";
import type {
  SessionPreviewReceipt,
  SessionStartReceipt,
} from "../../types/session-requests";
import type { ProjectShiftAttemptOrigin } from "../../types/shift-origin";
import { conversationReceiptSchema } from "../conversations/protocol";
import { parseBeadsIssueId } from "../run-correlation";
import { redactSecrets } from "../secret-patterns";
import { serializeClaudeLaunch } from "./claude-launch";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./identity-protocol";
import { projectShiftAttemptOriginSchema } from "./shift-origin-protocol";
import { sessionTurnSnapshotSchema } from "./turn-protocol";

export {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./identity-protocol";

const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value),
    );
// Wire paths may come from either supported spelling; registry admission also
// requires the host's absolute/canonical spelling before persisting them.
const path = label(1024).refine(
  (value) =>
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(value),
);
export function validOwnedSessionOrigin(value: {
  mode: string;
  beadId?: string | undefined;
  origin?: ProjectShiftAttemptOrigin | undefined;
}): boolean {
  return (
    !value.origin ||
    (value.mode === "task" && value.beadId === value.origin.beadId)
  );
}
/** Unrefined fields for composing provider branches without discarding cross-field checks. */
export const ownedSessionMetadataFieldsSchema = z
  .object({
    mode: z.enum(["task", "chat"]),
    provider: z.literal("claude"),
    workspace: path,
    repository: path,
    worktree: path,
    beadId: z
      .string()
      .max(200)
      .refine(
        (value) =>
          parseBeadsIssueId(value) === value &&
          redactSecrets(value).redactions.length === 0,
      )
      .optional(),
    smith: label(80),
    requestedModel: z
      .string()
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
    requestedEffort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .nullable(),
    origin: projectShiftAttemptOriginSchema.optional(),
  })
  .strict() satisfies z.ZodType<OwnedSessionMetadata>;
export const ownedSessionMetadataSchema =
  ownedSessionMetadataFieldsSchema.refine(validOwnedSessionOrigin);
export const ownedSessionSchema: z.ZodType<OwnedSessionRecord> = z
  .object({
    projectId: sessionProjectIdSchema,
    id: ownedSessionIdSchema,
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    createdAt: z.iso.datetime(),
    ...ownedSessionMetadataSchema.shape,
  })
  .strict()
  .refine(
    (value) =>
      validOwnedSessionOrigin(value) &&
      (!value.origin || value.origin.projectId === value.projectId),
  );
export const sessionStartReceiptSchema: z.ZodType<SessionStartReceipt> = z
  .object({ session: ownedSessionSchema, receipt: conversationReceiptSchema })
  .strict()
  .refine(
    (value) =>
      value.session.id === value.receipt.conversationId &&
      value.session.requestId === value.receipt.turn.requestId,
    { message: "The Start receipt belongs to a different session or request." },
  );
const serializedSchema = z
  .object({
    argv: z.array(z.string().max(65_536)).max(256),
    stdin: z.string().max(8_388_608),
    inputFormat: z.enum(["text", "stream-json"]),
    equivalentCommand: z.string().max(65_536),
    stdinNote: z.string().max(1024),
    requiredFlags: z
      .array(
        z
          .string()
          .max(100)
          .regex(/^--[a-zA-Z][a-zA-Z0-9-]*$/),
      )
      .max(128),
  })
  .strict();
export const sessionPreviewReceiptSchema: z.ZodType<SessionPreviewReceipt> = z
  .object({
    projectId: sessionProjectIdSchema,
    requestId: sessionRequestIdSchema,
    snapshot: sessionTurnSnapshotSchema,
    serialized: serializedSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.snapshot.launch.resumeSessionId !== undefined ||
      value.snapshot.launch.context?.projectId !== value.projectId ||
      value.snapshot.launch.context?.worktree !== value.snapshot.cwd
    )
      context.addIssue({
        code: "custom",
        message:
          "The preview snapshot has a different project, working directory or resume identity.",
      });
    try {
      const expected = serializeClaudeLaunch(
        value.snapshot.launch,
        value.snapshot.capabilities,
      );
      for (const key of Object.keys(expected) as Array<keyof typeof expected>)
        if (
          JSON.stringify(value.serialized[key]) !==
          JSON.stringify(expected[key])
        ) {
          context.addIssue({
            code: "custom",
            message: "The preview command differs from its reviewed snapshot.",
          });
          break;
        }
    } catch {
      context.addIssue({
        code: "custom",
        message: "The preview launch cannot be serialized.",
      });
    }
  });
