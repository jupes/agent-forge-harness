/**
 * The entry check every harness CLI uses (agent-forge-harness-05hy). Bun's
 * `import.meta.main` is false for a script that `bun run` is given by a
 * relative path from a working directory spelled with a Windows 8.3 short name
 * (`C:\Users\ERICHS~1\...`): the module keeps the short spelling, the entry
 * point has the long one, and the CLI exited 0 having done nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { isMain } from "./is-main";

const HARNESS = join(import.meta.dir, "..");
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge is-main "));
  scratch.push(dir);
  return dir;
}

/**
 * The 8.3 short spelling Windows gives a directory, or null where it gives
 * none (another platform, or a volume with short names turned off).
 */
function shortSpelling(dir: string): string | null {
  if (process.platform !== "win32") return null;
  const listed = Bun.spawnSync(
    ["cmd", "/d", "/c", "for %I in (.) do @echo %~sI"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const short = listed.stdout.toString().trim();
  if (listed.exitCode !== 0 || short.length === 0) return null;
  return short.toLowerCase() === dir.toLowerCase() ? null : short;
}

const SHORT_HARNESS = shortSpelling(HARNESS);

describe("isMain", () => {
  test("is true when Bun already says the module is the entry point", () => {
    expect(isMain({ main: true, path: "/nowhere/m.ts" }, "/elsewhere.ts")).toBe(
      true,
    );
  });

  test("is true when the module path and the entry point are one file spelled two ways", () => {
    const dir = scratchDir();
    const file = join(dir, "m.ts");
    writeFileSync(file, "\n");
    const respelled = `${dir}${sep}.${sep}m.ts`;
    expect(isMain({ main: false, path: respelled }, file)).toBe(true);
  });

  test("is false when the entry point is another file", () => {
    const dir = scratchDir();
    const file = join(dir, "m.ts");
    const other = join(dir, "other.ts");
    writeFileSync(file, "\n");
    writeFileSync(other, "\n");
    expect(isMain({ main: false, path: file }, other)).toBe(false);
  });

  test("is false, without throwing, when either path names no file", () => {
    const dir = scratchDir();
    const file = join(dir, "m.ts");
    writeFileSync(file, "\n");
    expect(isMain({ main: false, path: join(dir, "gone.ts") }, file)).toBe(
      false,
    );
    expect(isMain({ main: false, path: file }, join(dir, "gone.ts"))).toBe(
      false,
    );
  });

  test.skipIf(SHORT_HARNESS === null)(
    "is true for the module path in its 8.3 short spelling against the entry point in its long one",
    () => {
      const short = SHORT_HARNESS as string;
      expect(
        isMain(
          { main: false, path: join(short, "scripts", "is-main.ts") },
          join(HARNESS, "scripts", "is-main.ts"),
        ),
      ).toBe(true);
    },
  );
});

describe("a harness CLI started from a cwd spelled with an 8.3 short name", () => {
  test.skipIf(SHORT_HARNESS === null)(
    "forge:phase-gate run by a relative path from the short spelling prints its refusal and exits 2",
    () => {
      const home = scratchDir();
      const child = Bun.spawnSync(
        [process.execPath, "run", "scripts/forge/phase-gate.ts"],
        {
          cwd: SHORT_HARNESS as string,
          env: {
            ...process.env,
            AGENT_FORGE_HOME: join(home, ".agent-forge"),
            HOME: home,
            USERPROFILE: home,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = child.stdout.toString();
      expect({ exitCode: child.exitCode, empty: stdout.trim() === "" }).toEqual(
        { exitCode: 2, empty: false },
      );
      const printed = JSON.parse(stdout) as { ok: boolean; error: string };
      expect(printed.ok).toBe(false);
      expect(printed.error).toContain("First argument must be one of");
    },
    60_000,
  );
});

/** Every .ts file under a directory, skipping installed packages. */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("harness entrypoints", () => {
  test("no script or hook decides it is the entry point with import.meta.main alone", () => {
    const own = new Set([
      join(HARNESS, "scripts", "is-main.ts"),
      join(HARNESS, "scripts", "is-main.test.ts"),
    ]);
    const bare = [
      join(HARNESS, "scripts"),
      join(HARNESS, ".claude", "hooks"),
      join(HARNESS, ".claude", "skills"),
    ]
      .flatMap(sources)
      .filter((file) => !own.has(file))
      .filter((file) => /import\.meta\.main\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(HARNESS, file).split(sep).join("/"));
    expect(bare).toEqual([]);
  });
});
