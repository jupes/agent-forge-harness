import { z } from "zod";
import type { LoadedConfig } from "../../../scripts/config/load";
import {
  PROVIDER_USAGE_COUNTS,
  type Scoreboard,
  type ScoreboardRow,
  type SmithsView,
} from "../../../types/hearth";

if (typeof window !== "undefined") z.config({ jitless: true });

export const MAX_SMITHS_READ_BYTES = 2 * 1024 * 1024;
const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const path = text.refine((value) => /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value));
const name = text.max(256).refine((value) => !(value in Object.prototype));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
const smith = z
  .object({
    name,
    provider: text.max(256),
    model: text,
    effort: text,
    enabled: z.boolean(),
    tags: z
      .array(
        z
          .string()
          .max(512)
          .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value)),
      )
      .max(64),
  })
  .strict();
const entry = z
  .object({ smith: name, weight: z.number().finite().positive() })
  .strict();
const bench = z
  .array(entry)
  .min(1)
  .max(512)
  .refine((rows) =>
    Number.isFinite(rows.reduce((sum, row) => sum + row.weight, 0)),
  );
const benches = z.object({ low: bench, medium: bench, high: bench }).strict();
const smiths = z
  .record(name, smith)
  .refine(
    (rows) =>
      Object.keys(rows).length <= 512 &&
      Object.entries(rows).every(([key, value]) => key === value.name),
  );
const scalar = z.union([text, z.string().length(0), z.boolean(), amount]);
const provenance = z
  .object({
    value: z.union([scalar, z.array(scalar).max(512), z.array(entry).max(512)]),
    source: text,
  })
  .strict();

export const savedSmithConfigSchema: z.ZodType<LoadedConfig> = z
  .object({
    config: z
      .object({
        workflow: z.object({ defaultCrew: name }).strict(),
        smiths,
        benches,
        execution: z
          .object({ envPass: z.array(text.max(256)).max(512) })
          .strict(),
        shift: z
          .object({
            concurrency: count,
            forMs: count,
            maxBeads: count,
            maxUsd: amount,
            repairs: count,
            throttle: amount,
          })
          .strict(),
      })
      .strict(),
    provenance: z
      .record(text, provenance)
      .refine((rows) => Object.keys(rows).length <= 8192),
    files: z.array(path).max(64),
  })
  .strict()
  .superRefine((loaded, ctx) => {
    const issue = () =>
      ctx.addIssue({
        code: "custom",
        message: "Saved configuration and its provenance do not agree.",
      });
    const known = (value: string) => Object.hasOwn(loaded.config.smiths, value);
    if (!known(loaded.config.workflow.defaultCrew)) issue();
    for (const rows of Object.values(loaded.config.benches))
      for (const row of rows) if (!known(row.smith)) issue();
    for (const [key, row] of Object.entries(loaded.provenance)) {
      if (row.source !== "builtin" && !loaded.files.includes(row.source))
        issue();
      if (
        key === "workflow.default_crew" &&
        row.value !== loaded.config.workflow.defaultCrew
      )
        issue();
    }
    for (const [id, row] of Object.entries(loaded.config.smiths)) {
      for (const field of [
        "provider",
        "model",
        "effort",
        "enabled",
        "tags",
      ] as const) {
        const report = loaded.provenance[`smiths.${id}.${field}`];
        if (
          report &&
          JSON.stringify(report.value) !== JSON.stringify(row[field])
        )
          issue();
      }
    }
    for (const key of ["low", "medium", "high"] as const) {
      const report = loaded.provenance[`benches.${key}`];
      const rows = loaded.config.benches[key];
      if (
        report &&
        JSON.stringify(report.value) !== JSON.stringify(rows) &&
        JSON.stringify(report.value) !==
          JSON.stringify(rows.map((row) => `${row.smith}:${row.weight}`))
      )
        issue();
    }
  });

export const smithsViewSchema: z.ZodType<SmithsView> = z
  .object({
    smiths: z
      .array(smith)
      .max(512)
      .refine(
        (rows) => new Set(rows.map((row) => row.name)).size === rows.length,
      ),
    benches,
    defaultSmith: name,
  })
  .strict();

const findings = z
  .object({ blocker: count, high: count, medium: count, low: count })
  .strict();
const tokens = z
  .partialRecord(z.enum(PROVIDER_USAGE_COUNTS), count)
  .transform((value) => {
    const result: ScoreboardRow["usage"]["tokens"] = {};
    for (const key of PROVIDER_USAGE_COUNTS)
      if (value[key] !== undefined) result[key] = value[key];
    return result;
  });
const scoreboardRow = z
  .object({
    executor: z
      .object({ provider: text.max(256), model: text, smith: name.optional() })
      .strict()
      .transform((value) => ({
        provider: value.provider,
        model: value.model,
        ...(value.smith === undefined ? {} : { smith: value.smith }),
      }))
      .nullable(),
    runs: count,
    sessions: z
      .object({
        started: count,
        ended: count,
        completed: count,
        failed: count,
        timedOut: count,
        stopped: count,
        other: count,
      })
      .strict(),
    gates: z
      .object({
        ran: count,
        passed: count,
        failed: count,
        passRate: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    verdicts: z
      .object({ pass: count, fail: count, unreadable: count })
      .strict(),
    reviews: z
      .object({
        rounds: count,
        pass: count,
        fail: count,
        unreadable: count,
        findings,
      })
      .strict(),
    council: z
      .object({
        started: count,
        finished: count,
        pass: count,
        fail: count,
        unreadable: count,
        cancelled: count,
        costUsd: amount.nullable(),
        runsWithCost: count,
        findings: findings.nullable(),
        runsWithFindings: count,
      })
      .strict(),
    usage: z
      .object({
        sessions: count,
        costUsd: amount.nullable(),
        sessionsWithCost: count,
        tokens,
      })
      .strict(),
  })
  .strict();
export const recordedScoreboardSchema: z.ZodType<Scoreboard> = z
  .object({
    rows: z.array(scoreboardRow).max(4096),
    events: count,
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (board) =>
      new Set(board.rows.map((row) => JSON.stringify(row.executor))).size ===
        board.rows.length &&
      (board.from === null) === (board.to === null) &&
      (!board.from ||
        !board.to ||
        Date.parse(board.from) <= Date.parse(board.to)),
  );

export function boundedSmithsValue(value: unknown): unknown {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw Error("The Smiths read could not be verified.");
  }
  if (
    !encoded ||
    new TextEncoder().encode(encoded).length > MAX_SMITHS_READ_BYTES
  )
    throw Error(
      "The Smiths read exceeds its 2 MiB limit. Earlier verified values are kept.",
    );
  return value;
}
