import type { LedgerEventInput, Provider, Smith } from "../../types/hearth";

/** Where adapters send events. Swap for the ledger's `appendEvent` once it exists. */
export type EventSink = (event: LedgerEventInput) => void | Promise<void>;

export interface SpawnRequest {
  beadId: string;
  /** Directory the executor runs in. May contain spaces. */
  worktree: string;
  /** Workspace the events belong to (the harness root). */
  workspace: string;
  smith: Smith;
  /** Sent on stdin, never argv: argv is parsed by cmd.exe when a `.cmd` shim is involved. */
  prompt: string;
  /** Already filtered by `buildChildEnv`; the child receives exactly this. */
  env: Record<string, string>;
  runId?: string | undefined;
  timeoutMs?: number | undefined;
  /** Replaces the resolved binary (tests point this at a fake). Adapter flags are appended. */
  command?: string[] | undefined;
}

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
}

export interface ExecutorHandle {
  sessionId: string;
  pid: number;
  /** Every event the run produces, in order. Ends after `session.ended`. */
  events: AsyncIterable<LedgerEventInput>;
  done: Promise<ExecResult>;
  stop(reason: string): Promise<void>;
}

export interface DoctorResult {
  provider: Provider;
  found: boolean;
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
