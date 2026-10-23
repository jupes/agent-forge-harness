import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  GeminiTaskLaunch,
  GeminiTaskOutcome,
} from "../../types/gemini-task";
import type { GeminiTaskRuntimeEvent } from "../../types/gemini-task-runtime";
import { liveChildCount } from "../executors/supervisor";
import { scratchDirs } from "../test-scratch";
import { resolveGeminiCommand } from "./gemini-command";
import { serializeGeminiTask } from "./gemini-task";
import { createGeminiTaskRuntime } from "./gemini-task-runtime";

const scratch = scratchDirs(),
  binaries = scratchDirs();
afterEach(() => scratch.cleanup());
afterAll(() => binaries.cleanup());
let command: string;
beforeAll(async () => {
  const root = binaries.make("gemini-runtime-binary-");
  command = join(
    root,
    process.platform === "win32" ? "gemini-fixture.exe" : "gemini-fixture",
  );
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      join(import.meta.dir, "fixtures/gemini-task-runtime-compiled.ts"),
      "--compile",
      "--outfile",
      command,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => build.kill(), 20_000);
  try {
    const output = await new Response(build.stderr).text();
    if ((await build.exited) !== 0)
      throw Error(`Inert fixture compilation failed: ${output}`);
  } finally {
    clearTimeout(timer);
  }
}, 25_000);

function fixture(
  mode = "normal",
  timeoutMs = 5000,
  persistenceTimeoutMs = 5000,
) {
  const root = realpathSync.native(scratch.make("gemini-task-runtime-")),
    home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(home);
  mkdirSync(configHome);
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass = ["GEMINI_RUNTIME_LOG", "GEMINI_RUNTIME_MODE", "TEST_ALLOWED", "TEST_OPERATOR_SECRET", "AGENT_FORGE_FORGED", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"]\n[smiths.gemini-example]\nprovider = "gemini"\nmodel = "auto-gemini-example"\neffort = "default"\nenabled = true\n',
  );
  const log = join(root, "recordings.jsonl");
  const environment = {
    ...process.env,
    GEMINI_RUNTIME_LOG: log,
    GEMINI_RUNTIME_MODE: mode,
    TEST_ALLOWED: "allowed",
    TEST_OPERATOR_SECRET: "synthetic-operator-token",
    AGENT_FORGE_FORGED: "forged",
    NODE_OPTIONS: "--require DO_NOT_LOAD",
    NODE_PATH: "DO_NOT_LOAD",
    BUN_OPTIONS: "--preload DO_NOT_LOAD",
  };
  const settings = {
    root,
    home,
    configHome,
    command: [command],
    environment,
    timeoutMs,
    persistenceTimeoutMs,
    operatorToken: () => "synthetic-operator-token",
  };
  const runtime = createGeminiTaskRuntime(settings);
  const launch: GeminiTaskLaunch = {
    route: "gemini-cli",
    mode: "task",
    cwd: root,
    prompt: 'Private "quotes" & $(literal) %PATH%\n🌱',
    context: {
      projectId: "test-project",
      repository: root,
      worktree: root,
      beadId: "example-1",
    },
  };
  const records = (): Record<string, unknown>[] => {
    if (!existsSync(log)) return [];
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw Error("Invalid inert Gemini recording");
    }
  };
  return { root, runtime, launch, records, settings, log };
}

test("preparation is model-free and the owned native Task persists process identity before private stdin dispatch", async () => {
  const f = fixture(),
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  expect(f.records().map((r) => r.kind)).toEqual(["version", "help"]);
  expect(Object.isFrozen(prepared.launch)).toBe(true);
  const events: GeminiTaskRuntimeEvent[] = [];
  const result = await f.runtime.run(
    prepared,
    async (event) => {
      if (event.kind === "process")
        expect(f.records().some((r) => r.kind === "task")).toBe(false);
      events.push(event);
    },
    new AbortController().signal,
  );
  expect(result.phase).toBe("completed");
  expect(result.configuredModel).toBe("auto-gemini-example");
  expect(result.usage?.cachedInputTokens).toBe(7);
  const task = f.records().at(-1),
    serialized = serializeGeminiTask(prepared.launch, prepared.capabilities);
  expect(f.records().map((r) => r.kind)).toEqual([
    "version",
    "help",
    "version",
    "help",
    "task",
  ]);
  expect(task?.argv).toEqual(serialized.argv);
  expect(task?.stdin).toBe(serialized.stdin);
  expect(task?.cwd).toBe(prepared.canonicalCwd);
  expect(task?.secretPresent).toBe(false);
  expect(task?.forged).toBe(false);
  expect(task?.preload).toBe(false);
  expect(task?.allowed).toBe("allowed");
  expect(task?.adapter).toBe("1");
  expect(task?.smith).toBe("gemini-example");
  expect(events[0]).toMatchObject({ kind: "process", pid: task?.pid });
  expect(events.at(-1)).toMatchObject({
    kind: "outcome",
    outcome: { phase: "completed" },
  });
  expect(liveChildCount()).toBe(0);
});

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline)
      throw Error("Inert Gemini did not reach its bounded state");
    await Bun.sleep(10);
  }
}

test("actual supervised Stop and timeout retain partial text and end the owned provider and its helper", async () => {
  for (const stop of [true, false]) {
    const f = fixture("hang-tree", stop ? 5000 : 800),
      prepared = await f.runtime.prepare({
        smith: "gemini-example",
        launch: f.launch,
      });
    const controller = new AbortController(),
      events: GeminiTaskRuntimeEvent[] = [];
    const pending = f.runtime.run(
      prepared,
      async (event) => {
        events.push(event);
      },
      controller.signal,
    );
    await until(() => events.some((event) => event.kind === "text"));
    const task = f.records().find((record) => record.kind === "task");
    expect(typeof task?.childPid).toBe("number");
    if (stop) controller.abort("explicit test Stop");
    const result = await pending;
    expect(result.phase).toBe("failed");
    expect(events.at(-1)).toMatchObject({
      kind: "outcome",
      stopped: stop,
      timedOut: !stop,
    });
    if (typeof task?.pid !== "number" || typeof task.childPid !== "number")
      throw Error("Missing actual inert process identities");
    const pid = task.pid,
      childPid = task.childPid;
    await until(() => !running(pid) && !running(childPid));
    expect(liveChildCount()).toBe(0);
  }
});

test("native denial and error remain provider reports; malformed, missing and oversized output cannot confirm completion", async () => {
  const cases: readonly (readonly [string, GeminiTaskOutcome["phase"]])[] = [
    ["denied", "completed"],
    ["provider-error", "failed"],
    ["exit-9", "failed"],
    ["malformed", "unknown"],
    ["missing-result", "unknown"],
    ["overflow", "unknown"],
    ["normal-orphan", "completed"],
  ];
  for (const [mode, phase] of cases) {
    const f = fixture(mode),
      prepared = await f.runtime.prepare({
        smith: "gemini-example",
        launch: f.launch,
      });
    const events: GeminiTaskRuntimeEvent[] = [];
    const result = await f.runtime.run(
      prepared,
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
    );
    expect({ mode, phase: result.phase }).toEqual({ mode, phase });
    if (mode === "exit-9")
      expect(events.at(-1)).toMatchObject({
        kind: "outcome",
        exitCode: 9,
        stderr: { text: "Synthetic native stderr\n", truncated: false },
      });
    expect(f.records().filter((r) => r.kind === "task")).toHaveLength(1);
    if (mode === "denied") {
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "tool",
          state: "failed",
          error: expect.objectContaining({ type: "policy_violation" }),
        }),
      );
      expect(JSON.stringify(events)).not.toContain('"kind":"approval"');
    }
    if (mode === "normal-orphan") {
      const pid = f.records().at(-1)?.childPid;
      if (typeof pid !== "number") throw Error("Missing helper identity");
      await until(() => !running(pid));
    }
    expect(liveChildCount()).toBe(0);
  }
}, 20_000);

test("private process persistence must finish before stdin and a missing final receipt cannot report completion", async () => {
  for (const mode of [
    "refused-process",
    "stalled-process",
    "stalled-text",
    "refused-outcome",
  ]) {
    const f = fixture("normal", 5000, 80),
      prepared = await f.runtime.prepare({
        smith: "gemini-example",
        launch: f.launch,
      });
    let calls = 0;
    const result = await f.runtime.run(
      prepared,
      async (event) => {
        calls++;
        if (event.kind === "process" && mode.endsWith("process")) {
          if (mode === "stalled-process") await new Promise(() => {});
          else throw Error("Private process record refused");
        }
        if (event.kind === "text" && mode === "stalled-text")
          await new Promise(() => {});
        if (event.kind === "outcome" && mode === "refused-outcome")
          throw Error("Private final receipt refused");
      },
      new AbortController().signal,
    );
    expect(result.phase).toBe("unknown");
    expect(calls).toBeGreaterThan(0);
    expect(f.records().filter((r) => r.kind === "task")).toHaveLength(
      mode.endsWith("process") ? 0 : 1,
    );
    expect(liveChildCount()).toBe(0);
  }
});

test("changed native version, missing required help and stopped preparation refuse without a Task", async () => {
  for (const control of [{ version: "0.66.0" }, { help: "--model" }]) {
    const f = fixture(),
      prepared = await f.runtime.prepare({
        smith: "gemini-example",
        launch: f.launch,
      });
    writeFileSync(`${f.log}.control`, JSON.stringify(control));
    await expect(
      f.runtime.run(prepared, async () => {}, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.records().filter((r) => r.kind === "task")).toHaveLength(0);
  }
  const f = fixture(),
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    }),
    controller = new AbortController();
  controller.abort();
  expect(
    (
      await f.runtime.run(
        prepared,
        async () => {
          throw Error("Must not persist");
        },
        controller.signal,
      )
    ).phase,
  ).toBe("failed");
  expect(f.records().map((r) => r.kind)).toEqual(["version", "help"]);
});

test("retargeting the prepared working-directory link refuses before another native probe or Task", async () => {
  const f = fixture(),
    first = join(f.root, "first"),
    second = join(f.root, "second"),
    link = join(f.root, "linked");
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, link, process.platform === "win32" ? "junction" : "dir");
  const launch = {
    ...f.launch,
    cwd: link,
    context: { projectId: "test-project", repository: f.root, worktree: link },
  };
  const prepared = await f.runtime.prepare({ smith: "gemini-example", launch });
  if (process.platform === "win32") rmdirSync(link);
  else unlinkSync(link);
  symlinkSync(second, link, process.platform === "win32" ? "junction" : "dir");
  try {
    await expect(
      f.runtime.run(prepared, async () => {}, new AbortController().signal),
    ).rejects.toThrow("changed");
    expect(f.records().map((r) => r.kind)).toEqual(["version", "help"]);
  } finally {
    if (process.platform === "win32") rmdirSync(link);
    else unlinkSync(link);
  }
});

test("a directory retargeted while read-only preparation is running cannot become the prepared scope", async () => {
  const f = fixture("hold-help"),
    first = join(f.root, "first"),
    second = join(f.root, "second"),
    link = join(f.root, "linked");
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, link, process.platform === "win32" ? "junction" : "dir");
  const preparation = f.runtime.prepare({
    smith: "gemini-example",
    launch: {
      ...f.launch,
      cwd: link,
      context: {
        projectId: "test-project",
        repository: f.root,
        worktree: link,
      },
    },
  });
  const result = preparation.then(
    () => "unexpectedly accepted",
    () => "refused",
  );
  await until(() => f.records().some((record) => record.kind === "help"));
  if (process.platform === "win32") rmdirSync(link);
  else unlinkSync(link);
  symlinkSync(second, link, process.platform === "win32" ? "junction" : "dir");
  try {
    expect(await result).toBe("refused");
    expect(f.records().filter((r) => r.kind === "task")).toHaveLength(0);
  } finally {
    if (process.platform === "win32") rmdirSync(link);
    else unlinkSync(link);
  }
});

test.skipIf(process.platform !== "win32")(
  "the verified Windows npm package runs through actual native Node under owned supervision without executing its shell shim",
  async () => {
    const f = fixture(),
      node = Bun.which("node");
    if (!node || !/\.exe$/i.test(node))
      throw Error(
        "This Windows native installation test requires the CI Node executable",
      );
    const prefix = join(f.root, "npm"),
      packageRoot = join(prefix, "node_modules", "@google", "gemini-cli"),
      entry = join(packageRoot, "dist", "index.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(prefix, "gemini.cmd"),
      "THIS_SHELL_SHIM_MUST_NEVER_EXECUTE",
    );
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@google/gemini-cli",
        version: "0.65.0",
        type: "module",
        bin: { gemini: "dist/index.js" },
      }),
    );
    writeFileSync(
      entry,
      `import {appendFileSync} from "node:fs";
const argv=process.argv.slice(2),log=process.env.GEMINI_RUNTIME_LOG;
if(argv.includes("--version")) console.log("0.65.0");
else if(argv.includes("--help")) console.log("--output-format --model");
else {
  let stdin=""; for await (const chunk of process.stdin) stdin+=chunk;
  appendFileSync(log, JSON.stringify({kind:"node-task",stdin,argv,pid:process.pid,preload:!!process.env.NODE_OPTIONS||!!process.env.NODE_PATH||!!process.env.BUN_OPTIONS})+"\\n");
  const timestamp="2026-10-23T08:00:00.000Z";
  for (const event of [{type:"init",session_id:"0199a213-81c0-7800-8aa1-bbab2a035a53",model:"auto-gemini-example"},{type:"message",role:"assistant",content:"Node native reply",delta:true},{type:"result",status:"success"}]) console.log(JSON.stringify({timestamp,...event}));
}
`,
    );
    const verified = resolveGeminiCommand({
      which: (name) =>
        name === "gemini"
          ? join(prefix, "gemini.cmd")
          : name === "node"
            ? node
            : null,
    });
    const runtime = createGeminiTaskRuntime({
        ...f.settings,
        command: verified,
      }),
      prepared = await runtime.prepare({
        smith: "gemini-example",
        launch: f.launch,
      });
    const result = await runtime.run(
      prepared,
      async (event) => {
        if (event.kind === "process") expect(f.records()).toEqual([]);
      },
      new AbortController().signal,
    );
    expect(result.phase).toBe("completed");
    expect(result.usage).toBeNull();
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0]).toMatchObject({
      kind: "node-task",
      stdin: serializeGeminiTask(prepared.launch, prepared.capabilities).stdin,
      argv: ["--output-format", "stream-json"],
      preload: false,
    });
    expect(liveChildCount()).toBe(0);
  },
);

test("Stop and a rejected output flood do not drain hundreds of slow queued private writes", async () => {
  for (const stop of [true, false]) {
    const f = fixture(stop ? "flood-200" : "flood-300", 5000, 1000),
      prepared = await f.runtime.prepare({
        smith: "gemini-example",
        launch: f.launch,
      }),
      controller = new AbortController();
    let firstWrite: (() => void) | undefined,
      textWrites = 0;
    const first = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });
    const pending = f.runtime.run(
      prepared,
      async (event) => {
        if (event.kind === "text") {
          textWrites++;
          firstWrite?.();
          await Bun.sleep(12);
        }
      },
      controller.signal,
    );
    if (stop) await first;
    else
      await until(() => f.records().some((record) => record.kind === "task"));
    const start = performance.now();
    if (stop) controller.abort("Stop while the private writer is slow");
    const outcome = await pending;
    expect(outcome.phase).toBe("unknown");
    expect(textWrites).toBeLessThan(10);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(f.records().filter((r) => r.kind === "task")).toHaveLength(1);
    expect(liveChildCount()).toBe(0);
  }
});

test("a Task path retargeted during private process persistence cannot receive the accepted prompt", async () => {
  const f = fixture(),
    first = join(f.root, "first"),
    second = join(f.root, "second"),
    link = join(f.root, "linked");
  mkdirSync(first);
  mkdirSync(second);
  const detach = () =>
    process.platform === "win32" ? rmdirSync(link) : unlinkSync(link);
  symlinkSync(first, link, process.platform === "win32" ? "junction" : "dir");
  try {
    const prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: {
        ...f.launch,
        cwd: link,
        context: {
          projectId: "test-project",
          repository: f.root,
          worktree: link,
        },
      },
    });
    const events: GeminiTaskRuntimeEvent[] = [];
    const result = await f.runtime.run(
      prepared,
      async (event) => {
        events.push(event);
        if (event.kind === "process") {
          detach();
          symlinkSync(
            second,
            link,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
      },
      new AbortController().signal,
    );
    expect(result.phase).toBe("unknown");
    const reads = f.records().filter((row) => row.kind === "task");
    expect(reads.every((row) => row.stdin === "")).toBe(true);
    for (const row of reads) expect(row.cwd).toBe(prepared.canonicalCwd);
    expect(events.at(-1)).toMatchObject({
      kind: "outcome",
      outcome: { phase: "unknown" },
    });
    expect(liveChildCount()).toBe(0);
  } finally {
    detach();
  }
});
