import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeDirectory, sleepSync } from "./remove-directory";

/** An error the way Node reports a failed system call. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe("removeDirectory", () => {
  test("removes a tree with what is inside, and a path that is already gone is no error", () => {
    const dir = mkdtempSync(join(tmpdir(), "remove directory test "));
    try {
      mkdirSync(join(dir, "deep", "er"), { recursive: true });
      writeFileSync(join(dir, "deep", "er", "file.txt"), "x");
      removeDirectory(dir);
      expect(existsSync(dir)).toBe(false);
      expect(() => removeDirectory(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock that clears within the attempts is waited out: it retries after the delay and then succeeds", () => {
    const calls: string[] = [];
    const slept: number[] = [];
    let failures = 2;
    removeDirectory("the-path", {
      delayMs: 7,
      remove: (path) => {
        calls.push(path);
        if (failures-- > 0) throw errno("EBUSY");
      },
      sleep: (ms) => slept.push(ms),
    });
    expect(calls).toEqual(["the-path", "the-path", "the-path"]);
    expect(slept).toEqual([7, 7]);
  });

  test("a lock that never clears is tried the given number of times, waited for between tries only, and its last error is thrown", () => {
    let calls = 0;
    const slept: number[] = [];
    let thrown: unknown;
    try {
      removeDirectory("the-path", {
        attempts: 4,
        delayMs: 3,
        remove: () => {
          calls++;
          throw errno("EBUSY");
        },
        sleep: (ms) => slept.push(ms),
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as NodeJS.ErrnoException).code).toBe("EBUSY");
    expect(calls).toBe(4);
    expect(slept).toEqual([3, 3, 3]);
  });

  test("by default it tries five times, 100 ms apart", () => {
    const slept: number[] = [];
    let calls = 0;
    expect(() =>
      removeDirectory("the-path", {
        remove: () => {
          calls++;
          throw errno("EPERM");
        },
        sleep: (ms) => slept.push(ms),
      }),
    ).toThrow("EPERM");
    expect(calls).toBe(5);
    expect(slept).toEqual([100, 100, 100, 100]);
  });

  test("an error that is not a lock is thrown at once, with no retry and no wait", () => {
    let calls = 0;
    let waited = false;
    expect(() =>
      removeDirectory("the-path", {
        remove: () => {
          calls++;
          throw errno("EACCES");
        },
        sleep: () => {
          waited = true;
        },
      }),
    ).toThrow("EACCES");
    expect(calls).toBe(1);
    expect(waited).toBe(false);
  });
});

describe("sleepSync", () => {
  test("waits about as long as it is told to", () => {
    const start = performance.now();
    sleepSync(60);
    expect(performance.now() - start).toBeGreaterThanOrEqual(50);
  });
});
