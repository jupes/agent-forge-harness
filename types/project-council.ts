import { z } from "zod";
import type {
  ContextPack,
  CouncilProfile,
} from "../scripts/council/types";

export const PROJECT_COUNCIL_MAX_SELECTOR_BYTES = 262_144;
export const PROJECT_COUNCIL_MAX_PREPARED_BYTES = 1_048_576;
export const PROJECT_COUNCIL_MAX_ORIGINAL_BYTES = 2_097_152;
export const PROJECT_COUNCIL_MAX_JOURNAL_BYTES = 33_554_432;
export const PROJECT_COUNCIL_MAX_ORIGINALS = 1000;

export const projectCouncilRequestIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const textSchema = z.string().min(1).max(1024);

export const projectCouncilSourceChoiceSchema = z
  .object({
    sourceType: z.enum(["text", "bead", "file", "plan", "pr"]),
    source: z.string().min(1).max(PROJECT_COUNCIL_MAX_SELECTOR_BYTES),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = new TextEncoder().encode(value.source).byteLength;
    if (
      (value.sourceType === "text" && bytes > PROJECT_COUNCIL_MAX_SELECTOR_BYTES) ||
      (value.sourceType !== "text" && bytes > 4096)
    )
      context.addIssue({ code: "custom", message: "source selector is too long" });
  });

export const projectCouncilReserveRequestSchema = z
  .object({
    sourceChoice: projectCouncilSourceChoiceSchema,
    profileChoice: z.string().min(1).max(4096),
    maxUsd: z.number().finite().nonnegative().max(1_000_000),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(PROJECT_COUNCIL_MAX_PREPARED_BYTES),
    redactSecrets: z.boolean(),
  })
  .strict();

const sourceMetadataSchema = z
  .record(
    z.string().max(128),
    z.union([
      z.string().max(4096),
      z.number().finite(),
      z.boolean(),
      z.array(z.string().max(4096)).max(128),
    ]),
  )
  .superRefine((value, context) => {
    if (Object.keys(value).length > 128)
      context.addIssue({ code: "custom", message: "source metadata is too large" });
  });
const contextSourceSchema = z
  .object({
    kind: z.enum(["file", "plan", "pr", "stdin", "bead"]),
    displayName: textSchema.max(4096),
    locator: textSchema.max(4096),
    metadata: sourceMetadataSchema.optional(),
  })
  .strict();
const contextPackSchema: z.ZodType<ContextPack> = z
  .object({
    schemaVersion: z.literal(1),
    source: contextSourceSchema,
    createdAt: z.iso.datetime(),
    contentHash: digestSchema,
    byteLength: z.number().int().nonnegative().max(PROJECT_COUNCIL_MAX_PREPARED_BYTES),
    truncated: z.boolean(),
    redactions: z
      .array(
        z
          .object({ kind: textSchema.max(128), count: z.number().int().nonnegative() })
          .strict(),
      )
      .max(128),
    evidence: z
      .array(
        z
          .object({
            id: textSchema.max(128),
            title: textSchema.max(4096),
            content: z.string().max(PROJECT_COUNCIL_MAX_PREPARED_BYTES),
            contentHash: digestSchema,
            byteLength: z.number().int().nonnegative().max(PROJECT_COUNCIL_MAX_PREPARED_BYTES),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .max(512),
  })
  .strict()
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= PROJECT_COUNCIL_MAX_ORIGINAL_BYTES);

export const projectCouncilBindingSchema = z
  .object({
    projectId: z
      .string()
      .regex(/^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    workspace: textSchema,
    catalogRevision: z.number().int().nonnegative(),
    scopeHash: digestSchema,
    profileHash: digestSchema,
  })
  .strict();

export const projectCouncilStateSchema = z.enum([
  "reserved",
  "dispatch-claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "retired",
]);

export type ProjectCouncilOptions = {
  maxUsd: number;
  maxBytes: number;
  redactSecrets: boolean;
};
export type ProjectCouncilBinding = z.infer<typeof projectCouncilBindingSchema>;
export type ProjectCouncilReserveRequest = z.infer<
  typeof projectCouncilReserveRequestSchema
>;
export type ProjectCouncilState = z.infer<typeof projectCouncilStateSchema>;

export interface ProjectCouncilOriginal {
  requestId: string;
  runId: string;
  inputHash: string;
  intentHash: string;
  binding: ProjectCouncilBinding;
  profileChoice: string;
  profile: CouncilProfile;
  context: ContextPack;
  listing: string[];
  options: ProjectCouncilOptions;
  state: ProjectCouncilState;
  createdAt: string;
  updatedAt: string;
  dispatchClaimedAt: string | null;
}

export interface ProjectCouncilAuthority {
  projectId: string;
  workspace: string;
  workspaceRoot: string;
  catalogRevision: number;
  scopeHash: string;
}
export type ProjectCouncilSourceRef = {
  sourceType: ProjectCouncilReserveRequest["sourceChoice"]["sourceType"];
  source: string;
};
export type ProjectCouncilAuthorityResolver = (
  projectId: string,
  source: ProjectCouncilSourceRef,
) => Promise<ProjectCouncilAuthority>;

export interface ProjectCouncilMetadata {
  requestId: string;
  runId: string;
  intentHash: string;
  projectId: string;
  state: ProjectCouncilState;
  sourceType: ProjectCouncilReserveRequest["sourceChoice"]["sourceType"];
  sourceName: string;
  listing: string[];
  byteLength: number;
  truncated: boolean;
  redactions: ContextPack["redactions"];
  profileId: string;
  profileTitle: string;
  maxUsd: number;
  maxBytes: number;
  redactSecrets: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCouncilOriginalRead {
  metadata: ProjectCouncilMetadata;
  context: ContextPack;
  profile: CouncilProfile;
  options: ProjectCouncilOptions;
}

export interface ProjectCouncilReceipt {
  metadata: ProjectCouncilMetadata;
  phase: "reserved" | "unknown" | "running" | "completed" | "failed" | "cancelled" | "retired";
  error?: string;
}

export const projectCouncilOriginalSchema: z.ZodType<ProjectCouncilOriginal> =
  z
    .object({
      requestId: projectCouncilRequestIdSchema,
      runId: z.string().min(1).max(120),
      inputHash: digestSchema,
      intentHash: digestSchema,
      binding: projectCouncilBindingSchema,
      profileChoice: z.string().min(1).max(4096),
      profile: z.custom<CouncilProfile>((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          return false;
        return Object.keys(value).length <= 64;
      }),
      context: contextPackSchema,
      listing: z.array(textSchema.max(4096)).max(512),
      options: z
        .object({
          maxUsd: z.number().finite().nonnegative().max(1_000_000),
          maxBytes: z.number().int().min(1).max(PROJECT_COUNCIL_MAX_PREPARED_BYTES),
          redactSecrets: z.boolean(),
        })
        .strict(),
      state: projectCouncilStateSchema,
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      dispatchClaimedAt: z.iso.datetime().nullable(),
    })
    .strict()
    .refine((value) =>
      ["dispatch-claimed", "running", "completed", "failed", "cancelled"].includes(
        value.state,
      )
        ? value.dispatchClaimedAt !== null
        : value.dispatchClaimedAt === null,
    );

export const projectCouncilMetadataSchema: z.ZodType<ProjectCouncilMetadata> =
  z
    .object({
      requestId: projectCouncilRequestIdSchema,
      runId: z.string().min(1).max(120),
      intentHash: digestSchema,
      projectId: projectCouncilBindingSchema.shape.projectId,
      state: projectCouncilStateSchema,
      sourceType: z.enum(["text", "bead", "file", "plan", "pr"]),
      sourceName: textSchema.max(4096),
      listing: z.array(textSchema.max(4096)).max(512),
      byteLength: z.number().int().nonnegative().max(PROJECT_COUNCIL_MAX_PREPARED_BYTES),
      truncated: z.boolean(),
      redactions: z.array(z.object({ kind: textSchema.max(128), count: z.number().int().nonnegative() }).strict()).max(128),
      profileId: textSchema.max(128),
      profileTitle: textSchema.max(4096),
      maxUsd: z.number().finite().nonnegative().max(1_000_000),
      maxBytes: z.number().int().min(1).max(PROJECT_COUNCIL_MAX_PREPARED_BYTES),
      redactSecrets: z.boolean(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .strict();

export function projectCouncilMetadata(
  original: ProjectCouncilOriginal,
): ProjectCouncilMetadata {
  return projectCouncilMetadataSchema.parse({
    requestId: original.requestId,
    runId: original.runId,
    intentHash: original.intentHash,
    projectId: original.binding.projectId,
    state: original.state,
    sourceType: original.context.source.kind === "stdin" ? "text" : original.context.source.kind,
    sourceName: original.context.source.displayName,
    listing: [...original.listing],
    byteLength: original.context.byteLength,
    truncated: original.context.truncated,
    redactions: original.context.redactions.map((item) => ({ ...item })),
    profileId: original.profile.id,
    profileTitle: original.profile.title,
    maxUsd: original.options.maxUsd,
    maxBytes: original.options.maxBytes,
    redactSecrets: original.options.redactSecrets,
    createdAt: original.createdAt,
    updatedAt: original.updatedAt,
  });
}
