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
 * The token route answers only a same-origin request that holds the
 * dashboard's session cookie (`x1gs.3.31`), which the page gets once, from the
 * launch link it was opened with (see "The launch" below). Without one the
 * route answers 401 and the action fails as `NotSent`, saying how to open the
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
  SESSION_ROUTE,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";
import { STATIC_COPY_ERROR, servedStatically } from "./hearth-read";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

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

export interface LaunchOptions {
  fetch?: Fetch;
  /** A static copy: the secret is taken out of the address bar and nothing is sent (no hearth is behind it). */
  staticCopy?: boolean;
}

async function exchangeLaunch(
  secret: string,
  fetchImpl: Fetch,
): Promise<LaunchOutcome> {
  try {
    const response = await fetchImpl(SESSION_ROUTE, {
      method: "POST",
      headers: { [LAUNCH_HEADER]: secret, [SURFACE_HEADER]: "ui" },
      credentials: "same-origin",
    });
    const envelope = (await response.json().catch(() => null)) as {
      ok?: unknown;
      error?: unknown;
    } | null;
    if (response.ok && envelope?.ok === true) return { state: "exchanged" };
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
    options.fetch ?? ((input, init) => fetch(input, init)),
  );
}

let launched: Promise<LaunchOutcome> = Promise.resolve({ state: "none" });

/**
 * The page's launch: called once by the app's boot, before anything reads
 * the hash. The page's operator client waits for it before it asks for the
 * token.
 */
export function startPageLaunch(
  page: LaunchPage = window,
  options: LaunchOptions = { staticCopy: servedStatically() },
): Promise<LaunchOutcome> {
  launched = beginLaunch(page, options);
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
}

/**
 * The post was not made because no operator token could be had. Nothing was
 * changed: either no POST left the page, or the one that did was refused with
 * a 403, which the control plane answers only before doing anything. A
 * request that fails after the token was had is not this: it may have arrived.
 * Its name stays "Error", so a view that prints the error reads as before.
 */
export class NotSent extends Error {}

async function fetchToken(fetchImpl: Fetch): Promise<string> {
  const response = await fetchImpl(TOKEN_ROUTE);
  // No session (none yet, or expired): the page says how to get one, in its
  // own words, whatever the answer's body holds.
  if (response.status === 401) throw new Error(NO_SESSION_ERROR);
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

export interface OperatorClientOptions {
  /** A static copy: no token is asked for and nothing is sent; every request fails as `NotSent`. */
  staticCopy?: boolean;
  /**
   * Awaited before each request for the token: the page's launch, whose
   * session cookie the token route needs. Nothing by default.
   */
  ready?: () => Promise<unknown>;
}

/** A poster and a reader with one token cache of their own; `fetchImpl` is replaced in tests. */
export function createOperatorClient(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  options: OperatorClientOptions = {},
): OperatorClient {
  let token: Promise<string> | null = null;

  const currentToken = (): Promise<string> => {
    if (token === null) {
      const pending = (async () => {
        await options.ready?.();
        return fetchToken(fetchImpl);
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
    const held = await heldToken();
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
const pageClient = createOperatorClient(undefined, {
  staticCopy: servedStatically(),
  ready: launchSettled,
});
export const operatorPost: OperatorPost = pageClient.post;
export const operatorRead: OperatorRead = pageClient.read;
