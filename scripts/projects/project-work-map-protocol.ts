import { z } from "zod";
import { QUEUE_STATES } from "../../types/hearth";
import {
  type ProjectWorkMap,
  WORK_MAP_STATES,
} from "../../types/project-work-map";
import { BEADS_ISSUE_ID } from "../run-correlation";

if (typeof window !== "undefined") z.config({ jitless: true });

export const MAX_PROJECT_WORK_MAP_BYTES = 16 * 1024 * 1024;
// Each membership or epic carries a catalog UUID and consumes at least 64 bytes.
export const MAX_WORK_MAP_MEMBERSHIPS = Math.floor(
  MAX_PROJECT_WORK_MAP_BYTES / 64,
);

const beadId = z.string().regex(BEADS_ISSUE_ID);
const projectId = z.string().min(1).max(100);
const label = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));

export const projectWorkMapSchema: z.ZodType<ProjectWorkMap> = z
  .object({
    asOf: z.iso.datetime({ offset: true }),
    trackerAvailable: z.boolean(),
    sessionsComplete: z.boolean(),
    projects: z
      .array(
        z
          .object({
            id: projectId,
            name: label,
            archived: z.boolean(),
            availability: z.enum(["available", "partial", "unavailable"]),
          })
          .strict(),
      )
      .max(100),
    epics: z
      .array(
        z
          .object({
            id: beadId,
            projectId,
            title: label,
            parentId: beadId.nullable(),
          })
          .strict(),
      )
      .max(MAX_WORK_MAP_MEMBERSHIPS),
    beads: z
      .array(
        z
          .object({
            id: beadId,
            title: label,
            type: z.enum(["epic", "feature", "task", "bug", "chore"]),
            status: label.max(128),
            workState: z.enum(WORK_MAP_STATES),
            memberships: z
              .array(
                z.object({ projectId, epicId: beadId.nullable() }).strict(),
              )
              .min(1)
              .max(100),
            parentId: beadId.nullable(),
            updatedAt: z.iso.datetime({ offset: true }),
            delivery: label.max(280).nullable(),
            queue: z.enum(QUEUE_STATES).nullable(),
          })
          .strict(),
      )
      .max(100_000),
    dependencies: z
      .array(
        z
          .object({
            from: beadId,
            to: beadId,
            type: z.enum(["blocks", "requires", "relates"]),
          })
          .strict(),
      )
      .max(200_000),
  })
  .strict();
