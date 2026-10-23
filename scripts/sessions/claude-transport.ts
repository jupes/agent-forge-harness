import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  ConversationBinding,
  ConversationEvent,
} from "../../types/conversation";
import type {
  ClaudeLaunchCapabilities,
  ClaudeSessionLaunch,
} from "../../types/session-launch";
import type { SessionTurnSnapshot } from "../../types/session-turn";
import { loadConfig } from "../config/load";
import { ConversationError } from "../conversations/error";
import type { ConversationTransport } from "../conversations/transport";
import { buildChildEnv } from "../executors/env";
import { type Supervised, supervise } from "../executors/supervisor";
import { serializeClaudeLaunch } from "./claude-launch";
import { createClaudeSessionParser, isClaudeSessionId } from "./claude-stream";
import { sessionTurnSnapshotSchema } from "./turn-protocol";

interface Options {
  root: string;
  home: string;
  configHome?: string;
  /** Trusted fixture seam, never an HTTP argument. Windows still requires a native executable. */
  command?: readonly string[];
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  operatorToken?: () => string | null;
  /** Exact-model provider evidence, separate from the installed CLI's flag help. */
  modelEfforts?: NonNullable<ClaudeLaunchCapabilities["modelEfforts"]>;
}
interface PrepareInput {
  smith: string;
  cwd: string;
  launch: ClaudeSessionLaunch;
}
const unavailable = (reason: string) =>
  new ConversationError(503, `${reason} No provider turn was started.`);
const refusal = (reason: string) => new ConversationError(409, reason);
function directory(path: string): string {
  if (!isAbsolute(path) || !statSync(path).isDirectory())
    throw refusal("The prepared working directory is unavailable.");
  const canonical = realpathSync.native(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
function resumeId(binding: ConversationBinding | null): string | undefined {
  if (!binding) return undefined;
  if (binding.provider !== "claude" || !isClaudeSessionId(binding.sessionId))
    throw refusal("The conversation has no verified Claude resume identity.");
  return binding.sessionId;
}

/** Coding transport only. The sealed Keeper transport and its tools are unrelated. */
export function createClaudeSessionTransport(
  options: Options,
): ConversationTransport & {
  prepare(input: PrepareInput): Promise<SessionTurnSnapshot>;
} {
  const override = options.command ? [...options.command] : null;
  const runtime = (smithName?: string) => {
    let loaded: ReturnType<typeof loadConfig>;
    try {
      loaded = loadConfig({
        harnessRoot: options.root,
        env: {},
        ...(options.configHome ? { home: options.configHome } : {}),
      });
    } catch {
      throw unavailable("The session configuration could not be read.");
    }
    if (smithName !== undefined) {
      const smith = loaded.config.smiths[smithName];
      if (!smith?.enabled || smith.provider !== "claude")
        throw unavailable("The selected smith is not an enabled Claude smith.");
    }
    const env = buildChildEnv(
      options.environment ?? process.env,
      loaded.config.execution.envPass,
    );
    const token = options.operatorToken?.() ?? null;
    for (const [key, value] of Object.entries(env)) {
      if (
        /^agent_forge_/i.test(key) ||
        key.toLowerCase() === "forge_slug" ||
        (token !== null && token.length > 0 && value.includes(token))
      )
        delete env[key];
    }
    env["AGENT_FORGE_ADAPTER"] = "1";
    env["AGENT_FORGE_HOME"] = options.home;
    const found = override ?? [Bun.which("claude") ?? ""];
    const command = [...found];
    if (
      !command[0] ||
      command.some((word) => !word || word.includes("\0")) ||
      !Bun.which(command[0])
    )
      throw unavailable("The Claude CLI was not found.");
    if (process.platform === "win32" && !/\.exe$/i.test(command[0]))
      throw unavailable(
        "Coding sessions require the native Claude executable on Windows.",
      );
    return { command, env };
  };
  const inspect = async (ready: ReturnType<typeof runtime>) => {
    const probe = async (flag: string) => {
      let text = "",
        invalid = false;
      const child = supervise({
        command: [...ready.command, flag],
        cwd: options.root,
        env: ready.env,
        timeoutMs: 5000,
        maxLineBytes: 65_536,
        onOutputError: () => {
          invalid = true;
        },
        onLine: (line) => {
          text += `${line}\n`;
          if (text.length > 131_072)
            throw new Error("Capability reply exceeded its bound.");
        },
      });
      const exit = await child.done;
      if (invalid || exit.exitCode !== 0 || exit.timedOut || exit.stopped)
        throw unavailable(
          "The installed Claude CLI did not pass its read-only capability check.",
        );
      return text;
    };
    const versionOutput = await probe("--version");
    const version = /^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/.exec(
      versionOutput,
    )?.[1];
    const help = await probe("--help");
    if (!version)
      throw unavailable(
        "The installed Claude CLI did not report a usable version.",
      );
    const flags = [
      ...new Set(
        [...help.matchAll(/(?:^|\s)(--[A-Za-z][A-Za-z0-9-]*)\b/g)].map(
          (match) => match[1] ?? "",
        ),
      ),
    ];
    const capabilities: ClaudeLaunchCapabilities = {
      version,
      flags,
      ...(options.modelEfforts ? { modelEfforts: options.modelEfforts } : {}),
    };
    return capabilities;
  };
  const prepare = async (input: PrepareInput): Promise<SessionTurnSnapshot> => {
    const ready = runtime(input.smith);
    const cwd = directory(input.cwd);
    if (
      input.launch.context &&
      directory(input.launch.context.worktree) !== cwd
    )
      throw refusal(
        "The launch context and prepared working directory differ.",
      );
    const capabilities = await inspect(ready);
    serializeClaudeLaunch(input.launch, capabilities);
    const snapshot: SessionTurnSnapshot = {
      version: 1,
      provider: "claude",
      smith: input.smith,
      cwd: input.cwd,
      launch: structuredClone(input.launch),
      capabilities: structuredClone(capabilities),
    };
    if (!sessionTurnSnapshotSchema.safeParse(snapshot).success)
      throw refusal("The prepared session snapshot is invalid or too large.");
    return snapshot;
  };
  return {
    provider: "claude",
    prepare,
    async check(request) {
      resumeId(request.resume);
      await inspect(runtime());
    },
    async run(request, persist, signal) {
      const snapshot = request.input.session;
      if (!snapshot || !sessionTurnSnapshotSchema.safeParse(snapshot).success)
        throw refusal("A validated private session snapshot is required.");
      const launch = snapshot.launch;
      const context = launch.context;
      if (
        directory(request.root) !== directory(options.root) ||
        !context ||
        context.projectId !== request.project.id ||
        directory(context.worktree) !== directory(snapshot.cwd) ||
        launch.prompt !== request.input.text ||
        JSON.stringify(context.about ?? []) !==
          JSON.stringify(request.input.about) ||
        launch.resumeSessionId !== resumeId(request.resume)
      )
        throw refusal(
          "The prepared session does not match this project, directory, input or resume identity.",
        );
      if (signal.aborted)
        return {
          phase: "failed",
          reason: "The turn was stopped before dispatch.",
        };
      const ready = runtime(snapshot.smith);
      const current = await inspect(ready);
      if (current.version !== snapshot.capabilities.version)
        throw refusal(
          "The installed Claude CLI changed after preparation. No provider turn was started.",
        );
      // Validate live capabilities without changing any saved model, effort or arguments.
      serializeClaudeLaunch(launch, current);
      const serialized = serializeClaudeLaunch(launch, snapshot.capabilities);
      if (signal.aborted)
        return {
          phase: "failed",
          reason: "The turn was stopped before dispatch.",
        };
      ready.env["AGENT_FORGE_SMITH"] = snapshot.smith;
      if (context.beadId) ready.env["AGENT_FORGE_BEAD_ID"] = context.beadId;
      const parser = createClaudeSessionParser({
        version: current.version,
        ...(request.resume ? { resumeId: request.resume.sessionId } : {}),
      });
      let child: Supervised | undefined;
      let failure: string | null = null,
        storageFailed = false,
        pendingBytes = 0,
        pendingFrames = 0;
      let writes = Promise.resolve();
      const fail = () => {
        failure ??=
          "The provider stream or private transcript write was interrupted. Completion is unknown; this turn was not resent.";
        void child?.stop("Coding session protocol or storage failure");
      };
      const enqueue = (event: Exclude<ConversationEvent, { kind: "user" }>) => {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        pendingBytes += bytes;
        pendingFrames++;
        if (pendingBytes > 1_048_576 || pendingFrames > 256) {
          fail();
          return;
        }
        writes = writes
          .then(async () => {
            if (!storageFailed) await persist(event);
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
        void child?.stop("Coding session stop requested");
      };
      try {
        child = supervise({
          command: [...ready.command, ...serialized.argv],
          cwd: snapshot.cwd,
          env: ready.env,
          stdin: serialized.stdin,
          timeoutMs: options.timeoutMs ?? 15 * 60_000,
          maxLineBytes: 1_048_576,
          onOutputError: fail,
          onLine: (line) => {
            if (failure !== null) return;
            try {
              for (const event of parser.line(line))
                if (event.kind !== "user") enqueue(event);
            } catch {
              fail();
            }
          },
        });
        // "default" is a requested CLI default, never a measurement of served effort.
        enqueue({
          kind: "process",
          pid: child.pid,
          smith: snapshot.smith,
          requestedModel: launch.model,
          requestedEffort: launch.effort ?? "default",
        });
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        const exit = await child.done;
        await writes;
        if (failure !== null) return { phase: "unknown", reason: failure };
        return parser.finish(exit);
      } finally {
        signal.removeEventListener("abort", stop);
        if (child) await child.done;
        await writes;
      }
    },
  };
}
