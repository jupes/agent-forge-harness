import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { syncCodexSkills } from "../executors/codex-sync";
import { buildChildEnv } from "../executors/env";
import { verifyKeeperReader } from "../keeper/verify-reader";
import { createCodexTaskRuntime } from "../sessions/codex-task-runtime";
import { syncCodex } from "../sync-codex";
import { scratchDirs } from "../test-scratch";

const scratch = scratchDirs();
const root = resolve(import.meta.dir, "../..");
let executable: string;
let provider: string;
function environment(home: string) {
  const base = Object.fromEntries(
    Object.entries(buildChildEnv(process.env, [])).filter(
      ([key]) => key.toLowerCase() !== "path",
    ),
  );
  return {
    ...base,
    PATH: "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    AGENT_FORGE_HOME: join(home, "private-home"),
  };
}
beforeAll(() => {
  const folder = scratch.make("packaged-codex-sync-binary-");
  executable = join(
    folder,
    `hearth${process.platform === "win32" ? ".exe" : ""}`,
  );
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(root, "scripts/hearth/compiled-entry.ts"),
      "--outfile",
      executable,
    ],
    {
      cwd: folder,
      env: environment(folder),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  if (built.exitCode !== 0)
    throw new Error(
      `Packaged sync oracle did not compile: ${built.stderr.toString().slice(-2000)}`,
    );
  provider = join(folder, `codex${process.platform === "win32" ? ".exe" : ""}`);
  const providerEntry = join(folder, "provider-fixture.ts");
  writeFileSync(
    providerEntry,
    `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCodexTaskRuntimeFixture } from ${JSON.stringify(join(root, "scripts/sessions/fixtures/codex-task-runtime-fixture.ts").replaceAll("\\", "/"))};
if (!process.argv.includes("--version") && !process.argv.includes("--help") &&
    !existsSync(join(process.cwd(), ".agents/skills/one/SKILL.md"))) process.exit(19);
await runCodexTaskRuntimeFixture();
`,
  );
  const fake = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      providerEntry,
      "--outfile",
      provider,
    ],
    {
      cwd: folder,
      env: environment(folder),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  if (fake.exitCode !== 0)
    throw new Error(
      `Packaged fake provider did not compile: ${fake.stderr.toString().slice(-2000)}`,
    );
}, 65_000);
afterAll(() => scratch.cleanup());

function plantedRoot() {
  const folder = scratch.make("packaged-codex-sync-root-");
  for (const name of [
    ".git",
    ".claude/skills/one",
    ".claude/commands",
    ".claude/agents",
  ])
    mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(
    join(folder, ".claude/skills/one/SKILL.md"),
    "# Disposable one 🌱\n",
  );
  writeFileSync(
    join(folder, ".claude/commands/alpha.md"),
    "# Alpha\n\nExact body.\n",
  );
  return folder;
}
test("the production compiled hearth syncs its chosen cwd without ambient Bun or source scripts", () => {
  const folder = plantedRoot();
  const result = Bun.spawnSync([executable, "--codex-sync"], {
    cwd: folder,
    env: environment(folder),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
  let receipt: unknown;
  try {
    receipt = JSON.parse(result.stdout.toString());
  } catch {
    throw new Error("Packaged sync did not return its metadata envelope");
  }
  expect(receipt).toMatchObject({
    ok: true,
    data: { skills: 1, commandsConverted: 1 },
    error: null,
  });
  expect(
    readFileSync(join(folder, ".agents/skills/one/SKILL.md"), "utf8"),
  ).toBe("# Disposable one 🌱\n");
  expect(existsSync(join(folder, "scripts"))).toBe(false);
  expect(existsSync(join(folder, "package.json"))).toBe(false);
  expect(existsSync(join(folder, "private-home"))).toBe(false);
}, 10_000);

function generated(root: string, relative = ""): Array<[string, string]> {
  return readdirSync(join(root, relative), { withFileTypes: true })
    .flatMap<[string, string]>((entry) => {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? generated(root, path)
        : [[path, readFileSync(join(root, path)).toString("base64")]];
    })
    .filter(([path]) =>
      !relative
        ? path.startsWith(".agents/") || path.startsWith(".codex/")
        : true,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

test("packaged sync produces the source mirror only in the canonical linked checkout", async () => {
  const main = plantedRoot(),
    worktree = scratch.make("packaged-codex-linked-");
  const gitdir = join(main, ".git/worktrees/linked");
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
  mkdirSync(join(worktree, ".claude/skills/one"), { recursive: true });
  mkdirSync(join(worktree, ".claude/commands"), { recursive: true });
  mkdirSync(join(worktree, ".claude/agents"), { recursive: true });
  writeFileSync(
    join(worktree, ".claude/skills/one/SKILL.md"),
    "# Linked checkout's own source\n",
  );
  const reference = plantedRoot();
  writeFileSync(
    join(reference, ".claude/skills/one/SKILL.md"),
    "# Linked checkout's own source\n",
  );
  // Every generated byte comes from the linked checkout's own source.
  writeFileSync(
    join(worktree, ".claude/commands/alpha.md"),
    "# Alpha\n\nExact body.\n",
  );
  syncCodex(reference);
  await syncCodexSkills({
    workspace: main,
    worktree,
    command: [executable, "--codex-sync"],
    env: environment(worktree),
    timeoutMs: 5000,
  });
  expect(generated(worktree)).toEqual(generated(reference));
  expect(existsSync(join(main, ".agents"))).toBe(false);
  const foreign = plantedRoot();
  await syncCodexSkills({
    workspace: main,
    worktree: foreign,
    command: [executable, "--codex-sync"],
    env: environment(foreign),
    timeoutMs: 5000,
  });
  expect(existsSync(join(foreign, ".agents"))).toBe(false);
});

test("fixed packaged sync rejects extra caller paths or commands without creating server state or changing either root", () => {
  const folder = plantedRoot(),
    other = plantedRoot();
  for (const args of [["--root", other], [other], ["--command", provider]]) {
    const result = Bun.spawnSync([executable, "--codex-sync", ...args], {
      cwd: folder,
      env: environment(folder),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    let value: unknown;
    try {
      value = JSON.parse(result.stdout.toString());
    } catch {
      throw new Error("Packaged refusal did not return JSON");
    }
    expect(value).toMatchObject({ ok: false, data: null });
    for (const root of [folder, other]) {
      expect(existsSync(join(root, ".agents"))).toBe(false);
      expect(existsSync(join(root, ".codex"))).toBe(false);
      expect(existsSync(join(root, "private-home"))).toBe(false);
    }
  }
});

test("a native Task uses the fixed packaged sync before provider dispatch and never dispatches after sync refusal", async () => {
  for (const valid of [true, false]) {
    const folder = valid
      ? plantedRoot()
      : scratch.make("packaged-codex-no-source-");
    if (!valid) mkdirSync(join(folder, ".git"));
    const configHome = join(folder, "config"),
      home = join(folder, "home");
    mkdirSync(configHome);
    mkdirSync(home);
    writeFileSync(
      join(folder, "agent-forge.toml"),
      '[execution.env]\npass = ["CODEX_RUNTIME_LOG"]\n',
    );
    const log = join(folder, "provider.jsonl");
    const runtime = createCodexTaskRuntime({
      root: folder,
      home,
      configHome,
      command: [provider],
      syncCommand: [executable, "--codex-sync"],
      environment: { ...environment(folder), CODEX_RUNTIME_LOG: log },
      timeoutMs: 5000,
    });
    const snapshot = await runtime.prepare({
      smith: "codex-journeyman",
      launch: {
        mode: "task",
        cwd: folder,
        model: "gpt-example-exact",
        sandbox: "read-only",
        approvalPolicy: "never",
        prompt: "Private planted input",
      },
    });
    const result = await runtime.run(
      snapshot,
      async () => {},
      new AbortController().signal,
    );
    let lines: unknown[];
    try {
      lines = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error("Fake native provider did not record its calls");
    }
    expect(result.phase).toBe(valid ? "completed" : "failed");
    expect(lines).toHaveLength(valid ? 5 : 4);
    expect(JSON.stringify(lines)).toContain(
      valid ? '"kind":"task"' : '"kind":"help"',
    );
    if (!valid) expect(JSON.stringify(lines)).not.toContain('"kind":"task"');
  }
}, 15_000);

test("the same compiled production entry retains the sealed Keeper reader", async () => {
  expect(
    await verifyKeeperReader([executable, "--keeper-reader"]),
  ).toMatchObject({
    oneReadonlyTool: true,
    projectScoped: true,
    scopeChangeRefused: true,
    noOperatorAction: true,
    childStopped: true,
  });
}, 20_000);
