import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "sync-codex.ts");
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A harness root of its own, with the two slash commands and the one skill the script needs. */
function harnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sync codex "));
  scratch.push(root);
  write(
    root,
    ".claude/commands/alpha.md",
    '---\n# a comment, not a heading\nargument-hint: "<thing>"\n---\n\n# /alpha — Does alpha things\n\nBody of alpha.\n',
  );
  write(
    root,
    ".claude/commands/beta.md",
    "# /beta — Does beta things\n\nBody of beta.\n",
  );
  write(
    root,
    ".claude/skills/one/SKILL.md",
    "---\nname: one\ndescription: Does one.\n---\n\n# one\n",
  );
  write(root, ".claude/agents/lead.md", "# Lead\n");
  return root;
}

/** Runs the script with the scratch root as its working directory, as `bun run codex:sync` does. */
function sync(root: string): { exitCode: number | null; stdout: string } {
  const child = Bun.spawnSync([process.execPath, SCRIPT], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: child.exitCode, stdout: child.stdout.toString() };
}

describe("sync-codex", () => {
  test("a command file with frontmatter becomes a skill with the script's own frontmatter alone, then the command's text from its heading", () => {
    const root = harnessRoot();
    const ran = sync(root);
    expect(ran.exitCode).toBe(0);
    expect(
      readFileSync(join(root, ".agents/skills/alpha/SKILL.md"), "utf8"),
    ).toBe(
      "---\nname: alpha\ndescription: /alpha — Does alpha things. Use when the user runs /alpha.\n---\n\n# /alpha — Does alpha things\n\nBody of alpha.\n",
    );
  });

  test("a command file without frontmatter becomes a skill with its text unchanged", () => {
    const root = harnessRoot();
    expect(sync(root).exitCode).toBe(0);
    expect(
      readFileSync(join(root, ".agents/skills/beta/SKILL.md"), "utf8"),
    ).toBe(
      "---\nname: beta\ndescription: /beta — Does beta things. Use when the user runs /beta.\n---\n\n# /beta — Does beta things\n\nBody of beta.\n",
    );
  });

  test("the skills are copied as they are, and the run reports both commands converted", () => {
    const root = harnessRoot();
    const ran = sync(root);
    expect(
      readFileSync(join(root, ".agents/skills/one/SKILL.md"), "utf8"),
    ).toBe("---\nname: one\ndescription: Does one.\n---\n\n# one\n");
    const printed = JSON.parse(ran.stdout) as {
      ok: boolean;
      data: { skills: number; commandsConverted: number };
    };
    expect(printed.ok).toBe(true);
    expect(printed.data.skills).toBe(1);
    expect(printed.data.commandsConverted).toBe(2);
  });
});
