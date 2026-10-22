import { z } from "zod";
import type { KeeperReadQuery, KeeperReadResult } from "../../types/keeper";
import { ConversationError } from "../conversations/error";

if (typeof window !== "undefined") z.config({ jitless: true });

export const KEEPER_READ_SCHEMA = z
  .object({
    kind: z.enum(["beads", "queue", "sessions", "runs", "activity"]),
    id: z.string().trim().min(1).max(200).optional(),
    after: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1)
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export function parseKeeperReadQuery(value: unknown): KeeperReadQuery {
  const parsed = KEEPER_READ_SCHEMA.safeParse(value);
  if (
    !parsed.success ||
    (parsed.data.id !== undefined && (parsed.data.after ?? 0) !== 0)
  )
    throw new ConversationError(
      400,
      "Expected a project read kind, optional object id and bounded cursor/page size.",
    );
  const { kind, id, after, limit } = parsed.data;
  return {
    kind,
    ...(id !== undefined ? { id } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const KEEPER_RESULT_SCHEMA: z.ZodType<KeeperReadResult> = z
  .object({
    scope: z
      .object({
        projectId: z.string().max(100),
        name: z.string().max(120),
        slug: z.string().max(48),
        catalogRevision: count,
        workspace: z.string().max(1024),
        repositories: z.array(z.string().max(1024)).max(32),
        epicIds: z.array(z.string().max(200)).max(64),
        repositoryCount: count,
        epicCount: count,
        detailsComplete: z.boolean(),
        detailsReason: z.string().max(8000).nullable(),
        label: z.string().max(100),
        unavailableWorkspaces: count,
      })
      .strict(),
    kind: z.enum(["beads", "queue", "sessions", "runs", "activity"]),
    mode: z.enum(["index", "detail"]),
    source: z.string().max(200),
    asOf: z.iso.datetime(),
    complete: z.boolean(),
    reason: z.string().max(8000).nullable(),
    records: z
      .array(
        z
          .object({
            id: z.string().max(200),
            data: z.unknown(),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    totalKnown: count.nullable(),
    nextCursor: count.nullable(),
  })
  .strict();
