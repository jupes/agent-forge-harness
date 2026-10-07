import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasAmbiguousPath } from "./gate";
import { lockPath } from "./home";
import { readLock } from "./lock";
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
