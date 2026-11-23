import { z } from "zod";
import type {
  CodexExecCapabilities,
  CodexTaskLaunch,
  SerializedCodexTask,
} from "../../types/codex-task";

// Zod's generated validator must not require unsafe-eval in the native WebView.
if (typeof window !== "undefined") z.config({ jitless: true });

const version = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
const model = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const effort = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const wellFormed = (value: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
const label = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) && wellFormed(value),
  );
const absolutePath = label.refine(
  (value) =>
    /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(value) &&
    !value.split(/[\\/]/).some((part) => part === "." || part === ".."),
  "A bounded absolute working directory is required; server scope validation is separate.",
);
const requiredFlags = [
  "--json",
  "--color",
  "--sandbox",
  "--model",
  "--cd",
  "--config",
];
export const CODEX_TASK_MAX_STDIN_BYTES = 2_097_152;
const encoder = new TextEncoder();

export const codexTaskTextAttachmentSchema = z
  .object({
    kind: z.literal("text"),
    name: label.max(160),
    text: z
      .string()
      .max(524_288)
      .refine((value) => !value.includes("\0") && wellFormed(value)),
  })
  .strict();
const context = z
  .object({
    projectId: label,
    repository: absolutePath,
    worktree: absolutePath,
    beadId: label.optional(),
    about: z
      .array(
        z
          .object({
            kind: z.enum(["bead", "session", "run", "event"]),
            id: label,
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

export const codexModelEffortEvidenceSchema = z
  .object({
    model,
    efforts: z
      .array(effort)
      .max(32)
      .refine((values) => new Set(values).size === values.length),
    source: z.literal("model/list"),
    cliVersion: version,
    asOf: z.iso.datetime().max(100),
  })
  .strict();

export const codexExecCapabilitiesSchema = z
  .object({
    version,
    flags: z
      .array(
        z
          .string()
          .max(100)
          .regex(/^--[a-zA-Z][a-zA-Z0-9-]*$/),
      )
      .max(128),
    modelEfforts: z
      .array(codexModelEffortEvidenceSchema)
      .max(100)
      .refine(
        (values) =>
          new Set(values.map((entry) => entry.model)).size === values.length,
      )
      .optional(),
  })
  .strict();

export const codexTaskLaunchSchema = z
  .object({
    mode: z.literal("task"),
    cwd: absolutePath,
    model,
    sandbox: z.enum(["read-only", "workspace-write"]),
    approvalPolicy: z.literal("never"),
    prompt: z
      .string()
      .min(1)
      .max(16_384)
      .refine(
        (value) => !!value.trim() && !value.includes("\0") && wellFormed(value),
      ),
    effort: effort.optional(),
    attachments: z.array(codexTaskTextAttachmentSchema).max(8).optional(),
    context: context.optional(),
  })
  .strict();

/** Pure serialization, not execution authority. The server must validate scope and trusted capability evidence. */
export function serializeCodexTask(
  request: CodexTaskLaunch,
  available: CodexExecCapabilities,
): SerializedCodexTask {
  const launch = codexTaskLaunchSchema.parse(request);
  const capabilities = codexExecCapabilitiesSchema.parse(available);
  for (const flag of requiredFlags) {
    if (!capabilities.flags.includes(flag))
      throw new Error(`The installed Codex CLI does not advertise ${flag}.`);
  }
  if (launch.effort !== undefined) {
    const evidence = capabilities.modelEfforts?.find(
      (entry) => entry.model === launch.model,
    );
    if (
      !evidence ||
      evidence.cliVersion !== capabilities.version ||
      !evidence.efforts.includes(launch.effort)
    )
      throw new Error(
        "The requested effort lacks model/list evidence for this exact model and CLI version.",
      );
  }
  const argv = [
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    launch.sandbox,
    "--model",
    launch.model,
    "--cd",
    launch.cwd,
    "--config",
    'approval_policy="never"',
  ];
  if (launch.effort !== undefined)
    argv.push(
      "--config",
      `model_reasoning_effort=${JSON.stringify(launch.effort)}`,
    );
  argv.push("-");
  const data = {
    ...(launch.context === undefined ? {} : { context: launch.context }),
    ...(launch.attachments === undefined
      ? {}
      : { attachments: launch.attachments }),
  };
  const stdin =
    Object.keys(data).length === 0
      ? launch.prompt
      : `${launch.prompt}\n\n<agent-forge-task-data>\n${JSON.stringify(data)}\n</agent-forge-task-data>`;
  if (encoder.encode(stdin).byteLength > CODEX_TASK_MAX_STDIN_BYTES)
    throw new Error("The private Codex stdin exceeds its 2 MiB bound.");
  return {
    argv,
    stdin,
    inputFormat: "text",
    equivalentCommand: `& ${["codex", ...argv].map((value) => `'${value.replaceAll("'", "''")}'`).join(" ")}`,
    stdinNote:
      "Supply the original private stdin separately. This PowerShell argv preview alone does not restore or run the prompt; execute argv directly.",
    requiredFlags: [...requiredFlags],
  };
}
