/**
 * The git guardrail registered for PreToolUse on the Bash tool
 * (`.claude/hooks/block-dangerous-git.sh`), spawned the way the host runs a
 * hook command: the command line from `.claude/settings.json`, through
 * `bash -c`, with `CLAUDE_PROJECT_DIR` set to this checkout and a PreToolUse
 * payload for the Bash tool piped on stdin.
 *
 * Each group hands bash a PATH that reaches `cat`; the system's `grep`, unless
 * its title says otherwise; and `bun`, `jq` or neither, as its title says. Its
 * first test asks that bash which of them it finds. With the system's `grep`,
 * the Windows PATH is Git for Windows' `usr\bin` (which holds no `jq` or `bun`)
 * and, where named, the directory of the `bun` running this suite. On other
 * platforms it is a scratch directory of links to the named programs.
 * The group with `jq` runs where a `jq` is on this suite's PATH, and always
 * under CI; it also compares what `jq -r '.tool_input.command'` and
 * `read-tool-command.ts` (the reader the script runs without jq) print for the
 * same payloads.
 *
 * Two groups take the system's `grep` away. One has no `grep` on PATH at all;
 * the other has a stand-in `grep` script that exits 2. On Windows, where
 * `usr\bin` holds `grep` beside `cat`, `usr\bin` stays off their PATH and a
 * stand-in `cat` script runs `/usr/bin/cat` instead.
 *
 * These prove what the script decides for a payload under a given PATH. They
 * do not prove that a live session calls it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { toolCommandText } from "../.claude/hooks/read-tool-command";

const ROOT = join(import.meta.dir, "..");
const READER = join(ROOT, ".claude", "hooks", "read-tool-command.ts");
const WINDOWS = process.platform === "win32";
const SPAWN_TIMEOUT_MS = 60_000;

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file a child still holds on Windows: the OS temp directory reclaims it.
    }
  }
});

/** The commands registered for PreToolUse on the Bash tool. */
function registeredCommands(): string[] {
  const settings = JSON.parse(
    readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"),
  ) as {
    hooks: Record<
      string,
      Array<{ matcher?: string; hooks: Array<{ command: string }> }>
    >;
  };
  return (settings.hooks.PreToolUse ?? [])
    .filter((entry) => entry.matcher === "Bash")
    .flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

/**
 * The bash that runs the command line. On Windows it is Git for Windows' own
 * `usr\bin\bash.exe`, found from `git` on PATH: the host runs hooks through Git
 * Bash, and System32's `bash.exe` is the WSL launcher.
 */
function findBash(): string {
  if (!WINDOWS) {
    const bash = Bun.which("bash");
    if (bash === null) throw new Error("no bash on PATH");
    return bash;
  }
  const vcs = Bun.which("git");
  if (vcs !== null) {
    // git.exe is in <root>\cmd, <root>\bin or <root>\mingw64\bin.
    let dir = dirname(vcs);
    for (let up = 0; up < 3; up++) {
      const bash = join(dir, "usr", "bin", "bash.exe");
      if (existsSync(bash)) return bash;
      dir = dirname(dir);
    }
  }
  throw new Error("no Git for Windows bash found from git on PATH");
}

const BASH = findBash();

function which(name: string): string {
  const found = Bun.which(name);
  if (found === null) throw new Error(`no ${name} on PATH`);
  return found;
}

interface Tools {
  bun: boolean;
  jq: boolean;
  /** No `grep` on PATH, or a stand-in that exits 2. Left out: the system's. */
  grep?: "none" | "exits 2";
}

interface Box {
  root: string;
  cwd: string;
  env: Record<string, string>;
}

/** An executable bash script `name` in `dir` that runs `body`. */
function writeScript(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

/**
 * The PATH for bash: `cat`, `grep` as `tools.grep` says, and `bun` and `jq`
 * where `tools` says.
 */
function toolPath(root: string, tools: Tools): string {
  if (WINDOWS) {
    const dirs: string[] = [];
    if (tools.grep === undefined) {
      dirs.push(dirname(BASH));
    } else {
      // usr\bin holds grep beside cat, so it stays off this PATH: the stand-in
      // cat runs the one there by its path in Git Bash.
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeScript(bin, "cat", 'exec /usr/bin/cat "$@"');
      if (tools.grep === "exits 2") writeScript(bin, "grep", "exit 2");
      dirs.push(bin);
    }
    if (tools.bun) dirs.push(dirname(process.execPath));
    if (tools.jq) dirs.push(dirname(which("jq")));
    return dirs.join(";");
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  const links: Array<[string, string]> = [["cat", which("cat")]];
  if (tools.grep === undefined) links.push(["grep", which("grep")]);
  if (tools.bun) links.push(["bun", process.execPath]);
  if (tools.jq) links.push(["jq", which("jq")]);
  for (const [name, target] of links) symlinkSync(target, join(bin, name));
  if (tools.grep === "exits 2") writeScript(bin, "grep", "exit 2");
  return bin;
}

/**
 * A scratch directory and a from-scratch environment for the child: nothing of
 * the parent's is inherited except what a Windows child needs to start.
 */
function sandbox(tools: Tools): Box {
  const root = mkdtempSync(join(tmpdir(), "git guardrail test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  const home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  const env: Record<string, string> = {
    PATH: toolPath(root, tools),
    CLAUDE_PROJECT_DIR: ROOT,
    HOME: home,
    USERPROFILE: home,
    AGENT_FORGE_HOME: join(home, ".agent-forge"),
  };
  for (const name of ["SystemRoot", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { root, cwd, env };
}

interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(box: Box, argv: string[], stdin = ""): Promise<Ran> {
  const child = Bun.spawn(argv, {
    cwd: box.cwd,
    env: box.env,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

const bash = (box: Box, args: string[], stdin = ""): Promise<Ran> =>
  run(box, [BASH, ...args], stdin);

/**
 * Carriage returns dropped: a native jq.exe on Windows ends its output lines
 * with CRLF, and bash keeps the CR in the command it echoes back.
 */
const lf = (text: string): string => text.replaceAll("\r", "");

/** Run the registered hook command with `stdin` as its payload. */
async function guard(box: Box, stdin: string): Promise<Ran> {
  const [command] = registeredCommands();
  if (command === undefined) throw new Error("no PreToolUse hook for Bash");
  return bash(box, ["-c", command], stdin);
}

/** Which of the named programs the child's bash finds on its PATH. */
async function reachable(box: Box, names: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const name of names) {
    const ran = await bash(box, ["-c", 'command -v "$1"', "bash", name]);
    if (ran.exitCode === 0) found.push(name);
  }
  return found;
}

/** A PreToolUse payload for the Bash tool, with the fields the host documents. */
function preToolUse(
  command: string,
  description = "Run a command",
): Record<string, unknown> {
  return {
    session_id: "5d0f3a52-9c1e-4b7a-8e2f-bq2x00000001",
    transcript_path:
      "C:\\Users\\someone\\.claude\\projects\\C--repo\\5d0f3a52-9c1e-4b7a-8e2f-bq2x00000001.jsonl",
    cwd: "C:\\Users\\someone\\repo",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description },
    tool_use_id: "toolu_01Bq2xGuardrailTest",
  };
}

const payload = (command: string, description?: string): string =>
  JSON.stringify(preToolUse(command, description));

/** Commands the script blocks, each with the first pattern that matches it. */
const BLOCKED: ReadonlyArray<readonly [string, string]> = [
  ["git push --force origin master", "push --force"],
  ["git push -f origin master", "push -f"],
  ["git reset --hard HEAD~1", "reset --hard"],
  ["git clean -fd", "git clean -fd"],
  ["git clean -f src", "git clean -f "],
  ["git branch -D feature", "git branch -D"],
  ["git checkout .", "git checkout \\."],
  ["git restore .", "git restore \\."],
  // Escaped in the JSON payload: double quotes, and a newline.
  ['git commit -m "wip" && git reset --hard HEAD', "reset --hard"],
  ["git status\ngit push --force", "push --force"],
];

/** Commands no pattern matches. */
const ALLOWED: readonly string[] = [
  "git push origin master",
  "git status --short",
  "git checkout -b feature",
  "git branch -d merged",
  "git clean -n",
];

/** The tests a PATH with a working reader must pass. */
function readsTheCommand(tools: Tools): void {
  for (const [command, pattern] of BLOCKED) {
    test(
      `blocks ${JSON.stringify(command)} with exit 2, naming the pattern ${JSON.stringify(pattern)}`,
      async () => {
        const ran = await guard(sandbox(tools), payload(command));
        expect(ran.exitCode).toBe(2);
        expect(lf(ran.stderr)).toContain(
          `BLOCKED: '${command}' matches dangerous pattern '${pattern}'.`,
        );
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  for (const command of ALLOWED) {
    test(
      `lets ${JSON.stringify(command)} through with exit 0 and nothing on stderr`,
      async () => {
        const ran = await guard(sandbox(tools), payload(command));
        expect(ran).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  test(
    "checks tool_input.command only: a description that names a blocked command does not block git status",
    async () => {
      const ran = await guard(
        sandbox(tools),
        payload("git status", "Never run git push --force or git reset --hard"),
      );
      expect(ran).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "lets a payload with no tool_input.command through with exit 0",
    async () => {
      const body = preToolUse("unused");
      const ran = await guard(
        sandbox(tools),
        JSON.stringify({ ...body, tool_input: { description: "no command" } }),
      );
      expect(ran).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "blocks with exit 2 when the payload is not valid JSON",
    async () => {
      const ran = await guard(
        sandbox(tools),
        payload("git push --force origin master").slice(0, -20),
      );
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain("BLOCKED:");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "blocks with exit 2 when tool_input is a string, not an object",
    async () => {
      const body = preToolUse("unused");
      const ran = await guard(
        sandbox(tools),
        JSON.stringify({ ...body, tool_input: "git status" }),
      );
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain("BLOCKED:");
    },
    SPAWN_TIMEOUT_MS,
  );
}

describe("the PreToolUse hook registered for the Bash tool", () => {
  test("is one command, and it runs block-dangerous-git.sh", () => {
    const commands = registeredCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(".claude/hooks/block-dangerous-git.sh");
  });
});

/** Payloads for the reader: what it does, the payload, and its output (null: it fails). */
const READS: ReadonlyArray<
  readonly [string, Record<string, unknown>, string | null]
> = [
  [
    "gives a string command as it is",
    { tool_input: { command: 'git commit -m "a\nb"' } },
    'git commit -m "a\nb"',
  ],
  ["gives null with no tool_input", { tool_name: "Bash" }, "null"],
  ["gives null for a null tool_input", { tool_input: null }, "null"],
  ["gives null with no command", { tool_input: { description: "d" } }, "null"],
  ["gives null for a null command", { tool_input: { command: null } }, "null"],
  ["gives a number command as JSON", { tool_input: { command: 5 } }, "5"],
  [
    "gives an array command as indented JSON",
    { tool_input: { command: ["git", "push", "--force"] } },
    '[\n  "git",\n  "push",\n  "--force"\n]',
  ],
  [
    "gives an object command as indented JSON",
    { tool_input: { command: { run: "git reset --hard" } } },
    '{\n  "run": "git reset --hard"\n}',
  ],
  ["fails on a string tool_input", { tool_input: "git push --force" }, null],
  ["fails on an array tool_input", { tool_input: ["git push --force"] }, null],
];

describe("toolCommandText in read-tool-command.ts", () => {
  for (const [what, input, expected] of READS) {
    test(what, () => {
      expect(toolCommandText(input)).toBe(expected);
    });
  }
});

describe("the git guardrail with no jq on PATH and bun on PATH", () => {
  const tools: Tools = { bun: true, jq: false };

  test(
    "bash on this PATH finds cat, grep and bun, and no jq",
    async () => {
      expect(
        await reachable(sandbox(tools), ["cat", "grep", "bun", "jq"]),
      ).toEqual(["cat", "grep", "bun"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  readsTheCommand(tools);
});

describe("the git guardrail with neither jq nor bun on PATH", () => {
  const tools: Tools = { bun: false, jq: false };

  test(
    "bash on this PATH finds cat and grep, and no jq or bun",
    async () => {
      expect(
        await reachable(sandbox(tools), ["cat", "grep", "bun", "jq"]),
      ).toEqual(["cat", "grep"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "blocks git push --force origin master with exit 2, saying the payload cannot be read",
    async () => {
      const ran = await guard(
        sandbox(tools),
        payload("git push --force origin master"),
      );
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain("BLOCKED:");
      expect(ran.stderr).toContain("neither jq nor bun is on PATH");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "blocks git status --short too: a command it cannot read is refused",
    async () => {
      const ran = await guard(sandbox(tools), payload("git status --short"));
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain("neither jq nor bun is on PATH");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("the git guardrail with bun on PATH and no grep", () => {
  const tools: Tools = { bun: true, jq: false, grep: "none" };

  test(
    "bash on this PATH finds cat and bun, and no grep or jq",
    async () => {
      expect(
        await reachable(sandbox(tools), ["cat", "grep", "bun", "jq"]),
      ).toEqual(["cat", "bun"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "blocks git push --force origin master with exit 2, saying grep exited 127",
    async () => {
      const ran = await guard(
        sandbox(tools),
        payload("git push --force origin master"),
      );
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain(
        "BLOCKED: grep exited 127 checking the command against pattern 'push --force'.",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "blocks git status --short too: with no grep it checks no command",
    async () => {
      const ran = await guard(sandbox(tools), payload("git status --short"));
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain("BLOCKED: grep exited 127 ");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("the git guardrail with bun on PATH and a grep that exits 2", () => {
  const tools: Tools = { bun: true, jq: false, grep: "exits 2" };

  test(
    "bash on this PATH finds cat, grep and bun, and no jq",
    async () => {
      expect(
        await reachable(sandbox(tools), ["cat", "grep", "bun", "jq"]),
      ).toEqual(["cat", "grep", "bun"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "blocks git push --force origin master with exit 2, saying grep exited 2",
    async () => {
      const ran = await guard(
        sandbox(tools),
        payload("git push --force origin master"),
      );
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain(
        "BLOCKED: grep exited 2 checking the command against pattern 'push --force'.",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "blocks git status --short too: a grep that exits 2 checks no command",
    async () => {
      const ran = await guard(sandbox(tools), payload("git status --short"));
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain("BLOCKED: grep exited 2 ");
    },
    SPAWN_TIMEOUT_MS,
  );
});

// Skipped where this suite finds no jq, except under CI, whose runner has one:
// there a missing jq fails the group instead of passing over it.
describe.skipIf(Bun.which("jq") === null && process.env.CI === undefined)(
  "the git guardrail with jq on PATH and no bun",
  () => {
    const tools: Tools = { bun: false, jq: true };

    test(
      "bash on this PATH finds cat, grep and jq, and no bun",
      async () => {
        expect(
          await reachable(sandbox(tools), ["cat", "grep", "bun", "jq"]),
        ).toEqual(["cat", "grep", "jq"]);
      },
      SPAWN_TIMEOUT_MS,
    );

    readsTheCommand(tools);

    test(
      "jq -r '.tool_input.command' and read-tool-command.ts print the same for each reader payload and fail on the same ones",
      async () => {
        const box = sandbox(tools);
        const texts = [
          ...READS.map(([, input]) => JSON.stringify(input)),
          payload("git push --force origin master").slice(0, -20),
        ];
        for (const text of texts) {
          const jq = await run(
            box,
            [which("jq"), "-r", ".tool_input.command"],
            text,
          );
          const reader = await run(
            box,
            [process.execPath, "run", READER],
            text,
          );
          expect({
            text,
            ok: reader.exitCode === 0,
            stdout: reader.stdout,
          }).toEqual({ text, ok: jq.exitCode === 0, stdout: lf(jq.stdout) });
        }
      },
      SPAWN_TIMEOUT_MS,
    );
  },
);
