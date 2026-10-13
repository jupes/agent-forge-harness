/**
 * Pure state helpers for the dashboard shell.
 *
 * Kept apart from `app.tsx` so the rules that decide what renders — and what
 * a failed snapshot fetch may and may not hide — are testable without a DOM.
 */

import type { SnapshotSource } from "../../types/beads";
import type {
  LedgerEvent,
  OperatorEnvelope,
  QueueEntry,
  Reservation,
  SessionSummary,
  StreamSnapshot,
} from "../../types/hearth";
import { type RouteId, routeFor } from "./router";

/**
 * Routes that read `docs/data/beads.json`.
 *
 * Everything else must render even when that fetch fails. The old shell got
 * this wrong: `loadData()`'s catch branch overwrote the content area and never
 * called `render()`, so a first-load deep link to Commands, Skill builder or
 * Bead builder — none of which touch Beads data — showed raw error text until
 * the user clicked something.
 */
const SNAPSHOT_ROUTES = new Set<RouteId>([
  "dashboard",
  "issues",
  "epics",
  "insights",
]);

export function needsSnapshot(route: RouteId): boolean {
  return SNAPSHOT_ROUTES.has(route);
}

export interface SnapshotLabel {
  label: string;
  /** Raw ISO string for the title attribute; empty when unknown. */
  iso: string;
}

/**
 * Sidebar snapshot line: local time to read, ISO on hover. A snapshot built
 * from the fallback file says so, with the file's age.
 */
export function snapshotLabelFor(
  generatedAt: string | null,
  source?: SnapshotSource,
): SnapshotLabel {
  const raw = String(generatedAt ?? "").trim();
  if (!raw) return { label: "Snapshot: not loaded", iso: "" };

  const parsed = new Date(raw);
  const built = Number.isNaN(parsed.getTime())
    ? raw
    : parsed.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
  const fallback =
    source?.kind === "file"
      ? ` · from ${source.path} (written ${fileDate(source.modifiedAt)}); bd did not answer`
      : "";
  return { label: `Snapshot built: ${built}${fallback}`, iso: raw };
}

function fileDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export interface PageHeading {
  title: string;
  blurb: string;
}

export function pageTitleFor(route: RouteId): PageHeading {
  const definition = routeFor(route);
  return { title: definition.label, blurb: definition.blurb };
}

// ── Live state: what the hearth's event stream has told this page ───────────
//
// Pure rules. `use-stream.ts` owns the connection and calls these; nothing
// here knows about a network, a timer or a component.

/** `off` is final for the page: nothing asks again until it is loaded anew. */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "off";

/** Why live updates are off: nothing serves a stream here, or one was lost and did not come back. */
export type LiveOffReason = "no-hearth" | "lost";

/** One collection of the snapshot. `data` is null while it is unknown; `error` says why when the hearth did. */
export interface LiveCollection<T> {
  data: T | null;
  error: string | null;
}

export type LiveCollectionName = Exclude<keyof StreamSnapshot, "cursor">;

type CollectionData<K extends LiveCollectionName> =
  StreamSnapshot[K] extends OperatorEnvelope<infer T> ? T : never;

export type LiveState = {
  status: LiveStatus;
  offReason: LiveOffReason | null;
  /** The newest ledger id applied; null before the first snapshot. */
  cursor: number | null;
} & { [K in LiveCollectionName]: LiveCollection<CollectionData<K>> };

/** The session route's own maximum; the merged list never grows past it. */
export const MAX_LIVE_SESSIONS = 500;

const UNKNOWN = { data: null, error: null } as const;

export const INITIAL_LIVE_STATE: LiveState = {
  status: "connecting",
  offReason: null,
  cursor: null,
  sessions: UNKNOWN,
  runs: UNKNOWN,
  queue: UNKNOWN,
  reservations: UNKNOWN,
  smiths: UNKNOWN,
  config: UNKNOWN,
};

function collectionOf<T>(envelope: OperatorEnvelope<T>): LiveCollection<T> {
  return envelope.ok
    ? { data: envelope.data, error: null }
    : { data: null, error: envelope.error };
}

/**
 * A snapshot replaces everything, the cursor included, even when its cursor
 * is lower than the one held: the hearth answers a resume from an id ahead of
 * its ledger with a snapshot (the ledger was replaced), and what follows the
 * new cursor must then apply.
 */
export function applySnapshot(
  state: LiveState,
  snapshot: StreamSnapshot,
): LiveState {
  return {
    ...state,
    status: "live",
    offReason: null,
    cursor: snapshot.cursor,
    sessions: collectionOf(snapshot.sessions),
    runs: collectionOf(snapshot.runs),
    queue: collectionOf(snapshot.queue),
    reservations: collectionOf(snapshot.reservations),
    smiths: collectionOf(snapshot.smiths),
    config: collectionOf(snapshot.config),
  };
}

/** One session after `event`, folded as `listSessions` (scripts/ledger/query.ts) folds the ledger. */
function sessionAfter(
  known: SessionSummary | undefined,
  sessionId: string,
  event: LedgerEvent,
): SessionSummary {
  // `endedAt` holds only while the newest event is the end of the session.
  const { endedAt: _ended, ...kept } = known ?? {
    sessionId,
    workspace: event.workspace,
    lastEventAt: event.ts,
  };
  const next: SessionSummary = { ...kept, lastEventAt: event.ts };
  if (event.kind === "session.ended") next.endedAt = event.ts;
  if (event.kind === "session.started") {
    const { kind, worktree, parentSessionId } = event.payload;
    if (kind !== undefined) next.kind = kind;
    if (worktree !== undefined) next.worktree = worktree;
    if (parentSessionId !== undefined) next.parentSessionId = parentSessionId;
    next.startedAt = event.ts;
  }
  const by = event.executor;
  if (by?.provider && by.model)
    next.executor = {
      provider: by.provider,
      model: by.model,
      ...(by.effort !== undefined ? { effort: by.effort } : {}),
      ...(by.smith !== undefined ? { smith: by.smith } : {}),
      sessionId,
    };
  if (event.beadId) next.beadId = event.beadId;
  if (event.runId) next.runId = event.runId;
  return next;
}

/** Newest first, as the route lists them. */
function foldSession(
  sessions: SessionSummary[],
  event: LedgerEvent,
): SessionSummary[] {
  const id = event.sessionId;
  if (id === undefined) return sessions;
  const known = sessions.find((session) => session.sessionId === id);
  return [
    sessionAfter(known, id, event),
    ...sessions.filter((session) => session !== known),
  ].slice(0, MAX_LIVE_SESSIONS);
}

/** Oldest claim first, as `activeReservations` (scripts/ledger/query.ts) lists them. */
function foldReservation(
  held: Reservation[],
  event: LedgerEvent,
): Reservation[] {
  if (
    event.kind !== "reservation.acquired" &&
    event.kind !== "reservation.released"
  )
    return held;
  const { beadId } = event;
  if (beadId === undefined) return held;
  const { worktree, globs } = event.payload;
  // Removed first either way, so a claim taken again sorts by its new time.
  const others = held.filter(
    (claim) => claim.beadId !== beadId || claim.worktree !== worktree,
  );
  if (event.kind === "reservation.released")
    return others.length === held.length ? held : others;
  return [
    ...others,
    {
      beadId,
      worktree,
      workspace: event.workspace,
      globs,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      acquiredAt: event.ts,
    },
  ];
}

/**
 * Apply ledger events in id order. One at or below the cursor has been seen
 * (the snapshot may already show it, and a resume may replay it) and is left
 * out. When nothing applies the same object comes back, so nobody is told.
 * Runs and the queue are not folded: they are read again (see `use-stream.ts`).
 */
export function applyDeltas(
  state: LiveState,
  events: readonly LedgerEvent[],
): LiveState {
  if (state.cursor === null) return state;
  let cursor = state.cursor;
  let sessions = state.sessions.data;
  let reservations = state.reservations.data;
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (event.id <= cursor) continue;
    cursor = event.id;
    if (sessions !== null) sessions = foldSession(sessions, event);
    if (reservations !== null)
      reservations = foldReservation(reservations, event);
  }
  if (cursor === state.cursor) return state;
  return {
    ...state,
    cursor,
    sessions:
      sessions === state.sessions.data
        ? state.sessions
        : { data: sessions, error: null },
    reservations:
      reservations === state.reservations.data
        ? state.reservations
        : { data: reservations, error: null },
  };
}

export function withStatus(
  state: LiveState,
  status: LiveStatus,
  reason: LiveOffReason | null = null,
): LiveState {
  const offReason = status === "off" ? reason : null;
  return state.status === status && state.offReason === offReason
    ? state
    : { ...state, status, offReason };
}

/** A collection read again from its own route. */
export function withCollection<K extends LiveCollectionName>(
  state: LiveState,
  name: K,
  envelope: OperatorEnvelope<CollectionData<K>>,
): LiveState {
  return { ...state, [name]: collectionOf(envelope) };
}

/** The live cards of the dashboard. A number is null while its collection is unknown. */
export interface LiveStats {
  runsInFlight: number | null;
  /** Sessions that have not said they ended. Not liveness: a session can stop without saying so. */
  openSessions: number | null;
  /** Beads in a queue state other than `done`. */
  queued: number | null;
  claims: number | null;
}

const count = <T>(
  collection: LiveCollection<T[]>,
  counted: (entry: T) => boolean = () => true,
): number | null =>
  collection.data === null ? null : collection.data.filter(counted).length;

/** Null before the first snapshot and once live updates are off: there is nothing live to show. */
export function liveStats(state: LiveState): LiveStats | null {
  if (state.cursor === null || state.status === "off") return null;
  return {
    // The rule of `activeRuns` (scripts/forge/runs.ts), which reads the file
    // system and cannot be bundled; a test holds the two equal.
    runsInFlight: count(
      state.runs,
      (run) =>
        !run.complete || run.halted !== null || run.reviewPending !== null,
    ),
    openSessions: count(
      state.sessions,
      (session) => session.endedAt === undefined,
    ),
    queued: count(state.queue, (entry: QueueEntry) => entry.state !== "done"),
    claims: count(state.reservations),
  };
}
