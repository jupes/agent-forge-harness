import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { activeReservations } from "../ledger/query";
import {
  globsOverlap,
  mapsOverlap,
  overlapOf,
  type ReservationDeps,
  release,
  reservationFor,
  reserve,
} from "./reservations";
import { comparablePath } from "./worktrees";

/**
 * This file is also its own child process: with a role in the environment it
 * reserves once and prints the outcome, before any test is registered.
 */
const childRole = process.env["RESERVE_TEST_ROLE"];
if (childRole !== undefined) {
  const dir = process.env["RESERVE_TEST_DIR"] ?? "";
  const outcome = await reserve(
    {
      beadId: childRole,
      worktree: join(dir, "trees", childRole),
      globs: ["src/**"],
    },
    {
      workspace: "c:/race/workspace",
      ledgerPath: join(dir, "ledger.db"),
      lockFile: join(dir, "queue-lock.db"),
      // Each child stays 300 ms between its check and its write, so that
      // without the lock all three would check before any of them writes.
      appendEvent: (event) => {
        const until = Date.now() + 300;
        while (Date.now() < until) {
          // Hold the window open.
        }
        return appendEvent(event, { path: join(dir, "ledger.db") });
      },
    },
  );
  console.log(JSON.stringify(outcome));
  process.exit(0);
}

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

describe("globsOverlap beyond ASCII and plain spellings", () => {
  test("? is one character, a character outside the BMP and a letter whose lower case is longer included", () => {
    expect(globsOverlap("src/?.ts", "src/\u{1F600}.ts")).toBe(true);
    expect(globsOverlap("src/?.ts", "src/İ.ts")).toBe(true);
    expect(globsOverlap("src/??.ts", "src/\u{1F600}.ts")).toBe(false);
  });

  test("one path written two ways meets itself: a . segment, and NFC against NFD", () => {
    expect(globsOverlap("a/./b.ts", "a/b.ts")).toBe(true);
    expect(globsOverlap("docs/café.md", "docs/café.md")).toBe(true);
  });

  test("a glob too long to compare is taken to overlap everything, and never throws", () => {
    const long = `src/${"*a".repeat(30_000)}.ts`;
    expect(globsOverlap(long, "docs/x.md")).toBe(true);
    expect(globsOverlap("src/x.ts", `src/${"x".repeat(60_000)}`)).toBe(true);
  });

  test("a map with a glob that long reserves the whole repository", () => {
    const reserved = reservationFor({
      id: "x-1",
      description: `## Files\nsrc/${"x".repeat(2_000)}.ts\n`,
    });
    expect(reserved).toMatchObject({ globs: ["**"], conservative: true });
    expect(reserved.reason).toContain("long");
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

/**
 * Two spellings of one worktree. On Windows a path's drive and case do not
 * matter and backslashes separate; elsewhere only doubled and trailing
 * slashes differ.
 */
const WIN = process.platform === "win32";

describe("reserve and release, in the ledger", () => {
  const home = mkdtempSync(join(tmpdir(), "af-reserve-"));
  afterAll(() => {
    closeLedger(join(home, "ledger.db"));
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });
  let n = 0;
  function rig(): ReservationDeps & {
    held(): ReturnType<typeof activeReservations>;
  } {
    const workspace = `c:/repo-${++n}`;
    const ledgerPath = join(home, "ledger.db");
    return {
      workspace,
      ledgerPath,
      lockFile: join(home, "queue-lock.db"),
      held: () => activeReservations({ workspace }, { path: ledgerPath }),
    };
  }
  const A = "agent-forge-harness-a1";
  const B = "agent-forge-harness-b2";

  test("reserve writes reservation.acquired, which the ledger's fold sees, under one spelling of the worktree", async () => {
    const deps = rig();
    const outcome = await reserve(
      {
        beadId: "agent-forge-harness-x1gs.5.3",
        worktree: WIN ? "C:\\Repo\\trees\\abc" : "c:/repo//trees/abc/",
        globs: ["scripts/scheduler/**"],
        sessionId: "session-1",
      },
      deps,
    );
    expect(outcome).toMatchObject({ ok: true, value: { already: false } });
    expect(deps.held()).toEqual([
      expect.objectContaining({
        beadId: "agent-forge-harness-x1gs.5.3",
        worktree: WIN
          ? "c:/repo/trees/abc"
          : comparablePath("c:/repo/trees/abc"),
        globs: ["scripts/scheduler/**"],
        sessionId: "session-1",
      }),
    ]);
  });

  test("another bead's overlapping reservation is a conflict naming it and the pair; nothing is written", async () => {
    const deps = rig();
    await reserve(
      { beadId: A, worktree: "c:/repo/trees/a", globs: ["src/**"] },
      deps,
    );
    const outcome = await reserve(
      {
        beadId: B,
        worktree: "c:/repo/trees/b",
        globs: ["src/x.ts", "docs/**"],
      },
      deps,
    );
    expect(outcome.ok ? "" : outcome.kind).toBe("conflict");
    expect(outcome.ok ? "" : outcome.error).toContain(A);
    expect(outcome.ok ? "" : outcome.error).toContain("src/x.ts");
    expect(deps.held().map((r) => r.beadId)).toEqual([A]);
  });

  test("the same reservation again is already held; the same bead and worktree with other globs is a conflict", async () => {
    const deps = rig();
    const request = {
      beadId: A,
      worktree: "c:/repo/trees/a",
      globs: ["src/**"],
    };
    await reserve(request, deps);
    expect(
      await reserve(
        { ...request, worktree: WIN ? "C:/Repo/trees/a" : "c:/repo//trees/a/" },
        deps,
      ),
    ).toMatchObject({ ok: true, value: { already: true } });
    const other = await reserve({ ...request, globs: ["docs/**"] }, deps);
    expect(other.ok ? "" : other.kind).toBe("conflict");
    expect(deps.held().length).toBe(1);
  });

  test("release frees the reservation, whatever spelling of the worktree it is given; nothing held is not-held", async () => {
    const deps = rig();
    await reserve(
      {
        beadId: A,
        worktree: WIN ? "C:\\Repo\\trees\\a" : "c:/repo//trees/a",
        globs: ["src/**"],
      },
      deps,
    );
    expect(
      await release(
        { beadId: A, worktree: WIN ? "c:/REPO/trees/a/" : "c:/repo/trees/a/" },
        deps,
      ),
    ).toMatchObject({ ok: true });
    expect(deps.held()).toEqual([]);
    const again = await release(
      { beadId: A, worktree: "c:/repo/trees/a" },
      deps,
    );
    expect(again.ok ? "" : again.kind).toBe("not-held");
    // The freed globs can be taken by another bead.
    expect(
      (
        await reserve(
          { beadId: B, worktree: "c:/repo/trees/b", globs: ["src/a.ts"] },
          deps,
        )
      ).ok,
    ).toBe(true);
  });

  test("an id, a session, a worktree or a glob that is not one is invalid, and nothing is written", async () => {
    const deps = rig();
    const good = { beadId: A, worktree: "c:/repo/trees/a", globs: ["src/**"] };
    for (const bad of [
      { ...good, beadId: "not a bead" },
      { ...good, sessionId: `ghp_${"a1B2c3D4e5".repeat(4)}` },
      { ...good, worktree: "" },
      { ...good, globs: [] },
      { ...good, globs: ["/etc/passwd"] },
      { ...good, globs: ["../outside"] },
      { ...good, globs: ["a b"] },
      { ...good, globs: ["src/"] },
    ]) {
      const outcome = await reserve(bad, deps);
      expect({ bad, kind: outcome.ok ? "ok" : outcome.kind }).toEqual({
        bad,
        kind: "invalid",
      });
    }
    expect(deps.held()).toEqual([]);
  });

  test("a ledger that will not store the event is a failure, and nothing is held", async () => {
    const deps = rig();
    const outcome = await reserve(
      { beadId: A, worktree: "c:/repo/trees/a", globs: ["src/**"] },
      {
        ...deps,
        appendEvent: () => ({ ok: false, error: "the disk is full" }),
      },
    );
    expect(outcome.ok ? "" : outcome.kind).toBe("failed");
    expect(deps.held()).toEqual([]);
  });

  test("three processes reserving overlapping globs at once: exactly one holds them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-race-"));
    try {
      const outcomes = await Promise.all(
        [
          "agent-forge-harness-r1",
          "agent-forge-harness-r2",
          "agent-forge-harness-r3",
        ].map(
          (role) =>
            new Promise<{ ok: boolean; kind?: string }>((done, fail) => {
              const child = spawn("bun", [import.meta.path], {
                env: {
                  ...process.env,
                  RESERVE_TEST_ROLE: role,
                  RESERVE_TEST_DIR: dir,
                  AGENT_FORGE_HOME: dir,
                },
                stdio: ["ignore", "pipe", "pipe"],
              });
              let out = "";
              child.stdout.on("data", (chunk) => {
                out += String(chunk);
              });
              child.on("error", fail);
              child.on("close", () => {
                try {
                  done(JSON.parse(out.trim().split("\n").at(-1) ?? ""));
                } catch {
                  fail(new Error(`a child printed no outcome: ${out}`));
                }
              });
            }),
        ),
      );
      expect(outcomes.filter((o) => o.ok).length).toBe(1);
      expect(outcomes.filter((o) => !o.ok).map((o) => o.kind)).toEqual([
        "conflict",
        "conflict",
      ]);
      expect(
        activeReservations(
          { workspace: "c:/race/workspace" },
          { path: join(dir, "ledger.db") },
        ).length,
      ).toBe(1);
    } finally {
      closeLedger(join(dir, "ledger.db"));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});
