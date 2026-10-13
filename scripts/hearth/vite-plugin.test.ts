import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  connect,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import type { LiveStatus } from "../../docs/js/app-state";
import {
  createStreamClient,
  fetchTransport,
  type StreamClient,
} from "../../docs/js/use-stream";
import type { OperatorEnvelope, StreamSnapshot } from "../../types/hearth";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { resolveCheckout } from "../ledger/workspace";
import { API_PREFIX, OPERATOR_HEADER } from "./paths";
import { createHearth } from "./server";
import { openEventStream } from "./testing";
import { guardRequest, hearthPlugin } from "./vite-plugin";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Stands in for `rebuildPagesPlugin` (`scripts/dashboard/rebuild-pages.ts`). */
function rebuildStub(): Plugin {
  return {
    name: "rebuild-stub",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== "/__agent-forge/rebuild-pages") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, via: "vite" }));
      });
    },
  };
}

/** A TCP relay standing between the dashboard's proxy and the hearth. */
interface Relay {
  port: number;
  /**
   * Close every connection through the relay at once. To the proxy this is
   * what a killed hearth looks like: its sockets close, mid-response for a
   * stream. New connections are still relayed, as to a hearth started again.
   */
  cut(): void;
  /** Cut, and stop listening: nothing answers on the port any more. */
  close(): Promise<void>;
}

async function relayTo(target: number): Promise<Relay> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // A cut connection's other end may still be writing; that is expected here.
    socket.on("error", () => undefined);
  };
  const server = createNetServer((inbound) => {
    const outbound = connect(target, "127.0.0.1");
    track(inbound);
    track(outbound);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const cut = (): void => {
    for (const socket of [...sockets]) socket.destroy();
  };
  let closed: Promise<void> | null = null;
  return {
    port: address.port,
    cut,
    close() {
      closed ??= new Promise<void>((done) => {
        server.close(() => done());
        cut();
      });
      return closed;
    },
  };
}

interface Fixture {
  vite: ViteDevServer;
  /** The dashboard's origin: what a browser on it would send as `Origin`. */
  url: string;
  /** The hearth's operator token. */
  token: string;
  /** The hearth's ledger file. */
  ledger: string;
  root: string;
  /** Present when the proxy was pointed at a relay to the hearth. */
  relay: Relay | null;
}

async function fixture(options: { relay?: boolean } = {}): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "af-vite-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-vite-root-"));
  // A planted .git makes the temp root its own workspace in the ledger.
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".tmp", "work"), { recursive: true });
  const ledger = join(home, "ledger.db");
  const hearth = await createHearth({
    root,
    home,
    harnessRoot: resolve(import.meta.dir, "../.."),
    environment: {},
    api: {
      ledgerPath: ledger,
      // Never the real bd, never the user's config.
      runBd: async () => ({ status: 0, stdout: "[]", stderr: "" }),
      configHome: home,
    },
  });
  if (hearth.kind !== "started") throw new Error("expected a fresh hearth");
  const relay = options.relay ? await relayTo(hearth.port) : null;
  const upstream = relay?.port ?? hearth.port;
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: freePort(), strictPort: false },
    plugins: [
      rebuildStub(),
      hearthPlugin(root, {
        home,
        supervisor: {
          ensure: async () => upstream,
          stopIfOwner: async () => {},
        },
      }),
    ],
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("no address");
  cleanup.push(async () => {
    await vite.close();
    await relay?.close();
    await hearth.close();
    closeLedger(ledger);
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    vite,
    url: `http://127.0.0.1:${address.port}`,
    token: hearth.token,
    ledger,
    root,
    relay,
  };
}

/** `fixture()` with the proxy pointed at a relay to the hearth. */
async function relayedFixture(): Promise<Fixture & { relay: Relay }> {
  const relayed = await fixture({ relay: true });
  if (!relayed.relay) throw new Error("expected a relay");
  return { ...relayed, relay: relayed.relay };
}

/** Wait, in real time, until `check` holds. */
async function eventually(
  what: string,
  check: () => boolean,
  withinMs: number,
): Promise<void> {
  const deadline = performance.now() + withinMs;
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error(`${what}: not within ${Math.round(withinMs)} ms`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/**
 * The page's own stream client (`docs/js/use-stream.ts`) on the real fetch
 * transport and real timers, reading through the dashboard at `url`. Every
 * status it takes is recorded with the time it was taken.
 */
function pageClient(url: string): {
  client: StreamClient;
  statuses: { status: LiveStatus; at: number }[];
} {
  const headers = { Origin: url };
  const client = createStreamClient({
    transport: fetchTransport(`${url}${API_PREFIX}/stream`, { headers }),
    read: async (path) =>
      (await (
        await fetch(`${url}${API_PREFIX}${path}`, { headers })
      ).json()) as OperatorEnvelope<unknown>,
    // Every retry waits its shortest, so the bounds below hold for any draw.
    random: () => 0,
  });
  const statuses: { status: LiveStatus; at: number }[] = [];
  const leave = client.subscribe(() => {
    const { status } = client.getState();
    if (statuses.at(-1)?.status !== status)
      statuses.push({ status, at: performance.now() });
  });
  cleanup.push(async () => leave());
  return { client, statuses };
}

test("proxies a read route through Vite to the hearth", async () => {
  const { url } = await fixture();
  const res = await fetch(`${url}/__agent-forge/dev-api/forge-run`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
});

test("starts a council run through the proxy with the operator token, and streams its snapshot", async () => {
  const { url, token } = await fixture();
  const api = `${url}/__agent-forge/council-api`;
  const start = (headers: Record<string, string>): Promise<Response> =>
    fetch(`${api}/runs`, {
      method: "POST",
      // Behind the proxy the hearth sees the dashboard's Host, so the
      // dashboard's origin is the one a request has to declare.
      headers: { "Content-Type": "application/json", Origin: url, ...headers },
      body: JSON.stringify({
        sourceType: "text",
        source: "Evaluate this plan and record any missing evidence.",
        runId: "proxied-review",
      }),
    });
  expect((await start({})).status).toBe(403);
  const started = await start({ [OPERATOR_HEADER]: token });
  expect(started.status).toBe(202);
  let body = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    const stream = await fetch(`${api}/runs/proxied-review/events`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    body = await stream.text();
    if (body.includes('"status":"completed"')) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  expect(body).toContain("event: snapshot");
  expect(body).toContain('"status":"completed"');
}, 20_000);

test("the hearth stream stays open through the proxy: a snapshot, then a delta as it happens", async () => {
  const { url, ledger, root } = await fixture();
  const client = await openEventStream(`${url}/__agent-forge/stream`, {
    Origin: url,
  });
  cleanup.push(async () => client.close());
  expect(client.response.status).toBe(200);
  expect(client.response.headers.get("content-type")).toBe("text/event-stream");

  // Read while the stream is open: a proxy that buffered would deliver nothing yet.
  const first = await client.next(5000);
  expect(first?.event).toBe("snapshot");
  const snapshot = JSON.parse(first?.data ?? "{}") as StreamSnapshot;
  expect(snapshot.queue).toEqual({ ok: true, data: [], error: null });

  const stored = appendEvent(
    {
      kind: "gate.ran",
      workspace: resolveCheckout(root).workspace,
      payload: { gate: "typecheck", passed: true },
    },
    { path: ledger },
  );
  if (!stored.ok || !("id" in stored)) throw new Error("event not stored");
  const appended = performance.now();
  const delta = await client.next(1000);
  expect(performance.now() - appended).toBeLessThan(1000);
  expect(delta).toMatchObject({ event: "delta", id: String(stored.id) });
  expect(stored.id).toBeGreaterThan(snapshot.cursor);
}, 20_000);

test("when the hearth's connections close mid-stream, the page's stream client behind the proxy leaves live within 2 s and shows an event written after the cut within 3 s", async () => {
  const { url, ledger, root, relay } = await relayedFixture();
  const { client, statuses } = pageClient(url);
  await eventually("live", () => client.getState().status === "live", 5000);

  relay.cut();
  const cutAt = performance.now();
  // Written while the page is cut off, so only a new connection can bring it.
  const stored = appendEvent(
    {
      kind: "gate.ran",
      workspace: resolveCheckout(root).workspace,
      payload: { gate: "typecheck", passed: true },
    },
    { path: ledger },
  );
  if (!stored.ok || !("id" in stored)) throw new Error("event not stored");

  await eventually(
    "the page leaves live",
    () => client.getState().status !== "live",
    2000,
  );
  const left = statuses.find(
    (entry) => entry.at >= cutAt && entry.status !== "live",
  );
  expect(left?.status).toBe("reconnecting");
  await eventually(
    "the event written after the cut is shown",
    () => (client.getState().cursor ?? 0) >= stored.id,
    3000 - (performance.now() - cutAt),
  );
  expect(client.getState().status).toBe("live");
}, 20_000);

test("when nothing answers for the hearth after its connections close, the page's stream client behind the proxy turns live updates off", async () => {
  const { url, relay } = await relayedFixture();
  const { client } = pageClient(url);
  await eventually("live", () => client.getState().status === "live", 5000);

  await relay.close();
  // Six failures in a row, the waits between them at their shortest: about 8 s.
  await eventually(
    "live updates off",
    () => client.getState().status === "off",
    15_000,
  );
  expect(client.getState().offReason).toBe("lost");
}, 30_000);

test("refuses a foreign Origin through the proxy", async () => {
  const { url } = await fixture();
  const headers = { Origin: "https://evil.example" };
  expect(
    (await fetch(`${url}/__agent-forge/dev-api/forge-run`, { headers })).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/__agent-forge/council-api/runs`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
});

test("rebuild-pages is answered by Vite and never forwarded to the hearth", async () => {
  const { url } = await fixture();
  const res = await fetch(`${url}/__agent-forge/rebuild-pages`);
  expect(((await res.json()) as { via?: string }).via).toBe("vite");
});

/**
 * A port nothing listened on a moment ago. Vite given port 0 starts at 5173,
 * where another run of this suite may already be.
 */
function freePort(): number {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = probe;
  probe.stop(true);
  return port;
}

/** The body of a raw HTTP/1.1 response, with a chunked body put back together. */
function responseBody(head: string, rest: string): string {
  if (!/^transfer-encoding:\s*chunked\s*$/im.test(head)) return rest;
  let body = "";
  let at = 0;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n", at);
    if (lineEnd < 0) return body;
    const size = Number.parseInt(rest.slice(at, lineEnd), 16);
    if (!(size > 0)) return body;
    body += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    at = lineEnd + 2 + size + 2;
  }
}

/**
 * A GET with exactly these header lines, over a raw socket to the dashboard:
 * `fetch` folds a repeated header into one line.
 */
async function rawGet(
  url: string,
  path: string,
  headerLines: string[],
): Promise<{ status: number; body: string }> {
  const request = [
    `GET ${path} HTTP/1.1`,
    ...headerLines,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  const received = await new Promise<string>((done, fail) => {
    let text = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port: Number(new URL(url).port),
      socket: {
        open(socket) {
          socket.write(request);
        },
        data(_socket, chunk) {
          text += chunk.toString("utf8");
        },
        close() {
          done(text);
        },
        error(_socket, error) {
          fail(error);
        },
      },
    }).catch(fail);
  });
  const split = received.indexOf("\r\n\r\n");
  const head = split < 0 ? received : received.slice(0, split);
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0),
    body: split < 0 ? "" : responseBody(head, received.slice(split + 4)),
  };
}

/**
 * Proxied paths and what each answers a GET that declares the dashboard's own
 * origin: the token route, three handlers older than the operator table, and
 * one read row of the table.
 */
const PROXIED_GETS: Array<[string, number]> = [
  ["/__agent-forge/token", 200],
  ["/__agent-forge/health", 200],
  ["/__agent-forge/dev-api/forge-run", 200],
  ["/__agent-forge/council-api/profiles", 200],
  ["/__agent-forge/sessions", 200],
];

/** What the guard answers a repeated Host, Origin or Sec-Fetch-Site with. */
const REPEAT_REFUSAL =
  "The control-plane APIs refuse a request that sends Host, Origin or Sec-Fetch-Site more than once";

test("through the proxy, a GET that sends Origin, Sec-Fetch-Site or Host twice, in either order or with one value twice, is refused by the guard on the token, health, dev-api, council-api and sessions paths, and is not served the token", async () => {
  const { url, token } = await fixture();
  const host = `Host: ${new URL(url).host}`;
  const origin = `Origin: ${url}`;
  const site = "Sec-Fetch-Site: same-origin";
  const foreignOrigin = "Origin: https://evil.example";
  const crossSite = "Sec-Fetch-Site: cross-site";
  const foreignHost = "Host: evil.example";
  const repeats: Array<[string, string[]]> = [
    [
      "a foreign Origin then the dashboard's",
      [host, foreignOrigin, origin, site],
    ],
    [
      "the dashboard's Origin then a foreign one",
      [host, origin, foreignOrigin, site],
    ],
    [
      "the dashboard's Origin twice, once in lower case",
      [host, origin, origin.replace("Origin", "origin"), site],
    ],
    ["cross-site then same-origin", [host, origin, crossSite, site]],
    ["same-origin then cross-site", [host, origin, site, crossSite]],
    ["same-origin twice", [host, origin, site, site]],
    ["a foreign Host then the dashboard's", [foreignHost, host, origin, site]],
    [
      "the dashboard's Host then a foreign one",
      [host, foreignHost, origin, site],
    ],
    ["the dashboard's Host twice", [host, host, origin, site]],
  ];
  const answers: unknown[] = [];
  const refusals: unknown[] = [];
  for (const [path] of PROXIED_GETS) {
    for (const [label, lines] of repeats) {
      const answer = await rawGet(url, path, lines);
      let error: unknown = null;
      try {
        error = (JSON.parse(answer.body) as { error: unknown }).error;
      } catch {
        error = `not JSON: ${answer.body.slice(0, 80)}`;
      }
      answers.push({
        path,
        label,
        status: answer.status,
        error,
        token: answer.body.includes(token),
      });
      refusals.push({
        path,
        label,
        status: 403,
        error: REPEAT_REFUSAL,
        token: false,
      });
    }
  }
  expect(answers).toEqual(refusals);
}, 20_000);

test("through the proxy, a GET with Host, Origin and Sec-Fetch-Site each sent once keeps its answer on the same paths, also when Accept is sent twice", async () => {
  const { url, token } = await fixture();
  const once = [
    `Host: ${new URL(url).host}`,
    `Origin: ${url}`,
    "Sec-Fetch-Site: same-origin",
  ];
  const variants: Array<[string, string[]]> = [
    ["each once", once],
    ["each once, Accept twice", [...once, "Accept: */*", "Accept: */*"]],
  ];
  const answers: unknown[] = [];
  const expected: unknown[] = [];
  for (const [path, answered] of PROXIED_GETS) {
    for (const [label, lines] of variants) {
      const answer = await rawGet(url, path, lines);
      answers.push({
        path,
        label,
        status: answer.status,
        token: answer.body.includes(token),
      });
      expected.push({
        path,
        label,
        status: answered,
        token: path === "/__agent-forge/token",
      });
    }
  }
  expect(answers).toEqual(expected);
}, 20_000);

function fakeRequest(
  remoteAddress: string,
  url: string,
  rawHeaders: string[] = [],
): IncomingMessage {
  return {
    url,
    rawHeaders,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; status: () => number } {
  let status = 200;
  const res = {
    get statusCode() {
      return status;
    },
    set statusCode(value: number) {
      status = value;
    },
    setHeader() {},
    end() {},
  } as unknown as ServerResponse;
  return { res, status: () => status };
}

test("the guard refuses a non-loopback client on API paths but not on other paths", () => {
  const api = fakeResponse();
  expect(
    guardRequest(
      fakeRequest("192.168.1.20", "/__agent-forge/dev-api/forge-run"),
      api.res,
    ),
  ).toBe(false);
  expect(api.status()).toBe(403);
  const other = fakeResponse();
  expect(
    guardRequest(fakeRequest("192.168.1.20", "/index.html"), other.res),
  ).toBe(true);
  const rebuild = fakeResponse();
  expect(
    guardRequest(
      fakeRequest("192.168.1.20", "/__agent-forge/rebuild-pages"),
      rebuild.res,
    ),
  ).toBe(true);
  const local = fakeResponse();
  expect(
    guardRequest(
      fakeRequest("::ffff:127.0.0.1", "/__agent-forge/dev-api/forge-run"),
      local.res,
    ),
  ).toBe(true);
});

test("the guard covers every path Vite would proxy, including a bare-prefix dot-segment path", () => {
  const sneaky = fakeResponse();
  expect(
    guardRequest(
      fakeRequest(
        "192.168.1.20",
        "/__agent-forgeX/../__agent-forge/council-api/profiles",
      ),
      sneaky.res,
    ),
  ).toBe(false);
  expect(sneaky.status()).toBe(403);
});

test("the guard counts Host, Origin and Sec-Fetch-Site in any letter case, as Node's rawHeaders keeps the sender's, and only on paths Vite would proxy", () => {
  const api = "/__agent-forge/dev-api/forge-run";
  const repeated: string[][] = [
    ["Origin", "https://evil.example", "origin", "http://127.0.0.1:8787"],
    ["SEC-FETCH-SITE", "cross-site", "Sec-Fetch-Site", "same-origin"],
    ["Host", "127.0.0.1:8787", "hOST", "evil.example"],
  ];
  for (const rawHeaders of repeated) {
    const refused = fakeResponse();
    expect(
      guardRequest(fakeRequest("127.0.0.1", api, rawHeaders), refused.res),
    ).toBe(false);
    expect(refused.status()).toBe(403);
    // Vite answers these itself; what it does with a repeat is not the guard's.
    for (const local of ["/index.html", "/__agent-forge/rebuild-pages"]) {
      const passed = fakeResponse();
      expect(
        guardRequest(fakeRequest("127.0.0.1", local, rawHeaders), passed.res),
      ).toBe(true);
    }
  }
  const once = fakeResponse();
  expect(
    guardRequest(
      fakeRequest("127.0.0.1", api, [
        "Host",
        "127.0.0.1:8787",
        "Origin",
        "http://127.0.0.1:8787",
        "Sec-Fetch-Site",
        "same-origin",
        "Accept",
        "*/*",
        "accept",
        "*/*",
      ]),
      once.res,
    ),
  ).toBe(true);
  expect(once.status()).toBe(200);
});
