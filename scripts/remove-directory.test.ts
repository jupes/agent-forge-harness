import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, parse, sep } from "path";
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

/**
 * Every case below hands `removeDirectory` a recording `remove`, never the real
 * one: a target that is refused must not reach it, and one that is not refused
 * would otherwise remove a directory these tests must not touch.
 */
describe("removeDirectory refuses a target it must not remove", () => {
  /** Dots and spaces that Windows strips from the end of a name, so each can name the directory above. */
  const names = [
    "...",
    "....",
    " ",
    "  ",
    ". ",
    ".. ",
    ". .",
    `...${sep}`,
    ` ${sep}`,
  ];

  function attempt(path: string): { refused: boolean; removed: string[] } {
    const removed: string[] = [];
    let refused = false;
    try {
      removeDirectory(path, { remove: (p) => removed.push(p) });
    } catch {
      refused = true;
    }
    return { refused, removed };
  }

  test("a last segment that is empty or ends in a dot or a space is refused before anything is removed", () => {
    const parent = join(tmpdir(), "remove directory parent");
    const outcomes = names.map((name) => ({
      name,
      ...attempt(`${parent}${sep}${name}`),
    }));
    expect(outcomes.filter((o) => !o.refused || o.removed.length > 0)).toEqual(
      [],
    );
    expect(attempt(`${parent}${sep}.`).refused).toBe(true);
    expect(attempt(`${parent}${sep}..`).refused).toBe(true);
    expect(attempt("").refused).toBe(true);
    expect(attempt(parse(parent).root).refused).toBe(true);
  });

  test("the refusal says why", () => {
    expect(() =>
      removeDirectory(`${tmpdir()}${sep}...`, { remove: () => undefined }),
    ).toThrow("ends in a dot or a space");
  });

  test("the OS temp directory itself, in either spelling, is refused", () => {
    for (const spelling of [tmpdir(), realpathSync.native(tmpdir())]) {
      const { refused, removed } = attempt(spelling);
      expect({ spelling, refused, removed }).toEqual({
        spelling,
        refused: true,
        removed: [],
      });
    }
  });

  test("a name with a dot or a space inside, or a directory in the temp directory, is passed on to remove", () => {
    expect(attempt(join(tmpdir(), "a.b c"))).toEqual({
      refused: false,
      removed: [join(tmpdir(), "a.b c")],
    });
  });
});

describe("sleepSync", () => {
  test("waits about as long as it is told to", () => {
    const start = performance.now();
    sleepSync(60);
    expect(performance.now() - start).toBeGreaterThanOrEqual(50);
  });
});
