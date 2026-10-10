/**
 * The hearth's event stream: `GET /__agent-forge/stream`, server-sent events.
 *
 * A new connection gets one `snapshot` — where the ledger stood and what each
 * collection held — and then a `delta` for every ledger event after it, in id
 * order. A reconnect that sends `Last-Event-ID` gets only the deltas after
 * that id.
 *
 * The ledger is written by other processes (hooks, gates, CLIs), so nothing
 * can tell this one that a row arrived: each connection polls for ids above
 * its cursor. The ledger is the only change feed; nothing here watches Beads
 * or the config files.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { LedgerEvent } from "../../types/hearth";
import type { RouteReply } from "./api";

/** How often an open stream looks for new events. Well inside "a delta within 1 s". */
export const STREAM_POLL_MS = 250;
export const STREAM_KEEPALIVE_MS = 15_000;
/** A page that opens streams in a loop stops here. */
export const STREAM_MAX_CONNECTIONS = 32;
/** A connection with more than this waiting to be sent is given nothing new until it drains. */
export const STREAM_MAX_BUFFERED_BYTES = 1_000_000;
/** A connection that stays that full for this long is closed. */
export const STREAM_STALLED_MS = 30_000;
/** Events sent per ledger read, and reads per tick, when a connection is far behind. */
const BATCH = 500;
const BATCHES_PER_TICK = 4;

export interface LedgerStreamDeps {
  /** The ledger's newest id for this workspace. Throws when the ledger cannot be read. */
  cursor(): number;
  /** What the snapshot carries besides the cursor. Never rejects: a collection reports its own failure. */
  collections(): Promise<Record<string, unknown>>;
  /** Events after a cursor, oldest first, at most `limit`. May throw when the ledger is busy. */
  eventsAfter(cursor: number, limit: number): LedgerEvent[];
  pollMs?: number | undefined;
  keepaliveMs?: number | undefined;
  maxConnections?: number | undefined;
  maxBufferedBytes?: number | undefined;
  stalledMs?: number | undefined;
}

export interface LedgerStream {
  /**
   * Start streaming on `res`, resuming after `lastEventId` when there is one.
   * Answers a refusal instead when the stream cannot be opened; nothing has
   * been written to `res` in that case.
   */
  open(
    req: IncomingMessage,
    res: ServerResponse,
    lastEventId: number | null,
  ): Promise<RouteReply | undefined>;
  /** How many streams are open. */
  connections(): number;
  /** End every open stream. */
  close(): void;
}

interface Connection {
  res: ServerResponse;
  socket: Socket;
  cursor: number;
  closed: boolean;
  timers: Array<ReturnType<typeof setInterval>>;
  /** When its buffer was first found over the limit, while it still is. */
  fullSince: number | null;
  /** True while events are being written to it: a write can emit `drain` before it returns. */
  pumping: boolean;
}

export function createLedgerStream(deps: LedgerStreamDeps): LedgerStream {
  const pollMs = deps.pollMs ?? STREAM_POLL_MS;
  const keepaliveMs = deps.keepaliveMs ?? STREAM_KEEPALIVE_MS;
  const limit = deps.maxConnections ?? STREAM_MAX_CONNECTIONS;
  const maxBuffered = deps.maxBufferedBytes ?? STREAM_MAX_BUFFERED_BYTES;
  const stalledMs = deps.stalledMs ?? STREAM_STALLED_MS;
  const open = new Set<Connection>();

  /**
   * Stop serving a connection. `abandon` is for a client that is not reading:
   * ending the response would only queue a terminator behind data it will not
   * take, and the socket and that data would stay until the client left. Its
   * socket is destroyed instead; it resumes by `Last-Event-ID`.
   */
  function drop(connection: Connection, abandon = false): void {
    if (connection.closed) return;
    connection.closed = true;
    for (const timer of connection.timers) clearInterval(timer);
    open.delete(connection);
    if (abandon) connection.socket.destroy();
    else connection.res.end();
  }

  function message(event: string, id: number, data: unknown): string {
    // JSON has no raw line breaks, so the data is always one `data:` line.
    return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /**
   * Whether the client is behind on reading. A connection that is gets nothing
   * new: its cursor stays where it is, so what it has not been sent is still
   * in the ledger and follows when it catches up. One that stays behind for
   * the stall limit has its socket destroyed, which frees its slot and what
   * was waiting for it.
   *
   * `writableLength` is the measure: under Bun `write` returns true however
   * much is waiting.
   */
  function congested(connection: Connection): boolean {
    if (connection.res.writableLength <= maxBuffered) {
      connection.fullSince = null;
      return false;
    }
    const now = Date.now();
    connection.fullSince ??= now;
    if (now - connection.fullSince >= stalledMs) drop(connection, true);
    return true;
  }

  function pump(connection: Connection): void {
    // Not re-entered: `drain` can fire inside a write below, before the cursor
    // has moved past the event being written, and a second pass would send it again.
    if (connection.pumping) return;
    connection.pumping = true;
    try {
      for (let batch = 0; batch < BATCHES_PER_TICK; batch++) {
        if (connection.closed || congested(connection)) return;
        let events: LedgerEvent[];
        try {
          events = deps.eventsAfter(connection.cursor, BATCH);
        } catch {
          // A busy ledger: the cursor has not moved, so the next tick asks again.
          return;
        }
        for (const event of events) {
          connection.res.write(message("delta", event.id, event));
          connection.cursor = event.id;
        }
        if (events.length < BATCH) return;
      }
    } finally {
      connection.pumping = false;
    }
  }

  return {
    connections: () => open.size,
    close() {
      for (const connection of [...open]) drop(connection);
    },
    async open(req, res, lastEventId) {
      if (open.size >= limit)
        return { status: 503, error: "Too many event streams are open" };
      let newest: number;
      try {
        newest = deps.cursor();
      } catch {
        return { status: 503, error: "The ledger could not be read" };
      }

      // The slot is taken before anything is awaited, so connections arriving
      // together cannot pass the limit between them.
      const connection: Connection = {
        res,
        socket: req.socket,
        cursor: newest,
        closed: false,
        timers: [],
        fullSince: null,
        pumping: false,
      };
      open.add(connection);
      // Under Bun, a client that goes away closes the request and the socket;
      // the response emits nothing and its writes keep succeeding. All three
      // are listened to, and `drop` runs once.
      const gone = (): void => drop(connection);
      req.once("close", gone);
      res.once("close", gone);
      req.socket.once("close", gone);
      // A client that was behind has caught up: carry on at once rather than
      // at the next poll, or a long replay crawls at one buffer per tick.
      res.on("drain", () => pump(connection));

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Sent now, so the client sees the stream open while the snapshot is
      // still being read; without this the headers wait for the first write.
      res.flushHeaders();

      if (lastEventId !== null && lastEventId <= newest) {
        // A resume: the client has everything up to its id.
        connection.cursor = lastEventId;
      } else {
        // The cursor was read first: an event appended while the collections
        // are being read is newer than it, and follows as a delta. A delta may
        // then repeat something the snapshot already shows, never miss it.
        const collections = await deps.collections();
        if (connection.closed) return undefined;
        res.write(
          message("snapshot", newest, { cursor: newest, ...collections }),
        );
      }

      pump(connection);
      if (connection.closed) return undefined;
      connection.timers.push(
        setInterval(() => pump(connection), pollMs),
        setInterval(() => {
          if (!connection.closed) res.write(": keepalive\n\n");
        }, keepaliveMs),
      );
      return undefined;
    },
  };
}
