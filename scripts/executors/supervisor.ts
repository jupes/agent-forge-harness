/**
 * Runs one child process with a timeout, a stop(), and a guarantee that it does
 * not outlive the harness. Every live child is registered; a parent `exit`
 * (including a crash or Ctrl-C) kills the whole tree synchronously. A
 * `SIGINT` or `SIGTERM` does the same and exits 130, unless an interrupt owner
 * (`ownInterrupts`) has dealt with it. A harness killed outright runs no exit
 * hook: each child's tree is guarded for that case as it starts
 * (`tree-guard.ts`).
 */

import { join } from "node:path";
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
  /** Optional protocol bound, including output that never sends a newline. */
  maxLineBytes?: number;
  onOutputError?: () => void;
}

export interface Supervised {
  pid: number;
  done: Promise<ChildExit>;
  stop(reason: string): Promise<void>;
}

/** Trusted bidirectional protocols only. The ordinary serialized-stdin path is unchanged. */
export interface InteractiveSuperviseOptions
  extends Omit<SuperviseOptions, "stdin"> {
  stdinMode: "interactive";
  /** Cumulative process input and currently queued byte cap; not proof of child consumption. */
  maxStdinBytes?: number;
  stdinTimeoutMs?: number;
}

export interface InteractiveSupervised extends Supervised {
  /** Ordered, bounded input acceptance; native protocol acknowledgements prove consumption. */
  write(input: string): Promise<void>;
  /** Sends EOF after all earlier writes. Later writes refuse. */
  end(): Promise<void>;
}

const live = new Set<number>();
let hooked = false;

/** Kill a process and its children. Synchronous so it is safe inside `exit` handlers. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    const taskkill = join(
      process.env["SystemRoot"] || process.env["SYSTEMROOT"] || "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    Bun.spawnSync([taskkill, "/PID", String(pid), "/T", "/F"], {
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
  maxLineBytes?: number,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  const drain = (final: boolean) => {
    const parts = buffer.split(/\r?\n/);
    buffer = final ? "" : (parts.pop() ?? "");
    for (const part of parts) {
      if (maxLineBytes !== undefined && Buffer.byteLength(part) > maxLineBytes)
        throw new Error("Child output exceeded its protocol bound.");
      if (part.trim()) onLine(part);
    }
    if (maxLineBytes !== undefined && Buffer.byteLength(buffer) > maxLineBytes)
      throw new Error("Child output exceeded its protocol bound.");
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

export function supervise(
  options: InteractiveSuperviseOptions,
): InteractiveSupervised;
export function supervise(options: SuperviseOptions): Supervised;
export function supervise(
  options: SuperviseOptions | InteractiveSuperviseOptions,
): Supervised | InteractiveSupervised {
  const interactive = "stdinMode" in options;
  const maxStdinBytes = interactive
    ? (options.maxStdinBytes ?? 1024 * 1024)
    : 0;
  const stdinTimeoutMs = interactive ? (options.stdinTimeoutMs ?? 5000) : 0;
  if (
    interactive &&
    (!Number.isSafeInteger(maxStdinBytes) ||
      maxStdinBytes < 1 ||
      maxStdinBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(stdinTimeoutMs) ||
      stdinTimeoutMs < 1 ||
      stdinTimeoutMs > 30_000)
  )
    throw new Error("Interactive stdin bounds are invalid.");
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
  let inputFailure: Error | null = null;
  const inputWaiters = new Set<(error: Error) => void>();
  const failInput = (error: Error) => {
    inputFailure ??= error;
    for (const reject of inputWaiters) reject(inputFailure);
    inputWaiters.clear();
  };
  const kill = () => {
    failInput(new Error("Interactive stdin is closed."));
    killTree(proc.pid);
    if (interactive) guard.terminate?.();
  };

  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;

  if (!interactive) {
    if (options.stdin !== undefined) proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  let inputQueue = Promise.resolve();
  let inputBytes = 0;
  let totalInputBytes = 0;
  let inputFrames = 0;
  let inputEnded = false;
  let endPromise: Promise<void> | null = null;
  const enqueueInput = (
    bytes: number,
    action: () => number | Promise<number>,
  ): Promise<void> => {
    if (inputFailure) return Promise.reject(inputFailure);
    if (
      inputFrames >= 256 ||
      inputBytes + bytes > maxStdinBytes ||
      totalInputBytes + bytes > maxStdinBytes
    ) {
      const error = new Error(
        "Interactive stdin exceeded its queue bound or total byte bound.",
      );
      failInput(error);
      kill();
      return Promise.reject(error);
    }
    inputBytes += bytes;
    totalInputBytes += bytes;
    inputFrames++;
    const written = inputQueue.then(async () => {
      if (inputFailure) throw inputFailure;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          inputWaiters.delete(cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = (error: Error) => finish(error);
        const deadline = setTimeout(() => {
          const error = new Error(
            "Interactive stdin exceeded its write deadline.",
          );
          finish(error);
          failInput(error);
          kill();
        }, stdinTimeoutMs);
        inputWaiters.add(cancel);
        try {
          Promise.resolve(action()).then(
            () => finish(),
            () => {
              const error = new Error("Interactive stdin pipe is closed.");
              finish(error);
              failInput(error);
              kill();
            },
          );
        } catch {
          const error = new Error("Interactive stdin pipe is closed.");
          finish(error);
          failInput(error);
          kill();
        }
      });
    });
    const tracked = written.finally(() => {
      inputBytes -= bytes;
      inputFrames--;
    });
    inputQueue = tracked.catch(() => undefined);
    return tracked;
  };

  const pumped = pumpLines(
    proc.stdout,
    options.onLine,
    options.maxLineBytes,
  ).catch(() => {
    // A broken output protocol must not leave a producer blocked on its pipe.
    kill();
    options.onOutputError?.();
  });
  const stderrTail = readTail(proc.stderr, STDERR_TAIL_CHARS).catch(() => "");
  const done = (async (): Promise<ChildExit> => {
    try {
      const exitCode = await proc.exited;
      if (interactive) {
        // This per-turn owner retains no native helpers after the parent exits.
        killTree(proc.pid);
        guard.terminate?.();
        failInput(new Error("Interactive stdin is closed."));
      }
      await pumped.catch(() => undefined);
      const stderr = await stderrTail;
      return { exitCode, timedOut, stopped, stderr };
    } finally {
      if (timer) clearTimeout(timer);
      guard.release();
      live.delete(proc.pid);
    }
  })();

  const handle: Supervised = {
    pid: proc.pid,
    done,
    async stop() {
      stopped = true;
      kill();
      await done;
    },
  };
  if (!interactive) return handle;
  return {
    ...handle,
    write(input) {
      if (inputEnded || inputFailure)
        return Promise.reject(new Error("Interactive stdin is closed."));
      return enqueueInput(Buffer.byteLength(input), async () => {
        await proc.stdin.write(input);
        return proc.stdin.flush();
      });
    },
    end() {
      if (endPromise) return endPromise;
      inputEnded = true;
      endPromise = enqueueInput(0, () => proc.stdin.end());
      return endPromise;
    },
  };
}
