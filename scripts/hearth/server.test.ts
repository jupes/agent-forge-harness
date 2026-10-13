import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasAmbiguousPath } from "./gate";
import { lockPath } from "./home";
import { readLock } from "./lock";
import { HEALTH_ROUTE, TOKEN_ROUTE } from "./paths";
import { createHearth, type StartedHearth } from "./server";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
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
