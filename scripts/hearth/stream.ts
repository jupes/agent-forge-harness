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
import type { LedgerEvent } from "../../types/hearth";
import type { RouteReply } from "./api";

/** How often an open stream looks for new events. Well inside "a delta within 1 s". */
export const STREAM_POLL_MS = 250;
export const STREAM_KEEPALIVE_MS = 15_000;
/** A page that opens streams in a loop stops here. */
export const STREAM_MAX_CONNECTIONS = 32;
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
  cursor: number;
  closed: boolean;
  timers: Array<ReturnType<typeof setInterval>>;
}

export function createLedgerStream(deps: LedgerStreamDeps): LedgerStream {
  const pollMs = deps.pollMs ?? STREAM_POLL_MS;
  const keepaliveMs = deps.keepaliveMs ?? STREAM_KEEPALIVE_MS;
  const limit = deps.maxConnections ?? STREAM_MAX_CONNECTIONS;
  const open = new Set<Connection>();

  function drop(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    for (const timer of connection.timers) clearInterval(timer);
    open.delete(connection);
    connection.res.end();
  }

  function message(event: string, id: number, data: unknown): string {
    // JSON has no raw line breaks, so the data is always one `data:` line.
    return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function pump(connection: Connection): void {
    for (let batch = 0; batch < BATCHES_PER_TICK; batch++) {
      if (connection.closed) return;
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
        cursor: newest,
        closed: false,
        timers: [],
      };
      open.add(connection);
      // Under Bun, a client that goes away closes the request and the socket;
      // the response emits nothing and its writes keep succeeding. All three
      // are listened to, and `drop` runs once.
      const gone = (): void => drop(connection);
      req.once("close", gone);
      res.once("close", gone);
      req.socket.once("close", gone);

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
