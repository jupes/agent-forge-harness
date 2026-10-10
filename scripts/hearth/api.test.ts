import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type {
  EventsPage,
  LedgerEvent,
  LedgerEventInput,
  LedgerEventOf,
  OperatorEnvelope,
  QueueEntry,
  Reservation,
  RunDetail,
  SessionSummary,
  SmithsView,
} from "../../types/hearth";
import { type LoadedConfig, loadConfig } from "../config/load";
import { type AppendResult, appendEvent } from "../ledger/append";
import { setSessionModel } from "../ledger/session-models";
import type { ActionRoute, ApiRoute } from "./api";
import { tokenPath } from "./home";
import { OPERATOR_HEADER, SURFACE_HEADER } from "./paths";
import type { BdResult } from "./routes/dev-api";
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
  /** The effect itself, not its status: what the valid request must have changed. */
  happened(h: TestHearth, answer: unknown): Promise<void>;
}

interface Job {
  runId: string;
  status: string;
}

/** A council run that is still going when the next request arrives. */
async function runningRun(h: TestHearth, runId: string): Promise<void> {
  const started = await post(h, "/council/runs", text(runId));
  if (started.status !== 202) throw new Error(`could not start ${runId}`);
}

async function runStatus(h: TestHearth, runId: string): Promise<string> {
  const response = await fetch(`${h.api}/council-api/runs/${runId}`);
  return ((await response.json()) as { data?: Job }).data?.status ?? "";
}

/** The start really started a run: the service reports it as running or completed. */
const started =
  (runId: string) =>
  async (h: TestHearth): Promise<void> => {
    expect(["running", "completed"]).toContain(await runStatus(h, runId));
  };

/** The cancel really cancelled: the run was still going, and it ends cancelled, not completed. */
const cancelled =
  (runId: string) =>
  async (h: TestHearth, answer: unknown): Promise<void> => {
    expect(["cancelling", "cancelled"]).toContain((answer as Job).status);
    await councilRunFinished(h, runId);
    expect(await runStatus(h, runId)).toBe("cancelled");
  };

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
    happened: started("fixture-a"),
  },
  "POST /council/runs/:id/cancel": {
    prepare: (h) => runningRun(h, "to-cancel-a"),
    happened: cancelled("to-cancel-a"),
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
    happened: started("fixture-b"),
  },
  "POST /council-api/runs/:id/cancel": {
    prepare: (h) => runningRun(h, "to-cancel-b"),
    happened: cancelled("to-cancel-b"),
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
    // The review reached Beads through the hearth's own runner: the status
    // check, then the comment, each as an argument array.
    happened: async (h) => {
      expect(h.bd.calls.slice(-2)).toEqual([
        ["show", "demo-1", "--json"],
        [
          "comments",
          "add",
          "demo-1",
          "review: checkpoint APPROVED via Forge run dashboard",
        ],
      ]);
    },
  },
};

/** A concrete path per read row; a row with none fails the suite. */
const READS: Record<string, string> = {
  "GET /sessions": "/sessions",
  "GET /runs": "/runs",
  "GET /runs/:slug": "/runs/demo",
  "GET /events": "/events",
  "GET /queue": "/queue",
  "GET /reservations": "/reservations",
  "GET /smiths": "/smiths",
  "GET /config": "/config",
};

function fixture(route: ApiRoute): ActionFixture {
  const found = ACTIONS[key(route)];
  if (!found) throw new Error(`no fixture for action row ${key(route)}`);
  return found;
}

interface Probe {
  row: string;
  /** What the validator handed the effect. */
  input: unknown;
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
                  probes.push({ row: key(route), input, audit: audit() });
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
    // One stream, and nothing in the table of a kind this suite does not cover.
    expect(rows.filter((route) => route.kind === "stream").map(key)).toEqual([
      "GET /stream",
    ]);
    expect(rows.length).toBe(
      Object.keys(ACTIONS).length + Object.keys(READS).length + 1,
    );
  });
});

describe("every action row (iterating the table)", () => {
  test("with the token, from the hearth's own origin: one operator.action is appended, then the effect runs", async () => {
    const { h, probes } = await probed();
    for (const row of actionRows(h)) {
      const { valid, prepare, happened } = fixture(row);
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

      await happened(h, body.data);
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
      "answers ok with no row id",
      // justification: a result the ledger's type does not allow; the runner must not trust the shape.
      () => ({ ok: true, id: undefined, ulid: "x" }) as unknown as AppendResult,
    ],
    [
      "answers ok as a word, not as true",
      // justification: as above.
      () => ({ ok: "true", id: 1, ulid: "x" }) as unknown as AppendResult,
    ],
    [
      "answers ok with an id that is no row id",
      () => ({ ok: true, id: Number.NaN, ulid: "x" }),
    ],
    ["answers ok with a negative id", () => ({ ok: true, id: -1, ulid: "x" })],
    [
      "answers nothing at all",
      // justification: as above — a broken appender, not a typed one.
      () => null as unknown as AppendResult,
    ],
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
  return rawRequest(
    h,
    [
      `${method} /__agent-forge${path} HTTP/1.1`,
      ...headerLines,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
}

/** Send exactly these bytes, and read the status line and the body of the answer. */
function rawRequest(
  h: TestHearth,
  bytes: string,
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const socket = connect(h.hearth.port, "127.0.0.1", () => {
      socket.write(bytes);
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

    // The same body with no Content-Length (chunked): the cap is then found
    // while reading, and the answer must still be the 400 envelope.
    const payload = JSON.stringify({ ...REVIEW, padding: "x".repeat(20_000) });
    const chunks: string[] = [];
    for (let at = 0; at < payload.length; at += 4096) {
      const part = payload.slice(at, at + 4096);
      chunks.push(`${part.length.toString(16)}\r\n${part}\r\n`);
    }
    const chunked = await rawRequest(
      h,
      [
        "POST /__agent-forge/dev-api/forge-run/review HTTP/1.1",
        `Host: 127.0.0.1:${h.hearth.port}`,
        `Origin: ${h.hearth.url}`,
        "Content-Type: application/json",
        `X-Agent-Forge-Operator: ${h.hearth.token}`,
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        `${chunks.join("")}0\r\n\r\n`,
      ].join("\r\n"),
    );
    expect(chunked.status).toBe(400);
    expect(JSON.parse(chunked.body)).toMatchObject({
      ok: false,
      data: null,
      error: expect.stringContaining("exceeds"),
    });

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

function get(
  h: TestHearth,
  path: string,
  headers: Record<string, string> = h.headers(),
): Promise<Response> {
  return fetch(`${h.api}${path}`, { headers });
}

/** Append to the hearth's ledger under another workspace: what a second checkout on this machine would write. */
function appendElsewhere(
  h: TestHearth,
  event: Omit<LedgerEventInput, "workspace">,
): void {
  // justification: the caller's kind and payload stay paired; only the workspace is added.
  const stored = appendEvent(
    { ...event, workspace: "c:/work/another-checkout" } as LedgerEventInput,
    { path: h.ledger },
  );
  if (!stored.ok) throw new Error(stored.error);
}

const TOOL = { tool: "Bash", argsHash: "sha256:ab12" };

describe("every read row (iterating the table)", () => {
  test("answers a valid envelope for its fixture path", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    const rows = h.hearth.routes.filter((route) => route.kind === "read");
    if (rows.length === 0) throw new Error("the table has no read rows");
    for (const row of rows) {
      const path = READS[key(row)];
      if (path === undefined)
        throw new Error(`no fixture for read row ${key(row)}`);
      const response = await get(h, path);
      const body = await envelope(response);
      expect({ row: key(row), status: response.status, ok: body.ok }).toEqual({
        row: key(row),
        status: 200,
        ok: true,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("refuses a request that does not declare the hearth's own origin, and appends nothing", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    const rows = h.hearth.routes.filter((route) => route.kind === "read");
    if (rows.length === 0) throw new Error("the table has no read rows");
    const refused: Array<[string, Record<string, string>]> = [
      ["no declaration at all", {}],
      ["a foreign Origin", { Origin: "https://evil.example" }],
      ["another loopback port as Origin", { Origin: "http://127.0.0.1:1" }],
      ["Sec-Fetch-Site: same-site", { "Sec-Fetch-Site": "same-site" }],
      ["Sec-Fetch-Site: cross-site", { "Sec-Fetch-Site": "cross-site" }],
    ];
    for (const row of rows) {
      const path = READS[key(row)] ?? "";
      for (const [label, headers] of refused) {
        const response = await get(h, path, headers);
        expect({ row: key(row), label, status: response.status }).toEqual({
          row: key(row),
          label,
          status: 403,
        });
        expect((await envelope(response)).ok).toBe(false);
      }
      // A browser on the same origin sends no Origin on a GET; its fetch metadata is the declaration.
      const browser = await get(h, path, { "Sec-Fetch-Site": "same-origin" });
      expect({ row: key(row), status: browser.status }).toEqual({
        row: key(row),
        status: 200,
      });
    }
    expect(h.events()).toEqual([]);
    expect(h.bd.calls.every((args) => args[0] === "list")).toBe(true);
  });
});

describe("reads over the ledger and run state", () => {
  test("/sessions and /reservations return what the ledger holds for this workspace, and nothing from another", async () => {
    const h = await start();
    h.append({
      kind: "session.started",
      sessionId: "s-1",
      payload: { kind: "interactive", worktree: "trees/a" },
    });
    h.append({
      kind: "tool.called",
      sessionId: "s-1",
      beadId: "b-1",
      payload: TOOL,
    });
    h.append({ kind: "session.started", sessionId: "s-2", payload: {} });
    h.append({ kind: "session.ended", sessionId: "s-2", payload: {} });
    h.append({
      kind: "reservation.acquired",
      beadId: "b-1",
      sessionId: "s-1",
      payload: { worktree: "trees/a", globs: ["scripts/**"] },
    });
    appendElsewhere(h, {
      kind: "session.started",
      sessionId: "other",
      payload: {},
    });
    appendElsewhere(h, {
      kind: "reservation.acquired",
      beadId: "b-9",
      payload: { worktree: "trees/z", globs: ["**"] },
    });

    const sessions = await envelope<SessionSummary[]>(
      await get(h, "/sessions"),
    );
    expect(sessions.data?.map((session) => session.sessionId)).toEqual([
      "s-1",
      "s-2",
    ]);
    expect(sessions.data?.[0]).toMatchObject({
      workspace: h.workspace,
      kind: "interactive",
      worktree: "trees/a",
      beadId: "b-1",
    });
    expect(sessions.data?.[1]).toHaveProperty("endedAt");

    const openOnly = await envelope<SessionSummary[]>(
      await get(h, "/sessions?open=1&limit=5"),
    );
    expect(openOnly.data?.map((session) => session.sessionId)).toEqual(["s-1"]);
    const one = await envelope<SessionSummary[]>(
      await get(h, "/sessions?limit=1"),
    );
    expect(one.data?.map((session) => session.sessionId)).toEqual(["s-1"]);

    const reservations = await envelope<Reservation[]>(
      await get(h, "/reservations"),
    );
    expect(reservations.data).toEqual([
      {
        beadId: "b-1",
        worktree: "trees/a",
        workspace: h.workspace,
        globs: ["scripts/**"],
        sessionId: "s-1",
        acquiredAt: expect.any(String),
      },
    ]);

    for (const bad of [
      "/sessions?limit=0",
      "/sessions?limit=501",
      "/sessions?limit=ten",
      "/sessions?open=yes",
      "/sessions?active=1",
      "/sessions?limit=1&limit=2",
      "/reservations?bead=b-1",
    ]) {
      const response = await get(h, bad);
      expect({ bad, status: response.status }).toEqual({ bad, status: 400 });
      expect((await envelope(response)).ok).toBe(false);
    }
  });

  test("/events applies each filter and pages by `after`; events of another workspace never appear", async () => {
    const h = await start();
    const first = h.append({
      kind: "tool.called",
      sessionId: "s-1",
      beadId: "b-1",
      runId: "r-1",
      ts: "2026-10-01T10:00:00.000Z",
      payload: TOOL,
    });
    h.append({
      kind: "gate.ran",
      sessionId: "s-1",
      ts: "2026-10-02T10:00:00.000Z",
      payload: { gate: "typecheck", passed: true },
    });
    h.append({
      kind: "tool.called",
      sessionId: "s-2",
      beadId: "b-2",
      ts: "2026-10-03T10:00:00.000Z",
      payload: TOOL,
    });
    appendElsewhere(h, {
      kind: "tool.called",
      sessionId: "s-1",
      beadId: "b-1",
      runId: "r-1",
      payload: TOOL,
    });
    const last = h.append({
      kind: "gate.ran",
      runId: "r-1",
      ts: "2026-10-04T10:00:00.000Z",
      payload: { gate: "lint", passed: false },
    });
    const [a, b, c, d] = [first, first + 1, first + 2, last];

    const ids = async (query: string): Promise<number[]> => {
      const response = await get(h, `/events${query}`);
      const body = await envelope<EventsPage>(response);
      if (!body.ok) throw new Error(`${query}: ${body.error}`);
      expect(
        body.data.events.every((event) => event.workspace === h.workspace),
      ).toBe(true);
      return body.data.events.map((event) => event.id);
    };
    expect(await ids("")).toEqual([a, b, c, d]);
    expect(await ids("?kind=gate.ran")).toEqual([b, d]);
    expect(await ids("?kind=gate.ran,tool.called")).toEqual([a, b, c, d]);
    expect(await ids("?run=r-1")).toEqual([a, d]);
    expect(await ids("?session=s-2")).toEqual([c]);
    // A bead brings the other events of a session that touched it; beadExact does not.
    expect(await ids("?bead=b-1")).toEqual([a, b]);
    expect(await ids("?bead=b-1&beadExact=1")).toEqual([a]);
    expect(await ids("?since=2026-10-03T00:00:00Z")).toEqual([c, d]);
    expect(await ids("?kind=tool.called&session=s-1")).toEqual([a]);

    const tail = await envelope<EventsPage>(await get(h, "/events?limit=2"));
    expect(tail.data).toMatchObject({ cursor: d, more: true });
    expect(tail.data?.events.map((event) => event.id)).toEqual([c, d]);

    const page = await envelope<EventsPage>(
      await get(h, `/events?after=${a}&limit=2`),
    );
    expect(page.data).toMatchObject({ cursor: c, more: true });
    expect(page.data?.events.map((event) => event.id)).toEqual([b, c]);
    const rest = await envelope<EventsPage>(
      await get(h, `/events?after=${c}&limit=2`),
    );
    expect(rest.data).toMatchObject({ cursor: d, more: false });
    // An empty page keeps the cursor it was given, so a poller does not go backwards.
    const empty = await envelope<EventsPage>(
      await get(h, `/events?after=${d}`),
    );
    expect(empty.data).toEqual({ events: [], cursor: d, more: false });
    expect(
      (await envelope<EventsPage>(await get(h, "/events?kind=shift.started")))
        .data,
    ).toEqual({ events: [], cursor: 0, more: false });
  });

  test("/events refuses anything outside its filters, and the ledger commands the audit CLI also has", async () => {
    const h = await start();
    h.append({ kind: "tool.called", payload: TOOL });
    const long = "x".repeat(201);
    const refused = [
      "?kinds=gate.ran",
      "?kind=gate.ran&kind=tool.called",
      "?backup=1",
      "?compact=1",
      "?all-workspaces=1",
      "?allWorkspaces=1",
      "?workspace=c:/work/another-checkout",
      "?bead=--backup",
      "?run=--compact",
      "?session=--all-workspaces",
      "?kind=not.a.kind",
      "?kind=",
      "?since=yesterday",
      "?since=2026-13-45T00:00:00Z",
      "?limit=0",
      "?limit=1001",
      "?limit=ten",
      "?limit=-1",
      "?after=-1",
      "?after=1.5",
      `?after=${"9".repeat(400)}`,
      "?bead=",
      `?bead=${long}`,
      `?run=${long}`,
      `?session=${long}`,
      "?beadExact=1",
      "?bead=b-1&beadExact=yes",
    ];
    for (const query of refused) {
      const response = await get(h, `/events${query}`);
      const body = await envelope(response);
      expect({ query, status: response.status, ok: body.ok }).toEqual({
        query,
        status: 400,
        ok: false,
      });
    }
    // Nothing was backed up, compacted or widened: the one event is still the only thing there.
    expect(h.events().length).toBe(1);
    expect(existsSync(join(h.home, "backups"))).toBe(false);
  });

  test("/runs/:slug returns the run, its state and its newest events; unknown is 404, not a slug is 400", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    const entered = h.append({
      kind: "run.phase.entered",
      runId: "demo",
      payload: { phase: "research" },
    });
    h.append({
      kind: "run.phase.entered",
      runId: "another",
      payload: { phase: "plan" },
    });
    // Another checkout on this machine has a run of the same name.
    appendElsewhere(h, {
      kind: "run.phase.entered",
      runId: "demo",
      payload: { phase: "ship" },
    });

    const response = await get(h, "/runs/demo");
    expect(response.status).toBe(200);
    const body = await envelope<RunDetail>(response);
    expect(body.data?.run).toMatchObject({
      slug: "demo",
      phase: "research",
      next: "plan",
      complete: false,
    });
    expect(body.data?.state).toMatchObject({
      slug: "demo",
      feature: "Demo run",
      completed: ["research"],
    });
    expect(body.data?.events).toMatchObject({ cursor: entered, more: false });
    expect(body.data?.events.events.map((event) => event.id)).toEqual([
      entered,
    ]);

    const unknown = await get(h, "/runs/never-ran");
    expect(unknown.status).toBe(404);
    expect((await envelope(unknown)).ok).toBe(false);

    for (const bad of [
      "/runs/has%20space",
      `/runs/${"a".repeat(81)}`,
      "/runs/-leading-dash",
      "/runs/demo?verbose=1",
      "/runs/%E0%A4%A",
    ]) {
      const refused = await get(h, bad);
      expect({ bad, status: refused.status }).toEqual({ bad, status: 400 });
      expect((await envelope(refused)).ok).toBe(false);
    }
  });

  test("/runs/:slug bounds the events it returns", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    for (let i = 0; i < 205; i++)
      h.append({
        kind: "gate.ran",
        runId: "demo",
        payload: { gate: "typecheck", passed: true },
      });
    const body = await envelope<RunDetail>(await get(h, "/runs/demo"));
    expect(body.data?.events.events.length).toBe(200);
    expect(body.data?.events.more).toBe(true);
  });
});

const QUEUE_ARGS = [
  "list",
  "--readonly",
  "--flat",
  "--json",
  "--all",
  "--limit",
  "0",
  "--label-any",
  "queue:proposed,queue:approved,queue:queued,queue:running,queue:review,queue:done,queue:paused,queue:halted",
];

const BD_ISSUES = [
  {
    id: "b-1",
    title: "One",
    status: "open",
    priority: 2,
    issue_type: "task",
    labels: ["queue:approved", "command-center"],
  },
  {
    id: "b-2",
    title: "Two",
    status: "closed",
    priority: 1,
    issue_type: "bug",
    labels: ["queue:done"],
  },
  {
    id: "b-3",
    title: "Both",
    status: "in_progress",
    labels: ["queue:paused", "queue:running"],
  },
  // What a bd that ignores the label filter hands back: none of these is in the queue.
  { id: "b-4", title: "No queue label", status: "open", labels: ["privacy"] },
  {
    id: "b-5",
    title: "Not a queue state",
    status: "open",
    labels: ["queue:teleported", "queue:"],
  },
  { id: "b-6", title: "No labels at all", status: "open" },
];

const listed = (issues: unknown): BdResult => ({
  status: 0,
  stdout: JSON.stringify(issues),
  stderr: "",
});

describe("/queue", () => {
  test("asks bd with one fixed argument array, and returns one entry per queue label a bead carries", async () => {
    const h = await start();
    h.bd.list = listed(BD_ISSUES);
    const response = await get(h, "/queue");
    expect(response.status).toBe(200);
    expect((await envelope<QueueEntry[]>(response)).data).toEqual([
      {
        beadId: "b-1",
        title: "One",
        state: "approved",
        status: "open",
        priority: 2,
        type: "task",
      },
      {
        beadId: "b-2",
        title: "Two",
        state: "done",
        status: "closed",
        priority: 1,
        type: "bug",
      },
      { beadId: "b-3", title: "Both", state: "running", status: "in_progress" },
      { beadId: "b-3", title: "Both", state: "paused", status: "in_progress" },
    ]);
    expect(h.bd.calls).toEqual([QUEUE_ARGS]);
  });

  test("filters by state, and refuses a state or a parameter it does not know without calling bd", async () => {
    const h = await start();
    h.bd.list = listed(BD_ISSUES);
    const some = await envelope<QueueEntry[]>(
      await get(h, "/queue?state=running,done"),
    );
    expect(some.data?.map((entry) => [entry.beadId, entry.state])).toEqual([
      ["b-2", "done"],
      ["b-3", "running"],
    ]);
    // The request never changes what bd is asked.
    expect(h.bd.calls).toEqual([QUEUE_ARGS]);

    for (const bad of [
      "?state=teleported",
      "?state=",
      "?state=running&state=done",
      "?label=privacy",
      "?state=running,--all",
      "?limit=5",
    ]) {
      const response = await get(h, `/queue${bad}`);
      expect({ bad, status: response.status }).toEqual({ bad, status: 400 });
      expect((await envelope(response)).ok).toBe(false);
    }
    expect(h.bd.calls.length).toBe(1);
  });

  test("a bd failure, or output that is not a list of issues, is 502", async () => {
    const h = await start();
    const failures: Array<[string, BdResult]> = [
      [
        "a non-zero exit",
        { status: 1, stdout: "", stderr: "Error: database is locked\n" },
      ],
      [
        "a process that could not start",
        { status: null, stdout: "", stderr: "spawn bd ENOENT" },
      ],
      [
        "output that is not JSON",
        { status: 0, stdout: "no issues found", stderr: "" },
      ],
      [
        "JSON that is not a list",
        { status: 0, stdout: '{"issues":[]}', stderr: "" },
      ],
      [
        "a list of things that are not issues",
        { status: 0, stdout: '[1,"two",null]', stderr: "" },
      ],
    ];
    for (const [label, result] of failures) {
      h.bd.list = result;
      const response = await get(h, "/queue");
      const body = await envelope(response);
      expect({ label, status: response.status, ok: body.ok }).toEqual({
        label,
        status: 502,
        ok: false,
      });
    }
    h.bd.list = {
      status: 1,
      stdout: "",
      stderr: "Error: database is locked\n",
    };
    expect((await envelope(await get(h, "/queue"))).error).toContain(
      "database is locked",
    );
  });

  test("runs one bd at a time: a request that arrives during a read shares the next one, never an older answer", async () => {
    const h = await start();
    const waiting: Array<(result: BdResult) => void> = [];
    h.bd.list = () => new Promise<BdResult>((resolve) => waiting.push(resolve));
    const until = async (count: number): Promise<void> => {
      for (let i = 0; i < 200 && waiting.length < count; i++)
        await new Promise((done) => setTimeout(done, 5));
      if (waiting.length < count)
        throw new Error(
          `bd was started ${waiting.length} time(s), expected ${count}`,
        );
    };
    const ids = async (response: Promise<Response>): Promise<string[]> =>
      (await envelope<QueueEntry[]>(await response)).data?.map(
        (entry) => entry.beadId,
      ) ?? [];

    const first = get(h, "/queue");
    await until(1);
    // Both arrive while the first read is still running.
    const second = get(h, "/queue");
    const third = get(h, "/queue");
    await new Promise((done) => setTimeout(done, 50));
    expect(waiting.length).toBe(1);

    waiting[0]?.(listed([BD_ISSUES[0]]));
    expect(await ids(first)).toEqual(["b-1"]);
    await until(2);
    waiting[1]?.(listed([BD_ISSUES[1]]));
    expect(await ids(second)).toEqual(["b-2"]);
    expect(await ids(third)).toEqual(["b-2"]);
    expect(h.bd.calls.length).toBe(2);
  });

  test("a bd that never answers is 502 within the timeout, and the next request starts a new one", async () => {
    const h = await start({ api: { bdTimeoutMs: 100 } });
    h.bd.list = () => new Promise<BdResult>(() => {});
    const began = performance.now();
    const response = await get(h, "/queue");
    expect(response.status).toBe(502);
    expect(performance.now() - began).toBeLessThan(2000);
    // The message names the limit bd was given, not the backstop a second after it.
    expect((await envelope(response)).error).toContain(
      "did not answer within its 100 ms limit",
    );

    h.bd.list = listed([BD_ISSUES[0]]);
    const next = await get(h, "/queue");
    expect(next.status).toBe(200);
    expect(h.bd.calls.length).toBe(2);
  });
});

describe("/smiths and /config", () => {
  const WORKSPACE_TOML = [
    "[workflow]",
    'default_crew = "claude-master"',
    "",
    "[smiths.claude-apprentice]",
    "enabled = false",
    "",
  ].join("\n");

  test("return what the config loader returns for the hearth's root, with provenance", async () => {
    const h = await start({ files: { "agent-forge.toml": WORKSPACE_TOML } });
    mkdirSync(join(h.configHome, ".agent-forge"), { recursive: true });
    writeFileSync(
      join(h.configHome, ".agent-forge", "config.toml"),
      '[smiths.claude-journeyman]\neffort = "high"\n',
    );
    const expected = loadConfig({
      harnessRoot: h.root,
      home: h.configHome,
      env: {},
    });

    const config = await envelope<LoadedConfig>(await get(h, "/config"));
    expect(config.data).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(config.data?.config.workflow.defaultCrew).toBe("claude-master");
    expect(config.data?.provenance["workflow.default_crew"]?.source).toBe(
      join(h.root, "agent-forge.toml"),
    );
    expect(
      config.data?.provenance["smiths.claude-journeyman.effort"]?.source,
    ).toBe(join(h.configHome, ".agent-forge", "config.toml"));
    expect(config.data?.provenance["smiths.claude-master.model"]?.source).toBe(
      "builtin",
    );
    expect(config.data?.files.length).toBe(2);

    const smiths = await envelope<SmithsView>(await get(h, "/smiths"));
    expect(smiths.data?.defaultSmith).toBe("claude-master");
    expect(smiths.data?.smiths).toEqual(Object.values(expected.config.smiths));
    expect(
      smiths.data?.smiths.find((smith) => smith.name === "claude-apprentice")
        ?.enabled,
    ).toBe(false);
    expect(
      smiths.data?.smiths.find((smith) => smith.name === "claude-journeyman")
        ?.effort,
    ).toBe("high");
    expect(smiths.data?.benches).toEqual(expected.config.benches);
  });

  test("do not read the hearth's own environment: AGENT_FORGE_SMITH there changes nothing", async () => {
    const before = process.env["AGENT_FORGE_SMITH"];
    process.env["AGENT_FORGE_SMITH"] = "claude-apprentice";
    try {
      const h = await start();
      const smiths = await envelope<SmithsView>(await get(h, "/smiths"));
      expect(smiths.data?.defaultSmith).toBe("claude-journeyman");
      const config = await envelope<LoadedConfig>(await get(h, "/config"));
      expect(config.data?.provenance["workflow.default_crew"]?.source).toBe(
        "builtin",
      );
      expect(config.data?.files).toEqual([]);
    } finally {
      if (before === undefined) delete process.env["AGENT_FORGE_SMITH"];
      else process.env["AGENT_FORGE_SMITH"] = before;
    }
  });

  test("a config file that cannot be loaded is an error envelope naming the file, on both routes", async () => {
    const h = await start({
      files: { "agent-forge.toml": '[workflow]\ndefault_crew = "nobody"\n' },
    });
    for (const path of ["/config", "/smiths"]) {
      const response = await get(h, path);
      const body = await envelope(response);
      expect({ path, status: response.status, ok: body.ok }).toEqual({
        path,
        status: 500,
        ok: false,
      });
      expect(body.error).toContain("agent-forge.toml");
      expect(body.error).toContain('unknown smith "nobody"');
    }
  });
});

describe("council runs started through the hearth", () => {
  /** The council events in the ledger, once the run has recorded its end. */
  async function councilEvents(
    h: TestHearth,
    runId: string,
  ): Promise<LedgerEvent[]> {
    const ofRun = (): LedgerEvent[] =>
      h
        .events(["council.run.started", "council.run.finished"])
        .filter(
          (event) =>
            (event.kind === "council.run.started" ||
              event.kind === "council.run.finished") &&
            event.payload.councilRunId === runId,
        );
    for (
      let i = 0;
      i < 400 &&
      !ofRun().some((event) => event.kind === "council.run.finished");
      i++
    )
      await new Promise((done) => setTimeout(done, 25));
    return ofRun();
  }

  test("a hearth given a council ledger records the start and the end, for the bead the request names and nobody it did not", async () => {
    // What a session-attached emitter would pick up: an agent's mirror file in
    // the checkout, and a bead and run in the environment. None of it belongs
    // to a run the operator started from the dashboard.
    const before = {
      bead: process.env["AGENT_FORGE_BEAD_ID"],
      run: process.env["FORGE_SLUG"],
    };
    process.env["AGENT_FORGE_BEAD_ID"] = "bead-from-the-environment";
    process.env["FORGE_SLUG"] = "run-from-the-environment";
    try {
      const h = await start({
        councilRuns: true,
        files: { ".agent-forge-session": "agent-session-in-this-checkout\n" },
      });
      setSessionModel(
        {
          sessionId: "agent-session-in-this-checkout",
          provider: "claude",
          model: "claude-opus-5-5",
        },
        { path: h.ledger },
      );

      const named = await post(h, "/council/runs", {
        ...text("with-bead"),
        beadId: "demo-7",
      });
      expect(named.status).toBe(202);
      const withBead = await councilEvents(h, "with-bead");
      const unnamed = await post(h, "/council-api/runs", text("no-bead"));
      expect(unnamed.status).toBe(202);
      const noBead = await councilEvents(h, "no-bead");

      expect(withBead.map((event) => event.kind)).toEqual([
        "council.run.started",
        "council.run.finished",
      ]);
      expect(noBead.map((event) => event.kind)).toEqual([
        "council.run.started",
        "council.run.finished",
      ]);
      for (const event of withBead) {
        expect(event.workspace).toBe(h.workspace);
        expect(event.beadId).toBe("demo-7");
      }
      for (const event of [...withBead, ...noBead]) {
        expect(event).not.toHaveProperty("sessionId");
        expect(event).not.toHaveProperty("executor");
        expect(event).not.toHaveProperty("runId");
      }
      for (const event of noBead) expect(event).not.toHaveProperty("beadId");
      expect(withBead[1]?.payload).toMatchObject({
        councilRunId: "with-bead",
        outcome: expect.any(String),
      });

      // The audit row names the same run, carries the same bead, and comes first.
      const audit = h.events(["operator.action"]);
      expect(audit.map((event) => [event.payload, event.beadId])).toEqual([
        [
          { action: "council.run.start", surface: "api", target: "with-bead" },
          "demo-7",
        ],
        [
          { action: "council.run.start", surface: "api", target: "no-bead" },
          undefined,
        ],
      ]);
      expect(audit[0]?.id).toBeLessThan(withBead[0]?.id ?? 0);
      expect(audit[1]?.id).toBeLessThan(noBead[0]?.id ?? 0);
    } finally {
      for (const [name, value] of [
        ["AGENT_FORGE_BEAD_ID", before.bead],
        ["FORGE_SLUG", before.run],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 30_000);

  test("a hearth given none (the default) records the operator's action and no council event", async () => {
    const h = await start();
    const response = await post(h, "/council/runs", {
      ...text("unrecorded"),
      beadId: "demo-7",
    });
    expect(response.status).toBe(202);
    await councilRunFinished(h, "unrecorded");
    await new Promise((done) => setTimeout(done, 100));
    expect(h.events().map((event) => event.kind)).toEqual(["operator.action"]);
  }, 20_000);

  test("a run id the caller did not give is minted before the audit row, so the row names the run that starts", async () => {
    const h = await start({ councilRuns: true });
    const response = await post(h, "/council/runs", {
      sourceType: "text",
      source: "Evaluate this plan and record any missing evidence.",
    });
    expect(response.status).toBe(202);
    const job = (await envelope<{ runId: string }>(response)).data;
    expect(job?.runId).toMatch(/^council-\d+-[0-9a-f]{8}$/);
    const [audit] = h.events(["operator.action"]);
    expect(audit?.payload).toMatchObject({ target: job?.runId });
    const events = await councilEvents(h, job?.runId ?? "");
    expect(events[0]?.payload).toMatchObject({ councilRunId: job?.runId });
  }, 20_000);
});

describe("what travels from a request into an effect", () => {
  test("a council start hands the service only the fields it knows, whatever else the body holds", async () => {
    const { h, probes } = await probed();
    const response = await fetch(`${h.api}/council/runs`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      // Written out, so `__proto__` is a key of the JSON and not a prototype.
      body: `{"sourceType":"text","source":"Evaluate this.","runId":"only-known","beadId":"demo-7","maxUsd":1,"extra":"nope","nested":{"a":1},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
    });
    expect(response.status).toBe(202);
    const input = probes.at(-1)?.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      "beadId",
      "maxUsd",
      "runId",
      "source",
      "sourceType",
    ]);
    expect(input).toEqual({
      sourceType: "text",
      source: "Evaluate this.",
      runId: "only-known",
      beadId: "demo-7",
      maxUsd: 1,
    });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    await councilRunFinished(h, "only-known");
  }, 20_000);

  test("the queue read gives bd its own time limit; the review's calls keep the runner's", async () => {
    const h = await start({ api: { bdTimeoutMs: 1234 } });
    expect((await get(h, "/queue")).status).toBe(200);
    expect((await post(h, "/dev-api/forge-run/review", REVIEW)).status).toBe(
      200,
    );
    expect(h.bd.calls.map((args) => args[0])).toEqual([
      "list",
      "show",
      "comments",
    ]);
    expect(h.bd.options).toEqual([{ timeoutMs: 1234 }, undefined, undefined]);
  });
});

describe("a bead as the source of a council run started through the hearth", () => {
  /**
   * A hearth whose council start effect only records what it is handed: a bead
   * source would otherwise read the tracker, which no test here may do.
   */
  async function recording(): Promise<{ h: TestHearth; handed: unknown[] }> {
    const handed: unknown[] = [];
    const h = await start({
      api: {
        decorate: (routes) =>
          routes.map((route) =>
            route.kind === "action" && route.action === "council.run.start"
              ? {
                  ...route,
                  effect: (input: unknown) => {
                    handed.push(input);
                    return { status: 202, data: { accepted: true } };
                  },
                }
              : route,
          ),
      },
    });
    return { h, handed };
  }

  test("an id that is not one, an id shaped like a secret, and a beadId that is not exactly the bead under review are refused before anything is recorded or started", async () => {
    const { h, handed } = await recording();
    const refused: Array<[Record<string, unknown>, string]> = [
      [
        { sourceType: "bead", source: "not a bead id" },
        "source must be a Beads issue id when the source is a bead",
      ],
      [
        { sourceType: "bead", source: "--help" },
        "source must be a Beads issue id when the source is a bead",
      ],
      ...["demo-8", " demo-7 ", "demo-7\n", "DEMO-7", "demo-7.1", "demo"].map(
        (beadId): [Record<string, unknown>, string] => [
          { sourceType: "bead", source: "demo-7", beadId },
          "beadId must name the bead under review when the source is a bead",
        ],
      ),
      [
        // Twenty characters shaped like an access key id are a valid id by form.
        { sourceType: "bead", source: ["AKIA", "ZQ9ZQ8ZQ7ZQ6ZQ5Z"].join("") },
        "beadId must be a Beads issue id",
      ],
    ];
    for (const [body, message] of refused) {
      const response = await post(h, "/council/runs", body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect((await envelope(response)).error).toBe(message);
    }
    expect(handed).toEqual([]);
    expect(h.events()).toEqual([]);
  });

  test("an accepted bead source is audited against its bead and handed to the route's effect with it, whether or not the caller repeated the id or wrote space around it", async () => {
    const { h, handed } = await recording();
    for (const [runId, body] of [
      ["bead-plain", { sourceType: "bead", source: "demo-7" }],
      [
        "bead-named",
        { sourceType: "bead", source: "demo-7", beadId: "demo-7" },
      ],
      ["bead-spaced", { sourceType: "bead", source: " demo-7\n" }],
    ] as const) {
      const response = await post(h, "/council-api/runs", { ...body, runId });
      expect({ runId, status: response.status }).toEqual({
        runId,
        status: 202,
      });
    }
    expect(handed).toEqual([
      {
        sourceType: "bead",
        source: "demo-7",
        runId: "bead-plain",
        beadId: "demo-7",
      },
      {
        sourceType: "bead",
        source: "demo-7",
        runId: "bead-named",
        beadId: "demo-7",
      },
      {
        sourceType: "bead",
        source: " demo-7\n",
        runId: "bead-spaced",
        beadId: "demo-7",
      },
    ]);
    const audits = h.events(["operator.action"]);
    expect(audits.map((event) => [event.payload, event.beadId])).toEqual([
      [
        expect.objectContaining({
          action: "council.run.start",
          target: "bead-plain",
        }),
        "demo-7",
      ],
      [
        expect.objectContaining({
          action: "council.run.start",
          target: "bead-named",
        }),
        "demo-7",
      ],
      [
        expect.objectContaining({
          action: "council.run.start",
          target: "bead-spaced",
        }),
        "demo-7",
      ],
    ]);
  });
});
