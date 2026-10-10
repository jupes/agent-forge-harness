/**
 * Nothing in the repository still tells anyone to write, or look for, an
 * evaluator verdict at the task-scoped path (`.tmp/work/<TASK-ID>-verdict.json`,
 * schema 1), and every instruction that files a verdict names the command
 * that writes schema 2.
 *
 * A scan of the files git knows about (tracked, plus new files not ignored).
 * It finds mentions; the behaviour — that the strict gate reads only the path
 * a run's correlation declares, and refuses a schema 1 file — is tested in
 * `quality-gate-hook.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

/** The task-scoped verdict file, however the task id is spelled. */
const TASK_SCOPED = /-verdict\.json/;

/**
 * The only places the old path may still be named, and why. Anything
 * operational — a hook, a script, a command, a workflow, an agent, the
 * generated mirror — is absent from this list on purpose.
 */
const ALLOWED: ReadonlyArray<{ path: RegExp; why: string }> = [
  {
    path: /^\.claude\/protocols\/evaluation-verdict\.md$/,
    why: "names the legacy path once, to say it is legacy (checked line by line below)",
  },
  {
    path: /^docs\/plans\//,
    why: "plans and analyses written before the change; history, not instructions",
  },
  {
    path: /^scripts\/(verdict-migration|quality-gate-hook|tmp-work-cleanup)\.test\.ts$/,
    why: "tests that plant a file at the old path to show it is not read, or sweep one",
  },
];

/** Every instruction file that tells someone how a verdict is filed. */
const WRITER_INSTRUCTIONS = [
  ".claude/agents/evaluator.md",
  ".claude/workflows/feature.md",
  ".claude/workflows/forge-auto.md",
  ".claude/commands/ship.md",
  ".claude/commands/forgemaster-auto.md",
  ".claude/protocols/evaluation-verdict.md",
  ".agents/skills/forge-roles/references/evaluator.md",
  ".agents/skills/ship/SKILL.md",
  ".agents/skills/forgemaster-auto/SKILL.md",
];

const TEXT =
  /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|yaml|yml|toml|sh|ps1|html|css|txt)$/;
const MAX_BYTES = 2 * 1024 * 1024;

function knownFiles(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  }
  return listed.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0 && TEXT.test(path));
}

function read(path: string): string | null {
  const file = join(ROOT, path);
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    // Listed but gone from the working tree: a deletion not yet committed.
    return null;
  }
}

/** Every line that names the task-scoped verdict path, as `path:line: text`. */
function mentions(paths: readonly string[]): string[] {
  const found: string[] = [];
  for (const path of paths) {
    const text = read(path);
    if (text === null || !TASK_SCOPED.test(text)) continue;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (TASK_SCOPED.test(line)) {
        found.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
      }
    }
  }
  return found;
}

const allowed = (path: string): boolean =>
  ALLOWED.some((entry) => entry.path.test(path));

describe("the task-scoped verdict path", () => {
  const files = knownFiles();

  test("the scan sees the repository: the files it must reach are in it", () => {
    for (const path of [
      ...WRITER_INSTRUCTIONS,
      ".claude/hooks/quality-gate.ts",
      ".claude/protocols/model-tier-policy.md",
      ".claude/molecules/README.md",
      "scripts/eval-verdict.ts",
      "scripts/tmp-work-cleanup.ts",
    ]) {
      expect(files).toContain(path);
    }
    expect(files.length).toBeGreaterThan(200);
  });

  test("is named nowhere outside the allowlist: no hook, script, command, workflow, agent or mirror", () => {
    expect(mentions(files.filter((path) => !allowed(path)))).toEqual([]);
  });

  test("the protocol names it only to say it is legacy", () => {
    const lines = mentions([".claude/protocols/evaluation-verdict.md"]);
    expect(lines).toHaveLength(1);
    for (const line of lines) expect(line).toContain("legacy");
  });

  test("every instruction that files a verdict names the schema 2 writer", () => {
    for (const path of WRITER_INSTRUCTIONS) {
      expect({
        path,
        namesWriter: read(path)?.includes("forge:verdict"),
      }).toEqual({ path, namesWriter: true });
    }
  });

  test("no instruction file holds a schema 1 verdict example (schemaVersion 1 next to taskId)", () => {
    const schema1 = /"schemaVersion":\s*1,\s*"taskId"/;
    const stray = files
      .filter((path) => /^\.(claude|agents)\//.test(path))
      .filter((path) => schema1.test((read(path) ?? "").replace(/\s+/g, " ")));
    expect(stray).toEqual([]);
  });
});
