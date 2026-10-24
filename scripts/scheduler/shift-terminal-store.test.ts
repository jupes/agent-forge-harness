import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import { type ShiftRecord, writeShiftRecord } from "./shift-store";
import {
  createShiftTerminalPublisher,
  SHIFT_TERMINAL_PUBLICATION_ATTEMPTS,
  SHIFT_TERMINAL_PUBLICATION_MS,
} from "./shift-terminal-store";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

function fixture() {
  const root = scratch.make("shift-terminal-publication-"),
    dir = join(root, "shifts"),
    running: ShiftRecord = {
      shiftId: "shift-20261024-011521-868a",
      pid: process.pid,
      workspace: dir,
      startedAt: "2026-10-24T01:15:21.871Z",
      deadline: "2026-10-24T01:16:21.871Z",
      state: "running",
      options: {
        concurrency: 1,
        forMs: 60000,
        maxBeads: 1,
        maxUsd: 1,
        repairs: 0,
      },
      spentUsd: 0,
      unpriced: 0,
      beads: [],
    },
    terminal: ShiftRecord = {
      ...running,
      state: "stopped",
      reason: "operator",
      endedAt: "2026-10-24T01:15:28.268Z",
    };
  writeShiftRecord(dir, running);
  return {
    root,
    dir,
    running,
    terminal,
    path: join(dir, `${running.shiftId}.json`),
  };
}

test("a verified current sharing conflict can release before the same exact terminal draft is retried", async () => {
  const f = fixture(),
    original = readFileSync(f.path),
    originals = statSync(f.path, { bigint: true });
  let clock = 0,
    held = true,
    probes = 0;
  const attempts: Array<{ path: string; bytes: Buffer; ino: bigint }> = [];
  const publish = createShiftTerminalPublisher({
    platform: "win32",
    now: () => clock,
    async wait(ms) {
      clock += ms;
      held = false;
    },
    deleteAccessError(path) {
      expect(path).toBe(f.path);
      expect(readFileSync(path)).toEqual(original);
      expect(statSync(path, { bigint: true }).ino).toBe(originals.ino);
      probes++;
      return held ? 32 : 0;
    },
    rename(from, to) {
      attempts.push({
        path: from,
        bytes: readFileSync(from),
        ino: statSync(from, { bigint: true }).ino,
      });
      if (held) throw Object.assign(Error("held reader"), { code: "EPERM" });
      renameSync(from, to);
    },
  });
  await publish(f.dir, f.terminal);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(probes).toBe(1);
  expect(readFileSync(f.path, "utf8")).toBe(
    `${JSON.stringify(f.terminal, null, 2)}\n`,
  );
  const first = attempts[0];
  if (!first) throw Error("The original terminal draft was not attempted.");
  expect(statSync(f.path, { bigint: true }).ino).toBe(first.ino);
});

test("a never-released sharing conflict exhausts six total attempts without rewriting either saved file", async () => {
  const f = fixture(),
    original = readFileSync(f.path);
  let clock = 0,
    probes = 0,
    waits = 0;
  const attempts: Array<{ path: string; ino: bigint; bytes: Buffer }> = [];
  const failure = Object.assign(Error("sharing persists"), { code: "EPERM" });
  const publish = createShiftTerminalPublisher({
    platform: "win32",
    now: () => clock,
    async wait(ms) {
      waits++;
      clock += ms;
    },
    deleteAccessError() {
      probes++;
      return 32;
    },
    rename(from) {
      attempts.push({
        path: from,
        ino: statSync(from, { bigint: true }).ino,
        bytes: readFileSync(from),
      });
      throw failure;
    },
  });
  await expect(publish(f.dir, f.terminal)).rejects.toBe(failure);
  expect(attempts).toHaveLength(SHIFT_TERMINAL_PUBLICATION_ATTEMPTS);
  expect(new Set(attempts.map((attempt) => attempt.path)).size).toBe(1);
  expect(attempts.every((attempt) => attempt.ino === attempts[0]?.ino)).toBe(
    true,
  );
  expect(
    attempts.every((attempt) =>
      attempt.bytes.equals(attempts[0]?.bytes ?? Buffer.alloc(0)),
    ),
  ).toBe(true);
  expect(probes).toBe(SHIFT_TERMINAL_PUBLICATION_ATTEMPTS - 1);
  expect(waits).toBe(probes);
  expect(clock).toBeLessThan(SHIFT_TERMINAL_PUBLICATION_MS);
  expect(readFileSync(f.path)).toEqual(original);
  const first = attempts[0];
  if (!first) throw Error("The retained terminal draft is missing.");
  expect(readdirSync(f.dir).sort()).toEqual(
    [`${f.running.shiftId}.json`, first.path.slice(f.dir.length + 1)].sort(),
  );
});

for (const expiration of ["initial rename", "bounded wait"] as const)
  test(`no further attempt begins after the new 250ms budget expires during ${expiration}`, async () => {
    const f = fixture();
    let clock = 0,
      attempts = 0,
      probes = 0,
      waits = 0;
    const failure = Object.assign(Error("held"), { code: "EPERM" });
    const publish = createShiftTerminalPublisher({
      platform: "win32",
      now: () => clock,
      async wait(ms) {
        waits++;
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(SHIFT_TERMINAL_PUBLICATION_MS);
        clock = SHIFT_TERMINAL_PUBLICATION_MS;
      },
      deleteAccessError() {
        probes++;
        return 32;
      },
      rename() {
        attempts++;
        if (expiration === "initial rename")
          clock = SHIFT_TERMINAL_PUBLICATION_MS;
        throw failure;
      },
    });
    await expect(publish(f.dir, f.terminal)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(probes).toBe(expiration === "initial rename" ? 0 : 1);
    expect(waits).toBe(probes);
    expect(readFileSync(f.path, "utf8")).toBe(
      `${JSON.stringify(f.running, null, 2)}\n`,
    );
  });

for (const code of [0, 5, null])
  test(`a fresh access probe result ${code} never authorizes a retry`, async () => {
    const f = fixture();
    let attempts = 0,
      waits = 0,
      probes = 0;
    const failure = Object.assign(Error("rename refused"), { code: "EPERM" });
    const publish = createShiftTerminalPublisher({
      platform: "win32",
      deleteAccessError() {
        probes++;
        return code;
      },
      async wait() {
        waits++;
      },
      rename() {
        attempts++;
        throw failure;
      },
    });
    await expect(publish(f.dir, f.terminal)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(probes).toBe(1);
    expect(waits).toBe(0);
  });

test("each further failed rename needs a fresh sharing violation, rather than the earlier result", async () => {
  const f = fixture();
  let attempts = 0,
    probes = 0;
  const failure = Object.assign(Error("changed refusal"), { code: "EPERM" });
  const publish = createShiftTerminalPublisher({
    platform: "win32",
    now: () => 0,
    wait: async () => {},
    deleteAccessError: () => (++probes === 1 ? 32 : 5),
    rename() {
      attempts++;
      throw failure;
    },
  });
  await expect(publish(f.dir, f.terminal)).rejects.toBe(failure);
  expect(attempts).toBe(2);
  expect(probes).toBe(2);
});

for (const [platform, code] of [
  ["linux", "EPERM"],
  ["darwin", "EPERM"],
  ["win32", "EACCES"],
  ["win32", "ENOENT"],
] as const)
  test(`${platform} rename ${code} is one-shot and never probes Windows access`, async () => {
    const f = fixture();
    let attempts = 0,
      probes = 0;
    const failure = Object.assign(Error("not eligible"), { code });
    const publish = createShiftTerminalPublisher({
      platform,
      rename() {
        attempts++;
        throw failure;
      },
      deleteAccessError() {
        probes++;
        return 32;
      },
    });
    await expect(publish(f.dir, f.terminal)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(probes).toBe(0);
  });

for (const target of ["original", "draft"] as const)
  for (const mutation of [
    "changed bytes",
    "same bytes rewritten",
    "same bytes new file",
    "missing",
    "hard link",
    "directory link",
  ] as const)
    test(`${target} ${mutation} during the bounded wait refuses without another rename`, async () => {
      const f = fixture();
      let attempts = 0,
        retained = "";
      const publish = createShiftTerminalPublisher({
        platform: "win32",
        now: () => 0,
        deleteAccessError: () => 32,
        rename(from) {
          retained = from;
          attempts++;
          throw Object.assign(Error("held"), { code: "EPERM" });
        },
        async wait() {
          const path = target === "original" ? f.path : retained;
          const before = readFileSync(path);
          if (mutation === "changed bytes") writeFileSync(path, "changed");
          else if (mutation === "same bytes rewritten") {
            const identity = statSync(path, { bigint: true });
            expect(identity.isFile()).toBe(true);
            expect(identity.nlink).toBe(1n);
            expect(identity.ino).not.toBe(0n);
            writeFileSync(path, before);
            // A same-byte write can share the prior timestamp bucket. Make
            // this adversarial rewrite observably different without waiting.
            utimesSync(
              path,
              new Date(Number(identity.atimeMs)),
              new Date(Number(identity.mtimeMs) + 1_000),
            );
            const rewritten = statSync(path, { bigint: true });
            expect(rewritten.dev).toBe(identity.dev);
            expect(rewritten.ino).toBe(identity.ino);
            expect(rewritten.nlink).toBe(identity.nlink);
            expect(rewritten.size).toBe(identity.size);
            expect(readFileSync(path)).toEqual(before);
            expect(rewritten.mtimeNs).not.toBe(identity.mtimeNs);
            expect(attempts).toBe(1);
          } else if (mutation === "missing") unlinkSync(path);
          else if (mutation === "hard link") linkSync(path, `${path}.hard`);
          else {
            renameSync(path, `${path}.before`);
            if (mutation === "same bytes new file") writeFileSync(path, before);
            else {
              const directory = join(f.root, "linked-folder");
              mkdirSync(directory);
              symlinkSync(directory, path, "junction");
            }
          }
        },
      });
      await expect(publish(f.dir, f.terminal)).rejects.toThrow("changed");
      expect(attempts).toBe(1);
      const untouched = target === "original" ? retained : f.path;
      expect(readFileSync(untouched, "utf8")).toBe(
        `${JSON.stringify(target === "original" ? f.terminal : f.running, null, 2)}\n`,
      );
    });

test("a different original identity cannot authorize terminal retry", async () => {
  const f = fixture();
  writeShiftRecord(f.dir, { ...f.running, pid: f.running.pid + 1 });
  const original = readFileSync(f.path);
  let attempts = 0,
    probes = 0;
  const publish = createShiftTerminalPublisher({
    platform: "win32",
    rename() {
      attempts++;
      throw Object.assign(Error("refused"), { code: "EPERM" });
    },
    deleteAccessError() {
      probes++;
      return 32;
    },
  });
  await expect(publish(f.dir, f.terminal)).rejects.toThrow("changed");
  expect(attempts).toBe(1);
  expect(probes).toBe(0);
  expect(readFileSync(f.path)).toEqual(original);
});

test("ordinary successful terminal publication needs no Windows probe and leaves no draft", async () => {
  const f = fixture();
  const publish = createShiftTerminalPublisher({
    deleteAccessError() {
      throw Error("Must not probe a successful rename");
    },
  });
  await publish(f.dir, f.terminal);
  expect(readFileSync(f.path, "utf8")).toBe(
    `${JSON.stringify(f.terminal, null, 2)}\n`,
  );
  expect(readdirSync(f.dir)).toEqual([`${f.terminal.shiftId}.json`]);
  expect(existsSync(f.path)).toBe(true);
});

test("a publication acknowledgment cannot confirm different target bytes", async () => {
  const f = fixture();
  const publish = createShiftTerminalPublisher({
    rename(from, to) {
      renameSync(from, to);
      writeFileSync(to, "changed after acknowledgment");
    },
  });
  await expect(publish(f.dir, f.terminal)).rejects.toThrow(
    "could not be verified",
  );
  expect(readFileSync(f.path, "utf8")).toBe("changed after acknowledgment");
});

test("an oversized original cannot authorize a retry or be rewritten to make one eligible", async () => {
  const f = fixture(),
    oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 32);
  writeFileSync(f.path, oversized);
  let attempts = 0,
    probes = 0;
  const publish = createShiftTerminalPublisher({
    platform: "win32",
    rename() {
      attempts++;
      throw Object.assign(Error("refused"), { code: "EPERM" });
    },
    deleteAccessError() {
      probes++;
      return 32;
    },
  });
  await expect(publish(f.dir, f.terminal)).rejects.toThrow("changed");
  expect(attempts).toBe(1);
  expect(probes).toBe(0);
  expect(readFileSync(f.path)).toEqual(oversized);
});

test("an unverifiable monotonic clock cannot authorize publication", async () => {
  const f = fixture();
  let attempts = 0;
  const publish = createShiftTerminalPublisher({
    now: () => Number.NaN,
    rename() {
      attempts++;
    },
  });
  await expect(publish(f.dir, f.terminal)).rejects.toThrow("deadline");
  expect(attempts).toBe(0);
  expect(readFileSync(f.path, "utf8")).toBe(
    `${JSON.stringify(f.running, null, 2)}\n`,
  );
});
