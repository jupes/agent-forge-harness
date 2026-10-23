/**
 * Runs one child process with a timeout, a stop(), and a guarantee that it does
 * not outlive the harness. Every live child is registered; a parent `exit`
 * (including a crash or Ctrl-C) kills the whole tree synchronously. A
 * `SIGINT` or `SIGTERM` does the same and exits 130, unless an interrupt owner
 * (`ownInterrupts`) has dealt with it. A harness killed outright runs no exit
 * hook: each child's tree is guarded for that case as it starts
 * (`tree-guard.ts`).
 */

import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  INTERACTIVE_BOOTSTRAP_FLAG,
  INTERACTIVE_BOOTSTRAP_PREFIX,
  INTERACTIVE_START_MAX_BYTES,
} from "./interactive-bootstrap";
import { guardSuspendedWindowsProcess, guardTree } from "./tree-guard";
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
  /** Trusted packaged-entry/fixture prefix only. Never a public command surface. */
  bootstrapCommand?: readonly string[];
  /** Trusted startup-barrier fixture only; the normal process grants ownership immediately. */
  beforeStart?: () => Promise<void>;
  /** Trusted ownership-failure fixture seam only; never an HTTP or launch option. */
  interactiveGuard?: (pid: number) => {
    release(): void;
    terminate(): void;
  } | null;
}

export interface InteractiveSupervised extends Supervised {
  /** Actual provider identity; pid is the separately owned bootstrap tree root. */
  providerPid: Promise<number>;
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
  const target = interactive ? Bun.which(options.command[0] ?? "") : null;
  if (
    interactive &&
    (!target ||
      options.command.length > 32 ||
      options.command.some(
        (word) => !word || word.length > 8192 || word.includes("\0"),
      ))
  )
    throw new Error("The trusted interactive command is invalid.");
  const isolated = interactive
    ? mkdtempSync(join(tmpdir(), "agent-forge-interactive-"))
    : null;
  const cleanupIsolated = () => {
    if (isolated) {
      try {
        rmdirSync(isolated);
      } catch {
        /* Preserve unexpected files; never recursively remove another process's data. */
      }
    }
  };
  const bootstrap = interactive
    ? options.bootstrapCommand
      ? [...options.bootstrapCommand]
      : /^bun(?:\.exe)?$/i.test(basename(process.execPath))
        ? [
            process.execPath,
            "--no-env-file",
            "--no-install",
            `--config=${join(import.meta.dir, "interactive-bootstrap.bunfig.toml")}`,
            join(import.meta.dir, "interactive-bootstrap.ts"),
          ]
        : [process.execPath, INTERACTIVE_BOOTSTRAP_FLAG]
    : null;
  const bootstrapEnv: Record<string, string> = {};
  if (isolated) {
    for (const [name, value] of Object.entries(options.env))
      if (/^(?:systemroot|windir|temp|tmp)$/i.test(name))
        bootstrapEnv[name] = value;
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "BUN_INSTALL",
    ])
      bootstrapEnv[name] = isolated;
    bootstrapEnv.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
  }
  hookParentExit();
  const proc = (() => {
    try {
      return Bun.spawn(bootstrap ?? options.command, {
        cwd: isolated ?? options.cwd,
        env: interactive ? bootstrapEnv : options.env,
        stdin: "pipe",
        ...(process.platform === "win32" ? {} : { detached: true }),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      cleanupIsolated();
      throw error;
    }
  })();
  live.add(proc.pid);
  // For a harness ended outright, which runs no exit hook (`tree-guard.ts`).
  const selectGuard = () =>
    interactive
      ? options.interactiveGuard
        ? options.interactiveGuard(proc.pid)
        : process.platform === "win32"
          ? guardSuspendedWindowsProcess(proc.pid)
          : guardTree(proc.pid)
      : guardTree(proc.pid);
  let guard: ReturnType<typeof guardTree> | null;
  try {
    guard = selectGuard();
  } catch {
    guard = null;
  }
  if (guard === null) {
    // No protocol input has been written. Refuse rather than claim an unowned tree.
    proc.kill("SIGKILL");
    try {
      Promise.resolve(proc.stdin.end()).catch(() => undefined);
    } catch {
      // The failed child may already have closed its pipe.
    }
    void proc.stdout.cancel().catch(() => undefined);
    void proc.stderr.cancel().catch(() => undefined);
    live.delete(proc.pid);
    void proc.exited.then(cleanupIsolated);
    throw new Error("Interactive child ownership could not be established.");
  }

  let providerReady = false;
  let resolveProvider: (pid: number) => void = () => undefined;
  let rejectProvider: (error: Error) => void = () => undefined;
  const providerPid = new Promise<number>((resolve, reject) => {
    resolveProvider = resolve;
    rejectProvider = reject;
  });
  void providerPid.catch(() => undefined);

  let timedOut = false;
  let stopped = false;
  let exited = false;
  let inputFailure: Error | null = null;
  const inputWaiters = new Set<(error: Error) => void>();
  const failInput = (error: Error) => {
    inputFailure ??= error;
    if (!providerReady) rejectProvider(inputFailure);
    for (const reject of inputWaiters) reject(inputFailure);
    inputWaiters.clear();
  };
  const kill = () => {
    failInput(new Error("Interactive stdin is closed."));
    if (interactive && process.platform === "win32") guard.terminate?.();
    else if (!interactive || !exited) killTree(proc.pid);
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
    (line) => {
      if (interactive && !providerReady) {
        if (!line.startsWith(INTERACTIVE_BOOTSTRAP_PREFIX))
          throw new Error(
            "Interactive ownership acknowledgement is malformed.",
          );
        const pid = Number(line.slice(INTERACTIVE_BOOTSTRAP_PREFIX.length));
        if (!Number.isSafeInteger(pid) || pid < 1 || pid === proc.pid)
          throw new Error("Interactive provider identity is malformed.");
        providerReady = true;
        resolveProvider(pid);
        return;
      }
      options.onLine(line);
    },
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
      exited = true;
      if (interactive) {
        // Windows retains an owned job handle; POSIX descendants keep their process group alive.
        if (process.platform === "win32") guard.terminate?.();
        else killTree(proc.pid);
        failInput(new Error("Interactive stdin is closed."));
      }
      await pumped.catch(() => undefined);
      const stderr = await stderrTail;
      return { exitCode, timedOut, stopped, stderr };
    } finally {
      if (timer) clearTimeout(timer);
      guard.release();
      live.delete(proc.pid);
      cleanupIsolated();
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
  const start = `${JSON.stringify({ version: 1, command: [target, ...options.command.slice(1)], cwd: options.cwd, env: options.env, timeoutMs: Math.min(options.timeoutMs ?? 30 * 60_000, 30 * 60_000) })}\n`;
  if (Buffer.byteLength(start) > INTERACTIVE_START_MAX_BYTES) {
    failInput(new Error("The private ownership grant exceeded its bound."));
    kill();
  }
  // The one separately bounded control envelope is additional to the provider-input budget.
  else
    void enqueueInput(0, async () => {
      await options.beforeStart?.();
      await proc.stdin.write(start);
      return proc.stdin.flush();
    }).catch(() => undefined);
  return {
    ...handle,
    providerPid,
    write(input) {
      if (inputEnded || inputFailure)
        return Promise.reject(new Error("Interactive stdin is closed."));
      return enqueueInput(Buffer.byteLength(input), async () => {
        await providerPid;
        await proc.stdin.write(input);
        return proc.stdin.flush();
      });
    },
    end() {
      if (endPromise) return endPromise;
      inputEnded = true;
      endPromise = enqueueInput(0, async () => {
        await providerPid;
        return proc.stdin.end();
      });
      return endPromise;
    },
  };
}
