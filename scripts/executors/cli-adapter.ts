/**
 * Shared machinery for adapters that drive a provider's headless CLI: spawn it
 * in the worktree, feed the prompt on stdin, parse its JSON-lines stdout into
 * hearth events. A provider supplies only its flags and its line parser.
 */

import type { Executor, LedgerEventInput, Provider } from "../../types/hearth";
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

export interface CliAdapterSpec {
  provider: Provider;
  binary: string;
  versionArgs: string[];
  buildArgs(request: SpawnRequest): string[];
  /** Tool calls in one stdout line; unparseable or irrelevant lines yield none. */
  parseLine(line: string): ParsedTool[];
  /** Runs before spawning (e.g. mirror skills for Codex). */
  prepare?(request: SpawnRequest): Promise<void> | void;
}

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

      const sessionId = crypto.randomUUID();
      const executor: Executor = {
        provider: spec.provider,
        model: request.smith.model,
        effort: request.smith.effort,
        smith: request.smith.name,
        sessionId,
      };
      const base = {
        workspace: request.workspace,
        beadId: request.beadId,
        ...(request.runId ? { runId: request.runId } : {}),
        sessionId,
        executor,
      };
      const queue = eventQueue();
      const startedAt = Date.now();

      queue.push({
        ...base,
        ts: new Date().toISOString(),
        kind: "session.started",
        payload: { source: `headless:${spec.provider}` },
      });

      const child = supervise({
        command: [...resolved.command, ...spec.buildArgs(request)],
        cwd: request.worktree,
        env: request.env,
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        onLine: (line) => {
          for (const parsed of spec.parseLine(line)) {
            queue.push({
              ...base,
              ts: new Date().toISOString(),
              kind: "tool.called",
              payload: toolPayload(parsed),
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
          ...base,
          ts: new Date().toISOString(),
          kind: "session.ended",
          payload: { reason, durationMs: Date.now() - startedAt },
        });
        queue.close();
        return result;
      });

      return {
        sessionId,
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
