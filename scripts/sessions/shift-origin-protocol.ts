import { z } from "zod";
import type { ProjectShiftAttemptOrigin } from "../../types/shift-origin";
import { SHIFT_LIMITS } from "../config/defaults";
import { parseBeadsIssueId } from "../run-correlation";
import { redactSecrets } from "../secret-patterns";
import {
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "./identity-protocol";

const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value),
    );

/** Metadata classification only. A registry origin never authorizes private reads or controls. */
export const projectShiftAttemptOriginSchema: z.ZodType<ProjectShiftAttemptOrigin> =
  z
    .object({
      kind: z.literal("shift"),
      projectId: sessionProjectIdSchema,
      originalRequestId: sessionRequestIdSchema,
      shiftId: label(64).regex(/^shift-\d{8}-\d{6}-[0-9a-f]{4}$/),
      runId: label(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      beadId: label(200).refine(
        (value) =>
          parseBeadsIssueId(value) === value &&
          redactSecrets(value).redactions.length === 0,
      ),
      attempt: z
        .number()
        .int()
        .positive()
        .max(SHIFT_LIMITS.repairs[1] + 1),
    })
    .strict();
