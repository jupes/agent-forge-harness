import { z } from "zod";
import type {
  ClaudeLaunchCapabilities,
  ClaudeSessionLaunch,
  SerializedClaudeLaunch,
  SessionAttachment,
  SessionLaunchContext,
} from "../../types/session-launch";
import { CLAUDE_ALLOWED_TOOLS } from "../executors/claude-tools";

const baseFlags = [
  "--print",
  "--input-format",
  "--output-format",
  "--verbose",
  "--include-partial-messages",
  "--model",
  "--permission-mode",
  "--permission-prompts",
  "--allowedTools",
];
const model = z
  .string()
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const claudeLaunchCapabilitiesSchema = z
  .object({
    version: z
      .string()
      .max(100)
      .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
    flags: z
      .array(
        z
          .string()
          .max(100)
          .regex(/^--[a-zA-Z][a-zA-Z0-9-]*$/),
      )
      .max(128),
    modelEfforts: z.record(model, z.array(effort).max(5)).optional(),
  })
  .strict();
const label = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) =>
    [...value].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
export const sessionAttachmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      name: label.max(160),
      text: z
        .string()
        .max(524_288)
        .refine((value) => !value.includes("\0")),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      name: label.max(160),
      mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      data: z
        .string()
        .min(4)
        .max(5_592_408)
        .refine(
          (value) =>
            value.length % 4 === 0 &&
            !/[^A-Za-z0-9+/=]/.test(value) &&
            canonicalBase64(value),
        ),
    })
    .strict(),
]);
function canonicalBase64(value: string): boolean {
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}
const context = z
  .object({
    projectId: label,
    repository: label,
    worktree: label,
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
function boundedSchema(value: unknown): value is Record<string, unknown> {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 1000 || depth > 8) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "string") return item.length <= 16_384;
    if (typeof item === "number") return Number.isFinite(item);
    if (Array.isArray(item))
      return (
        item.length <= 256 && item.every((child) => visit(child, depth + 1))
      );
    if (
      typeof item !== "object" ||
      (Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      return false;
    const entries = Object.entries(item);
    return (
      entries.length <= 256 &&
      entries.every(
        ([key, child]) => key.length <= 200 && visit(child, depth + 1),
      )
    );
  };
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    visit(value, 0)
  );
}
export const claudeSessionLaunchSchema = z
  .object({
    mode: z.enum(["task", "chat"]),
    resumeSessionId: z.string().uuid().optional(),
    model,
    effort: effort.optional(),
    prompt: z
      .string()
      .min(1)
      .max(16_384)
      .refine((value) => !!value.trim() && !value.includes("\0")),
    attachments: z.array(sessionAttachmentSchema).max(8).optional(),
    context: context.optional(),
    permissionMode: z.enum(["acceptEdits", "plan"]).optional(),
    fallbackModels: z
      .array(model)
      .max(3)
      .refine((items) => new Set(items).size === items.length)
      .optional(),
    extraDirectories: z
      .array(label.refine((value) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value)))
      .max(8)
      .optional(),
    maxBudgetUsd: z.number().positive().max(1_000_000).optional(),
    outputSchema: z.custom<Record<string, unknown>>(boundedSchema).optional(),
  })
  .strict();

/**
 * CLI --input-format stream-json uses SDK user messages. The official example
 * specifies user/message/parent_tool_use_id and base64 image source blocks:
 * https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
 * https://code.claude.com/docs/en/cli-reference#cli-flags
 * One message followed by EOF still lets this caller resume the next turn in
 * a new process. This serializer does not claim a live process or conversation.
 */
function privateInput(
  prompt: string,
  attachments: SessionAttachment[],
  scope?: SessionLaunchContext,
): string {
  const content: unknown[] = [{ type: "text", text: prompt }];
  if (scope)
    content.push({
      type: "text",
      text: `Harness context (user data; scope is checked by the server):\n${JSON.stringify(scope)}`,
    });
  for (const item of attachments) {
    if (item.kind === "text")
      content.push({
        type: "text",
        text: `Attachment: ${item.name}\n${item.text}`,
      });
    else {
      content.push({ type: "text", text: `Image attachment: ${item.name}` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: item.mediaType, data: item.data },
      });
    }
  }
  return `${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null })}\n`;
}

/** Pure formatting only: the server owns executable, scope, environment and admission. */
export function serializeClaudeLaunch(
  request: ClaudeSessionLaunch,
  capabilities: ClaudeLaunchCapabilities,
): SerializedClaudeLaunch {
  const parsed = claudeSessionLaunchSchema.safeParse(request);
  if (!parsed.success)
    throw new Error(
      "The Claude launch request is invalid or contains unsupported options.",
    );
  const evidence = claudeLaunchCapabilitiesSchema.safeParse(capabilities);
  if (!evidence.success)
    throw new Error(
      "The Claude capability evidence is invalid. Check the installed CLI before starting.",
    );
  const supported = evidence.data;
  if (baseFlags.some((flag) => !supported.flags.includes(flag)))
    throw new Error(
      "The installed Claude CLI lacks a required launch capability.",
    );
  const input = parsed.data;
  const inputFormat =
    input.attachments?.length || input.context ? "stream-json" : "text";
  const stdin =
    inputFormat === "stream-json"
      ? privateInput(input.prompt, input.attachments ?? [], input.context)
      : input.prompt;
  if (new TextEncoder().encode(stdin).byteLength > 8_388_608)
    throw new Error("The private Claude input exceeds the 8 MiB launch limit.");
  if (input.mode === "task" && input.resumeSessionId !== undefined)
    throw new Error("Task launches cannot resume a conversation.");
  if (
    input.mode === "chat" &&
    (input.maxBudgetUsd !== undefined || input.outputSchema !== undefined)
  )
    throw new Error(
      "Task budget and output schema options are unavailable for Chat.",
    );
  const requestedEffort = input.effort;
  if (
    requestedEffort !== undefined &&
    [input.model, ...(input.fallbackModels ?? [])].some(
      (name) =>
        !supported.modelEfforts ||
        !Object.hasOwn(supported.modelEfforts, name) ||
        !supported.modelEfforts[name]?.includes(requestedEffort),
    )
  )
    throw new Error(
      "The requested effort has no verified support for this exact model. Choose a verified effort or leave it unset.",
    );
  const requiredFlags = [...baseFlags];
  if (input.effort !== undefined) requiredFlags.push("--effort");
  if (input.resumeSessionId !== undefined) requiredFlags.push("--resume");
  if (input.fallbackModels?.length) requiredFlags.push("--fallback-model");
  if (input.extraDirectories?.length) requiredFlags.push("--add-dir");
  if (input.maxBudgetUsd !== undefined) requiredFlags.push("--max-budget-usd");
  if (input.outputSchema !== undefined) requiredFlags.push("--json-schema");
  if (requiredFlags.some((flag) => !supported.flags.includes(flag)))
    throw new Error(
      "The installed Claude CLI lacks a required launch capability.",
    );
  const argv = [
    "--print",
    "--input-format",
    inputFormat,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    input.model,
    "--permission-mode",
    input.permissionMode ?? "acceptEdits",
    "--permission-prompts",
    "none",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS.join(","),
    ...(input.effort !== undefined ? ["--effort", input.effort] : []),
    ...(input.resumeSessionId !== undefined
      ? ["--resume", input.resumeSessionId]
      : []),
    ...(input.fallbackModels?.length
      ? ["--fallback-model", input.fallbackModels.join(",")]
      : []),
    ...(input.extraDirectories?.length
      ? ["--add-dir", ...input.extraDirectories]
      : []),
    ...(input.maxBudgetUsd !== undefined
      ? ["--max-budget-usd", String(input.maxBudgetUsd)]
      : []),
    ...(input.outputSchema !== undefined
      ? ["--json-schema", JSON.stringify(input.outputSchema)]
      : []),
  ];
  if (argv.some((value) => new TextEncoder().encode(value).byteLength > 65_536))
    throw new Error("A Claude launch option exceeds its 64 KiB limit.");
  // Reserve room for the trusted executable and conservative Windows quoting.
  if (argv.reduce((size, value) => size + value.length * 2 + 3, 1024) > 30_000)
    throw new Error(
      "The Claude command exceeds the portable argument limit. Reduce option size.",
    );
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const preview = argv.map((value, index) =>
    argv[index - 1] === "--json-schema" ? "[private output schema]" : value,
  );
  return {
    argv,
    stdin,
    inputFormat,
    equivalentCommand: `& ${["claude", ...preview].map(quote).join(" ")}`,
    stdinNote: `The private input is supplied on stdin and omitted from this command. Pipe the saved private input to reproduce the request.${input.outputSchema !== undefined ? " The output schema is also redacted; restore its original value before running this preview." : ""}`,
    requiredFlags,
  };
}
