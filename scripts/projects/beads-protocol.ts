import { z } from "zod";
import { QUEUE_STATES } from "../../types/hearth";
import type { ProjectBeadsPage } from "../../types/project-beads";

if (typeof window !== "undefined") z.config({ jitless: true });
const label = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
export const projectBeadSchema = z
  .object({
    id: label.max(200),
    title: label,
    type: z.enum(["epic", "feature", "task", "bug", "chore"]),
    status: label.max(80),
    priority: z
      .union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
      ])
      .nullable(),
    parent: label.max(200).nullable(),
    assignee: label.nullable(),
    owner: label.nullable(),
    labels: z.array(label).max(100),
    createdAt: z.string().max(100),
    updatedAt: z.string().max(100),
    due: z.string().max(100).nullable(),
    description: z.string().max(65_536),
    acceptanceCriteria: z.string().max(32_768),
    estimate: z.number().finite().nonnegative().nullable(),
    spent: z.number().finite().nonnegative().nullable(),
    ready: z.boolean(),
    blocked: z.boolean(),
    blockers: z.array(label.max(200)).max(500),
    unavailableBlockers: z.number().int().min(0).max(10_000),
    queue: z.enum(QUEUE_STATES).nullable(),
    smith: label.nullable(),
    comments: z
      .array(
        z
          .object({
            body: z.string().max(16_384),
            author: z.string().max(1024),
            createdAt: z.string().max(100),
          })
          .strict(),
      )
      .max(100),
    commentsComplete: z.boolean(),
    detailsLoaded: z.boolean(),
    fileMap: z.array(label).max(500).nullable().default(null),
    fileMapReason: z.string().max(2048).nullable().default(null),
    reservations: z
      .array(
        z
          .object({
            worktree: label,
            globs: z.array(label).max(500),
            acquiredAt: z.string().max(100),
            sessionId: label.nullable(),
          })
          .strict(),
      )
      .max(100)
      .nullable()
      .default(null),
    activity: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            kind: label.max(100),
            ts: z.string().max(100),
            sessionId: label.nullable(),
          })
          .strict(),
      )
      .max(100)
      .nullable()
      .default(null),
    activityComplete: z.boolean().default(false),
  })
  .strict();
export const projectBeadsPageSchema: z.ZodType<ProjectBeadsPage> = z
  .object({
    projectId: label.max(100),
    workspace: label,
    asOf: z.string().max(100),
    complete: z.boolean(),
    problems: z.array(z.string().max(2048)).max(100),
    beads: z.array(projectBeadSchema).max(1000),
    dependencies: z
      .array(
        z
          .object({
            from: label.max(200),
            to: label.max(200),
            type: z.enum(["blocks", "requires", "relates"]),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.beads.map((bead) => bead.id));
    if (
      ids.size !== value.beads.length ||
      value.dependencies.some(
        (edge) => !ids.has(edge.from) || !ids.has(edge.to),
      ) ||
      value.beads.some(
        (bead) =>
          (bead.parent !== null && !ids.has(bead.parent)) ||
          (bead.status === "closed" && bead.blocked) ||
          bead.blockers.some((id) => !ids.has(id)) ||
          (bead.ready &&
            (bead.status !== "open" || bead.assignee !== null || bead.blocked)),
      )
    )
      context.addIssue({
        code: "custom",
        message: "The scoped bead graph or Ready state is inconsistent.",
      });
  });
