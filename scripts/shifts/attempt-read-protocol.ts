import { z } from "zod";
import type { ProjectShiftAttemptsPage } from "../../types/shift-attempts";
import { ownedCodingPageSchema } from "../sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../sessions/codex-owned-wire-protocol";
import {
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "../sessions/identity-protocol";

if (typeof window !== "undefined") z.config({ jitless: true });
export const SHIFT_ATTEMPT_METADATA_REASON =
  "Owned attempt metadata only. Open this attempt to verify its private history; the index does not prove provider dispatch or completion.";
export const projectShiftAttemptsPageSchema: z.ZodType<ProjectShiftAttemptsPage> =
  z
    .object({
      projectId: sessionProjectIdSchema,
      originalRequestId: sessionRequestIdSchema,
      shiftId: z.string().regex(/^shift-\d{8}-\d{6}-[0-9a-f]{4}$/),
      asOf: z.iso.datetime(),
      items: z
        .array(
          z
            .object({
              session: ownedCodingSessionSchema,
              phase: z.literal("unknown"),
              reason: z.literal(SHIFT_ATTEMPT_METADATA_REASON),
              controllable: z.literal(false),
            })
            .strict(),
        )
        .max(1000),
    })
    .strict()
    .refine(
      (page) =>
        new Set(page.items.map((item) => item.session.id)).size ===
          page.items.length &&
        page.items.every(
          ({ session }) =>
            session.projectId === page.projectId &&
            session.origin?.originalRequestId === page.originalRequestId &&
            session.origin.shiftId === page.shiftId,
        ),
    );
export const projectShiftAttemptPageSchema = ownedCodingPageSchema.refine(
  (page) => !page.controllable,
);
