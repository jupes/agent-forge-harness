import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function fixture(pathsWithSpaces = false) {
  const home = mkdtempSync(
    join(tmpdir(), pathsWithSpaces ? "af sup home-" : "af-sup-home-"),
  );
  const root = mkdtempSync(
    join(tmpdir(), pathsWithSpaces ? "af sup root-" : "af-sup-root-"),
  );
  const make = (id: string, command?: readonly string[]) => {
    const supervisor = createSupervisor({
      root,
      home,
      id,
      ...(command === undefined ? {} : { command }),
    });
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

const FAKE_LAUNCHER = `
const { createHash } = require("node:crypto");
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { join, resolve } = require("node:path");
const rootIndex = process.argv.indexOf("--root");
const root = resolve(process.argv[rootIndex + 1]);
const home = process.env.AGENT_FORGE_HOME;
appendFileSync(join(home, "launcher-starts.txt"), process.pid + "\\n");
writeFileSync(join(home, "launcher-argv.json"), JSON.stringify(process.argv.slice(1)));
const normalized = root.replaceAll("\\\\", "/");
const key = createHash("sha256")
  .update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
  .digest("hex")
  .slice(0, 12);
const server = createServer((req, res) => {
  const body = JSON.stringify({
    ok: true,
    data: { pid: process.pid, root },
    error: null,
  });
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
});
mkdirSync(home, { recursive: true });
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  writeFileSync(join(home, "hearth-" + key + ".lock"), JSON.stringify({
    pid: process.pid,
    port,
    root,
    startedAt: new Date().toISOString(),
    tokenFile: join(home, "tokens", key + ".token"),
  }));
});
`;

test("uses a configured executable and preserves spaced paths as argv values", async () => {
  const { home, root, make, lock } = fixture(true);
  const launcher = join(
    home,
    `native launcher with spaces${process.platform === "win32" ? ".exe" : ""}`,
  );
  linkSync(process.execPath, launcher);
  const supervisor = make("desktop", [
    launcher,
    "-e",
    FAKE_LAUNCHER,
    "marker argument with spaces",
  ]);
  const port = await supervisor.ensure();
  expect(lock()?.port).toBe(port);
  expect(lock()?.root).toBe(root);
  expect(lock()?.supervisor).toBe("desktop");
  const argv = JSON.parse(
    readFileSync(join(home, "launcher-argv.json"), "utf8"),
  ) as string[];
  expect(argv[0]).toBe("marker argument with spaces");
  expect(argv.slice(-2)).toEqual(["--root", root]);
  expect(
    readFileSync(join(home, "launcher-starts.txt"), "utf8")
      .trim()
      .split(/\r?\n/),
  ).toHaveLength(1);
});

test("rejects empty and blank configured executables before creating a lock", () => {
  for (const command of [[], [" "]]) {
    const home = join(tmpdir(), "missing supervisor home");
    const root = join(tmpdir(), "missing supervisor root");
    expect(() =>
      createSupervisor({ root, home, id: "bad", command }),
    ).toThrow();
    expect(readLock(lockPath(home, root))).toBeNull();
  }
});

test("concurrent ensure calls share one configured launcher startup", async () => {
  const { home, make, lock } = fixture(true);
  const supervisor = make("desktop", [
    process.execPath,
    "-e",
    FAKE_LAUNCHER,
    "one startup marker.txt",
  ]);
  const ports = await Promise.all([
    supervisor.ensure(),
    supervisor.ensure(),
    supervisor.ensure(),
  ]);
  expect(new Set(ports).size).toBe(1);
  expect(lock()?.port).toBe(ports[0]);
  expect(
    readFileSync(join(home, "launcher-starts.txt"), "utf8")
      .trim()
      .split(/\r?\n/),
  ).toHaveLength(1);
});

test("explicit restart replaces only the owned hearth and concurrent reads join it", async () => {
  const { home, make, lock } = fixture();
  const supervisor = make("desktop", [
    process.execPath,
    "-e",
    FAKE_LAUNCHER,
    "restart-fixture",
  ]);
  await supervisor.ensure();
  const previous = lock()?.pid ?? 0;
  const restart = supervisor.restartIfOwner!();
  const [result, port] = await Promise.all([restart, supervisor.ensure()]);
  expect(result).toEqual({ ok: true, port });
  expect(lock()?.pid).not.toBe(previous);
  expect(isPidAlive(previous)).toBe(false);
  expect(lock()?.supervisor).toBe("desktop");
  expect(
    readFileSync(join(home, "launcher-starts.txt"), "utf8")
      .trim()
      .split(/\r?\n/),
  ).toHaveLength(2);
});

test("restart refuses a hearth adopted by another supervisor without stopping or claiming it", async () => {
  const { home, make, lock } = fixture();
  const command = [process.execPath, "-e", FAKE_LAUNCHER, "restart-fixture"];
  const first = make("first", command);
  await first.ensure();
  const second = make("second", command);
  await second.ensure();
  const previous = lock();
  const result = await first.restartIfOwner!();
  expect(result.ok).toBe(false);
  expect(lock()).toEqual(previous);
  expect(isPidAlive(previous?.pid ?? 0)).toBe(true);
  expect(
    readFileSync(join(home, "launcher-starts.txt"), "utf8")
      .trim()
      .split(/\r?\n/),
  ).toHaveLength(1);
});

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

test("a hearth survives its launching supervisor process exiting so another window can adopt it", async () => {
  const { home, root, make, lock } = fixture();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  await printedBy(
    `
    import { createSupervisor } from ${SUPERVISOR};
    const supervisor = createSupervisor({root:${JSON.stringify(root)},home:${JSON.stringify(home)},id:'departing-window',command:[process.execPath,'-e',${JSON.stringify(FAKE_LAUNCHER)},'handoff-fixture']});
    const port=await supervisor.ensure();
    process.stdout.write(JSON.stringify({port}));
  `,
    env,
  );
  const pid = lock()?.pid ?? 0;
  expect(isPidAlive(pid)).toBe(true);
  const remaining = make("remaining-window");
  await remaining.ensure();
  expect(lock()?.pid).toBe(pid);
  expect(lock()?.supervisor).toBe("remaining-window");
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
/**
 * The supervisor module, as the probe process loads it. Interpolated rather than
 * written into its text: the import scan (`scripts/import-graph.ts`) reads this
 * file's text, would take the line for a load of this file's own, and throws on
 * a relative specifier it cannot resolve from here.
 */
const SUPERVISOR = JSON.stringify("./scripts/hearth/supervisor");

const PROBE = `
import { isHealthy } from ${SUPERVISOR};
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
