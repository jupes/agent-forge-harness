/**
 * Tell the dashboard dev server when the hearth has written to the tracker.
 *
 * Every write the hearth makes to the tracker (a bead created, claimed,
 * commented on or closed; a queue move) appends `bead.transitioned` to the
 * ledger once `bd` has confirmed it. This asks the hearth's `/events` route for
 * those events, one poll at a time, and calls `onWrite` once for each poll that
 * found any newer than the last it saw. The first poll only finds where the
 * newest one is: what was written before following began is not reported.
 *
 * Not seen: a write made with `bd` outside the hearth, which appends nothing,
 * and a hearth write whose `bead.transitioned` the ledger did not store.
 *
 * Asked over `loopbackExchange`, not `fetch` or `node:http`, which under Bun
 * send a loopback request to `HTTP_PROXY`. Loaded by Vite under Node: imports
 * nothing from Bun or from `scripts/ledger/`.
 */

import { type Exchange, loopbackExchange } from "./loopback";
import { API_PREFIX } from "./paths";

/** How long the follower waits between polls. */
export const TRACKER_WRITE_POLL_MS = 1000;
/** Events asked for per request once there is a cursor; `/events` takes up to 1000. */
const PAGE = 200;
/** Requests one poll may make when the events keep coming. */
const PAGES_PER_POLL = 10;
const REQUEST_TIMEOUT_MS = 5000;
const ANSWER_MAX_BYTES = 2_000_000;
const KIND = "bead.transitioned";

export interface FollowTrackerWritesOptions {
  /** The hearth's port. A rejection fails that poll; the next one asks again. */
  port(): Promise<number>;
  /** Called once per poll that found a tracker write. */
  onWrite(): void;
  /** Default `TRACKER_WRITE_POLL_MS`. */
  pollMs?: number;
  /** `loopbackExchange` when not given. */
  exchange?: Exchange;
}

export interface TrackerWriteFollower {
  /** Stop polling. A request in flight is cancelled and `onWrite` is not called again. */
  stop(): void;
}

interface EventsPage {
  /** How many `bead.transitioned` events the page held. */
  found: number;
  cursor: number;
  more: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The page an `/events` answer holds, or null when it is not one. */
function readPage(status: number, body: string): EventsPage | null {
  if (status !== 200) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["ok"] !== true) return null;
  const data = parsed["data"];
  if (!isRecord(data)) return null;
  const { events, cursor, more } = data;
  if (
    !Array.isArray(events) ||
    typeof cursor !== "number" ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    typeof more !== "boolean"
  )
    return null;
  return {
    found: events.filter((event) => isRecord(event) && event["kind"] === KIND)
      .length,
    cursor,
    more,
  };
}

export function followTrackerWrites(
  options: FollowTrackerWritesOptions,
): TrackerWriteFollower {
  const pollMs = options.pollMs ?? TRACKER_WRITE_POLL_MS;
  const exchange = options.exchange ?? loopbackExchange;
  const cancel = new AbortController();
  /** The newest `bead.transitioned` id seen; null until the first poll has found it. */
  let cursor: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function ask(port: number, after: number | null): Promise<EventsPage> {
    const query = new URLSearchParams({
      kind: KIND,
      limit: after === null ? "1" : String(PAGE),
    });
    if (after !== null) query.set("after", String(after));
    const answer = await exchange({
      port,
      method: "GET",
      target: `${API_PREFIX}/events?${query}`,
      // A read is answered only to a request that declares the hearth's own origin.
      headers: { Origin: `http://127.0.0.1:${port}` },
      signal: cancel.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: ANSWER_MAX_BYTES,
    });
    const page = readPage(answer.status, answer.body);
    if (page === null)
      throw new Error(`/events answered ${answer.status} without a page`);
    return page;
  }

  async function poll(): Promise<void> {
    const port = await options.port();
    if (cursor === null) {
      // `limit=1` with no `after` is the newest one: where following begins.
      cursor = (await ask(port, null)).cursor;
      return;
    }
    let found = 0;
    for (let request = 0; request < PAGES_PER_POLL; request++) {
      const page = await ask(port, cursor);
      found += page.found;
      cursor = page.cursor;
      if (!page.more) break;
    }
    if (found > 0 && !cancel.signal.aborted) options.onWrite();
  }

  function next(): void {
    if (cancel.signal.aborted) return;
    timer = setTimeout(() => {
      // A failed poll leaves the cursor where it was: the next one asks again
      // from there, so a write made meanwhile is still found.
      poll().then(next, next);
    }, pollMs);
    // Polling alone does not keep the process running.
    timer.unref?.();
  }

  poll().then(next, next);

  return {
    stop() {
      cancel.abort();
      clearTimeout(timer);
    },
  };
}
