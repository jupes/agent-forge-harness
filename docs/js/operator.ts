/**
 * Posting an operator action to the hearth, and reading what only the
 * operator may read.
 *
 * Every mutating route of the control plane needs the operator token, and so
 * does a read of a stored council run (it holds what was reviewed, a bead's
 * private text included). The page asks the hearth for the token — the token
 * route answers only a same-origin request — the first time it needs it, and
 * sends it with each action and each such read. Posts and reads share it.
 *
 * The hearth mints a new token every time it starts, and the dashboard restarts
 * a stopped hearth without the page knowing. So a 403 is answered by fetching
 * the token again and sending once more: a refused action has done nothing,
 * which is what makes the second attempt safe, and a read changes nothing.
 * When the token cannot be had, the request fails with `NotSent`: the caller
 * can say it was not made.
 */

import {
  OPERATOR_HEADER,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

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

/** A poster and a reader with one token cache of their own; `fetchImpl` is replaced in tests. */
export function createOperatorClient(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): OperatorClient {
  let token: Promise<string> | null = null;

  const currentToken = (): Promise<string> => {
    if (token === null) {
      const pending = fetchToken(fetchImpl);
      token = pending;
      // A failed fetch is not remembered: the next action asks again.
      pending.catch(() => {
        if (token === pending) token = null;
      });
    }
    return token;
  };

  const heldToken = async (): Promise<string> => {
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

/** The page's client: one token cache for every island, posts and reads alike. */
const pageClient = createOperatorClient();
export const operatorPost: OperatorPost = pageClient.post;
export const operatorRead: OperatorRead = pageClient.read;
