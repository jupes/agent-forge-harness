/**
 * Posting an operator action to the hearth, and reading what only the
 * operator may read.
 *
 * Every mutating route of the control plane needs the operator token, and so
 * does a read of a stored council run (it holds what was reviewed, a bead's
 * private text included). The page asks the hearth for the token the first
 * time it needs it, and sends it with each action and each such read. Posts
 * and reads share it.
 *
 * The token route answers only a same-origin request that holds both halves
 * of a dashboard session (`x1gs.3.31`): its HttpOnly cookie, which the browser
 * sends, and its key, which the page keeps in its origin's `localStorage` and
 * sends in `SESSION_KEY_HEADER`. The page gets both once, from the launch link
 * it was opened with (see "The launch" below). The key is read from storage
 * for every token request, never held in memory: a launch in another tab
 * replaces both halves, and every tab follows it. Without a session the route
 * answers 401 and the action fails as `NotSent`, saying how to open the
 * dashboard from its launcher (`NO_SESSION_ERROR`).
 *
 * The hearth mints a new token every time it starts, and the dashboard restarts
 * a stopped hearth without the page knowing. So a 403 is answered by fetching
 * the token again and sending once more: a refused action has done nothing,
 * which is what makes the second attempt safe, and a read changes nothing.
 * The session outlives such a restart. When the token cannot be had, the
 * request fails with `NotSent`: the caller can say it was not made. Nothing is
 * retried past that one second attempt.
 */

import {
  LAUNCH_HEADER,
  LAUNCH_KEY,
  NO_SESSION_ERROR,
  OPERATOR_HEADER,
  SESSION_KEY_HEADER,
  SESSION_KEY_STORAGE,
  SESSION_ROUTE,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";
import {
  type HearthReadOptions,
  readHearth,
  STATIC_COPY_ERROR,
  servedStatically,
} from "./hearth-read";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Bound ordinary answers including their bodies; streams retain their caller's lifetime. */
function boundedFetch(fetchImpl: Fetch, options: HearthReadOptions): Fetch {
  return (url, init = {}) =>
    readHearth(
      url,
      async (response) => {
        if (
          new Headers(init.headers).get("accept") === "text/event-stream" &&
          response.ok &&
          response.headers.get("content-type")?.startsWith("text/event-stream")
        )
          return response;
        const body =
          response.body === null ? null : await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      {
        ...options,
        fetch: (input, bounded) =>
          fetchImpl(input, {
            ...init,
            signal:
              init.signal && bounded?.signal
                ? AbortSignal.any([init.signal, bounded.signal])
                : (bounded?.signal ?? null),
          }),
      },
    );
}

// ── The session key ─────────────────────────────────────────────────────────

/** Where the page keeps its session key. */
export interface SessionKeyStore {
  /** The key, read now; null when there is none or the storage refuses. */
  get(): string | null;
  set(key: string): void;
}

/**
 * The page's origin's `localStorage`. A page of another port of this host is
 * sent the session cookie but cannot read this, so it never has the key. A
 * storage the browser refuses holds no key, and the token route then answers
 * 401: the page reads, and says how to relaunch.
 */
export const pageSessionKeys: SessionKeyStore = {
  get() {
    try {
      return globalThis.localStorage?.getItem(SESSION_KEY_STORAGE) ?? null;
    } catch {
      return null;
    }
  },
  set(key) {
    try {
      globalThis.localStorage?.setItem(SESSION_KEY_STORAGE, key);
    } catch {
      // Refused storage: the session cannot be used from this page.
    }
  },
};

/** What a session key is: 256 bits as lower-case hex. */
const SESSION_KEY_SHAPE = /^[0-9a-f]{64}$/;

// ── The launch ──────────────────────────────────────────────────────────────
//
// The dashboard is opened from a launch link (`bun run dashboard` prints one;
// `bun run dashboard:open` prints another): its fragment carries a one-time
// secret, `#launch=<secret>`, or `#/<route>?…&launch=<secret>` with a route.
// The app's boot calls `startPageLaunch` before anything reads the hash. It
// takes the secret out of the address bar at once with `replaceState`,
// keeping the route and its other parameters, so no view, bookmark or copied
// link holds it, then sends it once, same-origin, to the session route, which
// answers an HttpOnly session cookie. The page's client waits for that
// exchange before it asks for the token.
//
// The secret leaves the address bar before the exchange is answered, not
// after: the hearth spends it whether or not the exchange succeeds, so it is
// worth nothing there either way.

export interface TakenLaunch {
  /** The secret the fragment carried, or null for none (or more than one). */
  secret: string | null;
  /** The fragment without it: `""` for none, otherwise starting with `#`. */
  hash: string;
}

/**
 * The launch secret a URL fragment carries, and the fragment without it.
 *
 * A fragment that is a route (`#/timeline?bead=x&launch=…`) keeps its route
 * and every other parameter, byte for byte; one that is only the secret
 * (`#launch=…`) becomes empty. A fragment with no `launch` parameter comes
 * back as it was, a bare in-page anchor (`#af-main`) included. A fragment
 * with more than one is stripped of all of them and gives no secret.
 */
export function takeLaunchSecret(hash: string): TakenLaunch {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const routed = raw.startsWith("/");
  const at = routed ? raw.indexOf("?") : -1;
  if (routed && at === -1) return { secret: null, hash };
  const route = routed ? raw.slice(0, at) : "";
  const query = routed ? raw.slice(at + 1) : raw;
  const parts = query.split("&");
  const isLaunch = (part: string): boolean =>
    part === LAUNCH_KEY || part.startsWith(`${LAUNCH_KEY}=`);
  const secrets = parts
    .filter(isLaunch)
    .map((part) => part.slice(LAUNCH_KEY.length + 1));
  if (secrets.length === 0) return { secret: null, hash };
  const rest = parts.filter((part) => !isLaunch(part)).join("&");
  const kept = routed ? (rest === "" ? route : `${route}?${rest}`) : rest;
  const [only] = secrets;
  return {
    secret: secrets.length === 1 && only ? only : null,
    hash: kept === "" ? "" : `#${kept}`,
  };
}

/** What a launch came to. */
export type LaunchOutcome =
  /** The page was not opened from a launch link. */
  | { state: "none" }
  /** The hearth gave the page a session. */
  | { state: "exchanged" }
  /** The hearth refused, or did not answer: the page has no new session. */
  | { state: "refused"; error: string };

/** What `beginLaunch` needs of the page. */
export interface LaunchPage {
  location: { hash: string; pathname: string; search: string };
  history: {
    state: unknown;
    replaceState(data: unknown, unused: string, url?: string): void;
  };
}

/** What `startPageLaunch` needs of the page: also its `hashchange` event. */
export interface LaunchWindow extends LaunchPage {
  addEventListener(type: "hashchange", listener: () => void): void;
}

export interface LaunchOptions
  extends Pick<HearthReadOptions, "timeoutMs" | "timers"> {
  fetch?: Fetch;
  /** A static copy: the secret is taken out of the address bar and nothing is sent (no hearth is behind it). */
  staticCopy?: boolean;
  /** Where the session key the exchange answers is kept; `pageSessionKeys` by default. */
  sessionKeys?: SessionKeyStore;
}

async function exchangeLaunch(
  secret: string,
  fetchImpl: Fetch,
  keys: SessionKeyStore,
): Promise<LaunchOutcome> {
  try {
    const response = await fetchImpl(SESSION_ROUTE, {
      method: "POST",
      headers: { [LAUNCH_HEADER]: secret, [SURFACE_HEADER]: "ui" },
      credentials: "same-origin",
    });
    const envelope = (await response.json().catch(() => null)) as {
      ok?: unknown;
      data?: { key?: unknown } | null;
      error?: unknown;
    } | null;
    if (response.ok && envelope?.ok === true) {
      // The key goes to the origin's storage only: never into a URL, a log or memory.
      const key = envelope.data?.key;
      if (typeof key !== "string" || !SESSION_KEY_SHAPE.test(key))
        return {
          state: "refused",
          error: "The control plane answered no session key",
        };
      keys.set(key);
      return { state: "exchanged" };
    }
    return {
      state: "refused",
      error:
        typeof envelope?.error === "string"
          ? envelope.error
          : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      state: "refused",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Take the launch secret out of `page`'s address bar, at once, and exchange
 * it. Settles with what the exchange came to; never rejects.
 */
export function beginLaunch(
  page: LaunchPage,
  options: LaunchOptions = {},
): Promise<LaunchOutcome> {
  const { hash, pathname, search } = page.location;
  const taken = takeLaunchSecret(hash);
  if (taken.hash !== hash)
    page.history.replaceState(
      page.history.state,
      "",
      `${pathname}${search}${taken.hash}`,
    );
  if (taken.secret === null || options.staticCopy)
    return Promise.resolve({ state: "none" });
  return exchangeLaunch(
    taken.secret,
    boundedFetch(
      options.fetch ?? ((input, init) => fetch(input, init)),
      options,
    ),
    options.sessionKeys ?? pageSessionKeys,
  );
}

let launched: Promise<LaunchOutcome> = Promise.resolve({ state: "none" });

/**
 * The page's launch: called once by the app's boot, before anything reads
 * the hash. The page's operator client waits for it before it asks for the
 * token.
 *
 * A launch link opened in a tab already showing the dashboard at the same
 * path does not load the page again: only the fragment changes. So the page
 * also looks for a secret on every `hashchange`. Its listener is added here,
 * before the app renders, so it runs before the router's and the Timeline's
 * listeners, which then read the fragment without the secret.
 */
export function startPageLaunch(
  page: LaunchWindow = window,
  options: LaunchOptions = { staticCopy: servedStatically() },
): Promise<LaunchOutcome> {
  launched = beginLaunch(page, options);
  page.addEventListener("hashchange", () => {
    if (takeLaunchSecret(page.location.hash).hash !== page.location.hash)
      launched = beginLaunch(page, options);
  });
  return launched;
}

/** The page's launch, once it has settled; at once when there was none. */
export function launchSettled(): Promise<LaunchOutcome> {
  return launched;
}

// ── The operator client ─────────────────────────────────────────────────────

export type OperatorPost = (url: string, body: unknown) => Promise<Response>;

/** A GET (or what `init` says) with the operator token added to its headers. */
export type OperatorRead = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface OperatorClient {
  post: OperatorPost;
  read: OperatorRead;
  invalidateToken(): void;
}

/**
 * The post was not made because no operator token could be had. Nothing was
 * changed: either no POST left the page, or the one that did was refused with
 * a 403, which the control plane answers only before doing anything. A
 * request that fails after the token was had is not this: it may have arrived.
 * Its name stays "Error", so a view that prints the error reads as before.
 */
export class NotSent extends Error {}

async function fetchToken(
  fetchImpl: Fetch,
  keys: SessionKeyStore,
): Promise<string> {
  // Read now, for this request: another tab's launch may have replaced it.
  const key = keys.get();
  const response = await (key === null
    ? fetchImpl(TOKEN_ROUTE)
    : fetchImpl(TOKEN_ROUTE, { headers: { [SESSION_KEY_HEADER]: key } }));
  // No session (none yet, or expired): the page says how to get one, in its
  // own words, whatever the answer's body holds. The body is read away first:
  // an answer left unread stays open in the browser.
  if (response.status === 401) {
    await response.text().catch(() => "");
    throw new Error(NO_SESSION_ERROR);
  }
  const envelope = (await response.json()) as {
    ok: boolean;
    data: { token?: unknown } | null;
    error: string | null;
  };
  const token = envelope.data?.token;
  if (!response.ok || !envelope.ok || typeof token !== "string")
    throw new Error(
      envelope.error ?? "The control plane did not provide an operator token",
    );
  return token;
}

export interface OperatorClientOptions
  extends Pick<HearthReadOptions, "timeoutMs" | "timers"> {
  /** A static copy: no token is asked for and nothing is sent; every request fails as `NotSent`. */
  staticCopy?: boolean;
  /**
   * Awaited before each request for the token: the page's launch, whose
   * session the token route needs. Nothing by default.
   */
  ready?: () => Promise<unknown>;
  /** Where the session key is read from, for each token request; `pageSessionKeys` by default. */
  sessionKeys?: SessionKeyStore;
  /** A desktop connection can refuse workspace writes before any request leaves. */
  postProblem?: (url: string) => string | null;
}

/** A poster and a reader with one token cache of their own; `fetchImpl` is replaced in tests. */
export function createOperatorClient(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  options: OperatorClientOptions = {},
): OperatorClient {
  fetchImpl = boundedFetch(fetchImpl, options);
  let token: Promise<string> | null = null;

  const currentToken = (): Promise<string> => {
    if (token === null) {
      const pending = (async () => {
        await options.ready?.();
        return fetchToken(fetchImpl, options.sessionKeys ?? pageSessionKeys);
      })();
      token = pending;
      // A failed fetch is not remembered: the next action asks again.
      pending.catch(() => {
        if (token === pending) token = null;
      });
    }
    return token;
  };

  const heldToken = async (): Promise<string> => {
    if (options.staticCopy) throw new NotSent(STATIC_COPY_ERROR);
    try {
      return await currentToken();
    } catch (error) {
      throw new NotSent(error instanceof Error ? error.message : String(error));
    }
  };

  const send = async (url: string, body: unknown): Promise<Response> => {
    const check = (): void => {
      const problem = options.postProblem?.(url);
      if (problem) throw new NotSent(problem);
    };
    check();
    const held = await heldToken();
    check();
    return fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [OPERATOR_HEADER]: held,
        [SURFACE_HEADER]: "ui",
      },
      body: JSON.stringify(body),
    });
  };

  const get = async (url: string, init: RequestInit): Promise<Response> => {
    const held = await heldToken();
    const headers = new Headers(init.headers);
    headers.set(OPERATOR_HEADER, held);
    return fetchImpl(url, {
      ...init,
      headers: Object.fromEntries(headers.entries()),
    });
  };

  /** Once more after a 403, with a token fetched again. */
  const again =
    <A extends unknown[]>(attempt: (...args: A) => Promise<Response>) =>
    async (...args: A): Promise<Response> => {
      const response = await attempt(...args);
      if (response.status !== 403) return response;
      token = null;
      return attempt(...args);
    };

  return {
    post: again(send),
    read: again((url: string, init: RequestInit = {}) => get(url, init)),
    invalidateToken: () => {
      token = null;
    },
  };
}

/** A poster with its own token cache; `fetchImpl` is replaced in tests. */
export function createOperatorPost(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): OperatorPost {
  return createOperatorClient(fetchImpl).post;
}

/**
 * The page's client: one token cache for every island, posts and reads alike.
 * On a static copy it asks for nothing: no hearth is behind it. It asks for
 * the token only once the page's launch has settled.
 */
let pagePostProblem: ((url: string) => string | null) | null = null;
export function setPagePostProblem(
  check: (url: string) => string | null,
): void {
  pagePostProblem = check;
}

const pageClient = createOperatorClient(undefined, {
  staticCopy: servedStatically(),
  ready: launchSettled,
  postProblem: (url) => pagePostProblem?.(url) ?? null,
});

/** Consume an explicit restart's launch in place, keeping page data and pending writes. */
export function refreshPageSession(
  link: string,
  origin: string = window.location.origin,
): Promise<LaunchOutcome> {
  const url = new URL(link);
  if (
    url.origin !== origin ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    !/^#launch=[0-9a-f]{64}$/.test(url.hash)
  )
    throw new Error(
      "The restarted hearth returned an invalid desktop launch link",
    );
  pageClient.invalidateToken();
  launched = exchangeLaunch(
    url.hash.slice("#launch=".length),
    boundedFetch((input, init) => fetch(input, init), {}),
    pageSessionKeys,
  );
  return launched;
}
export const operatorPost: OperatorPost = pageClient.post;
export const operatorRead: OperatorRead = pageClient.read;
