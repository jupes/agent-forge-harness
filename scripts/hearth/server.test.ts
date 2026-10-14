import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hasAmbiguousPath } from "./gate";
import { lockPath, tokenPath } from "./home";
import { type HearthLock, readLock } from "./lock";
import { HEALTH_ROUTE, TOKEN_ROUTE } from "./paths";
import { createHearth, type Hearth, type StartedHearth } from "./server";
import { deadProxyEnvironment } from "./testing";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Last in, first out: a hearth or a process is stopped before its directories go.
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function start(): Promise<{
  hearth: StartedHearth;
  home: string;
  root: string;
}> {
  const home = mkdtempSync(join(tmpdir(), "af-hearth-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-hearth-root-"));
  mkdirSync(join(root, ".tmp", "work"), { recursive: true });
  const hearth = await createHearth({ root, home, environment: {} });
  if (hearth.kind !== "started") throw new Error("expected a fresh hearth");
  cleanup.push(async () => {
    await hearth.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { hearth, home, root };
}

const DEV = "/__agent-forge/dev-api";

test("serves the forge-run envelope on the loopback port", async () => {
  const { hearth } = await start();
  const res = await fetch(`${hearth.url}${DEV}/forge-run`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; error: string | null };
  expect(body.ok).toBe(true);
  expect(body.error).toBeNull();
  expect(hearth.url.startsWith("http://127.0.0.1:")).toBe(true);
});

test("refuses any request that carries a foreign Origin, GET or POST", async () => {
  const { hearth } = await start();
  const headers = { Origin: "https://evil.example" };
  expect(
    (await fetch(`${hearth.url}${DEV}/forge-run`, { headers })).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${hearth.url}${DEV}/forge-run/review`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${hearth.url}/__agent-forge/token`, { headers })).status,
  ).toBe(403);
});

test("refuses a non-loopback Host header", async () => {
  const { hearth } = await start();
  const res = await fetch(`${hearth.url}${DEV}/forge-run`, {
    headers: { Host: "attacker.example" },
  });
  expect(res.status).toBe(403);
});

test("serves the token only to a same-origin request, never to a bare GET", async () => {
  const { hearth } = await start();
  const url = `${hearth.url}/__agent-forge/token`;
  expect((await fetch(url)).status).toBe(403);
  const viaOrigin = await fetch(url, { headers: { Origin: hearth.url } });
  expect(viaOrigin.status).toBe(200);
  expect(
    ((await viaOrigin.json()) as { data: { token: string } }).data.token,
  ).toBe(hearth.token);
  const viaFetchSite = await fetch(url, {
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  expect(viaFetchSite.status).toBe(200);
});

/**
 * Paths the operator table does not serve, and what each answers a GET that
 * declares the hearth's own origin. The table's runner has its own repeat
 * check; these were guarded by the front door alone.
 */
const OUTSIDE_THE_TABLE: Array<[string, number]> = [
  [TOKEN_ROUTE, 200],
  [HEALTH_ROUTE, 200],
  [`${DEV}/forge-run`, 200],
  ["/__agent-forge/council-api/profiles", 200],
  ["/__agent-forge/nope", 404],
];

/** A GET with exactly these header lines, over a raw socket: fetch folds a repeated header into one line. */
function rawGetWith(
  port: number,
  path: string,
  headerLines: string[],
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          ...headerLines,
          "Connection: close",
          "",
          "",
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

test("a GET that sends Origin, Sec-Fetch-Site or Host twice, in either order or with one value twice, is 403 on the token, health, dev-api, council-api and an unknown path, and is not served the token", async () => {
  const { hearth } = await start();
  const host = `Host: 127.0.0.1:${hearth.port}`;
  const origin = `Origin: ${hearth.url}`;
  const site = "Sec-Fetch-Site: same-origin";
  const foreignOrigin = "Origin: https://evil.example";
  const crossSite = "Sec-Fetch-Site: cross-site";
  const foreignHost = "Host: evil.example";
  const repeats: Array<[string, string[]]> = [
    ["a foreign Origin then the hearth's", [host, foreignOrigin, origin, site]],
    [
      "the hearth's Origin then a foreign one",
      [host, origin, foreignOrigin, site],
    ],
    [
      "the hearth's Origin twice, once in lower case",
      [host, origin, origin.replace("Origin", "origin"), site],
    ],
    ["cross-site then same-origin", [host, origin, crossSite, site]],
    ["same-origin then cross-site", [host, origin, site, crossSite]],
    ["same-origin twice", [host, origin, site, site]],
    ["a foreign Host then the hearth's", [foreignHost, host, origin, site]],
    ["the hearth's Host then a foreign one", [host, foreignHost, origin, site]],
    ["the hearth's Host twice", [host, host, origin, site]],
  ];
  const answers: unknown[] = [];
  const refusals: unknown[] = [];
  for (const [path, answered] of OUTSIDE_THE_TABLE) {
    // Each header once is answered, so the refusals below are about the repeat.
    const once = await rawGetWith(hearth.port, path, [host, origin, site]);
    expect({ path, status: once.status }).toEqual({ path, status: answered });
    if (path === TOKEN_ROUTE) expect(once.body).toContain(hearth.token);
    for (const [label, lines] of repeats) {
      const answer = await rawGetWith(hearth.port, path, lines);
      answers.push({
        path,
        label,
        status: answer.status,
        ok: (JSON.parse(answer.body) as { ok: boolean }).ok,
        token: answer.body.includes(hearth.token),
      });
      refusals.push({ path, label, status: 403, ok: false, token: false });
    }
  }
  expect(answers).toEqual(refusals);
});

test("Sec-Fetch-Site: same-site, cross-site, an unknown value or two values folded into one line is 403 on the token, health, dev-api, council-api and an unknown path, with or without the hearth's own Origin", async () => {
  const { hearth } = await start();
  const refused = [
    "same-site",
    "cross-site",
    "same-sight",
    "cross-site, same-origin",
  ];
  // With the hearth's own Origin the fetch metadata is the only thing wrong.
  const declarations: Array<Record<string, string>> = [
    {},
    { Origin: hearth.url },
  ];
  const answers: unknown[] = [];
  const refusals: unknown[] = [];
  for (const [path] of OUTSIDE_THE_TABLE) {
    for (const declared of declarations) {
      for (const value of refused) {
        const response = await fetch(`${hearth.url}${path}`, {
          headers: { ...declared, "Sec-Fetch-Site": value },
        });
        const body = await response.text();
        answers.push({
          path,
          declared,
          value,
          status: response.status,
          ok: (JSON.parse(body) as { ok: boolean }).ok,
          token: body.includes(hearth.token),
        });
        refusals.push({
          path,
          declared,
          value,
          status: 403,
          ok: false,
          token: false,
        });
      }
    }
  }
  expect(answers).toEqual(refusals);
});

test("Sec-Fetch-Site: same-origin or none, with the hearth's own Origin, keeps its answer on the token, health, dev-api, council-api and an unknown path", async () => {
  const { hearth } = await start();
  for (const [path, answered] of OUTSIDE_THE_TABLE) {
    for (const value of ["same-origin", "none"]) {
      const response = await fetch(`${hearth.url}${path}`, {
        headers: { Origin: hearth.url, "Sec-Fetch-Site": value },
      });
      await response.body?.cancel();
      expect({ path, value, status: response.status }).toEqual({
        path,
        value,
        status: answered,
      });
    }
  }
});

test("unknown routes answer a 404 envelope", async () => {
  const { hearth } = await start();
  const unknown = await fetch(`${hearth.url}/__agent-forge/nope`);
  expect(unknown.status).toBe(404);
  expect(((await unknown.json()) as { ok: boolean }).ok).toBe(false);
  expect((await fetch(`${hearth.url}/index.html`)).status).toBe(404);
});

test("serves council routes through the hearth", async () => {
  const { hearth } = await start();
  const res = await fetch(`${hearth.url}/__agent-forge/council-api/profiles`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  const runs = await fetch(`${hearth.url}/__agent-forge/council-api/runs`);
  expect(((await runs.json()) as { ok: boolean }).ok).toBe(true);
});

test("writes a lock for its root, and a second start for the same root reuses it", async () => {
  const { hearth, home, root } = await start();
  expect(readLock(lockPath(home, root))?.port).toBe(hearth.port);
  const again = await createHearth({ root, home, environment: {} });
  expect(again.kind).toBe("reused");
  expect(again.port).toBe(hearth.port);
});

/** A temp home and root, removed after the test. The root is its own checkout. */
function places(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "af-hearth-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-hearth-root-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".tmp", "work"), { recursive: true });
  cleanup.push(async () => {
    for (const dir of [home, root]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // A file a stopped process still holds on Windows: the OS temp directory reclaims it.
      }
    }
  });
  return { home, root };
}

/** Write the lock for `root` as a hearth would, naming this test process's pid and `port`. */
function plantLock(home: string, root: string, port: number): HearthLock {
  const lock: HearthLock = {
    pid: process.pid,
    port,
    root: resolve(root),
    startedAt: new Date(0).toISOString(),
    tokenFile: tokenPath(home, root),
  };
  writeFileSync(lockPath(home, root), JSON.stringify(lock));
  return lock;
}

/** A loopback port that nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** A server that answers the health route with `data`, and records each request it is sent. */
async function healthStandIn(data: {
  pid: number;
  root: string;
}): Promise<{ port: number; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (req.url !== HEALTH_ROUTE) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, data: null, error: "not found" }));
      return;
    }
    res.end(JSON.stringify({ ok: true, data, error: null }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return { port: (server.address() as AddressInfo).port, asked };
}

/** `createHearth` in this process; a hearth it starts is closed after the test. */
async function startIn(home: string, root: string): Promise<Hearth> {
  const hearth = await createHearth({ root, home, environment: {} });
  if (hearth.kind === "started") cleanup.push(() => hearth.close());
  return hearth;
}

test("a direct start replaces a lock that names this process's pid when nothing answers on its port, and starts", async () => {
  const { home, root } = places();
  const planted = plantLock(home, root, await closedPort());
  const hearth = await startIn(home, root);
  expect(hearth.kind).toBe("started");
  expect(hearth.port).not.toBe(planted.port);
  expect(readLock(lockPath(home, root))?.port).toBe(hearth.port);
});

test("a direct start replaces a lock whose port answers the health route with another pid, and starts", async () => {
  const { home, root } = places();
  const standIn = await healthStandIn({
    pid: process.pid + 1,
    root: resolve(root),
  });
  plantLock(home, root, standIn.port);
  const hearth = await startIn(home, root);
  expect(standIn.asked).toEqual([`GET ${HEALTH_ROUTE}`]);
  expect(hearth.kind).toBe("started");
  expect(readLock(lockPath(home, root))?.port).toBe(hearth.port);
});

test("a direct start replaces a lock whose port answers the health route with this pid for another root, and starts", async () => {
  // A hearth of this process for another root answers on that port with this pid.
  const other = await start();
  const { home, root } = places();
  plantLock(home, root, other.hearth.port);
  const hearth = await startIn(home, root);
  expect(hearth.kind).toBe("started");
  expect(hearth.port).not.toBe(other.hearth.port);
  expect(readLock(lockPath(home, root))?.port).toBe(hearth.port);
});

interface ServerProcess {
  pid: number;
  /** The first whole line it printed on stdout. */
  firstLine: Promise<string>;
  /** Its exit code, once it has exited and its output has closed. */
  closed: Promise<number | null>;
}

/**
 * `bun scripts/hearth/server.ts --root <root>` with `home` as its
 * `AGENT_FORGE_HOME`, stopped after the test through its own handle. The rest
 * of its environment is `base`.
 */
function runServer(
  home: string,
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): ServerProcess {
  const child = spawn(
    process.execPath,
    [join(import.meta.dir, "server.ts"), "--root", root],
    {
      env: {
        ...base,
        AGENT_FORGE_HOME: home,
        HEARTH_PORT: "",
        COUNCIL_RUNS_DIR: join(root, "council-runs"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const closed = new Promise<number | null>((done) =>
    child.once("close", (code) => done(code)),
  );
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const firstLine = new Promise<string>((done, fail) => {
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const end = stdout.indexOf("\n");
      if (end >= 0) done(stdout.slice(0, end).trimEnd());
    });
    void closed.then((code) =>
      fail(
        new Error(`the hearth exited (${code}) printing no line: ${stderr}`),
      ),
    );
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return { pid: child.pid ?? 0, firstLine, closed };
}

test("the server process prints 'listening' and takes the lock when the lock names the test process's pid and nothing answers on its port", async () => {
  const { home, root } = places();
  const planted = plantLock(home, root, await closedPort());
  const server = runServer(home, root);
  const line = await server.firstLine;
  const lock = readLock(lockPath(home, root));
  expect(line).toBe(`hearth listening on http://127.0.0.1:${lock?.port}`);
  expect(lock?.pid).toBe(server.pid);
  expect(lock?.port).not.toBe(planted.port);
}, 30_000);

test("the server process prints 'already running' and exits 0 after the lock's port answered the health route with the lock's pid and root", async () => {
  const { home, root } = places();
  const standIn = await healthStandIn({
    pid: process.pid,
    root: resolve(root),
  });
  const planted = plantLock(home, root, standIn.port);
  const server = runServer(home, root);
  expect(await server.firstLine).toBe(
    `hearth already running on http://127.0.0.1:${standIn.port}`,
  );
  expect(await server.closed).toBe(0);
  expect(standIn.asked).toEqual([`GET ${HEALTH_ROUTE}`]);
  // Reused, not replaced.
  expect(readLock(lockPath(home, root))).toEqual(planted);
}, 30_000);

test("with HTTP_PROXY naming a port nothing listens on and no NO_PROXY, the server process prints 'already running' for the running hearth of its root, exits 0, and leaves its lock and token file as they were", async () => {
  const { home, root } = places();
  const running = await startIn(home, root);
  expect(running.kind).toBe("started");
  const lock = readLock(lockPath(home, root));
  expect(lock?.port).toBe(running.port);
  const token = readFileSync(tokenPath(home, root), "utf8");
  const server = runServer(home, root, await deadProxyEnvironment());
  expect(await server.firstLine).toBe(
    `hearth already running on ${running.url}`,
  );
  expect(await server.closed).toBe(0);
  expect(readLock(lockPath(home, root))).toEqual(lock);
  expect(readFileSync(tokenPath(home, root), "utf8")).toBe(token);
}, 30_000);

const STILL_STARTING = "503 The control plane is still starting";

test("a token request sent as the hearth starts, before its start has returned, is answered 503 'still starting' and not with an empty token or the token another hearth left in the file; one answered after the start is served the token the start minted", async () => {
  const answers: string[] = [];
  const allowed = new Set([STILL_STARTING, "200 the token this start minted"]);
  for (let attempt = 0; attempt < 5; attempt++) {
    const { home, root } = places();
    const file = tokenPath(home, root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${"f".repeat(64)}\n`);
    const port = await closedPort();
    // It is listening by the time this call returns, and takes the lock and
    // mints its token only after that.
    const starting = createHearth({ root, home, port, environment: {} });
    const asked = fetch(`http://127.0.0.1:${port}${TOKEN_ROUTE}`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const hearth = await starting;
    if (hearth.kind !== "started") throw new Error("expected a fresh hearth");
    cleanup.push(() => hearth.close());
    const answer = await asked;
    const body = (await answer.json()) as {
      data: { token?: unknown } | null;
      error: string | null;
    };
    const token = body.data?.token;
    answers.push(
      answer.status === 200 && token === hearth.token
        ? "200 the token this start minted"
        : `${answer.status} ${body.error ?? `token ${JSON.stringify(token)}`}`,
    );
  }
  expect(answers.filter((answer) => !allowed.has(answer))).toEqual([]);
  expect(answers).toContain(STILL_STARTING);
});

test("health reports the pid and root", async () => {
  const { hearth, root } = await start();
  const res = await fetch(`${hearth.url}/__agent-forge/health`);
  const body = (await res.json()) as { data: { pid: number; root: string } };
  expect(body.data.pid).toBe(process.pid);
  expect(resolve(body.data.root)).toBe(resolve(root));
});

function rawGet(url: string, path: string): Promise<number> {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const req = httpRequest(
      { host: target.hostname, port: target.port, path, method: "GET" },
      (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      },
    );
    req.on("error", fail);
    req.end();
  });
}

test("refuses ambiguous paths that a router could read two ways", async () => {
  const { hearth } = await start();
  // Bun resolves dot segments before the handler sees the URL, so only the
  // separators it leaves intact can be observed here; dot segments are covered
  // by the unit test below.
  for (const path of [
    "/__agent-forge/council-api/%2fprofiles",
    "/__agent-forge/council-api/%5cprofiles",
    "/__agent-forge//dev-api/forge-run",
  ]) {
    expect(await rawGet(hearth.url, path)).toBe(400);
  }
});

test("keeps the token out of the lock and removes the token file on close", async () => {
  const { hearth, home, root } = await start();
  const lock = readFileSync(lockPath(home, root), "utf8");
  expect(lock).not.toContain(hearth.token);
  const tokenFile = readLock(lockPath(home, root))?.tokenFile ?? "";
  expect(existsSync(tokenFile)).toBe(true);
  await hearth.close();
  expect(existsSync(tokenFile)).toBe(false);
  expect(readLock(lockPath(home, root))).toBeNull();
});

test("hasAmbiguousPath flags dot segments, encoded separators and empty segments only", () => {
  for (const bad of [
    "/__agent-forgeX/../__agent-forge/council-api/profiles",
    "/__agent-forge/./dev-api",
    "/__agent-forge/council-api/%2e%2e/profiles",
    "/a%2Fb",
    String.raw`/a\b`,
    "/a//b",
  ]) {
    expect(hasAmbiguousPath(bad)).toBe(true);
  }
  for (const good of [
    "/__agent-forge/dev-api/forge-run",
    "/__agent-forge/council-api/runs/run-1.v2/events",
    "/__agent-forge/council-api/runs/..name/events",
  ]) {
    expect(hasAmbiguousPath(good)).toBe(false);
  }
});
