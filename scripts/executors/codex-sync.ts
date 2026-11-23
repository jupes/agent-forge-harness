import { codexSyncDirectory } from "./codex";
import { type Supervised, supervise } from "./supervisor";

export interface CodexSyncOptions {
  workspace: string;
  worktree: string;
  /** Trusted source/packaged prefix only. Public requests never supply this command. */
  command: readonly string[];
  /** Already filtered by the caller's provider environment policy. */
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Capped at thirty seconds, including when the caller has a longer run budget. */
  timeoutMs?: number;
}

export class CodexSyncError extends Error {
  constructor() {
    super("Codex skill sync did not complete successfully.");
    this.name = "CodexSyncError";
  }
}

/** One bounded sync process, in the same checkout selected by the canonical executor. */
export async function syncCodexSkills(
  options: CodexSyncOptions,
): Promise<void> {
  if (options.signal?.aborted) throw new CodexSyncError();
  const cwd = codexSyncDirectory(options);
  if (cwd === undefined) return;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const prefix = [...options.command];
  const executable = prefix[0] ? Bun.which(prefix[0]) : null;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !executable ||
    prefix.length > 16 ||
    prefix.some((word) => !word || word.length > 4096 || word.includes("\0")) ||
    (process.platform === "win32" && !/\.exe$/i.test(executable))
  )
    throw new CodexSyncError();
  let invalid = false,
    bytes = 0;
  let child: Supervised;
  try {
    child = supervise({
      command: [executable, ...prefix.slice(1)],
      cwd,
      env: { ...options.env },
      timeoutMs: Math.min(timeoutMs, 30_000),
      maxLineBytes: 65_536,
      onOutputError: () => {
        invalid = true;
      },
      onLine: (line) => {
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > 131_072) throw new CodexSyncError();
      },
    });
  } catch {
    throw new CodexSyncError();
  }
  const stop = () => {
    void child.stop("Codex skill sync stopped");
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    const exit = await child.done;
    if (invalid || exit.exitCode !== 0 || exit.timedOut || exit.stopped)
      throw new CodexSyncError();
  } finally {
    options.signal?.removeEventListener("abort", stop);
    await child.done;
  }
}
