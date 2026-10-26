import { z } from "zod";
import type { Smith } from "../../types/hearth";
import type {
  SmithConfigEditFields,
  SmithConfigEditPreview,
  SmithConfigEditPreviewRequest,
  SmithConfigEditRequest,
  SmithConfigEditRevision,
  SmithConfigEditTargetBefore,
} from "../../types/smith-config-edit";
import { validateSmith } from "../hearth/validate";

if (typeof window !== "undefined") z.config({ jitless: true });

export const SMITH_CONFIG_EDIT_LIMITS = Object.freeze({
  requestBytes: 16_000,
  responseBytes: 65_536,
  sourceBytes: 1_048_576,
  pathLength: 1024,
});

const encodedWithin = (value: unknown, max: number) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= max;
  } catch {
    return false;
  }
};

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const smithConfigEditRequestIdSchema = z
  .uuid()
  .refine((id) => id === id.toLowerCase());
export const smithConfigEditRevisionSchema = z
  .object({ version: z.literal(1), user: hash, workspace: hash })
  .strict() satisfies z.ZodType<SmithConfigEditRevision>;

const fields = {
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(512),
  effort: z.string().min(1).max(128),
  enabled: z.boolean(),
  tags: z.array(z.string().max(256)).max(64),
} as const;

const name = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !(value in Object.prototype));
const smithSchema = z
  .object({ name, ...fields })
  .strict()
  .refine((value) => validateSmith(value).ok) satisfies z.ZodType<Smith>;

const previewFields = {
  target: z.enum(["user", "workspace"]),
  name,
  smith: smithSchema,
};
export const smithConfigEditPreviewRequestSchema = z
  .object(previewFields)
  .strict()
  .refine((value) => value.name === value.smith.name)
  .refine((value) =>
    encodedWithin(value, SMITH_CONFIG_EDIT_LIMITS.requestBytes),
  ) satisfies z.ZodType<SmithConfigEditPreviewRequest>;

export const smithConfigEditRequestSchema = z
  .object({
    requestId: smithConfigEditRequestIdSchema,
    ...previewFields,
    expectedRevision: smithConfigEditRevisionSchema,
  })
  .strict()
  .refine((value) => value.name === value.smith.name)
  .refine((value) =>
    encodedWithin(value, SMITH_CONFIG_EDIT_LIMITS.requestBytes),
  ) satisfies z.ZodType<SmithConfigEditRequest>;

const path = z
  .string()
  .min(1)
  .max(SMITH_CONFIG_EDIT_LIMITS.pathLength)
  .refine(
    (value) =>
      value === "builtin" ||
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value),
  );
const filePath = z
  .string()
  .min(1)
  .max(SMITH_CONFIG_EDIT_LIMITS.pathLength)
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value),
  );
const targetBeforeSchema = z
  .object({ ...fields })
  .partial()
  .strict() satisfies z.ZodType<SmithConfigEditTargetBefore>;
const provenanceSchema = z
  .object({
    provider: path,
    model: path,
    effort: path,
    enabled: path,
    tags: path,
  })
  .strict() satisfies z.ZodType<Record<keyof SmithConfigEditFields, string>>;

export const smithConfigEditPreviewSchema = z
  .object({
    version: z.literal(1),
    target: z.enum(["user", "workspace"]),
    file: filePath,
    expectedRevision: smithConfigEditRevisionSchema,
    candidate: z
      .object({
        sha256: hash,
        byteLength: z
          .number()
          .int()
          .positive()
          .max(SMITH_CONFIG_EDIT_LIMITS.sourceBytes),
        created: z.boolean(),
      })
      .strict(),
    review: z
      .object({
        name,
        targetBefore: targetBeforeSchema.nullable(),
        targetAfter: smithSchema,
        effectiveBefore: smithSchema,
        effectiveAfter: smithSchema,
        provenanceBefore: provenanceSchema,
        provenanceAfter: provenanceSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.review.name !== value.review.targetAfter.name ||
      value.review.name !== value.review.effectiveAfter.name
    )
      context.addIssue({ code: "custom", message: "The Smith name changed." });
  })
  .refine((value) =>
    encodedWithin(value, SMITH_CONFIG_EDIT_LIMITS.responseBytes),
  ) satisfies z.ZodType<SmithConfigEditPreview>;

/** Versioned write-family hash; create request bytes/hash semantics stay unchanged. */
export function canonicalSmithConfigEditRequest(value: unknown): string {
  const request = smithConfigEditRequestSchema.parse(value),
    smith = request.smith;
  return JSON.stringify({
    family: "smith-config-edit",
    version: 1,
    requestId: request.requestId,
    target: request.target,
    name: request.name,
    smith: {
      name: smith.name,
      provider: smith.provider,
      model: smith.model,
      effort: smith.effort,
      enabled: smith.enabled,
      tags: smith.tags,
    },
    expectedRevision: {
      version: 1,
      user: request.expectedRevision.user,
      workspace: request.expectedRevision.workspace,
    },
  });
}
