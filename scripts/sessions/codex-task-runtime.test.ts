import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexTaskLaunch } from "../../types/codex-task";
import type { CodexTaskRuntimeEvent } from "../../types/codex-task-runtime";
import { liveChildCount } from "../executors/supervisor";
import { scratchDirs } from "../test-scratch";
import { serializeCodexTask } from "./codex-task";
import {
  type CodexTaskRuntimeOptions,
  createCodexTaskRuntime,
} from "./codex-task-runtime";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const version = "0.163.0-alpha.10.2";
const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const fake = join(import.meta.dir, "fixtures/codex-task-runtime-cli.ts");

function fixture(mode = "normal", timeoutMs = 5000) {
  const root = scratch.make("codex-task-runtime-");
  const home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(home);
  mkdirSync(configHome);
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass = ["CODEX_RUNTIME_MODE", "CODEX_RUNTIME_LOG", "TEST_OPERATOR_SECRET", "TEST_ALLOWED", "AGENT_FORGE_FORGED", "FORGE_SLUG"]\n',
  );
  const log = join(root, "fake.jsonl");
  const environment = {
    ...process.env,
    CODEX_RUNTIME_MODE: mode,
    CODEX_RUNTIME_LOG: log,
    TEST_OPERATOR_SECRET: "prefix-synthetic-operator-token-suffix",
    TEST_ALLOWED: "allowed",
    AGENT_FORGE_FORGED: "forged",
    FORGE_SLUG: "forged",
  };
  const settings: CodexTaskRuntimeOptions = {
    root,
    home,
    configHome,
    command: [process.execPath, fake],
    syncCommand: [process.execPath, fake, "--sync"],
    environment,
    timeoutMs,
    operatorToken: () => "synthetic-operator-token",
    modelEfforts: [
      {
        model: "gpt-example-exact",
        efforts: ["high"],
        source: "model/list",
        cliVersion: version,
        asOf: "2026-10-22T10:00:00.000Z",
      },
    ],
  };
  const runtime = createCodexTaskRuntime(settings);
  const launch: CodexTaskLaunch = {
    mode: "task",
    cwd: root,
    model: "gpt-example-exact",
    effort: "high",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    prompt: 'Private "quotes" & $(literal) %PATH%\n🌱',
    context: {
      projectId: "project-test",
      repository: root,
      worktree: root,
      beadId: "alpha-1",
      about: [],
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
      throw new Error("Invalid fake runtime recording");
    }
  };
  return {
    root,
    home,
    configHome,
    runtime,
    launch,
    records,
    environment,
    log,
    settings,
  };
}

test("preparation is model-free; dispatch preserves the prepared Task through supervised native pipes", async () => {
  const f = fixture();
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  expect(snapshot.launch).toEqual(f.launch);
  expect(f.records().map((record) => record.kind)).toEqual(["version", "help"]);
  const events: CodexTaskRuntimeEvent[] = [];
  const result = await f.runtime.run(
    snapshot,
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
  );
  expect(result).toEqual({
    phase: "completed",
    reason: null,
    threadId,
    observedModel: null,
    usage: { inputTokens: 9, outputTokens: 6 },
  });
  const records = f.records();
  expect(records.map((record) => record.kind)).toEqual([
    "version",
    "help",
    "version",
    "help",
    "sync",
    "task",
  ]);
  const actual = records.at(-1);
  const serialized = serializeCodexTask(snapshot.launch, snapshot.capabilities);
  expect(actual?.argv).toEqual(serialized.argv);
  expect(actual?.stdin).toBe(serialized.stdin);
  expect(actual?.cwd).toBe(f.root);
  expect(actual?.secretPresent).toBe(false);
  expect(actual?.forged).toBe(false);
  expect(actual?.allowed).toBe("allowed");
  expect(actual?.adapter).toBe("1");
  expect(actual?.smith).toBe("codex-journeyman");
  expect(actual?.bead).toBe("alpha-1");
  expect(events.filter((event) => event.kind === "text")).toEqual([
    { kind: "text", itemId: "reply", text: "Runtime private reply 🌱" },
  ]);
});

test("reader, identity and exit failures never turn a successful-looking stream into completion", async () => {
  for (const mode of [
    "exit-after-result",
    "malformed",
    "foreign",
    "overflow-after-result",
    "missing-terminal",
  ]) {
    const f = fixture(mode);
    const snapshot = await f.runtime.prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    });
    const events: CodexTaskRuntimeEvent[] = [];
    const result = await f.runtime.run(
      snapshot,
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
    );
    expect(result.phase).toBe("unknown");
    expect(result.observedModel).toBe(null);
    expect(result.threadId).toBe(threadId);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(events.filter((event) => event.kind === "identity")).toHaveLength(1);
  }
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
      throw new Error(
        "The fake runtime did not reach its bounded process state.",
      );
    await Bun.sleep(20);
  }
}

test("Stop and timeout return only after the actual fake Task and its descendant are gone", async () => {
  const baseline = liveChildCount();
  for (const timeout of [false, true]) {
    const f = fixture("hang-tree", timeout ? 1000 : 5000);
    const snapshot = await f.runtime.prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    });
    const controller = new AbortController();
    const events: CodexTaskRuntimeEvent[] = [];
    const job = f.runtime.run(
      snapshot,
      async (event) => {
        events.push(event);
      },
      controller.signal,
    );
    try {
      await until(() => f.records().some((record) => record.kind === "task"));
      if (!timeout) controller.abort();
      const result = await job;
      expect(result.phase).toBe(timeout ? "unknown" : "failed");
      const actual = f.records().find((record) => record.kind === "task");
      if (
        typeof actual?.pid !== "number" ||
        typeof actual.childPid !== "number"
      )
        throw new Error("The fixture did not report its actual process tree.");
      const pid = actual.pid,
        childPid = actual.childPid;
      await until(() => !running(pid) && !running(childPid));
      expect(running(pid) || running(childPid)).toBe(false);
    } finally {
      controller.abort();
      await job;
    }
  }
  expect(liveChildCount()).toBe(baseline);
});

test("prepare refuses incomplete capability evidence without dispatching or silently dropping effort", async () => {
  const f = fixture("legacy-help");
  await expect(
    f.runtime.prepare({ smith: "codex-journeyman", launch: f.launch }),
  ).rejects.toThrow("--json");
  expect(
    f
      .records()
      .some((record) => record.kind === "sync" || record.kind === "task"),
  ).toBe(false);
});

test("fixed Task preparation survives current model-default edits and clones/freezes caller data", async () => {
  const f = fixture();
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  expect(
    Object.isFrozen(snapshot) &&
      Object.isFrozen(snapshot.launch) &&
      Object.isFrozen(snapshot.capabilities),
  ).toBe(true);
  f.launch.model = "caller-changed-model";
  writeFileSync(
    join(f.root, "agent-forge.toml"),
    `${readFileSync(join(f.root, "agent-forge.toml"), "utf8")}\n[smiths.codex-journeyman]\nmodel = "current-default-model"\neffort = "low"\n`,
  );
  const result = await f.runtime.run(
    snapshot,
    async () => {},
    new AbortController().signal,
  );
  expect(result.phase).toBe("completed");
  const argv = f.records().find((record) => record.kind === "task")?.argv;
  expect(argv).toEqual(
    serializeCodexTask(snapshot.launch, snapshot.capabilities).argv,
  );
  expect(JSON.stringify(argv)).not.toContain("current-default-model");
  expect(JSON.stringify(argv)).not.toContain("caller-changed-model");
});

test("disabled or foreign smiths, absent effort evidence and changed CLI versions never dispatch", async () => {
  for (const smith of ["missing-smith", "claude-journeyman"]) {
    const f = fixture();
    await expect(
      f.runtime.prepare({ smith, launch: f.launch }),
    ).rejects.toThrow("enabled Codex");
    expect(f.records()).toEqual([]);
  }
  const f = fixture();
  const { modelEfforts, ...unverified } = f.settings;
  await expect(
    createCodexTaskRuntime(unverified).prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    }),
  ).rejects.toThrow("effort");
  expect(
    f
      .records()
      .some((record) => record.kind === "task" || record.kind === "sync"),
  ).toBe(false);
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  f.environment.CODEX_RUNTIME_MODE = "changed-version";
  await expect(
    f.runtime.run(snapshot, async () => {}, new AbortController().signal),
  ).rejects.toThrow("changed after preparation");
  expect(
    f
      .records()
      .some((record) => record.kind === "task" || record.kind === "sync"),
  ).toBe(false);
  const disabled = fixture();
  writeFileSync(
    join(disabled.root, "agent-forge.toml"),
    "[smiths.codex-journeyman]\nenabled = false\n",
  );
  await expect(
    disabled.runtime.prepare({
      smith: "codex-journeyman",
      launch: disabled.launch,
    }),
  ).rejects.toThrow("enabled Codex");
  expect(disabled.records()).toEqual([]);
});

test("sync failure or cancellation never dispatches a Task and releases its actual supervised tree", async () => {
  for (const mode of ["sync-failure", "hang-sync"]) {
    const f = fixture(mode);
    const snapshot = await f.runtime.prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    });
    const controller = new AbortController();
    const job = f.runtime.run(snapshot, async () => {}, controller.signal);
    try {
      if (mode === "hang-sync") {
        await until(() => f.records().some((record) => record.kind === "sync"));
        controller.abort();
      }
      const result = await job;
      expect(result.phase).toBe("failed");
      expect(result.reason).not.toContain("SECRET");
      expect(f.records().some((record) => record.kind === "task")).toBe(false);
      const sync = f.records().find((record) => record.kind === "sync");
      if (typeof sync?.pid !== "number")
        throw new Error("Missing sync process identity");
      const pid = sync.pid;
      await until(() => !running(pid));
      if (mode === "hang-sync") {
        if (typeof sync.childPid !== "number")
          throw new Error("Missing sync descendant identity");
        const childPid = sync.childPid;
        await until(() => !running(childPid));
        expect(running(pid) || running(childPid)).toBe(false);
      }
    } finally {
      controller.abort();
      await job;
    }
  }
});

test("a private write failure latches unknown, stops the Task and does not expose the storage error", async () => {
  const f = fixture("hang-tree");
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  const events: CodexTaskRuntimeEvent[] = [];
  const result = await f.runtime.run(
    snapshot,
    async (event) => {
      events.push(event);
      if (event.kind === "text") throw new Error("SECRET persistence body");
    },
    new AbortController().signal,
  );
  expect(result.phase).toBe("unknown");
  expect(result.threadId).toBe(threadId);
  expect(result.reason).not.toContain("SECRET");
  expect(events.filter((event) => event.kind === "text")).toHaveLength(1);
  const actual = f.records().find((record) => record.kind === "task");
  if (typeof actual?.pid !== "number" || typeof actual.childPid !== "number")
    throw new Error("Missing failed-storage process tree");
  expect(running(actual.pid) || running(actual.childPid)).toBe(false);
});

test("an already stopped Task dispatches neither sync nor provider and fabricated Chat snapshots refuse", async () => {
  const f = fixture();
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  const controller = new AbortController();
  controller.abort();
  const result = await f.runtime.run(
    snapshot,
    async () => {
      throw new Error("No private event should exist");
    },
    controller.signal,
  );
  expect(result.phase).toBe("failed");
  expect(f.records().map((record) => record.kind)).toEqual(["version", "help"]);
  const unknownRun = (input: unknown) =>
    Reflect.apply(f.runtime.run, undefined, [
      input,
      async () => {},
      new AbortController().signal,
    ]);
  for (const change of [
    { launch: { ...snapshot.launch, mode: "chat" } },
    { cwd: join(f.root, "elsewhere") },
    { launch: { ...snapshot.launch, resumeSessionId: threadId } },
  ])
    await expect(unknownRun({ ...snapshot, ...change })).rejects.toThrow();
  expect(f.records().map((record) => record.kind)).toEqual(["version", "help"]);
});

test("sync selects the actual harness linked checkout and skips an unrelated repository", async () => {
  for (const sameWorkspace of [false, true]) {
    const f = fixture();
    const worktree = scratch.make("codex-task-selected-");
    if (sameWorkspace) {
      const marker = join(f.root, ".git", "worktrees", "linked");
      mkdirSync(marker, { recursive: true });
      writeFileSync(join(marker, "commondir"), "../..\n");
      writeFileSync(join(worktree, ".git"), `gitdir: ${marker}\n`);
    } else mkdirSync(join(worktree, ".git"));
    const snapshot = await f.runtime.prepare({
      smith: "codex-journeyman",
      launch: {
        ...f.launch,
        cwd: worktree,
        context: { projectId: "project-test", repository: worktree, worktree },
      },
    });
    expect(
      (
        await f.runtime.run(
          snapshot,
          async () => {},
          new AbortController().signal,
        )
      ).phase,
    ).toBe("completed");
    const sync = f.records().filter((record) => record.kind === "sync");
    expect(sync).toHaveLength(sameWorkspace ? 1 : 0);
    if (sameWorkspace)
      expect(String(sync[0]?.cwd).toLowerCase().replaceAll("\\", "/")).toBe(
        worktree.toLowerCase().replaceAll("\\", "/"),
      );
  }
});

test("Stop during a capability probe waits for cleanup and returns a known pre-dispatch failure", async () => {
  const f = fixture();
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  f.environment.CODEX_RUNTIME_MODE = "hang-help";
  const controller = new AbortController();
  const job = f.runtime.run(snapshot, async () => {}, controller.signal);
  try {
    await until(
      () => f.records().filter((record) => record.kind === "help").length === 2,
    );
    controller.abort();
    const result = await job;
    expect(result.phase).toBe("failed");
    expect(
      f
        .records()
        .some((record) => record.kind === "sync" || record.kind === "task"),
    ).toBe(false);
    const probe = f
      .records()
      .filter((record) => record.kind === "help")
      .at(-1);
    if (typeof probe?.pid !== "number" || typeof probe.childPid !== "number")
      throw new Error("Missing capability process tree");
    expect(running(probe.pid) || running(probe.childPid)).toBe(false);
  } finally {
    controller.abort();
    await job.catch(() => undefined);
  }
});

test("CLI effort defaults stay unreported and invalid native commands never probe or dispatch", async () => {
  const f = fixture();
  const { modelEfforts, ...settings } = f.settings;
  const { effort, ...launch } = f.launch;
  const runtime = createCodexTaskRuntime(settings);
  const snapshot = await runtime.prepare({ smith: "codex-journeyman", launch });
  const events: CodexTaskRuntimeEvent[] = [];
  expect(
    (
      await runtime.run(
        snapshot,
        async (event) => {
          events.push(event);
        },
        new AbortController().signal,
      )
    ).observedModel,
  ).toBe(null);
  expect(events.find((event) => event.kind === "process")).toMatchObject({
    requestedEffort: null,
    requestedModel: "gpt-example-exact",
  });
  expect(
    JSON.stringify(f.records().find((record) => record.kind === "task")?.argv),
  ).not.toContain("model_reasoning_effort");
  const bad = fixture();
  await expect(
    createCodexTaskRuntime({ ...bad.settings, command: [] }).check({
      smith: "codex-journeyman",
    }),
  ).rejects.toThrow("native Codex");
  if (process.platform === "win32") {
    const shim = join(bad.root, "codex.cmd");
    writeFileSync(shim, "@exit /b 0\n");
    await expect(
      createCodexTaskRuntime({ ...bad.settings, command: [shim] }).check({
        smith: "codex-journeyman",
      }),
    ).rejects.toThrow("native executable");
  }
  expect(bad.records()).toEqual([]);
});

test("private persistence pressure is bounded and cannot report completion after a fast terminal result", async () => {
  const f = fixture("flood");
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const job = f.runtime.run(
    snapshot,
    async () => {
      if (++writes === 1) await blocked;
    },
    new AbortController().signal,
  );
  try {
    await until(() => f.records().some((record) => record.kind === "task"));
    await Bun.sleep(100);
    release?.();
    const result = await job;
    expect(result.phase).toBe("unknown");
    expect(writes).toBeLessThanOrEqual(256);
    expect(result.reason).not.toContain("SECRET");
  } finally {
    release?.();
    await job;
  }
});
