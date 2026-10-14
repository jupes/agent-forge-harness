import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Smith } from "../../types/hearth";
import { BUILTIN_BENCHES, BUILTIN_SMITHS } from "../config/defaults";
import type { ForgeConfig } from "../config/load";
import { claudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import {
  doctorLine,
  makeTaskDirectory,
  runDoctor,
  TASK_PROMPT,
  type TaskCheckOptions,
  taskSmiths,
} from "./doctor-cli";
import { buildChildEnv } from "./env";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const fake = (provider: string, mode = "ok") => [
  process.execPath,
  FAKE,
  "--fake-provider",
  provider,
  "--fake-mode",
  mode,
];

const adapters = {
  claude: claudeAdapter,
  codex: createCodexAdapter({ prepare: () => undefined }),
};

const smith = (name: string) => BUILTIN_SMITHS[name] as Smith;

/**
 * Task-check options that never reach a real CLI or the OS home: a harness
 * root that is its own checkout, and task directories made inside it (each
 * planted with a `.git` directory, as every temp root in these tests is).
 */
function taskSetup() {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge doctor ")),
  );
  mkdirSync(join(root, ".git"));
  const made: string[] = [];
  const options: TaskCheckOptions = {
    smiths: {
      claude: smith("claude-journeyman"),
      codex: smith("codex-journeyman"),
    },
    harnessRoot: root,
    env: buildChildEnv(process.env, []),
    timeoutMs: 30_000,
    makeDirectory: () => {
      const dir = join(root, `task ${made.length}`);
      mkdirSync(join(dir, ".git"), { recursive: true });
      made.push(dir);
      return dir;
    },
  };
  return { root, made, options };
}

describe("forge:doctor without --task (fake binary)", () => {
  test("a binary that answers --version but is not signed in is reported as answering --version, with the task check not run", async () => {
    const [report] = await runDoctor(
      { claude: claudeAdapter },
      { claude: fake("claude", "auth") },
    );
    expect(report).toMatchObject({
      provider: "claude",
      found: true,
      ok: true,
      version: "fake-claude 0.0.1",
      task: null,
    });
    const line = doctorLine(report as NonNullable<typeof report>);
    expect(line).toStartWith("claude: answers --version (fake-claude 0.0.1)");
    expect(line).toEndWith(
      "can it run a task? not checked (bun run forge:doctor --task)",
    );
  });
});

describe("forge:doctor --task (fake binary)", () => {
  test("a binary whose sign-in is rejected answers --version but cannot run a task, and the provider's reason is given", async () => {
    const { options } = taskSetup();
    const [report] = await runDoctor(
      { claude: claudeAdapter },
      { claude: fake("claude", "auth") },
      options,
    );
    expect(report).toMatchObject({
      found: true,
      ok: true,
      task: {
        ok: false,
        smith: "claude-journeyman",
        tools: 0,
        reason: "provider exited 1: not signed in (fake)",
      },
    });
    expect(doctorLine(report as NonNullable<typeof report>)).toEndWith(
      "cannot run a task with claude-journeyman: provider exited 1: not signed in (fake)",
    );
  });

  test("a codex with no tool host answers --version and exits 0 on the task, but cannot run a task", async () => {
    const { options } = taskSetup();
    const [report] = await runDoctor(
      { codex: adapters.codex },
      { codex: fake("codex", "no-tool-host") },
      options,
    );
    expect(report).toMatchObject({
      ok: true,
      task: {
        ok: false,
        smith: "codex-journeyman",
        tools: 0,
        reason:
          "provider exited 0 but reported an error: the tool host was not found, so no command can run (fake)",
      },
    });
  });

  test("a binary that exits 0 without calling a tool, and reports no error, cannot run a task", async () => {
    const { options } = taskSetup();
    const [report] = await runDoctor(
      { claude: claudeAdapter },
      { claude: fake("claude", "no-tools") },
      options,
    );
    expect(report?.task).toMatchObject({
      ok: false,
      tools: 0,
      reason: "the provider exited 0 without calling a tool",
    });
  });

  test("a binary that calls tools and exits 0 can run a task; the task runs in its own directory with the task prompt on stdin", async () => {
    const { root, made, options } = taskSetup();
    const dump = join(root, "dump.json");
    const report = await runDoctor(
      adapters,
      {
        claude: [...fake("claude"), "--fake-dump", dump],
        codex: fake("codex"),
      },
      options,
    );
    expect(report).toMatchObject([
      {
        provider: "claude",
        ok: true,
        task: { ok: true, smith: "claude-journeyman", tools: 2 },
      },
      {
        provider: "codex",
        ok: true,
        task: { ok: true, smith: "codex-journeyman", tools: 2 },
      },
    ]);
    expect(report[0]?.task).not.toHaveProperty("reason");
    expect(doctorLine(report[0] as NonNullable<(typeof report)[0]>)).toEndWith(
      "ran a task with claude-journeyman (tool calls: 2)",
    );

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.stdin).toBe(TASK_PROMPT);
    expect(made).toHaveLength(2);
    expect(made.map((dir) => dir.toLowerCase())).toContain(
      String(seen.cwd).toLowerCase(),
    );
    expect(report[0]?.task?.directory?.toLowerCase()).toBe(
      String(seen.cwd).toLowerCase(),
    );
  });

  test("a binary that does not answer --version is not given a task", async () => {
    const { made, options } = taskSetup();
    const [report] = await runDoctor(
      { claude: claudeAdapter },
      {
        claude: [process.execPath, join(tmpdir(), "no-such-claude-script.ts")],
      },
      options,
    );
    expect(report).toMatchObject({ found: true, ok: false, task: null });
    expect(made).toEqual([]);
    expect(doctorLine(report as NonNullable<typeof report>)).toStartWith(
      "claude: does not answer --version (version check exited ",
    );
  });

  test("a binary that is not found is not given a task, and the line says it is not found", async () => {
    const { made, options } = taskSetup();
    const missing = join(tmpdir(), "no-such-claude-binary");
    const [report] = await runDoctor(
      { claude: claudeAdapter },
      { claude: [missing] },
      options,
    );
    expect(report).toMatchObject({ found: false, ok: false, task: null });
    expect(made).toEqual([]);
    expect(doctorLine(report as NonNullable<typeof report>)).toBe(
      `claude: not found (${missing} not found)`,
    );
  });

  test("a task whose directory cannot be made is reported as not run, with why, and the doctor does not throw", async () => {
    const { options } = taskSetup();
    const [report] = await runDoctor(
      { claude: claudeAdapter },
      { claude: fake("claude") },
      {
        ...options,
        makeDirectory: () => {
          throw new Error("no room for a task directory (test)");
        },
      },
    );
    expect(report).toMatchObject({
      ok: true,
      task: {
        ok: false,
        smith: "claude-journeyman",
        tools: 0,
        reason: "no room for a task directory (test)",
      },
    });
    expect(report?.task).not.toHaveProperty("directory");
  });

  test("a provider no enabled smith uses is not given a task, and the report says why", async () => {
    const { made, options } = taskSetup();
    const [report] = await runDoctor(
      { claude: claudeAdapter },
      { claude: fake("claude") },
      { ...options, smiths: {} },
    );
    expect(report).toMatchObject({
      ok: true,
      task: { ok: false, tools: 0, reason: "no enabled smith uses claude" },
    });
    expect(made).toEqual([]);
    expect(doctorLine(report as NonNullable<typeof report>)).toEndWith(
      "; cannot run a task: no enabled smith uses claude",
    );
  });
});

describe("taskSmiths", () => {
  test("the default crew checks its own provider; another provider uses its first enabled smith, in config order", () => {
    const config: ForgeConfig = {
      workflow: { defaultCrew: "claude-journeyman" },
      smiths: {
        "claude-master": smith("claude-master"),
        "claude-journeyman": smith("claude-journeyman"),
        "codex-retired": {
          ...smith("codex-journeyman"),
          name: "codex-retired",
          enabled: false,
        },
        "codex-journeyman": smith("codex-journeyman"),
      },
      benches: BUILTIN_BENCHES as ForgeConfig["benches"],
      execution: { envPass: [] },
    };
    const picked = taskSmiths(config);
    expect(Object.keys(picked).sort()).toEqual(["claude", "codex"]);
    expect(picked.claude?.name).toBe("claude-journeyman");
    expect(picked.codex?.name).toBe("codex-journeyman");
  });
});

describe("makeTaskDirectory", () => {
  test("makes a new directory that is the top level of its own git repository", () => {
    const dir = makeTaskDirectory();
    expect(existsSync(join(dir, ".git"))).toBe(true);
    const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(top.exitCode).toBe(0);
    expect(realpathSync.native(top.stdout.toString().trim())).toBe(
      realpathSync.native(dir),
    );
  });
});
