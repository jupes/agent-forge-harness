import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BUILTIN_SMITHS } from "../config/defaults";
import { comparableCheckout } from "../forge/runs";
import { hashText } from "../hash-text";
import { scratchDirs } from "../test-scratch";
import { claudeAdapter } from "./claude";
import { runExec } from "./exec-cli";
import type { PrivateExecCapture } from "./private-capture";
import type { ChildExit, SpawnRequest } from "./types";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const fake = join(import.meta.dir, "fixtures", "fake-cli.ts");
const fixedFailure =
  "The private provider transcript could not be verified. The shift must stop before another attempt.";
function alive(pid: number) {
  try {
    if (
      process.platform === "linux" &&
      /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    )
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function captureFinished(
  entered: Promise<ChildExit | null>,
  original: Promise<unknown>,
): Promise<ChildExit | null> {
  return Promise.race([
    entered,
    original.then(() => {
      throw Error("The original execution settled before private finish entry");
    }),
  ]);
}

const STARTUP_MILESTONES = [
  "fixture-entered",
  "stdin-read-completed",
  "descendant-spawn-returned",
  "stdout-write-requested",
] as const;
function readStartupMilestones(file: string, root: string): unknown {
  try {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 2048 ||
      dirname(realpathSync.native(file)) !== root
    )
      return "unavailable";
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text, "utf8") > 2048) return "unavailable";
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return "unavailable";
    if (!isRecord(raw)) return "unavailable";
    const record = raw;
    if (
      Object.keys(record).sort().join(",") !== "stages,version" ||
      record.version !== 1 ||
      !Array.isArray(record.stages) ||
      record.stages.length < 1 ||
      record.stages.length > STARTUP_MILESTONES.length
    )
      return "unavailable";
    const stages: Array<{ stage: string; elapsedMs: number }> = [];
    let previousIndex = -1, previousTime = -1;
    for (const value of record.stages) {
      if (!isRecord(value)) return "unavailable";
      const item = value, index = STARTUP_MILESTONES.findIndex((stage) => stage === item.stage);
      if (
        Object.keys(item).sort().join(",") !== "elapsedMs,stage" ||
        index < 0 ||
        index !== previousIndex + 1 ||
        typeof item.elapsedMs !== "number" ||
        !Number.isSafeInteger(item.elapsedMs) ||
        item.elapsedMs < 0 ||
        item.elapsedMs < previousTime ||
        item.elapsedMs > 15_000
      )
        return "unavailable";
      previousIndex = index;
      previousTime = item.elapsedMs;
      stages.push({
        stage: STARTUP_MILESTONES[index] ?? "unavailable",
        elapsedMs: item.elapsedMs,
      });
    }
    return stages;
  } catch {
    return "unavailable";
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

test("private finish entry is observed while original execution remains held", async () => {
  const entered = deferred<ChildExit | null>(),
    original = deferred<void>();
  const exit: ChildExit = {
    exitCode: 0,
    stopped: false,
    timedOut: false,
    stderr: "",
  };
  let observed: ChildExit | null | undefined;
  const waiting = captureFinished(entered.promise, original.promise).then(
    (value) => {
      observed = value;
      return value;
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observed).toBeUndefined();
    entered.resolve(exit);
    expect(await waiting).toBe(exit);
  } finally {
    original.resolve();
    entered.resolve(exit);
    await waiting;
  }
});

test("early original execution refusal or completion cannot invent private finish entry", async () => {
  const failure = new Error("fixture original execution failed");
  await expect(
    captureFinished(new Promise(() => {}), Promise.reject(failure)),
  ).rejects.toBe(failure);
  await expect(
    captureFinished(new Promise(() => {}), Promise.resolve()),
  ).rejects.toThrow(
    "The original execution settled before private finish entry",
  );
});
function setup(mode = "ok") {
  const root = realpathSync.native(scratch.make("owned exec capture "));
  mkdirSync(join(root, ".git"));
  const dump = join(root, "child.json");
  const smith = BUILTIN_SMITHS["claude-journeyman"];
  if (!smith) throw Error("Fixture smith missing");
  const request: SpawnRequest = {
    beadId: "capture-bead",
    worktree: root,
    workspace: root,
    smith: structuredClone(smith),
    prompt: "  exact private prompt\nsecond line  ",
    env: {
      PATH: process.env.PATH ?? "",
      ANTHROPIC_API_KEY: "private-env-value",
    },
    timeoutMs: 5000,
    command: [
      process.execPath,
      fake,
      "--fake-provider",
      "claude",
      "--fake-mode",
      mode,
      "--fake-dump",
      dump,
    ],
  };
  return { root, dump, request };
}

test("private capture retains the actual canonical input before spawn, then settles after ordered output and tree exit", async () => {
  const f = setup(),
    entered = deferred<void>(),
    release = deferred<void>(),
    finish = deferred<void>(),
    finishEntered = deferred<ChildExit | null>();
  const order: string[] = [],
    lines: string[] = [];
  let providerPid = 0,
    actual: unknown,
    exit: ChildExit | null = null;
  const pending = claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      async prepare(prepared) {
        actual = structuredClone(prepared);
        order.push("prepared");
        entered.resolve();
        await release.promise;
        return {
          holdTree() {},
          started(pid) {
            expect(pid).toBeGreaterThan(0);
            providerPid = pid;
            order.push("process");
          },
          line(line) {
            lines.push(line);
            order.push("line");
          },
          async finish(result) {
            exit = result;
            order.push("exit");
            finishEntered.resolve(result);
            await finish.promise;
          },
        };
      },
    },
  });
  try {
    expect(
      await Promise.race([
        entered.promise.then(() => "prepared"),
        pending.then(() => "spawned"),
      ]),
    ).toBe("prepared");
    expect(existsSync(f.dump)).toBe(false);
    expect(JSON.stringify(actual)).not.toContain("private-env-value");
    expect(actual).toMatchObject({
      provider: "claude",
      workspace: comparableCheckout(f.root),
      cwd: f.root,
      beadId: "capture-bead",
      smith: f.request.smith,
      stdin: f.request.prompt,
      timeoutMs: 5000,
    });
    release.resolve();
    const handle = await pending;
    let settled = false;
    const done = handle.done.then((result) => {
      settled = true;
      return result;
    });
    expect(await captureFinished(finishEntered.promise, done)).toBe(exit);
    expect(exit).toMatchObject({
      exitCode: 0,
      stopped: false,
      timedOut: false,
    });
    expect(settled).toBe(false);
    expect(order[0]).toBe("prepared");
    expect(order[1]).toBe("process");
    expect(lines.length).toBeGreaterThan(0);
    const child = JSON.parse(readFileSync(f.dump, "utf8"));
    expect(child.pid).toBe(providerPid);
    expect(alive(providerPid)).toBe(false);
    expect(actual).toMatchObject({
      command: [process.execPath, fake, ...child.argv],
      stdin: child.stdin,
      cwd: child.cwd,
    });
    finish.resolve();
    expect((await done).privateCaptureFailed).toBeUndefined();
  } finally {
    release.resolve();
    finish.resolve();
    const handle = await pending;
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 10000);

test("attended execution owns its tree and persists the actual provider process before private stdin", async () => {
  const f = setup(),
    entered = deferred<void>(),
    release = deferred<void>();
  const order: string[] = [];
  let providerPid = 0;
  const handle = await claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      prepare: async () => ({
        holdTree() {
          order.push("held-tree");
        },
        async started(pid) {
          providerPid = pid;
          order.push("process-pending");
          entered.resolve();
          await release.promise;
          order.push("process-persisted");
        },
        line() {
          order.push("private-output");
        },
        async finish() {
          order.push("tree-exited");
        },
      }),
    },
  });
  try {
    await entered.promise;
    await Bun.sleep(200);
    expect(existsSync(f.dump)).toBe(false);
    expect(order).toEqual(["held-tree", "process-pending"]);
    expect(providerPid).not.toBe(handle.pid);
    release.resolve();
    expect((await handle.done).privateCaptureFailed).toBeUndefined();
    let recorded: unknown;
    try {
      recorded = JSON.parse(readFileSync(f.dump, "utf8"));
    } catch {
      throw Error("Native fixture input was not published");
    }
    expect(recorded).toMatchObject({
      pid: providerPid,
      stdin: f.request.prompt,
    });
    expect(order.indexOf("process-persisted")).toBeLessThan(
      order.indexOf("private-output"),
    );
    expect(order.at(-1)).toBe("tree-exited");
  } finally {
    release.resolve();
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 10000);

test("a process-record deadline stops its owned provider without sending private input or announcing a prompt", async () => {
  const f = setup(),
    entered = deferred<void>(),
    late = deferred<void>();
  let providerPid = 0,
    finished = 0;
  const handle = await claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      deadlineMs: 100,
      prepare: async () => ({
        holdTree() {},
        async started(pid) {
          providerPid = pid;
          entered.resolve();
          await late.promise;
        },
        line() {
          throw Error("No private input was sent");
        },
        async finish() {
          finished++;
          expect(() => process.kill(providerPid, 0)).toThrow();
        },
      }),
    },
  });
  try {
    await entered.promise;
    const result = await Promise.race([
      handle.done,
      Bun.sleep(1000).then(() => null),
    ]);
    expect(result).toMatchObject({ privateCaptureFailed: true, stopped: true });
    expect(finished).toBe(1);
    expect(existsSync(f.dump)).toBe(false);
    const events = [];
    for await (const event of handle.events) events.push(event);
    expect(events.some((event) => event.kind === "prompt.submitted")).toBe(
      false,
    );
    late.resolve();
    await Bun.sleep(0);
    expect(existsSync(f.dump)).toBe(false);
  } finally {
    late.resolve();
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 10000);

test("Stop aborts an uncooperative private process write and settles after tree cleanup", async () => {
  const f = setup(),
    entered = deferred<void>(),
    controller = new AbortController();
  let providerPid = 0,
    aborted = false;
  const handle = await claudeAdapter.spawn({
    ...f.request,
    signal: controller.signal,
    privateCapture: {
      prepare: async (_input, control) => ({
        holdTree() {},
        started(pid) {
          providerPid = pid;
          control.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
          entered.resolve();
          return new Promise(() => {});
        },
        line() {},
        async finish() {
          expect(() => process.kill(providerPid, 0)).toThrow();
        },
      }),
    },
  });
  try {
    await entered.promise;
    controller.abort();
    expect(
      await Promise.race([handle.done, Bun.sleep(1000).then(() => null)]),
    ).toMatchObject({ privateCaptureFailed: true, stopped: true });
    expect(aborted).toBe(true);
    expect(existsSync(f.dump)).toBe(false);
  } finally {
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 10000);

test("private capture finishes only after a normally exiting provider's held helper has stopped", async () => {
  const f = setup("orphan");
  let descendant = 0;
  const handle = await claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      prepare: async () => ({
        holdTree() {},
        started() {},
        line(line) {
          let packet: unknown;
          try {
            packet = JSON.parse(line);
          } catch {
            return;
          }
          if (
            packet &&
            typeof packet === "object" &&
            "childPid" in packet &&
            typeof packet.childPid === "number"
          )
            descendant = packet.childPid;
        },
        async finish() {
          expect(descendant).toBeGreaterThan(0);
          expect(alive(descendant)).toBe(false);
        },
      }),
    },
  });
  try {
    expect(await handle.done).toMatchObject({ exitCode: 0, stopped: false });
    expect(descendant).toBeGreaterThan(0);
    expect(alive(descendant)).toBe(false);
  } finally {
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 10000);

test("a refused private prepare starts no child and does not expose storage diagnostics", async () => {
  const f = setup();
  const pending = claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      prepare: async () => {
        throw Error("private storage path and provider body");
      },
    },
  });
  try {
    await expect(pending).rejects.toThrow(fixedFailure);
    expect(existsSync(f.dump)).toBe(false);
    expect(existsSync(join(f.root, ".agent-forge-session"))).toBe(false);
  } finally {
    await pending.then(
      async (handle) => {
        await handle.stop("fixture cleanup");
        await handle.done;
      },
      () => {},
    );
  }
});

test("private output failure stops and awaits the supervised tree and cannot become provider success", async () => {
  const f = setup("hang-tree");
  const milestonesFile = join(f.root, "startup-milestones.json");
  const request = {
    ...f.request,
    command: [...f.request.command, "--fake-milestones", milestonesFile],
  };
  let descendant: number | null = null;
  const observedAt = performance.now();
  type SettlementStage =
    | "adapter-spawn-requested"
    | "adapter-spawn-returned"
    | "tree-held"
    | "provider-started-callback"
    | "first-line-callback"
    | "private-line-rejected"
    | "finish-entered"
    | "finish-returned"
    | "done-settled"
    | "done-rejected"
    | "existing-deadline-expired"
    | "cleanup-stop-requested"
    | "cleanup-settled";
  const stages: { stage: SettlementStage; elapsedMs: number }[] = [];
  const mark = (stage: SettlementStage) => {
    if (stages.length >= 12 || stages.some((item) => item.stage === stage))
      return;
    stages.push({
      stage,
      elapsedMs: Math.max(0, Math.round(performance.now() - observedAt)),
    });
  };
  let lineCount = 0;
  let finishCount = 0;
  type DoneState = "pending" | "private-failure" | "other-result" | "rejected";
  let doneState: DoneState = "pending";
  let deadlineMissed = false;
  let doneAtDeadline: DoneState = "pending";
  let descendantAliveAtDeadline: boolean | null = null;
  const cleanupOutcome: {
    value: "pending" | "settled" | "rejected";
  } = { value: "pending" };
  mark("adapter-spawn-requested");
  const handle = await claudeAdapter.spawn({
    ...request,
    privateCapture: {
      prepare: async () => ({
        holdTree() {
          mark("tree-held");
        },
        started() {
          mark("provider-started-callback");
        },
        line(line) {
          lineCount = Math.min(8, lineCount + 1);
          mark("first-line-callback");
          try {
            const packet = JSON.parse(line);
            descendant = packet.childPid;
          } catch {
            /* only the fixed fixture PID is needed */
          }
          mark("private-line-rejected");
          throw Error("private parse diagnostic");
        },
        async finish() {
          finishCount = Math.min(2, finishCount + 1);
          mark("finish-entered");
          mark("finish-returned");
        },
      }),
    },
  });
  mark("adapter-spawn-returned");
  void handle.done.then(
    (result) => {
      doneState = result.privateCaptureFailed
        ? "private-failure"
        : "other-result";
      mark("done-settled");
    },
    () => {
      doneState = "rejected";
      mark("done-rejected");
    },
  );
  try {
    const result = await Promise.race([
      handle.done,
      Bun.sleep(1500).then(() => {
        deadlineMissed = true;
        doneAtDeadline = doneState;
        descendantAliveAtDeadline =
          descendant === null ? null : alive(descendant);
        mark("existing-deadline-expired");
        return null;
      }),
    ]);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ privateCaptureFailed: true, stopped: true });
    expect(JSON.stringify(result)).not.toContain("private parse diagnostic");
    expect(descendant).toBeNumber();
    const descendantPid = descendant;
    if (descendantPid !== null) expect(alive(descendantPid)).toBe(false);
  } finally {
    if (deadlineMissed) mark("cleanup-stop-requested");
    const cleanup = async () => {
      try {
        await handle.stop("fixture cleanup");
        await handle.done;
        cleanupOutcome.value = "settled";
      } catch (error) {
        cleanupOutcome.value = "rejected";
        throw error;
      }
    };
    try {
      await cleanup();
    } finally {
      if (deadlineMissed) {
        if (cleanupOutcome.value === "settled") mark("cleanup-settled");
        const facts = {
          version: 1,
          stages,
          lineCount,
          finishCount,
          doneAtDeadline,
          doneAfterCleanup: doneState,
          cleanupOutcome: cleanupOutcome.value,
          fixtureMilestones: readStartupMilestones(milestonesFile, f.root),
          descendantSeen: descendant !== null,
          descendantAliveAtDeadline,
          descendantAliveAfterCleanup:
            descendant === null ? null : alive(descendant),
        };
        try {
          const serialized = JSON.stringify(facts);
          console.error(
            `[private-capture-settlement] ${
              serialized.length <= 2048
                ? serialized
                : JSON.stringify({ version: 1, truncated: true })
            }`,
          );
        } catch {
          console.error(
            '[private-capture-settlement] {"version":1,"unavailable":true}',
          );
        }
      }
    }
  }
}, 10000);

test("private preparation cannot change the executed input or its metadata hash while it waits", async () => {
  const f = setup(),
    original = f.request.prompt;
  const request = {
    ...f.request,
    privateCapture: {
      async prepare(input) {
        input.stdin = "mutated callback copy";
        input.command.length = 0;
        request.prompt = "mutated original";
        request.smith.model = "mutated-model";
        return { holdTree() {}, started() {}, line() {}, async finish() {} };
      },
    },
  } satisfies SpawnRequest;
  const handle = await claudeAdapter.spawn(request);
  try {
    const events = [];
    for await (const event of handle.events) events.push(event);
    expect((await handle.done).exitCode).toBe(0);
    const child = JSON.parse(readFileSync(f.dump, "utf8"));
    expect(child.stdin).toBe(original);
    expect(child.argv).not.toContain("mutated-model");
    expect(
      events.find((event) => event.kind === "prompt.submitted")?.payload,
    ).toMatchObject({ hash: hashText(original), length: original.length });
  } finally {
    await handle.stop("fixture cleanup");
    await handle.done;
  }
});

test("a late private write failure stays fatal through runExec while the metadata sink remains separate", async () => {
  const f = setup(),
    events: unknown[] = [];
  const result = await runExec(
    [
      "--bead",
      "capture-bead",
      "--worktree",
      f.root,
      "--prompt",
      f.request.prompt,
    ],
    {
      harnessRoot: f.root,
      home: f.root,
      cwd: f.root,
      ...(f.request.command ? { command: f.request.command } : {}),
      env: { PATH: process.env.PATH },
      adapters: { claude: claudeAdapter },
      sink: (event) => {
        events.push(event);
      },
      privateCapture: {
        prepare: async () => ({
          holdTree() {},
          started() {},
          line() {},
          async finish() {
            throw Error("private write diagnostic");
          },
        }),
      },
    },
  );
  expect(result.privateCaptureFailed).toBe(true);
  expect(result.code).toBe(2);
  expect(result.body.error).toBe(fixedFailure);
  expect(JSON.stringify(events)).not.toContain(f.request.prompt);
  expect(JSON.stringify(events)).not.toContain("private write diagnostic");
  expect(events.at(-1)).toMatchObject({
    kind: "session.ended",
    payload: { reason: "failed: private transcript unavailable" },
  });
});

test("prepare failure remains a fatal runExec signal before any provider or metadata event", async () => {
  const f = setup(),
    events: unknown[] = [];
  const result = await runExec(
    [
      "--bead",
      "capture-bead",
      "--worktree",
      f.root,
      "--prompt",
      "private prompt",
    ],
    {
      harnessRoot: f.root,
      home: f.root,
      cwd: f.root,
      ...(f.request.command ? { command: f.request.command } : {}),
      env: { PATH: process.env.PATH },
      adapters: { claude: claudeAdapter },
      sink: (event) => {
        events.push(event);
      },
      privateCapture: {
        prepare: async () => {
          throw Error("unavailable private storage");
        },
      },
    },
  );
  expect(result.privateCaptureFailed).toBe(true);
  expect(result.body).toEqual({ ok: false, data: null, error: fixedFailure });
  expect(events).toEqual([]);
  expect(existsSync(f.dump)).toBe(false);
});

test("Stop during private preparation prevents provider spawn after the preparation barrier opens", async () => {
  const f = setup(),
    entered = deferred<void>(),
    release = deferred<void>(),
    controller = new AbortController();
  let abandoned = false;
  const pending = runExec(
    [
      "--bead",
      "capture-bead",
      "--worktree",
      f.root,
      "--prompt",
      "private prompt",
    ],
    {
      harnessRoot: f.root,
      home: f.root,
      cwd: f.root,
      ...(f.request.command ? { command: f.request.command } : {}),
      env: { PATH: process.env.PATH },
      adapters: { claude: claudeAdapter },
      sink: () => {},
      signal: controller.signal,
      privateCapture: {
        async prepare() {
          entered.resolve();
          await release.promise;
          return {
            holdTree() {},
            started() {},
            line() {},
            async finish(exit) {
              abandoned = exit === null;
            },
          };
        },
      },
    },
  );
  await entered.promise;
  controller.abort("operator stopped shift");
  release.resolve();
  const result = await pending;
  expect(result.code).toBe(2);
  expect(abandoned).toBe(true);
  expect(existsSync(f.dump)).toBe(false);
});

test("Stop settles a never-resolving prepare and fences a late owner without launching", async () => {
  const f = setup(),
    entered = deferred<void>(),
    late = deferred<PrivateExecCapture>(),
    controller = new AbortController();
  let aborted = false,
    abandoned = 0;
  const pending = claudeAdapter.spawn({
    ...f.request,
    signal: controller.signal,
    privateCapture: {
      async prepare(_input, control) {
        control.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        entered.resolve();
        return late.promise;
      },
    },
  });
  await entered.promise;
  controller.abort();
  const result = await Promise.race([
    pending.then(
      () => "spawned",
      () => "refused",
    ),
    Bun.sleep(500).then(() => "hung"),
  ]);
  late.resolve({
    holdTree() {},
    started() {
      throw Error("Late owner started");
    },
    line() {},
    async finish(exit) {
      if (exit === null) abandoned++;
    },
  });
  await pending.catch(() => {});
  await Bun.sleep(0);
  expect(result).toBe("refused");
  expect(aborted).toBe(true);
  expect(abandoned).toBe(1);
  expect(existsSync(f.dump)).toBe(false);
});

test("a prepare deadline settles fatally and a late owner cannot dispatch", async () => {
  const f = setup(),
    late = deferred<PrivateExecCapture>();
  let aborted = false,
    abandoned = 0;
  const pending = claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      deadlineMs: 100,
      async prepare(_input, control) {
        control.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return late.promise;
      },
    },
  });
  const result = await Promise.race([
    pending.then(
      () => "spawned",
      (error: unknown) => (error instanceof Error ? error.message : "refused"),
    ),
    Bun.sleep(600).then(() => "hung"),
  ]);
  late.resolve({
    holdTree() {},
    started() {
      throw Error("Late owner started");
    },
    line() {},
    async finish(exit) {
      if (exit === null) abandoned++;
    },
  });
  await pending.catch(() => {});
  await Bun.sleep(0);
  expect(result).toBe(fixedFailure);
  expect(aborted).toBe(true);
  expect(abandoned).toBe(1);
  expect(existsSync(f.dump)).toBe(false);
});

test("a never-resolving finish cannot hold provider done or Stop after actual tree exit", async () => {
  const f = setup();
  f.request.command = [
    process.execPath,
    join(import.meta.dir, "fixtures/delayed-fake-cli.ts"),
    ...(f.request.command?.slice(2) ?? []),
  ];
  let aborted = false;
  const finishEntered = deferred<ChildExit | null>();
  const handle = await claudeAdapter.spawn({
    ...f.request,
    privateCapture: {
      deadlineMs: 100,
      async prepare(_input, control) {
        control.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          holdTree() {},
          started() {},
          line() {},
          finish: (exit: ChildExit | null) => {
            finishEntered.resolve(exit);
            return new Promise(() => {});
          },
        };
      },
    },
  });
  try {
    let entryTimer: ReturnType<typeof setTimeout> | undefined;
    let exit: ChildExit | null;
    try {
      exit = await Promise.race([
        finishEntered.promise,
        new Promise<never>((_, reject) => {
          entryTimer = setTimeout(
            () =>
              reject(
                Error(
                  "The closed fixture did not reach private finish after owned exit",
                ),
              ),
            f.request.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (entryTimer) clearTimeout(entryTimer);
    }
    expect(exit).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stopped: false,
    });
    expect(() => process.kill(handle.pid, 0)).toThrow();
    let dump: unknown;
    try {
      dump = JSON.parse(readFileSync(f.dump, "utf8"));
    } catch {
      throw Error("Missing closed fixture process receipt");
    }
    if (
      !dump ||
      typeof dump !== "object" ||
      !("pid" in dump) ||
      typeof dump.pid !== "number"
    )
      throw Error("Invalid closed fixture process identity");
    expect(alive(dump.pid)).toBe(false);
    const result = await Promise.race([
      handle.done,
      Bun.sleep(1000).then(() => null),
    ]);
    expect(result).toMatchObject({ exitCode: 0, privateCaptureFailed: true });
    expect(aborted).toBe(true);
    expect(() => process.kill(handle.pid, 0)).toThrow();
    await handle.stop("already exited");
  } finally {
    await handle.stop("closed finish oracle cleanup");
    void handle.done.catch(() => {});
  }
});
