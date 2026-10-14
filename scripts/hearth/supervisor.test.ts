import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lockPath } from "./home";
import { type HearthLock, isPidAlive, readLock } from "./lock";
import { HEALTH_ROUTE } from "./paths";
import { createSupervisor } from "./supervisor";
import { deadProxyEnvironment, startTestHearth } from "./testing";

const REPO = resolve(import.meta.dir, "..", "..");

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "af-sup-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-sup-root-"));
  const make = (id: string) => {
    const supervisor = createSupervisor({ root, home, id });
    cleanup.push(() => supervisor.stopIfOwner());
    return supervisor;
  };
  cleanup.push(async () => {
    const lock = readLock(lockPath(home, root));
    if (lock && isPidAlive(lock.pid)) process.kill(lock.pid);
    await new Promise((done) => setTimeout(done, 200));
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { home, root, make, lock: () => readLock(lockPath(home, root)) };
}

test("starts a hearth, records itself as supervisor, and stops it on close", async () => {
  const { make, lock } = fixture();
  const first = make("first");
  const port = await first.ensure();
  expect(lock()?.port).toBe(port);
  expect(lock()?.supervisor).toBe("first");
  const pid = lock()?.pid ?? 0;
  expect(isPidAlive(pid)).toBe(true);
  await first.stopIfOwner();
  await new Promise((done) => setTimeout(done, 300));
  expect(isPidAlive(pid)).toBe(false);
  expect(lock()).toBeNull();
}, 30_000);

test("a second supervisor adopts the live hearth, and the old one then leaves it running", async () => {
  const { make, lock } = fixture();
  const first = make("first");
  const port = await first.ensure();
  const pid = lock()?.pid ?? 0;
  const second = make("second");
  expect(await second.ensure()).toBe(port);
  expect(lock()?.pid).toBe(pid);
  expect(lock()?.supervisor).toBe("second");
  await first.stopIfOwner();
  expect(isPidAlive(pid)).toBe(true);
  await second.stopIfOwner();
}, 30_000);

test("respawns on the same port when the hearth was stopped underneath it", async () => {
  const { make, lock } = fixture();
  const first = make("first");
  const port = await first.ensure();
  const pid = lock()?.pid ?? 0;
  process.kill(pid);
  await new Promise((done) => setTimeout(done, 500));
  expect(isPidAlive(pid)).toBe(false);
  expect(await first.ensure()).toBe(port);
  expect(lock()?.pid).not.toBe(pid);
  expect(isPidAlive(lock()?.pid ?? 0)).toBe(true);
}, 30_000);

/** What a bun process run from the repository root prints, read as JSON. */
async function printedBy(
  script: string,
  env: Record<string, string>,
): Promise<unknown> {
  const child = spawn(process.execPath, ["-e", script], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    err += String(chunk);
  });
  const code = await new Promise<number | null>((done) =>
    child.once("close", done),
  );
  if (code !== 0) throw new Error(`the script exited ${code}: ${err}`);
  return JSON.parse(out);
}

/**
 * In that process: whether a plain `fetch` of the lock's health route got any
 * answer, and what `isHealthy` says of the lock.
 */
const PROBE = `
import { isHealthy } from "./scripts/hearth/supervisor";
const lock = JSON.parse(process.env.PROBE_LOCK ?? "null");
let fetchAnswered = true;
try {
  await fetch("http://127.0.0.1:" + lock.port + ${JSON.stringify(HEALTH_ROUTE)}, {
    signal: AbortSignal.timeout(2000),
  });
} catch {
  fetchAnswered = false;
}
process.stdout.write(JSON.stringify({ fetchAnswered, healthy: await isHealthy(lock) }));
`;

test("isHealthy, in a bun process whose HTTP_PROXY names a port nothing listens on and that has no NO_PROXY, judges a running hearth healthy where fetch in that process gets no answer", async () => {
  const running = await startTestHearth();
  cleanup.push(() => running.close());
  const lock: HearthLock | null = readLock(
    lockPath(running.home, running.root),
  );
  expect(lock?.port).toBe(running.hearth.port);
  const env = await deadProxyEnvironment();
  expect(
    await printedBy(PROBE, { ...env, PROBE_LOCK: JSON.stringify(lock) }),
  ).toEqual({ fetchAnswered: false, healthy: true });
}, 30_000);

/** A process of this test's own that does nothing: a live pid that is not a hearth. */
function idleProcess(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return child.pid ?? 0;
}

/** A loopback port whose server is closed after the test; `answer` handles each connection. */
async function portThat(answer: (socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    answer(socket);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return (server.address() as AddressInfo).port;
}

/** A temp home and root, with a lock for the root naming `pid` and `port` and owned by supervisor `id`. */
function ownedLock(pid: number, port: number, id: string) {
  const home = mkdtempSync(join(tmpdir(), "af-sup-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-sup-root-"));
  cleanup.push(async () => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const planted: HearthLock = {
    pid,
    port,
    root: resolve(root),
    startedAt: new Date(0).toISOString(),
    tokenFile: join(home, "tokens", "x.token"),
    supervisor: id,
  };
  writeFileSync(lockPath(home, root), JSON.stringify(planted));
  return {
    supervisor: createSupervisor({ root, home, id }),
    lock: () => readLock(lockPath(home, root)),
    planted,
  };
}

test("stopIfOwner, when its lock names a pid that is not alive, releases the lock", async () => {
  const dead = 2 ** 22 + 12345;
  expect(isPidAlive(dead)).toBe(false);
  const owned = ownedLock(dead, await portThat((socket) => socket.end()), "me");
  await owned.supervisor.stopIfOwner();
  expect(owned.lock()).toBeNull();
});

test("stopIfOwner, when its lock names a live pid whose port answers the health route with another pid, releases the lock and leaves that process running", async () => {
  const pid = idleProcess();
  const port = await portThat((socket) => {
    socket.once("data", () => {
      const body = JSON.stringify({
        ok: true,
        data: { pid: pid + 1, root: "elsewhere" },
        error: null,
      });
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  const owned = ownedLock(pid, port, "me");
  await owned.supervisor.stopIfOwner();
  expect(owned.lock()).toBeNull();
  expect(isPidAlive(pid)).toBe(true);
});

test("stopIfOwner, when its lock names a live pid whose port takes the connection but answers nothing within the health probe's 2 s, leaves the lock in place and the process running", async () => {
  const pid = idleProcess();
  // Takes the request and never answers: a hearth too busy to reply.
  const port = await portThat(() => undefined);
  const owned = ownedLock(pid, port, "me");
  const started = performance.now();
  await owned.supervisor.stopIfOwner();
  expect(performance.now() - started).toBeGreaterThanOrEqual(1900);
  expect(owned.lock()).toEqual(owned.planted);
  expect(isPidAlive(pid)).toBe(true);
}, 15_000);
