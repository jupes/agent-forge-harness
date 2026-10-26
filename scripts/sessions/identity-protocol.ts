import { z } from "zod";
import { workspaceKey } from "../projects/scope";

/** Browser-safe identity shapes; these do not establish filesystem authority. */
export const sessionProjectIdSchema = z
  .string()
  .regex(
    /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const sessionRequestIdSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const ownedSessionIdSchema = z
  .string()
  .max(44)
  .refine(
    (value) =>
      value.startsWith("session-") &&
      sessionRequestIdSchema.safeParse(value.slice(8)).success,
  );
export const sessionRequestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const portableWorkspaceSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      value === value.trim() &&
      !/[\p{Cc}\p{Cs}]/u.test(value) &&
      (value.startsWith("/") ||
        value.startsWith("\\\\") ||
        /^[a-zA-Z]:[\\/]/.test(value)),
  )
  .refine((value) => workspaceKey(value) === value);

export const sessionStartIdentityScopeSchema = z
  .object({
    family: z.literal("owned-session-start"),
    projectId: sessionProjectIdSchema,
    workspace: portableWorkspaceSchema,
  })
  .strict();
export const sessionStartIdentityMetadataSchema = z
  .object({
    version: z.literal(1),
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    provider: z.enum(["claude", "codex", "gemini"]),
    mode: z.enum(["task", "chat"]),
    state: z.enum(["reserved", "attempted", "not-sent", "admitted", "retired"]),
  })
  .strict();
export const sessionStartIdentityPageSchema = z
  .object({
    version: z.literal(1),
    scope: sessionStartIdentityScopeSchema,
    identities: z.array(sessionStartIdentityMetadataSchema).max(1_000),
  })
  .strict()
  .superRefine((page, context) => {
    if (
      new Set(page.identities.map((item) => item.requestId)).size !==
      page.identities.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate request identity.",
      });
  });
export const sessionStartIdentityReplySchema = z
  .object({
    version: z.literal(1),
    scope: sessionStartIdentityScopeSchema,
    identity: sessionStartIdentityMetadataSchema,
  })
  .strict();
export const retireSessionStartIdentitySchema = z
  .object({ requestHash: sessionRequestHashSchema })
  .strict();
