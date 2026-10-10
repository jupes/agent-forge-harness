/**
 * What each Claude Code hook event becomes in the ledger.
 *
 * The hook scripts under `.claude/hooks/` are thin: they read the JSON the
 * host pipes on stdin and call one function here. Everything is metadata — a
 * prompt is its hash and length, a tool call is its name and a hash of its
 * input — and nothing here throws into the host: what is not known is left
 * out, and a failed write is `appendEvent`'s one stderr line.
 *
 * Loads `bun:sqlite` through the ledger, so only Bun entry points import it.
 */

import type {
  Executor,
  LedgerEventInput,
  SessionKind,
} from "../../types/hearth";
import { hashText } from "../hash-text";
import { type AppendResult, appendEvent } from "./append";
import { backupIfDue } from "./backup";
import { removeSessionMirror, writeSessionMirror } from "./identity";
import { ledgerPath } from "./paths";
import { openChildSessions } from "./query";
import {
  getSessionModel,
  type SessionModel,
  setSessionModel,
} from "./session-models";
import {
  effortOf,
  modelFromTranscriptTail,
  type TranscriptModel,
} from "./transcript-model";
import { resolveCheckout } from "./workspace";

type Env = Readonly<Record<string, string | undefined>>;

/** The JSON object a hook receives on stdin. Every field is unverified. */
export type HookInput = Readonly<Record<string, unknown>>;

/** Hooks only ever run inside this host, so the provider is a constant. */
const PROVIDER = "claude";

/** The env names whose value the probe compares with the hook's `session_id`. */
const SESSION_ENV_NAMES = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
] as const;

export interface HookIdentity {
  /** The ledger's session key: the host's id, or `<host id>:<agent id>` for a child. */
  sessionId: string;
  /** The `session_id` the host sent, shared by a session and its subagents. */
  hostSessionId: string;
  parentSessionId?: string;
  kind: SessionKind;
}

/** Everything a handler touches outside its arguments, so tests can replace any of it. */
export interface HookDeps {
  env: Env;
  /** Used when stdin carries no `cwd`. */
  cwd: string;
  append(event: LedgerEventInput): AppendResult;
  getModel(sessionId: string): SessionModel | null;
  setModel(entry: SessionModel & { sessionId: string }): boolean;
  readTranscript(path: string): TranscriptModel | null;
  openChildren(sessionId: string): string[];
  writeMirror(worktree: string, sessionId: string): boolean;
  removeMirror(worktree: string, ifHolds: string): boolean;
  backupIfDue(): boolean;
}

/** The real dependencies, bound to one ledger file. */
export function hookDeps(opts: {
  env: Env;
  cwd: string;
  path?: string;
  now?: () => Date;
}): HookDeps {
  const path = opts.path ?? ledgerPath(opts.env);
  const clock = opts.now ? { now: opts.now } : {};
  return {
    env: opts.env,
    cwd: opts.cwd,
    append: (event) => appendEvent(event, { path, ...clock }),
    getModel: (sessionId) => getSessionModel(sessionId, { path }),
    setModel: (entry) => setSessionModel(entry, { path, ...clock }),
    readTranscript: (file) => modelFromTranscriptTail(file),
    openChildren: (sessionId) => openChildSessions(sessionId, { path }),
    writeMirror: writeSessionMirror,
    removeMirror: removeSessionMirror,
    backupIfDue: () => backupIfDue({ path, ...clock }),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * Who a hook payload speaks for. A payload with `agent_id` comes from inside a
 * subagent call and shares its parent's `session_id`, so it becomes a child
 * session; it is a teammate only when the payload says so. A session started
 * with a parent in its environment is a teammate with an id of its own.
 */
export function sessionIdentity(
  input: HookInput,
  env: Env = {},
): HookIdentity | null {
  const hostSessionId = text(input.session_id);
  if (hostSessionId === undefined) return null;
  const agentId = text(input.agent_id);
  const teammate = text(input.teammate_name) !== undefined;
  if (agentId !== undefined)
    return {
      sessionId: `${hostSessionId}:${agentId}`,
      hostSessionId,
      parentSessionId: hostSessionId,
      kind: teammate ? "teammate" : "subagent",
    };
  const parent = text(env.AGENT_FORGE_PARENT_SESSION);
  if (parent !== undefined || teammate)
    return {
      sessionId: hostSessionId,
      hostSessionId,
      ...(parent !== undefined ? { parentSessionId: parent } : {}),
      kind: "teammate",
    };
  return { sessionId: hostSessionId, hostSessionId, kind: "interactive" };
}

/** Stdin `effort` is `{ level }`; a plain string is accepted; anything else is ignored. */
export function effortLevel(input: HookInput): string | undefined {
  return effortOf(input.effort);
}

interface Context {
  identity: HookIdentity;
  workspace: string;
  worktree: string;
  beadId?: string;
  runId?: string;
}

function contextOf(input: HookInput, deps: HookDeps): Context | null {
  const identity = sessionIdentity(input, deps.env);
  if (identity === null) return null;
  const { workspace, worktree } = resolveCheckout(text(input.cwd) ?? deps.cwd);
  const beadId = text(deps.env.AGENT_FORGE_BEAD_ID);
  const runId = text(deps.env.FORGE_SLUG);
  return {
    identity,
    workspace,
    worktree,
    ...(beadId !== undefined ? { beadId } : {}),
    ...(runId !== undefined ? { runId } : {}),
  };
}

/** The cached model for a session, or for its parent when it has none of its own. */
function cachedModel(
  identity: HookIdentity,
  deps: HookDeps,
): { owner: string; model: SessionModel } | null {
  const own = deps.getModel(identity.sessionId);
  if (own) return { owner: identity.sessionId, model: own };
  if (identity.hostSessionId === identity.sessionId) return null;
  const parent = deps.getModel(identity.hostSessionId);
  return parent ? { owner: identity.hostSessionId, model: parent } : null;
}

/**
 * The executor to put on an event, or undefined when no model is known — an
 * event is never tagged with a guessed model. An effort level on stdin is the
 * current one: it goes on the event and into the cache.
 */
function executorOf(
  input: HookInput,
  identity: HookIdentity,
  deps: HookDeps,
): Executor | undefined {
  const cached = cachedModel(identity, deps);
  if (cached === null) return undefined;
  const stdinEffort = effortLevel(input);
  if (stdinEffort !== undefined && stdinEffort !== cached.model.effort)
    deps.setModel({
      ...cached.model,
      effort: stdinEffort,
      sessionId: cached.owner,
    });
  const effort = stdinEffort ?? cached.model.effort;
  const smith = text(deps.env.AGENT_FORGE_SMITH);
  return {
    provider: cached.model.provider,
    model: cached.model.model,
    ...(effort !== undefined ? { effort } : {}),
    ...(smith !== undefined ? { smith } : {}),
    sessionId: identity.sessionId,
  };
}

/** The correlation fields every event of this payload shares. */
function envelope(
  context: Context,
  executor: Executor | undefined,
  sessionId: string = context.identity.sessionId,
): Pick<
  LedgerEventInput,
  "workspace" | "sessionId" | "beadId" | "runId" | "executor"
> {
  return {
    workspace: context.workspace,
    sessionId,
    ...(context.beadId !== undefined ? { beadId: context.beadId } : {}),
    ...(context.runId !== undefined ? { runId: context.runId } : {}),
    ...(executor ? { executor: { ...executor, sessionId } } : {}),
  };
}

/**
 * A child session has no start hook of its own, so its `session.started` is
 * offered before each of its events; the ledger keeps the first and ignores
 * the rest, which also holds when several hooks race.
 */
function startChild(
  context: Context,
  executor: Executor | undefined,
  deps: HookDeps,
): void {
  const { identity } = context;
  if (identity.sessionId === identity.hostSessionId) return;
  deps.append({
    kind: "session.started",
    ...envelope(context, executor),
    payload: {
      kind: identity.kind,
      worktree: context.worktree,
      parentSessionId: identity.hostSessionId,
    },
  });
}

/** Fill the model cache from the transcript when it has nothing for this session. */
function learnModel(
  input: HookInput,
  identity: HookIdentity,
  deps: HookDeps,
): void {
  if (cachedModel(identity, deps) !== null) return;
  const transcript = text(input.transcript_path);
  if (transcript === undefined) return;
  const found = deps.readTranscript(transcript);
  // The transcript is the host session's, so the model is recorded for it; a
  // child reads it through the parent fallback.
  if (found)
    deps.setModel({
      sessionId: identity.hostSessionId,
      provider: PROVIDER,
      ...found,
    });
}

/**
 * SessionStart: remember the model when the host reports one, record the
 * session once, and leave the mirror that lets scripts launched from this
 * worktree attach to it. A resume, clear or compact of a known session offers
 * the same start again and the ledger ignores it.
 */
export function handleSessionStart(input: HookInput, deps: HookDeps): void {
  const context = contextOf(input, deps);
  if (context === null) return;
  const { identity } = context;
  const model = text(input.model);
  if (model !== undefined) {
    const effort = effortLevel(input);
    deps.setModel({
      sessionId: identity.sessionId,
      provider: PROVIDER,
      model,
      ...(effort !== undefined ? { effort } : {}),
    });
  }
  const source = text(input.source);
  deps.append({
    kind: "session.started",
    ...envelope(context, executorOf(input, identity, deps)),
    payload: {
      ...(source !== undefined ? { source } : {}),
      kind: identity.kind,
      worktree: context.worktree,
      ...(identity.parentSessionId !== undefined
        ? { parentSessionId: identity.parentSessionId }
        : {}),
    },
  });
  if (identity.sessionId === identity.hostSessionId)
    deps.writeMirror(context.worktree, identity.sessionId);
  deps.backupIfDue();
}

/** UserPromptSubmit: the prompt's hash and length. */
export function handlePrompt(input: HookInput, deps: HookDeps): void {
  const context = contextOf(input, deps);
  if (context === null || typeof input.prompt !== "string") return;
  const executor = executorOf(input, context.identity, deps);
  startChild(context, executor, deps);
  deps.append({
    kind: "prompt.submitted",
    ...envelope(context, executor),
    payload: { hash: hashText(input.prompt), length: input.prompt.length },
  });
}

/**
 * PostToolUse: the tool's name, a hash of its input and, when the host
 * supplies it, how long it ran. The host gives no exit code. A tool call means
 * an assistant turn exists, so this is also where a session with no cached
 * model reads its transcript — once, since the result is cached.
 */
export function handleToolUse(input: HookInput, deps: HookDeps): void {
  const context = contextOf(input, deps);
  const tool = text(input.tool_name);
  if (context === null || tool === undefined) return;
  learnModel(input, context.identity, deps);
  const executor = executorOf(input, context.identity, deps);
  startChild(context, executor, deps);
  const duration = input.duration_ms;
  deps.append({
    kind: "tool.called",
    ...envelope(context, executor),
    payload: {
      tool,
      argsHash: hashText(JSON.stringify(input.tool_input ?? null)),
      ...(typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration >= 0
        ? { durationMs: Math.round(duration) }
        : {}),
    },
  });
}

/**
 * Stop: no event (there is no stop kind). The turn that just ended is in the
 * transcript, so the cached model is brought up to date — this is how a model
 * switched mid-session is noticed.
 */
export function handleStop(input: HookInput, deps: HookDeps): void {
  const identity = sessionIdentity(input, deps.env);
  if (identity === null) return;
  const transcript = text(input.transcript_path);
  const found =
    transcript === undefined ? null : deps.readTranscript(transcript);
  const cached = deps.getModel(identity.sessionId);
  const effort = effortLevel(input) ?? found?.effort;
  const model = found?.model ?? cached?.model;
  if (model === undefined) return;
  if (
    cached !== null &&
    cached.model === model &&
    (effort === undefined || effort === cached.effort)
  )
    return;
  deps.setModel({
    sessionId: identity.sessionId,
    provider: cached?.provider ?? PROVIDER,
    model,
    ...(effort !== undefined ? { effort } : {}),
  });
}

/**
 * SessionEnd: end the session's open children, then the session, and drop
 * the mirror if it is still this session's. A payload that names no session
 * ends nothing. The tracker is not touched: the end of a session is handed
 * nothing a push could be made through.
 */
export function handleSessionEnd(input: HookInput, deps: HookDeps): void {
  const context = contextOf(input, deps);
  if (context === null) return;
  const { identity } = context;
  const executor = executorOf(input, identity, deps);
  for (const child of deps.openChildren(identity.sessionId))
    deps.append({
      kind: "session.ended",
      ...envelope(context, executor, child),
      payload: { reason: "parent-ended" },
    });
  const reason = text(input.reason);
  deps.append({
    kind: "session.ended",
    ...envelope(context, executor),
    payload: reason !== undefined ? { reason } : {},
  });
  deps.removeMirror(context.worktree, identity.sessionId);
}

export interface HookProbe {
  event: string | null;
  /** The names of the stdin fields, sorted. */
  keys: string[];
  /** The names inside stdin `effort`, when it is an object. */
  effortKeys?: string[];
  /** The names of the host's own environment variables, sorted. */
  env: string[];
  /** Per exported id: whether it equals the hook's `session_id`; null when unset. */
  sessionIdEquals: Record<(typeof SESSION_ENV_NAMES)[number], boolean | null>;
}

/**
 * The shape of a hook call, for checking the host's contract: field names,
 * variable names and three booleans. No value from stdin or the environment
 * is ever part of the result.
 */
export function probeKeys(input: HookInput, env: Env): HookProbe {
  const effort = input.effort;
  const sessionId = text(input.session_id);
  const equals = (name: string): boolean | null => {
    const value = text(env[name]);
    return value === undefined ? null : value === sessionId;
  };
  return {
    event: text(input.hook_event_name) ?? null,
    keys: Object.keys(input).sort(),
    ...(typeof effort === "object" && effort !== null && !Array.isArray(effort)
      ? { effortKeys: Object.keys(effort).sort() }
      : {}),
    env: Object.keys(env)
      .filter((name) => name.startsWith("CLAUDE_"))
      .sort(),
    sessionIdEquals: {
      CLAUDE_CODE_SESSION_ID: equals("CLAUDE_CODE_SESSION_ID"),
      CLAUDE_CODE_HOST_SESSION_ID: equals("CLAUDE_CODE_HOST_SESSION_ID"),
      CLAUDE_CODE_CHILD_SESSION: equals("CLAUDE_CODE_CHILD_SESSION"),
    },
  };
}
