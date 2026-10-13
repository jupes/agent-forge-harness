/**
 * What the Timeline shows, from what the hearth answered: one bead's or one
 * run's ledger events in ledger order, narrowed by kind, as a window of rows.
 *
 * Pure: the hash, the read paths, the merge of pages, the kind filter, a line
 * per event and the window of rows in view. The reading itself is
 * `timeline-reader.ts`; the page is `islands/TimelineIsland.tsx`.
 */

import {
  LEDGER_EVENT_KINDS,
  type LedgerEvent,
  type LedgerEventKind,
} from "../../types/hearth";

/** The most events `/events` answers in one page. */
export const PAGE_LIMIT = 1000;

/** Whose events: one bead (with the sessions that touched it) or one forge run. */
export interface TimelineScope {
  by: "bead" | "run";
  id: string;
}

export interface TimelineQuery {
  scope: TimelineScope | null;
  /** The kinds shown, in the ledger's own order; none means every kind. */
  kinds: LedgerEventKind[];
}

const KIND_SET = new Set<string>(LEDGER_EVENT_KINDS);

function isKind(value: string): value is LedgerEventKind {
  return KIND_SET.has(value);
}

/** Known kinds, once each, in the order of `LEDGER_EVENT_KINDS`. */
function orderedKinds(names: readonly string[]): LedgerEventKind[] {
  const wanted = new Set(names);
  return LEDGER_EVENT_KINDS.filter((kind) => wanted.has(kind) && isKind(kind));
}

/**
 * The scope and kinds a `#/timeline?…` hash asks for. The scope is a bead or a
 * run, never both: the ledger would answer their intersection, and a link
 * only ever names one. When both are given the bead is used.
 */
export function parseTimelineHash(hash: string): TimelineQuery {
  const at = hash.indexOf("?");
  const params = new URLSearchParams(at === -1 ? "" : hash.slice(at + 1));
  const bead = params.get("bead") ?? "";
  const run = params.get("run") ?? "";
  const scope: TimelineScope | null =
    bead !== ""
      ? { by: "bead", id: bead }
      : run !== ""
        ? { by: "run", id: run }
        : null;
  const kinds = (params.get("kind") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return { scope, kinds: orderedKinds(kinds) };
}

/** The hash that asks for `query`. */
export function timelineHash(query: TimelineQuery): string {
  const params = new URLSearchParams();
  if (query.scope !== null) params.set(query.scope.by, query.scope.id);
  const kinds = orderedKinds(query.kinds);
  if (kinds.length > 0) params.set("kind", kinds.join(","));
  const search = params.toString();
  return search === "" ? "#/timeline" : `#/timeline?${search}`;
}

/** `params`, narrowed to `kinds` when any is given, as an `/events` path. */
function withKinds(
  params: URLSearchParams,
  kinds: readonly LedgerEventKind[],
): string {
  if (kinds.length > 0) params.set("kind", kinds.join(","));
  return `/events?${params.toString()}`;
}

/** A page of a scope's events after a cursor (of `kinds` only, when given), as the operator API path. */
export function eventsPath(
  scope: TimelineScope,
  after: number,
  kinds: readonly LedgerEventKind[] = [],
): string {
  const params = new URLSearchParams({
    [scope.by]: scope.id,
    after: String(after),
    limit: String(PAGE_LIMIT),
  });
  return withKinds(params, kinds);
}

/** Up to `limit` of one session's events after a cursor (of `kinds` only, when given). */
export function sessionPath(
  sessionId: string,
  after: number,
  limit: number,
  kinds: readonly LedgerEventKind[] = [],
): string {
  const params = new URLSearchParams({
    session: sessionId,
    after: String(after),
    limit: String(limit),
  });
  return withKinds(params, kinds);
}

/** The most events the Timeline holds for one scope: the newest are kept. */
export const EVENT_CAP = 10_000;

export interface Merged {
  events: LedgerEvent[];
  /** Events were left out to stay within the cap. */
  cut: boolean;
}

/** `held` and `incoming` together in id order, each id once, at most `cap` of the newest. */
export function mergeEvents(
  held: readonly LedgerEvent[],
  incoming: readonly LedgerEvent[],
  cap: number = EVENT_CAP,
): Merged {
  const byId = new Map<number, LedgerEvent>();
  for (const entry of held) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  const events = [...byId.values()].sort((a, b) => a.id - b.id);
  return events.length > cap
    ? { events: events.slice(events.length - cap), cut: true }
    : { events, cut: false };
}

export interface KindCount {
  kind: LedgerEventKind;
  count: number;
}

/**
 * How many events of each kind are present, in the order of
 * `LEDGER_EVENT_KINDS`. A kind in `present` that none of `events` has is
 * listed with a count of 0: the scope has events of it that are not held.
 */
export function kindCounts(
  events: readonly LedgerEvent[],
  present: readonly LedgerEventKind[] = [],
): KindCount[] {
  const counts = new Map<LedgerEventKind, number>();
  for (const kind of present) counts.set(kind, 0);
  for (const entry of events)
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  return LEDGER_EVENT_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined ? [] : [{ kind, count }];
  });
}

/** The events of the chosen kinds; every event when none is chosen. */
export function filterByKinds(
  events: readonly LedgerEvent[],
  kinds: readonly LedgerEventKind[],
): readonly LedgerEvent[] {
  if (kinds.length === 0) return events;
  const wanted = new Set(kinds);
  return events.filter((entry) => wanted.has(entry.kind));
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The parts that are present, joined. */
function parts(...pieces: Array<string | false | undefined>): string {
  return pieces.filter((piece) => typeof piece === "string").join(", ");
}

/**
 * One line for an event, from its payload. Payloads hold metadata only
 * (names, hashes, sizes, durations), so all of a payload may be shown.
 */
export function describeEvent(event: LedgerEvent): string {
  switch (event.kind) {
    case "session.started": {
      const { kind, worktree } = event.payload;
      return `session started${kind !== undefined ? ` (${kind})` : ""}${worktree !== undefined ? ` in ${worktree}` : ""}`;
    }
    case "session.ended": {
      const { reason, durationMs } = event.payload;
      return `session ended${reason !== undefined ? `: ${reason}` : ""}${durationMs !== undefined ? `, after ${duration(durationMs)}` : ""}`;
    }
    case "tool.called": {
      const { tool, exitCode, durationMs } = event.payload;
      return parts(
        tool,
        exitCode !== undefined && `exit ${exitCode}`,
        durationMs !== undefined && duration(durationMs),
      );
    }
    case "prompt.submitted":
      return `prompt of ${event.payload.length} characters`;
    case "run.phase.entered":
      return `entered ${event.payload.phase}`;
    case "run.phase.completed": {
      const { phase, artifact } = event.payload;
      return `completed ${phase}${artifact !== undefined ? `: ${artifact}` : ""}`;
    }
    case "review.recorded": {
      const { phase, round, verdict, findings, action } = event.payload;
      const counts = `${findings.blocker} blocker, ${findings.high} high, ${findings.medium} medium, ${findings.low} low`;
      return `${phase} review ${round}: ${verdict} (${counts})${action !== undefined ? `, ${action}` : ""}`;
    }
    case "gate.ran": {
      const { gate, passed, exitCode, durationMs } = event.payload;
      return parts(
        `${gate} ${passed ? "passed" : "failed"}`,
        exitCode !== undefined && `exit ${exitCode}`,
        durationMs !== undefined && duration(durationMs),
      );
    }
    case "verdict.bound": {
      const { verdict, summary } = event.payload;
      return `verdict ${verdict}${summary !== undefined ? `: ${summary}` : ""}`;
    }
    case "bead.transitioned": {
      const payload = event.payload;
      if ("action" in payload && payload.action !== undefined)
        return `${payload.action}${payload.length !== undefined ? ` (${payload.length} characters)` : ""}`;
      if (!("to" in payload) || payload.to === undefined) return "transitioned";
      const { from, to, reason } = payload;
      return `queue: ${from ?? "none"} → ${to}${reason !== undefined ? ` (${reason})` : ""}`;
    }
    case "reservation.acquired":
      return `reserved ${event.payload.globs.join(", ")} in ${event.payload.worktree}`;
    case "reservation.released":
      return `released ${event.payload.globs.join(", ")} in ${event.payload.worktree}`;
    case "shift.started":
      return `shift ${event.payload.shiftId} started, ${event.payload.concurrency} at a time`;
    case "shift.stopped":
      return `shift ${event.payload.shiftId} stopped: ${event.payload.reason}`;
    case "council.run.started":
      return `council ${event.payload.councilRunId} started (${event.payload.profile})`;
    case "council.run.finished": {
      const { councilRunId, outcome, costUsd } = event.payload;
      return `council ${councilRunId} finished: ${outcome}${costUsd !== undefined ? `, $${costUsd.toFixed(2)}` : ""}`;
    }
    case "friction.recorded":
      return `friction filed as ${event.payload.frictionBeadId}`;
    case "operator.action": {
      const { action, surface, target } = event.payload;
      return `${action} via ${surface}${target !== undefined ? ` on ${target}` : ""}`;
    }
  }
}

/** The height of one row of the list, in CSS pixels; the window maths depends on it. */
export const ROW_PX = 44;
/** Rows kept in the document above and below the ones in view. */
export const OVERSCAN = 10;

export interface WindowInput {
  scrollTop: number;
  viewportPx: number;
  rowPx: number;
  count: number;
  overscan: number;
}

/** The rows `[first, last)` to keep in the document for a scroll position. */
export function visibleWindow(input: WindowInput): {
  first: number;
  last: number;
} {
  const { viewportPx, rowPx, count, overscan } = input;
  if (count === 0) return { first: 0, last: 0 };
  // A position left over from a longer list counts as the end of this one.
  const top = Math.min(
    Math.max(0, input.scrollTop),
    Math.max(0, count * rowPx - viewportPx),
  );
  const first = Math.max(0, Math.floor(top / rowPx) - overscan);
  const last = Math.min(
    count,
    Math.ceil((top + viewportPx) / rowPx) + overscan,
  );
  return { first, last };
}
