import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hearthHome, lockPath, rootKey, tokenPath } from "./home";
import {
  acquireLock,
  type HearthLock,
  isPidAlive,
  readLock,
  releaseLock,
} from "./lock";
import { createToken, readToken } from "./token";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-hearth-lock-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function lockFor(home: string, root: string, pid: number): HearthLock {
  return {
    pid,
    port: 4321,
    root,
    startedAt: "2026-10-06T00:00:00.000Z",
    tokenFile: tokenPath(home, root),
  };
}

test("AGENT_FORGE_HOME overrides the default home, and roots get distinct keys", () => {
  expect(hearthHome({ AGENT_FORGE_HOME: "/x/home" })).toBe("/x/home");
  expect(hearthHome({}).endsWith(".agent-forge")).toBe(true);
  expect(rootKey("/a/b")).not.toBe(rootKey("/a/c"));
  expect(rootKey("/a/b")).toBe(rootKey("/a/b"));
  expect(lockPath("/h", "/a/b")).not.toBe(lockPath("/h", "/a/c"));
});

test("first acquire wins; a live lock for the same root is returned, not replaced", () => {
  const home = temp();
  const root = "/some/root";
  const path = lockPath(home, root);
  expect(acquireLock(path, lockFor(home, root, process.pid)).kind).toBe(
    "acquired",
  );
  const second = acquireLock(path, {
    ...lockFor(home, root, process.pid),
    port: 9,
  });
  expect(second.kind).toBe("held");
  expect(readLock(path)?.port).toBe(4321);
});

test("a lock whose pid is dead is replaced", () => {
  const home = temp();
  const root = "/some/root";
  const path = lockPath(home, root);
  const dead = 2 ** 22 + 12345;
  expect(isPidAlive(dead)).toBe(false);
  acquireLock(path, lockFor(home, root, dead));
  expect(acquireLock(path, lockFor(home, root, process.pid)).kind).toBe(
    "acquired",
  );
  expect(readLock(path)?.pid).toBe(process.pid);
});

test("different roots do not collide, and release removes only the owning pid lock", () => {
  const home = temp();
  const a = lockPath(home, "/root/a");
  const b = lockPath(home, "/root/b");
  expect(acquireLock(a, lockFor(home, "/root/a", process.pid)).kind).toBe(
    "acquired",
  );
  expect(acquireLock(b, lockFor(home, "/root/b", process.pid)).kind).toBe(
    "acquired",
  );
  releaseLock(a, process.pid + 1);
  expect(readLock(a)).not.toBeNull();
  releaseLock(a, process.pid);
  expect(readLock(a)).toBeNull();
  expect(readLock(b)).not.toBeNull();
});

test("a malformed lock file reads as no lock", () => {
  const home = temp();
  const path = lockPath(home, "/r");
  acquireLock(path, lockFor(home, "/r", process.pid));
  writeFileSync(path, "{not json");
  expect(readLock(path)).toBeNull();
});

test("createToken writes a fresh 64-hex token and readToken returns it", () => {
  const home = temp();
  const file = tokenPath(home, "/r");
  const token = createToken(file);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(readToken(file)).toBe(token);
  expect(readFileSync(file, "utf8").trim()).toBe(token);
  expect(createToken(file)).not.toBe(token);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
});
