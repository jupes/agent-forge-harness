import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDesktopArguments } from "./desktop-entry";
import { startDesktopHost } from "./desktop-host";
import { tokenPath } from "./home";
import {
  API_PREFIX,
  OPERATOR_HEADER,
  SESSION_KEY_HEADER,
  SESSION_ROUTE,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "./paths";
import { deadProxyEnvironment, startTestHearth } from "./testing";
import { readToken } from "./token";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

async function fixture() {
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
    },
  });
  closes.push(host.close);
  return { hearth, host, assetsRoot, origin: new URL(host.url).origin };
}

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

test("accepts only the exact three trusted CLI options and keeps spaced values intact", () => {
  expect(
    parseDesktopArguments([
      "--root",
      "C:\\work tree",
      "--assets",
      "C:\\built UI",
      "--hearth",
      "C:\\native hearth.exe",
    ]),
  ).toEqual({
    root: resolve("C:\\work tree"),
    assetsRoot: resolve("C:\\built UI"),
    hearthCommand: [resolve("C:\\native hearth.exe")],
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
