import { z } from "zod";
import type { GeminiTaskLaunch } from "../../types/gemini-task";
import type { PreparedGeminiTask } from "../../types/gemini-task-runtime";
import {
  geminiTaskCapabilitiesSchema,
  geminiTaskLaunchSchema,
  serializeGeminiTask,
} from "./gemini-task";

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
export const preparedGeminiLaunchSchema = geminiTaskLaunchSchema.transform(
  (value): GeminiTaskLaunch => ({
    route: value.route,
    mode: value.mode,
    cwd: value.cwd,
    prompt: value.prompt,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.approvalMode === undefined
      ? {}
      : { approvalMode: value.approvalMode }),
    ...(value.sandbox === undefined ? {} : { sandbox: value.sandbox }),
    ...(value.policyFiles === undefined
      ? {}
      : { policyFiles: value.policyFiles }),
    ...(value.includeDirectories === undefined
      ? {}
      : { includeDirectories: value.includeDirectories }),
    ...(value.attachments === undefined
      ? {}
      : { attachments: value.attachments }),
    ...(value.context === undefined
      ? {}
      : {
          context: {
            projectId: value.context.projectId,
            repository: value.context.repository,
            worktree: value.context.worktree,
            ...(value.context.beadId === undefined
              ? {}
              : { beadId: value.context.beadId }),
          },
        }),
  }),
);
/** Pure wire validation. Native canonical paths remain the runtime's responsibility. */
export const preparedGeminiTaskSchema: z.ZodType<PreparedGeminiTask> = z
  .object({
    version: z.literal(1),
    provider: z.literal("gemini"),
    smith: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    canonicalRoot: path,
    canonicalCwd: path,
    command: z.array(path).min(1).max(16),
    paths: z.array(path).max(35),
    launch: preparedGeminiLaunchSchema,
    capabilities: geminiTaskCapabilitiesSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      serializeGeminiTask(value.launch, value.capabilities);
      if (
        new TextEncoder().encode(JSON.stringify(value)).byteLength > 3_145_728
      )
        throw Error("Snapshot bound");
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "The private Gemini Task preparation is unsupported or exceeds its bound.",
      });
    }
  });
