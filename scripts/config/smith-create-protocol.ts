import { z } from "zod";
import type { Smith } from "../../types/hearth";
import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateRequest,
  SmithConfigPreview,
  SmithConfigPreviewRequest,
  SmithConfigRevision,
} from "../../types/smith-config-create";
import { validateSmith } from "../hearth/validate";

if (typeof window !== "undefined") z.config({ jitless: true });

/** Fixed producer bounds, never caller-controlled settings. */
export const SMITH_CONFIG_CREATE_LIMITS = Object.freeze({
  requestBytes: 16_000,
  responseBytes: 65_536,
  sourceBytes: 1_048_576,
  privateRecordBytes: 65_536,
  privateLockBytes: 65_536,
  records: 1000,
  pathLength: 1024,
});

const encodedWithin = (value: unknown, max: number) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= max;
  } catch {
    return false;
  }
};
export const smithConfigHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const smithConfigRequestIdSchema = z
  .uuid()
  .refine((id) => id === id.toLowerCase());
export const smithConfigRevisionSchema = z
  .object({
    version: z.literal(1),
    user: smithConfigHashSchema,
    workspace: smithConfigHashSchema,
  })
  .strict() satisfies z.ZodType<SmithConfigRevision>;
export const completeConfigSmithSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .refine((name) => !(name in Object.prototype)),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(512),
    effort: z.string().min(1).max(128),
    enabled: z.boolean(),
    tags: z.array(z.string().max(256)).max(64),
  })
  .strict()
  .refine((value) => validateSmith(value).ok) satisfies z.ZodType<Smith>;
const previewFields = {
  target: z.enum(["user", "workspace"]),
  smith: completeConfigSmithSchema,
};
export const smithConfigPreviewRequestSchema = z
  .object(previewFields)
  .strict()
  .refine((value) =>
    encodedWithin(value, SMITH_CONFIG_CREATE_LIMITS.requestBytes),
  ) satisfies z.ZodType<SmithConfigPreviewRequest>;
export const smithConfigCreateRequestSchema = z
  .object({
    requestId: smithConfigRequestIdSchema,
    ...previewFields,
    expectedRevision: smithConfigRevisionSchema,
  })
  .strict()
  .refine((value) =>
    encodedWithin(value, SMITH_CONFIG_CREATE_LIMITS.requestBytes),
  ) satisfies z.ZodType<SmithConfigCreateRequest>;

const path = z
  .string()
  .min(1)
  .max(SMITH_CONFIG_CREATE_LIMITS.pathLength)
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value),
  );
const provenance = z
  .object({
    provider: path,
    model: path,
    effort: path,
    enabled: path,
    tags: path,
  })
  .strict();
export const smithConfigPreviewSchema = z
  .object({
    version: z.literal(1),
    target: z.enum(["user", "workspace"]),
    file: path,
    expectedRevision: smithConfigRevisionSchema,
    candidate: z
      .object({
        sha256: smithConfigHashSchema,
        byteLength: z
          .number()
          .int()
          .positive()
          .max(SMITH_CONFIG_CREATE_LIMITS.sourceBytes),
        created: z.boolean(),
      })
      .strict(),
    review: z
      .object({
        before: z.null(),
        after: completeConfigSmithSchema,
        provenance,
      })
      .strict(),
  })
  .strict()
  .refine((value) =>
    Object.values(value.review.provenance).every(
      (source) => source === value.file,
    ),
  )
  .refine((value) =>
    encodedWithin(value, SMITH_CONFIG_CREATE_LIMITS.responseBytes),
  ) satisfies z.ZodType<SmithConfigPreview>;

const nullablePreview = smithConfigPreviewSchema.nullable();
const result = z.discriminatedUnion("phase", [
  z
    .object({
      phase: z.literal("held"),
      stage: z.enum(["intent", "prepared", "attempted", "unconfirmed"]),
      preview: nullablePreview,
    })
    .strict(),
  z
    .object({
      phase: z.literal("confirmed"),
      completedAt: z.iso.datetime(),
      preview: smithConfigPreviewSchema,
      publication: z
        .object({
          file: path,
          created: z.boolean(),
          sha256: smithConfigHashSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("refused"),
      refusedAt: z.iso.datetime(),
      reason: z.enum([
        "stale-revision",
        "invalid-candidate",
        "source-unavailable",
        "cancelled-before-attempt",
        "write-refused-before-attempt",
      ]),
      preview: nullablePreview,
    })
    .strict(),
]);
export const smithConfigCreateReceiptSchema = z
  .object({
    version: z.literal(1),
    requestId: smithConfigRequestIdSchema,
    ownerScopeHash: smithConfigHashSchema,
    inputHash: smithConfigHashSchema,
    createdAt: z.iso.datetime(),
    original: smithConfigCreateRequestSchema,
    result,
  })
  .strict()
  .superRefine((value, context) => {
    const refuse = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (value.requestId !== value.original.requestId)
      refuse("The original belongs to another request.");
    const { result, original } = value;
    if (result.phase === "held") {
      if (result.stage === "intent" && result.preview !== null)
        refuse("An intent cannot claim prepared review evidence.");
      if (
        (result.stage === "prepared" || result.stage === "attempted") &&
        result.preview === null
      )
        refuse("The saved stage requires its prepared review evidence.");
    }
    const preview = result.preview;
    if (
      preview !== null &&
      (preview.target !== original.target ||
        preview.expectedRevision.user !== original.expectedRevision.user ||
        preview.expectedRevision.workspace !==
          original.expectedRevision.workspace ||
        !sameSmith(preview.review.after, original.smith))
    )
      refuse("The review differs from the exact original.");
    if (
      result.phase === "confirmed" &&
      (result.publication.file !== result.preview.file ||
        result.publication.sha256 !== result.preview.candidate.sha256 ||
        result.publication.created !== result.preview.candidate.created)
    )
      refuse("The publication differs from its reviewed candidate.");
  })
  .refine((value) =>
    encodedWithin(value, SMITH_CONFIG_CREATE_LIMITS.responseBytes),
  ) satisfies z.ZodType<SmithConfigCreateReceipt>;

function sameSmith(a: Smith, b: Smith): boolean {
  return (
    a.name === b.name &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.enabled === b.enabled &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}

/** Only this new domain input is canonicalized; existing provider launch hashes are untouched. */
export function canonicalSmithConfigCreateRequest(value: unknown): string {
  const request = smithConfigCreateRequestSchema.parse(value),
    smith = request.smith;
  return JSON.stringify({
    version: 1,
    requestId: request.requestId,
    target: request.target,
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
