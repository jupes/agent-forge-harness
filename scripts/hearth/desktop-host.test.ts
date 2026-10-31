import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeLedger } from "../ledger/db";
import { removeDirectory } from "../remove-directory";
import { parseDesktopArguments, runDesktopCleanup } from "./desktop-entry";
import { startDesktopHost } from "./desktop-host";
import { lockPath, tokenPath } from "./home";
import { readLock, updateLock } from "./lock";
import {
  API_PREFIX,
  OPERATOR_HEADER,
  SESSION_KEY_HEADER,
  SESSION_ROUTE,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "./paths";
import {
  deadProxyEnvironment,
  privateTempDir,
  startTestHearth,
} from "./testing";
import { readToken } from "./token";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

async function fixture(
  restart?: (
    hearth: Awaited<ReturnType<typeof startTestHearth>>,
  ) => Promise<import("./supervisor").RestartResult>,
) {
  const hearth = await startTestHearth();
  closes.push(() => hearth.close());
  const assetsRoot = mkdtempSync(join(hearth.root, "assets with spaces-"));
  writeFileSync(join(assetsRoot, "index.html"), "desktop shell");
  const host = await startDesktopHost({
    root: hearth.root,
    home: hearth.home,
    assetsRoot,
    supervisor: {
      ensure: async () => hearth.hearth.port,
      stopIfOwner: async () => {},
      ...(restart ? { restartIfOwner: () => restart(hearth) } : {}),
    },
  });
  closes.push(host.close);
  return { hearth, host, assetsRoot, origin: new URL(host.url).origin };
}

test("desktop restart is authenticated, validated, audited before effect, and returns a fresh same-origin launch", async () => {
  let restarts = 0;
  const { hearth, host, origin } = await fixture(async (running) => {
    expect(running.events(["operator.action"]).at(-1)?.payload).toMatchObject({
      action: "desktop.hearth.restart",
      surface: "ui",
    });
    restarts++;
    return { ok: true, port: running.hearth.port };
  });
  const path = `${origin}${API_PREFIX}/desktop/restart`;
  const headers = {
    Origin: origin,
    [OPERATOR_HEADER]: hearth.hearth.token,
    [SURFACE_HEADER]: "ui",
    "Content-Type": "application/json",
  };
  for (const [extra, body, status] of [
    [{ [OPERATOR_HEADER]: "wrong" }, {}, 403],
    [{ Origin: "http://127.0.0.1:1" }, {}, 403],
    [{}, { command: "anything" }, 400],
  ] as const) {
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: { ...headers, ...extra },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(status);
    expect(restarts).toBe(0);
  }
  const response = await fetch(path, { method: "POST", headers, body: "{}" });
  expect(response.status).toBe(200);
  const answer = await response.json();
  expect(answer.ok).toBe(true);
  expect(new URL(answer.data.url).origin).toBe(origin);
  expect(new URL(answer.data.url).hash).toMatch(/^#launch=[0-9a-f]{64}$/);
  expect(answer.data.url).not.toBe(host.url);
  expect(restarts).toBe(1);
});

test("a real desktop restart rotates the hearth token and session, including after automatic process replacement", async () => {
  const temp = privateTempDir("af-desktop-restart-");
  closes.push(async () => {
    closeLedger(join(temp, "home", "ledger.db"));
    removeDirectory(temp, { attempts: 21, delayMs: 50 });
  });
  const home = join(temp, "home");
  const root = join(temp, "checkout");
  const assetsRoot = join(temp, "assets");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "desktop fixture");
  const serverModule = pathToFileURL(
    resolve(import.meta.dir, "server.ts"),
  ).href;
  const source = `const {createHearth}=await import(${JSON.stringify(serverModule)}); await createHearth({root:process.argv[process.argv.indexOf('--root')+1],home:process.env.AGENT_FORGE_HOME,api:{configHome:process.env.AGENT_FORGE_HOME,runBd:async()=>({status:0,stdout:'[]',stderr:''})}});`;
  const host = await startDesktopHost({
    root,
    home,
    assetsRoot,
    hearthCommand: [process.execPath, "-e", source, "desktop-fixture"],
  });
  closes.push(host.close);
  const origin = new URL(host.url).origin;
  const exchange = async (link: string) => {
    const response = await fetch(`${origin}${SESSION_ROUTE}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "x-agent-forge-launch": new URL(link).hash.slice(8),
        [SURFACE_HEADER]: "ui",
      },
    });
    expect(response.status).toBe(200);
    return {
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
      key: (await response.json()).data.key,
    };
  };
  const session = await exchange(host.url);
  const tokenFile = tokenPath(home, root);
  const before = readToken(tokenFile);
  const restart = async () =>
    fetch(`${origin}${API_PREFIX}/desktop/restart`, {
      method: "POST",
      headers: {
        Origin: origin,
        [OPERATOR_HEADER]: readToken(tokenFile) ?? "",
        [SURFACE_HEADER]: "ui",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  const first = await restart();
  expect(first.status).toBe(200);
  const fresh = await exchange((await first.json()).data.url);
  expect(fresh).not.toEqual(session);
  expect(readToken(tokenFile)).not.toBe(before);
  const previous = readLock(lockPath(home, root));
  if (!previous || previous.pid === process.pid)
    throw new Error("No fixture-owned child hearth");
  process.kill(previous.pid);
  await new Promise((done) => setTimeout(done, 300));
  expect((await fetch(`${origin}${API_PREFIX}/health`)).status).toBe(200);
  expect(readLock(lockPath(home, root))?.pid).not.toBe(previous.pid);
  const second = await restart();
  expect(second.status).toBe(200);
  await second.body?.cancel();
}, 30_000);

test("serves fixed assets and carries launch/session/token/action traffic on one guarded origin", async () => {
  const { hearth, host, origin } = await fixture();
  const page = await fetch(`${origin}/`);
  expect(await page.text()).toBe("desktop shell");
  expect(page.headers.get("content-security-policy")).toContain(
    "default-src 'self'",
  );
  const secret = new URL(host.url).hash.slice("#launch=".length);
  const exchanged = await fetch(`${origin}${SESSION_ROUTE}`, {
    method: "POST",
    headers: {
      Origin: origin,
      [SURFACE_HEADER]: "ui",
      "x-agent-forge-launch": secret,
    },
  });
  expect(exchanged.status).toBe(200);
  const data = (await exchanged.json()) as { data: { key: string } };
  const cookie = exchanged.headers.get("set-cookie")?.split(";")[0];
  const token = readToken(tokenPath(hearth.home, hearth.root));
  const authorized = await fetch(`${origin}${TOKEN_ROUTE}`, {
    headers: {
      Origin: origin,
      Cookie: cookie ?? "",
      [SESSION_KEY_HEADER]: data.data.key,
    },
  });
  expect(authorized.status).toBe(200);
  expect(token).not.toBeNull();
  expect(await authorized.text()).toContain(token ?? "");
  const action = await fetch(`${origin}${API_PREFIX}/beads`, {
    method: "POST",
    headers: {
      Origin: origin,
      [OPERATOR_HEADER]: token ?? "",
      [SURFACE_HEADER]: "ui",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: "desktop tracer action",
      type: "task",
      priority: "P2",
    }),
  });
  expect(action.status).toBe(201);
  expect(
    hearth
      .events(["operator.action"])
      .some(
        (event) =>
          (event.payload as { action?: string }).action === "bead.create",
      ),
  ).toBe(true);
});

test("rejects foreign origins, near-prefix proxy lookalikes, and traversal outside the asset root", async () => {
  const { host, origin } = await fixture();
  const foreign = await fetch(`${origin}/`, {
    headers: { Origin: "http://127.0.0.1:1" },
  });
  expect(foreign.status).toBe(403);
  const lookalike = await fetch(`${origin}${API_PREFIX}X/health`);
  expect(lookalike.status).toBe(404);
  const port = Number(new URL(origin).port);
  const socket = connect(port, "127.0.0.1");
  const traversal = await new Promise<string>((resolve, reject) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += String(chunk);
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
    socket.on("connect", () =>
      socket.write(
        `GET /%2e%2e/package.json HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      ),
    );
  });
  expect(traversal).toContain("400 Bad Request");
  await host.close();
});

test("rejects duplicate raw origin headers before proxying", async () => {
  const { origin, host } = await fixture();
  const port = Number(new URL(origin).port);
  const socket = connect(port, "127.0.0.1");
  const response = await new Promise<string>((resolve, reject) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += String(chunk);
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
    socket.on("connect", () =>
      socket.write(
        `GET ${API_PREFIX}/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      ),
    );
  });
  expect(response).toContain("403 Forbidden");
  await host.close();
});

test("serves only canonical assets and refuses symlink escape", async () => {
  const { host, origin, hearth, assetsRoot } = await fixture();
  const outside = join(hearth.root, "outside");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(outside);
  writeFileSync(join(outside, "private.txt"), "private");
  symlinkSync(outside, join(assetsRoot, "escape"), "junction");
  const hidden = await fetch(`${origin}/escape/private.txt`);
  expect(hidden.status).toBe(404);
  await host.close();
});

test("refuses unsafe proxy startup and works with process-start loopback exemptions", async () => {
  const hearth = await startTestHearth();
  closes.push(() => hearth.close());
  const assetsRoot = mkdtempSync(join(hearth.root, "proxy assets-"));
  writeFileSync(join(assetsRoot, "index.html"), "shell");
  const moduleUrl = pathToFileURL(
    join(import.meta.dir, "desktop-host.ts"),
  ).href;
  const apiPath = `${API_PREFIX}/health`;
  const script = `
    const { startDesktopHost } = await import(${JSON.stringify(moduleUrl)});
    let ensured = false;
    try {
      const host = await startDesktopHost({
        root: ${JSON.stringify(hearth.root)}, home: ${JSON.stringify(hearth.home)}, assetsRoot: ${JSON.stringify(assetsRoot)},
        supervisor: { ensure: async () => { ensured = true; return ${hearth.hearth.port}; }, stopIfOwner: async () => {} },
      });
      const url = new URL(host.url);
      const result = await new Promise((resolve, reject) => {
        const socket = require("node:net").connect(Number(url.port), "127.0.0.1");
        let wire = "";
        socket.on("error", reject);
        socket.on("data", (chunk) => wire += String(chunk));
        socket.on("connect", () => socket.write("GET ${apiPath} HTTP/1.1\\r\\nHost: " + url.host + "\\r\\nOrigin: " + url.origin + "\\r\\nConnection: close\\r\\n\\r\\n"));
        socket.on("close", () => {
          const split = wire.indexOf("\\r\\n\\r\\n");
          resolve({ status: Number(/^HTTP\\/1\\.[01] (\\d+)/.exec(wire)?.[1]), body: wire.slice(split + 4) });
        });
      });
      await host.close();
      console.log(JSON.stringify({ ensured, ...result }));
    } catch (error) {
      console.log(JSON.stringify({ ensured, error: String(error) }));
    }
  `;
  const run = async (env: Record<string, string>) => {
    const child = spawn(process.execPath, ["-e", script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill(), 8_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    clearTimeout(timer);
    if (code !== 0)
      throw new Error(`desktop child exited ${code}: ${stderr}\n${stdout}`);
    return JSON.parse(stdout) as {
      ensured: boolean;
      status?: number;
      body?: string;
      error?: string;
    };
  };
  const unsafe = await run(await deadProxyEnvironment());
  expect(unsafe.ensured).toBe(false);
  expect(unsafe.error).toContain("both NO_PROXY and no_proxy");
  const env = await deadProxyEnvironment();
  env.NO_PROXY = "example.invalid,127.0.0.1";
  env.no_proxy = "local.invalid,127.0.0.1";
  const safe = await run(env);
  expect(safe.ensured).toBe(true);
  expect(safe.status).toBe(200);
  expect(JSON.parse(safe.body ?? "{}").ok).toBe(true);
}, 15_000);

test.each([
  "host shutdown",
  "client disconnect",
] as const)("streams incrementally and releases the upstream on %s", async (ending) => {
  const hearth = await startTestHearth();
  closes.push(() => hearth.close());
  const assetsRoot = mkdtempSync(join(hearth.root, "stream assets-"));
  writeFileSync(join(assetsRoot, "index.html"), "shell");
  let upstreamClosed!: () => void;
  const upstreamGone = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  let routeReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    routeReached = resolve;
  });
  const upstream = createServer((req, res) => {
    if (req.url?.endsWith("/stream")) {
      routeReached();
      req.socket.once("close", upstreamClosed);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": open\n\n");
      return;
    }
    res.writeHead(200, { "Content-Length": "40" });
    res.write("truncated");
    setTimeout(() => res.destroy(), 10);
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("missing stream port");
  let target = hearth.hearth.port;
  const host = await startDesktopHost({
    root: hearth.root,
    home: hearth.home,
    assetsRoot,
    supervisor: { ensure: async () => target, stopIfOwner: async () => {} },
  });
  closes.push(host.close);
  closes.push(
    () =>
      new Promise<void>((resolve) => {
        upstream.closeAllConnections();
        upstream.close(() => resolve());
      }),
  );
  const origin = new URL(host.url).origin;
  target = address.port;
  const truncated = await fetch(`${origin}${API_PREFIX}/truncate`);
  await expect(truncated.arrayBuffer()).rejects.toThrow();
  const client = connect(Number(new URL(origin).port), "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    client.once("error", reject);
    client.once("data", (chunk) => {
      expect(String(chunk)).toContain("200 OK");
      resolve();
    });
    client.once("connect", () =>
      client.write(
        `GET ${API_PREFIX}/stream HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\nConnection: keep-alive\r\n\r\n`,
      ),
    );
  });
  await reached;
  if (ending === "host shutdown") await host.close();
  else client.destroy();
  await Promise.race([
    upstreamGone,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("stream cleanup left upstream open")),
        2000,
      ),
    ),
  ]);
  client.destroy();
});

test("accepts only the exact trusted CLI options and keeps spaced values intact", () => {
  expect(
    parseDesktopArguments([
      "--root",
      "C:\\work tree",
      "--assets",
      "C:\\built UI",
      "--hearth",
      "C:\\native hearth.exe",
      "--native-picker",
      "C:\\Agent Forge.exe",
    ]),
  ).toEqual({
    root: resolve("C:\\work tree"),
    assetsRoot: resolve("C:\\built UI"),
    hearthCommand: [
      resolve("C:\\native hearth.exe"),
      "--native-project-picker",
      resolve("C:\\Agent Forge.exe"),
    ],
  });
  expect(() =>
    parseDesktopArguments([
      "--root",
      "x",
      "--assets",
      "y",
      "--hearth",
      "z",
      "--port",
      "1",
    ]),
  ).toThrow();
});

test("crash cleanup never takes ownership from another supervisor", async () => {
  const hearth = await startTestHearth();
  closes.push(() => hearth.close());
  const file = lockPath(hearth.home, hearth.root);
  const original = readLock(file);
  expect(original).not.toBeNull();
  if (!original) throw new Error("fixture lock missing");
  const anotherOwner = "11111111-1111-4111-8111-111111111111";
  updateLock(file, original, { supervisor: anotherOwner });
  await runDesktopCleanup(
    [
      "--cleanup",
      "--root",
      hearth.root,
      "--owner",
      "22222222-2222-4222-8222-222222222222",
    ],
    hearth.home,
  );
  expect(readLock(file)?.supervisor).toBe(anotherOwner);
  expect(
    (await fetch(`http://127.0.0.1:${hearth.hearth.port}/__agent-forge/health`))
      .status,
  ).toBe(200);
});

test("desktop refuses writes to a hearth with missing or mismatched API compatibility", async () => {
  const { hearth, assetsRoot } = await fixture();
  let port = hearth.hearth.port;
  let version: number | undefined = 2;
  let posts = 0;
  const old = createServer((req, res) => {
    if (req.method === "POST") posts++;
    expect(req.headers[OPERATOR_HEADER]).toBeUndefined();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        data: { pid: process.pid, root: hearth.root, apiVersion: version },
        error: null,
      }),
    );
  });
  await new Promise<void>((done) => old.listen(0, "127.0.0.1", done));
  closes.push(async () => {
    old.closeAllConnections();
    await new Promise<void>((done) => old.close(() => done()));
  });
  const host = await startDesktopHost({
    root: hearth.root,
    home: hearth.home,
    assetsRoot,
    supervisor: { ensure: async () => port, stopIfOwner: async () => {} },
  });
  closes.push(host.close);
  const address = old.address();
  if (!address || typeof address === "string")
    throw new Error("fixture port missing");
  port = address.port;
  const file = lockPath(hearth.home, hearth.root);
  const lock = readLock(file);
  if (!lock) throw new Error("fixture lock missing");
  writeFileSync(file, JSON.stringify({ ...lock, port }));
  const origin = new URL(host.url).origin;
  for (version of [2, undefined]) {
    const response = await fetch(`${origin}${API_PREFIX}/beads/bead-1/claim`, {
      method: "POST",
      headers: {
        Origin: origin,
        [OPERATOR_HEADER]: hearth.hearth.token,
        [SURFACE_HEADER]: "ui",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).ok).toBe(false);
  }
  expect(posts).toBe(0);
});
