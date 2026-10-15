import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, relative, sep } from "path";
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

/**
 * `cleanup` removes a whole tree, so `track` takes only a directory directly
 * under the OS temp directory. Every decoy below is made by this file, with a
 * file inside that must survive the `cleanup` that follows a refusal. A decoy
 * outside the temp directory goes in this checkout's gitignored `.tmp`.
 */
describe("track refuses what is not a directory directly under the OS temp directory", () => {
  function decoyOutsideTemp(): string {
    const parent = join(import.meta.dir, "..", ".tmp");
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, "scratch-guard-"));
    others.push(dir);
    writeFileSync(join(dir, "keep.txt"), "kept");
    return dir;
  }

  function decoyInTemp(): string {
    const dir = mkdtempSync(join(tmpdir(), "scratch guard "));
    others.push(dir);
    writeFileSync(join(dir, "keep.txt"), "kept");
    return dir;
  }

  test("a relative path, even one that names a real directory", () => {
    const scratch = scratchDirs();
    const decoy = decoyOutsideTemp();
    const relativePath = relative(process.cwd(), decoy);
    expect(isAbsolute(relativePath)).toBe(false);

    expect(() => scratch.track(relativePath)).toThrow("not an absolute path");
    scratch.cleanup();
    expect(existsSync(join(decoy, "keep.txt"))).toBe(true);
  });

  test("the OS temp directory itself, in either spelling", () => {
    const scratch = scratchDirs();
    expect(() => scratch.track(tmpdir())).toThrow(
      "not directly under the OS temp directory",
    );
    expect(() => scratch.track(realpathSync.native(tmpdir()))).toThrow(
      "not directly under the OS temp directory",
    );
  });

  test("a directory outside the OS temp directory", () => {
    const scratch = scratchDirs();
    const decoy = decoyOutsideTemp();
    expect(isAbsolute(decoy)).toBe(true);

    expect(() => scratch.track(decoy)).toThrow(
      "not directly under the OS temp directory",
    );
    scratch.cleanup();
    expect(existsSync(join(decoy, "keep.txt"))).toBe(true);
  });

  test("a directory inside a directory under the OS temp directory", () => {
    const scratch = scratchDirs();
    const parent = decoyInTemp();
    const nested = join(parent, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "keep.txt"), "kept");

    expect(() => scratch.track(nested)).toThrow(
      "not directly under the OS temp directory",
    );
    scratch.cleanup();
    expect(existsSync(join(nested, "keep.txt"))).toBe(true);
  });

  test("a path with a .. segment, even one that leads back into the temp directory", () => {
    const scratch = scratchDirs();
    const decoy = decoyInTemp();
    const sneaky = `${tmpdir()}${sep}..${sep}${basename(tmpdir())}${sep}${basename(decoy)}`;
    expect(existsSync(join(sneaky, "keep.txt"))).toBe(true);

    expect(() => scratch.track(sneaky)).toThrow("made only of dots and spaces");
    scratch.cleanup();
    expect(existsSync(join(decoy, "keep.txt"))).toBe(true);
  });

  test("a directory with the real path of the temp directory is taken, as is one with the spelling os.tmpdir() gives", () => {
    const scratch = scratchDirs();
    const viaReal = mkdtempSync(
      join(realpathSync.native(tmpdir()), "scratch guard "),
    );
    const viaTmpdir = mkdtempSync(join(tmpdir(), "scratch guard "));
    others.push(viaReal, viaTmpdir);

    expect(scratch.track(viaReal)).toBe(viaReal);
    expect(scratch.track(viaTmpdir)).toBe(viaTmpdir);
    scratch.cleanup();
    expect(existsSync(viaReal)).toBe(false);
    expect(existsSync(viaTmpdir)).toBe(false);
  });

  test("a refusal tracks nothing: the directories tracked before it are still removed, and nothing else", () => {
    const scratch = scratchDirs();
    const mine = scratch.make("scratch guard ");
    others.push(mine);
    const decoy = decoyOutsideTemp();

    expect(() => scratch.track(decoy)).toThrow();
    scratch.cleanup();
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(decoy, "keep.txt"))).toBe(true);
  });

  test("make takes a prefix, not a path: one with a separator is refused before anything is made", () => {
    const scratch = scratchDirs();
    const parent = decoyInTemp();

    expect(() => scratch.make(`${basename(parent)}${sep}inner-`)).toThrow(
      "prefix",
    );
    expect(readdirSync(parent)).toEqual(["keep.txt"]);
  });
});

/**
 * Windows strips trailing dots and spaces from the last segment of a path, so
 * `<temp>\...` and `<temp>\ ` name the temp directory itself, and `cleanup`
 * would remove all of it. These tests run against a fake temp directory (made
 * under the real one, with a sentinel file inside) given to `scratchDirs`, so
 * what a regression gets wrong is removed from the fake and never from the
 * real temp directory.
 */
describe("track refuses a last segment Windows reads as another directory", () => {
  function fakeTemp(): string {
    const dir = realpathSync.native(
      mkdtempSync(join(tmpdir(), "scratch fake temp ")),
    );
    others.push(dir);
    writeFileSync(join(dir, "sentinel.txt"), "kept");
    return dir;
  }

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

  test("nine names made of dots and spaces, with or without a trailing separator, are each refused, and the fake temp directory keeps its sentinel", () => {
    expect(names).toHaveLength(9);
    const temp = fakeTemp();
    const scratch = scratchDirs({ tempDir: temp });
    const taken = names.filter((name) => {
      try {
        scratch.track(`${temp}${sep}${name}`);
        return true;
      } catch {
        return false;
      }
    });
    expect(taken).toEqual([]);

    scratch.cleanup();
    expect(existsSync(join(temp, "sentinel.txt"))).toBe(true);
  });

  test("the refusal says why: the name ends in a dot or a space", () => {
    const temp = fakeTemp();
    const scratch = scratchDirs({ tempDir: temp });
    expect(() => scratch.track(`${temp}${sep}...`)).toThrow(
      "ends in a dot or a space",
    );
    expect(() => scratch.track(`${temp}${sep}name.`)).toThrow(
      "ends in a dot or a space",
    );
    expect(() => scratch.track(`${temp}${sep}name `)).toThrow(
      "ends in a dot or a space",
    );
  });

  test("a segment before the last that is only dots and spaces is refused too", () => {
    const temp = fakeTemp();
    const scratch = scratchDirs({ tempDir: temp });
    mkdirSync(join(temp, "inner"));
    expect(() =>
      scratch.track(`${temp}${sep}inner${sep}.. ${sep}inner`),
    ).toThrow("made only of dots and spaces");
    expect(() => scratch.track(`${temp}${sep}...${sep}inner`)).toThrow(
      "made only of dots and spaces",
    );
  });

  test("a link in the temp directory that leads back to it, or out of it, is refused: only a real directory directly under it is taken", () => {
    const temp = fakeTemp();
    const scratch = scratchDirs({ tempDir: temp });
    const outside = join(import.meta.dir, "..", ".tmp");
    mkdirSync(outside, { recursive: true });
    const victim = mkdtempSync(join(outside, "scratch-victim-"));
    others.push(victim);
    writeFileSync(join(victim, "keep.txt"), "kept");
    symlinkSync(temp, join(temp, "back"), "junction");
    symlinkSync(victim, join(temp, "out"), "junction");

    expect(() => scratch.track(join(temp, "back"))).toThrow(
      "not directly under the OS temp directory",
    );
    expect(() => scratch.track(join(temp, "out"))).toThrow(
      "not directly under the OS temp directory",
    );
    scratch.cleanup();
    expect(existsSync(join(temp, "sentinel.txt"))).toBe(true);
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  });

  test("a real directory made in the fake temp directory is still taken and removed, and a name with a dot or a space inside is fine", () => {
    const temp = fakeTemp();
    const scratch = scratchDirs({ tempDir: temp });
    const made = scratch.make("scratch fake ");
    const dotted = join(temp, "a.b c");
    mkdirSync(dotted);
    scratch.track(dotted);
    expect(dirname(made)).toBe(temp);

    scratch.cleanup();
    expect(existsSync(made)).toBe(false);
    expect(existsSync(dotted)).toBe(false);
    expect(existsSync(join(temp, "sentinel.txt"))).toBe(true);
  });
});
