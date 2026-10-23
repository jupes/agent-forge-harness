import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  GeminiTaskCapabilities,
  GeminiTaskLaunch,
  GeminiTaskOutcome,
} from "../../types/gemini-task";
import type {
  GeminiTaskRuntimeEvent,
  PreparedGeminiTask,
} from "../../types/gemini-task-runtime";
import { loadConfig } from "../config/load";
import { buildChildEnv } from "../executors/env";
import { type InteractiveSupervised, supervise } from "../executors/supervisor";
import { reportedText } from "./activity-protocol";
import { resolveGeminiCommand } from "./gemini-command";
import {
  GEMINI_TASK_MAX_STDIN_BYTES,
  geminiTaskCapabilitiesSchema,
  serializeGeminiTask,
} from "./gemini-task";
import {
  preparedGeminiLaunchSchema,
  preparedGeminiTaskSchema,
} from "./gemini-task-runtime-protocol";
import {
  createGeminiTaskParser,
  GEMINI_TASK_STREAM_LIMITS,
} from "./gemini-task-stream";

export interface GeminiTaskRuntimeOptions {
  root: string;
  home: string;
  configHome?: string;
  /** Trusted embedding/compiled-fixture prefix. Never accept a caller command. */
  command?: readonly string[];
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  persistenceTimeoutMs?: number;
  operatorToken?: () => string | null;
}
const unavailable = (reason: string) =>
  new Error(`${reason} No Gemini Task was started.`);
const canonical = (path: string, kind: "file" | "directory"): string => {
  try {
    if (!isAbsolute(path)) throw Error();
    const value = realpathSync.native(path),
      info = statSync(value);
    if (kind === "directory" ? !info.isDirectory() : !info.isFile())
      throw Error();
    return process.platform === "win32" ? value.toLowerCase() : value;
  } catch {
    throw unavailable("A prepared Gemini path is unavailable or has changed.");
  }
};
const freeze = (value: unknown): void => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
};
const noDispatch = (): GeminiTaskOutcome => ({
  phase: "failed",
  reason: "The Gemini Task was stopped before dispatch.",
  sessionId: null,
  configuredModel: null,
  usage: null,
});

/** One explicit Task only. Trusted admission owns private originals, scope and retry authorization. */
export function createGeminiTaskRuntime(options: GeminiTaskRuntimeOptions) {
  const rootPath = options.root,
    root = canonical(rootPath, "directory"),
    home = options.home;
  const commandOverride = options.command ? [...options.command] : null;
  const environment = { ...(options.environment ?? process.env) };
  const timeoutMs = options.timeoutMs ?? 15 * 60_000,
    persistenceTimeoutMs = options.persistenceTimeoutMs ?? 5000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30 * 60_000 ||
    !Number.isSafeInteger(persistenceTimeoutMs) ||
    persistenceTimeoutMs < 1 ||
    persistenceTimeoutMs > 30_000
  )
    throw unavailable("The Gemini supervision deadlines are invalid.");
  const ready = (smith: string) => {
    let loaded: ReturnType<typeof loadConfig>;
    try {
      loaded = loadConfig({
        harnessRoot: rootPath,
        env: {},
        ...(options.configHome ? { home: options.configHome } : {}),
      });
    } catch {
      throw unavailable("The Gemini smith configuration could not be read.");
    }
    const selected = loaded.config.smiths[smith];
    if (!selected?.enabled || selected.provider !== "gemini")
      throw unavailable("The selected smith is not an enabled Gemini smith.");
    const env = buildChildEnv(environment, loaded.config.execution.envPass),
      token = options.operatorToken?.() ?? null;
    for (const [name, value] of Object.entries(env))
      if (
        /^agent_forge_/i.test(name) ||
        /^(forge_slug|node_options|node_path|bun_options)$/i.test(name) ||
        (token && value.includes(token))
      )
        delete env[name];
    env["AGENT_FORGE_ADAPTER"] = "1";
    env["AGENT_FORGE_HOME"] = home;
    let command = commandOverride
      ? [...commandOverride]
      : resolveGeminiCommand();
    if (
      !command.length ||
      command.length > 16 ||
      command.some(
        (word) => !word || word.length > 4096 || /[\p{Cc}\p{Cs}]/u.test(word),
      )
    )
      throw unavailable("The native Gemini command is invalid.");
    const executable = command[0] ? Bun.which(command[0]) : null;
    if (
      !executable ||
      (process.platform === "win32" && !/\.exe$/i.test(executable))
    )
      throw unavailable("A native Gemini executable is unavailable.");
    command = [canonical(executable, "file"), ...command.slice(1)];
    return { env, command };
  };
  const inspect = async (
    runtime: ReturnType<typeof ready>,
    signal?: AbortSignal,
  ): Promise<GeminiTaskCapabilities> => {
    const probe = async (args: string[]) => {
      if (signal?.aborted) throw unavailable("Gemini preparation was stopped.");
      let text = "",
        invalid = false;
      const child = supervise({
        command: [...runtime.command, ...args],
        cwd: rootPath,
        env: runtime.env,
        stdinMode: "interactive",
        timeoutMs: 5000,
        maxLineBytes: 65_536,
        onOutputError: () => {
          invalid = true;
        },
        onLine: (line) => {
          text += `${line}\n`;
          if (Buffer.byteLength(text) > 131_072) throw Error("Probe overflow");
        },
      });
      const stop = () => {
        void child.stop("Gemini capability probe stopped");
      };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        await child.end();
        const exit = await child.done;
        if (invalid || exit.exitCode !== 0 || exit.stopped || exit.timedOut)
          throw unavailable("The Gemini read-only capability check failed.");
        return text;
      } catch {
        throw unavailable("The Gemini read-only capability check failed.");
      } finally {
        signal?.removeEventListener("abort", stop);
        await child.done;
      }
    };
    const versionText = await probe(["--version"]),
      version = /^\s*(?:gemini(?:-cli)?\s+)?(\d+\.\d+\.\d+)\s*$/.exec(
        versionText,
      )?.[1];
    if (version !== "0.65.0")
      throw unavailable(
        "Gemini CLI does not report the verified 0.65.0 protocol version.",
      );
    const help = await probe(["--help"]);
    return geminiTaskCapabilitiesSchema.parse({
      version,
      flags: [
        ...new Set(
          [...help.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)\b/g)].map(
            (match) => match[1],
          ),
        ),
      ],
    });
  };
  const paths = (launch: GeminiTaskLaunch): string[] => [
    ...(launch.context
      ? [
          canonical(launch.context.repository, "directory"),
          canonical(launch.context.worktree, "directory"),
        ]
      : []),
    ...(launch.includeDirectories ?? []).map((path) =>
      canonical(path, "directory"),
    ),
    ...(launch.policyFiles ?? []).map((path) => canonical(path, "file")),
  ];
  const validate = (snapshot: PreparedGeminiTask) => {
    if (
      canonical(rootPath, "directory") !== root ||
      snapshot.canonicalRoot !== root ||
      canonical(snapshot.launch.cwd, "directory") !== snapshot.canonicalCwd ||
      JSON.stringify(paths(snapshot.launch)) !==
        JSON.stringify(snapshot.paths) ||
      (snapshot.launch.context &&
        canonical(snapshot.launch.context.worktree, "directory") !==
          snapshot.canonicalCwd)
    )
      throw unavailable("The prepared Gemini directory or context changed.");
    serializeGeminiTask(snapshot.launch, snapshot.capabilities);
  };
  return {
    async check(input: { smith: string }) {
      return inspect(ready(input.smith));
    },
    async prepare(input: {
      smith: string;
      launch: GeminiTaskLaunch;
    }): Promise<PreparedGeminiTask> {
      const launch = preparedGeminiLaunchSchema.parse(input.launch),
        runtime = ready(input.smith),
        canonicalCwd = canonical(launch.cwd, "directory"),
        capturedPaths = paths(launch),
        capabilities = await inspect(runtime);
      const snapshot = preparedGeminiTaskSchema.parse({
        version: 1,
        provider: "gemini",
        smith: input.smith,
        canonicalRoot: root,
        canonicalCwd,
        command: runtime.command,
        paths: capturedPaths,
        launch,
        capabilities,
      });
      validate(snapshot);
      freeze(snapshot);
      return snapshot;
    },
    async run(
      prepared: PreparedGeminiTask,
      persist: (event: GeminiTaskRuntimeEvent) => Promise<void>,
      signal: AbortSignal,
    ): Promise<GeminiTaskOutcome> {
      const snapshot = preparedGeminiTaskSchema.parse(prepared);
      validate(snapshot);
      if (signal.aborted) return noDispatch();
      const runtime = ready(snapshot.smith);
      if (JSON.stringify(runtime.command) !== JSON.stringify(snapshot.command))
        throw unavailable(
          "The native Gemini command changed after preparation.",
        );
      let capabilities: GeminiTaskCapabilities;
      try {
        capabilities = await inspect(runtime, signal);
      } catch (error) {
        if (signal.aborted) return noDispatch();
        throw error;
      }
      if (capabilities.version !== snapshot.capabilities.version)
        throw unavailable("The Gemini CLI version changed after preparation.");
      serializeGeminiTask(snapshot.launch, capabilities);
      validate(snapshot);
      if (
        JSON.stringify(ready(snapshot.smith).command) !==
        JSON.stringify(snapshot.command)
      )
        throw unavailable(
          "The native Gemini command changed during preparation.",
        );
      if (signal.aborted) return noDispatch();
      const serialized = serializeGeminiTask(
          snapshot.launch,
          snapshot.capabilities,
        ),
        parser = createGeminiTaskParser({ version: capabilities.version });
      runtime.env["AGENT_FORGE_SMITH"] = snapshot.smith;
      if (snapshot.launch.context?.beadId)
        runtime.env["AGENT_FORGE_BEAD_ID"] = snapshot.launch.context.beadId;
      let child: InteractiveSupervised | undefined,
        failure = false,
        storageFailed = false,
        pendingBytes = 0,
        pendingFrames = 0;
      let releaseWrites: (() => void) | undefined;
      let writes = new Promise<void>((resolve) => {
        releaseWrites = resolve;
      });
      const boundedPersist = async (event: GeminiTaskRuntimeEvent) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => persist(event)),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(Error("Private persistence deadline")),
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
        void child?.stop("Gemini protocol, input or private storage failure");
      };
      const enqueue = (event: GeminiTaskRuntimeEvent) => {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        pendingBytes += bytes;
        pendingFrames++;
        if (pendingBytes > 1_048_576 || pendingFrames >= 256) {
          fail();
          return;
        }
        writes = writes
          .then(async () => {
            if (storageFailed) return;
            if (failure || signal.aborted) {
              // Already accepted writes may finish, but Stop/protocol failure
              // must not wait once per queued frame. Missing private frames
              // keep this outcome unknown rather than confirming completion.
              failure = true;
              return;
            }
            await boundedPersist(event);
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
        void child?.stop("Gemini Task stopped");
      };
      try {
        child = supervise({
          command: [...runtime.command, ...serialized.argv],
          cwd: snapshot.launch.cwd,
          env: runtime.env,
          stdinMode: "interactive",
          maxStdinBytes: GEMINI_TASK_MAX_STDIN_BYTES,
          stdinTimeoutMs: 5000,
          timeoutMs,
          maxLineBytes: GEMINI_TASK_STREAM_LIMITS.lineBytes,
          onOutputError: fail,
          onLine: (line) => {
            if (!failure)
              try {
                for (const event of parser.read(line)) enqueue(event);
              } catch {
                fail();
              }
          },
        });
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        try {
          const pid = await child.providerPid;
          await boundedPersist({
            kind: "process",
            pid,
            bootstrapPid: child.pid,
            smith: snapshot.smith,
            requestedModel: snapshot.launch.model ?? null,
          });
          releaseWrites?.();
          if (!failure && !signal.aborted) {
            await child.write(serialized.stdin);
            await child.end();
          }
        } catch {
          storageFailed = true;
          fail();
        } finally {
          releaseWrites?.();
        }
        const exit = await child.done;
        await writes;
        let result = parser.finish(exit);
        if (failure)
          result = {
            ...result,
            phase: "unknown",
            reason:
              "The Gemini stream, input or private persistence was interrupted. This Task was not resent.",
          };
        if (!storageFailed)
          try {
            await boundedPersist({
              kind: "outcome",
              outcome: result,
              exitCode: exit.exitCode,
              stopped: exit.stopped,
              timedOut: exit.timedOut,
              stderr: reportedText(exit.stderr),
            });
          } catch {
            result = {
              ...result,
              phase: "unknown",
              reason:
                "The final Gemini outcome could not be saved. This Task was not resent.",
            };
          }
        return result;
      } finally {
        signal.removeEventListener("abort", stop);
        releaseWrites?.();
        if (child) await child.done;
        await writes;
      }
    },
  };
}
