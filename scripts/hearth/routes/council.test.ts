import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeCouncilTransport } from "../../council/fake-transport";
import {
  applyCouncilJobDelta,
  type CouncilJobDelta,
} from "../../council/job-delta";
import {
  type CouncilServiceJob,
  createCouncilService,
} from "../../council/service";
import type { ModelTransport } from "../../council/types";
import { OPERATOR_HEADER } from "../paths";
import {
  openEventStream,
  type StreamClient,
  type StreamMessage,
} from "../testing";
import { COUNCIL_API, councilHttpHandler } from "./council";

/** The operator token the handler under test honours. */
const TOKEN = "7".repeat(64);
const WITH_TOKEN = { [OPERATOR_HEADER]: TOKEN };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(
  options: {
    /** Every model call waits until the run is cancelled, so a run stays `running`. */
    slow?: boolean;
    /** Every model call waits for `release()`; `blocked` settles at the first one. */
    gated?: boolean;
    keepaliveMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "council-http-"));
  let release = () => {};
  const open = new Promise<void>((done) => {
    release = done;
  });
  let reached = () => {};
  const blocked = new Promise<void>((done) => {
    reached = done;
  });
  const simulated = new FakeCouncilTransport();
  const gated: ModelTransport = {
    async generate(request, signal) {
      reached();
      await open;
      return simulated.generate(request, signal);
    },
  };
  const service = createCouncilService({
    workspaceRoot: root,
    harnessRoot: resolve(import.meta.dir, "../../.."),
    runsRoot: join(root, "runs"),
    ...(options.slow
      ? {
          resolveTransport: () => () =>
            new FakeCouncilTransport({ delayMs: 60_000 }),
        }
      : options.gated
        ? { resolveTransport: () => () => gated }
        : {}),
  });
  // The handler is handed the service with its subscriptions counted: taken
  // and not yet released, and snapshots the service handed to their listeners.
  let subscriptions = 0;
  let deliveries = 0;
  const counted: typeof service = {
    ...service,
    subscribe(runId, listener) {
      const unsubscribe = service.subscribe(runId, (job) => {
        deliveries++;
        listener(job);
      });
      subscriptions++;
      let held = true;
      return () => {
        if (held) subscriptions--;
        held = false;
        unsubscribe();
      };
    },
  };
  const handler = councilHttpHandler(counted, {
    keepaliveMs: options.keepaliveMs,
    expectedToken: () => TOKEN,
  });
  const writes: Array<{ mock: { calls: unknown[] } }> = [];
  const server: Server = createServer((req, res) => {
    writes.push(spyOn(res, "write"));
    void handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test server address");
  const url = `http://127.0.0.1:${address.port}${COUNCIL_API}`;
  cleanup.push(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    url,
    port: address.port,
    release: () => release(),
    blocked,
    subscriptions: () => subscriptions,
    deliveries: () => deliveries,
    /** Calls to `write` on every response this server has given. */
    writes: () => writes.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
  };
}

/** Open a run's event stream with the operator token; the test's cleanup closes it. */
async function events(url: string, runId: string): Promise<StreamClient> {
  const client = await openEventStream(
    `${url}/runs/${runId}/events`,
    WITH_TOKEN,
  );
  cleanup.push(async () => client.close());
  return client;
}

function statusOf(message: StreamMessage | null): string {
  if (message?.event !== "snapshot")
    throw new Error(`expected a snapshot, got ${message?.event ?? "the end"}`);
  return (JSON.parse(message.data) as { status: string }).status;
}

/** Read up to the next keepalive comment; answers the statuses of the snapshots before it. */
async function untilKeepalive(client: StreamClient): Promise<string[]> {
  const statuses: string[] = [];
  for (;;) {
    const message = await client.next();
    if (message?.event === "comment") {
      expect(message.data).toBe("keepalive");
      return statuses;
    }
    statuses.push(statusOf(message));
  }
}

/** Wait up to a second for `check` to hold; the caller asserts it. */
const settled = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++)
    await new Promise((done) => setTimeout(done, 10));
};

async function envelope(response: Response): Promise<{
  ok: boolean;
  data: Record<string, unknown>;
  error: string | null;
}> {
  try {
    return await response.json();
  } catch {
    throw new Error("HTTP response is not a JSON envelope");
  }
}

test("the handler lists, streams and replays a council run it did not start", async () => {
  const { service, url } = await fixture();
  const profiles = await envelope(await fetch(`${url}/profiles`));
  expect(profiles.ok).toBe(true);
  expect(Array.isArray(profiles.data)).toBe(true);
  // Starting a run is an operator action (scripts/hearth/api.test.ts posts it
  // through a hearth); here the service starts it and the handler only reads.
  service.start({
    sourceType: "text",
    source: "Evaluate this plan and record any missing evidence.",
    runId: "http-review",
  });
  const finished = await service.wait("http-review");
  expect(finished.status).toBe("completed");
  const read = { headers: WITH_TOKEN };
  const stream = await fetch(`${url}/runs/http-review/events`, read);
  const events = await stream.text();
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  expect(events.match(/event: snapshot/g)).toHaveLength(1);
  expect(events).toContain('"status":"completed"');
  const replay = await envelope(await fetch(`${url}/runs/http-review`, read));
  expect(replay.data.run).toEqual(finished.run);
  const list = await envelope(await fetch(`${url}/runs`, read));
  expect(Array.isArray(list.data)).toBe(true);
}, 10000);

/** A GET with exactly these header lines, over a raw socket: fetch folds a repeated header into one line. */
function rawGet(port: number, path: string, lines: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1");
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk.toString("utf8");
    });
    socket.on("end", () => done(answer));
    socket.on("error", fail);
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
        ...lines,
        "",
        "",
      ].join("\r\n"),
    );
  });
}

test("a stored run, the run list and a run's event stream answer only a request that carries the operator token once: without it, with a wrong one or with it twice, 403 and nothing of any run", async () => {
  const h = await fixture();
  h.service.start({
    sourceType: "text",
    source: "Private acceptance criterion: the widget never leaks its key.",
    runId: "private-run",
  });
  expect((await h.service.wait("private-run")).status).toBe("completed");

  const refusal = {
    ok: false,
    data: null,
    error:
      "Reading a stored council run needs the operator token of this control plane",
  };
  const paths = [
    "/runs",
    "/runs/private-run",
    "/runs/private-run/events",
    // An id no run has is refused the same way: the refusal says nothing of what is stored.
    "/runs/no-such-run",
    "/runs/no-such-run/events",
  ];
  const tries: Array<[string, Record<string, string>]> = [
    ["no token", {}],
    // A declared same-origin request is not enough.
    ["the hearth's own origin and no token", { Origin: new URL(h.url).origin }],
    ["a wrong token", { [OPERATOR_HEADER]: "0".repeat(64) }],
  ];
  for (const path of paths) {
    for (const [label, headers] of tries) {
      const response = await fetch(`${h.url}${path}`, { headers });
      const body = await response.text();
      expect({
        path,
        label,
        status: response.status,
        type: response.headers.get("content-type"),
        body: JSON.parse(body),
      }).toEqual({
        path,
        label,
        status: 403,
        type: "application/json; charset=utf-8",
        body: refusal,
      });
    }
    const twice = await rawGet(h.port, `${COUNCIL_API}${path}`, [
      `X-Agent-Forge-Operator: ${TOKEN}`,
      `X-Agent-Forge-Operator: ${TOKEN}`,
    ]);
    expect({ path, head: twice.split("\r\n")[0] }).toEqual({
      path,
      head: "HTTP/1.1 403 Forbidden",
    });
    expect(twice).not.toContain("widget");
  }
  // Nothing was subscribed for a refused stream.
  expect(h.subscriptions()).toBe(0);

  // With the token, the run is answered, evidence included.
  const run = await fetch(`${h.url}/runs/private-run`, {
    headers: WITH_TOKEN,
  });
  expect(run.status).toBe(200);
  expect(await run.text()).toContain("the widget never leaks its key");
  // The profiles hold no run and still need no token.
  expect((await fetch(`${h.url}/profiles`)).status).toBe(200);
}, 10000);

test("while no token can be honoured, a request carrying one is refused too", async () => {
  const root = mkdtempSync(join(tmpdir(), "council-http-"));
  const service = createCouncilService({
    workspaceRoot: root,
    harnessRoot: resolve(import.meta.dir, "../../.."),
    runsRoot: join(root, "runs"),
  });
  const handler = councilHttpHandler(service, { expectedToken: () => null });
  const server: Server = createServer((req, res) => {
    void handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(async () => {
    await service.close();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}${COUNCIL_API}/runs`, {
    headers: WITH_TOKEN,
  });
  expect(response.status).toBe(403);
});

test("mounted alone, the handler performs no mutation for any POST", async () => {
  const { service, url } = await fixture();
  const json = { "Content-Type": "application/json" };
  const started = await fetch(`${url}/runs`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      sourceType: "text",
      source: "This must not start a run.",
      runId: "never",
    }),
  });
  expect(started.status).toBe(404);
  expect(service.list()).toEqual([]);

  service.start({ sourceType: "text", source: "Leave me be.", runId: "kept" });
  const cancelled = await fetch(`${url}/runs/kept/cancel`, {
    method: "POST",
    headers: json,
    body: "{}",
  });
  expect(cancelled.status).toBe(405);
  expect((await service.wait("kept")).status).toBe("completed");
}, 10000);

test("local dashboard refuses cross-origin requests and other methods", async () => {
  const { url } = await fixture();
  expect(
    (
      await fetch(`${url}/profiles`, {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/profiles`, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${url}/profiles`, { headers: { Host: "attacker.example" } }))
      .status,
  ).toBe(403);
  expect(
    (await fetch(`${url}/runs/missing`, { method: "DELETE" })).status,
  ).toBe(405);
});

test("a client that leaves while the run is still going: its subscription is released and nothing more is written for it, keepalives included", async () => {
  const h = await fixture({ slow: true, keepaliveMs: 20 });
  h.service.start({
    sourceType: "text",
    source: "Hold this review open.",
    runId: "left-mid-run",
  });
  const client = await events(h.url, "left-mid-run");
  expect((await untilKeepalive(client))[0]).toBe("running");
  expect(h.subscriptions()).toBe(1);

  client.close();
  await settled(() => h.subscriptions() === 0);
  expect(h.subscriptions()).toBe(0);
  const written = h.writes();
  // Ten keepalive intervals.
  await new Promise((done) => setTimeout(done, 200));
  expect(h.writes()).toBe(written);
  expect(h.service.get("left-mid-run").status).toBe("running");

  // A cancel hands its snapshot to every listener the run still has.
  const delivered = h.deliveries();
  h.service.cancel("left-mid-run");
  expect(h.deliveries()).toBe(delivered);
  expect(h.writes()).toBe(written);
}, 10000);

test("a client that stays through the run keeps getting keepalives and snapshots; its stream ends when the run does and its subscription is released", async () => {
  const h = await fixture({ slow: true, keepaliveMs: 20 });
  h.service.start({
    sourceType: "text",
    source: "Hold this review open.",
    runId: "stayed",
  });
  const client = await events(h.url, "stayed");
  expect((await untilKeepalive(client))[0]).toBe("running");
  await untilKeepalive(client);
  expect(h.subscriptions()).toBe(1);

  h.service.cancel("stayed");
  const statuses: string[] = [];
  for (
    let message = await client.next();
    message !== null;
    message = await client.next()
  )
    if (message.event !== "comment") statuses.push(statusOf(message));
  expect(statuses).toContain("cancelling");
  expect(statuses.at(-1)).toBe("cancelled");
  await settled(() => h.subscriptions() === 0);
  expect(h.subscriptions()).toBe(0);
}, 10000);

/** The event and data of each message in a whole event-stream body; comments left out. */
function messagesOf(body: string): Array<{ event: string; data: string }> {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "" && !block.startsWith(":"))
    .map((block) => {
      const lines = block.split("\n");
      return {
        event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "",
        data: lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join(""),
      };
    });
}

test("with ?deltas=1 a client is sent the whole job once and then only what changed: it rebuilds every job a snapshot client is sent, each event comes once, and the stream is smaller", async () => {
  const h = await fixture({ gated: true });
  h.service.start({
    sourceType: "text",
    source: "Evaluate this plan and record any missing evidence.",
    runId: "deltas",
  });
  // Both subscribe while the run waits at its first model call, so both are sent the same updates.
  await h.blocked;
  const whole = fetch(`${h.url}/runs/deltas/events`, {
    headers: WITH_TOKEN,
  }).then((r) => r.text());
  const changes = fetch(`${h.url}/runs/deltas/events?deltas=1`, {
    headers: WITH_TOKEN,
  }).then((r) => r.text());
  await settled(() => h.subscriptions() === 2);
  expect(h.subscriptions()).toBe(2);
  h.release();
  const [wholeBody, changesBody] = await Promise.all([whole, changes]);

  const snapshots = messagesOf(wholeBody);
  expect(new Set(snapshots.map((message) => message.event))).toEqual(
    new Set(["snapshot"]),
  );
  const [first, ...rest] = messagesOf(changesBody);
  expect(first?.event).toBe("snapshot");
  expect(rest.length).toBeGreaterThan(0);
  expect(new Set(rest.map((message) => message.event))).toEqual(
    new Set(["delta"]),
  );

  let job = JSON.parse(first?.data ?? "") as CouncilServiceJob;
  let eventsSent = job.events.length;
  const rebuilt = [job];
  for (const message of rest) {
    const delta = JSON.parse(message.data) as CouncilJobDelta;
    eventsSent += delta.events.length;
    job = applyCouncilJobDelta(job, delta);
    rebuilt.push(job);
  }
  expect(rebuilt).toEqual(
    snapshots.map((message) => JSON.parse(message.data) as CouncilServiceJob),
  );
  expect(job.status).toBe("completed");
  expect(eventsSent).toBe(job.events.length);
  expect(Buffer.byteLength(changesBody)).toBeLessThan(
    Buffer.byteLength(wholeBody) / 2,
  );

  // A run that has finished is one snapshot either way.
  const replayed = messagesOf(
    await (
      await fetch(`${h.url}/runs/deltas/events?deltas=1`, {
        headers: WITH_TOKEN,
      })
    ).text(),
  );
  expect(replayed.map((message) => message.event)).toEqual(["snapshot"]);
}, 20000);
