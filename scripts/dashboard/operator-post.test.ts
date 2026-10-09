import { describe, expect, test } from "bun:test";
import { createOperatorPost } from "../../docs/js/operator";
import { OPERATOR_HEADER, SURFACE_HEADER, TOKEN_ROUTE } from "../hearth/paths";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * A stand-in hearth: serves whatever token is current, and accepts a POST only
 * when it carries that token.
 */
function fakeHearth(tokens: string[]) {
  const calls: Call[] = [];
  let served = 0;
  let current = "";
  const fetchImpl = async (
    input: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(
        ([name, value]) => [name.toLowerCase(), value],
      ),
    );
    calls.push({
      url: input,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : null,
    });
    if (input === TOKEN_ROUTE) {
      current = tokens[Math.min(served++, tokens.length - 1)] ?? "";
      return Response.json({ ok: true, data: { token: current }, error: null });
    }
    return headers[OPERATOR_HEADER] === current
      ? Response.json({ ok: true, data: "done", error: null })
      : Response.json(
          { ok: false, data: null, error: "token" },
          { status: 403 },
        );
  };
  return {
    calls,
    fetchImpl,
    /** The hearth restarted: it now accepts only a token nobody has fetched yet. */
    restart: () => {
      current = "minted-after-restart";
    },
    posts: () => calls.filter((call) => call.method === "POST"),
    tokenFetches: () => calls.filter((call) => call.url === TOKEN_ROUTE).length,
  };
}

describe("operatorPost", () => {
  test("fetches the token once, and sends it with the ui surface and the JSON body", async () => {
    const hearth = fakeHearth(["t-1"]);
    const post = createOperatorPost(hearth.fetchImpl);

    const first = await post("/__agent-forge/council-api/runs", { a: 1 });
    const second = await post("/__agent-forge/council-api/runs/x/cancel", {});

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(hearth.tokenFetches()).toBe(1);
    expect(hearth.posts().map((call) => call.headers)).toEqual([
      {
        "content-type": "application/json",
        [OPERATOR_HEADER]: "t-1",
        [SURFACE_HEADER]: "ui",
      },
      {
        "content-type": "application/json",
        [OPERATOR_HEADER]: "t-1",
        [SURFACE_HEADER]: "ui",
      },
    ]);
    expect(hearth.posts().map((call) => call.body)).toEqual(['{"a":1}', "{}"]);
  });

  test("after a 403 it fetches a fresh token and retries exactly once", async () => {
    const hearth = fakeHearth(["t-1", "t-2"]);
    const post = createOperatorPost(hearth.fetchImpl);
    expect((await post("/__agent-forge/x", {})).status).toBe(200);

    // The hearth restarts and mints a new token: the cached one is refused.
    hearth.restart();
    const calls = hearth.calls.length;
    const retried = await post("/__agent-forge/x", { b: 2 });
    expect(retried.status).toBe(200);
    expect(
      hearth.calls.slice(calls).map((call) => `${call.method} ${call.url}`),
    ).toEqual([
      "POST /__agent-forge/x",
      `GET ${TOKEN_ROUTE}`,
      "POST /__agent-forge/x",
    ]);
    expect(hearth.posts().at(-1)?.headers[OPERATOR_HEADER]).toBe("t-2");
  });

  test("a second refusal is returned as it is, not retried again", async () => {
    const calls: string[] = [];
    const post = createOperatorPost(async (input, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      return input === TOKEN_ROUTE
        ? Response.json({ ok: true, data: { token: "t" }, error: null })
        : Response.json(
            { ok: false, data: null, error: "refused" },
            { status: 403 },
          );
    });
    const response = await post("/__agent-forge/x", {});
    expect(response.status).toBe(403);
    expect(calls).toEqual([
      `GET ${TOKEN_ROUTE}`,
      "POST /__agent-forge/x",
      `GET ${TOKEN_ROUTE}`,
      "POST /__agent-forge/x",
    ]);
  });

  test("when the token cannot be fetched the post fails with the hearth's reason, and the next call asks again", async () => {
    let up = false;
    const post = createOperatorPost(async (input) => {
      if (input !== TOKEN_ROUTE)
        return Response.json({ ok: true, data: 1, error: null });
      return up
        ? Response.json({ ok: true, data: { token: "t" }, error: null })
        : Response.json(
            { ok: false, data: null, error: "still starting" },
            { status: 503 },
          );
    });
    await expect(post("/__agent-forge/x", {})).rejects.toThrow(
      "still starting",
    );
    up = true;
    expect((await post("/__agent-forge/x", {})).status).toBe(200);
  });
});
