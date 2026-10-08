/**
 * Who an event belongs to, for emitters that are not the session itself.
 *
 * A script launched from a session (a phase gate, a quality gate, a review
 * round) has no hook payload to read its identity from. It attaches to the
 * live session through the mirror file the session leaves in its worktree,
 * and takes the model from the ledger's per-session cache. Nothing here
 * invents a value: what is not known is left out.
 */

import { readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Executor } from "../../types/hearth";
import { getSessionModel } from "./session-models";
import { resolveCheckout } from "./workspace";

type Env = Readonly<Record<string, string | undefined>>;

/** One line in the worktree root: the id of the session working there. */
export const SESSION_MIRROR_FILE = ".agent-forge-session";

/** A mirror older than this was left behind by a session that never cleaned up. */
const MIRROR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The session id mirrored into a worktree, or null when absent, malformed or stale. */
export function readSessionMirror(
  worktree: string,
  opts: { now?: () => Date } = {},
): string | null {
  try {
    const file = join(worktree, SESSION_MIRROR_FILE);
    const age = (opts.now?.() ?? new Date()).getTime() - statSync(file).mtimeMs;
    if (age > MIRROR_MAX_AGE_MS) return null;
    const lines = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    const id = lines.length === 1 ? lines[0]?.trim() : undefined;
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function writeSessionMirror(
  worktree: string,
  sessionId: string,
): boolean {
  try {
    writeFileSync(join(worktree, SESSION_MIRROR_FILE), `${sessionId}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Remove the mirror only if it still names `ifHolds`: a newer session's mirror is left alone. */
export function removeSessionMirror(
  worktree: string,
  ifHolds: string,
): boolean {
  try {
    const file = join(worktree, SESSION_MIRROR_FILE);
    if (readFileSync(file, "utf8").trim() !== ifHolds) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** What a caller knows about the work an event belongs to. */
export interface AttachHints {
  beadId?: string;
  runId?: string;
  executor?: Executor;
}

export interface AttachInput {
  cwd: string;
  env: Env;
  /** From command-line flags: wins over everything. */
  explicit?: AttachHints;
  /** From the run state: used when nothing closer is known. */
  fallback?: AttachHints;
  /** The ledger file to read the model cache from. */
  path?: string;
  now?: () => Date;
}

export interface Attach {
  workspace: string;
  worktree: string;
  sessionId?: string;
  executor?: Executor;
  beadId?: string;
  runId?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function sessionExecutor(
  sessionId: string,
  env: Env,
  path: string | undefined,
): Executor | undefined {
  const cached = getSessionModel(sessionId, path === undefined ? {} : { path });
  if (!cached) return undefined;
  const effort = cached.effort ?? nonEmpty(env.CLAUDE_EFFORT);
  return {
    provider: cached.provider,
    model: cached.model,
    ...(effort !== undefined ? { effort } : {}),
    sessionId,
  };
}

/** The executor stored on a run says who started it, not who is live now: its session id is dropped. */
function withoutSession(executor: Executor | undefined): Executor | undefined {
  if (!executor) return undefined;
  const { sessionId: _sessionId, ...rest } = executor;
  return rest;
}

/**
 * The correlation fields for an event emitted from `cwd`.
 *
 * - `sessionId`: the mirror in the worktree, else absent. The run state never
 *   supplies it, and neither does the environment: no variable there is part
 *   of the host's documented contract.
 * - `executor`: explicit flags, else the cached model of the session, else the
 *   executor stored on the run (without its session id), else absent.
 * - `beadId` / `runId`: explicit flag, else environment, else run state.
 */
export function resolveAttach(input: AttachInput): Attach {
  const { cwd, env, explicit, fallback } = input;
  const { workspace, worktree } = resolveCheckout(cwd);

  const sessionId =
    readSessionMirror(worktree, input.now ? { now: input.now } : {}) ??
    undefined;

  const base =
    explicit?.executor ??
    (sessionId !== undefined
      ? sessionExecutor(sessionId, env, input.path)
      : undefined) ??
    withoutSession(fallback?.executor);
  const smith = nonEmpty(env.AGENT_FORGE_SMITH);
  const executor =
    base && base.smith === undefined && smith !== undefined
      ? { ...base, smith }
      : base;

  const beadId =
    explicit?.beadId ?? nonEmpty(env.AGENT_FORGE_BEAD_ID) ?? fallback?.beadId;
  const runId = explicit?.runId ?? nonEmpty(env.FORGE_SLUG) ?? fallback?.runId;

  return {
    workspace,
    worktree,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(executor ? { executor } : {}),
    ...(beadId !== undefined ? { beadId } : {}),
    ...(runId !== undefined ? { runId } : {}),
  };
}
