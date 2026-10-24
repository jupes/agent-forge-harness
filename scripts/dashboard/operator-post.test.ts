import { describe, expect, test } from "bun:test";
import { STATIC_COPY_ERROR } from "../../docs/js/hearth-read";
import {
  beginLaunch,
  createOperatorClient,
  createOperatorPost,
  launchSettled,
  NotSent,
  startPageLaunch,
  takeLaunchSecret,
} from "../../docs/js/operator";
import {
  LAUNCH_HEADER,
  NO_SESSION_ERROR,
  OPERATOR_HEADER,
  SESSION_KEY_HEADER,
  SESSION_ROUTE,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../hearth/paths";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

test("a connection guard blocks writes before token lookup and again after a pending token arrives", async () => {
  const calls: string[] = [];
  let blocked: string | null = "The hearth connection is unavailable";
  let answer: ((value: Response) => void) | undefined;
  const client = createOperatorClient(
    async (url) => {
      calls.push(url);
      return new Promise<Response>((done) => {
        answer = done;
      });
    },
    { postProblem: () => blocked },
  );
  await expect(
    within(client.post("/action", {}), "blocked post"),
  ).rejects.toBeInstanceOf(NotSent);
  expect(calls).toEqual([]);
  blocked = null;
  const pending = client.post("/action", {});
  await new Promise((done) => setImmediate(done));
  blocked = "The hearth stopped while authenticating";
  answer?.(Response.json({ ok: true, data: { token: "t" }, error: null }));
  await expect(within(pending, "guarded token wait")).rejects.toBeInstanceOf(
    NotSent,
  );
  expect(calls).toEqual([TOKEN_ROUTE]);
});

/**
 * `promise`, or a failure after `ms` of real time. A hung-request test whose
 * deadline regressed would otherwise wait on a promise that never settles,
 * and bun's per-test timeout does not end it: the run hangs instead of
 * failing. The real timer here does fire, and the test fails in seconds.
 */
async function within<T>(
  promise: Promise<T>,
  what: string,
  ms = 2_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, fail) => {
        timer = setTimeout(
          () => fail(new Error(`${what} did not settle within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("bounded operator requests", () => {
  test("successful streams stay streaming and keep caller cancellation after the header timer is cleared", async () => {
    const timers = new Set<() => void>();
    let streamSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": open\n\n"));
      },
    });
    const client = createOperatorClient(
      async (url, init) => {
        if (url === TOKEN_ROUTE)
          return Response.json({ ok: true, data: { token: "t" }, error: null });
        streamSignal = init?.signal;
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      {
        timers: {
          set(run) {
            timers.add(run);
            return run;
          },
          clear(handle) {
            for (const timer of timers)
              if (timer === handle) timers.delete(timer);
          },
        },
      },
    );
    const controller = new AbortController();
    const response = await client.read("/events", {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(timers.size).toBe(0);
    expect(response.body).toBe(body);
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
      ": open\n\n",
    );
    controller.abort();
    expect(streamSignal?.aborted).toBe(true);
    await reader?.cancel();
  });

  test("no-body answers preserve status and headers without manufacturing a body", async () => {
    const client = createOperatorClient(async (url) =>
      url === TOKEN_ROUTE
        ? Response.json({ ok: true, data: { token: "t" }, error: null })
        : new Response(null, {
            status: 204,
            statusText: "No Content",
            headers: { "x-result": "saved" },
          }),
    );
    const response = await client.post("/save", {});
    expect(response.status).toBe(204);
    expect(response.statusText).toBe("No Content");
    expect(response.headers.get("x-result")).toBe("saved");
    expect(response.body).toBeNull();
  });

  test("a launch that never answers is refused within its bound and keeps no session key", async () => {
    let expire = () => {};
    let signal: AbortSignal | null | undefined;
    const keys = keyStore();
    const pending = beginLaunch(
      {
        location: { hash: "#launch=secret", pathname: "/", search: "" },
        history: { state: null, replaceState() {} },
      },
      {
        fetch: async (_url, init) => {
          signal = init?.signal;
          return new Promise<Response>(() => {});
        },
        sessionKeys: keys,
        timers: {
          set(run) {
            expire = run;
            return 1;
          },
          clear() {},
        },
      },
    );
    expire();
    expect(await within(pending, "the launch")).toEqual({
      state: "refused",
      error: "The control plane did not answer within 45 s.",
    });
    expect(signal?.aborted).toBe(true);
    expect(keys.held).toEqual([]);
  });

  test.each([
    "token",
    "post",
    "read",
  ] as const)("hung %s headers or body settle and do not retry", async (kind) => {
    for (const bodyOnly of [false, true]) {
      let expire = () => {};
      let cleared = 0;
      const calls: string[] = [];
      let signal: AbortSignal | null | undefined;
      let reached = () => {};
      const hanging = new Promise<void>((done) => {
        reached = done;
      });
      const client = createOperatorClient(
        async (url, init) => {
          calls.push(url);
          if (kind !== "token" && url === TOKEN_ROUTE)
            return Response.json({
              ok: true,
              data: { token: "t" },
              error: null,
            });
          signal = init?.signal;
          reached();
          return bodyOnly
            ? new Response(new ReadableStream({ start() {} }))
            : new Promise<Response>(() => {});
        },
        {
          timeoutMs: 45_000,
          timers: {
            set(run) {
              expire = run;
              return 1;
            },
            clear() {
              cleared++;
            },
          },
        },
      );
      const pending = (
        kind === "read" ? client.read("/runs") : client.post("/runs", {})
      ).catch((error: unknown) => error);
      await within(hanging, `the ${kind} request`);
      await Promise.resolve();
      expire();
      const error = await within(pending, `the hung ${kind}`);
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof NotSent).toBe(kind === "token");
      expect(error).toHaveProperty(
        "message",
        "The control plane did not answer within 45 s.",
      );
      expect(signal?.aborted).toBe(true);
      expect(calls).toEqual(
        kind === "token" ? [TOKEN_ROUTE] : [TOKEN_ROUTE, "/runs"],
      );
      expect(cleared).toBe(kind === "token" ? 1 : 2);
    }
  });
});

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
    controller.abort();
    expect(signals.at(-1)?.aborted).toBe(true);
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

describe("without a dashboard session (x1gs.3.31)", () => {
  /** A token route that answers 401 as the hearth does without a session, with a body that is not the page's words. */
  const noSession = async (input: string): Promise<Response> =>
    input === TOKEN_ROUTE
      ? Response.json(
          { ok: false, data: null, error: "the hearth's own words" },
          { status: 401 },
        )
      : Response.json({ ok: true, data: 1, error: null });

  test("a post fails as NotSent saying how to open the dashboard from its launcher, and nothing is posted", async () => {
    const calls: string[] = [];
    const post = createOperatorPost(async (input, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      return noSession(input);
    });
    const error = await post("/__agent-forge/beads", {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NotSent);
    expect(error).toHaveProperty("message", NO_SESSION_ERROR);
    expect(NO_SESSION_ERROR).toContain("bun run dashboard");
    expect(NO_SESSION_ERROR).toContain("bun run dashboard:open");
    expect(calls).toEqual([`GET ${TOKEN_ROUTE}`]);
  });

  test("the 401's body is read away before the post fails: an answer left unread stays open in the browser", async () => {
    const answers: Response[] = [];
    const post = createOperatorPost(async (input) => {
      const answer = await noSession(input);
      answers.push(answer);
      return answer;
    });
    await post("/__agent-forge/beads", {}).catch(() => undefined);
    expect(answers.map((answer) => answer.bodyUsed)).toEqual([true]);
  });

  test("after a 403 the token is asked for once more; a 401 then fails the post as NotSent, with no further request", async () => {
    const calls: string[] = [];
    let tokenAsks = 0;
    const post = createOperatorPost(async (input, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input === TOKEN_ROUTE && tokenAsks++ === 0)
        return Response.json({ ok: true, data: { token: "t" }, error: null });
      if (input === TOKEN_ROUTE) return noSession(input);
      return Response.json(
        { ok: false, data: null, error: "token" },
        { status: 403 },
      );
    });
    const error = await post("/__agent-forge/x", {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toHaveProperty("message", NO_SESSION_ERROR);
    expect(calls).toEqual([
      `GET ${TOKEN_ROUTE}`,
      "POST /__agent-forge/x",
      `GET ${TOKEN_ROUTE}`,
    ]);
  });

  test("the client asks for the token only once its launch has settled", async () => {
    const order: string[] = [];
    let settle = (): void => {};
    const launch = new Promise<void>((done) => {
      settle = done;
    });
    const client = createOperatorClient(
      async (input) => {
        order.push(input);
        return Response.json({ ok: true, data: { token: "t" }, error: null });
      },
      {
        ready: async () => {
          await launch;
          order.push("launch settled");
        },
      },
    );
    const posted = client.post("/__agent-forge/x", {});
    await new Promise((done) => setTimeout(done, 20));
    expect(order).toEqual([]);
    settle();
    await posted;
    expect(order).toEqual(["launch settled", TOKEN_ROUTE, "/__agent-forge/x"]);
  });
});

/** A stand-in for the page's storage of its session key: what was set, in order. */
function keyStore(initial: string | null = null) {
  const store = {
    held: initial === null ? ([] as string[]) : [initial],
    get: () => store.held.at(-1) ?? null,
    set: (key: string) => {
      store.held.push(key);
    },
  };
  return store;
}

const KEY = "ef".repeat(32);

describe("the session key (x1gs.3.31)", () => {
  test("the token request carries the key read from storage when it is made: after another tab's launch replaced it, the next one carries the new key", async () => {
    const keys = keyStore("01".repeat(32));
    const sentKeys: Array<string | null> = [];
    let answers = 0;
    const client = createOperatorClient(
      async (input, init) => {
        if (input === TOKEN_ROUTE) {
          sentKeys.push(new Headers(init?.headers).get(SESSION_KEY_HEADER));
          // The first is refused (the cookie is another tab's by now), the second served.
          return answers++ === 0
            ? Response.json(
                { ok: false, data: null, error: "no session" },
                { status: 401 },
              )
            : Response.json({ ok: true, data: { token: "t" }, error: null });
        }
        return Response.json({ ok: true, data: 1, error: null });
      },
      { sessionKeys: keys },
    );
    const first = await client
      .post("/__agent-forge/x", {})
      .catch((error: unknown) => error);
    expect(first).toBeInstanceOf(NotSent);
    keys.set("02".repeat(32));
    expect((await client.post("/__agent-forge/x", {})).status).toBe(200);
    expect(sentKeys).toEqual(["01".repeat(32), "02".repeat(32)]);
  });

  test("with no key in storage the token request carries none, and the action fails as NotSent with how to relaunch", async () => {
    const sent: Array<string | null> = [];
    const post = createOperatorClient(
      async (input, init) => {
        sent.push(new Headers(init?.headers).get(SESSION_KEY_HEADER));
        return input === TOKEN_ROUTE
          ? Response.json(
              { ok: false, data: null, error: "x" },
              { status: 401 },
            )
          : Response.json({ ok: true, data: 1, error: null });
      },
      { sessionKeys: keyStore() },
    ).post;
    const error = await post("/__agent-forge/x", {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toHaveProperty("message", NO_SESSION_ERROR);
    expect(sent).toEqual([null]);
  });

  test("an exchange that answers no key, or one of another shape, is refused and keeps nothing; a refused exchange keeps nothing", async () => {
    for (const data of [{}, { key: "short" }, { key: KEY.toUpperCase() }]) {
      const keys = keyStore();
      const outcome = await beginLaunch(
        {
          location: {
            hash: `#launch=${"ab".repeat(32)}`,
            pathname: "/",
            search: "",
          },
          history: { state: null, replaceState: () => undefined },
        },
        {
          fetch: async () => Response.json({ ok: true, data, error: null }),
          sessionKeys: keys,
        },
      );
      expect({ data, outcome, held: keys.held }).toEqual({
        data,
        outcome: {
          state: "refused",
          error: "The control plane answered no session key",
        },
        held: [],
      });
    }
  });
});

describe("the launch fragment", () => {
  const SECRET = "ab".repeat(32);

  test("takeLaunchSecret takes the secret and keeps the route part and every other parameter as it was", () => {
    expect(takeLaunchSecret(`#launch=${SECRET}`)).toEqual({
      secret: SECRET,
      hash: "",
    });
    expect(takeLaunchSecret(`#/workbench?launch=${SECRET}`)).toEqual({
      secret: SECRET,
      hash: "#/workbench",
    });
    expect(
      takeLaunchSecret(`#/timeline?bead=x-1&launch=${SECRET}&kind=a%2Cb`),
    ).toEqual({ secret: SECRET, hash: "#/timeline?bead=x-1&kind=a%2Cb" });
    expect(takeLaunchSecret(`#/timeline?launch=${SECRET}&kind=a,b`)).toEqual({
      secret: SECRET,
      hash: "#/timeline?kind=a,b",
    });
  });

  test("takeLaunchSecret leaves a fragment with no secret as it was, and gives none for an empty or a repeated one, which it still strips", () => {
    for (const hash of [
      "",
      "#",
      "#/workbench",
      "#/timeline?bead=x-1",
      "#af-main",
      "#/timeline?launched=1",
    ])
      expect(takeLaunchSecret(hash)).toEqual({ secret: null, hash });
    expect(takeLaunchSecret("#/workbench?launch=")).toEqual({
      secret: null,
      hash: "#/workbench",
    });
    expect(
      takeLaunchSecret(`#/workbench?launch=${SECRET}&launch=${SECRET}`),
    ).toEqual({ secret: null, hash: "#/workbench" });
  });

  /** A page at `hash`, whose address bar and history are recorded. */
  function page(hash: string) {
    const replaced: string[] = [];
    const location = { hash, pathname: "/index.html", search: "?x=1" };
    return {
      replaced,
      location,
      history: {
        state: { kept: true },
        replaceState(data: unknown, _unused: string, url?: string) {
          expect(data).toEqual({ kept: true });
          const next = url ?? "";
          replaced.push(next);
          location.hash = next.includes("#")
            ? next.slice(next.indexOf("#"))
            : "";
        },
      },
    };
  }

  test("beginLaunch removes the secret from the address bar before the exchange is answered, keeping the route, then posts it once, same-origin, to the session route, and keeps the session key it answers in the page's storage", async () => {
    const at = page(`#/timeline?bead=x-1&launch=${SECRET}`);
    const keys = keyStore();
    const sent: Array<{
      url: string;
      init: RequestInit | undefined;
      hash: string;
    }> = [];
    const outcome = await beginLaunch(at, {
      fetch: async (url, init) => {
        sent.push({ url, init, hash: at.location.hash });
        return Response.json({ ok: true, data: { key: KEY }, error: null });
      },
      sessionKeys: keys,
    });
    expect(outcome).toEqual({ state: "exchanged" });
    expect(keys.held).toEqual([KEY]);
    expect(at.replaced).toEqual(["/index.html?x=1#/timeline?bead=x-1"]);
    expect(sent).toEqual([
      {
        url: SESSION_ROUTE,
        init: {
          method: "POST",
          headers: { [LAUNCH_HEADER]: SECRET, [SURFACE_HEADER]: "ui" },
          credentials: "same-origin",
          signal: expect.any(AbortSignal),
        },
        // Already gone from the address bar when the request left.
        hash: "#/timeline?bead=x-1",
      },
    ]);
  });

  test("beginLaunch on a page with no secret changes nothing and sends nothing; on a static copy it strips the secret and sends nothing", async () => {
    const plain = page("#/workbench");
    const sent: string[] = [];
    const record = async (url: string): Promise<Response> => {
      sent.push(url);
      return Response.json({ ok: true, data: {}, error: null });
    };
    expect(await beginLaunch(plain, { fetch: record })).toEqual({
      state: "none",
    });
    expect(plain.replaced).toEqual([]);
    const copy = page(`#launch=${SECRET}`);
    expect(
      await beginLaunch(copy, { fetch: record, staticCopy: true }),
    ).toEqual({ state: "none" });
    expect(copy.replaced).toEqual(["/index.html?x=1"]);
    expect(sent).toEqual([]);
  });

  test("startPageLaunch exchanges the secret the page was opened with, and one a later fragment-only navigation brings; launchSettled answers the latest", async () => {
    const at = page(`#launch=${SECRET}`);
    const listeners: Array<() => void> = [];
    const sent: string[] = [];
    const win = {
      ...at,
      addEventListener: (_type: "hashchange", listener: () => void) => {
        listeners.push(listener);
      },
    };
    const keys = keyStore();
    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      const secret = new Headers(init?.headers).get(LAUNCH_HEADER) ?? url;
      sent.push(secret);
      // A key of its own for each exchange.
      return Response.json({
        ok: true,
        data: { key: secret.split("").reverse().join("") },
        error: null,
      });
    };
    expect(
      await startPageLaunch(win, { fetch: fetchImpl, sessionKeys: keys }),
    ).toEqual({
      state: "exchanged",
    });
    expect(listeners).toHaveLength(1);
    // A fragment with no secret changes nothing.
    at.location.hash = "#/workbench";
    listeners[0]?.();
    expect(at.replaced).toEqual(["/index.html?x=1"]);
    // The same tab given another launch link: only the fragment changed.
    const next = "cd".repeat(32);
    at.location.hash = `#/workbench?launch=${next}`;
    listeners[0]?.();
    expect(at.replaced).toEqual([
      "/index.html?x=1",
      "/index.html?x=1#/workbench",
    ]);
    expect(await launchSettled()).toEqual({ state: "exchanged" });
    expect(sent).toEqual([SECRET, next]);
    // The later launch's key replaced the first's.
    expect(keys.held).toEqual(["ba".repeat(32), "dc".repeat(32)]);
  });

  test("beginLaunch reports a refused or failed exchange in the hearth's words, keeps no key, and never rejects", async () => {
    const keys = keyStore();
    const refused = await beginLaunch(page(`#launch=${SECRET}`), {
      fetch: async () =>
        Response.json(
          {
            ok: false,
            data: { key: KEY },
            error: "This launch link is not valid",
          },
          { status: 403 },
        ),
      sessionKeys: keys,
    });
    expect(keys.held).toEqual([]);
    expect(refused).toEqual({
      state: "refused",
      error: "This launch link is not valid",
    });
    const failed = await beginLaunch(page(`#launch=${SECRET}`), {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(failed).toEqual({ state: "refused", error: "Failed to fetch" });
  });
});
