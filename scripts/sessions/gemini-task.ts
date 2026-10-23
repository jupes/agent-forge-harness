import { z } from "zod";
import type { GeminiChatLaunch } from "../../types/gemini-chat-runtime";
import type {
  GeminiTaskCapabilities,
  GeminiTaskLaunch,
  SerializedGeminiTask,
} from "../../types/gemini-task";

if (typeof window !== "undefined") z.config({ jitless: true });

export const geminiTaskCapabilitiesSchema = z
  .object({
    version: z.literal("0.65.0"),
    flags: z
      .array(
        z
          .string()
          .max(80)
          .regex(/^--[a-z][a-z0-9-]*$/),
      )
      .max(256),
  })
  .strict();
export const GEMINI_TASK_MAX_STDIN_BYTES = 2_097_152;
const encoder = new TextEncoder();
const wellFormed = (value: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
const privateText = z
  .string()
  .max(GEMINI_TASK_MAX_STDIN_BYTES)
  .refine((value) => !value.includes("\0") && wellFormed(value));
const label = z
  .string()
  .min(1)
  .max(4096)
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
);
export const geminiTaskLaunchSchema = z
  .object({
    route: z.literal("gemini-cli"),
    mode: z.literal("task"),
    cwd: absolutePath,
    prompt: privateText.refine((value) => value.trim().length > 0),
    model: z
      .string()
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
      .optional(),
    approvalMode: z.enum(["default", "auto_edit", "plan"]).optional(),
    sandbox: z.boolean().optional(),
    policyFiles: z.array(absolutePath).max(16).optional(),
    includeDirectories: z.array(absolutePath).max(16).optional(),
    context: z
      .object({
        projectId: label.max(200),
        repository: absolutePath,
        worktree: absolutePath,
        beadId: label.max(200).optional(),
        about: z
          .array(
            z
              .object({
                kind: z.enum(["bead", "session", "run", "event"]),
                id: label.max(200),
              })
              .strict(),
          )
          .max(16)
          .optional(),
      })
      .strict()
      .optional(),
    attachments: z
      .array(
        z
          .object({
            kind: z.literal("text"),
            name: label.max(160),
            text: privateText.max(524_288),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

export const geminiChatLaunchSchema = geminiTaskLaunchSchema
  .omit({ mode: true })
  .extend({ mode: z.literal("chat") })
  .strict();

export function serializeGeminiTask(
  input: GeminiTaskLaunch,
  available: GeminiTaskCapabilities,
): SerializedGeminiTask {
  return serializeGeminiLaunch(input, available, "task");
}

export function serializeGeminiChat(
  input: GeminiChatLaunch,
  available: GeminiTaskCapabilities,
): SerializedGeminiTask {
  return serializeGeminiLaunch(input, available, "chat");
}

function serializeGeminiLaunch(
  input: GeminiTaskLaunch | GeminiChatLaunch,
  available: GeminiTaskCapabilities,
  mode: "task" | "chat",
): SerializedGeminiTask {
  const label = mode === "task" ? "Task" : "Chat";
  const parsed = (
    mode === "task" ? geminiTaskLaunchSchema : geminiChatLaunchSchema
  ).safeParse(input);
  if (!parsed.success)
    throw new Error(`The private Gemini ${label} request is invalid.`);
  const request = parsed.data;
  const evidence = geminiTaskCapabilitiesSchema.safeParse(available);
  if (!evidence.success)
    throw new Error(
      `The installed Gemini CLI lacks the verified 0.65.0 ${label} protocol.`,
    );
  const capabilities = evidence.data;
  const argv = mode === "task" ? ["--output-format", "stream-json"] : ["--acp"];
  const requiredFlags = [mode === "task" ? "--output-format" : "--acp"];
  const option = (flag: string, value: string) => {
    argv.push(flag, value);
    if (!requiredFlags.includes(flag)) requiredFlags.push(flag);
  };
  if (request.model !== undefined) option("--model", request.model);
  if (request.approvalMode !== undefined)
    option("--approval-mode", request.approvalMode);
  if (request.sandbox !== undefined) {
    argv.push(request.sandbox ? "--sandbox" : "--sandbox=false");
    requiredFlags.push("--sandbox");
  }
  for (const path of request.policyFiles ?? []) option("--policy", path);
  for (const path of request.includeDirectories ?? [])
    option("--include-directories", path);
  const data = {
    ...(request.context === undefined ? {} : { context: request.context }),
    ...(request.attachments === undefined
      ? {}
      : { attachments: request.attachments }),
  };
  const stdin =
    Object.keys(data).length === 0
      ? request.prompt
      : `${request.prompt}\n\n<agent-forge-${mode}-data>\n${JSON.stringify(data).replaceAll("@", "\\u0040")}\n</agent-forge-${mode}-data>`;
  if (encoder.encode(stdin).byteLength > GEMINI_TASK_MAX_STDIN_BYTES)
    throw new Error(
      "The complete private Gemini stdin exceeds its 2 MiB bound.",
    );
  for (const flag of requiredFlags)
    if (!capabilities.flags.includes(flag))
      throw new Error(`The installed Gemini CLI does not advertise ${flag}.`);
  return {
    argv,
    stdin,
    inputFormat: "text",
    equivalentCommand: `& ${["gemini", ...argv].map((value) => `'${value.replaceAll("'", "''")}'`).join(" ")}`,
    stdinNote:
      "Supply the original private stdin separately; execute argv directly.",
    requiredFlags,
  };
}
