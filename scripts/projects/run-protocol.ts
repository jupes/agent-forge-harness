import { z } from "zod";
import type {
  ProjectRunDetail,
  ProjectRunArtifact,
  ProjectRunRow,
  ProjectRunsPage,
} from "../../types/project-runs";
import { artifactPath, FORGE_PHASES } from "../forge/phases";
import { comparableCheckout, isValidSlug } from "../forge/runs";
import { sessionProjectIdSchema } from "../sessions/identity-protocol";

if (typeof window !== "undefined") z.config({ jitless: true });

export const MAX_PROJECT_RUN_BYTES = 512 * 1024;
export const MAX_PROJECT_RUN_ARTIFACT_BYTES = 512 * 1024;
export const MAX_PROJECT_RUN_ARTIFACT_RESPONSE_BYTES = 4 * 1024 * 1024;
const text = z
  .string()
  .max(2048)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const slug = text.refine(isValidSlug);
const phase = z.enum(FORGE_PHASES);
const verdict = z.enum(["PASS", "FAIL", "UNREADABLE"]);
const phaseRow = z
  .object({
    id: phase,
    state: z.enum(["complete", "active", "locked"]),
    artifact: text.max(1024).nullable(),
    artifactMissing: z.boolean(),
  })
  .strict();
const status = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("halted"), phase, reason: text }).strict(),
  z.object({ kind: z.literal("revising"), phase }).strict(),
  z.object({ kind: z.literal("awaiting-review"), phase }).strict(),
  z.object({ kind: z.literal("shipped") }).strict(),
  z.object({ kind: z.literal("phase"), phase }).strict(),
]);
export const projectRunRowSchema: z.ZodType<ProjectRunRow> = z
  .object({
    slug,
    feature: text.nullable(),
    epic: text.max(256).min(1),
    mode: z.enum(["gated", "auto"]),
    health: z.enum(["shipped", "attention", "running"]),
    phases: z.array(phaseRow).length(4),
    status,
    completedCount: z.number().int().min(0).max(4),
    totalPhases: z.literal(4),
    gatePassed: z.boolean().nullable(),
    reviewRounds: z.number().int().min(0).max(256),
    latestVerdict: verdict.nullable(),
    updatedAt: z.iso.datetime().nullable(),
    complete: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.phases.every((row, index) => row.id === FORGE_PHASES[index]) &&
      value.completedCount ===
        value.phases.filter((row) => row.state === "complete").length,
  );

const source = {
  version: z.literal(1),
  projectId: sessionProjectIdSchema,
  workspace: text.max(1024).min(1),
  checkout: text.max(1024).min(1),
  asOf: z.iso.datetime(),
  coverage: z.literal("served-checkout-only"),
  problems: z.array(text).max(30),
};
const bounded = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <=
  MAX_PROJECT_RUN_BYTES;
export const projectRunsPageSchema: z.ZodType<ProjectRunsPage> = z
  .object({
    ...source,
    runs: z.array(projectRunRowSchema).max(128),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.runs.map((row) => row.slug)).size === value.runs.length,
  )
  .refine(bounded, "Run metadata exceeds its bounded response size.");

const findings = z
  .object({
    blocker: z.number().int().min(0).max(1_000_000),
    high: z.number().int().min(0).max(1_000_000),
    medium: z.number().int().min(0).max(1_000_000),
    low: z.number().int().min(0).max(1_000_000),
  })
  .strict();
const gate = z
  .object({
    event: text.max(200),
    timestamp: z.iso.datetime(),
    passed: z.boolean(),
    checks: z
      .array(
        z
          .object({
            name: text.max(200).min(1),
            passed: z.boolean(),
            skipped: z.boolean(),
            detail: text.max(200).nullable(),
          })
          .strict(),
      )
      .max(64),
    checkout: text.max(1024).nullable(),
    branch: text.max(200).nullable(),
    link: z.enum(["linked", "unlinked", "legacy"]),
    beadsIssueId: text.max(256).nullable(),
    executionRunId: slug.nullable(),
    forgeSlug: slug.nullable(),
    evaluatorEvidence: z.enum(["schema-2", "legacy"]).nullable(),
  })
  .strict();
export const projectRunDetailSchema: z.ZodType<ProjectRunDetail> = z
  .object({
    ...source,
    run: projectRunRowSchema,
    reviews: z
      .array(
        z
          .object({
            phase,
            round: z.number().int().positive().max(256),
            verdict,
            findings,
            summary: z.string().max(2048).nullable(),
            at: z.iso.datetime(),
          })
          .strict(),
      )
      .max(256),
    gateHistory: z.array(gate).max(11),
    gateHistoryDays: z.literal(30),
    earlierGateLimit: z.literal(10),
  })
  .strict()
  .refine(
    (value) =>
      value.reviews.length === value.run.reviewRounds &&
      (value.reviews.at(-1)?.verdict ?? null) === value.run.latestVerdict &&
      value.gateHistory.every(
        (item) =>
          item.checkout !== null &&
          comparableCheckout(item.checkout) ===
            comparableCheckout(value.checkout) &&
          (item.link === "linked"
            ? item.executionRunId === value.run.slug &&
              item.beadsIssueId !== null
            : item.link === "legacy" && item.forgeSlug === value.run.slug),
      ),
  )
  .refine(bounded, "Run metadata exceeds its bounded response size.");

export const projectRunArtifactSchema: z.ZodType<ProjectRunArtifact> = z
  .object({
    ...source,
    slug,
    kind: z.enum(["research", "plan", "ship"]),
    artifact: text.max(1024),
    bytes: z.number().int().min(1).max(MAX_PROJECT_RUN_ARTIFACT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().min(1).max(MAX_PROJECT_RUN_ARTIFACT_BYTES),
  })
  .strict()
  .refine((value) => {
    const expected = artifactPath(value.kind, value.slug);
    return (
      value.artifact === expected &&
      new TextEncoder().encode(value.content).byteLength === value.bytes &&
      !value.content.includes("\u0000") &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        MAX_PROJECT_RUN_ARTIFACT_RESPONSE_BYTES
    );
  }, "Run artifact is incomplete or exceeds its bounded response size.");
