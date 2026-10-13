import type { LedgerEventInput, Provider, Smith } from "../../types/hearth";

/** What a sink says about one event: stored, or not and why. */
export type SinkResult = { ok: true } | { ok: false; error: string };

/**
 * Where a run's events are stored (`sinks.ts` has the ledger's). A sink
 * reports a failure instead of throwing: a run must not stop because its
 * audit trail could not be written. A sink that returns nothing has taken the
 * event.
 */
export type EventSink = (
  event: LedgerEventInput,
) => SinkResult | void | Promise<SinkResult> | Promise<void>;

export interface SpawnRequest {
  beadId: string;
  /** Directory the executor runs in. May contain spaces. */
  worktree: string;
  /**
   * The harness root the run was launched from. Events carry its main checkout
   * (a linked worktree resolves to the checkout it belongs to); adapter
   * preparation such as `codex:sync` runs in the directory as given.
   */
  workspace: string;
  smith: Smith;
  /** Sent on stdin, never argv: argv is parsed by cmd.exe when a `.cmd` shim is involved. */
  prompt: string;
  /**
   * Already filtered by `buildChildEnv`. The child receives this plus the
   * variables its adapter sets itself (`childEnv` in `env.ts`).
   */
  env: Record<string, string>;
  runId?: string | undefined;
  /** The session that launched this run, when one is known. */
  parentSessionId?: string | undefined;
  timeoutMs?: number | undefined;
  /** Replaces the resolved binary (tests point this at a fake). Adapter flags are appended. */
  command?: string[] | undefined;
}

/** How a supervised child ended. */
export interface ChildExit {
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  /**
   * The end of what the child wrote to stderr (`STDERR_TAIL_CHARS` at most).
   * Shown in a command's own output, never stored in the ledger.
   */
  stderr: string;
}

/** How a run ended: the child's exit, and what the provider said went wrong. */
export interface ExecResult extends ChildExit {
  /**
   * The errors the provider reported in its own stream, in its words, oldest
   * first and each once. Shown in a command's own output, never stored in the
   * ledger.
   */
  providerErrors: string[];
}

export interface ExecutorHandle {
  /**
   * The id every event of the run carries: the provider's own, taken from the
   * first stream line that reports it, else one the adapter minted. Until the
   * run's first event it can still change from the minted id to the
   * provider's, so read it after an event (or after `done`).
   */
  readonly sessionId: string;
  pid: number;
  /** Every event the run produces, in order. Ends after `session.ended`. */
  events: AsyncIterable<LedgerEventInput>;
  done: Promise<ExecResult>;
  stop(reason: string): Promise<void>;
}

export interface DoctorResult {
  provider: Provider;
  /**
   * The binary is there: the provider's on PATH, or an override's program
   * (its first item) as `Bun.which` finds it. Found says nothing about
   * whether it runs.
   */
  found: boolean;
  /**
   * The binary answered `--version` with exit 0. That is all: a CLI that is
   * not signed in, or cannot run a tool, answers it too (`forge:doctor --task`).
   */
  ok: boolean;
  version?: string | undefined;
  path?: string | undefined;
  reason?: string | undefined;
}

export interface ExecutorAdapter {
  provider: Provider;
  doctor(command?: string[]): Promise<DoctorResult>;
  spawn(request: SpawnRequest): Promise<ExecutorHandle>;
}
