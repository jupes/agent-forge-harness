import { z } from "zod";
import type {
  CodexChatApproval,
  CodexChatCapabilities,
  CodexChatCommand,
  CodexChatDecision,
  CodexChatEvent,
  CodexChatLaunch,
  CodexChatUsage,
  PreparedCodexChat,
} from "../../types/codex-chat";
import { reportedText, SESSION_ACTIVITY_LIMITS } from "./activity-protocol";
import {
  codexExecCapabilitiesSchema,
  codexTaskLaunchSchema,
} from "./codex-task";

/** Generated from this native CLI without a model call; other wire versions require new evidence. */
export const CODEX_APP_SERVER_VERSION = "0.163.0-alpha.10.2";
export const CODEX_CHAT_MAX_BYTES = 2_097_152;
const encoder = new TextEncoder();
export const codexChatLaunchSchema = codexTaskLaunchSchema
  .omit({ mode: true, approvalPolicy: true })
  .extend({
    mode: z.literal("chat"),
    approvalPolicy: z.enum(["on-request", "never"]),
  })
  .strict()
  .transform(
    (value): CodexChatLaunch => ({
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
export const codexChatCapabilitiesSchema =
  codexExecCapabilitiesSchema.transform(
    (value): CodexChatCapabilities => ({
      version: value.version,
      flags: value.flags,
      ...(value.modelEfforts === undefined
        ? {}
        : { modelEfforts: value.modelEfforts }),
    }),
  );

/** Pure protocol input, not scope, execution or approval authority. Never execute the preview string. */
export function serializeCodexChat(
  request: CodexChatLaunch,
  available: CodexChatCapabilities,
) {
  const launch = codexChatLaunchSchema.parse(request);
  const capabilities = codexChatCapabilitiesSchema.parse(available);
  if (capabilities.version !== CODEX_APP_SERVER_VERSION)
    throw new Error(
      "The installed Codex version has no verified app-server protocol.",
    );
  if (!capabilities.flags.includes("--stdio"))
    throw new Error(
      "The installed Codex app-server does not advertise --stdio.",
    );
  if (
    launch.effort !== undefined &&
    !capabilities.modelEfforts?.some(
      (entry) =>
        entry.model === launch.model &&
        entry.cliVersion === capabilities.version &&
        entry.efforts.includes(launch.effort ?? ""),
    )
  )
    throw new Error(
      "The requested effort lacks model/list evidence for this exact model and CLI version.",
    );
  const data = {
    ...(launch.context === undefined ? {} : { context: launch.context }),
    ...(launch.attachments === undefined
      ? {}
      : { attachments: launch.attachments }),
  };
  const text =
    Object.keys(data).length === 0
      ? launch.prompt
      : `${launch.prompt}\n\n<agent-forge-chat-data>\n${JSON.stringify(data)}\n</agent-forge-chat-data>`;
  if (encoder.encode(text).byteLength > CODEX_CHAT_MAX_BYTES)
    throw new Error("The private Codex Chat input exceeds its 2 MiB bound.");
  return {
    argv: ["app-server", "--stdio"],
    thread: {
      model: launch.model,
      cwd: launch.cwd,
      sandbox: launch.sandbox,
      approvalPolicy: launch.approvalPolicy,
      approvalsReviewer: "user" as const,
      environments: [],
    },
    input: { type: "text" as const, text, text_elements: [] },
    effort: launch.effort ?? null,
    equivalentCommand: "& 'codex' 'app-server' '--stdio'",
    stdinNote:
      "This starts only the stdio server. Restore the original private JSON handshake and input separately; this preview does not run the prompt. Execute argv directly.",
  };
}

export const preparedCodexChatSchema: z.ZodType<PreparedCodexChat> = z
  .object({
    version: z.literal(1),
    provider: z.literal("codex"),
    smith: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    cwd: z.string().min(1).max(1024),
    canonicalCwd: z.string().min(1).max(1024),
    launch: codexChatLaunchSchema,
    capabilities: codexChatCapabilitiesSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.cwd === value.launch.cwd &&
      (value.launch.context === undefined ||
        value.cwd === value.launch.context.worktree),
  )
  .superRefine((value, ctx) => {
    try {
      serializeCodexChat(value.launch, value.capabilities);
      if (
        encoder.encode(JSON.stringify(value)).byteLength > CODEX_CHAT_MAX_BYTES
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "The private Codex Chat snapshot is unsupported or exceeds 2 MiB.",
      });
    }
  });

const id = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
export const codexNativeUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
const nativeRequestId = z.union([id, z.number().safe()]);
const object = (value: unknown) =>
  z.record(z.string(), z.unknown()).parse(value);
export type CodexAppServerFrame =
  | { kind: "response"; id: string | number; result: unknown; error: boolean }
  | { kind: "request"; id: string | number; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown };
export const nativeRequestKey = (value: string | number) =>
  `${typeof value}:${value}`;

export function parseCodexAppServerFrame(line: string): CodexAppServerFrame {
  if (encoder.encode(line).byteLength > 1_048_576)
    throw new Error("Codex protocol frame exceeds its bound.");
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("Codex protocol frame is malformed.");
  }
  try {
    const row = z
      .object({
        jsonrpc: z.literal("2.0").optional(),
        id: nativeRequestId.optional(),
        method: id.optional(),
        params: z.unknown().optional(),
        result: z.unknown().optional(),
        error: z
          .object({
            code: z.number().safe(),
            message: z.string().max(16_384),
            data: z.unknown().optional(),
          })
          .optional(),
      })
      .strict()
      .parse(raw);
    const result = Object.hasOwn(row, "result"),
      error = Object.hasOwn(row, "error");
    if (row.method !== undefined) {
      if (result || error) throw new Error();
      return row.id === undefined
        ? { kind: "notification", method: row.method, params: row.params }
        : {
            kind: "request",
            id: row.id,
            method: row.method,
            params: row.params,
          };
    }
    if (row.id === undefined || result === error) throw new Error();
    return { kind: "response", id: row.id, result: row.result, error };
  } catch {
    throw new Error("Codex protocol frame is malformed.");
  }
}

export type NativeCodexApproval = Omit<
  CodexChatApproval,
  "id" | "provider" | "processId"
>;
const turn = z.object({
  id: codexNativeUuidSchema,
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
});
const item = z.object({
  id,
  type: id,
  text: z.string().max(1_048_576).optional(),
});
const nativeCommand = item.extend({
  type: z.literal("commandExecution"),
  command: z.string().min(1).max(65_536),
  cwd: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => !value.includes("\0")),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
  aggregatedOutput: z.string().max(1_048_576).nullable(),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
  durationMs: z.number().safe().nonnegative().nullable(),
});
const counts = z.object({
  inputTokens: z.number().safe().nonnegative(),
  outputTokens: z.number().safe().nonnegative(),
  cachedInputTokens: z.number().safe().nonnegative(),
  cacheWriteInputTokens: z.number().safe().nonnegative(),
  reasoningOutputTokens: z.number().safe().nonnegative(),
  totalTokens: z.number().safe().nonnegative(),
});
const narrowDecisions: CodexChatDecision[] = ["accept", "decline", "cancel"];

/** Dedicated camelCase app-server decoder, independent of snake_case exec and sealed Keeper. */
export function createCodexChatStream(options: {
  launch: CodexChatLaunch;
  version: string;
  resumeThreadId: string | null;
}) {
  let threadId: string | null = null,
    turnId: string | null = null;
  let armed = false,
    terminal: "completed" | "failed" | "interrupted" | null = null;
  let usage: CodexChatUsage | null = null,
    frameBytes = 0,
    frameCount = 0,
    textBytes = 0,
    commandBytes = 0;
  const items = new Map<
    string,
    {
      type: string;
      text: string;
      completed: boolean;
      command?: {
        identity: string;
        started: string | null;
        completed: string | null;
        outputBytes: number;
        outputTruncated: boolean;
        report: CodexChatCommand;
      };
    }
  >();
  const scoped = (params: Record<string, unknown>, requireTurn = true) => {
    if (
      !threadId ||
      params.threadId !== threadId ||
      (requireTurn && (!turnId || params.turnId !== turnId))
    )
      throw new Error("Codex protocol identity differs from the owned turn.");
  };
  const bindTurn = (value: unknown): CodexChatEvent[] => {
    if (!armed || !threadId)
      throw new Error("Codex turn arrived before owned admission.");
    const current = turn.parse(value);
    if (turnId !== null && current.id !== turnId)
      throw new Error("Codex protocol turn identity changed.");
    if (turnId) return [];
    turnId = current.id;
    return [{ kind: "turn", threadId, turnId }];
  };
  const message = (
    itemId: string,
    value: string,
    delta: boolean,
    completed: boolean,
  ): CodexChatEvent[] => {
    const previous = items.get(itemId);
    if (previous && previous.type !== "agentMessage")
      throw new Error("Codex item identity changed.");
    const old = previous?.text ?? "";
    const full = delta ? old + value : value;
    if (!full.startsWith(old) || (previous?.completed && full !== old))
      throw new Error(
        "Codex message content conflicts with its private prefix.",
      );
    const suffix = full.slice(old.length);
    textBytes += encoder.encode(suffix).byteLength;
    if (textBytes > 1_048_576 || (!previous && items.size >= 256))
      throw new Error("Codex text exceeds its protocol bound.");
    items.set(itemId, {
      type: "agentMessage",
      text: full,
      completed: completed || previous?.completed === true,
    });
    return suffix ? [{ kind: "text", itemId, text: suffix }] : [];
  };
  const commandReport = (report: CodexChatCommand): CodexChatEvent[] => {
    const bytes = encoder.encode(JSON.stringify(report)).byteLength;
    if (bytes > SESSION_ACTIVITY_LIMITS.eventBytes)
      throw new Error(
        "Codex command activity exceeds its private event bound.",
      );
    commandBytes += bytes;
    if (commandBytes > SESSION_ACTIVITY_LIMITS.aggregateBytes)
      throw new Error(
        "Codex command activity exceeds its private report bound.",
      );
    return [report];
  };
  const command = (
    value: unknown,
    source: "item/started" | "item/completed" | "turn/completed",
  ): CodexChatEvent[] => {
    if (!threadId || !turnId)
      throw new Error("Codex command has no owned native turn identity.");
    const current = nativeCommand.parse(value),
      previous = items.get(current.id),
      identity = JSON.stringify([current.command, current.cwd]),
      signature = JSON.stringify(current);
    if (previous && previous.type !== "commandExecution")
      throw new Error("Codex command item identity changed.");
    if (previous?.command && previous.command.identity !== identity)
      throw new Error("Codex command metadata changed its item identity.");
    if ((source === "item/started") !== (current.status === "inProgress"))
      throw new Error(
        "Codex command status conflicts with its lifecycle source.",
      );
    if (previous?.completed) {
      if (
        source !== "item/started" &&
        previous.command?.completed === signature
      )
        return [];
      throw new Error("Codex command changed after its completed report.");
    }
    if (source === "item/started" && previous?.command?.started) {
      if (previous.command.started === signature) return [];
      throw new Error(
        "Codex command started report conflicts with its original.",
      );
    }
    if (!previous && items.size >= 256)
      throw new Error("Codex items exceed their protocol bound.");
    const output =
      current.aggregatedOutput === null
        ? null
        : reportedText(current.aggregatedOutput);
    const report: CodexChatCommand = {
      kind: "command",
      source,
      threadId,
      turnId,
      itemId: current.id,
      command: reportedText(current.command),
      cwd: current.cwd,
      status: current.status,
      output,
      outputSource: output === null ? null : "aggregate",
      exitCode: current.exitCode,
      durationMs: current.durationMs,
      partial: current.status === "inProgress",
    };
    items.set(current.id, {
      type: "commandExecution",
      text: "",
      completed: current.status !== "inProgress",
      command: {
        identity,
        started: source === "item/started" ? signature : null,
        completed: source === "item/started" ? null : signature,
        outputBytes: output ? encoder.encode(output.text).byteLength : 0,
        outputTruncated: output?.truncated ?? false,
        report,
      },
    });
    return commandReport(report);
  };
  const commandDelta = (params: Record<string, unknown>): CodexChatEvent[] => {
    const itemId = id.parse(params.itemId),
      previous = items.get(itemId),
      current = previous?.command;
    if (!current || previous.type !== "commandExecution" || previous.completed)
      throw new Error("Codex output has no active command item identity.");
    const delta = reportedText(z.string().max(1_048_576).parse(params.delta)),
      capacity = SESSION_ACTIVITY_LIMITS.textBytes - current.outputBytes;
    // Once a portion is omitted, later bytes cannot restore an honest prefix.
    if (current.outputTruncated) return [];
    let retained = "",
      used = 0;
    for (const character of delta.text) {
      const size = encoder.encode(character).byteLength;
      if (used + size > capacity) break;
      retained += character;
      used += size;
    }
    const output = reportedText(retained),
      truncated =
        current.outputTruncated ||
        delta.truncated ||
        retained.length < delta.text.length;
    current.outputBytes += encoder.encode(output.text).byteLength;
    const changed = truncated !== current.outputTruncated;
    current.outputTruncated = truncated;
    if (!output.text && !changed) return [];
    const report: CodexChatCommand = {
      ...current.report,
      source: "item/commandExecution/outputDelta",
      output: { text: output.text, truncated },
      outputSource: "delta",
      exitCode: null,
      durationMs: null,
    };
    return commandReport(report);
  };
  return {
    thread(value: unknown): {
      events: CodexChatEvent[];
      cwd: string;
      writableRoots: string[];
    } {
      if (threadId) throw new Error("Codex thread identity was already bound.");
      const ack = z
        .object({
          thread: z.object({
            id: codexNativeUuidSchema,
            sessionId: codexNativeUuidSchema,
            forkedFromId: z.null(),
            parentThreadId: z.null(),
            status: z.object({ type: z.literal("idle") }),
          }),
          model: id,
          modelProvider: id,
          cwd: z.string().min(1).max(1024),
          approvalPolicy: z.enum(["never", "on-request"]),
          approvalsReviewer: z.literal("user"),
          reasoningEffort: z.string().max(64).nullable(),
          sandbox: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("readOnly"),
              networkAccess: z.literal(false),
            }),
            z.object({
              type: z.literal("workspaceWrite"),
              writableRoots: z.array(z.string().min(1).max(1024)).max(20),
              networkAccess: z.literal(false),
              excludeTmpdirEnvVar: z.boolean(),
              excludeSlashTmp: z.boolean(),
            }),
          ]),
        })
        .parse(value);
      if (
        ack.thread.sessionId !== ack.thread.id ||
        (options.resumeThreadId !== null &&
          ack.thread.id !== options.resumeThreadId) ||
        ack.model !== options.launch.model ||
        ack.approvalPolicy !== options.launch.approvalPolicy ||
        ack.sandbox.type !==
          (options.launch.sandbox === "read-only"
            ? "readOnly"
            : "workspaceWrite")
      )
        throw new Error(
          "Codex acknowledged different owned identity or launch settings.",
        );
      threadId = ack.thread.id;
      return {
        events: [
          {
            kind: "identity",
            provider: "codex",
            threadId,
            version: options.version,
          },
          {
            kind: "configuration",
            model: ack.model,
            modelProvider: ack.modelProvider,
            effort: ack.reasoningEffort,
            cwd: ack.cwd,
          },
        ],
        cwd: ack.cwd,
        writableRoots:
          ack.sandbox.type === "workspaceWrite"
            ? ack.sandbox.writableRoots
            : [],
      };
    },
    armTurn() {
      if (!threadId || armed)
        throw new Error("Codex turn admission is invalid.");
      armed = true;
    },
    turn(value: unknown) {
      return bindTurn(z.object({ turn }).parse(value).turn);
    },
    accept(frame: CodexAppServerFrame): {
      events: CodexChatEvent[];
      approvals: NativeCodexApproval[];
      resolved: (string | number)[];
    } {
      const events: CodexChatEvent[] = [],
        approvals: NativeCodexApproval[] = [],
        resolved: (string | number)[] = [];
      if (frame.kind === "response") return { events, approvals, resolved };
      frameBytes += encoder.encode(JSON.stringify(frame)).byteLength;
      if (++frameCount > 4096 || frameBytes > 8_388_608)
        throw new Error("Codex stream exceeds its protocol bound.");
      const params = object(frame.params);
      if (frame.kind === "request") {
        scoped(params);
        if (terminal || options.launch.approvalPolicy === "never")
          throw new Error(
            "Codex approval arrived outside an allowed live turn.",
          );
        const base = {
          nativeRequestId: frame.id,
          threadId: codexNativeUuidSchema.parse(params.threadId),
          turnId: codexNativeUuidSchema.parse(params.turnId),
          itemId: id.parse(params.itemId),
          reason:
            z.string().max(16_384).nullable().optional().parse(params.reason) ??
            null,
        };
        z.number().safe().nonnegative().parse(params.startedAtMs);
        if (frame.method === "item/commandExecution/requestApproval") {
          if (
            params.kind !== "command" ||
            params.environmentId !== null ||
            [params.networkApprovalContext, params.additionalPermissions].some(
              (value) => value !== undefined && value !== null,
            )
          )
            throw new Error("Codex requested unsupported broader permissions.");
          if (
            items.get(base.itemId)?.type !== "commandExecution" ||
            items.get(base.itemId)?.completed
          )
            throw new Error("Codex approval item identity is unavailable.");
          const offered =
            params.availableDecisions === undefined ||
            params.availableDecisions === null
              ? narrowDecisions
              : z
                  .array(z.unknown())
                  .max(16)
                  .parse(params.availableDecisions)
                  .filter(
                    (value): value is CodexChatDecision =>
                      value === "accept" ||
                      value === "decline" ||
                      value === "cancel",
                  );
          if (!offered.length)
            throw new Error(
              "Codex has no supported narrow approval decisions.",
            );
          approvals.push({
            ...base,
            kind: "command",
            nativeApprovalId:
              id.nullable().optional().parse(params.approvalId) ?? null,
            command: z.string().min(1).max(16_384).parse(params.command),
            cwd: z.string().min(1).max(1024).parse(params.cwd),
            availableDecisions: [...new Set(offered)],
          });
        } else if (frame.method === "item/fileChange/requestApproval") {
          if (params.grantRoot !== undefined && params.grantRoot !== null)
            throw new Error(
              "Codex requested an unsupported session-wide grant.",
            );
          if (
            items.get(base.itemId)?.type !== "fileChange" ||
            items.get(base.itemId)?.completed
          )
            throw new Error("Codex approval item identity is unavailable.");
          approvals.push({
            ...base,
            kind: "file-change",
            nativeApprovalId: null,
            command: null,
            cwd: null,
            availableDecisions: [...narrowDecisions],
          });
        } else
          throw new Error("Codex requested an unsupported client operation.");
      } else if (frame.method === "warning") {
        const warning = z
          .object({
            threadId: codexNativeUuidSchema.nullable(),
            message: z.string().max(16_384),
          })
          .strict()
          .parse(params);
        if (warning.threadId !== null) scoped(warning, false);
        // Non-fatal diagnostics remain private; neither global nor scoped bodies enter events.
      } else if (frame.method === "thread/started") {
        const announced = z
          .object({
            id: codexNativeUuidSchema,
            sessionId: codexNativeUuidSchema.optional(),
            forkedFromId: z.null().optional(),
            parentThreadId: z.null().optional(),
          })
          .parse(params.thread);
        if (
          !threadId ||
          announced.id !== threadId ||
          (announced.sessionId !== undefined &&
            announced.sessionId !== threadId)
        )
          throw new Error(
            "Codex announced a different native thread identity.",
          );
      } else if (frame.method === "turn/started") {
        scoped(params, false);
        events.push(...bindTurn(params.turn));
      } else if (frame.method === "turn/completed") {
        scoped(params, false);
        const finished = z
          .object({
            id: codexNativeUuidSchema,
            status: z.enum(["completed", "failed", "interrupted"]),
            items: z.array(z.unknown()).max(256),
            error: z.unknown(),
          })
          .parse(params.turn);
        if (!turnId || finished.id !== turnId || terminal)
          throw new Error(
            "Codex terminal identity conflicts with the owned turn.",
          );
        if (finished.status === "completed" && finished.error !== null)
          throw new Error("Codex completed turn carries an error.");
        for (const value of finished.items) {
          const final = item.parse(value);
          if (final.type === "agentMessage")
            events.push(
              ...message(final.id, z.string().parse(final.text), false, true),
            );
          else if (final.type === "commandExecution")
            events.push(...command(value, "turn/completed"));
        }
        terminal = finished.status;
      } else if (frame.method === "serverRequest/resolved") {
        scoped(params, false);
        resolved.push(nativeRequestId.parse(params.requestId));
      } else if (frame.method === "item/commandExecution/outputDelta") {
        scoped(params);
        if (terminal)
          throw new Error(
            "Codex command output arrived after its terminal result.",
          );
        events.push(...commandDelta(params));
      } else if (frame.method === "item/agentMessage/delta") {
        scoped(params);
        if (terminal)
          throw new Error("Codex text arrived after its terminal result.");
        events.push(
          ...message(
            id.parse(params.itemId),
            z.string().max(1_048_576).parse(params.delta),
            true,
            false,
          ),
        );
      } else if (
        frame.method === "item/started" ||
        frame.method === "item/completed"
      ) {
        scoped(params);
        if (terminal)
          throw new Error(
            "Codex item content arrived after its terminal result.",
          );
        const current = item.parse(params.item),
          old = items.get(current.id);
        if (old && old.type !== current.type)
          throw new Error("Codex item identity changed.");
        if (current.type === "commandExecution")
          events.push(...command(params.item, frame.method));
        else if (current.type === "agentMessage")
          events.push(
            ...message(
              current.id,
              z.string().parse(current.text),
              false,
              frame.method === "item/completed",
            ),
          );
        else {
          if (!old && items.size >= 256)
            throw new Error("Codex items exceed their protocol bound.");
          items.set(current.id, {
            type: current.type,
            text: "",
            completed: frame.method === "item/completed",
          });
        }
      } else if (frame.method === "thread/tokenUsage/updated") {
        scoped(params);
        const reported = z
          .object({ last: counts, total: counts })
          .parse(params.tokenUsage);
        const map = (value: z.infer<typeof counts>) => ({
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
          cachedInputTokens: value.cachedInputTokens,
          cacheWriteInputTokens: value.cacheWriteInputTokens,
          reasoningOutputTokens: value.reasoningOutputTokens,
        });
        usage = {
          lastResponse: map(reported.last),
          threadTotal: map(reported.total),
        };
        events.push({ kind: "usage", usage });
      } else if (frame.method === "model/rerouted") {
        scoped(params);
        events.push({
          kind: "reroute",
          fromModel: id.parse(params.fromModel),
          toModel: id.parse(params.toModel),
          reason: z.literal("highRiskCyberActivity").parse(params.reason),
        });
      } else if (frame.method === "error")
        throw new Error("Codex reported a native turn error.");
      else if (Object.hasOwn(params, "threadId"))
        scoped(params, Object.hasOwn(params, "turnId"));
      return { events, approvals, resolved };
    },
    state: () => ({ threadId, turnId, terminal, usage }),
  };
}
