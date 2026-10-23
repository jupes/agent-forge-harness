import { z } from "zod";
import type { GeminiTaskStartRequest } from "../../types/gemini-owned-task";
import { geminiTaskLaunchSchema } from "./gemini-task";
import { sessionStartSchema } from "./request-protocol";

/** No public path selectors until a scoped producer can authorize those selections. */
export const geminiTaskStartSchema = sessionStartSchema
  .omit({ launch: true })
  .extend({
    provider: z.literal("gemini"),
    launch: geminiTaskLaunchSchema
      .omit({
        cwd: true,
        context: true,
        policyFiles: true,
        includeDirectories: true,
      })
      .extend({
        prompt: geminiTaskLaunchSchema.shape.prompt.max(16_384),
        attachments: geminiTaskLaunchSchema.shape.attachments
          .unwrap()
          .max(8)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .transform(
    (value): GeminiTaskStartRequest => ({
      ...value,
      launch: {
        route: value.launch.route,
        mode: value.launch.mode,
        prompt: value.launch.prompt,
        ...(value.launch.model === undefined
          ? {}
          : { model: value.launch.model }),
        ...(value.launch.approvalMode === undefined
          ? {}
          : { approvalMode: value.launch.approvalMode }),
        ...(value.launch.sandbox === undefined
          ? {}
          : { sandbox: value.launch.sandbox }),
        ...(value.launch.attachments === undefined
          ? {}
          : { attachments: value.launch.attachments }),
      },
    }),
  ) satisfies z.ZodType<GeminiTaskStartRequest>;
