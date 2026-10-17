/**
 * Runs one child process with a timeout, a stop(), and a guarantee that it does
 * not outlive the harness. Every live child is registered; a parent `exit`
 * (including a crash or Ctrl-C) kills the whole tree synchronously. A
 * `SIGINT` or `SIGTERM` does the same and exits 130, unless an interrupt owner
 * (`ownInterrupts`) has dealt with it. A harness killed outright runs no exit
 * hook: each child's tree is guarded for that case as it starts
 * (`tree-guard.ts`).
 */

import { guardTree } from "./tree-guard";
import type { ChildExit } from "./types";

/** How much of a child's stderr is kept: the end, where a failure says why. */
export const STDERR_TAIL_CHARS = 4000;

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
  done: Promise<ChildExit>;
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

/** The signals the supervisor listens for. */
export type InterruptSignal = "SIGINT" | "SIGTERM";

/**
 * Given each `SIGINT` or `SIGTERM` first. True means it has dealt with the
 * signal: the supervisor then kills nothing and does not exit. False (or a
 * throw) leaves the signal to the supervisor: every supervised child's tree
 * is killed and the process exits 130.
 */
export type InterruptOwner = (signal: InterruptSignal) => boolean;

/** The registered owner, wrapped so that each registration is told apart. */
let owner: { take: InterruptOwner } | null = null;

function onInterrupt(signal: InterruptSignal): void {
  const current = owner;
  let handled = false;
  try {
    handled = current !== null && current.take(signal);
  } catch {
    // An owner that fails has not dealt with the signal.
  }
  if (handled) return;
  killAllLive();
  process.exit(130);
}

/**
 * Make `take` the owner of this process's `SIGINT` and `SIGTERM` until the
 * function it returns is called. The supervisor's listeners are installed at
 * once, so the owner is asked even before any child is supervised. There is
 * one owner at a time: registering while one is registered throws, so an
 * owner is never replaced by accident. The returned release removes this
 * registration only (a second call, or one after another owner registered,
 * does nothing). With no owner, a signal kills every supervised child's tree
 * and exits 130, as `forge:exec` does.
 */
export function ownInterrupts(take: InterruptOwner): () => void {
  if (owner !== null)
    throw new Error(
      "an interrupt owner is registered already: release it before registering another",
    );
  hookParentExit();
  const registration = { take };
  owner = registration;
  return () => {
    if (owner === registration) owner = null;
  };
}

function hookParentExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAllLive);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => onInterrupt(signal));
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

/** Read a stream to its end, keeping only its last `max` characters. */
async function readTail(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text = (text + decoder.decode(value, { stream: true })).slice(-max);
  }
  return (text + decoder.decode()).slice(-max);
}

export function supervise(options: SuperviseOptions): Supervised {
  hookParentExit();
  const proc = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    ...(process.platform === "win32" ? {} : { detached: true }),
    stdout: "pipe",
    stderr: "pipe",
  });
  live.add(proc.pid);
  // For a harness ended outright, which runs no exit hook (`tree-guard.ts`).
  const guard = guardTree(proc.pid);

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
  const stderrTail = readTail(proc.stderr, STDERR_TAIL_CHARS).catch(() => "");
  const done = (async (): Promise<ChildExit> => {
    try {
      const exitCode = await proc.exited;
      await pumped.catch(() => undefined);
      const stderr = await stderrTail;
      return { exitCode, timedOut, stopped, stderr };
    } finally {
      if (timer) clearTimeout(timer);
      guard.release();
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
