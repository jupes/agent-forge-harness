import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { scratchDirs } from "./test-scratch";

/** What this file made by hand, to prove the helper leaves what it did not make. */
const others: string[] = [];
afterEach(() => {
  for (const dir of others.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("scratchDirs", () => {
  test("make gives a new directory under the OS temp directory with the prefix, and cleanup removes it with what is inside", () => {
    const scratch = scratchDirs();
    const dir = scratch.make("scratch helper test ");
    others.push(dir);
    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir)).toStartWith("scratch helper test ");
    mkdirSync(join(dir, "deep", "er"), { recursive: true });
    writeFileSync(join(dir, "deep", "er", "file.txt"), "x");

    scratch.cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  test("two makes are two directories, and cleanup removes both and then nothing more", () => {
    const scratch = scratchDirs();
    const first = scratch.make("scratch helper test ");
    const second = scratch.make("scratch helper test ");
    others.push(first, second);
    expect(first).not.toBe(second);

    scratch.cleanup();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);

    // A directory made after a cleanup is not touched by the next one alone.
    const again = scratch.make("scratch helper test ");
    others.push(again);
    scratch.cleanup();
    expect(existsSync(again)).toBe(false);
    expect(() => scratch.cleanup()).not.toThrow();
  });

  test("only the exact paths it made go: a sibling with the same prefix, made another way, stays", () => {
    const scratch = scratchDirs();
    const mine = scratch.make("scratch helper sibling ");
    const sibling = mkdtempSync(join(tmpdir(), "scratch helper sibling "));
    others.push(mine, sibling);
    writeFileSync(join(sibling, "keep.txt"), "kept");

    scratch.cleanup();
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(sibling, "keep.txt"))).toBe(true);
  });

  test("track adds a directory something else made, returns it, and a directory already gone is no error", () => {
    const scratch = scratchDirs();
    const made = mkdtempSync(join(tmpdir(), "scratch helper tracked "));
    others.push(made);
    expect(scratch.track(made)).toBe(made);
    const gone = mkdtempSync(join(tmpdir(), "scratch helper tracked "));
    scratch.track(gone);
    rmSync(gone, { recursive: true, force: true });

    expect(() => scratch.cleanup()).not.toThrow();
    expect(existsSync(made)).toBe(false);
  });
});
