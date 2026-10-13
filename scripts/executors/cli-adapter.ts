/**
 * Shared machinery for adapters that drive a provider's headless CLI: spawn it
 * in the worktree, feed the prompt on stdin, parse its JSON-lines stdout into
 * hearth events. A provider supplies only its flags and its line parser.
 */

import type {
  Executor,
  LedgerEventBase,
  LedgerEventInput,
  Provider,
} from "../../types/hearth";
import { resolveCheckout } from "../ledger/workspace";
import { childEnv } from "./env";
import { supervise } from "./supervisor";
import type {
  DoctorResult,
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
}

export interface CliAdapterSpec {
  provider: Provider;
  binary: string;
  versionArgs: string[];
  buildArgs(request: SpawnRequest): string[];
  /** What one stdout line reports; an unparseable or irrelevant line reports no tools and nothing else. */
  parseLine(line: string): ParsedLine;
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

export function createCliAdapter(spec: CliAdapterSpec): ExecutorAdapter {
  return {
    provider: spec.provider,

    async doctor(override): Promise<DoctorResult> {
      const resolved = resolveCommand(spec, override);
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
      // it. Used only when an event must be written before any line has.
      const mintedId = crypto.randomUUID();
      let session: { id: string; base: EventBase } | undefined;

      /** Fix the session's id and announce it: `session.started` comes first. */
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
        session = { id: sessionId, base };
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
        return session;
      };
      const current = () => session ?? begin(mintedId);

      const child = supervise({
        command: [...resolved.command, ...spec.buildArgs(request)],
        cwd: request.worktree,
        env: childEnv(request),
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        onLine: (line) => {
          const parsed = spec.parseLine(line);
          if (!session && parsed.sessionId) begin(parsed.sessionId);
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
      const done = child.done.then((result) => {
        const reason = result.timedOut
          ? "timeout"
          : result.stopped
            ? `stopped: ${stopReason ?? "operator"}`
            : result.exitCode === 0
              ? "completed"
              : `failed: exit ${result.exitCode}`;
        queue.push({
          ...current().base,
          ts: new Date().toISOString(),
          kind: "session.ended",
          payload: { reason, durationMs: Date.now() - startedAt },
        });
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
