import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import type {
  CodexChatApproval,
  CodexChatBinding,
  CodexChatCapabilities,
  CodexChatDecision,
  CodexChatEvent,
  CodexChatLaunch,
  CodexChatOutcome,
  PreparedCodexChat,
} from "../../types/codex-chat";
import type { CodexModelEffortEvidence } from "../../types/codex-task";
import { loadConfig } from "../config/load";
import { codexSyncDirectory } from "../executors/codex";
import { buildChildEnv } from "../executors/env";
import { type InteractiveSupervised, supervise } from "../executors/supervisor";
import {
  codexChatCapabilitiesSchema,
  codexChatLaunchSchema,
  codexNativeUuidSchema,
  createCodexChatStream,
  type NativeCodexApproval,
  nativeRequestKey,
  parseCodexAppServerFrame,
  preparedCodexChatSchema,
  serializeCodexChat,
} from "./codex-app-server-protocol";
import {
  buildCodexChatForkParams,
  parseCodexChatForkRuntimeInput,
  type VerifiedNativeCodexChatFork,
  verifyCodexChatForkResponse,
} from "./codex-chat-fork-runtime-protocol";

export interface CodexChatRuntimeOptions {
  root: string;
  home: string;
  configHome?: string;
  /** Trusted fixture/embedding prefixes only, never public launch fields. */
  command?: readonly string[];
  syncCommand?: readonly string[];
  environment?: Record<string, string | undefined>;
  operatorToken?: () => string | null;
  modelEfforts?: readonly CodexModelEffortEvidence[];
  timeoutMs?: number;
  rpcTimeoutMs?: number;
  approvalTimeoutMs?: number;
  persistenceTimeoutMs?: number;
}
export interface CodexChatCallbacks {
  /** Trusted authority seam. A future protected operator route must own this decision. */
  requestApproval(
    approval: Readonly<CodexChatApproval>,
    signal: AbortSignal,
  ): Promise<CodexChatDecision>;
}
const directory = (path: string) => {
  try {
    if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error();
    const value = realpathSync.native(path);
    return process.platform === "win32" ? value.toLowerCase() : value;
  } catch {
    throw new Error("The prepared Codex Chat directory is unavailable.");
  }
};
function bounded<T>(
  operation: () => PromiseLike<T> | T,
  ms: number,
  signal: AbortSignal | undefined,
  message: string,
  timeoutError?: Error,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(message));
      return;
    }
    let done = false;
    const finish = (
      result: { ok: true; value: T } | { ok: false; error: unknown },
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };
    const abort = () =>
      finish({ ok: false, error: timeoutError ?? new Error(message) });
    const timer = setTimeout(abort, ms);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      Promise.resolve(operation()).then(
        (value) => finish({ ok: true, value }),
        (error: unknown) => finish({ ok: false, error }),
      );
    } catch (error) {
      finish({ ok: false, error });
    }
  });
}
class CodexChatPersistenceDeadlineError extends Error {
  constructor() {
    super("Private Chat persistence deadline exceeded.");
    this.name = "CodexChatPersistenceDeadlineError";
  }
}
const freeze = (value: unknown): void => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
};

/** Standalone native Chat. Scope, private lease, original identity and retry authority stay with its trusted caller. */
export function createCodexChatRuntime(options: CodexChatRuntimeOptions) {
  const root = directory(options.root),
    command = options.command ? [...options.command] : null;
  const syncCommand = options.syncCommand ? [...options.syncCommand] : null;
  const modelEfforts = options.modelEfforts
    ? structuredClone(options.modelEfforts)
    : undefined;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000,
    rpcTimeoutMs = options.rpcTimeoutMs ?? 5000;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000,
    persistenceTimeoutMs = options.persistenceTimeoutMs ?? 5000;
  for (const [value, max] of [
    [timeoutMs, 30 * 60_000],
    [rpcTimeoutMs, 30_000],
    [approvalTimeoutMs, 5 * 60_000],
    [persistenceTimeoutMs, 30_000],
  ])
    if (
      !Number.isSafeInteger(value) ||
      value === undefined ||
      max === undefined ||
      value < 1 ||
      value > max
    )
      throw new Error("Codex Chat deadlines are invalid.");
  const native = (prefix: readonly string[]) => {
    const executable = prefix[0] ? Bun.which(prefix[0]) : null;
    if (
      !executable ||
      prefix.length > 16 ||
      prefix.some(
        (word) => !word || word.length > 4096 || word.includes("\0"),
      ) ||
      (process.platform === "win32" && !/\.exe$/i.test(executable))
    )
      throw new Error("A native Codex executable is required.");
    return [executable, ...prefix.slice(1)];
  };
  const ready = (smith: string) => {
    const loaded = loadConfig({
      harnessRoot: options.root,
      env: {},
      ...(options.configHome ? { home: options.configHome } : {}),
    });
    const selected = loaded.config.smiths[smith];
    if (!selected?.enabled || selected.provider !== "codex")
      throw new Error("The selected smith is not an enabled Codex smith.");
    const env = buildChildEnv(
        options.environment ?? process.env,
        loaded.config.execution.envPass,
      ),
      token = options.operatorToken?.() ?? null;
    for (const [name, value] of Object.entries(env))
      if (
        /^agent_forge_/i.test(name) ||
        /^forge_slug$/i.test(name) ||
        (token && value.includes(token))
      )
        delete env[name];
    env.AGENT_FORGE_ADAPTER = "1";
    env.AGENT_FORGE_HOME = options.home;
    return { env, command: native(command ?? [Bun.which("codex") ?? ""]) };
  };
  const inspect = async (
    runtime: ReturnType<typeof ready>,
    signal?: AbortSignal,
  ): Promise<CodexChatCapabilities> => {
    const probe = async (args: string[]) => {
      if (signal?.aborted)
        throw new Error("Codex Chat preparation was stopped.");
      let text = "",
        invalid = false;
      const child = supervise({
        command: [...runtime.command, ...args],
        cwd: options.root,
        env: runtime.env,
        stdinMode: "interactive",
        timeoutMs: 5000,
        maxLineBytes: 65_536,
        onOutputError: () => {
          invalid = true;
        },
        onLine: (line) => {
          text += `${line}\n`;
          if (text.length > 131_072) throw new Error("Probe bound");
        },
      });
      const stop = () => {
        void child.stop("Chat probe stopped");
      };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        await child.end().catch(() => undefined);
        const exit = await child.done;
        if (invalid || exit.exitCode !== 0 || exit.timedOut || exit.stopped)
          throw new Error("The Codex Chat capability probe failed.");
        return text;
      } finally {
        signal?.removeEventListener("abort", stop);
        await child.done;
      }
    };
    const version =
      /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)(?:\s|$)/.exec(
        await probe(["--version"]),
      )?.[1];
    if (!version) throw new Error("Codex did not report a usable CLI version.");
    const help = await probe(["app-server", "--help"]);
    return codexChatCapabilitiesSchema.parse({
      version,
      flags: [
        ...new Set(
          [...help.matchAll(/(?:^|\s)(--[A-Za-z][A-Za-z0-9-]*)\b/g)].map(
            (match) => match[1] ?? "",
          ),
        ),
      ],
      ...(modelEfforts ? { modelEfforts } : {}),
    });
  };
  const validate = (snapshot: PreparedCodexChat) => {
    if (
      directory(options.root) !== root ||
      directory(snapshot.cwd) !== snapshot.canonicalCwd ||
      snapshot.cwd !== snapshot.launch.cwd ||
      (snapshot.launch.context &&
        directory(snapshot.launch.context.worktree) !== snapshot.canonicalCwd)
    )
      throw new Error(
        "The immutable Codex Chat directory changed after preparation.",
      );
    serializeCodexChat(snapshot.launch, snapshot.capabilities);
  };
  return {
    check: (input: { smith: string }) => inspect(ready(input.smith)),
    async prepare(input: {
      smith: string;
      launch: CodexChatLaunch;
    }): Promise<PreparedCodexChat> {
      const launch = codexChatLaunchSchema.parse(input.launch),
        canonicalCwd = directory(launch.cwd);
      const capabilities = await inspect(ready(input.smith));
      serializeCodexChat(launch, capabilities);
      const snapshot = preparedCodexChatSchema.parse({
        version: 1,
        provider: "codex",
        smith: input.smith,
        cwd: launch.cwd,
        canonicalCwd,
        launch,
        capabilities,
      });
      validate(snapshot);
      freeze(snapshot);
      return snapshot;
    },
    /** One bounded native Fork transaction. The caller owns the durable attempt fence. */
    async fork(value: unknown): Promise<VerifiedNativeCodexChatFork> {
      const input = parseCodexChatForkRuntimeInput(value),
        snapshot = input.prepared;
      validate(snapshot);
      if (input.signal?.aborted)
        throw new Error("Native Fork was stopped before startup.");
      if (directory(snapshot.canonicalCwd) !== snapshot.canonicalCwd)
        throw new Error("The prepared Codex Chat workspace is not canonical.");
      const runtime = ready(snapshot.smith),
        forkParams = buildCodexChatForkParams(input),
        control = new AbortController();
      const stop = () => control.abort();
      input.signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, timeoutMs);
      let child: InteractiveSupervised | null = null,
        exit: Awaited<InteractiveSupervised["done"]> | null = null,
        startedThreadId: string | null = null,
        relatedThreadIds: string[] = [],
        verifiedThreadId: string | null = null,
        failure: Error | null = null,
        nextId = 1;
      const pending = new Map<
        string,
        { resolve(value: unknown): void; reject(error: Error): void }
      >();
      const insideWorkspace = (path: string) => {
        const rel = relative(snapshot.canonicalCwd, directory(path));
        return !(
          rel === ".." ||
          rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
          isAbsolute(rel)
        );
      };
      const fail = (message: string) => {
        if (failure) return;
        failure = new Error(message);
        for (const rpc of pending.values()) rpc.reject(failure);
        pending.clear();
      };
      try {
        if (control.signal.aborted) throw new Error("Fork was stopped.");
        const capabilities = await inspect(runtime, control.signal);
        if (capabilities.version !== snapshot.capabilities.version)
          throw new Error("Codex version changed before Fork.");
        validate(snapshot);
        serializeCodexChat(snapshot.launch, capabilities);
        if (control.signal.aborted) throw new Error("Fork was stopped.");
        child = supervise({
          command: [...runtime.command, "app-server", "--stdio"],
          cwd: snapshot.cwd,
          env: { ...runtime.env, AGENT_FORGE_SMITH: snapshot.smith },
          stdinMode: "interactive",
          maxStdinBytes: 1_048_576,
          stdinTimeoutMs: rpcTimeoutMs,
          timeoutMs,
          maxLineBytes: 1_048_576,
          onOutputError: () => fail("Native Fork output could not be read."),
          onLine(line) {
            if (failure) return;
            try {
              const frame = parseCodexAppServerFrame(line);
              if (frame.kind === "request") {
                fail("Native Fork made an unsupported server request.");
                return;
              }
              if (frame.kind !== "response") {
                if (frame.method === "warning") {
                  const warning = z
                    .object({
                      threadId: codexNativeUuidSchema.nullable(),
                      message: z.string().max(4096),
                    })
                    .strict()
                    .safeParse(frame.params);
                  if (!warning.success) {
                    fail("Native Fork emitted a malformed warning.");
                    return;
                  }
                  return;
                }
                if (
                  frame.method === "thread/started" &&
                  startedThreadId === null
                ) {
                  const notification = z
                    .object({
                      thread: z
                        .object({ id: codexNativeUuidSchema })
                        .passthrough(),
                    })
                    .passthrough()
                    .safeParse(frame.params);
                  if (!notification.success) {
                    fail("Native Fork emitted a malformed child notification.");
                    return;
                  }
                  startedThreadId = notification.data.thread.id;
                  if (verifiedThreadId && startedThreadId !== verifiedThreadId)
                    fail("Native Fork notification changed child identity.");
                  return;
                }
                if (frame.method === "thread/goal/updated") {
                  if (relatedThreadIds.length >= 8) {
                    fail("Native Fork emitted too many thread notifications.");
                    return;
                  }
                  const notification = z
                    .object({ threadId: codexNativeUuidSchema })
                    .passthrough()
                    .safeParse(frame.params);
                  if (!notification.success) {
                    fail(
                      "Native Fork emitted a malformed thread notification.",
                    );
                    return;
                  }
                  relatedThreadIds.push(notification.data.threadId);
                  if (
                    verifiedThreadId &&
                    notification.data.threadId !== verifiedThreadId
                  )
                    fail("Native Fork notification changed child identity.");
                  return;
                }
                fail("Native Fork emitted an unexpected server notification.");
                return;
              }
              const key = nativeRequestKey(frame.id),
                rpc = pending.get(key);
              if (!rpc) throw new Error("Unmatched Fork response");
              pending.delete(key);
              if (frame.error) rpc.reject(new Error("Codex refused Fork."));
              else rpc.resolve(frame.result);
            } catch {
              fail(
                "The native Fork protocol was malformed or changed identity.",
              );
            }
          },
        });
        const active = child;
        void active.done.then(
          (result) => {
            exit = result;
            if (pending.size) fail("Codex exited before acknowledging Fork.");
          },
          () =>
            fail(
              "The owned native Fork process cleanup could not be confirmed.",
            ),
        );
        const rpc = async (
          method: string,
          params: unknown,
        ): Promise<unknown> => {
          if (control.signal.aborted || failure)
            throw failure ?? new Error("Fork was stopped.");
          const id = nextId++,
            key = nativeRequestKey(id);
          const response = new Promise<unknown>((resolve, reject) =>
            pending.set(key, { resolve, reject }),
          );
          void response.catch(() => undefined);
          await bounded(
            () => active.write(`${JSON.stringify({ id, method, params })}\n`),
            rpcTimeoutMs,
            control.signal,
            "Native Fork input did not settle.",
          );
          return bounded(
            () => response,
            rpcTimeoutMs,
            control.signal,
            "Native Fork acknowledgement did not settle.",
          );
        };
        await rpc("initialize", {
          clientInfo: {
            name: "agent_forge",
            title: "Agent Forge",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }).then((value) => {
          z.object({
            userAgent: z.string().max(1024),
            codexHome: z.string().max(1024),
            platformFamily: z.string().max(100),
            platformOs: z.string().max(100),
          })
            .strict()
            .parse(value);
        });
        await bounded(
          () =>
            active.write(
              `${JSON.stringify({ method: "initialized", params: {} })}\n`,
            ),
          rpcTimeoutMs,
          control.signal,
          "Native Fork initialization did not settle.",
        );
        const response = await rpc("thread/fork", forkParams);
        const verified = verifyCodexChatForkResponse(response, input);
        verifiedThreadId = verified.threadId;
        if (
          (startedThreadId && startedThreadId !== verifiedThreadId) ||
          relatedThreadIds.some((id) => id !== verifiedThreadId)
        )
          throw new Error("Native Fork notification changed child identity.");
        if (
          directory(verified.settings.cwd) !== snapshot.canonicalCwd ||
          verified.runtimeWorkspaceRoots.some(
            (path) => !insideWorkspace(path),
          ) ||
          verified.writableRoots.some((path) => !insideWorkspace(path))
        )
          throw new Error(
            "Native Fork returned a non-canonical workspace path.",
          );
        validate(snapshot);
        await bounded(
          () => active.end(),
          rpcTimeoutMs,
          control.signal,
          "Native Fork shutdown did not settle.",
        );
        exit = await bounded(
          () => active.done,
          rpcTimeoutMs,
          undefined,
          "Native Fork process exit did not settle.",
        );
        if (exit.exitCode !== 0 || exit.timedOut || exit.stopped)
          throw new Error("Native Fork process did not close cleanly.");
        if (failure) throw failure;
        if (startedThreadId !== verifiedThreadId)
          throw new Error("Native Fork child notification was not confirmed.");
        if (relatedThreadIds.some((id) => id !== verifiedThreadId))
          throw new Error("Native Fork notification changed child identity.");
        return verified;
      } catch (error) {
        throw error instanceof Error ? error : new Error("Native Fork failed.");
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", stop);
        if (child) {
          if (!exit)
            await child.stop("Native Fork finalization").catch(() => undefined);
          exit = await child.done;
        }
        for (const rpc of pending.values())
          rpc.reject(new Error("Native Fork ended."));
        pending.clear();
      }
    },
    async run(
      input: { prepared: PreparedCodexChat; resume: CodexChatBinding | null },
      persist: (event: CodexChatEvent) => Promise<void>,
      signal: AbortSignal,
      callbacks: CodexChatCallbacks,
    ): Promise<CodexChatOutcome> {
      const snapshot = preparedCodexChatSchema.parse(input.prepared);
      validate(snapshot);
      const resume =
        input.resume === null
          ? null
          : z
              .object({
                provider: z.literal("codex"),
                threadId: codexNativeUuidSchema,
                version: z.literal(snapshot.capabilities.version),
              })
              .strict()
              .parse(input.resume);
      const runtime = ready(snapshot.smith),
        control = new AbortController();
      const stream = createCodexChatStream({
        launch: snapshot.launch,
        version: snapshot.capabilities.version,
        resumeThreadId: resume?.threadId ?? null,
      });
      let child: InteractiveSupervised | null = null,
        failure: { phase: "failed" | "unknown"; reason: string } | null = null;
      let providerProcessId: number | null = null;
      let timedOut = false,
        stopped = false,
        privateWriteFailed = false,
        writes = Promise.resolve(),
        queuedFrames = 0,
        queuedBytes = 0;
      const pending = new Map<
        string,
        {
          resolve(value: unknown): void;
          reject(error: Error): void;
          accept?: (value: unknown) => void;
        }
      >();
      const approvals = new Map<
        string,
        {
          fingerprint: string;
          approval: CodexChatApproval;
          controller: AbortController;
          closed: boolean;
        }
      >();
      const approvalTasks = new Set<Promise<void>>();
      const latch = (phase: "failed" | "unknown", reason: string) => {
        if (!failure || (phase === "unknown" && failure.phase !== "unknown"))
          failure = { phase, reason };
        control.abort();
        for (const rpc of pending.values()) rpc.reject(new Error(reason));
        pending.clear();
        for (const entry of approvals.values()) {
          entry.closed = true;
          entry.controller.abort();
        }
        if (child) void child.stop(reason);
      };
      const enqueue = (event: CodexChatEvent) => {
        if (failure) return Promise.resolve();
        const copy = structuredClone(event),
          bytes = Buffer.byteLength(JSON.stringify(copy));
        if (queuedFrames >= 256 || queuedBytes + bytes > 1_048_576) {
          latch("unknown", "The private Chat writer exceeded its queue bound.");
          return Promise.resolve();
        }
        queuedFrames++;
        queuedBytes += bytes;
        const next = writes
          .then(async () => {
            if (failure) return;
            try {
              await bounded(
                () => persist(copy),
                persistenceTimeoutMs,
                // Stop cancels protocol work, while an already-started private
                // save retains its own bounded chance to preserve that report.
                undefined,
                "Private Chat persistence did not settle.",
                new CodexChatPersistenceDeadlineError(),
              );
            } catch (error) {
              privateWriteFailed = true;
              latch(
                "unknown",
                error instanceof CodexChatPersistenceDeadlineError
                  ? "The private Chat writer exceeded its deadline."
                  : "The private Chat writer failed.",
              );
            }
          })
          .finally(() => {
            queuedFrames--;
            queuedBytes -= bytes;
          });
        writes = next;
        return next;
      };
      const resolveApproval = (
        key: string,
        source: "serverRequest/resolved" | "turn/completed",
      ) => {
        const entry = approvals.get(key);
        if (!entry)
          throw new Error("Native resolution has no matching live approval.");
        if (entry.closed) return;
        entry.closed = true;
        entry.controller.abort();
        void enqueue({
          kind: "approval-resolved",
          approvalId: entry.approval.id,
          source,
        });
      };
      const requestApproval = (native: NativeCodexApproval) => {
        if (!child || !providerProcessId || failure)
          throw new Error("Native approval has no live owner.");
        const key = nativeRequestKey(native.nativeRequestId),
          fingerprint = JSON.stringify(native),
          previous = approvals.get(key);
        if (previous) {
          if (previous.closed)
            throw new Error("Native approval identity is no longer live.");
          if (previous.fingerprint !== fingerprint)
            throw new Error("Native approval identity changed.");
          return;
        }
        if (approvals.size >= 128)
          throw new Error("Native approvals exceeded their bound.");
        const approval: CodexChatApproval = {
          ...native,
          id: randomUUID(),
          provider: "codex",
          processId: providerProcessId,
        };
        freeze(approval);
        const entry = {
          fingerprint,
          approval,
          controller: new AbortController(),
          closed: false,
        };
        approvals.set(key, entry);
        const active = child;
        let task: Promise<void>;
        task = (async () => {
          await enqueue({ kind: "approval-request", approval });
          if (failure || entry.closed) return;
          const raw = await bounded(
            () => callbacks.requestApproval(approval, entry.controller.signal),
            approvalTimeoutMs,
            entry.controller.signal,
            "The native approval decision did not settle.",
          );
          if (failure || entry.closed) return;
          const decision = z.enum(["accept", "decline", "cancel"]).parse(raw);
          if (!approval.availableDecisions.includes(decision))
            throw new Error("The native approval did not offer that decision.");
          await enqueue({
            kind: "approval-decision",
            approvalId: approval.id,
            decision,
          });
          if (failure || entry.closed) return;
          await bounded(
            () =>
              active.write(
                `${JSON.stringify({ id: native.nativeRequestId, result: { decision } })}\n`,
              ),
            rpcTimeoutMs,
            entry.controller.signal,
            "The native approval reply did not settle.",
          );
        })()
          .catch(() => {
            if (!entry.closed && !failure)
              latch(
                "unknown",
                "The native approval was unsupported or exceeded its decision deadline.",
              );
          })
          .finally(() => {
            approvalTasks.delete(task);
          });
        approvalTasks.add(task);
      };
      let resolveTerminal: () => void = () => undefined;
      const terminal = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      const stop = () => {
        stopped = true;
        latch("failed", "The Codex Chat turn was stopped.");
      };
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        latch("unknown", "The Codex Chat turn exceeded its deadline.");
      }, timeoutMs);
      let exit: Awaited<InteractiveSupervised["done"]> | null = null;
      try {
        if (signal.aborted) stop();
        if (control.signal.aborted) throw new Error();
        const capabilities = await inspect(runtime, control.signal);
        if (capabilities.version !== snapshot.capabilities.version)
          throw new Error("Codex version changed.");
        validate(snapshot);
        const serialized = serializeCodexChat(snapshot.launch, capabilities);
        const syncCwd = codexSyncDirectory({
          workspace: options.root,
          worktree: snapshot.cwd,
        });
        if (syncCwd) {
          let syncBytes = 0,
            syncInvalid = false;
          const sync = supervise({
            command: native(
              syncCommand ?? [Bun.which("bun") ?? "", "run", "codex:sync"],
            ),
            cwd: syncCwd,
            env: runtime.env,
            stdinMode: "interactive",
            timeoutMs: Math.min(timeoutMs, 30_000),
            maxLineBytes: 65_536,
            onOutputError: () => {
              syncInvalid = true;
            },
            onLine: (line) => {
              syncBytes += Buffer.byteLength(line);
              if (syncBytes > 131_072)
                throw new Error("Chat sync output bound");
            },
          });
          const cancel = () => {
            void sync.stop("Chat sync stopped");
          };
          control.signal.addEventListener("abort", cancel, { once: true });
          try {
            if (control.signal.aborted) cancel();
            await sync.end().catch(() => undefined);
            const result = await sync.done;
            if (
              syncInvalid ||
              result.exitCode !== 0 ||
              result.timedOut ||
              result.stopped
            )
              throw new Error("Chat sync failed.");
          } finally {
            control.signal.removeEventListener("abort", cancel);
            await sync.done;
          }
        }
        validate(snapshot);
        if (control.signal.aborted) throw new Error();
        child = supervise({
          command: [...runtime.command, ...serialized.argv],
          cwd: snapshot.cwd,
          env: {
            ...runtime.env,
            AGENT_FORGE_SMITH: snapshot.smith,
            ...(snapshot.launch.context?.beadId
              ? { AGENT_FORGE_BEAD: snapshot.launch.context.beadId }
              : {}),
          },
          stdinMode: "interactive",
          maxStdinBytes: 8_388_608,
          stdinTimeoutMs: rpcTimeoutMs,
          timeoutMs,
          maxLineBytes: 1_048_576,
          onOutputError: () =>
            latch("unknown", "The native Chat output reader failed."),
          onLine(line) {
            if (failure) return;
            try {
              const frame = parseCodexAppServerFrame(line);
              if (frame.kind === "response") {
                const key = nativeRequestKey(frame.id),
                  rpc = pending.get(key);
                if (!rpc) throw new Error("Unmatched native response");
                pending.delete(key);
                if (frame.error) {
                  rpc.reject(new Error("Codex refused a protocol request."));
                  latch("unknown", "Codex refused a native protocol request.");
                } else {
                  rpc.accept?.(frame.result);
                  rpc.resolve(frame.result);
                }
              } else {
                const decoded = stream.accept(frame);
                for (const event of decoded.events) void enqueue(event);
                for (const approval of decoded.approvals)
                  requestApproval(approval);
                for (const id of decoded.resolved)
                  resolveApproval(
                    nativeRequestKey(id),
                    "serverRequest/resolved",
                  );
                if (stream.state().terminal !== null) {
                  for (const [key, entry] of approvals)
                    if (!entry.closed) resolveApproval(key, "turn/completed");
                  resolveTerminal();
                }
              }
            } catch {
              latch(
                "unknown",
                "The native Chat protocol was malformed or changed identity.",
              );
            }
          },
        });
        const active = child;
        void child.done.then(
          (value) => {
            exit = value;
            if (stream.state().terminal === null && !failure)
              latch(
                "unknown",
                "Codex exited before a confirmed terminal turn.",
              );
          },
          () =>
            latch(
              "unknown",
              "The owned native process cleanup could not be confirmed.",
            ),
        );
        const providerPid = await bounded(
          () => active.providerPid,
          rpcTimeoutMs,
          control.signal,
          "The owned provider startup did not settle.",
        );
        providerProcessId = providerPid;
        await enqueue({
          kind: "process",
          pid: providerPid,
          wrapperPid: child.pid,
          smith: snapshot.smith,
          requestedModel: snapshot.launch.model,
          requestedEffort: snapshot.launch.effort ?? null,
        });
        let nextId = 1;
        const rpc = async (
          method: string,
          params: unknown,
          accept?: (value: unknown) => void,
        ) => {
          if (control.signal.aborted) throw new Error();
          const id = nextId++,
            key = nativeRequestKey(id);
          const response = new Promise<unknown>((resolve, reject) => {
            pending.set(key, {
              resolve,
              reject,
              ...(accept ? { accept } : {}),
            });
          });
          void response.catch(() => undefined);
          await bounded(
            () => active.write(`${JSON.stringify({ id, method, params })}\n`),
            rpcTimeoutMs,
            control.signal,
            "Native Chat input did not settle.",
          );
          return bounded(
            () => response,
            rpcTimeoutMs,
            control.signal,
            "Native Chat acknowledgement did not settle.",
          );
        };
        await rpc(
          "initialize",
          {
            clientInfo: {
              name: "agent_forge",
              title: "Agent Forge",
              version: "0.1.0",
            },
            capabilities: { experimentalApi: false, requestAttestation: false },
          },
          (value) => {
            z.object({
              userAgent: z.string().max(1024),
              codexHome: z.string().max(1024),
              platformFamily: z.string().max(100),
              platformOs: z.string().max(100),
            }).parse(value);
          },
        );
        await bounded(
          () =>
            active.write(
              `${JSON.stringify({ method: "initialized", params: {} })}\n`,
            ),
          rpcTimeoutMs,
          control.signal,
          "Native Chat initialization did not settle.",
        );
        const threadParams = resume
          ? {
              threadId: resume.threadId,
              excludeTurns: true,
              model: serialized.thread.model,
              cwd: serialized.thread.cwd,
              sandbox: serialized.thread.sandbox,
              approvalPolicy: serialized.thread.approvalPolicy,
              approvalsReviewer: "user",
            }
          : { ...serialized.thread, allowProviderModelFallback: false };
        await rpc(
          resume ? "thread/resume" : "thread/start",
          threadParams,
          (value) => {
            const ack = stream.thread(value);
            if (
              directory(ack.cwd) !== snapshot.canonicalCwd ||
              ack.writableRoots.some((path) => {
                const rel = relative(snapshot.canonicalCwd, directory(path));
                return (
                  rel === ".." ||
                  rel.startsWith(
                    `..${process.platform === "win32" ? "\\" : "/"}`,
                  ) ||
                  isAbsolute(rel)
                );
              })
            )
              throw new Error("Native Chat scope changed.");
            for (const event of ack.events) void enqueue(event);
          },
        );
        await writes;
        if (control.signal.aborted) throw new Error();
        validate(snapshot);
        stream.armTurn();
        await rpc(
          "turn/start",
          {
            threadId: stream.state().threadId,
            input: [serialized.input],
            cwd: snapshot.cwd,
            model: snapshot.launch.model,
            ...(serialized.effort === null
              ? {}
              : { effort: serialized.effort }),
            approvalPolicy: snapshot.launch.approvalPolicy,
            approvalsReviewer: "user",
            environments: [],
            sandboxPolicy:
              snapshot.launch.sandbox === "read-only"
                ? { type: "readOnly", networkAccess: false }
                : {
                    type: "workspaceWrite",
                    writableRoots: [snapshot.cwd],
                    networkAccess: false,
                    excludeTmpdirEnvVar: true,
                    excludeSlashTmp: true,
                  },
          },
          (value) => {
            for (const event of stream.turn(value)) void enqueue(event);
          },
        );
        await bounded(
          () => terminal,
          timeoutMs,
          control.signal,
          "Native Chat terminal result did not settle.",
        );
        await writes;
        let eofError: unknown = null;
        try {
          await active.end();
        } catch (error) {
          eofError = error;
        }
        exit = await bounded(
          () => active.done,
          rpcTimeoutMs,
          undefined,
          "Native Chat shutdown did not settle.",
        );
        if (
          eofError &&
          (!(eofError instanceof Error) || !eofError.message.includes("closed"))
        )
          latch("unknown", "The native Chat input did not close cleanly.");
      } catch {
        if (!failure)
          latch(
            "unknown",
            "The native Chat turn could not complete its bounded protocol.",
          );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        for (const entry of approvals.values()) {
          entry.closed = true;
          entry.controller.abort();
        }
        if (child) {
          if (failure) await child.stop("Chat finalization");
          exit = await child.done;
        }
        await Promise.allSettled([...approvalTasks]);
        await writes;
      }
      const current = stream.state();
      const readFailure = (): {
        phase: "failed" | "unknown";
        reason: string;
      } | null => failure;
      const failed = readFailure();
      const completed =
        current.terminal === "completed" &&
        exit?.exitCode === 0 &&
        !exit.timedOut &&
        !exit.stopped;
      let outcome: CodexChatOutcome = {
        phase: failed?.phase ?? (completed ? "completed" : "failed"),
        reason:
          failed?.reason ??
          (completed
            ? null
            : "Codex did not complete the owned Chat turn successfully."),
        threadId: current.threadId,
        turnId: current.turnId,
        observedModel: null,
        usage: current.usage,
        exitCode: exit?.exitCode ?? null,
        stopped: stopped || (exit?.stopped ?? false),
        timedOut: timedOut || (exit?.timedOut ?? false),
      };
      // The physical tree and earlier private callbacks have settled. This final
      // save has its own bounded wait, including after Stop aborted protocol work.
      if (!privateWriteFailed)
        try {
          await bounded(
            () =>
              persist({ kind: "outcome", outcome: structuredClone(outcome) }),
            persistenceTimeoutMs,
            undefined,
            "The final private Chat outcome did not settle.",
          );
        } catch {
          outcome = {
            ...outcome,
            phase: "unknown",
            reason:
              "The final private Chat outcome could not be saved. The turn was not resent.",
          };
        }
      return outcome;
    },
  };
}
