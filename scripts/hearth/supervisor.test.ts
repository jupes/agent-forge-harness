import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
