import { describe, expect, test } from "bun:test";
import { STATIC_COPY_ERROR } from "../../docs/js/hearth-read";
import {
  createOperatorClient,
  createOperatorPost,
  NotSent,
} from "../../docs/js/operator";
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
    const headers = Object.fromEntries(new Headers(init.headers).entries());
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
    reads: () =>
      calls.filter((call) => call.method === "GET" && call.url !== TOKEN_ROUTE),
    tokenFetches: () => calls.filter((call) => call.url === TOKEN_ROUTE).length,
  };
}

describe("operatorRead", () => {
  test("sends the token on a GET and keeps the request's own headers and signal; no body and no surface label", async () => {
    const hearth = fakeHearth(["t-1"]);
    const { read } = createOperatorClient(hearth.fetchImpl);
    const signals: Array<AbortSignal | null | undefined> = [];
    const watched = createOperatorClient(async (input, init) => {
      signals.push(init?.signal);
      return hearth.fetchImpl(input, init);
    }).read;

    const answer = await read("/__agent-forge/council-api/runs/r-1");
    expect(answer.status).toBe(200);
    const controller = new AbortController();
    await watched("/__agent-forge/council-api/runs/r-1/events", {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });

    expect(hearth.reads().map((call) => call.headers)).toEqual([
      { [OPERATOR_HEADER]: "t-1" },
      { accept: "text/event-stream", [OPERATOR_HEADER]: "t-1" },
    ]);
    expect(hearth.reads().map((call) => call.body)).toEqual([null, null]);
    expect(signals.at(-1)).toBe(controller.signal);
  });

  test("shares the poster's token: a post and a read fetch it once", async () => {
    const hearth = fakeHearth(["t-1"]);
    const client = createOperatorClient(hearth.fetchImpl);
    await client.post("/__agent-forge/council-api/runs", {});
    await client.read("/__agent-forge/council-api/runs");
    expect(hearth.tokenFetches()).toBe(1);
    expect(hearth.reads().at(-1)?.headers[OPERATOR_HEADER]).toBe("t-1");
  });

  test("after a 403 it fetches a fresh token and reads once more", async () => {
    const hearth = fakeHearth(["t-1", "t-2"]);
    const { read } = createOperatorClient(hearth.fetchImpl);
    expect((await read("/__agent-forge/x")).status).toBe(200);

    hearth.restart();
    const calls = hearth.calls.length;
    expect((await read("/__agent-forge/x")).status).toBe(200);
    expect(
      hearth.calls.slice(calls).map((call) => `${call.method} ${call.url}`),
    ).toEqual([
      "GET /__agent-forge/x",
      `GET ${TOKEN_ROUTE}`,
      "GET /__agent-forge/x",
    ]);
    expect(hearth.reads().at(-1)?.headers[OPERATOR_HEADER]).toBe("t-2");
  });

  test("a token that cannot be had fails the read with NotSent, and no read is made", async () => {
    const calls: string[] = [];
    const { read } = createOperatorClient(async (input, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      return input === TOKEN_ROUTE
        ? Response.json(
            { ok: false, data: null, error: "still starting" },
            { status: 503 },
          )
        : Response.json({ ok: true, data: 1, error: null });
    });
    const error = await read("/__agent-forge/x").catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NotSent);
    expect(calls).toEqual([`GET ${TOKEN_ROUTE}`]);
  });
});

describe("on a static copy", () => {
  test("nothing is asked for: no token, no read, no post; each fails as not sent, saying live data is not available there", async () => {
    const hearth = fakeHearth(["t-1"]);
    const { read, post } = createOperatorClient(hearth.fetchImpl, {
      staticCopy: true,
    });
    for (const attempt of [
      () => read("/__agent-forge/council-api/profiles"),
      () => post("/__agent-forge/council-api/runs", { source: "x" }),
    ]) {
      const error = await attempt().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(NotSent);
      expect((error as Error).message).toBe(STATIC_COPY_ERROR);
    }
    expect(hearth.calls).toEqual([]);
  });
});

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

  test("a token that cannot be had fails the post with NotSent, and no POST is made", async () => {
    const failures: Array<() => Response> = [
      () =>
        Response.json(
          { ok: false, data: null, error: "still starting" },
          { status: 503 },
        ),
      () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const failure of failures) {
      const calls: string[] = [];
      const post = createOperatorPost(async (input, init = {}) => {
        calls.push(`${init.method ?? "GET"} ${input}`);
        return input === TOKEN_ROUTE
          ? failure()
          : Response.json({ ok: true, data: 1, error: null });
      });
      const error = await post("/__agent-forge/x", {}).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(NotSent);
      expect(calls).toEqual([`GET ${TOKEN_ROUTE}`]);
    }
  });

  test("after a 403, a token that cannot be had again fails with NotSent: the one POST made was refused", async () => {
    const calls: string[] = [];
    let tokens = 0;
    const post = createOperatorPost(async (input, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input !== TOKEN_ROUTE)
        return Response.json(
          { ok: false, data: null, error: "token" },
          { status: 403 },
        );
      return tokens++ === 0
        ? Response.json({ ok: true, data: { token: "t" }, error: null })
        : Response.json(
            { ok: false, data: null, error: "still starting" },
            { status: 503 },
          );
    });
    const error = await post("/__agent-forge/x", {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NotSent);
    expect(error).toHaveProperty("message", "still starting");
    expect(calls).toEqual([
      `GET ${TOKEN_ROUTE}`,
      "POST /__agent-forge/x",
      `GET ${TOKEN_ROUTE}`,
    ]);
  });

  test("a NotSent prints as the Error it replaced: Error and the token route's reason", async () => {
    const post = createOperatorPost(async () =>
      Response.json(
        { ok: false, data: null, error: "still starting" },
        { status: 503 },
      ),
    );
    const error = await post("/__agent-forge/x", {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NotSent);
    expect(String(error)).toBe("Error: still starting");
  });

  test("a POST that fails after the token was had fails with its own error, not NotSent", async () => {
    const post = createOperatorPost(async (input) => {
      if (input === TOKEN_ROUTE)
        return Response.json({ ok: true, data: { token: "t" }, error: null });
      throw new TypeError("Failed to fetch");
    });
    const error = await post("/__agent-forge/x", {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(NotSent);
  });
});
