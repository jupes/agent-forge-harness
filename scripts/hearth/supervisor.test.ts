import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPath } from "./home";
import { isPidAlive, readLock } from "./lock";
import { createSupervisor } from "./supervisor";

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
