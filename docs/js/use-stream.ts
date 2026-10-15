/**
 * The dashboard's one connection to the hearth's event stream.
 *
 * `GET /__agent-forge/stream` sends a snapshot and then every ledger event
 * after it. This module reads that once per page, whatever is on screen: the
 * connection opens with the first component that wants it, is shared by all
 * of them, and closes with the last. What arrives is merged into the live
 * state by the pure rules in `app-state.ts`.
 *
 * The stream is read with `fetch`, not the browser's own event-source class:
 * the hearth takes the resume id only as a request header, which a page
 * cannot set on a connection that class opens, and the class retries forever
 * at a fixed delay and never says why a connection was refused. Here the
 * client owns the request, so it can resume from the last id it applied, back
 * off, and tell "nothing serves a stream here" (a static host: live updates go
 * off after one request) from "the hearth is briefly away" (retried, bounded).
 *
 * Reads need no operator token; this module never asks for one.
 *
 * The ledger is the only change feed. Where an event does not carry enough to
 * update a view, the view's own read route is fetched again when an event of
 * a kind that matters arrives: at most once per short window, never on a timer.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { API_PREFIX } from "../../scripts/hearth/paths";
import type {
  LedgerEvent,
  LedgerEventKind,
  OperatorEnvelope,
  StreamSnapshot,
} from "../../types/hearth";
import {
  applyDeltas,
  applySnapshot,
  INITIAL_LIVE_STATE,
  type LiveState,
  withCollection,
  withStatus,
} from "./app-state";
import { type DevApiState, fetchDevApi } from "./use-dev-api";

// ── Limits ──────────────────────────────────────────────────────────────────

/** Deltas wait this long so a burst becomes one state update. */
export const BATCH_MS = 50;
/** A batch this large is applied without waiting. */
export const BATCH_MAX = 500;
/** A view's route is read again at most once per this window. */
export const REFETCH_WINDOW_MS = 300;
/**
 * The first retry waits up to this; each later one doubles it. With
 * `MAX_FAILURES` at six there are five retries, so the longest wait is up to
 * 8 s: the sixth failure turns live updates off instead of waiting again.
 */
export const RETRY_BASE_MS = 500;
/** This many failures in a row turn live updates off for the page. */
export const MAX_FAILURES = 6;
/**
 * Three missed keepalives: the hearth sends one every 15 s. An open stream
 * that sends nothing for this long is given up.
 */
export const SILENCE_MS = 45_000;
/**
 * A request with no answer (no response headers) for this long is given up:
 * a hearth that hangs never answers. The hearth writes a byte as soon as a
 * stream opens (`: open`), so its answer reaches the page at once, also
 * behind the dashboard's proxy, which passes the headers on only with the
 * first byte. What can still hold it: the hearth's read of the ledger's
 * cursor (the ledger waits up to 2 s on a busy file), and the dashboard
 * starting a hearth again before it proxies. A start slower than this costs
 * one failure and a retry, which joins the same start.
 */
export const ANSWER_MS = 10_000;
/**
 * A stream that has been open this long and is then heard from works; only
 * then do earlier failures stop counting. A live hearth sends a byte at least
 * every 15 s, so a stream that stays silent never resets the count.
 */
export const STABLE_MS = 5_000;
/**
 * The most text held while waiting for a message to end. Far above any real
 * snapshot; it only stops a stream that never ends a message.
 */
export const SSE_MAX_BUFFER = 4_000_000;

// ── Reading server-sent events ──────────────────────────────────────────────

export interface SseMessage {
  event: string;
  id: string | null;
  data: string;
}

export interface SseParser {
  /** Feed decoded text. False when the unfinished message has outgrown the limit. */
  push(text: string): boolean;
}

/**
 * Split a stream into messages. The hearth ends lines with LF only and sends
 * a comment line (`: keepalive`) between events; a block with no data is not
 * a message.
 */
export function createSseParser(
  onMessage: (message: SseMessage) => void,
  maxBuffer: number = SSE_MAX_BUFFER,
): SseParser {
  let buffer = "";
  return {
    push(text) {
      buffer += text;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end === -1) break;
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        let id: string | null = null;
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line === "" || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const raw = colon === -1 ? "" : line.slice(colon + 1);
          const value = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (field === "event") event = value;
          else if (field === "id") id = value;
          else if (field === "data") data.push(value);
        }
        if (data.length > 0) onMessage({ event, id, data: data.join("\n") });
      }
      return buffer.length <= maxBuffer;
    },
  };
}

// ── The connection ──────────────────────────────────────────────────────────

/**
 * How a connection stopped. `refused`: what answered is not an event stream
 * and is not a server failure, so nothing serves one here. `failed`: no
 * answer, or a server failure. `ended`: an open stream closed.
 */
export type StreamEnd = "refused" | "failed" | "ended";

export interface StreamHandlers {
  /** The answer is an event stream. */
  onOpen(): void;
  /** Bytes arrived: a message, part of one, or a keepalive. */
  onActivity(): void;
  onMessage(message: SseMessage): void;
  /** Called once, and never after `close()`. */
  onEnd(outcome: StreamEnd): void;
}

/** Open one connection, resuming after `lastEventId` when there is one. Replaced by a stand-in in tests. */
export type StreamTransport = (
  lastEventId: number | null,
  handlers: StreamHandlers,
) => { close(): void };

export interface FetchTransportOptions {
  /** How the request is made: the page's `fetch`, or one that adds what a route needs (the operator token). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Extra request headers. A page needs none: its own origin is what the hearth checks. */
  headers?: Record<string, string>;
}

export function fetchTransport(
  url: string,
  options: FetchTransportOptions = {},
): StreamTransport {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  return (lastEventId, handlers) => {
    const controller = new AbortController();
    let closed = false;
    const end = (outcome: StreamEnd): void => {
      if (closed) return;
      closed = true;
      controller.abort();
      handlers.onEnd(outcome);
    };

    void (async () => {
      let response: Response;
      try {
        response = await request(url, {
          headers: {
            Accept: "text/event-stream",
            ...options.headers,
            ...(lastEventId !== null
              ? { "Last-Event-ID": String(lastEventId) }
              : {}),
          },
          cache: "no-store",
          signal: controller.signal,
        });
      } catch {
        end("failed");
        return;
      }
      const type = response.headers.get("content-type") ?? "";
      const body = response.body;
      if (!response.ok || !type.startsWith("text/event-stream") || !body) {
        end(response.status >= 500 ? "failed" : "refused");
        return;
      }
      if (closed) return;
      handlers.onOpen();

      const parser = createSseParser((message) => {
        if (!closed) handlers.onMessage(message);
      });
      const reader = body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (closed) return;
          handlers.onActivity();
          if (!parser.push(decoder.decode(value, { stream: true }))) {
            end("failed");
            return;
          }
        }
      } catch {
        end("failed");
        return;
      }
      end("ended");
    })();

    return {
      close() {
        closed = true;
        controller.abort();
      },
    };
  };
}

// ── Reading a route again ───────────────────────────────────────────────────

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  // justification: the handle is whatever `set` above returned.
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Refetcher {
  /** Ask for a read. Many asks in a burst become one read now and at most one after it. */
  request(): void;
  dispose(): void;
}

export interface RefetcherOptions {
  /** The read. Its failure is its own business: a rejection is swallowed here. */
  run(): Promise<void>;
  windowMs?: number;
  timers?: Timers;
  now?: () => number;
}

/**
 * Leading edge: the first ask reads at once. Then at most one read starts per
 * window, one is in flight at a time, and asks that arrive meanwhile are
 * answered by exactly one read afterwards. Nothing repeats on its own.
 */
export function createRefetcher(options: RefetcherOptions): Refetcher {
  const windowMs = options.windowMs ?? REFETCH_WINDOW_MS;
  const timers = options.timers ?? REAL_TIMERS;
  const now = options.now ?? (() => Date.now());
  let inFlight = false;
  let again = false;
  let disposed = false;
  let startedAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;

  const start = (): void => {
    timer = null;
    if (disposed) return;
    inFlight = true;
    startedAt = now();
    void options
      .run()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          request();
        }
      });
  };

  const request = (): void => {
    if (disposed || timer !== null) return;
    if (inFlight) {
      again = true;
      return;
    }
    const wait = startedAt + windowMs - now();
    if (wait > 0) timer = timers.set(start, wait);
    else start();
  };

  return {
    request,
    dispose() {
      disposed = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
  };
}

// ── The client ──────────────────────────────────────────────────────────────

/** Why a watcher is told: events of its kinds were applied, or the stream reopened and something may have been missed. */
export type WatchReason = "events" | "resync";

export interface StreamClient {
  getState(): LiveState;
  /** Be told after every change of state. Holds the connection open until the returned function is called. */
  subscribe(listener: () => void): () => void;
  /**
   * Be told, once per applied batch, when it held an event of one of `kinds`,
   * and once whenever the stream reopens. Holds the connection like `subscribe`.
   */
  watch(
    kinds: readonly LedgerEventKind[],
    callback: (reason: WatchReason) => void,
  ): () => void;
}

export interface StreamClientDeps {
  transport: StreamTransport;
  /** GET one read route of the operator API and answer its envelope. Rejects when nothing usable answered. */
  read(path: string): Promise<OperatorEnvelope<unknown>>;
  timers?: Timers;
  /** A number in [0, 1). */
  random?: () => number;
  now?: () => number;
}

/** A run summary is computed from the run's stored state, which these two kinds follow. */
export const RUN_KINDS: readonly LedgerEventKind[] = [
  "run.phase.completed",
  "review.recorded",
];
/** A queue entry is a bead's label; a tracker write or a queue move may have changed one. */
export const QUEUE_KINDS: readonly LedgerEventKind[] = ["bead.transitioned"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const COLLECTIONS = [
  "sessions",
  "runs",
  "queue",
  "reservations",
  "smiths",
  "config",
] as const;

function isSnapshot(value: unknown): value is StreamSnapshot {
  return (
    isRecord(value) &&
    typeof value["cursor"] === "number" &&
    COLLECTIONS.every((name) => {
      const envelope = value[name];
      return isRecord(envelope) && typeof envelope["ok"] === "boolean";
    })
  );
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  return (
    isRecord(value) &&
    typeof value["id"] === "number" &&
    typeof value["kind"] === "string" &&
    typeof value["ts"] === "string" &&
    typeof value["workspace"] === "string" &&
    isRecord(value["payload"])
  );
}

export function createStreamClient(deps: StreamClientDeps): StreamClient {
  const timers = deps.timers ?? REAL_TIMERS;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => Date.now());

  let state = INITIAL_LIVE_STATE;
  const listeners = new Set<() => void>();
  const watchers = new Set<{
    kinds: ReadonlySet<LedgerEventKind>;
    callback: (reason: WatchReason) => void;
  }>();
  let holders = 0;

  let connection: { close(): void } | null = null;
  /** Raised for every connection and on release, so a late call from an old one is ignored. */
  let generation = 0;
  /** Whether a connection of this page has ended: the next one to open may follow a gap. */
  let afterAGap = false;
  let failures = 0;
  /** The next request asks for a snapshot even when the page has a cursor. */
  let askAfresh = false;
  let waiting: LedgerEvent[] = [];
  let batchTimer: unknown = null;
  let retryTimer: unknown = null;
  let silenceTimer: unknown = null;

  const setState = (next: LiveState): void => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /** `kinds` null: the stream reopened, tell everyone. */
  const tell = (kinds: ReadonlySet<LedgerEventKind> | null): void => {
    for (const watcher of [...watchers]) {
      if (kinds === null) watcher.callback("resync");
      else if ([...kinds].some((kind) => watcher.kinds.has(kind)))
        watcher.callback("events");
    }
  };

  const stop = (handle: unknown): null => {
    if (handle !== null) timers.clear(handle);
    return null;
  };

  /** Apply what is waiting: one state update, one notification, nothing kept. */
  const flush = (): void => {
    batchTimer = stop(batchTimer);
    if (waiting.length === 0) return;
    const batch = waiting;
    waiting = [];
    const before = state.cursor;
    const next = applyDeltas(state, batch);
    if (next === state || before === null) return;
    const kinds = new Set<LedgerEventKind>();
    for (const event of batch) if (event.id > before) kinds.add(event.kind);
    setState(next);
    tell(kinds);
  };

  const receive = (message: SseMessage): void => {
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      // Not ours to read; the stream carries on.
      return;
    }
    if (message.event === "snapshot" && isSnapshot(data)) {
      // A snapshot replaces everything, so nothing older is worth applying.
      waiting = [];
      batchTimer = stop(batchTimer);
      setState(applySnapshot(state, data));
    } else if (message.event === "delta" && isLedgerEvent(data)) {
      waiting.push(data);
      if (waiting.length >= BATCH_MAX) flush();
      else if (batchTimer === null) batchTimer = timers.set(flush, BATCH_MS);
    }
  };

  const drop = (): void => {
    generation += 1;
    afterAGap = true;
    connection?.close();
    connection = null;
    silenceTimer = stop(silenceTimer);
    // What was received is applied now, so the next request resumes after it.
    flush();
  };

  /** Give the connection up after `ms` with nothing from it. */
  const watchSilence = (ms: number = SILENCE_MS): void => {
    silenceTimer = stop(silenceTimer);
    silenceTimer = timers.set(lost, ms);
  };

  /** A connection failed, ended, or went silent. */
  function lost(): void {
    drop();
    failures += 1;
    if (failures >= MAX_FAILURES) {
      setState(withStatus(state, "off", "lost"));
      return;
    }
    setState(withStatus(state, "reconnecting"));
    const ceiling = RETRY_BASE_MS * 2 ** (failures - 1);
    retryTimer = timers.set(
      () => {
        retryTimer = null;
        connect();
      },
      (0.5 + random() / 2) * ceiling,
    );
  }

  function connect(): void {
    if (connection !== null || holders === 0 || state.status === "off") return;
    generation += 1;
    const mine = generation;
    const current = (): boolean => mine === generation;
    let openedAt: number | null = null;
    let works = false;
    /**
     * Bytes arrived. Staying open and still being heard from is what shows a
     * stream that works. Neither the bare open nor a first message is: a
     * stream that opens, sends its snapshot and ends, or then says nothing,
     * over and over, must still run out.
     */
    const heard = (): void => {
      watchSilence();
      if (works || openedAt === null || now() - openedAt < STABLE_MS) return;
      works = true;
      failures = 0;
    };
    const resumeFrom = askAfresh ? null : state.cursor;
    askAfresh = false;
    // Timed from the request: a hearth that hangs never answers it. A resume
    // that gets no answer is asked for next without its id: a hearth started
    // before it wrote `: open` answers an idle resume, behind the proxy, only
    // with its first keepalive (15 s), and a first open with its snapshot.
    silenceTimer = stop(silenceTimer);
    silenceTimer = timers.set(() => {
      if (resumeFrom !== null) askAfresh = true;
      lost();
    }, ANSWER_MS);
    const handle = deps.transport(resumeFrom, {
      onOpen() {
        if (!current()) return;
        openedAt = now();
        watchSilence();
        // A resume shows what the page already has; a first open waits for its snapshot.
        if (state.cursor !== null) setState(withStatus(state, "live"));
        // Anything but the first connection of the page follows a gap, in which a
        // view may have failed to read: every watcher reads again.
        const gap = afterAGap;
        afterAGap = false;
        if (gap) tell(null);
      },
      onActivity() {
        if (!current()) return;
        heard();
      },
      onMessage(message) {
        if (!current()) return;
        heard();
        receive(message);
      },
      onEnd(outcome) {
        if (!current()) return;
        if (outcome === "refused") {
          drop();
          setState(withStatus(state, "off", "no-hearth"));
        } else lost();
      },
    });
    // A transport may end before it returns; that connection is already over.
    if (current()) connection = handle;
    else handle.close();
  }

  const hold = (): void => {
    holders += 1;
    if (holders === 1) connect();
  };

  const release = (): void => {
    holders -= 1;
    if (holders > 0) return;
    drop();
    retryTimer = stop(retryTimer);
    if (state.status !== "off")
      setState(
        withStatus(
          state,
          state.cursor === null ? "connecting" : "reconnecting",
        ),
      );
  };

  const watch: StreamClient["watch"] = (kinds, callback) => {
    const watcher = { kinds: new Set(kinds), callback };
    watchers.add(watcher);
    hold();
    return () => {
      if (watchers.delete(watcher)) release();
    };
  };

  // Runs and the queue are not carried by events: their routes are read again.
  const reread = (name: "runs" | "queue"): Refetcher =>
    createRefetcher({
      timers,
      now,
      async run() {
        const envelope = await deps.read(`/${name}`);
        if (holders === 0 || state.cursor === null || state.status === "off")
          return;
        // A read that did not answer (it rejected) keeps what was shown. One
        // that answered "this cannot be read" is taken at its word: the
        // collection is unknown until a later read says otherwise.
        // justification: the route named `name` answers the envelope of the collection named `name`.
        setState(withCollection(state, name, envelope as never));
      },
    });
  const runs = reread("runs");
  const queue = reread("queue");
  watchers.add({ kinds: new Set(RUN_KINDS), callback: () => runs.request() });
  watchers.add({
    kinds: new Set(QUEUE_KINDS),
    callback: () => queue.request(),
  });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      hold();
      return () => {
        if (listeners.delete(listener)) release();
      };
    },
    watch,
  };
}

// ── A view that reads its own route ─────────────────────────────────────────

export interface LiveReadOptions<T> {
  /** Read the view's data. */
  load(): Promise<T>;
  client: StreamClient;
  kinds: readonly LedgerEventKind[];
  onChange(update: (previous: DevApiState<T>) => DevApiState<T>): void;
  timers?: Timers;
  now?: () => number;
}

/** Stops a live read; `reload` asks for a read now, after the one in flight if there is one. */
export type LiveRead = (() => void) & { reload(): void };

/**
 * Read once, then again whenever an event of `kinds` is applied or the stream
 * reopens. A later read that fails keeps what is shown: the hearth being away
 * for a moment must not blank a page that has its data. Returns the stop,
 * which also carries `reload` for a view that knows it changed something.
 */
export function startLiveRead<T>(options: LiveReadOptions<T>): LiveRead {
  let live = true;
  const refetcher = createRefetcher({
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.now ? { now: options.now } : {}),
    async run() {
      try {
        const data = await options.load();
        if (live)
          options.onChange(() => ({ data, error: null, loading: false }));
      } catch (cause) {
        if (!live) return;
        const error = cause instanceof Error ? cause.message : String(cause);
        options.onChange((previous) =>
          previous.data !== null
            ? previous
            : { data: null, error, loading: false },
        );
      }
    },
  });
  refetcher.request();
  const unwatch = options.client.watch(options.kinds, () =>
    refetcher.request(),
  );
  return Object.assign(
    () => {
      live = false;
      unwatch();
      refetcher.dispose();
    },
    { reload: () => refetcher.request() },
  );
}

// ── The page's client and its hooks ─────────────────────────────────────────

async function readRoute(
  path: string,
  fetchImpl: (input: string) => Promise<Response> = (input) => fetch(input),
): Promise<OperatorEnvelope<unknown>> {
  const response = await fetchImpl(`${API_PREFIX}${path}`);
  const envelope: unknown = await response.json();
  if (!isRecord(envelope) || typeof envelope["ok"] !== "boolean")
    throw new Error(`HTTP ${response.status}`);
  // justification: checked above to be an envelope; its data is read by the route's own type.
  return envelope as OperatorEnvelope<unknown>;
}

/**
 * An operator API read route's data, or an error with the hearth's own words
 * when it answered `ok: false`.
 */
export async function readOperatorRoute<T>(
  path: string,
  fetchImpl?: (input: string) => Promise<Response>,
): Promise<T> {
  const envelope = await readRoute(path, fetchImpl);
  if (!envelope.ok)
    throw new Error(envelope.error ?? "the control plane refused the read");
  // justification: the route named `path` answers data of the caller's `T`.
  return envelope.data as T;
}

/**
 * A connection where nothing serves a stream: it ends at once as refused and
 * sends no request, so live updates go off as a static host's answer turns
 * them off, without a failed request in the console.
 */
const NO_STREAM: StreamTransport = (_lastEventId, handlers) => {
  handlers.onEnd("refused");
  return { close: () => undefined };
};

/**
 * The page's connection to the stream. A static copy (a `vite build` of the
 * dashboard) asks for none: only the dev server has a hearth behind
 * `/__agent-forge`, and every page of a copy would otherwise make one request
 * that fails.
 */
export function pageTransport(
  staticCopy: boolean,
  options: FetchTransportOptions = {},
): StreamTransport {
  return staticCopy
    ? NO_STREAM
    : fetchTransport(`${API_PREFIX}/stream`, options);
}

let page: StreamClient | null = null;

/** The one client of this page, made on first use. */
export function appStream(): StreamClient {
  page ??= createStreamClient({
    // A build has no HMR socket: there `import.meta.hot` is undefined. The
    // dev server, which proxies the hearth, always gives a page one.
    transport: pageTransport(import.meta.hot === undefined),
    read: readRoute,
  });
  return page;
}

/**
 * A slice of the live state. The component re-renders only when the slice
 * changes (`equal`, by default identity): the state itself changes with every
 * batch of events.
 */
export function useStream<T>(
  select: (state: LiveState) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const client = appStream();
  const [selected, setSelected] = useState<T>(() => select(client.getState()));
  const latest = useRef({ select, equal });
  latest.current = { select, equal };

  useEffect(() => {
    const update = (): void =>
      setSelected((previous) => {
        const next = latest.current.select(client.getState());
        return latest.current.equal(previous, next) ? previous : next;
      });
    const unsubscribe = client.subscribe(update);
    // The state may have moved between the first render and this effect.
    update();
    return unsubscribe;
  }, [client]);

  return selected;
}

/**
 * `useDevApi` for a view that should follow the ledger: the dev-only route is
 * read on mount and again when an event of `kinds` arrives. Pass `kinds` as a
 * module constant, not a new array per render.
 */
export function useLiveRead<T>(
  route: string,
  kinds: readonly LedgerEventKind[],
): DevApiState<T> {
  const [state, setState] = useState<DevApiState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(
    () =>
      startLiveRead<T>({
        load: () => fetchDevApi<T>(route),
        client: appStream(),
        kinds,
        onChange: setState,
      }),
    [route, kinds],
  );

  return state;
}

/**
 * `useLiveRead` for an operator API read route (`/__agent-forge<path>`): read
 * on mount and again when an event of `kinds` is applied or the stream
 * reopens; `reload` reads again, for a view that just changed something. Pass
 * `kinds` as a module constant.
 */
export function useOperatorRead<T>(
  path: string,
  kinds: readonly LedgerEventKind[],
): DevApiState<T> & { reload(): void } {
  const [state, setState] = useState<DevApiState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  const live = useRef<LiveRead | null>(null);

  useEffect(() => {
    const read = startLiveRead<T>({
      load: () => readOperatorRoute<T>(path),
      client: appStream(),
      kinds,
      onChange: setState,
    });
    live.current = read;
    return () => {
      read();
      if (live.current === read) live.current = null;
    };
  }, [path, kinds]);

  return { ...state, reload: () => live.current?.reload() };
}
