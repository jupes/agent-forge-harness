/**
 * Reading one bead's or one run's ledger events for the Timeline, and keeping
 * them current.
 *
 * `/events` pages only forward, so the history is read from the start, a page
 * of 1000 at a time, up to the cap (`timeline-model.ts`). After that the
 * stream says when the ledger moved, and only what lies past the cursor is
 * read. The I/O is handed in, so all of this runs against a fake ledger in the
 * tests.
 */

import {
  type EventsPage,
  LEDGER_EVENT_KINDS,
  type LedgerEvent,
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
  /** The cap was reached: older events are shown, newer ones are not read. */
  cut: boolean;
  /** Why the last read failed; null after one that worked. */
  error: string | null;
}

export interface TimelineReadOptions {
  scope: TimelineScope;
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
  const cap = options.cap ?? EVENT_CAP;
  let live = true;
  let events: LedgerEvent[] = [];
  let cursor = 0;
  let cut = false;
  let loaded = false;
  let loading = false;
  let error: string | null = null;
  /** Sessions with an event in the list. */
  let seen = new Set<string>();
  /** The next read starts from the beginning and replaces the list when its first page arrives. */
  let restart = false;
  /** The stream reopened: whatever read comes next reads from the start. */
  let pendingResync = false;

  const publish = (): void => {
    if (live) options.onChange({ events, loading, cut, error });
  };

  const merge = (incoming: readonly LedgerEvent[]): void => {
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
    const oldest = (await read(sessionPath(session, 0, 1))).events[0];
    if (!live || oldest === undefined || oldest.id > bound) return;
    let from = 0;
    while (live && !cut) {
      const page = await read(sessionPath(session, from, PAGE_LIMIT));
      if (!live) return;
      const older = page.events.filter((entry) => entry.id <= bound);
      merge(older);
      if (!page.more || older.length < page.events.length) return;
      from = page.cursor;
    }
  };

  /**
   * Read forward from `after` until the ledger has no more or the list is
   * full. On the first page of a read from the start, every session shown
   * already brought all its events with it: nothing was read before.
   */
  const readForward = async (after: number): Promise<void> => {
    let from = after;
    for (;;) {
      const page = await read(eventsPath(scope, from));
      if (!live) return;
      error = null;
      if (restart) {
        restart = false;
        events = [];
        seen = new Set();
        cut = false;
      }
      const joined = newSessions(page);
      merge(page.events);
      cursor = page.cursor;
      if (scope.by === "bead" && from > 0)
        for (const session of joined) await backfill(session, from);
      if (!live) return;
      const more = !cut && page.more;
      loading = !loaded && more;
      publish();
      if (!more) return;
      from = page.cursor;
    }
  };

  const fullRead = async (): Promise<void> => {
    restart = true;
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
        } else if (!cut) await readForward(cursor);
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
