import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitRun } from "../scheduler/worktrees";
import { scratchDirs } from "../test-scratch";
import {
  collectKnowledgeSource,
  createKnowledgeGit,
  readKnowledgeTarget,
  resolveKnowledgeTarget,
} from "./knowledge-source";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
test("production knowledge Git boundary strips ambient redirects and disables incidental commands", () => {
  let invoked = 0;
  const git = createKnowledgeGit({
    platform: "win32",
    environment: {
      PATH: "C:/Git/bin",
      SystemRoot: "C:/Windows",
      GIT_DIR: "C:/foreign",
      GIT_WORK_TREE: "C:/private",
      GIT_CONFIG_PARAMETERS: "unsafe",
      GIT_TRACE: "C:/leak",
      AGENT_FORGE_HOME: "C:/private-profile",
      ANTHROPIC_API_KEY: "private-key",
    },
    spawn: (command, args, options) => {
      invoked++;
      expect(command).toBe("git");
      expect(args).toContain("core.fsmonitor=false");
      expect(args).toContain("core.hooksPath=NUL");
      expect(args).toContain("maintenance.auto=false");
      expect(args).toContain("gc.auto=0");
      expect(options.windowsHide).toBe(true);
      expect(options.timeout).toBe(5000);
      expect(options.maxBuffer).toBe(512 * 1024);
      expect(options.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "NUL",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      });
      for (const key of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_CONFIG_PARAMETERS",
        "GIT_TRACE",
        "AGENT_FORGE_HOME",
        "ANTHROPIC_API_KEY",
      ])
        expect(options.env[key]).toBeUndefined();
      return { status: 0, stdout: "a".repeat(40), stderr: "" };
    },
  });
  expect(
    git(["rev-parse", "--verify", "HEAD"], "C:/served", 60_000).status,
  ).toBe(0);
  expect(invoked).toBe(1);
  expect(git(["status"], "C:/served").status).toBeNull();
  expect(invoked).toBe(1);
});
function fixture() {
  const root = scratch.make("knowledge-source-");
  let main = join(root, "alpha");
  mkdirSync(join(main, ".git"), { recursive: true });
  mkdirSync(join(main, "src"));
  main = realpathSync.native(main);
  writeFileSync(join(main, "README.md"), "# Alpha\nA real source description.");
  writeFileSync(
    join(main, "package.json"),
    JSON.stringify({ name: "alpha", scripts: { test: "bun test" } }),
  );
  writeFileSync(join(main, "src", "index.ts"), "export const value = 1;\n");
  const commands: string[][] = [];
  let commit = "a".repeat(40);
  const tracked = ["README.md", "package.json", "src/index.ts", ".env"];
  const git: GitRun = (args, cwd) => {
    commands.push([...args]);
    let stdout = "";
    if (args.includes("--git-common-dir")) stdout = join(main, ".git");
    else if (args.includes("--show-toplevel")) stdout = main;
    else if (args.includes("HEAD")) stdout = commit;
    else if (args[0] === "ls-files") stdout = tracked.join("\0") + "\0";
    else if (args[0] === "log")
      stdout = `${commit}\t2026-11-06T00:00:00+00:00\tInitial source\n`;
    else throw Error(`Unexpected Git read: ${args}`);
    expect(cwd).toBe(main);
    return { status: 0, stdout, stderr: "" };
  };
  return {
    main,
    git,
    commands,
    tracked,
    advance: () => {
      commit = "b".repeat(40);
    },
  };
}
test("known credential paths and Windows private-directory case variants are excluded before reading bytes", () => {
  const f = fixture(),
    privatePaths = [
      "credentials.json",
      "SECRETS.json",
      "secrets.yaml",
      "secrets.yml",
      ".AWS/config.json",
      ".CODEX/auth.json",
      ".ENV.production",
      "nested/private.PEM",
    ];
  for (const path of privatePaths) {
    const file = join(f.main, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0xff]));
    f.tracked.push(path);
  }
  const source = collectKnowledgeSource(
    resolveKnowledgeTarget(f.main, f.git),
    f.git,
  );
  expect(source.files.map((file) => file.path)).toEqual([
    "README.md",
    "package.json",
    "src/index.ts",
  ]);
  for (const path of privatePaths)
    expect(JSON.stringify(source)).not.toContain(path);
});
test("knowledge source reads only fixed served authority, hashes bounded tracked evidence and preserves actual age", () => {
  const f = fixture(),
    target = resolveKnowledgeTarget(f.main, f.git);
  const before = readKnowledgeTarget(
    target,
    new Date("2026-11-06T00:00:00.000Z").getTime(),
  );
  expect(before.state).toBe("missing");
  writeFileSync(join(f.main, ".env"), "PRIVATE must not be read");
  const source = collectKnowledgeSource(target, f.git);
  expect(source.files.map((file) => file.path)).toEqual([
    "README.md",
    "package.json",
    "src/index.ts",
  ]);
  expect(JSON.stringify(source)).not.toContain("PRIVATE must not be read");
  expect(source.sourceCommit).toBe("a".repeat(40));
  expect(source.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  mkdirSync(join(f.main, "knowledge", "repos"), { recursive: true });
  writeFileSync(target.file, "overview:\n  name: alpha\n");
  const actualMtime = readKnowledgeTarget(target).snapshot.mtimeMs;
  if (actualMtime === null) throw Error("Expected written knowledge mtime");
  const written = readKnowledgeTarget(target, actualMtime + 30 * 86_400_000);
  expect(written.state).toBe("present");
  expect(written.ageDays).toBe(30);
  expect(written.freshness).toBe("aging");
  expect(
    readKnowledgeTarget(target, actualMtime + 31 * 86_400_000).freshness,
  ).toBe("stale");
  expect(
    f.commands.every((args) =>
      ["rev-parse", "ls-files", "log"].includes(args[0]!),
    ),
  ).toBe(true);
});
test("source snapshots change with source bytes or HEAD and unsafe/incompatible prior output remains untouched", () => {
  const f = fixture(),
    target = resolveKnowledgeTarget(f.main, f.git),
    first = collectKnowledgeSource(target, f.git);
  writeFileSync(join(f.main, "src", "index.ts"), "export const value = 2;\n");
  expect(collectKnowledgeSource(target, f.git).evidenceHash).not.toBe(
    first.evidenceHash,
  );
  f.advance();
  expect(collectKnowledgeSource(target, f.git).sourceCommit).toBe(
    "b".repeat(40),
  );
  mkdirSync(join(f.main, "knowledge", "repos"), { recursive: true });
  const invalid = "overview: !foreign tagged\n";
  writeFileSync(target.file, invalid);
  expect(() => readKnowledgeTarget(target, Date.now())).toThrow();
  expect(readFileSync(target.file, "utf8")).toBe(invalid);
});
