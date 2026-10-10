/**
 * Posting an operator action to the hearth.
 *
 * Every mutating route of the control plane needs the operator token. The page
 * asks the hearth for it — the token route answers only a same-origin request —
 * the first time it has something to post, and sends it with each action.
 *
 * The hearth mints a new token every time it starts, and the dashboard restarts
 * a stopped hearth without the page knowing. So a 403 is answered by fetching
 * the token again and posting once more: a refused action has done nothing,
 * which is what makes the second attempt safe.
 */

import {
  OPERATOR_HEADER,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../../scripts/hearth/paths";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type OperatorPost = (url: string, body: unknown) => Promise<Response>;

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

/** A poster with its own token cache; `fetchImpl` is replaced in tests. */
export function createOperatorPost(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): OperatorPost {
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

  const send = async (url: string, body: unknown): Promise<Response> =>
    fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [OPERATOR_HEADER]: await currentToken(),
        [SURFACE_HEADER]: "ui",
      },
      body: JSON.stringify(body),
    });

  return async (url, body) => {
    const response = await send(url, body);
    if (response.status !== 403) return response;
    token = null;
    return send(url, body);
  };
}

/** The page's poster: one token cache for every island. */
export const operatorPost: OperatorPost = createOperatorPost();
