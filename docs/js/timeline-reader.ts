/**
 * Reading one bead's or one run's ledger events for the Timeline, and keeping
 * them current.
 *
 * `/events` pages only forward, so the history is read from the start, a page
 * of 1000 at a time, to its end. Past the cap (`timeline-model.ts`) the
 * newest are held and the older ones make way. After that the stream says
 * when the ledger moved, and only what lies past the cursor is read. A read
 * may be narrowed to some kinds, which the ledger then answers alone. The I/O
 * is handed in, so all of this runs against a fake ledger in the tests.
 */

import {
  type EventsPage,
  LEDGER_EVENT_KINDS,
  type LedgerEvent,
  type LedgerEventKind,
} from "../../types/hearth";
import {
  EVENT_CAP,
  eventsPath,
  mergeEvents,
  PAGE_LIMIT,
  sessionPath,
  type TimelineScope,
} from "./timeline-model";
import { createRefetcher, type StreamClient, type Timers } from "./use-stream";

export interface TimelineView {
  events: LedgerEvent[];
  /** The first read (or one after a resync) still has pages to fetch. */
  loading: boolean;
  /** More events were read than the cap: the newest are held, older ones are not. */
  cut: boolean;
  /** Why the last read failed; null after one that worked. */
  error: string | null;
  /** Every kind among the events read, held or not, in the order of `LEDGER_EVENT_KINDS`. */
  kindsRead: LedgerEventKind[];
  /** How many sessions joined the bead late and brought older events in; it only grows. */
  lateJoins: number;
}

export interface TimelineReadOptions {
  scope: TimelineScope;
  /** Read only events of these kinds (the ledger narrows them); every kind when absent or empty. */
  kinds?: readonly LedgerEventKind[];
  /** GET an operator API read path and answer its page of events. */
  read(path: string): Promise<EventsPage>;
  client: Pick<StreamClient, "watch">;
  onChange(view: TimelineView): void;
  timers?: Timers;
  now?: () => number;
  /** The most events held; `EVENT_CAP` unless a test asks for fewer. */
  cap?: number;
}

/** Start reading; the returned function stops it. */
export function startTimelineRead(options: TimelineReadOptions): () => void {
  const { scope, read } = options;
  const kinds = options.kinds ?? [];
  const cap = options.cap ?? EVENT_CAP;
  let live = true;
  let events: LedgerEvent[] = [];
  let cursor = 0;
  let cut = false;
  let loaded = false;
  let loading = false;
  let error: string | null = null;
  let kindsRead = new Set<LedgerEventKind>();
  let lateJoins = 0;
  /** Sessions with an event read, held or not. */
  let seen = new Set<string>();
  /**
   * Sessions still to be asked about, each with the cursor the page that
   * first showed it was read after. One stays until its backfill has worked,
   * so a probe that fails is tried again on the next read.
   */
  let unprobed = new Map<string, number>();
  /** The next read starts from the beginning and replaces the list when its first page arrives. */
  let restart = false;
  /** The stream reopened: whatever read comes next reads from the start. */
  let pendingResync = false;

  const publish = (): void => {
    if (live)
      options.onChange({
        events,
        loading,
        cut,
        error,
        kindsRead: LEDGER_EVENT_KINDS.filter((kind) => kindsRead.has(kind)),
        lateJoins,
      });
  };

  const merge = (incoming: readonly LedgerEvent[]): void => {
    for (const entry of incoming) kindsRead.add(entry.kind);
    const merged = mergeEvents(events, incoming, cap);
    events = merged.events;
    if (merged.cut) cut = true;
  };

  /** The sessions on a page that the list has not seen, now marked seen. */
  const newSessions = (page: EventsPage): string[] => {
    const found: string[] = [];
    for (const entry of page.events)
      if (entry.sessionId !== undefined && !seen.has(entry.sessionId)) {
        seen.add(entry.sessionId);
        found.push(entry.sessionId);
      }
    return found;
  };

  /**
   * A bead's events include every event of a session that touched the bead,
   * but a session's events before it first did so start to match only then,
   * and their ids may lie at or below a cursor already read past. A session
   * first seen on a page read after `bound` is asked for its oldest event; when
   * that is at or below `bound`, its events up to `bound` are read and merged.
   */
  const backfill = async (session: string, bound: number): Promise<void> => {
    const oldest = (await read(sessionPath(session, 0, 1, kinds))).events[0];
    if (!live || oldest === undefined || oldest.id > bound) return;
    lateJoins += 1;
    let from = 0;
    while (live) {
      const page = await read(sessionPath(session, from, PAGE_LIMIT, kinds));
      if (!live) return;
      const older = page.events.filter((entry) => entry.id <= bound);
      merge(older);
      if (!page.more || older.length < page.events.length) return;
      from = page.cursor;
    }
  };

  /** Backfill every session still waiting; one that fails stays for the next read. */
  const probeWaiting = async (): Promise<void> => {
    for (const [session, bound] of unprobed) {
      await backfill(session, bound);
      unprobed.delete(session);
    }
  };

  /**
   * Read forward from `after` until the ledger has no more. On the first page
   * of a read from the start, every session shown already brought all its
   * events with it: nothing was read before.
   */
  const readForward = async (after: number): Promise<void> => {
    let from = after;
    for (;;) {
      const page = await read(eventsPath(scope, from, kinds));
      if (!live) return;
      error = null;
      if (restart) {
        restart = false;
        events = [];
        seen = new Set();
        unprobed = new Map();
        cut = false;
        kindsRead = new Set();
      }
      const joined = newSessions(page);
      merge(page.events);
      cursor = page.cursor;
      if (scope.by === "bead" && from > 0)
        for (const session of joined) unprobed.set(session, from);
      await probeWaiting();
      if (!live) return;
      const more = page.more;
      loading = !loaded && more;
      publish();
      if (!more) return;
      from = page.cursor;
    }
  };

  const fullRead = async (): Promise<void> => {
    restart = true;
    loaded = false;
    loading = true;
    await readForward(0);
    loaded = true;
    loading = false;
  };

  const refetcher = createRefetcher({
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.now ? { now: options.now } : {}),
    async run() {
      try {
        // Read when the run starts, so a reopen merged with a later ask
        // while a read was out is never taken for a follow read.
        if (!loaded || pendingResync) {
          pendingResync = false;
          await fullRead();
        } else {
          await probeWaiting();
          await readForward(cursor);
        }
      } catch (cause) {
        // What is shown stays: the hearth being away must not blank the page.
        error = cause instanceof Error ? cause.message : String(cause);
        loading = false;
        restart = false;
        publish();
      }
    },
  });
  refetcher.request();
  const unwatch = options.client.watch(LEDGER_EVENT_KINDS, (reason) => {
    if (reason === "resync") pendingResync = true;
    refetcher.request();
  });
  return () => {
    live = false;
    unwatch();
    refetcher.dispose();
  };
}

/** A read narrowed to the chosen kinds, and the key it is read again under. */
export interface Narrowing {
  kinds: readonly LedgerEventKind[];
  key: string;
}

/**
 * Whether the chosen kinds are read from the ledger rather than filtered from
 * `view`: only once `view` was cut, when its events are not all of the
 * scope's. The key changes with the kinds and with each late join that
 * brought older events: such a join can be made by an event of a kind not
 * chosen, which a read narrowed to the chosen kinds never sees, so that read
 * starts again from the beginning.
 */
export function narrowing(
  view: TimelineView | null,
  kinds: readonly LedgerEventKind[],
): Narrowing | null {
  if (view === null || !view.cut || kinds.length === 0) return null;
  return { kinds, key: `${kinds.join(",")}#${view.lateJoins}` };
}
