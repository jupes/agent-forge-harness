import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { LedgerEventOf, OperatorEnvelope } from "../../types/hearth";
import type { AppendResult } from "../ledger/append";
import type { ActionRoute, ApiRoute } from "./api";
import { tokenPath } from "./home";
import { OPERATOR_HEADER, SURFACE_HEADER } from "./paths";
import {
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "./testing";
import { validateOperatorEnvelope } from "./validate";

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function start(options: TestHearthOptions = {}): Promise<TestHearth> {
  const hearth = await startTestHearth(options);
  open.push(hearth);
  return hearth;
}

/** The answer's envelope, after checking it is one. */
async function envelope<T = unknown>(
  response: Response,
): Promise<OperatorEnvelope<T>> {
  const body: unknown = await response.json();
  const checked = validateOperatorEnvelope(body);
  if (!checked.ok) throw new Error(`not an envelope: ${checked.error}`);
  // justification: the guard above proved the envelope; `T` is the caller's claim about `data`.
  return checked.value as OperatorEnvelope<T>;
}

const RUN_STATE = JSON.stringify({
  schemaVersion: 2,
  slug: "demo",
  feature: "Demo run",
  phase: "research",
  completed: ["research"],
  artifacts: { research: "plans/research/demo.md" },
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const key = (route: ApiRoute): string => `${route.method} ${route.path}`;

/** The table's action rows. An empty table must fail a test that iterates it, not pass it. */
function actionRows(h: TestHearth): ActionRoute[] {
  const rows = h.hearth.routes.filter(
    (route): route is ActionRoute => route.kind === "action",
  );
  if (rows.length === 0) throw new Error("the table has no action rows");
  return rows;
}

function post(
  h: TestHearth,
  path: string,
  body: unknown,
  headers: Record<string, string> = h.headers(h.hearth.token),
): Promise<Response> {
  return fetch(`${h.api}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function councilRunFinished(h: TestHearth, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${h.api}/council-api/runs/${runId}`);
    const job = (await response.json()) as { data?: { status?: string } };
    if (job.data?.status !== "running" && job.data?.status !== "cancelling")
      return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`council run ${runId} did not finish`);
}

interface ActionFixture {
  /** A request the row accepts, and the status its effect answers. */
  valid: { path: string; body: unknown; status: number; target: string };
  /** A request the row's validator refuses. */
  invalid: { path: string; body: unknown };
  /** What the valid request needs to exist first. */
  prepare?(h: TestHearth): Promise<void>;
}

const text = (runId: string): Record<string, unknown> => ({
  sourceType: "text",
  source: "Evaluate this plan and record any missing evidence.",
  runId,
});

async function finishedRun(h: TestHearth, runId: string): Promise<void> {
  const started = await post(h, "/council/runs", text(runId));
  if (started.status !== 202) throw new Error(`could not start ${runId}`);
  await councilRunFinished(h, runId);
}

const REVIEW = { issueId: "demo-1", decision: "approve", note: "" };

/** One entry per action row of the table; a row with none fails the suite. */
const ACTIONS: Record<string, ActionFixture> = {
  "POST /council/runs": {
    valid: {
      path: "/council/runs",
      body: text("fixture-a"),
      status: 202,
      target: "fixture-a",
    },
    invalid: {
      path: "/council/runs",
      body: { sourceType: "nope", source: "x" },
    },
  },
  "POST /council/runs/:id/cancel": {
    prepare: (h) => finishedRun(h, "to-cancel-a"),
    valid: {
      path: "/council/runs/to-cancel-a/cancel",
      body: {},
      status: 200,
      target: "to-cancel-a",
    },
    invalid: { path: "/council/runs/con/cancel", body: {} },
  },
  "POST /council-api/runs": {
    valid: {
      path: "/council-api/runs",
      body: text("fixture-b"),
      status: 202,
      target: "fixture-b",
    },
    invalid: { path: "/council-api/runs", body: { sourceType: "text" } },
  },
  "POST /council-api/runs/:id/cancel": {
    prepare: (h) => finishedRun(h, "to-cancel-b"),
    valid: {
      path: "/council-api/runs/to-cancel-b/cancel",
      body: {},
      status: 200,
      target: "to-cancel-b",
    },
    invalid: { path: "/council-api/runs/trailing./cancel", body: {} },
  },
  "POST /dev-api/forge-run/review": {
    valid: {
      path: "/dev-api/forge-run/review",
      body: REVIEW,
      status: 200,
      target: "demo-1",
    },
    invalid: {
      path: "/dev-api/forge-run/review",
      body: { issueId: "../x", decision: "approve" },
    },
  },
};

/** A concrete path per read row; a row with none fails the suite. */
const READS: Record<string, string> = {
  "GET /runs": "/runs",
};

function fixture(route: ApiRoute): ActionFixture {
  const found = ACTIONS[key(route)];
  if (!found) throw new Error(`no fixture for action row ${key(route)}`);
  return found;
}

interface Probe {
  row: string;
  /** The audit rows in the ledger at the moment the effect was called. */
  audit: LedgerEventOf<"operator.action">[];
}

/** A hearth whose every action row reports when its effect is called, and what the ledger held then. */
async function probed(
  options: TestHearthOptions = {},
): Promise<{ h: TestHearth; probes: Probe[] }> {
  const probes: Probe[] = [];
  let h: TestHearth | undefined;
  const audit = (): LedgerEventOf<"operator.action">[] =>
    (h?.events(["operator.action"]) ?? []).filter(
      (event): event is LedgerEventOf<"operator.action"> =>
        event.kind === "operator.action",
    );
  h = await start({
    ...options,
    api: {
      ...options.api,
      decorate: (routes) =>
        routes.map((route) =>
          route.kind !== "action"
            ? route
            : {
                ...route,
                effect: (input: unknown) => {
                  probes.push({ row: key(route), audit: audit() });
                  return route.effect(input);
                },
              },
        ),
    },
  });
  return { h, probes };
}

function snapshot(h: TestHearth): number[] {
  return h.events().map((event) => event.id);
}

describe("the operator API on a hearth", () => {
  test("GET /runs answers the envelope with the runs of the hearth's root", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    const response = await fetch(`${h.api}/runs`, { headers: h.headers() });
    expect(response.status).toBe(200);
    const body = await envelope<Array<{ slug: string }>>(response);
    expect(body.ok).toBe(true);
    expect(body.data?.map((run) => run.slug)).toEqual(["demo"]);
  });
});

describe("the route table", () => {
  test("every row has a fixture here, and every fixture a row", async () => {
    const h = await start();
    const rows = h.hearth.routes;
    expect(
      rows
        .filter((route) => route.kind === "action")
        .map(key)
        .sort(),
    ).toEqual(Object.keys(ACTIONS).sort());
    expect(
      rows
        .filter((route) => route.kind === "read")
        .map(key)
        .sort(),
    ).toEqual(Object.keys(READS).sort());
  });
});

describe("every action row (iterating the table)", () => {
  test("with the token, from the hearth's own origin: one operator.action is appended, then the effect runs", async () => {
    const { h, probes } = await probed();
    for (const row of actionRows(h)) {
      const { valid, prepare } = fixture(row);
      await prepare?.(h);
      const before = snapshot(h);
      const seen = probes.length;

      const response = await post(h, valid.path, valid.body);
      const body = await envelope(response);
      expect({ row: key(row), status: response.status, ok: body.ok }).toEqual({
        row: key(row),
        status: valid.status,
        ok: true,
      });

      // Exactly one new event, and it is this row's audit row.
      const added = h.events().filter((event) => !before.includes(event.id));
      expect(
        added.map((event) => ({
          row: key(row),
          kind: event.kind,
          payload: event.payload,
        })),
      ).toEqual([
        {
          row: key(row),
          kind: "operator.action",
          payload: { action: row.action, surface: "api", target: valid.target },
        },
      ]);

      // The effect ran once, and that row was already stored when it started.
      const calls = probes.slice(seen);
      expect(calls.map((call) => call.row)).toEqual([key(row)]);
      expect(calls[0]?.audit.at(-1)?.id).toBe(added[0]?.id);

      if (row.action === "council.run.start")
        await councilRunFinished(h, valid.target);
    }
  }, 30_000);

  test("without the token, or with a wrong one: 403, nothing appended, the effect not called", async () => {
    const { h, probes } = await probed();
    const token = h.hearth.token;
    const wrong: Array<[string, string | null]> = [
      ["no header", null],
      ["an empty value", ""],
      ["another token of the same length", "0".repeat(token.length)],
      ["a prefix", token.slice(0, -1)],
      ["a longer value", `${token}0`],
      ["the token in upper case", token.toUpperCase()],
      // Whitespace around a header value is not part of it (HTTP strips it in
      // transit), so that case belongs to tokenMatches' own test, not here.
      ["the token as a bearer value", `Bearer ${token}`],
      [
        "the token twice in one line, as fetch folds a repeat",
        `${token}, ${token}`,
      ],
      ["a wrong value folded before the token", `wrong, ${token}`],
    ];
    for (const row of actionRows(h)) {
      const { valid } = fixture(row);
      for (const [label, value] of wrong) {
        const before = snapshot(h);
        const response = await post(h, valid.path, valid.body, {
          ...h.headers(),
          ...(value === null ? {} : { [OPERATOR_HEADER]: value }),
        });
        const body = await envelope(response);
        expect({
          row: key(row),
          label,
          status: response.status,
          ok: body.ok,
          added: snapshot(h).length - before.length,
        }).toEqual({ row: key(row), label, status: 403, ok: false, added: 0 });
      }
    }
    expect(probes).toEqual([]);
  });

  test("with the token but not from the hearth's own origin: 403, nothing appended, the effect not called", async () => {
    const { h, probes } = await probed();
    const token = { [OPERATOR_HEADER]: h.hearth.token };
    const json = { "Content-Type": "application/json" };
    const origins: Array<[string, Record<string, string>]> = [
      ["no declaration at all", {}],
      ["a foreign Origin", { Origin: "https://evil.example" }],
      ["another loopback port as Origin", { Origin: "http://127.0.0.1:1" }],
      ["Sec-Fetch-Site: same-site", { "Sec-Fetch-Site": "same-site" }],
      ["Sec-Fetch-Site: cross-site", { "Sec-Fetch-Site": "cross-site" }],
      ["Sec-Fetch-Site: none", { "Sec-Fetch-Site": "none" }],
      ["a non-loopback Host", { Origin: h.hearth.url, Host: "evil.example" }],
    ];
    for (const row of actionRows(h)) {
      const { valid } = fixture(row);
      for (const [label, declared] of origins) {
        const before = snapshot(h);
        const response = await post(h, valid.path, valid.body, {
          ...json,
          ...token,
          ...declared,
        });
        const body = await envelope(response);
        expect({
          row: key(row),
          label,
          status: response.status,
          ok: body.ok,
          added: snapshot(h).length - before.length,
        }).toEqual({ row: key(row), label, status: 403, ok: false, added: 0 });
      }
    }
    expect(probes).toEqual([]);
  });

  test("a request the row's validator refuses: 400, nothing appended, the effect not called", async () => {
    const { h, probes } = await probed();
    for (const row of actionRows(h)) {
      const { invalid, valid } = fixture(row);
      const cases: Array<[string, string, unknown, Record<string, string>]> = [
        ["the row's invalid fixture", invalid.path, invalid.body, {}],
        ["malformed JSON", valid.path, "{broken", {}],
        [
          "not JSON at all",
          valid.path,
          valid.body,
          { "Content-Type": "text/plain" },
        ],
        [
          "an undeclared surface",
          valid.path,
          valid.body,
          { [SURFACE_HEADER]: "robot" },
        ],
      ];
      for (const [label, path, body, extra] of cases) {
        const before = snapshot(h);
        const response = await post(h, path, body, {
          ...h.headers(h.hearth.token),
          ...extra,
        });
        const answer = await envelope(response);
        expect({
          row: key(row),
          label,
          status: response.status,
          ok: answer.ok,
          added: snapshot(h).length - before.length,
        }).toEqual({ row: key(row), label, status: 400, ok: false, added: 0 });
      }
    }
    expect(probes).toEqual([]);
    // The wording the dashboard already shows for a broken body is kept.
    const broken = await post(h, "/council-api/runs", "{broken");
    expect((await envelope(broken)).error).toContain("valid JSON");
  });

  test("a declared surface is stored on the audit row", async () => {
    const { h } = await probed();
    for (const surface of ["ui", "cli", "mcp", "api"]) {
      const response = await post(h, "/dev-api/forge-run/review", REVIEW, {
        ...h.headers(h.hearth.token),
        [SURFACE_HEADER]: surface,
      });
      expect(response.status).toBe(200);
      expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
        surface,
      });
    }
  });

  const refusals: Array<[string, () => AppendResult]> = [
    ["refuses", () => ({ ok: false, error: "the ledger is read-only" })],
    ["reports a duplicate", () => ({ ok: true, duplicate: true, ulid: "x" })],
    [
      "throws",
      () => {
        throw new Error("ledger offline");
      },
    ],
  ];
  for (const [label, appendEvent] of refusals) {
    test(`when the audit append ${label}: 503 and the effect is not called`, async () => {
      const { h, probes } = await probed({ api: { appendEvent } });
      for (const row of actionRows(h)) {
        const { valid } = fixture(row);
        const response = await post(h, valid.path, valid.body);
        const body = await envelope(response);
        expect({ row: key(row), status: response.status, ok: body.ok }).toEqual(
          {
            row: key(row),
            status: 503,
            ok: false,
          },
        );
        expect(body.error).toContain("nothing was done");
      }
      expect(probes).toEqual([]);
      // Nothing reached the real effects either: no run was started, bd was not called.
      const runs = await fetch(`${h.api}/council-api/runs`);
      expect((await envelope<unknown[]>(runs)).data).toEqual([]);
      expect(h.bd.calls).toEqual([]);
    });
  }

  test("a busy ledger is retried before the action is refused", async () => {
    let calls = 0;
    const { h, probes } = await probed({
      api: {
        appendEvent: () => {
          calls++;
          return calls < 3
            ? { ok: false, error: "database is locked" }
            : { ok: true, id: 7, ulid: "01J" };
        },
      },
    });
    const response = await post(h, "/dev-api/forge-run/review", REVIEW);
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(probes.length).toBe(1);

    calls = -100;
    const refused = await post(h, "/dev-api/forge-run/review", REVIEW);
    expect(refused.status).toBe(503);
    expect(calls).toBe(-97);
    expect(probes.length).toBe(1);
  });
});

describe("the operator token", () => {
  test("is honoured only while the token file still holds it; the token route then answers 503", async () => {
    const { h, probes } = await probed();
    const file = tokenPath(h.home, h.root);
    const minted = h.hearth.token;
    const states: Array<[string, () => void, string[]]> = [
      [
        "rewritten to another value",
        () => writeFileSync(file, "f".repeat(64)),
        [minted, "f".repeat(64)],
      ],
      ["emptied", () => writeFileSync(file, ""), [minted, ""]],
      ["deleted", () => rmSync(file, { force: true }), [minted]],
    ];
    for (const [label, change, presented] of states) {
      change();
      for (const row of actionRows(h)) {
        const { valid } = fixture(row);
        for (const value of presented) {
          const response = await post(h, valid.path, valid.body, {
            ...h.headers(),
            [OPERATOR_HEADER]: value,
          });
          expect({ row: key(row), label, status: response.status }).toEqual({
            row: key(row),
            label,
            status: 403,
          });
        }
      }
      const served = await fetch(`${h.api}/token`, { headers: h.headers() });
      expect({ label, status: served.status }).toEqual({ label, status: 503 });
    }
    expect(probes).toEqual([]);
    expect(h.events()).toEqual([]);

    // Put back, the minted token works again: the rule is about agreement, not history.
    writeFileSync(file, `${minted}\n`);
    expect((await post(h, "/dev-api/forge-run/review", REVIEW)).status).toBe(
      200,
    );
  });
});

/** Send a request with exactly these header lines, and read the status line and body. */
function raw(
  h: TestHearth,
  method: string,
  path: string,
  headerLines: string[],
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const socket = connect(h.hearth.port, "127.0.0.1", () => {
      socket.write(
        [
          `${method} /__agent-forge${path} HTTP/1.1`,
          ...headerLines,
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          body,
        ].join("\r\n"),
      );
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", fail);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0);
      done({ status, body: received.slice(received.indexOf("\r\n\r\n") + 4) });
    });
  });
}

describe("repeated security headers (raw socket: fetch folds a repeat into one line)", () => {
  test("a request that sends the token, the surface, Origin, Sec-Fetch-Site or Host twice is 403 and writes nothing", async () => {
    const { h, probes } = await probed();
    const host = `Host: 127.0.0.1:${h.hearth.port}`;
    const origin = `Origin: ${h.hearth.url}`;
    const json = "Content-Type: application/json";
    const token = `X-Agent-Forge-Operator: ${h.hearth.token}`;
    const body = JSON.stringify(REVIEW);
    const path = "/dev-api/forge-run/review";

    // The same request with each header once is accepted, so the refusals below are about the repeat.
    const once = await raw(h, "POST", path, [host, origin, json, token], body);
    expect(once.status).toBe(200);
    const before = snapshot(h);
    const seen = probes.length;

    const repeats: Array<[string, string[]]> = [
      [
        "a wrong token then the right one",
        [host, origin, json, "X-Agent-Forge-Operator: wrong", token],
      ],
      [
        "the right token then a wrong one",
        [host, origin, json, token, "X-Agent-Forge-Operator: wrong"],
      ],
      [
        "the token twice in other letter case",
        [host, origin, json, token, token.replace("X-Agent", "x-agent")],
      ],
      [
        "two surfaces",
        [
          host,
          origin,
          json,
          token,
          "X-Agent-Forge-Surface: ui",
          "X-Agent-Forge-Surface: api",
        ],
      ],
      [
        "a foreign Origin then the hearth's",
        [host, "Origin: https://evil.example", origin, json, token],
      ],
      [
        "the hearth's Origin then a foreign one",
        [host, origin, "Origin: https://evil.example", json, token],
      ],
      [
        "cross-site then same-origin fetch metadata",
        [
          host,
          "Sec-Fetch-Site: cross-site",
          "Sec-Fetch-Site: same-origin",
          json,
          token,
        ],
      ],
      [
        "a foreign Host then the hearth's",
        ["Host: evil.example", host, origin, json, token],
      ],
    ];
    for (const [label, lines] of repeats) {
      const answer = await raw(h, "POST", path, lines, body);
      expect({ label, status: answer.status }).toEqual({ label, status: 403 });
      expect(validateOperatorEnvelope(JSON.parse(answer.body)).ok).toBe(true);
    }
    expect(snapshot(h)).toEqual(before);
    expect(probes.length).toBe(seen);
  });
});

describe("the paths that existed before the table", () => {
  test("keep their answers: a service refusal is 400 after an audit row, the list and the 405 are unchanged", async () => {
    const { h, probes } = await probed();
    await finishedRun(h, "kept");

    const duplicate = await post(h, "/council-api/runs", text("kept"));
    expect(duplicate.status).toBe(400);
    expect((await envelope(duplicate)).ok).toBe(false);

    const unknown = await post(h, "/council-api/runs/never-started/cancel", {});
    expect(unknown.status).toBe(400);
    expect((await envelope(unknown)).ok).toBe(false);

    // Both were authorised and well-formed, so both were audited and attempted.
    expect(h.events(["operator.action"]).map((event) => event.payload)).toEqual(
      [
        { action: "council.run.start", surface: "api", target: "kept" },
        { action: "council.run.start", surface: "api", target: "kept" },
        {
          action: "council.run.cancel",
          surface: "api",
          target: "never-started",
        },
      ],
    );
    expect(probes.length).toBe(3);

    const list = await fetch(`${h.api}/council-api/runs`);
    expect(list.status).toBe(200);
    expect(
      (await envelope<Array<{ runId: string }>>(list)).data?.map(
        (job) => job.runId,
      ),
    ).toEqual(["kept"]);

    const stream = await fetch(`${h.api}/council-api/runs/kept/events`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(await stream.text()).toContain('"status":"completed"');

    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await fetch(`${h.api}/dev-api/forge-run/review`, {
        method,
        headers: h.headers(h.hearth.token),
      });
      expect({ method, status: response.status }).toEqual({
        method,
        status: 405,
      });
    }
  }, 20_000);

  test("a table path asked with a method no handler serves is 405 with Allow; the section 6 actions that are not mounted are not there", async () => {
    const { h, probes } = await probed();
    const wrongMethod = await fetch(`${h.api}/council/runs`, {
      headers: h.headers(),
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect((await envelope(wrongMethod)).ok).toBe(false);

    const posted = await post(h, "/runs", {});
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");

    const unmounted = [
      "/beads",
      "/beads/demo-1/claim",
      "/beads/demo-1/close",
      "/beads/demo-1/comment",
      "/queue/demo-1/approve",
      "/queue/demo-1/queue",
      "/queue/demo-1/pause",
      "/queue/demo-1/resume",
      "/queue/demo-1/reassign",
      "/shifts",
      "/shifts/shift-1/stop",
      "/runs/demo/replan",
    ];
    for (const path of unmounted) {
      const response = await post(h, path, {});
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect((await envelope(response)).ok).toBe(false);
    }
    expect(h.events()).toEqual([]);
    expect(probes).toEqual([]);
  });
});

describe("request bounds", () => {
  test("a body over the row's cap, and an id shaped like a secret, are 400 and write nothing", async () => {
    const { h, probes } = await probed();
    // Valid in every other respect: only its size can be the reason it is refused.
    const big = await post(h, "/dev-api/forge-run/review", {
      ...REVIEW,
      padding: "x".repeat(20_000),
    });
    expect(big.status).toBe(400);
    expect((await envelope(big)).error).toContain("exceeds");

    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    for (const [path, body] of [
      ["/council/runs", { ...text("ok-run"), beadId: secret }],
      ["/council/runs", text(secret)],
      ["/dev-api/forge-run/review", { ...REVIEW, issueId: secret }],
    ] as const) {
      const response = await post(h, path, body);
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
      expect(JSON.stringify(await response.json())).not.toContain(secret);
    }
    expect(h.events()).toEqual([]);
    expect(probes).toEqual([]);
  });
});
