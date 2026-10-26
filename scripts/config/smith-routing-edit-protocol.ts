import { z } from "zod";
import { BENCH_NAMES } from "../../types/hearth";
import type {
  SmithRoutingEditChange,
  SmithRoutingEditPreview,
  SmithRoutingEditPreviewRequest,
  SmithRoutingEditRequest,
  SmithRoutingEditReview,
  SmithRoutingEditRevision,
} from "../../types/smith-routing-edit";

export const SMITH_ROUTING_EDIT_LIMITS = Object.freeze({
  requestBytes: 16_000,
  responseBytes: 65_536,
  sourceBytes: 1_048_576,
  pathLength: 1024,
  privateRecordBytes: 65_536,
  records: 1_000,
});

function encodedWithin(value: unknown, max: number): boolean {
  try {
    const encoded = JSON.stringify(value);
    return (
      encoded !== undefined &&
      new TextEncoder().encode(encoded).byteLength <= max
    );
  } catch {
    return false;
  }
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestId = z.uuid().refine((value) => value === value.toLowerCase());
const smithName = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !(value in Object.prototype));
const benchEntry = z
  .object({ smith: smithName, weight: z.number().finite().positive() })
  .strict();
// Every valid serialized row needs at least 24 bytes. This bound is derived
// from the 16 KiB request transport, not from the unrestricted config loader.
const maxBenchEntriesPerRequest = Math.floor(
  SMITH_ROUTING_EDIT_LIMITS.requestBytes / 24,
);
const benchEntries = z.array(benchEntry).min(1).max(maxBenchEntriesPerRequest);
const benchName = z.enum(BENCH_NAMES);
const change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default"), smith: smithName }).strict(),
  z
    .object({
      kind: z.literal("bench"),
      bench: benchName,
      entries: benchEntries,
    })
    .strict(),
]);
const target = z.enum(["user", "workspace"]);
const revision: z.ZodType<SmithRoutingEditRevision> = z
  .object({ version: z.literal(1), user: hash, workspace: hash })
  .strict();

export const smithRoutingEditPreviewRequestSchema: z.ZodType<SmithRoutingEditPreviewRequest> =
  z
    .object({ target, change })
    .strict()
    .refine((value) =>
      encodedWithin(value, SMITH_ROUTING_EDIT_LIMITS.requestBytes),
    );

export const smithRoutingEditRequestSchema: z.ZodType<SmithRoutingEditRequest> =
  z
    .object({ requestId, target, change, expectedRevision: revision })
    .strict()
    .refine((value) =>
      encodedWithin(value, SMITH_ROUTING_EDIT_LIMITS.requestBytes),
    );

const value = z.union([smithName, benchEntries]);
export const smithRoutingEditReviewSchema = z
  .object({
    change,
    targetBefore: value.nullable(),
    targetAfter: value,
    effectiveBefore: value,
    effectiveAfter: value,
    provenanceBefore: z
      .string()
      .min(1)
      .max(SMITH_ROUTING_EDIT_LIMITS.pathLength),
    provenanceAfter: z
      .string()
      .min(1)
      .max(SMITH_ROUTING_EDIT_LIMITS.pathLength),
  })
  .strict()
  .superRefine((review, context) => {
    const isBench = review.change.kind === "bench";
    const shapeMatches = (
      candidate: string | { smith: string; weight: number }[] | null,
    ) =>
      candidate === null ||
      (isBench ? Array.isArray(candidate) : typeof candidate === "string");
    if (
      !shapeMatches(review.targetBefore) ||
      !shapeMatches(review.targetAfter) ||
      !shapeMatches(review.effectiveBefore) ||
      !shapeMatches(review.effectiveAfter)
    )
      context.addIssue({
        code: "custom",
        message: "Routing edit value changed shape.",
      });
    const expected =
      review.change.kind === "bench"
        ? review.change.entries
        : review.change.smith;
    if (
      JSON.stringify(review.targetAfter) !== JSON.stringify(expected) ||
      JSON.stringify(review.effectiveAfter) !== JSON.stringify(expected)
    )
      context.addIssue({
        code: "custom",
        message: "Effective routing value differs from the reviewed change.",
      });
  })
  .refine(
    (review) => encodedWithin(review, SMITH_ROUTING_EDIT_LIMITS.responseBytes),
    { message: "The routing edit review exceeds its response limit." },
  );

const filePath = z
  .string()
  .min(1)
  .max(SMITH_ROUTING_EDIT_LIMITS.pathLength)
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value),
  );

export const smithRoutingEditPreviewSchema: z.ZodType<SmithRoutingEditPreview> =
  z
    .object({
      version: z.literal(1),
      target,
      file: filePath,
      expectedRevision: revision,
      candidate: z
        .object({
          sha256: hash,
          byteLength: z
            .number()
            .int()
            .positive()
            .max(SMITH_ROUTING_EDIT_LIMITS.sourceBytes),
          created: z.boolean(),
        })
        .strict(),
      review: smithRoutingEditReviewSchema,
    })
    .strict()
    .refine((preview) =>
      encodedWithin(preview, SMITH_ROUTING_EDIT_LIMITS.responseBytes),
    );

/** Stable versioned original bytes; list order and duplicate bench rows are significant. */
export function canonicalSmithRoutingEditRequest(raw: unknown): string {
  const request = smithRoutingEditRequestSchema.parse(raw),
    normalizedChange: SmithRoutingEditChange =
      request.change.kind === "default"
        ? { kind: "default", smith: request.change.smith }
        : {
            kind: "bench",
            bench: request.change.bench,
            entries: request.change.entries.map((entry) => ({
              smith: entry.smith,
              weight: entry.weight,
            })),
          };
  return JSON.stringify({
    family: "smith-routing-edit",
    version: 1,
    requestId: request.requestId,
    target: request.target,
    change: normalizedChange,
    expectedRevision: {
      version: 1,
      user: request.expectedRevision.user,
      workspace: request.expectedRevision.workspace,
    },
  });
}
