import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
import {
  openEventStream,
  type StreamClient,
  type StreamMessage,
} from "../testing";
import { COUNCIL_API, councilHttpHandler } from "./council";

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
    release: () => release(),
    blocked,
    subscriptions: () => subscriptions,
    deliveries: () => deliveries,
    /** Calls to `write` on every response this server has given. */
    writes: () => writes.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
  };
}

/** Open a run's event stream; the test's cleanup closes it. */
async function events(url: string, runId: string): Promise<StreamClient> {
  const client = await openEventStream(`${url}/runs/${runId}/events`, {});
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
  const stream = await fetch(`${url}/runs/http-review/events`);
  const events = await stream.text();
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  expect(events.match(/event: snapshot/g)).toHaveLength(1);
  expect(events).toContain('"status":"completed"');
  const replay = await envelope(await fetch(`${url}/runs/http-review`));
  expect(replay.data.run).toEqual(finished.run);
  const list = await envelope(await fetch(`${url}/runs`));
  expect(Array.isArray(list.data)).toBe(true);
}, 10000);

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
  const whole = fetch(`${h.url}/runs/deltas/events`).then((r) => r.text());
  const changes = fetch(`${h.url}/runs/deltas/events?deltas=1`).then((r) =>
    r.text(),
  );
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
    await (await fetch(`${h.url}/runs/deltas/events?deltas=1`)).text(),
  );
  expect(replayed.map((message) => message.event)).toEqual(["snapshot"]);
}, 20000);
