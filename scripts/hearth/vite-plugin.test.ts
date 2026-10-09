import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import type { StreamSnapshot } from "../../types/hearth";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { resolveCheckout } from "../ledger/workspace";
import { OPERATOR_HEADER } from "./paths";
import { createHearth } from "./server";
import { openEventStream } from "./testing";
import { guardRequest, hearthPlugin } from "./vite-plugin";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Stands in for `rebuildPagesApiPlugin`, which lives in the dashboard config. */
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

interface Fixture {
  vite: ViteDevServer;
  /** The dashboard's origin: what a browser on it would send as `Origin`. */
  url: string;
  /** The hearth's operator token. */
  token: string;
  /** The hearth's ledger file. */
  ledger: string;
  root: string;
}

async function fixture(): Promise<Fixture> {
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
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      rebuildStub(),
      hearthPlugin(root, {
        home,
        supervisor: {
          ensure: async () => hearth.port,
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
  };
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

function fakeRequest(remoteAddress: string, url: string): IncomingMessage {
  return { url, socket: { remoteAddress } } as unknown as IncomingMessage;
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
