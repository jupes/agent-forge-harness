import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  CodexExecCapabilities,
  CodexExecOutcome,
  CodexModelEffortEvidence,
  CodexTaskLaunch,
} from "../../types/codex-task";
import type {
  CodexTaskRuntimeEvent,
  PreparedCodexTask,
} from "../../types/codex-task-runtime";
import { loadConfig } from "../config/load";
import { codexSyncDirectory } from "../executors/codex";
import { buildChildEnv } from "../executors/env";
import { type Supervised, supervise } from "../executors/supervisor";
import {
  CODEX_EXEC_STREAM_LIMITS,
  createCodexExecParser,
} from "./codex-exec-stream";
import { serializeCodexTask } from "./codex-task";
import {
  preparedCodexCapabilitiesSchema,
  preparedCodexLaunchSchema,
  preparedCodexTaskSchema,
} from "./codex-task-runtime-protocol";

export { preparedCodexTaskSchema } from "./codex-task-runtime-protocol";

export interface CodexTaskRuntimeOptions {
  root: string;
  home: string;
  configHome?: string;
  /** Trusted embedding/fixture prefix only. Never accept an HTTP/caller command. */
  command?: readonly string[];
  /** Trusted supervised sync prefix; cwd is still selected by codexSyncDirectory. */
  syncCommand?: readonly string[];
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Trusted private-writer deadline; not a public launch option. Defaults to five seconds. */
  persistenceTimeoutMs?: number;
  operatorToken?: () => string | null;
  modelEfforts?: readonly CodexModelEffortEvidence[];
}

const unavailable = (reason: string) =>
  new Error(`${reason} No provider turn was started.`);
const directory = (path: string): string => {
  try {
    if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error();
    const canonical = realpathSync.native(path);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    throw unavailable("The prepared working directory is unavailable.");
  }
};
const freeze = (value: unknown): void => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
};
const outcome = (
  phase: CodexExecOutcome["phase"],
  reason: string,
): CodexExecOutcome => ({
  phase,
  reason,
  threadId: null,
  observedModel: null,
  usage: null,
});

/** Standalone Task runtime. Its trusted caller owns scope, allowance, the private journal and retry authorization. */
export function createCodexTaskRuntime(options: CodexTaskRuntimeOptions) {
  const root = directory(options.root);
  const override = options.command ? [...options.command] : null;
  const syncOverride = options.syncCommand ? [...options.syncCommand] : null;
  const modelEfforts = options.modelEfforts
    ? structuredClone(options.modelEfforts)
    : undefined;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const persistenceTimeoutMs = options.persistenceTimeoutMs ?? 5000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30 * 60_000
  )
    throw unavailable("The Task timeout is invalid.");
  if (
    !Number.isSafeInteger(persistenceTimeoutMs) ||
    persistenceTimeoutMs < 1 ||
    persistenceTimeoutMs > 30_000
  )
    throw unavailable("The private persistence deadline is invalid.");
  const native = (prefix: readonly string[]): string[] => {
    const resolved = prefix[0] ? Bun.which(prefix[0]) : null;
    if (
      !resolved ||
      prefix.some(
        (word) => !word || word.length > 4096 || word.includes("\0"),
      ) ||
      prefix.length > 16
    )
      throw unavailable("The native Codex executable is unavailable.");
    if (process.platform === "win32" && !/\.exe$/i.test(resolved))
      throw unavailable("Codex Tasks require a native executable on Windows.");
    return [resolved, ...prefix.slice(1)];
  };
  const ready = (smith: string) => {
    let loaded: ReturnType<typeof loadConfig>;
    try {
      loaded = loadConfig({
        harnessRoot: options.root,
        env: {},
        ...(options.configHome ? { home: options.configHome } : {}),
      });
    } catch {
      throw unavailable("The Task configuration could not be read.");
    }
    const selected = loaded.config.smiths[smith];
    if (!selected?.enabled || selected.provider !== "codex")
      throw unavailable("The selected smith is not an enabled Codex smith.");
    const env = buildChildEnv(
      options.environment ?? process.env,
      loaded.config.execution.envPass,
    );
    const token = options.operatorToken?.() ?? null;
    for (const [name, value] of Object.entries(env))
      if (
        /^agent_forge_/i.test(name) ||
        name.toLowerCase() === "forge_slug" ||
        (token && value.includes(token))
      )
        delete env[name];
    env["AGENT_FORGE_ADAPTER"] = "1";
    env["AGENT_FORGE_HOME"] = options.home;
    return { env, command: native(override ?? [Bun.which("codex") ?? ""]) };
  };
  const inspect = async (
    runtime: ReturnType<typeof ready>,
    signal?: AbortSignal,
  ): Promise<CodexExecCapabilities> => {
    const probe = async (args: string[]) => {
      if (signal?.aborted)
        throw unavailable("The Task was stopped during preparation.");
      let text = "",
        invalid = false;
      const child = supervise({
        command: [...runtime.command, ...args],
        cwd: options.root,
        env: runtime.env,
        timeoutMs: 5000,
        maxLineBytes: 65_536,
        onOutputError: () => {
          invalid = true;
        },
        onLine: (line) => {
          text += `${line}\n`;
          if (text.length > 131_072) throw new Error("Probe overflow");
        },
      });
      const stop = () => {
        void child.stop("Task capability probe stopped");
      };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        const exit = await child.done;
        if (invalid || exit.exitCode !== 0 || exit.timedOut || exit.stopped)
          throw unavailable("The Codex read-only capability check failed.");
        return text;
      } finally {
        signal?.removeEventListener("abort", stop);
        await child.done;
      }
    };
    const versionText = await probe(["--version"]);
    const version =
      /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)(?:\s|$)/.exec(
        versionText,
      )?.[1];
    if (!version)
      throw unavailable("The Codex CLI did not report a usable version.");
    const help = await probe(["exec", "--help"]);
    const flags = [
      ...new Set(
        [...help.matchAll(/(?:^|\s)(--[A-Za-z][A-Za-z0-9-]*)\b/g)].map(
          (match) => match[1] ?? "",
        ),
      ),
    ];
    return preparedCodexCapabilitiesSchema.parse({
      version,
      flags,
      ...(modelEfforts ? { modelEfforts } : {}),
    });
  };
  const validate = (snapshot: PreparedCodexTask) => {
    const launch = snapshot.launch;
    if (directory(snapshot.cwd) !== snapshot.canonicalCwd)
      throw unavailable(
        "The prepared Task directory changed after preparation.",
      );
    if (
      directory(options.root) !== root ||
      snapshot.cwd !== launch.cwd ||
      (launch.context &&
        directory(launch.context.worktree) !== directory(snapshot.cwd))
    )
      throw unavailable(
        "The immutable Task directory and context do not match.",
      );
    directory(snapshot.cwd);
    serializeCodexTask(launch, snapshot.capabilities);
  };
  return {
    async check(input: { smith: string }) {
      return inspect(ready(input.smith));
    },
    async prepare(input: {
      smith: string;
      launch: PreparedCodexTask["launch"];
    }): Promise<PreparedCodexTask> {
      const launch = preparedCodexLaunchSchema.parse(input.launch);
      const canonicalCwd = directory(launch.cwd);
      const runtime = ready(input.smith);
      const capabilities = await inspect(runtime);
      // Keep the native preparation's specific controlled capability refusal;
      // the private wire codec intentionally reports only a bounded summary.
      serializeCodexTask(launch, capabilities);
      const snapshot = preparedCodexTaskSchema.parse({
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
    async run(
      prepared: PreparedCodexTask,
      persist: (event: CodexTaskRuntimeEvent) => Promise<void>,
      signal: AbortSignal,
    ): Promise<CodexExecOutcome> {
      const snapshot = preparedCodexTaskSchema.parse(prepared);
      validate(snapshot);
      if (signal.aborted)
        return outcome("failed", "The Task was stopped before dispatch.");
      const runtime = ready(snapshot.smith);
      let current: CodexExecCapabilities;
      try {
        current = await inspect(runtime, signal);
      } catch (error) {
        if (signal.aborted)
          return outcome("failed", "The Task was stopped before dispatch.");
        throw error;
      }
      if (current.version !== snapshot.capabilities.version)
        throw unavailable("The installed Codex CLI changed after preparation.");
      serializeCodexTask(snapshot.launch, current);
      validate(snapshot);
      const serialized = serializeCodexTask(
        snapshot.launch,
        snapshot.capabilities,
      );
      const syncDirectory = codexSyncDirectory({
        workspace: options.root,
        worktree: snapshot.cwd,
      });
      if (signal.aborted)
        return outcome("failed", "The Task was stopped before dispatch.");
      if (syncDirectory) {
        let invalid = false,
          size = 0;
        const sync = supervise({
          command: native(
            syncOverride ?? [process.execPath, "run", "codex:sync"],
          ),
          cwd: syncDirectory,
          env: runtime.env,
          timeoutMs: Math.min(timeoutMs, 30_000),
          maxLineBytes: 65_536,
          onOutputError: () => {
            invalid = true;
          },
          onLine: (line) => {
            size += line.length;
            if (size > 131_072) throw new Error("Sync overflow");
          },
        });
        const stop = () => {
          void sync.stop("Task sync stopped");
        };
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        try {
          const exit = await sync.done;
          if (invalid || exit.exitCode !== 0 || exit.timedOut || exit.stopped)
            return outcome(
              "failed",
              "Skill sync did not complete successfully. No Codex Task was started.",
            );
        } finally {
          signal.removeEventListener("abort", stop);
          await sync.done;
        }
      }
      if (signal.aborted)
        return outcome("failed", "The Task was stopped before dispatch.");
      validate(snapshot);
      runtime.env["AGENT_FORGE_SMITH"] = snapshot.smith;
      if (snapshot.launch.context?.beadId)
        runtime.env["AGENT_FORGE_BEAD_ID"] = snapshot.launch.context.beadId;
      const parser = createCodexExecParser({ version: current.version });
      let child: Supervised | undefined,
        failure = false,
        storageFailed = false,
        pendingBytes = 0,
        pendingFrames = 0;
      let writes = Promise.resolve();
      const boundedPersist = async (event: CodexTaskRuntimeEvent) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => persist(event)),
            new Promise<void>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error("Private persistence deadline exceeded")),
                persistenceTimeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const fail = () => {
        failure = true;
        void child?.stop("Task protocol or private storage failure");
      };
      const enqueue = (event: CodexTaskRuntimeEvent) => {
        const bytes = new TextEncoder().encode(
          JSON.stringify(event),
        ).byteLength;
        pendingBytes += bytes;
        pendingFrames++;
        if (pendingBytes > 1_048_576 || pendingFrames > 256) {
          fail();
          return;
        }
        writes = writes
          .then(async () => {
            if (!storageFailed) await boundedPersist(event);
          })
          .catch(() => {
            storageFailed = true;
            fail();
          })
          .finally(() => {
            pendingBytes -= bytes;
            pendingFrames--;
          });
      };
      const stop = () => {
        void child?.stop("Codex Task stopped");
      };
      try {
        child = supervise({
          command: [...runtime.command, ...serialized.argv],
          cwd: snapshot.cwd,
          env: runtime.env,
          stdin: serialized.stdin,
          timeoutMs,
          maxLineBytes: CODEX_EXEC_STREAM_LIMITS.lineBytes,
          onOutputError: fail,
          onLine: (line) => {
            if (failure) return;
            try {
              for (const event of parser.line(line)) enqueue(event);
            } catch {
              fail();
            }
          },
        });
        enqueue({
          kind: "process",
          pid: child.pid,
          smith: snapshot.smith,
          requestedModel: snapshot.launch.model,
          requestedEffort: snapshot.launch.effort ?? null,
        });
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        const exit = await child.done;
        await writes;
        const result = parser.finish(exit);
        if (failure)
          return {
            ...result,
            phase: "unknown",
            reason:
              "The Task stream or private persistence was interrupted. This Task was not resent.",
          };
        return result;
      } finally {
        signal.removeEventListener("abort", stop);
        if (child) await child.done;
        await writes;
      }
    },
  };
}
