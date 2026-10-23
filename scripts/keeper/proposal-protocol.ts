import { z } from "zod";
import type {
  KeeperProposalDraft,
  KeeperProposalMessage,
} from "../../types/keeper-proposal";

if (typeof window !== "undefined") z.config({ jitless: true });
export const MAX_KEEPER_PROPOSAL_BYTES = 24_000;
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const name = z.string().trim().min(1).max(80);
const text = (max: number) => z.string().trim().min(1).max(max);
const action = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("approve-beads"),
      beadIds: z
        .array(id)
        .min(1)
        .max(16)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict(),
  z
    .object({
      kind: z.literal("start-session"),
      provider: z.enum(["claude", "codex", "gemini", "grok"]),
      smith: name,
      beadId: id,
      repository: text(4096).refine((value) => !/[\0\r\n]/.test(value)),
      worktree: z.enum(["current", "new"]),
      prompt: text(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("start-shift"),
      durationMinutes: z.number().int().min(1).max(1440),
      concurrency: z.number().int().min(1).max(8),
      beadLimit: z.number().int().min(1).max(100),
      spendLimitUsd: z.number().positive().max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("send-to-council"),
      beadId: id,
      profile: name,
      question: text(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create-beads"),
      beads: z
        .array(
          z
            .object({
              title: text(200),
              type: z.enum(["task", "feature", "bug", "chore", "epic"]),
              priority: z.union([
                z.literal(0),
                z.literal(1),
                z.literal(2),
                z.literal(3),
                z.literal(4),
              ]),
              parentId: id,
              description: text(6000),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal("manage-bead"),
      beadId: id,
      operation: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("pause") }).strict(),
        z.object({ kind: z.literal("resume") }).strict(),
        z.object({ kind: z.literal("reassign"), smith: name }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("record-decision"),
      beadId: id,
      decision: text(3000),
    })
    .strict(),
]);
export const keeperProposalDraftSchema: z.ZodType<KeeperProposalDraft> = z
  .object({ title: text(120), detail: text(1000), action })
  .strict();
export const keeperProposalMessageSchema: z.ZodType<KeeperProposalMessage> = z
  .object({
    kind: z.literal("keeper.proposals.v1"),
    message: text(4000),
    proposals: z.array(keeperProposalDraftSchema).min(1).max(7),
  })
  .strict();

/** Whole structured messages only; quoted examples and partial streams are never actionable. */
export function parseKeeperProposalMessage(
  text: string,
): KeeperProposalMessage | null {
  if (new TextEncoder().encode(text).byteLength > MAX_KEEPER_PROPOSAL_BYTES)
    return null;
  let raw: unknown;
  try {
    raw = JSON.parse(
      text.trim().replace(/^```json\s*\n([\s\S]*)\n```$/i, "$1"),
    );
  } catch {
    return null;
  }
  const parsed = keeperProposalMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
