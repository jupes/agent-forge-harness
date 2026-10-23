import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { syncCodex } from "./sync-codex";

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
    timeout: 5000,
  });
  return { exitCode: child.exitCode, stdout: child.stdout.toString() };
}

describe("sync-codex", () => {
  test("importing the sync module leaves generated trees untouched and emits no sync result", () => {
    const root = harnessRoot();
    write(root, ".agents/skills/kept.txt", "Keep until an explicit sync.\n");
    write(root, ".codex/kept.txt", "Keep this too.\n");
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)}); console.log("imported");`,
      ],
      {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("imported");
    expect(existsSync(join(root, ".agents/skills/kept.txt"))).toBe(true);
    expect(existsSync(join(root, ".codex/kept.txt"))).toBe(true);
    expect(existsSync(join(root, ".agents/CODEX-NOTES.md"))).toBe(false);
  });

  test("explicit sync preserves the complete original mirror and never changes source or adjacent files", () => {
    const roots = [harnessRoot(), harnessRoot()];
    const tree = (root: string, relative = ""): Array<[string, string]> =>
      readdirSync(join(root, relative), { withFileTypes: true })
        .flatMap<[string, string]>((entry) => {
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          return entry.isDirectory()
            ? tree(root, path)
            : [[path, readFileSync(join(root, path)).toString("base64")]];
        })
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const root of roots) {
      write(root, ".claude/commands/forge-plan.md", "# duplicate\n");
      write(root, ".claude/commands/ignored.txt", "not a command\n");
      write(
        root,
        ".claude/agents/worker.md",
        "# Worker\nPrivate fixture role.\n",
      );
      write(
        root,
        ".claude/skills/one/references/nested.txt",
        "Nested fixture 🌱\n",
      );
      writeFileSync(
        join(root, ".claude/skills/one/bytes.bin"),
        Buffer.from([0, 255, 1, 128]),
      );
      write(root, ".agents/manual.txt", "Adjacent hand-authored file.\n");
      write(root, ".agents/skills/stale.txt", "Regenerated away.\n");
      write(root, ".codex/stale.txt", "Regenerated away too.\n");
    }
    const first = roots[0],
      second = roots[1];
    if (!first || !second) throw new Error("Missing disposable roots");
    const original = tree(join(first, ".claude"));
    const result = syncCodex(first);
    const ran = sync(second);
    let receipt: unknown;
    try {
      receipt = JSON.parse(ran.stdout);
    } catch {
      throw new Error("Sync entry did not return JSON");
    }
    expect(ran.exitCode).toBe(0);
    expect(receipt).toEqual({ ok: true, data: result, error: null });
    const generated = (root: string) =>
      tree(root).filter(
        ([path]) => path.startsWith(".agents/") || path.startsWith(".codex/"),
      );
    expect(generated(first)).toEqual(generated(second));
    // Legacy commands retain filesystem enumeration: Windows and Linux reverse
    // the two-command notes list. These exact original-tree digests differ only
    // by that display order; every other generated byte remains pinned.
    expect([
      "62c48c393e8585f8bdb43df47d1ae46f558e0b58580c7ddf2b8e4f0e60ab76ec",
      "d1e5ab50458d716315afdefdc62c705f8ffec405c4f143b9c8a24b92ab92abc4",
    ]).toContain(
      createHash("sha256")
        .update(JSON.stringify(generated(first)))
        .digest("hex"),
    );
    expect(tree(join(first, ".claude"))).toEqual(original);
    expect(tree(join(second, ".claude"))).toEqual(original);
    expect(readFileSync(join(first, ".agents/manual.txt"), "utf8")).toBe(
      "Adjacent hand-authored file.\n",
    );
    expect(existsSync(join(first, ".agents/skills/stale.txt"))).toBe(false);
    expect(existsSync(join(first, ".codex/stale.txt"))).toBe(false);
  });

  test("the closed entry refuses caller paths and commands before touching any generated file", () => {
    const root = harnessRoot();
    write(root, ".agents/skills/kept.txt", "Do not change.\n");
    for (const args of [
      ["--root", root],
      ["--codex-sync", root],
      ["--command", "anything"],
    ]) {
      const child = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      let receipt: unknown;
      try {
        receipt = JSON.parse(child.stdout.toString());
      } catch {
        throw new Error("Sync refusal did not return JSON");
      }
      expect(child.exitCode).toBe(1);
      expect(receipt).toMatchObject({ ok: false, data: null });
      expect(readFileSync(join(root, ".agents/skills/kept.txt"), "utf8")).toBe(
        "Do not change.\n",
      );
      expect(existsSync(join(root, ".codex"))).toBe(false);
    }
  });

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
    let printed: {
      ok: boolean;
      data: { skills: number; commandsConverted: number };
    };
    try {
      printed = JSON.parse(ran.stdout);
    } catch {
      throw new Error("Sync entry did not return JSON");
    }
    expect(printed.ok).toBe(true);
    expect(printed.data.skills).toBe(1);
    expect(printed.data.commandsConverted).toBe(2);
  });
});
