import { z } from "zod";
import type {
  KeeperBriefContent,
  KeeperBriefSnapshot,
  KeeperBriefs,
} from "../../types/keeper-brief";

if (typeof window !== "undefined") z.config({ jitless: true });
export const MAX_BRIEF_SNAPSHOT_BYTES = 10_000;
const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const briefRefreshSchema = z
  .object({ requestId: z.string().uuid(), expectedRevision: count })
  .strict();
const object = z
  .object({
    kind: z.enum(["bead", "session", "run", "event"]),
    id: z.string().min(1).max(200),
  })
  .strict();
export const briefSnapshotSchema: z.ZodType<KeeperBriefSnapshot> = z
  .object({
    version: z.literal(1),
    projectId: z.string().max(100),
    projectName: z.string().max(120),
    workspace: z.string().max(4096),
    catalogRevision: count,
    asOf: z.iso.datetime(),
    since: z.iso.datetime(),
    scope: z
      .object({
        label: z.string().max(100),
        epicIds: z.array(z.string().max(200)).max(8),
        epicCount: count,
        repositoryCount: count,
      })
      .strict(),
    observed: z
      .object({
        beads: count.nullable(),
        queue: count.nullable(),
        sessions: count.nullable(),
        runs: count.nullable(),
        activity: count.nullable(),
      })
      .strict(),
    complete: z.boolean(),
    limitations: z.array(z.string().max(500)).max(16),
    facts: z
      .array(
        z
          .object({
            section: z.enum(["moving", "waiting", "stuck", "context"]),
            object,
            title: z.string().max(140),
            state: z.string().max(120),
            at: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        MAX_BRIEF_SNAPSHOT_BYTES &&
      Date.parse(value.since) <= Date.parse(value.asOf),
  );
const section = z
  .array(
    z
      .object({
        text: z.string().trim().min(1).max(480),
        facts: z.array(z.number().int().nonnegative().max(39)).min(1).max(6),
      })
      .strict(),
  )
  .max(4);
export const briefContentSchema: z.ZodType<KeeperBriefContent> = z
  .object({
    summary: z.string().trim().min(1).max(800),
    moving: section,
    waiting: section,
    stuck: section,
  })
  .strict();
const brief = z
  .object({
    requestId: z.string().uuid(),
    createdAt: z.iso.datetime(),
    snapshot: briefSnapshotSchema,
    content: briefContentSchema,
  })
  .strict();
export const briefsSchema: z.ZodType<KeeperBriefs> = z
  .object({
    projectId: z.string().max(100),
    revision: count,
    latest: brief.nullable(),
    earlier: z.array(brief).max(10),
    refresh: z
      .object({
        requestId: z.string().uuid(),
        phase: z.enum([
          "accepted",
          "running",
          "cancelling",
          "completed",
          "cancelled",
          "failed",
          "unknown",
        ]),
        problem: z.string().max(1000).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
