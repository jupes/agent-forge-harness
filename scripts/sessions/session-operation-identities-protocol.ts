/** Strict browser-safe wire contract for the read-only operation identity page. */
import { z } from "zod";
import type { SessionOperationIdentityPage } from "../../types/session-operation-identities";
import { workspaceKey } from "../projects/scope";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./protocol";

export const SESSION_OPERATION_IDENTITY_LIMITS = Object.freeze({
  operations: 1_500,
  responseBytes: 65_536,
});

const workspaceSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      value === value.trim() &&
      !/[\p{Cc}\p{Cs}]/u.test(value) &&
      (value.startsWith("/") ||
        value.startsWith("\\\\") ||
        /^[a-zA-Z]:[\\/]/.test(value)) &&
      workspaceKey(value) === value,
  );

const startIdentitySchema = z
  .object({
    family: z.literal("owned-session-start"),
    version: z.literal(1),
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    provider: z.enum(["claude", "codex", "gemini"]),
    mode: z.enum(["task", "chat"]),
    state: z.enum(["reserved", "attempted", "not-sent", "admitted", "retired"]),
  })
  .strict();

export const codexChatForkIdentityMetadataSchema = z
  .object({
    family: z.literal("codex-chat-fork"),
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    parentSessionId: ownedSessionIdSchema,
    throughTurnRequestId: sessionRequestIdSchema,
    state: z.enum(["reserved", "attempted", "captured", "linked", "held"]),
    childSessionId: ownedSessionIdSchema.optional(),
    heldReason: z
      .enum(["unknown-native-outcome", "invalid-native-outcome"])
      .optional(),
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      (identity.state === "linked") !==
      (identity.childSessionId !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Only linked Forks expose a child session.",
      });
    if ((identity.state === "held") !== (identity.heldReason !== undefined))
      context.addIssue({
        code: "custom",
        message: "Only held Forks expose a held reason.",
      });
  });

const operationSchema = z.discriminatedUnion("family", [
  startIdentitySchema,
  codexChatForkIdentityMetadataSchema,
]);

export const sessionOperationIdentityPageSchema: z.ZodType<SessionOperationIdentityPage> =
  z
    .object({
      version: z.literal(1),
      scope: z
        .object({
          projectId: sessionProjectIdSchema,
          workspace: workspaceSchema,
        })
        .strict(),
      operations: z
        .array(operationSchema)
        .max(SESSION_OPERATION_IDENTITY_LIMITS.operations),
    })
    .strict()
    .superRefine((page, context) => {
      const seen = new Set<string>();
      let previous = "";
      for (const operation of page.operations) {
        const key = `${operation.family}\0${operation.requestId}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            message: "Duplicate operation identity.",
          });
          return;
        }
        seen.add(key);
        const order = `${operation.family}\0${operation.requestId}`;
        if (previous !== "" && order < previous) {
          context.addIssue({
            code: "custom",
            message: "Operation identities are not in stable order.",
          });
          return;
        }
        previous = order;
      }
    });

export function sessionOperationIdentityEnvelopeBytes(
  data: SessionOperationIdentityPage,
): number {
  return new TextEncoder().encode(
    JSON.stringify({ ok: true, data, error: null }),
  ).byteLength;
}
