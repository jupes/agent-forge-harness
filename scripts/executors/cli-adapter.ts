/**
 * Shared machinery for adapters that drive a provider's headless CLI: spawn it
 * in the worktree, feed the prompt on stdin, parse its JSON-lines stdout into
 * hearth events. A provider supplies only its flags and its line parser.
 */

import {
  CLI_DEFAULT_MODEL,
  type Executor,
  type LedgerEventBase,
  type LedgerEventInput,
  type Provider,
  type ProviderUsage,
  type ProviderUsageCount,
} from "../../types/hearth";
import { hashText } from "../hash-text";
import {
  readSessionMirror,
  removeSessionMirror,
  writeSessionMirror,
} from "../ledger/identity";
import { ulid } from "../ledger/ulid";
import { resolveCheckout } from "../ledger/workspace";
import { childEnv } from "./env";
import { supervise } from "./supervisor";
import type {
  DoctorResult,
  ExecResult,
  ExecutorAdapter,
  ExecutorHandle,
  SpawnRequest,
} from "./types";

/** A tool invocation found in one provider output line. */
export interface ParsedTool {
  tool: string;
  input: unknown;
  exitCode?: number;
}

/** What one provider output line reports. */
export interface ParsedLine {
  tools: ParsedTool[];
  /** The provider's own id for the session, when this line carries it. */
  sessionId?: string;
  /** What the run used, when this line reports it. */
  usage?: ProviderUsage;
  /** The model a response on this line named, when it names one. */
  model?: string;
}

/**
 * The counts of a provider's usage object, renamed as `names` maps them: each
 * a non-negative whole number, else left out. Undefined when none is left.
 */
export function usageCounts(
  source: unknown,
  names: Readonly<Record<string, ProviderUsageCount>>,
): ProviderUsage | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const usage: ProviderUsage = {};
  for (const [field, name] of Object.entries(names)) {
    const count = record[field];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
      usage[name] = count;
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export interface CliAdapterSpec {
  provider: Provider;
  binary: string;
  versionArgs: string[];
  buildArgs(request: SpawnRequest): string[];
  /** What one stdout line reports; an unparseable or irrelevant line reports no tools and nothing else. */
  parseLine(line: string): ParsedLine;
  /** The error one stdout line reports, in the provider's words; undefined for any other line. */
  parseError(line: string): string | undefined;
  /** Runs before spawning (e.g. mirror skills for Codex). */
  prepare?(request: SpawnRequest): Promise<void> | void;
}

/** The fields every event of one session shares. */
type EventBase = Omit<LedgerEventBase, "ts">;

export function hashArgs(input: unknown): string {
  const text = JSON.stringify(input ?? null);
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

/** An unbounded async queue: producers push, one consumer iterates until closed. */
function eventQueue() {
  const items: LedgerEventInput[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(event: LedgerEventInput) {
      items.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *iterate(): AsyncGenerator<LedgerEventInput> {
      while (true) {
        const next = items.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function toolPayload(parsed: ParsedTool) {
  const payload: { tool: string; argsHash: string; exitCode?: number } = {
    tool: parsed.tool,
    argsHash: hashArgs(parsed.input),
  };
  if (parsed.exitCode !== undefined) payload.exitCode = parsed.exitCode;
  return payload;
}

/**
 * Mirror a headless session into the checkout its child runs in, so that a
 * script the child launches (a phase gate, a quality gate) attaches to it as
 * it would to an interactive session. Returns what undoes it at the end: when
 * the file still names this session, the fresh mirror it replaced is put
 * back, or the file is removed. A mirror written over it in the meantime
 * belongs to a newer session and is left alone.
 */
function mirrorSession(checkout: string, sessionId: string): () => void {
  const replaced = readSessionMirror(checkout);
  writeSessionMirror(checkout, sessionId);
  return () => {
    if (replaced === null || replaced === sessionId) {
      removeSessionMirror(checkout, sessionId);
    } else if (readSessionMirror(checkout) === sessionId) {
      writeSessionMirror(checkout, replaced);
    }
  };
}

function resolveCommand(
  spec: CliAdapterSpec,
  override?: string[],
): { command: string[]; path?: string } | { error: string } {
  if (override && override.length > 0) {
    return { command: override, path: override.join(" ") };
  }
  const path = Bun.which(spec.binary);
  if (!path) return { error: `${spec.binary} not found on PATH` };
  return { command: [path], path };
}

/**
 * The `--model` argument for a smith's model, the same flag in both CLIs:
 * none for `CLI_DEFAULT_MODEL`, so the CLI runs the model it is configured with.
 */
export function modelArgs(model: string): string[] {
  return model === CLI_DEFAULT_MODEL ? [] : ["--model", model];
}

export function createCliAdapter(spec: CliAdapterSpec): ExecutorAdapter {
  return {
    provider: spec.provider,

    async doctor(override): Promise<DoctorResult> {
      // An override's program is found the way the binary is: as `Bun.which`
      // finds it, which is also how `Bun.spawn` looks it up. One that is not
      // there is not found; one that is there but fails is found and not ok.
      const program = override?.[0];
      const resolved =
        program !== undefined && !Bun.which(program)
          ? { error: `${program} not found` }
          : resolveCommand(spec, override);
      if ("error" in resolved) {
        return {
          provider: spec.provider,
          found: false,
          ok: false,
          reason: resolved.error,
        };
      }
      try {
        const proc = Bun.spawn([...resolved.command, ...spec.versionArgs], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = (await new Response(proc.stdout).text()).trim();
        const code = await proc.exited;
        return {
          provider: spec.provider,
          found: true,
          ok: code === 0,
          path: resolved.path,
          version: out.split(/\r?\n/)[0] || undefined,
          reason: code === 0 ? undefined : `version check exited ${code}`,
        };
      } catch (error) {
        return {
          provider: spec.provider,
          found: true,
          ok: false,
          path: resolved.path,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async spawn(request): Promise<ExecutorHandle> {
      const resolved = resolveCommand(spec, request.command);
      if ("error" in resolved) throw new Error(resolved.error);
      await spec.prepare?.(request);

      // Spelled the way every other emitter spells them: the harness's main
      // checkout (also when the run was launched from a linked worktree of
      // it), and the checkout the executor runs in.
      const { workspace } = resolveCheckout(request.workspace);
      const { worktree } = resolveCheckout(request.worktree);
      const queue = eventQueue();
      const startedAt = Date.now();
      // The session's id is the provider's, from the first line that reports
      // it. A ULID, as the protocol mints, only when an event must be written
      // before any line has.
      const mintedId = ulid();
      let session:
        | { id: string; base: EventBase; unmirror: () => void }
        | undefined;
      // In the provider's words: for the command's output, never an event.
      const providerErrors = new Set<string>();

      /**
       * Fix the session's id, announce it (`session.started` comes first,
       * then `prompt.submitted`) and mirror it into the checkout the child
       * runs in.
       */
      const begin = (sessionId: string) => {
        const executor: Executor = {
          provider: spec.provider,
          model: request.smith.model,
          effort: request.smith.effort,
          smith: request.smith.name,
          sessionId,
        };
        const base: EventBase = {
          workspace,
          beadId: request.beadId,
          ...(request.runId ? { runId: request.runId } : {}),
          sessionId,
          executor,
        };
        session = {
          id: sessionId,
          base,
          unmirror: mirrorSession(worktree, sessionId),
        };
        queue.push({
          ...base,
          ts: new Date().toISOString(),
          kind: "session.started",
          payload: {
            source: `headless:${spec.provider}`,
            kind: "headless",
            worktree,
            ...(request.parentSessionId
              ? { parentSessionId: request.parentSessionId }
              : {}),
          },
        });
        // The prompt went to the child on stdin at spawn: its hash and
        // length, as the prompt hook records them, never the text.
        queue.push({
          ...base,
          ts: new Date().toISOString(),
          kind: "prompt.submitted",
          payload: {
            hash: hashText(request.prompt),
            length: request.prompt.length,
          },
        });
        return session;
      };
      const current = () => session ?? begin(mintedId);
      // The last usage the stream reported: one turn per run is what has
      // been seen, so a later report is taken to replace an earlier one.
      let usage: ProviderUsage | undefined;
      // The model the stream's responses last named, handed on when it changes.
      let observedModel: string | undefined;

      const child = supervise({
        command: [...resolved.command, ...spec.buildArgs(request)],
        cwd: request.worktree,
        env: childEnv(request),
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        onLine: (line) => {
          const reported = spec.parseError(line);
          if (reported !== undefined) providerErrors.add(reported);
          const parsed = spec.parseLine(line);
          if (!session && parsed.sessionId) begin(parsed.sessionId);
          if (parsed.usage) usage = parsed.usage;
          if (parsed.model !== undefined && parsed.model !== observedModel) {
            observedModel = parsed.model;
            try {
              request.onModel?.({
                sessionId: current().id,
                provider: spec.provider,
                model: parsed.model,
              });
            } catch {
              // What the run was observed to be is not worth stopping it for.
            }
          }
          for (const tool of parsed.tools) {
            queue.push({
              ...current().base,
              ts: new Date().toISOString(),
              kind: "tool.called",
              payload: toolPayload(tool),
            });
          }
        },
      });

      let stopReason: string | undefined;
      const done = child.done.then((exit): ExecResult => {
        const result = { ...exit, providerErrors: [...providerErrors] };
        // Fixed wording only: the provider's own text stays out of the ledger.
        const reason = result.timedOut
          ? "timeout"
          : result.stopped
            ? `stopped: ${stopReason ?? "operator"}`
            : result.exitCode !== 0
              ? `failed: exit ${result.exitCode}`
              : result.providerErrors.length > 0
                ? "failed: exit 0, provider reported an error"
                : "completed";
        const { base, unmirror } = current();
        queue.push({
          ...base,
          ts: new Date().toISOString(),
          kind: "session.ended",
          payload: {
            reason,
            durationMs: Date.now() - startedAt,
            ...(usage ? { usage } : {}),
          },
        });
        unmirror();
        queue.close();
        return result;
      });

      return {
        get sessionId() {
          return session?.id ?? mintedId;
        },
        pid: child.pid,
        events: queue.iterate(),
        done,
        async stop(reason) {
          stopReason = reason;
          await child.stop(reason);
        },
      };
    },
  };
}
