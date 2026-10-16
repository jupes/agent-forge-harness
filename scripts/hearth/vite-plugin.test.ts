import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  connect,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import type { LiveStatus } from "../../docs/js/app-state";
import {
  createStreamClient,
  fetchTransport,
  type StreamClient,
} from "../../docs/js/use-stream";
import type { OperatorEnvelope, StreamSnapshot } from "../../types/hearth";
import { HEARTH_PLUGIN } from "../dashboard/dashboard-url";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { dashboardRecordPath, tokenPath } from "./home";
import { readDashboardRecord, sessionCookieName } from "./launch";
import { loopbackProxyVariable } from "./loopback";
import {
  API_PREFIX,
  LAUNCH_ROUTE,
  NO_SESSION_ERROR,
  OPERATOR_HEADER,
  TOKEN_ROUTE,
} from "./paths";
import { createHearth } from "./server";
import {
  cookiePair,
  dashboardSession,
  exchangeLaunch,
  openEventStream,
  startTestHearth,
} from "./testing";
import {
  guardRequest,
  HEARTH_PLUGIN_NAME,
  type HearthPluginApi,
  hearthPlugin,
} from "./vite-plugin";

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

/**
 * The time limit of a test that builds a fixture: a hearth and a Vite server,
 * both in this process. The first fixture in the file takes about 0.2 s on its
 * own, and 7.6 to 10.3 s while 32 busy-looping processes share this
 * 16-thread machine, past bun's 5 s default (wwj5).
 */
const FIXTURE_TIMEOUT_MS = 30_000;

interface Fixture {
  vite: ViteDevServer;
  /** The dashboard's origin: what a browser on it would send as `Origin`. */
  url: string;
  /** The hearth's operator token. */
  token: string;
  /** The hearth's ledger file. */
  ledger: string;
  root: string;
  home: string;
  /** Present when the proxy was pointed at a relay to the hearth. */
  relay: Relay | null;
  /** The hearth plugin's `api`, as the dashboard's other plugins find it. */
  plugin: HearthPluginApi;
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
  let plugin: HearthPluginApi | null = null;
  const vite = await listeningVite(root, () => {
    const made = hearthPlugin(root, {
      home,
      supervisor: {
        ensure: async () => upstream,
        stopIfOwner: async () => {},
      },
    });
    plugin = made.api;
    return [rebuildStub(), made];
  });
  if (plugin === null) throw new Error("no hearth plugin was made");
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
    home,
    relay,
    plugin,
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

test(
  "proxies a read route through Vite to the hearth",
  async () => {
    const { url } = await fixture();
    const res = await fetch(`${url}/__agent-forge/dev-api/forge-run`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "starts a council run through the proxy with the operator token; a read of the run without the token is refused, and with it the finished run is read and its snapshot streamed",
  async () => {
    const { url, token } = await fixture();
    const api = `${url}/__agent-forge/council-api`;
    const start = (headers: Record<string, string>): Promise<Response> =>
      fetch(`${api}/runs`, {
        method: "POST",
        // Behind the proxy the hearth sees the dashboard's Host, so the
        // dashboard's origin is the one a request has to declare.
        headers: {
          "Content-Type": "application/json",
          Origin: url,
          ...headers,
        },
        body: JSON.stringify({
          sourceType: "text",
          source: "Evaluate this plan and record any missing evidence.",
          runId: "proxied-review",
        }),
      });
    expect((await start({})).status).toBe(403);
    const started = await start({ [OPERATOR_HEADER]: token });
    expect(started.status).toBe(202);
    // The stream is read once the run has finished: then it holds one snapshot
    // and ends. While a run is going, its stream sends the whole job again on
    // every event, 0.2 to 0.6 MB for this run. Read live through the proxy in
    // this process, under load, that stream stopped part way and never ended
    // in 26 of 1136 runs; read after the run had finished, in none of 396
    // (wwj5). The dashboard runs Vite under Node, in a process of its own.
    // Reading a stored run needs the operator token, through the proxy too.
    const read = { headers: { [OPERATOR_HEADER]: token } };
    expect((await fetch(`${api}/runs/proxied-review`)).status).toBe(403);
    let status = "running";
    for (let attempt = 0; attempt < 100 && status === "running"; attempt++) {
      const job = (await (
        await fetch(`${api}/runs/proxied-review`, read)
      ).json()) as OperatorEnvelope<{ status: string }>;
      status = job.data?.status ?? `no run: ${job.error}`;
      if (status === "running")
        await new Promise((done) => setTimeout(done, 100));
    }
    expect(status).toBe("completed");
    const stream = await fetch(`${api}/runs/proxied-review/events`, read);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const body = await stream.text();
    expect(body).toContain("event: snapshot");
    expect(body).toContain('"status":"completed"');
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "the hearth stream stays open through the proxy: a snapshot, then a delta as it happens",
  async () => {
    const { url, ledger, root } = await fixture();
    const client = await openEventStream(`${url}/__agent-forge/stream`, {
      Origin: url,
    });
    cleanup.push(async () => client.close());
    expect(client.response.status).toBe(200);
    expect(client.response.headers.get("content-type")).toBe(
      "text/event-stream",
    );

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
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "when the hearth's connections close mid-stream, the page's stream client behind the proxy leaves live within 2 s and shows an event written after the cut within 3 s",
  async () => {
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
  },
  FIXTURE_TIMEOUT_MS,
);

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

test(
  "refuses a foreign Origin through the proxy",
  async () => {
    const { url } = await fixture();
    const headers = { Origin: "https://evil.example" };
    expect(
      (await fetch(`${url}/__agent-forge/dev-api/forge-run`, { headers }))
        .status,
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
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "rebuild-pages is answered by Vite and never forwarded to the hearth",
  async () => {
    const { url } = await fixture();
    const res = await fetch(`${url}/__agent-forge/rebuild-pages`);
    expect(((await res.json()) as { via?: string }).via).toBe("vite");
  },
  FIXTURE_TIMEOUT_MS,
);

/**
 * A Vite server for `root`, listening on a port that was free a moment before.
 * Another process can take the port in between. Vite then retries on the same
 * server, and under bun that retry never settles: the fixture hung until the
 * test's limit (wwj5). With `strictPort` the taken port is refused at once,
 * and the server is built again on another port.
 */
async function listeningVite(
  root: string,
  plugins: () => Plugin[],
): Promise<ViteDevServer> {
  for (let attempt = 1; ; attempt++) {
    const vite = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: freePort(), strictPort: true },
      plugins: plugins(),
    });
    try {
      await vite.listen();
      return vite;
    } catch (error) {
      await vite.close();
      if (attempt === 5 || !String(error).includes("is already in use"))
        throw error;
    }
  }
}

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
 * origin and carries a dashboard session (the token route needs one): the
 * token route, three handlers older than the operator table, and one read row
 * of the table.
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

test(
  "through the proxy, a GET that sends Origin, Sec-Fetch-Site or Host twice, in either order or with one value twice, is refused by the guard on the token, health, dev-api, council-api and sessions paths, and is not served the token, a dashboard session notwithstanding",
  async () => {
    const { url, token } = await fixture();
    const cookie = `Cookie: ${await dashboardSession(url, token)}`;
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
      [
        "a foreign Host then the dashboard's",
        [foreignHost, host, origin, site],
      ],
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
        const answer = await rawGet(url, path, [...lines, cookie]);
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
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "through the proxy, a GET with Host, Origin and Sec-Fetch-Site each sent once and a dashboard session keeps its answer on the same paths, also when Accept is sent twice",
  async () => {
    const { url, token } = await fixture();
    const once = [
      `Host: ${new URL(url).host}`,
      `Origin: ${url}`,
      "Sec-Fetch-Site: same-origin",
      `Cookie: ${await dashboardSession(url, token)}`,
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
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "x1gs.3.31 through the proxy: a request declaring the dashboard's origin gets no token without a session (401); the launch flow's Set-Cookie names the API prefix and no Domain, so it stays on the dashboard's own host, and the token route answers a request that carries it",
  async () => {
    const { url, token, home, root } = await fixture();
    const ask = (cookie: string | null) =>
      fetch(`${url}${TOKEN_ROUTE}`, {
        headers: { Origin: url, ...(cookie ? { Cookie: cookie } : {}) },
      });
    const bare = await ask(null);
    const bareBody = await bare.text();
    expect({
      status: bare.status,
      error: (JSON.parse(bareBody) as { error: unknown }).error,
      token: bareBody.includes(token),
    }).toEqual({ status: 401, error: NO_SESSION_ERROR, token: false });

    const minted = await fetch(`${url}${LAUNCH_ROUTE}`, {
      method: "POST",
      headers: { [OPERATOR_HEADER]: token },
    });
    const secret = String(
      ((await minted.json()) as { data: { secret: unknown } }).data.secret,
    );
    const exchanged = await exchangeLaunch(url, secret);
    expect(exchanged.status).toBe(200);
    const name = sessionCookieName(home, root);
    const value = cookiePair(exchanged.setCookie).slice(name.length + 1);
    expect(exchanged.setCookie).toBe(
      `${name}=${value}; Path=/__agent-forge; HttpOnly; SameSite=Strict`,
    );
    const served = await ask(cookiePair(exchanged.setCookie));
    expect(served.status).toBe(200);
    expect(
      ((await served.json()) as { data: { token: string } }).data.token,
    ).toBe(token);
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "the hearth plugin's launchLink is the base it is given with a fresh secret in the fragment, which the session route exchanges once",
  async () => {
    const { url, plugin } = await fixture();
    const link = await plugin.launchLink("http://127.0.0.1:4321/");
    const match = /^http:\/\/127\.0\.0\.1:4321\/#launch=([0-9a-f]{64})$/.exec(
      link,
    );
    expect(match).not.toBeNull();
    const secret = match?.[1] ?? "";
    expect(await plugin.launchLink("http://127.0.0.1:4321/")).not.toBe(link);
    expect((await exchangeLaunch(url, secret)).status).toBe(200);
    expect((await exchangeLaunch(url, secret)).status).toBe(403);
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "x1gs.3.31: the hearth plugin's launchLink refuses a base that names localhost, or an address off this machine, before any secret is minted",
  async () => {
    const { plugin, ledger, root } = await fixture();
    const minted = (): number =>
      queryEvents(
        {
          workspace: resolveCheckout(root).workspace,
          kinds: ["operator.action"],
        },
        { path: ledger },
      ).length;
    const before = minted();
    for (const base of [
      "http://localhost:4321/",
      "http://192.168.1.20:4321/",
    ]) {
      const refused = await plugin
        .launchLink(base)
        .catch((error: unknown) => error);
      expect({ base, refused: String(refused) }).toEqual({
        base,
        refused: expect.stringContaining("never a name that resolves"),
      });
    }
    expect(minted()).toBe(before);
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "the hearth plugin's launchLink rejects, saying so, when the token file cannot be read, and before the dashboard has started its control plane",
  async () => {
    const { plugin, home, root } = await fixture();
    rmSync(tokenPath(home, root), { force: true });
    const missing = await plugin
      .launchLink("http://127.0.0.1:4321/")
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(Error);
    expect(String(missing)).toContain("token file could not be read");
    const early = await hearthPlugin(root, { home })
      .api.launchLink("http://127.0.0.1:4321/")
      .catch((error: unknown) => error);
    expect(String(early)).toContain("has not started its control plane");
  },
  FIXTURE_TIMEOUT_MS,
);

test(
  "a listening dashboard records where it listens for dashboard:open (the address it bound, 127.0.0.1, and its port, its pid and root) and removes the record when it closes",
  async () => {
    const { vite, url, home, root } = await fixture();
    const record = dashboardRecordPath(home, root);
    expect(readDashboardRecord(record)).toEqual({
      pid: process.pid,
      root: resolve(root),
      url: `http://127.0.0.1:${new URL(url).port}/`,
    });
    await vite.close();
    expect(existsSync(record)).toBe(false);
  },
  FIXTURE_TIMEOUT_MS,
);

test("the print plugin finds the hearth plugin by the name it has", () => {
  expect(hearthPlugin("/r", { home: "/h" }).name).toBe(HEARTH_PLUGIN_NAME);
  expect(HEARTH_PLUGIN).toBe(HEARTH_PLUGIN_NAME);
});

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

// ── A page that gives a request up, and the dashboard under Node ────────────

/**
 * A stand-in for a hearth that hangs: on a loopback port, it accepts each
 * connection, reads nothing and never answers. It keeps every connection and
 * notes each one's close.
 */
async function hungUpstream(): Promise<{
  port: number;
  sockets: Socket[];
  closed: Set<Socket>;
}> {
  const sockets: Socket[] = [];
  const closed = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.push(socket);
    socket.once("close", () => closed.add(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  );
  return { port: address.port, sockets, closed };
}

/** `node`, which the dashboard runs under in use; the tests that need it are skipped without it. */
const NODE = Bun.which("node");
/** Whether that `node` reads proxy settings from the environment (`NODE_USE_ENV_PROXY`). */
const NODE_USES_ENV_PROXY =
  NODE !== null &&
  Bun.spawnSync([NODE, "--help"]).stdout.toString().includes("--use-env-proxy");

/** This process's environment without any proxy setting. */
function withoutProxies(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !/proxy/i.test(name)) env[name] = value;
  return env;
}

/**
 * The dashboard's proxy as it runs in use: a Vite dev server under Node, in a
 * child process with exactly `env`, with `hearthPlugin` attached to
 * `upstream`. Vite loads the config file with its own bundler, as it loads
 * `vite.dashboard.config.ts`. When `env.PROBE` names a URL, the child asks
 * for it once before the server listens, with `http.get` through
 * `http.globalAgent`: the agent that follows `HTTP_PROXY` under
 * `NODE_USE_ENV_PROXY`, and the one the proxy must never be given.
 */
async function nodeDashboard(
  upstream: number,
  env: Record<string, string>,
): Promise<string> {
  if (!NODE) throw new Error("node is not on PATH");
  const slash = (path: string): string => path.replaceAll("\\", "/");
  const root = mkdtempSync(join(tmpdir(), "af-node-dashboard-"));
  mkdirSync(join(root, ".git"));
  const config = join(root, "dashboard.config.ts");
  const plugin = slash(resolve(import.meta.dir, "vite-plugin.ts"));
  writeFileSync(
    config,
    [
      `import { hearthPlugin } from ${JSON.stringify(plugin)};`,
      "export default {",
      `  root: ${JSON.stringify(slash(root))},`,
      '  logLevel: "silent",',
      `  plugins: [hearthPlugin(${JSON.stringify(slash(root))}, { home: ${JSON.stringify(slash(root))}, supervisor: { ensure: async () => ${upstream}, stopIfOwner: async () => {} } })],`,
      "};",
    ].join("\n"),
  );
  const vite = pathToFileURL(
    join(
      dirname(Bun.resolveSync("vite/package.json", import.meta.dir)),
      "dist",
      "node",
      "index.js",
    ),
  ).href;
  const port = freePort();
  const script = [
    `const { createServer } = await import(${JSON.stringify(vite)});`,
    `const server = await createServer({ configFile: ${JSON.stringify(slash(config))}, server: { host: "127.0.0.1", port: ${port}, strictPort: true } });`,
    'if (process.env.PROBE) { const http = await import("node:http"); await new Promise((done) => http.get(process.env.PROBE, { agent: http.globalAgent }, (res) => { res.resume(); res.on("end", done); }).on("error", done)); }',
    "await server.listen();",
    'process.stdout.write("listening\\n");',
    "process.stdin.resume();",
    'process.stdin.on("end", () => server.close().then(() => process.exit(0)));',
  ].join("\n");
  const child = Bun.spawn([NODE, "--input-type=module", "-e", script], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(async () => {
    child.stdin.end();
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const reader = child.stdout.getReader();
  let said = "";
  const deadline = performance.now() + 30_000;
  while (!said.includes("listening")) {
    if (performance.now() > deadline)
      throw new Error("the dashboard under node did not listen within 30 s");
    const { value, done } = await reader.read();
    if (done)
      throw new Error(
        `the dashboard under node exited: ${await new Response(child.stderr).text()}`,
      );
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return `http://127.0.0.1:${port}`;
}

/** Ask for a stream through the dashboard at `url`, then give it up before any answer. */
async function askAndGiveUp(
  url: string,
  upstream: { sockets: Socket[] },
): Promise<void> {
  const controller = new AbortController();
  const asked = fetch(`${url}${API_PREFIX}/stream`, {
    headers: { Origin: url },
    signal: controller.signal,
  }).catch(() => undefined);
  await eventually(
    "the proxy reaches the hearth",
    () => upstream.sockets.length === 1,
    10_000,
  );
  controller.abort();
  await asked;
}

// Run under Node only. Under Bun's `node:http` (Vite in this process), a client
// that left before any answer had been written raised no event on the request,
// the response or the socket within 1.5 s; the socket's `close` came only when
// the server closed (measured on Windows, Bun 1.3.10). The proxy cannot tell
// there. The dashboard runs Vite under Node.
test.skipIf(!NODE)(
  "a request the page gives up before the hearth answers closes the proxy's connection to the hearth within 1 s (the dashboard under Node, in a child process)",
  async () => {
    const upstream = await hungUpstream();
    const url = await nodeDashboard(upstream.port, withoutProxies());
    await askAndGiveUp(url, upstream);
    await eventually(
      "the proxy's connection to the hearth closes",
      () => upstream.closed.size === 1,
      1000,
    );
  },
  60_000,
);

// ── A stream opens for the page at once ─────────────────────────────────────

/** "within 1 s", or what was measured instead: the time in ms, or "never". */
function withinOneSecond(opened: number | "never"): string {
  if (opened === "never") return "not open within 3 s";
  return opened < 1000 ? "within 1 s" : `${Math.round(opened)} ms`;
}

/**
 * How long, through the dashboard at `url`, a resumed stream takes to open
 * for the page's own transport (`fetchTransport`): from the request to its
 * answer. A first open gives the cursor to resume from. "never" when it has
 * not opened within 3 s.
 */
async function resumeOpensAfter(url: string): Promise<number | "never"> {
  const first = await openEventStream(`${url}${API_PREFIX}/stream`, {
    Origin: url,
  });
  const snapshot = await first.next(10_000);
  first.close();
  const { cursor } = JSON.parse(snapshot?.data ?? "{}") as StreamSnapshot;
  const asked = performance.now();
  let connection: { close(): void } | null = null;
  const opened = new Promise<number>((done, fail) => {
    connection = fetchTransport(`${url}${API_PREFIX}/stream`, {
      headers: { Origin: url },
    })(cursor, {
      onOpen: () => done(performance.now() - asked),
      onActivity: () => undefined,
      onMessage: () => undefined,
      onEnd: (outcome) => fail(new Error(`the stream ended (${outcome})`)),
    });
  });
  try {
    return await Promise.race([
      opened,
      new Promise<"never">((done) => setTimeout(() => done("never"), 3000)),
    ]);
  } finally {
    (connection as { close(): void } | null)?.close();
  }
}

test(
  "through the proxy, a resumed stream opens for the page within 1 s, long before its first keepalive (Vite in process, under Bun)",
  async () => {
    const { url } = await fixture();
    const opened = await resumeOpensAfter(url);
    expect(withinOneSecond(opened)).toBe("within 1 s");
  },
  FIXTURE_TIMEOUT_MS,
);

test.skipIf(!NODE)(
  "through the dashboard under Node, a resumed stream opens for the page within 1 s, long before its first keepalive (Vite in a child process, the hearth in this one)",
  async () => {
    const hearth = await startTestHearth();
    cleanup.push(() => hearth.close());
    const url = await nodeDashboard(
      Number(new URL(hearth.hearth.url).port),
      withoutProxies(),
    );
    const opened = await resumeOpensAfter(url);
    expect(withinOneSecond(opened)).toBe("within 1 s");
  },
  60_000,
);

// ── The dashboard and HTTP_PROXY ────────────────────────────────────────────

/** A stand-in hearth: answers every request with one envelope and notes what was asked, with the operator token it carried. */
async function recordingHearth(): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createHttpServer((req, res) => {
    seen.push(
      `${req.method} ${req.url} ${req.headers[OPERATOR_HEADER] ?? "-"}`,
    );
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, data: "the hearth", error: null }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { port: address.port, seen };
}

/** A stand-in HTTP proxy: notes the first line of everything sent to it, and refuses it. */
async function recordingProxy(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", (chunk: Buffer) => {
      seen.push(chunk.toString("latin1").split("\r\n")[0] ?? "");
      socket.end(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

test.skipIf(!NODE_USES_ENV_PROXY)(
  "under NODE_USE_ENV_PROXY=1 with HTTP_PROXY set and no NO_PROXY, the dashboard under Node sends a page's request to the hearth directly, operator token included, and nothing of it to the proxy; in that process a request through http.globalAgent does go to the proxy",
  async () => {
    const hearth = await recordingHearth();
    const probe = await recordingHearth();
    const proxy = await recordingProxy();
    const env = {
      ...withoutProxies(),
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: proxy.url,
      PROBE: `http://127.0.0.1:${probe.port}/probe`,
    };
    // The measured rule says Node takes this proxy for 127.0.0.1 here.
    expect(loopbackProxyVariable(env, "node")).toBe("HTTP_PROXY");
    const url = await nodeDashboard(hearth.port, env);

    const answer = await fetch(`${url}${API_PREFIX}/sessions`, {
      headers: { Origin: url, [OPERATOR_HEADER]: "token-under-test" },
    });
    expect(await answer.json()).toEqual({
      ok: true,
      data: "the hearth",
      error: null,
    });
    expect(hearth.seen).toEqual([
      `GET ${API_PREFIX}/sessions token-under-test`,
    ]);
    // The control: the child's request for the probe through
    // http.globalAgent went to the proxy, so the environment was in effect
    // for that agent there. Nothing else reached the proxy.
    expect(probe.seen).toEqual([]);
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toContain(`127.0.0.1:${probe.port}`);
  },
  60_000,
);
