import { describe, expect, test } from "bun:test";
import {
  globsOverlap,
  mapsOverlap,
  overlapOf,
  reservationFor,
} from "./reservations";

describe("globsOverlap: some path matches both", () => {
  const cases: Array<[string, string, boolean]> = [
    ["scripts/a.ts", "scripts/a.ts", true],
    ["scripts/a.ts", "scripts/b.ts", false],
    ["**", "anything/at/all.md", true],
    ["a/**", "**/b", true],
    ["a/**", "b/**", false],
    ["*.ts", "a*", true],
    ["*.ts", "*.md", false],
    ["a/*/c", "a/**/c", true],
    // a/c covers a/c/c (the covering rule), which a/*/c matches.
    ["a/*/c", "a/c", true],
    ["a/*/c", "b/c", false],
    ["a/*", "a/b/a", false],
    ["src/?.ts", "src/ab.ts", false],
    ["src/?.ts", "src/*.ts", true],
    ["docs/**/*.md", "docs/x/y/z.md", true],
    ["docs/**/*.md", "docs/**/*.ts", false],
    // A literal last segment is also a directory: docs/x/y/z.ts/a.md matches both.
    ["docs/**/*.md", "docs/x/y/z.ts", true],
    ["Scripts/A.ts", "scripts/a.ts", true],
    ["a[1].ts", "a1.ts", false],
    ["a[1].ts", "a[1].ts", true],
  ];
  for (const [a, b, overlap] of cases)
    test(`${a} and ${b}: ${overlap ? "overlap" : "do not"}`, () => {
      expect(globsOverlap(a, b)).toBe(overlap);
      expect(globsOverlap(b, a)).toBe(overlap);
    });

  test("a glob whose last segment is literal covers everything under it, a wildcard in an earlier segment included", () => {
    expect(globsOverlap("scripts/scheduler", "scripts/scheduler/x.ts")).toBe(
      true,
    );
    expect(globsOverlap("a/*/c", "a/x/c/d.ts")).toBe(true);
    // A last segment with a wildcard covers only what it matches.
    expect(globsOverlap("scripts/*.ts", "scripts/x/y.ts")).toBe(false);
    expect(globsOverlap("scripts/sched", "scripts/scheduler/x.ts")).toBe(false);
  });

  test("maps overlap when any pair does, and the pair is named", () => {
    expect(mapsOverlap(["a/**", "b.ts"], ["c/**", "b.ts"])).toBe(true);
    expect(mapsOverlap(["a/**"], ["c/**"])).toBe(false);
    expect(overlapOf(["a/**", "b.ts"], ["c/**", "B.ts"])).toEqual([
      "b.ts",
      "B.ts",
    ]);
    expect(overlapOf(["a/**"], ["c/**"])).toBeNull();
  });
});

describe("reservationFor: what a bead reserves", () => {
  const files = (...globs: string[]) =>
    `Work.\n\n## Files\n${globs.join("\n")}\n`;

  test("the globs of the description's file map", () => {
    expect(
      reservationFor({
        id: "x-1",
        description: files("scripts/a.ts", "docs/"),
      }),
    ).toEqual({ globs: ["scripts/a.ts", "docs/**"], conservative: false });
  });

  test("the acceptance criteria's map when the description has none", () => {
    expect(
      reservationFor({
        id: "x-1",
        description: "No map here.",
        acceptance_criteria: files("types/beads.ts"),
      }),
    ).toEqual({ globs: ["types/beads.ts"], conservative: false });
  });

  test("a missing, empty or malformed map reserves the whole repository, and says why", () => {
    for (const bead of [
      { id: "x-1" },
      { id: "x-1", description: "No map at all." },
      { id: "x-1", description: "## Files\n\n" },
      { id: "x-1", description: files("/etc/passwd") },
      { id: "x-1", description: files("../outside") },
      // An invalid map in the description is not passed over for one in the AC.
      {
        id: "x-1",
        description: files("a b"),
        acceptance_criteria: files("ok.ts"),
      },
    ]) {
      const reserved = reservationFor(bead);
      expect(reserved.globs).toEqual(["**"]);
      expect(reserved.conservative).toBe(true);
      expect(reserved.reason).toBeString();
    }
  });
});

describe("globsOverlap against brute force", () => {
  /** A path matches a glob, by the dialect and the covering rule, as a regular expression would say. */
  function matches(glob: string, path: string): boolean {
    const literalLast = !/[*?]/.test(glob.split("/").at(-1) ?? "");
    const segment = (s: string) =>
      s === "**"
        ? null
        : s
            .split("")
            .map((c) =>
              c === "*"
                ? "[^/]*"
                : c === "?"
                  ? "[^/]"
                  : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
            )
            .join("");
    const parts = glob.split("/").map(segment);
    let source = "";
    parts.forEach((part, index) => {
      const sep = index === 0 ? "" : "/";
      source += part === null ? `(${sep}[^/]+)*` : `${sep}${part}`;
    });
    if (source.startsWith("(/")) source = `(${source.slice(2)}`;
    const tail = literalLast ? "(/[^/]+)*" : "";
    return new RegExp(`^${source}${tail}$`).test(path);
  }

  const SEGMENTS = ["a", "b", "ab", "x.ts", "y.md"];
  const paths: string[] = [];
  const grow = (prefix: string[], depth: number) => {
    if (prefix.length > 0) paths.push(prefix.join("/"));
    if (depth === 0) return;
    for (const s of SEGMENTS) grow([...prefix, s], depth - 1);
  };
  grow([], 4);

  const GLOBS = [
    "**",
    "a",
    "a/**",
    "**/b",
    "a/*",
    "*/b",
    "a/*/b",
    "a/**/b",
    "*.ts",
    "**/*.ts",
    "a/*.md",
    "?",
    "a?",
    "*b",
    "a/b",
    "b/a/x.ts",
    "ab/**/y.md",
  ];

  test("never says two globs are disjoint when some path matches both", () => {
    const missed: string[] = [];
    for (const a of GLOBS)
      for (const b of GLOBS) {
        const witness = paths.find((p) => matches(a, p) && matches(b, p));
        if (witness !== undefined && !globsOverlap(a, b))
          missed.push(`${a} | ${b} (both match ${witness})`);
      }
    expect(missed).toEqual([]);
  });
});
