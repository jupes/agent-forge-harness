/**
 * Runs one child process with a timeout, a stop(), and a guarantee that it does
 * not outlive the harness. Every live child is registered; a parent `exit`
 * (including a crash or Ctrl-C) kills the whole tree synchronously.
 */

import type { ExecResult } from "./types";

export interface SuperviseOptions {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  onLine: (line: string) => void;
}

export interface Supervised {
  pid: number;
  done: Promise<ExecResult>;
  stop(reason: string): Promise<void>;
}

const live = new Set<number>();
let hooked = false;

/** Kill a process and its children. Synchronous so it is safe inside `exit` handlers. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Kill every supervised child. Registered on process exit; exported for tests. */
export function killAllLive(): void {
  for (const pid of live) killTree(pid);
  live.clear();
}

export function liveChildCount(): number {
  return live.size;
}

function hookParentExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAllLive);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killAllLive();
      process.exit(130);
    });
  }
}

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  const drain = (final: boolean) => {
    const parts = buffer.split(/\r?\n/);
    buffer = final ? "" : (parts.pop() ?? "");
    for (const part of parts) {
      if (part.trim()) onLine(part);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
}

export function supervise(options: SuperviseOptions): Supervised {
  hookParentExit();
  const proc = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  live.add(proc.pid);

  let timedOut = false;
  let stopped = false;
  const kill = () => killTree(proc.pid);

  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;

  if (options.stdin !== undefined) proc.stdin.write(options.stdin);
  proc.stdin.end();

  const pumped = pumpLines(proc.stdout, options.onLine);
  const done = (async (): Promise<ExecResult> => {
    try {
      const exitCode = await proc.exited;
      await pumped.catch(() => undefined);
      return { exitCode, timedOut, stopped };
    } finally {
      if (timer) clearTimeout(timer);
      live.delete(proc.pid);
    }
  })();

  return {
    pid: proc.pid,
    done,
    async stop() {
      stopped = true;
      kill();
      await done;
    },
  };
}
