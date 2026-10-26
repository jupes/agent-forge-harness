/** Strict trusted-input and wire codecs for the private native Codex Fork runtime. */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type {
  CodexChatBinding,
  PreparedCodexChat,
} from "../../types/codex-chat";
import {
  CODEX_APP_SERVER_VERSION,
  codexNativeUuidSchema,
  preparedCodexChatSchema,
} from "./codex-app-server-protocol";

const MAX_FORK_FRAME_BYTES = 1_048_576;
const boundedName = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const nullableName = boundedName.nullable();
const absolutePath = z.string().min(1).max(1024).refine(isAbsolute);
const codexChatBindingSchema: z.ZodType<CodexChatBinding> = z
  .object({
    provider: z.literal("codex"),
    threadId: codexNativeUuidSchema,
    version: z.literal(CODEX_APP_SERVER_VERSION),
  })
  .strict();
const sourceSettingsSchema = z
  .object({
    modelProvider: boundedName,
    serviceTier: z.string().max(128).nullable(),
    reasoningEffort: z.string().max(64).nullable(),
  })
  .strict();

export interface CodexChatForkRuntimeInput {
  prepared: PreparedCodexChat;
  parent: CodexChatBinding;
  /** Native turn ID resolved from the selected completed app-owned turn. */
  lastTurnId: string;
  /** Every field is present; null is a verified nullable value, not missing evidence. */
  sourceSettings: {
    modelProvider: string;
    serviceTier: string | null;
    reasoningEffort: string | null;
  };
  signal?: AbortSignal | undefined;
}

const runtimeInputSchema: z.ZodType<CodexChatForkRuntimeInput> = z
  .object({
    prepared: preparedCodexChatSchema,
    parent: codexChatBindingSchema,
    lastTurnId: codexNativeUuidSchema,
    sourceSettings: sourceSettingsSchema,
    signal: z
      .custom<AbortSignal>(
        (signal) =>
          typeof AbortSignal !== "undefined" && signal instanceof AbortSignal,
      )
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.parent.version !== input.prepared.capabilities.version)
      ctx.addIssue({
        code: "custom",
        path: ["parent", "version"],
        message: "The saved parent and prepared Codex version differ.",
      });
    const selectedEffort = input.sourceSettings.reasoningEffort;
    if (
      input.prepared.launch.effort !== undefined &&
      input.prepared.launch.effort !== selectedEffort
    )
      ctx.addIssue({
        code: "custom",
        path: ["sourceSettings", "reasoningEffort"],
        message: "The saved source effort differs from its prepared launch.",
      });
    if (
      selectedEffort !== null &&
      !input.prepared.capabilities.modelEfforts?.some(
        (entry) =>
          entry.model === input.prepared.launch.model &&
          entry.cliVersion === input.prepared.capabilities.version &&
          entry.efforts.includes(selectedEffort),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["sourceSettings", "reasoningEffort"],
        message: "The source effort lacks exact model and version evidence.",
      });
  });

export function parseCodexChatForkRuntimeInput(
  value: unknown,
): CodexChatForkRuntimeInput {
  return runtimeInputSchema.parse(value);
}

export interface CodexChatForkParams {
  threadId: string;
  lastTurnId: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: "user";
  sandbox: "read-only" | "workspace-write";
  config?: { model_reasoning_effort: string };
  ephemeral: false;
  excludeTurns: true;
  /** Experimental field; only the dedicated Fork process opts into experimental API. */
  deferGoalContinuation: true;
}

export function buildCodexChatForkParams(
  input: CodexChatForkRuntimeInput,
): CodexChatForkParams {
  const parsed = parseCodexChatForkRuntimeInput(input);
  return {
    threadId: parsed.parent.threadId,
    lastTurnId: parsed.lastTurnId,
    model: parsed.prepared.launch.model,
    modelProvider: parsed.sourceSettings.modelProvider,
    serviceTier: parsed.sourceSettings.serviceTier,
    cwd: parsed.prepared.canonicalCwd,
    approvalPolicy: parsed.prepared.launch.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: parsed.prepared.launch.sandbox,
    ...(parsed.sourceSettings.reasoningEffort === null
      ? {}
      : {
          config: {
            model_reasoning_effort: parsed.sourceSettings.reasoningEffort,
          },
        }),
    ephemeral: false,
    excludeTurns: true,
    deferGoalContinuation: true,
  };
}

const statusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }).strict(),
  z.object({ type: z.literal("notLoaded") }).strict(),
  z.object({ type: z.literal("systemError") }).strict(),
  z
    .object({
      type: z.literal("active"),
      activeFlags: z.array(z.unknown()).max(32),
    })
    .strict(),
]);
const sessionSourceSchema = z.union([
  z.enum(["cli", "vscode", "exec", "appServer", "unknown"]),
  z.object({ custom: z.string().max(256) }).strict(),
  z.object({ subAgent: z.unknown() }).strict(),
]);
const threadSchema = z
  .object({
    id: codexNativeUuidSchema,
    environments: z.array(z.unknown()).max(32).nullable(),
    extra: z.unknown().nullable(),
    sessionId: codexNativeUuidSchema,
    forkedFromId: codexNativeUuidSchema.nullable(),
    parentThreadId: codexNativeUuidSchema.nullable(),
    preview: z.string().max(65_536),
    ephemeral: z.boolean(),
    section: z.unknown().nullable(),
    sectionEnteredAt: z.number().finite().nullable(),
    projectId: z.string().max(256).nullable(),
    historyMode: z.enum(["legacy", "paginated"]),
    turns: z.array(z.unknown()).max(0),
    modelProvider: boundedName,
    model: nullableName,
    reasoningEffort: z.string().max(64).nullable(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    recencyAt: z.number().finite().nullable(),
    status: statusSchema,
    path: z.string().max(1024).nullable(),
    cwd: absolutePath,
    cliVersion: z.string().max(80),
    originator: z.string().max(256).nullable(),
    source: sessionSourceSchema,
    canAcceptDirectInput: z.boolean().nullable(),
    threadSource: z.string().max(256).nullable(),
    agentNickname: z.string().max(256).nullable(),
    agentRole: z.string().max(256).nullable(),
    gitInfo: z.unknown().nullable(),
    name: z.string().max(1024).nullable(),
    daybreakEnabled: z.boolean().nullable(),
  })
  .strict();
const sandboxResponseSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("readOnly"), networkAccess: z.literal(false) })
    .strict(),
  z
    .object({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(absolutePath).max(20),
      networkAccess: z.literal(false),
      excludeTmpdirEnvVar: z.literal(true),
      excludeSlashTmp: z.literal(true),
    })
    .strict(),
]);
const forkResponseSchema = z
  .object({
    thread: threadSchema,
    model: boundedName,
    modelProvider: boundedName,
    serviceTier: z.string().max(128).nullable(),
    disabledPluginIds: z.array(z.string().max(256)).max(256),
    cwd: absolutePath,
    runtimeWorkspaceRoots: z.array(absolutePath).max(20),
    instructionSources: z.array(z.string().max(1024)).max(128),
    approvalPolicy: z.enum(["on-request", "never"]),
    approvalsReviewer: z.literal("user"),
    sandbox: sandboxResponseSchema,
    activePermissionProfile: z.null(),
    reasoningEffort: z.string().max(64).nullable(),
    multiAgentMode: z.literal("explicitRequestOnly"),
  })
  .strict();

export interface VerifiedNativeCodexChatFork {
  parentThreadId: string;
  lastTurnId: string;
  threadId: string;
  forkedFromId: string;
  cliVersion: string;
  status: "idle";
  canAcceptDirectInput: true;
  settings: {
    model: string;
    modelProvider: string;
    serviceTier: string | null;
    cwd: string;
    approvalPolicy: "on-request" | "never";
    approvalsReviewer: "user";
    sandbox: "read-only" | "workspace-write";
    reasoningEffort: string | null;
  };
  runtimeWorkspaceRoots: string[];
  writableRoots: string[];
}

function normalizedPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertWithinWorkspace(path: string, workspace: string): void {
  const root = normalizedPath(workspace),
    candidate = normalizedPath(path),
    rel = relative(root, candidate);
  if (
    !isAbsolute(path) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    throw new Error(
      "Native Fork reported a path outside the trusted workspace.",
    );
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    return Buffer.byteLength(serialized);
  } catch {
    throw new Error("Native Fork response is not bounded JSON data.");
  }
}

export function verifyCodexChatForkResponse(
  value: unknown,
  input: CodexChatForkRuntimeInput,
): VerifiedNativeCodexChatFork {
  if (serializedBytes(value) > MAX_FORK_FRAME_BYTES)
    throw new Error("Native Fork response exceeds its frame bound.");
  const response = forkResponseSchema.parse(value),
    prepared = input.prepared,
    settings = input.sourceSettings,
    thread = response.thread;
  if (
    thread.id === input.parent.threadId ||
    thread.forkedFromId !== input.parent.threadId ||
    thread.parentThreadId !== null ||
    thread.cliVersion !== prepared.capabilities.version ||
    thread.status.type !== "idle" ||
    thread.canAcceptDirectInput !== true ||
    thread.ephemeral ||
    thread.turns.length !== 0 ||
    thread.model !== prepared.launch.model ||
    thread.modelProvider !== settings.modelProvider ||
    thread.reasoningEffort !== settings.reasoningEffort
  )
    throw new Error(
      "Native Fork returned different child identity or settings.",
    );

  if (
    response.model !== prepared.launch.model ||
    response.modelProvider !== settings.modelProvider ||
    response.serviceTier !== settings.serviceTier ||
    normalizedPath(response.cwd) !== normalizedPath(prepared.canonicalCwd) ||
    normalizedPath(thread.cwd) !== normalizedPath(prepared.canonicalCwd) ||
    response.approvalPolicy !== prepared.launch.approvalPolicy ||
    response.approvalsReviewer !== "user" ||
    response.reasoningEffort !== settings.reasoningEffort ||
    (prepared.launch.sandbox === "read-only"
      ? response.sandbox.type !== "readOnly"
      : response.sandbox.type !== "workspaceWrite")
  )
    throw new Error("Native Fork acknowledged different source configuration.");

  const workspaceRoots = response.runtimeWorkspaceRoots,
    writableRoots =
      response.sandbox.type === "workspaceWrite"
        ? response.sandbox.writableRoots
        : [];
  for (const path of [...workspaceRoots, ...writableRoots])
    assertWithinWorkspace(path, prepared.canonicalCwd);

  return {
    parentThreadId: input.parent.threadId,
    lastTurnId: input.lastTurnId,
    threadId: thread.id,
    forkedFromId: thread.forkedFromId,
    cliVersion: thread.cliVersion,
    status: "idle",
    canAcceptDirectInput: true,
    settings: {
      model: response.model,
      modelProvider: response.modelProvider,
      serviceTier: response.serviceTier,
      cwd: prepared.canonicalCwd,
      approvalPolicy: response.approvalPolicy,
      approvalsReviewer: response.approvalsReviewer,
      sandbox: prepared.launch.sandbox,
      reasoningEffort: response.reasoningEffort,
    },
    runtimeWorkspaceRoots: workspaceRoots,
    writableRoots,
  };
}
