import { z } from "zod";
import type { ProjectRecord } from "../../types/projects";

/** Initial interruption events from Command Center decision 19, using Inbox source IDs. */
export const PROJECT_NOTIFICATION_EVENTS = [
  "stopped-shift",
  "failed-gate",
  "council-verdict",
  "bead-approval",
] as const;
export const projectNotificationsSchema = z
  .object({
    "stopped-shift": z.boolean(),
    "failed-gate": z.boolean(),
    "council-verdict": z.boolean(),
    "bead-approval": z.boolean(),
  })
  .strict();
export type ProjectNotifications = z.infer<typeof projectNotificationsSchema>;
/** Absence retains the pre-notification behavior: no OS interruption. */
export const NO_PROJECT_NOTIFICATIONS: Readonly<ProjectNotifications> =
  Object.freeze({
    "stopped-shift": false,
    "failed-gate": false,
    "council-verdict": false,
    "bead-approval": false,
  });
export const projectNotificationsRequestSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    notifications: projectNotificationsSchema,
  })
  .strict();

/** Delivery must supply verified project ownership, never broadcast workspace-wide events. */
export function projectInterruptionAllowed(
  project: Pick<ProjectRecord, "id" | "archived" | "notifications">,
  event: {
    projectId: string;
    kind: (typeof PROJECT_NOTIFICATION_EVENTS)[number];
    reason?: string;
  },
): boolean {
  return (
    !project.archived &&
    event.projectId === project.id &&
    (event.kind !== "stopped-shift" || event.reason === "halted") &&
    (project.notifications ?? NO_PROJECT_NOTIFICATIONS)[event.kind] === true
  );
}
