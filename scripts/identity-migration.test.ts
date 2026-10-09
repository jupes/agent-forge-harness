/**
 * Nothing in the repository still treats the host's identity variables as a
 * source of identity, or tells anyone to set them.
 *
 * A scan of the files git knows about (tracked, plus new files not ignored),
 * so other checkouts nested in the working directory are not walked. It finds
 * mentions; the behaviour — that the gate ignores these variables when they
 * are set — is tested in `quality-gate-hook.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

/** The variables that used to carry the gate's event and task. */
const RETIRED = /CLAUDE_TASK_ID|CLAUDE_HOOK_EVENT/;

/**
 * The only places a retired variable may still be named, and why. Anything
 * operational — a hook, a script, a command, a protocol's instructions, the
 * generated mirror — is absent from this list on purpose.
 */
const ALLOWED: ReadonlyArray<{ path: RegExp; why: string }> = [
  {
    path: /^\.claude\/protocols\/agent-onboarding\.md$/,
    why: "says never to read them (checked line by line below)",
  },
  {
    path: /^docs\/plans\//,
    why: "plans and analyses written before the change; history, not instructions",
  },
  {
    path: /^scripts\/beads\/command-center-plan\.ts$/,
    why: "plan text recording that the host never set the variable",
  },
  {
    path: /^scripts\/(identity-migration|quality-gate-hook|quality-gate-ledger|run-correlation)\.test\.ts$/,
    why: "tests that set the variables to show they are ignored",
  },
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

/** Every line that names a retired variable, as `path:line: text`. */
function mentions(paths: readonly string[]): string[] {
  const found: string[] = [];
  for (const path of paths) {
    const file = join(ROOT, path);
    let text: string;
    try {
      if (statSync(file).size > MAX_BYTES) continue;
      text = readFileSync(file, "utf8");
    } catch {
      // Listed but gone from the working tree: a deletion not yet committed.
      continue;
    }
    if (!RETIRED.test(text)) continue;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (RETIRED.test(line)) {
        found.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
      }
    }
  }
  return found;
}

const allowed = (path: string): boolean =>
  ALLOWED.some((entry) => entry.path.test(path));

describe("the retired identity variables", () => {
  const files = knownFiles();

  test("the scan sees the repository: the files it must reach are in it", () => {
    for (const path of [
      ".claude/hooks/quality-gate.ts",
      ".claude/commands/ship.md",
      ".claude/protocols/evaluation-verdict.md",
      ".agents/skills/ship/SKILL.md",
      "scripts/quality-gate-identity.ts",
      "AGENTS.md",
      "CLAUDE.md",
    ]) {
      expect(files).toContain(path);
    }
    expect(files.length).toBeGreaterThan(200);
  });

  test("are named nowhere outside the allowlist: no hook, script, command, protocol or mirror", () => {
    const stray = mentions(files.filter((path) => !allowed(path)));
    expect(stray).toEqual([]);
  });

  test("where the onboarding protocol names them, every line forbids reading them or says the host never sets them", () => {
    const lines = mentions([".claude/protocols/agent-onboarding.md"]);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/Never read|does \*\*not\*\* set/);
    }
  });

  test("the strict-verdict instructions say how the gate is given its Beads issue", () => {
    for (const path of [
      ".claude/commands/ship.md",
      ".claude/protocols/evaluation-verdict.md",
      ".agents/skills/ship/SKILL.md",
    ]) {
      const text = readFileSync(join(ROOT, path), "utf8");
      expect(text).toContain("--correlation");
      expect(text).toContain("forge:correlate");
    }
  });
});
