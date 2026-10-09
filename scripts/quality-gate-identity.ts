/**
 * What a quality-gate result belongs to: its checkout, and the Beads issue and
 * Forge run it was explicitly correlated to.
 *
 * `.claude/hooks/quality-gate.ts` appends every run to one user-global log
 * that every checkout and worktree on the machine shares. Recording this with
 * each entry is what lets a reader — the dashboard's Forge run view — show a
 * result only where it applies.
 *
 * Two identities meet at the gate and are kept apart:
 *
 * - the Beads issue and the run, which come only from a validated run
 *   correlation (`run-correlation.ts`). Without one the entry is unlinked: it
 *   names no issue and no run, and no run is guessed for it;
 * - the host's own identity (its task id, team, session and teammate), read
 *   from the hook payload and recorded as inert metadata. It is never a Beads
 *   id and is never passed to `bd`, a command line or a file path.
 *
 * Nothing here touches disk: the dashboard bundles this module.
 */

import type { HookStdin } from "../.claude/hooks/utils/hook-input";
import type { BeadsIssueId, RunCorrelation } from "./run-correlation";

/** The hook events the gate is registered for. */
const GATE_EVENTS = ["TaskCompleted", "TeammateIdle"] as const;

export type GateEvent = (typeof GATE_EVENTS)[number];

function isGateEvent(value: unknown): value is GateEvent {
  return (GATE_EVENTS as readonly unknown[]).includes(value);
}

/** Who said which event this is: the host's payload, the command line, or nobody. */
export type GateEventSource = "stdin" | "argv" | "default";

/**
 * What stdin was when the gate ran. `silent` is a pipe that sent nothing in
 * the time allowed: with the default event, a payload that never arrived.
 */
export type GateStdinState = "payload" | "terminal" | "empty" | "silent";

/**
 * The host task list a host task id is local to: the agent team the payload
 * names. A host task in any other kind of list is recorded without a scope.
 */
export interface HostTaskScope {
  kind: "agent-team";
  id: string;
}

/**
 * The host's own identity for the event that ran the gate. Every field is
 * optional, unverified and for display only.
 */
export interface GateHostIdentity {
  hostTaskScope?: HostTaskScope;
  /** The host's `task_id`: local to one task list, and never a Beads id. */
  hostTaskId?: string;
  /** Who created the host task. No event the gate runs on reports these. */
  creatorHostSessionId?: string;
  creatorTeammateName?: string;
  /** The session and teammate whose TaskCompleted ran the gate. */
  completerHostSessionId?: string;
  completerTeammateName?: string;
  /** The teammate a TeammateIdle is about. */
  idleTeammateName?: string;
}

/** The plain-text fields of `GateHostIdentity`, for anything that walks them. */
export const GATE_HOST_TEXT_FIELDS = [
  "hostTaskId",
  "creatorHostSessionId",
  "creatorTeammateName",
  "completerHostSessionId",
  "completerTeammateName",
  "idleTeammateName",
] as const satisfies readonly (keyof GateHostIdentity)[];

export const GATE_LOG_SCHEMA_VERSION = 2 as const;

export interface GateIdentity {
  schemaVersion: typeof GATE_LOG_SCHEMA_VERSION;
  /** Top level of the checkout the gate ran in. */
  checkout: string;
  /** Branch checked out at the time, or null for a detached HEAD. */
  branch: string | null;
  /** From the run correlation. Null, with `executionRunId`, on an unlinked entry. */
  beadsIssueId: BeadsIssueId | null;
  /** From the run correlation: the Forge run id. */
  executionRunId: string | null;
  /** Why the entry is unlinked. Absent on a linked one. */
  unlinkedReason?: string;
  host?: GateHostIdentity;
}

export type GateInvocation =
  | {
      ok: true;
      event: GateEvent;
      eventSource: GateEventSource;
      stdin: GateStdinState;
      host?: GateHostIdentity;
    }
  | { ok: false; error: string };

/** Longer than any id or name a host sends; a value over it is not recorded. */
const HOST_TEXT_LIMIT = 200;

/** True when `text` holds a control character: nothing a name or an id has. */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A host-supplied value as short plain text, or undefined when it is not that. */
export function hostText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 &&
    text.length <= HOST_TEXT_LIMIT &&
    !hasControlCharacter(text)
    ? text
    : undefined;
}

function hostIdentity(
  event: GateEvent,
  input: Readonly<Record<string, unknown>>,
): GateHostIdentity | undefined {
  const team = hostText(input.team_name);
  const teammate = hostText(input.teammate_name);
  const taskId = hostText(input.task_id);
  const session = hostText(input.session_id);
  const completed = event === "TaskCompleted";
  const host: GateHostIdentity = {
    ...(team !== undefined
      ? { hostTaskScope: { kind: "agent-team", id: team } }
      : {}),
    ...(completed && taskId !== undefined ? { hostTaskId: taskId } : {}),
    ...(completed && session !== undefined
      ? { completerHostSessionId: session }
      : {}),
    ...(completed && teammate !== undefined
      ? { completerTeammateName: teammate }
      : {}),
    ...(!completed && teammate !== undefined
      ? { idleTeammateName: teammate }
      : {}),
  };
  return Object.keys(host).length > 0 ? host : undefined;
}

/**
 * Which event a gate run is for, and what the host said about itself.
 *
 * The event is the host's payload's. Without a payload (a run by hand, or
 * stdin that never arrived) it is the one named on the command line, else
 * TaskCompleted: the full set of checks. The gate does not guess: input that
 * arrived and is not a TaskCompleted or TeammateIdle payload is refused, and
 * so is a payload that names one event while the command line names the other.
 */
export function gateInvocation(
  stdin: HookStdin,
  argv: readonly string[],
): GateInvocation {
  if (stdin.kind === "malformed") return { ok: false, error: stdin.error };
  const named = argv.find(isGateEvent);
  if (stdin.kind === "none") {
    return named !== undefined
      ? { ok: true, event: named, eventSource: "argv", stdin: stdin.reason }
      : {
          ok: true,
          event: "TaskCompleted",
          eventSource: "default",
          stdin: stdin.reason,
        };
  }
  const event = stdin.input.hook_event_name;
  if (!isGateEvent(event)) {
    return {
      ok: false,
      error: `stdin hook_event_name must be ${GATE_EVENTS.join(" or ")}`,
    };
  }
  if (named !== undefined && named !== event) {
    return {
      ok: false,
      error: `stdin says ${event} but the command line says ${named}`,
    };
  }
  const host = hostIdentity(event, stdin.input);
  return {
    ok: true,
    event,
    eventSource: "stdin",
    stdin: "payload",
    ...(host !== undefined ? { host } : {}),
  };
}

export function gateIdentity(input: {
  cwd: string;
  /** `git rev-parse --show-toplevel`, or null outside a git checkout. */
  gitToplevel: string | null;
  /** `git rev-parse --abbrev-ref HEAD`, or null if it failed. */
  gitBranch: string | null;
  /** The validated correlation the gate was pointed at, or null. */
  correlation: RunCorrelation | null;
  /** Why there is no correlation. Ignored when there is one. */
  unlinkedReason?: string;
  host?: GateHostIdentity;
}): GateIdentity {
  const { correlation } = input;
  const branch = input.gitBranch?.trim() || null;
  return {
    schemaVersion: GATE_LOG_SCHEMA_VERSION,
    checkout: input.gitToplevel?.trim() || input.cwd,
    branch: branch === "HEAD" ? null : branch,
    beadsIssueId: correlation?.beadsIssueId ?? null,
    executionRunId: correlation?.executionRunId ?? null,
    ...(correlation === null && input.unlinkedReason
      ? { unlinkedReason: input.unlinkedReason }
      : {}),
    ...(input.host ? { host: input.host } : {}),
  };
}
