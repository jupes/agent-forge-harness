import { z } from "zod";
import type {
  CodexExecCapabilities,
  CodexTaskLaunch,
} from "../../types/codex-task";
import type { PreparedCodexTask } from "../../types/codex-task-runtime";
import {
  codexExecCapabilitiesSchema,
  codexTaskLaunchSchema,
  serializeCodexTask,
} from "./codex-task";

export const preparedCodexLaunchSchema = codexTaskLaunchSchema.transform(
  (value): CodexTaskLaunch => ({
    mode: value.mode,
    cwd: value.cwd,
    model: value.model,
    sandbox: value.sandbox,
    approvalPolicy: value.approvalPolicy,
    prompt: value.prompt,
    ...(value.effort === undefined ? {} : { effort: value.effort }),
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
            ...(value.context.about === undefined
              ? {}
              : { about: value.context.about }),
          },
        }),
  }),
);
export const preparedCodexCapabilitiesSchema =
  codexExecCapabilitiesSchema.transform(
    (value): CodexExecCapabilities => ({
      version: value.version,
      flags: value.flags,
      ...(value.modelEfforts === undefined
        ? {}
        : { modelEfforts: value.modelEfforts }),
    }),
  );
/** Pure private codec, safe in the WebView. Canonical path authority remains with the native runtime. */
export const preparedCodexTaskSchema: z.ZodType<PreparedCodexTask> = z
  .object({
    version: z.literal(1),
    provider: z.literal("codex"),
    smith: z
      .string()
      .min(1)
      .max(80)
      .refine(
        (value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value),
      ),
    cwd: z.string().max(1024),
    canonicalCwd: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value)),
    launch: preparedCodexLaunchSchema,
    capabilities: preparedCodexCapabilitiesSchema,
  })
  .strict()
  .refine((value) => value.cwd === value.launch.cwd)
  .superRefine((value, ctx) => {
    try {
      serializeCodexTask(value.launch, value.capabilities);
      if (
        new TextEncoder().encode(JSON.stringify(value)).byteLength > 2_097_152
      )
        throw Error("Oversized preparation");
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "The private Codex Task snapshot is unsupported or exceeds 2 MiB.",
      });
    }
  });
