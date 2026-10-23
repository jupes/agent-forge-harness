import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  GeminiChatOutcome,
  GeminiChatRuntimeEvent,
} from "../../types/gemini-chat-runtime";
import { killTree } from "../executors/supervisor";
import { scratchDirs } from "../test-scratch";
import { createGeminiChatRuntime } from "./gemini-chat-runtime";

const scratch = scratchDirs(),
  binaries = scratchDirs();
afterEach(() => scratch.cleanup());
afterAll(() => binaries.cleanup());
let command: string;
beforeAll(async () => {
  command = join(
    binaries.make("gemini-chat-binary-"),
    process.platform === "win32" ? "fixture.exe" : "fixture",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      join(import.meta.dir, "fixtures/gemini-chat-runtime-compiled.ts"),
      "--compile",
      "--outfile",
      command,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const stderr = await new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw Error(stderr);
  } finally {
    clearTimeout(timer);
  }
}, 25_000);
function fixture(mode = "normal", timeoutMs = 5000) {
  const root = realpathSync.native(scratch.make("gemini-chat-runtime-")),
    home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(join(root, ".git"));
  mkdirSync(home);
  mkdirSync(configHome);
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass = ["GEMINI_CHAT_LOG", "GEMINI_CHAT_MODE", "TEST_ALLOWED", "TEST_OPERATOR_SECRET", "AGENT_FORGE_FORGED", "NODE_OPTIONS", "BUN_OPTIONS", "NODE_PATH"]\n[smiths.gemini-example]\nprovider = "gemini"\nmodel = "exact-model"\neffort = "default"\nenabled = true\n',
  );
  const log = join(root, "record.json");
  const settings = {
    root,
    home,
    configHome,
    command: [command],
    environment: {
      ...process.env,
      GEMINI_CHAT_LOG: log,
      GEMINI_CHAT_MODE: mode,
      TEST_ALLOWED: "allowed",
      TEST_OPERATOR_SECRET: "synthetic-token",
      AGENT_FORGE_FORGED: "forged",
      NODE_OPTIONS: "--require DO_NOT_LOAD",
      BUN_OPTIONS: "--preload DO_NOT_LOAD",
      NODE_PATH: "DO_NOT_LOAD",
    },
    timeoutMs,
    cancellationTimeoutMs: 500,
    persistenceTimeoutMs: 500,
    operatorToken: () => "synthetic-token",
  };
  const records = (): Record<string, unknown>[] => {
    if (!existsSync(log)) return [];
    try {
      return JSON.parse(readFileSync(log, "utf8"));
    } catch {
      throw Error("Invalid fixture recording");
    }
  };
  return {
    root,
    log,
    settings,
    records,
    runtime: createGeminiChatRuntime(settings),
    launch: {
      route: "gemini-cli" as const,
      mode: "chat" as const,
      cwd: root,
      prompt: "Private exact first 🌱\n",
      model: "exact-model",
    },
  };
}
test("actual compiled ACP dispatch persists the real process before private input and completes one exact prompt", async () => {
  const f = fixture(),
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  expect(
    f.records().every((row) => row.kind === "version" || row.kind === "help"),
  ).toBe(true);
  const events: GeminiChatRuntimeEvent[] = [],
    requestId = randomUUID();
  const outcome = await f.runtime.run(
    { prepared, requestId, resume: null },
    async (event) => {
      if (event.kind === "process")
        expect(f.records().filter((row) => row.kind === "wire")).toEqual([]);
      events.push(event);
    },
    new AbortController().signal,
    {
      requestPermission: async () => {
        throw Error("Unexpected permission");
      },
    },
  );
  expect(outcome.phase).toBe("completed");
  expect(outcome.usage).toEqual({
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  });
  expect(
    events.some(
      (event) => event.kind === "text" && event.text === "Private ACP reply 🌱",
    ),
  ).toBe(true);
  const start = f.records().find((row) => row.kind === "start");
  expect(start).toMatchObject({
    argv: ["--acp", "--model", "exact-model"],
    allowed: "allowed",
    secretPresent: false,
    forged: false,
    preload: false,
    adapter: "1",
    smith: "gemini-example",
  });
  expect(events.find((event) => event.kind === "process")).toMatchObject({
    pid: start?.pid,
    requestId,
  });
  expect(JSON.stringify(start)).not.toContain(f.launch.prompt);
});

test("a recreated runtime resumes the exact native session and never assigns delayed replay to the new turn", async () => {
  const f = fixture(),
    first = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  const callbacks = {
    requestPermission: async () => {
      throw Error("Unexpected permission");
    },
  };
  const firstOutcome = await f.runtime.run(
    { prepared: first, requestId: randomUUID(), resume: null },
    async () => {},
    new AbortController().signal,
    callbacks,
  );
  if (!firstOutcome.sessionId) throw Error("No confirmed native identity");
  const recreated = createGeminiChatRuntime(f.settings),
    events: GeminiChatRuntimeEvent[] = [];
  const prepared = await recreated.prepare({
    smith: "gemini-example",
    launch: { ...f.launch, prompt: "Explicit second private prompt" },
  });
  const outcome = await recreated.run(
    {
      prepared,
      requestId: randomUUID(),
      resume: { sessionId: firstOutcome.sessionId, version: "0.65.0" },
    },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    callbacks,
  );
  expect(outcome.phase).toBe("completed");
  expect(f.records().filter((row) => row.kind === "start")).toHaveLength(2);
  const frames = f
    .records()
    .flatMap((row) => (row.kind === "wire" ? [row.value] : []));
  expect(
    frames.filter(
      (frame) =>
        frame &&
        typeof frame === "object" &&
        "method" in frame &&
        frame.method === "session/load",
    ),
  ).toEqual([
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: {
        cwd: prepared.canonicalCwd,
        mcpServers: [],
        sessionId: firstOutcome.sessionId,
      },
    },
  ]);
  expect(events.filter((event) => event.kind === "text")).toEqual([
    {
      kind: "text",
      role: "assistant",
      text: "Historical before load reply",
      scope: "native-session",
      requestId: null,
    },
    {
      kind: "text",
      role: "assistant",
      text: "Historical after new prompt",
      scope: "native-session",
      requestId: null,
    },
    {
      kind: "text",
      role: "assistant",
      text: "Private ACP reply 🌱",
      scope: "native-session",
      requestId: null,
    },
  ]);
});

test("an actual permission reply waits for its immutable private decision intent and uses only an offered once choice", async () => {
  const f = fixture("permission"),
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  const events: GeminiChatRuntimeEvent[] = [],
    original = randomUUID(),
    decision = randomUUID();
  let release = () => {},
    entered = () => {};
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    intent = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const running = f.runtime.run(
    { prepared, requestId: original, resume: null },
    async (event) => {
      events.push(event);
      if (event.kind === "permission-intent") {
        entered();
        await held;
      }
    },
    new AbortController().signal,
    {
      requestPermission: async (offer) => {
        expect(offer.requestId).toBe(original);
        expect(offer.options.map((option) => option.optionId)).toEqual([
          "once",
          "deny",
        ]);
        const processEvent = events.find((event) => event.kind === "process");
        if (!processEvent) throw Error("Missing actual process event");
        expect(offer.processId).toBe(processEvent.pid);
        return { requestId: decision, optionId: "once" };
      },
    },
  );
  await intent;
  const replies = () =>
    f
      .records()
      .filter(
        (row) =>
          row.kind === "wire" &&
          row.value &&
          typeof row.value === "object" &&
          "result" in row.value,
      );
  expect(replies()).toEqual([]);
  release();
  expect((await running).phase).toBe("completed");
  expect(replies()).toEqual([
    {
      kind: "wire",
      value: {
        jsonrpc: "2.0",
        id: 41,
        result: { outcome: { outcome: "selected", optionId: "once" } },
      },
    },
  ]);
  expect(events.filter((event) => event.kind === "permission-intent")).toEqual([
    {
      kind: "permission-intent",
      requestId: original,
      decisionRequestId: decision,
      rpcId: 41,
      toolCallId: "tool-one",
      optionId: "once",
    },
  ]);
});

const noPermission = {
  requestPermission: async () => {
    throw Error("Unexpected permission");
  },
};
function wire(f: ReturnType<typeof fixture>) {
  return f
    .records()
    .flatMap((row) =>
      row.kind === "wire" && row.value && typeof row.value === "object"
        ? [row.value]
        : [],
    );
}
function methodCount(f: ReturnType<typeof fixture>, method: string) {
  return wire(f).filter((frame) => "method" in frame && frame.method === method)
    .length;
}
function permissionReplies(f: ReturnType<typeof fixture>) {
  return wire(f).filter(
    (frame) => "id" in frame && frame.id === 41 && "result" in frame,
  );
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function gone(pid: number) {
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !alive(pid);
}

test.each([
  "hang-tree",
  "ignore-cancel",
  "normal-orphan",
])("actual %s drains provider and inherited-pipe helper before returning", async (mode) => {
  const f = fixture(mode, mode === "ignore-cancel" ? 500 : 5000),
    controller = new AbortController();
  const events: GeminiChatRuntimeEvent[] = [],
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  let helper = 0;
  try {
    const outcome = await f.runtime.run(
      { prepared, requestId: randomUUID(), resume: null },
      async (event) => {
        events.push(event);
        if (mode === "hang-tree" && event.kind === "text") controller.abort();
      },
      controller.signal,
      noPermission,
    );
    const pid = events.find((event) => event.kind === "process")?.pid;
    const helperRecord = f.records().find((row) => row.kind === "helper");
    if (typeof helperRecord?.pid !== "number" || !pid)
      throw Error("Missing actual fixture process identity");
    helper = helperRecord.pid;
    expect(await gone(pid)).toBe(true);
    expect(await gone(helper)).toBe(true);
    expect(methodCount(f, "session/prompt")).toBe(1);
    expect(methodCount(f, "session/cancel")).toBe(
      mode === "normal-orphan" ? 0 : 1,
    );
    expect(outcome.phase).toBe(
      mode === "normal-orphan"
        ? "completed"
        : mode === "ignore-cancel"
          ? "unknown"
          : "failed",
    );
    expect(outcome.stopReason).toBe(
      mode === "normal-orphan"
        ? "end_turn"
        : mode === "hang-tree"
          ? "cancelled"
          : null,
    );
    expect(events.find((event) => event.kind === "outcome")).toMatchObject({
      timedOut: mode === "ignore-cancel",
    });
  } finally {
    if (helper && alive(helper)) killTree(helper);
  }
});

const failures: readonly (readonly [string, GeminiChatOutcome["phase"]])[] = [
  ["error", "failed"],
  ["missing-result", "unknown"],
  ["malformed", "unknown"],
  ["overflow", "unknown"],
  ["exit-nine", "failed"],
];
test.each(
  failures,
)("actual %s preserves native failure or uncertainty without replay", async (mode, phase) => {
  const f = fixture(mode),
    events: GeminiChatRuntimeEvent[] = [];
  const prepared = await f.runtime.prepare({
    smith: "gemini-example",
    launch: f.launch,
  });
  const outcome = await f.runtime.run(
    { prepared, requestId: randomUUID(), resume: null },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    noPermission,
  );
  expect(outcome.phase).toBe(phase);
  expect(methodCount(f, "session/prompt")).toBe(1);
  expect(f.records().filter((row) => row.kind === "start")).toHaveLength(1);
  if (mode === "exit-nine")
    expect(events.find((event) => event.kind === "outcome")).toMatchObject({
      stderr: { text: "Synthetic private exit diagnostic\n" },
    });
  if (mode === "error")
    expect(outcome.reason).toBe("Synthetic authentication required");
});

test.each([
  "process",
  "identity",
  "permission-intent",
])("a failed %s save fences all dependent private bytes, including a late completion", async (kind) => {
  const f = fixture(kind === "permission-intent" ? "permission" : "normal"),
    events: GeminiChatRuntimeEvent[] = [];
  const runtime = createGeminiChatRuntime({
      ...f.settings,
      persistenceTimeoutMs: 80,
    }),
    prepared = await runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  let release = () => {};
  const late = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = await runtime.run(
    { prepared, requestId: randomUUID(), resume: null },
    async (event) => {
      events.push(event);
      if (event.kind === kind) await late;
    },
    new AbortController().signal,
    {
      requestPermission: async () => ({
        requestId: randomUUID(),
        optionId: "once",
      }),
    },
  );
  expect(outcome.phase).toBe("unknown");
  expect(permissionReplies(f)).toEqual([]);
  expect(methodCount(f, "session/prompt")).toBe(
    kind === "permission-intent" ? 1 : 0,
  );
  if (kind === "process") expect(wire(f)).toEqual([]);
  release();
  await Bun.sleep(30);
  expect(permissionReplies(f)).toEqual([]);
  expect(methodCount(f, "session/prompt")).toBe(
    kind === "permission-intent" ? 1 : 0,
  );
});

test("a final private outcome failure remains uncertain even after a native success", async () => {
  const f = fixture(),
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  const outcome = await f.runtime.run(
    { prepared, requestId: randomUUID(), resume: null },
    async (event) => {
      if (event.kind === "outcome")
        throw Error("Synthetic private disk refusal");
    },
    new AbortController().signal,
    noPermission,
  );
  expect(outcome.phase).toBe("unknown");
  expect(outcome.stopReason).toBe("end_turn");
  expect(methodCount(f, "session/prompt")).toBe(1);
});

test("native permission settlement aborts a pending callback and cannot send its late allow", async () => {
  const f = fixture("permission-controlled"),
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  let release = () => {},
    callbackSignal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = await f.runtime.run(
    { prepared, requestId: randomUUID(), resume: null },
    async () => {},
    new AbortController().signal,
    {
      requestPermission: async (_offer, signal) => {
        callbackSignal = signal;
        writeFileSync(`${f.log}.settle`, "settle exact fixture tool");
        await held;
        return { requestId: randomUUID(), optionId: "once" };
      },
    },
  );
  expect(outcome.phase).toBe("completed");
  expect(callbackSignal?.aborted).toBe(true);
  release();
  await Bun.sleep(30);
  expect(permissionReplies(f)).toEqual([]);
});

test("Stop aborts an already pending permission callback before one scoped cancellation and ignores its late allow", async () => {
  const f = fixture("permission"),
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    }),
    stop = new AbortController();
  let release = () => {},
    callbackSignal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    events: GeminiChatRuntimeEvent[] = [];
  const outcome = await f.runtime.run(
    { prepared, requestId: randomUUID(), resume: null },
    async (event) => {
      events.push(event);
    },
    stop.signal,
    {
      requestPermission: async (_offer, signal) => {
        callbackSignal = signal;
        stop.abort();
        await held;
        return { requestId: randomUUID(), optionId: "once" };
      },
    },
  );
  expect(outcome.phase).toBe("failed");
  expect(outcome.stopReason).toBe("cancelled");
  expect(callbackSignal?.aborted).toBe(true);
  expect(methodCount(f, "session/cancel")).toBe(1);
  expect(events.filter((event) => event.kind === "permission-intent")).toEqual(
    [],
  );
  release();
  await Bun.sleep(30);
  expect(permissionReplies(f)).toEqual([]);
});

test.each([
  "always",
  "unknown",
  "deadline",
])("unoffered or absent %s decisions cannot produce a native reply", async (selection) => {
  const f = fixture("permission"),
    runtime = createGeminiChatRuntime({
      ...f.settings,
      permissionTimeoutMs: 80,
    });
  const prepared = await runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    }),
    events: GeminiChatRuntimeEvent[] = [];
  const outcome = await runtime.run(
    { prepared, requestId: randomUUID(), resume: null },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    {
      requestPermission: async () => {
        if (selection === "deadline") await new Promise(() => {});
        return { requestId: randomUUID(), optionId: selection };
      },
    },
  );
  expect(outcome.phase).toBe("unknown");
  expect(permissionReplies(f)).toEqual([]);
  expect(events.filter((event) => event.kind === "permission-intent")).toEqual(
    [],
  );
});

test("a saturated private event queue fails closed without serially waiting through every queued frame", async () => {
  const f = fixture("flood"),
    runtime = createGeminiChatRuntime({
      ...f.settings,
      persistenceTimeoutMs: 80,
    });
  const prepared = await runtime.prepare({
    smith: "gemini-example",
    launch: f.launch,
  });
  let writes = 0;
  const started = Date.now();
  const outcome = await runtime.run(
    { prepared, requestId: randomUUID(), resume: null },
    async (event) => {
      if (event.kind === "text") {
        writes++;
        await new Promise(() => {});
      }
    },
    new AbortController().signal,
    noPermission,
  );
  expect(outcome.phase).toBe("unknown");
  expect(writes).toBeLessThanOrEqual(1);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(methodCount(f, "session/prompt")).toBe(1);
});

test.each([
  { version: "0.66.0" },
  { help: "--model" },
])("changed native capability evidence %j refuses before a prompt", async (control) => {
  const f = fixture(),
    prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch: f.launch,
    });
  writeFileSync(`${f.log}.control`, JSON.stringify(control));
  await expect(
    f.runtime.run(
      { prepared, requestId: randomUUID(), resume: null },
      async () => {},
      new AbortController().signal,
      noPermission,
    ),
  ).rejects.toThrow();
  expect(f.records().filter((row) => row.kind === "start")).toEqual([]);
});

test("a stopped original, unsupported resume version and foreign prepared scope cannot dispatch", async () => {
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
        { prepared, requestId: randomUUID(), resume: null },
        async () => {
          throw Error("Unexpected private write");
        },
        controller.signal,
        noPermission,
      )
    ).phase,
  ).toBe("failed");
  await expect(
    f.runtime.run(
      {
        prepared,
        requestId: randomUUID(),
        resume: { sessionId: randomUUID(), version: "0.66.0" },
      },
      async () => {},
      new AbortController().signal,
      noPermission,
    ),
  ).rejects.toThrow();
  await expect(
    f.runtime.run(
      {
        prepared: { ...prepared, canonicalRoot: f.settings.home },
        requestId: randomUUID(),
        resume: null,
      },
      async () => {},
      new AbortController().signal,
      noPermission,
    ),
  ).rejects.toThrow("changed");
  expect(f.records().map((row) => row.kind)).toEqual(["version", "help"]);
});

test.each([
  false,
  true,
])("a working directory retargeted %s during read-only preparation cannot become Chat scope", async (during) => {
  const f = fixture(),
    first = join(f.root, "first"),
    second = join(f.root, "second"),
    link = join(f.root, "linked");
  mkdirSync(first);
  mkdirSync(second);
  const detach = () =>
    process.platform === "win32" ? rmdirSync(link) : unlinkSync(link);
  symlinkSync(first, link, process.platform === "win32" ? "junction" : "dir");
  const launch = {
    ...f.launch,
    cwd: link,
    context: { projectId: "test-project", repository: f.root, worktree: link },
  };
  try {
    const prepared = await f.runtime.prepare({
      smith: "gemini-example",
      launch,
    });
    if (during)
      writeFileSync(`${f.log}.control`, JSON.stringify({ mode: "hold-help" }));
    const retarget = () => {
      detach();
      symlinkSync(
        second,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    };
    if (!during) retarget();
    const pending = f.runtime.run(
      { prepared, requestId: randomUUID(), resume: null },
      async () => {},
      new AbortController().signal,
      noPermission,
    );
    if (during) {
      const deadline = Date.now() + 3000;
      while (
        f.records().filter((row) => row.kind === "help").length < 2 &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      expect(f.records().filter((row) => row.kind === "help")).toHaveLength(2);
      retarget();
    }
    await expect(pending).rejects.toThrow("changed");
    expect(f.records().filter((row) => row.kind === "start")).toEqual([]);
    if (!during)
      expect(f.records().map((row) => row.kind)).toEqual(["version", "help"]);
  } finally {
    detach();
  }
});

test.each([
  "process",
  "identity",
  "permission-intent",
])("retargeting a prepared path across the awaited %s save cannot release dependent native bytes", async (kind) => {
  const f = fixture(kind === "permission-intent" ? "permission" : "normal"),
    first = join(f.root, "first"),
    second = join(f.root, "second"),
    link = join(f.root, "linked");
  mkdirSync(first);
  mkdirSync(second);
  const detach = () =>
    process.platform === "win32" ? rmdirSync(link) : unlinkSync(link);
  symlinkSync(first, link, process.platform === "win32" ? "junction" : "dir");
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
  let changed = false;
  try {
    const outcome = await f.runtime.run(
      { prepared, requestId: randomUUID(), resume: null },
      async (event) => {
        if (event.kind === kind) {
          detach();
          symlinkSync(
            second,
            link,
            process.platform === "win32" ? "junction" : "dir",
          );
          changed = true;
        }
      },
      new AbortController().signal,
      {
        requestPermission: async () => ({
          requestId: randomUUID(),
          optionId: "once",
        }),
      },
    );
    expect(changed).toBe(true);
    expect(outcome.phase).toBe("unknown");
    expect(methodCount(f, "session/prompt")).toBe(
      kind === "permission-intent" ? 1 : 0,
    );
    expect(permissionReplies(f)).toEqual([]);
    if (kind === "process") expect(wire(f)).toEqual([]);
    const start = f.records().find((row) => row.kind === "start");
    // Stop may end a spawned provider before its fixture entry executes.
    if (kind !== "process" || start)
      expect(start).toMatchObject({ cwd: prepared.canonicalCwd });
  } finally {
    detach();
  }
});
