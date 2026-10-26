import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CodexChatEvent, CodexChatLaunch } from "../../types/codex-chat";
import { scratchDirs } from "../test-scratch";
import { parseCodexChatForkRuntimeInput } from "./codex-chat-fork-runtime-protocol";
import {
  type CodexChatCallbacks,
  createCodexChatRuntime,
} from "./codex-chat-runtime";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const fake = join(import.meta.dir, "fixtures/codex-app-server-cli.ts");
const version = "0.163.0-alpha.10.2";
const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
function fixture(mode = "normal") {
  const root = scratch.make("codex-chat-runtime-"),
    home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(home);
  mkdirSync(configHome);
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass = ["CODEX_CHAT_MODE", "CODEX_CHAT_LOG", "TEST_ALLOWED", "TEST_SECRET", "AGENT_FORGE_FORGED", "FORGE_SLUG"]\n',
  );
  const log = join(root, "fake.jsonl");
  const options = {
    root,
    home,
    configHome,
    command: [process.execPath, fake],
    syncCommand: [process.execPath, fake, "--sync"],
    environment: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: home,
      USERPROFILE: home,
      CODEX_CHAT_MODE: mode,
      CODEX_CHAT_LOG: log,
      TEST_ALLOWED: "allowed",
      TEST_SECRET: "prefix-synthetic-operator-token",
      AGENT_FORGE_FORGED: "forged",
      FORGE_SLUG: "forged",
    },
    timeoutMs: 5000,
    rpcTimeoutMs: 1000,
    approvalTimeoutMs: 1000,
    persistenceTimeoutMs: 500,
    operatorToken: () => "synthetic-operator-token",
    modelEfforts: [
      {
        model: "exact-model",
        efforts: ["high"],
        source: "model/list" as const,
        cliVersion: version,
        asOf: "2026-10-23T00:00:00.000Z",
      },
    ],
  };
  const runtime = createCodexChatRuntime(options);
  const launch: CodexChatLaunch = {
    mode: "chat",
    cwd: root,
    model: "exact-model",
    effort: "high",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    prompt: "Private 🌱 $(literal)",
    context: {
      projectId: "project-a",
      repository: root,
      worktree: root,
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
      throw new Error("Malformed inert app-server recording.");
    }
  };
  return { root, runtime, launch, records, options };
}

async function forkInput(f: ReturnType<typeof fixture>) {
  const prepared = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  return parseCodexChatForkRuntimeInput({
    prepared,
    parent: { provider: "codex", threadId, version },
    lastTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    sourceSettings: {
      modelProvider: "openai",
      serviceTier: null,
      reasoningEffort: "high",
    },
  });
}

test("the dedicated native Fork sends one bounded fork request and returns only verified child metadata", async () => {
  const f = fixture("fork"),
    input = await forkInput(f);
  const result = await f.runtime.fork(input),
    calls = f.records().filter((row) => row.kind === "rpc"),
    initialize = calls.find((row) => row.method === "initialize"),
    fork = calls.find((row) => row.method === "thread/fork");
  expect(result.threadId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a55");
  expect(result.forkedFromId).toBe(threadId);
  expect(result).not.toHaveProperty("preview");
  expect(result).not.toHaveProperty("path");
  expect(calls.map((row) => row.method)).toEqual(["initialize", "thread/fork"]);
  expect(
    f
      .records()
      .filter((row) => row.kind === "notification")
      .map((row) => row.method),
  ).toEqual(["initialized"]);
  expect(initialize?.params).toMatchObject({
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  expect(fork?.params).toMatchObject({
    threadId,
    lastTurnId: input.lastTurnId,
    modelProvider: "openai",
    serviceTier: null,
    ephemeral: false,
    excludeTurns: true,
    deferGoalContinuation: true,
  });
  expect(fork?.params).not.toHaveProperty("path");
  expect(fork?.params).not.toHaveProperty("beforeTurnId");
  expect(fork?.params).not.toHaveProperty("experimentalPredictionMode");
});

test("Fork refuses an already-cancelled request before startup or capability probes", async () => {
  const cancelled = fixture("fork"),
    cancelledInput = await forkInput(cancelled),
    before = cancelled.records(),
    controller = new AbortController();
  controller.abort();
  await expect(
    cancelled.runtime.fork({ ...cancelledInput, signal: controller.signal }),
  ).rejects.toThrow();
  expect(cancelled.records()).toEqual(before);
});

const forkFailureCases: [string, string[]][] = [
  ["fork-initialize-failure", ["initialize"]],
  ["fork-server-request", ["initialize"]],
  ["fork-malformed", ["initialize", "thread/fork"]],
  ["fork-oversized", ["initialize", "thread/fork"]],
  ["fork-wrong-parent", ["initialize", "thread/fork"]],
  ["fork-wrong-child", ["initialize", "thread/fork"]],
  ["fork-wrong-config", ["initialize", "thread/fork"]],
  ["fork-active", ["initialize", "thread/fork"]],
  ["fork-cleanup-failure", ["initialize", "thread/fork"]],
  ["fork-lost-response", ["initialize", "thread/fork"]],
];
test.each(
  forkFailureCases,
)("Fork rejects %s without retry or falling back to Start", async (mode, expectedMethods) => {
  const f = fixture(mode),
    input = await forkInput(f);
  await expect(f.runtime.fork(input)).rejects.toThrow();
  const calls = f.records().filter((row) => row.kind === "rpc");
  expect(calls.map((row) => row.method)).toEqual(expectedMethods);
  expect(calls.filter((row) => row.method === "thread/fork")).toHaveLength(
    expectedMethods.includes("thread/fork") ? 1 : 0,
  );
  expect(
    calls.some((row) =>
      ["thread/start", "thread/resume", "turn/start"].includes(
        String(row.method),
      ),
    ),
  ).toBe(false);
  if (mode === "fork-lost-response")
    expect(
      f.records().some((row) => row.kind === "fork-created-without-response"),
    ).toBe(true);
});
test("an actual native Chat retains mutable supplied turn plans without inventing an item, mode or completion from step status", async () => {
  const f = fixture("turn-plan"),
    events: CodexChatEvent[] = [];
  const prepared = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  const result = await f.runtime.run(
    { prepared, resume: null },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    { requestApproval: async () => "decline" },
  );
  expect(result.phase).toBe("completed");
  const plans = events.filter((event) => event.kind === "turn-plan");
  expect(plans).toHaveLength(3);
  expect(plans[0]).toEqual(plans[1]);
  expect(plans[0]).not.toHaveProperty("itemId");
  expect(events).toContainEqual({
    kind: "turn-plan",
    source: "turn/plan/updated",
    threadId,
    turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    explanation: null,
    plan: [
      {
        step: { text: "Inspect the supplied context", truncated: false },
        status: "inProgress",
      },
      {
        step: { text: "Check the result", truncated: false },
        status: "pending",
      },
    ],
    truncated: false,
  });
  expect(events).toContainEqual({
    kind: "turn-plan",
    source: "turn/plan/updated",
    threadId,
    turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    explanation: {
      text: "The provider revised its supplied plan.",
      truncated: false,
    },
    plan: [
      {
        step: { text: "Inspect the supplied context", truncated: false },
        status: "completed",
      },
      {
        step: { text: "Check the revised result", truncated: false },
        status: "inProgress",
      },
    ],
    truncated: false,
  });
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(f.records().find((row) => row.method === "initialize")).toMatchObject({
    params: { capabilities: { experimentalApi: false } },
  });
  expect(
    f.records().find((row) => row.method === "turn/start")?.params,
  ).not.toHaveProperty("plan");
});

test("an actual native Chat exposes only explicit indexed reasoning summaries without requesting or retaining raw content", async () => {
  const f = fixture("reasoning-summary"),
    events: CodexChatEvent[] = [];
  const prepared = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  const result = await f.runtime.run(
    { prepared, resume: null },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    { requestApproval: async () => "decline" },
  );
  expect(result.phase).toBe("completed");
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "reasoning-summary",
      source: "item/reasoning/summaryTextDelta",
      threadId,
      turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
      itemId: "reported-reasoning-a",
      partial: true,
      update: {
        kind: "delta",
        summaryIndex: 0,
        content: { text: "Visible ", truncated: false },
        prefixMissing: false,
      },
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "reasoning-summary",
      source: "item/completed",
      partial: false,
      update: {
        kind: "snapshot",
        summary: [
          { text: "Visible summary one.", truncated: false },
          { text: "Visible summary two.", truncated: false },
        ],
        truncated: false,
        closure: "item-ended",
        turnStatus: null,
      },
    }),
  );
  expect(JSON.stringify(events)).not.toContain(
    "RAW_REASONING_MUST_NOT_PERSIST",
  );
  expect(events.filter((event) => event.kind === "text")).toEqual([
    { kind: "text", itemId: "message-a", text: "Hello" },
    { kind: "text", itemId: "message-a", text: " world" },
  ]);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(f.records().find((row) => row.method === "initialize")).toMatchObject({
    params: { capabilities: { experimentalApi: false } },
  });
  expect(
    f.records().find((row) => row.method === "thread/start")?.params,
  ).not.toHaveProperty("experimentalRawEvents");
  expect(
    f.records().find((row) => row.method === "turn/start")?.params,
  ).not.toHaveProperty("summary");
});

test("an actual native Chat command preserves started, streamed and completed reports outside assistant text", async () => {
  const f = fixture("command-activity");
  const prepared = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  const events: CodexChatEvent[] = [];
  const result = await f.runtime.run(
    { prepared, resume: null },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    { requestApproval: async () => "decline" },
  );
  const identity = {
    kind: "command" as const,
    threadId,
    turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    itemId: "reported-command-a",
    command: { text: "inert command <script> stays text", truncated: false },
    cwd: f.root,
  };
  expect(events).toContainEqual({
    ...identity,
    source: "item/started",
    status: "inProgress",
    output: null,
    outputSource: null,
    exitCode: null,
    durationMs: null,
    partial: true,
  });
  expect(events).toContainEqual({
    ...identity,
    source: "item/commandExecution/outputDelta",
    status: "inProgress",
    output: { text: "Reported line one\n", truncated: false },
    outputSource: "delta",
    exitCode: null,
    durationMs: null,
    partial: true,
  });
  expect(events).toContainEqual({
    ...identity,
    source: "item/completed",
    status: "completed",
    output: {
      text: "Reported line one\nReported line two\n",
      truncated: false,
    },
    outputSource: "aggregate",
    exitCode: 0,
    durationMs: 12,
    partial: false,
  });
  expect(result.phase).toBe("completed");
  expect(events.filter((event) => event.kind === "text")).toEqual([
    { kind: "text", itemId: "message-a", text: "Hello" },
    { kind: "text", itemId: "message-a", text: " world" },
  ]);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
});

test("native Chat starts and resumes exactly one owned thread across two supervised processes", async () => {
  const f = fixture();
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  expect(f.records().map((row) => row.kind)).toEqual(["version", "help"]);
  const first: CodexChatEvent[] = [];
  const result = await f.runtime.run(
    { prepared: snapshot, resume: null },
    async (event) => {
      first.push(event);
    },
    new AbortController().signal,
    { requestApproval: async () => "decline" },
  );
  expect(result).toMatchObject({
    phase: "completed",
    threadId,
    observedModel: null,
    exitCode: 0,
    stopped: false,
    timedOut: false,
  });
  expect(first.filter((event) => event.kind === "text")).toEqual([
    { kind: "text", itemId: "message-a", text: "Hello" },
    { kind: "text", itemId: "message-a", text: " world" },
  ]);
  const second = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: { ...f.launch, prompt: "Second explicit private turn" },
  });
  const next = await f.runtime.run(
    { prepared: second, resume: { provider: "codex", threadId, version } },
    async () => {},
    new AbortController().signal,
    { requestApproval: async () => "decline" },
  );
  expect(next.phase).toBe("completed");
  const calls = f.records().filter((row) => row.kind === "rpc");
  expect(calls.filter((row) => row.method === "thread/start")).toHaveLength(1);
  expect(calls.filter((row) => row.method === "thread/resume")).toHaveLength(1);
  expect(
    calls.find((row) => row.method === "thread/resume")?.params,
  ).toMatchObject({ threadId, excludeTurns: true });
  expect(JSON.stringify(calls)).not.toContain('"history"');
  expect(JSON.stringify(calls)).not.toContain('"path"');
  expect(
    f
      .records()
      .filter((row) => row.kind === "process")
      .map((row) => row.argv),
  ).toEqual([
    ["app-server", "--stdio"],
    ["app-server", "--stdio"],
  ]);
});

test("native approval is private and durable before one narrow reply reaches the live process", async () => {
  const f = fixture("approval-command"),
    events: CodexChatEvent[] = [];
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  let calls = 0;
  const result = await f.runtime.run(
    { prepared: snapshot, resume: null },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    {
      async requestApproval(approval) {
        calls++;
        expect(
          events.some(
            (event) =>
              event.kind === "approval-request" &&
              event.approval.id === approval.id,
          ),
        ).toBe(true);
        expect(approval).toMatchObject({
          provider: "codex",
          threadId,
          nativeRequestId: 1,
          kind: "command",
          command: "inert example",
          availableDecisions: ["accept", "decline", "cancel"],
        });
        expect(Object.isFrozen(approval)).toBe(true);
        const processEvent = events.find((event) => event.kind === "process");
        expect(processEvent?.pid).toBe(approval.processId);
        expect(processEvent?.wrapperPid).not.toBe(approval.processId);
        expect(f.records().find((row) => row.kind === "process")?.pid).toBe(
          approval.processId,
        );
        return "accept";
      },
    },
  );
  expect(result.phase).toBe("completed");
  expect(calls).toBe(1);
  expect(f.records().filter((row) => row.kind === "answer")).toMatchObject([
    { id: 1, result: { decision: "accept" } },
  ]);
  expect(
    events
      .filter((event) => event.kind.startsWith("approval-"))
      .map((event) => event.kind),
  ).toEqual(["approval-request", "approval-decision", "approval-resolved"]);
});

for (const decision of ["accept", "decline", "cancel"] as const) {
  test(`native file approval supports exactly one ${decision} reply with a string RPC id`, async () => {
    const f = fixture("approval-file");
    const snapshot = await f.runtime.prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    });
    let calls = 0;
    const result = await f.runtime.run(
      { prepared: snapshot, resume: null },
      async () => {},
      new AbortController().signal,
      {
        requestApproval: async (approval) => {
          calls++;
          expect(approval.kind).toBe("file-change");
          expect(approval.nativeRequestId).toBe("1");
          return decision;
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.phase).toBe(decision === "cancel" ? "failed" : "completed");
    expect(f.records().filter((row) => row.kind === "answer")).toMatchObject([
      { id: "1", result: { decision } },
    ]);
  });
}

const decline = { requestApproval: async () => "decline" as const };
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
async function until<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw new Error("The inert native fixture did not reach its expected state.");
}
function treeRecord(records: Record<string, unknown>[]) {
  const row = records.find((record) => record.kind === "tree");
  return row && typeof row.pid === "number" && typeof row.childPid === "number"
    ? { pid: row.pid, childPid: row.childPid }
    : null;
}
async function stoppedTree(pids: { pid: number; childPid: number }) {
  return until(() => (!alive(pids.pid) && !alive(pids.childPid) ? true : null));
}

for (const mode of [
  "foreign",
  "malformed",
  "premature",
  "settings-mismatch",
  "provider-error",
  "bad-exit",
  "approval-conflict",
]) {
  test(`native ${mode} cannot become successful private Chat completion`, async () => {
    const f = fixture(mode),
      events: CodexChatEvent[] = [];
    let offered = 0;
    // The owner has not answered when the conflicting native request arrives.
    // Separate pipe writes may otherwise deliver an already authorized decline
    // before the later conflict; future protocol input cannot undo that reply.
    const waitingAuthority: CodexChatCallbacks = {
      requestApproval: async (_approval, signal) => {
        offered++;
        return new Promise((_resolve, reject) => {
          const abort = () =>
            reject(Error("Conflicting native request stopped"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const snapshot = await f.runtime.prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    });
    const result = await f.runtime.run(
      { prepared: snapshot, resume: null },
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
      mode === "approval-conflict" ? waitingAuthority : decline,
    );
    expect(result.phase).not.toBe("completed");
    expect(result.reason).not.toContain("private-provider-error");
    expect(
      events
        .filter((event) => event.kind === "text")
        .map((event) => event.text)
        .join(""),
    ).not.toContain("foreign body");
    const pids = treeRecord(f.records());
    if (pids) expect(await stoppedTree(pids)).toBe(true);
    if (mode === "settings-mismatch")
      expect(
        f.records().filter((row) => row.method === "turn/start"),
      ).toHaveLength(0);
    if (mode === "approval-conflict") {
      expect(offered).toBeLessThanOrEqual(1);
      expect(events.some((event) => event.kind === "approval-decision")).toBe(
        false,
      );
      expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(
        0,
      );
    }
  });
}

test("duplicate native approval requests call authority once; native resolution prevents late answers", async () => {
  for (const mode of ["approval-command-duplicate", "approval-resolved"]) {
    const f = fixture(mode),
      events: CodexChatEvent[] = [];
    const snapshot = await f.runtime.prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    });
    let calls = 0,
      late: (() => void) | null = null;
    const result = await f.runtime.run(
      { prepared: snapshot, resume: null },
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
      {
        async requestApproval() {
          calls++;
          if (mode === "approval-command-duplicate") return "accept";
          return new Promise((resolve) => {
            late = () => resolve("accept");
          });
        },
      },
    );
    expect(result.phase).toBe("completed");
    expect(calls).toBeLessThanOrEqual(1);
    const finishLate = (): (() => void) | null => late;
    finishLate()?.();
    await Bun.sleep(20);
    expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(
      mode === "approval-command-duplicate" ? 1 : 0,
    );
    expect(
      events.filter((event) => event.kind === "approval-request"),
    ).toHaveLength(1);
  }
});

test("replaying an already resolved native approval refuses without another callback or reply", async () => {
  const f = fixture("approval-stale");
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  let calls = 0;
  const result = await f.runtime.run(
    { prepared: snapshot, resume: null },
    async () => {},
    new AbortController().signal,
    {
      requestApproval: () => {
        calls++;
        return new Promise(() => {});
      },
    },
  );
  expect(result.phase).toBe("unknown");
  expect(calls).toBeLessThanOrEqual(1);
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(0);
});

test.each([
  "approval-never",
  "hang-initialize",
] as const)("%s: an unanswered live protocol phase stops real native descendants", async (mode) => {
  const f = fixture(mode),
    runtime = createCodexChatRuntime({
      ...f.options,
      timeoutMs: 10000,
      rpcTimeoutMs: 5000,
      approvalTimeoutMs: 100,
    });
  const snapshot = await runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  let approvals = 0;
  const result = await runtime.run(
    { prepared: snapshot, resume: null },
    async () => {},
    new AbortController().signal,
    {
      requestApproval: () => {
        approvals++;
        return new Promise(() => {});
      },
    },
  );
  expect(result.phase).toBe("unknown");
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(f.records().some((row) => row.method === "initialize")).toBe(true);
  expect(approvals).toBe(mode === "approval-never" ? 1 : 0);
  const pids = treeRecord(f.records());
  expect(pids).not.toBeNull();
  if (pids) expect(await stoppedTree(pids)).toBe(true);
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(0);
}, 15000);

test("Stop lets an in-flight private write settle within its own deadline before saving one final native outcome", async () => {
  const f = fixture("hang-text"),
    controller = new AbortController();
  const runtime = createCodexChatRuntime({
    ...f.options,
    persistenceTimeoutMs: 3000,
  });
  const snapshot = await runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  let writing = false;
  let release: () => void = () => {
    throw Error("Private writer was not held");
  };
  const persisted: CodexChatEvent[] = [];
  const running = runtime.run(
    { prepared: snapshot, resume: null },
    async (event) => {
      if (event.kind === "text") {
        writing = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      persisted.push(event);
    },
    controller.signal,
    decline,
  );
  const pids = await until(() => treeRecord(f.records()));
  await until(() => (writing ? true : null));
  controller.abort();
  expect(await stoppedTree(pids)).toBe(true);
  release();
  const result = await running;
  expect(result).toMatchObject({
    phase: "failed",
    reason: "The Codex Chat turn was stopped.",
    stopped: true,
    timedOut: false,
  });
  const final = persisted.filter((event) => event.kind === "outcome");
  expect(final).toHaveLength(1);
  expect(final[0]).toEqual({ kind: "outcome", outcome: result });
  expect(persisted.at(-1)?.kind).toBe("outcome");
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
});

test("explicit Stop confirms actual native tree cleanup while a private writer never settles", async () => {
  const f = fixture("hang-text"),
    controller = new AbortController();
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  let writing = false,
    late: (() => void) | null = null;
  const persisted: CodexChatEvent[] = [];
  const running = f.runtime.run(
    { prepared: snapshot, resume: null },
    async (event) => {
      if (event.kind === "text") {
        writing = true;
        await new Promise<void>((resolve) => {
          late = resolve;
        });
      }
      persisted.push(event);
    },
    controller.signal,
    decline,
  );
  const pids = await until(() => treeRecord(f.records()));
  await until(() => (writing ? true : null));
  controller.abort();
  const result = await running;
  expect(result.phase).toBe("unknown");
  expect(result.reason).toBe("The private Chat writer exceeded its deadline.");
  expect(result.stopped).toBe(true);
  expect(await stoppedTree(pids)).toBe(true);
  const before = persisted.length;
  const finishLate = (): (() => void) | null => late;
  finishLate()?.();
  await Bun.sleep(20);
  // The underlying external writer is caller-owned; late completion never restores runtime success.
  expect(result.phase).toBe("unknown");
  expect(persisted.length).toBeLessThanOrEqual(before + 1);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
});

test.each([
  "hang",
  "never-exit",
] as const)("%s: the intended deadline stops native helpers instead of accepting terminal-plus-hang", async (mode) => {
  const f = fixture(mode),
    runtime = createCodexChatRuntime({
      ...f.options,
      // Establish which deadline wins; an initialization RPC timeout is
      // not evidence of either a hung turn or terminal shutdown cleanup.
      timeoutMs: mode === "hang" ? 5000 : 10000,
      rpcTimeoutMs: mode === "hang" ? 10000 : 1000,
    });
  const snapshot = await runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  const events: CodexChatEvent[] = [];
  const result = await runtime.run(
    { prepared: snapshot, resume: null },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    decline,
  );
  expect(result.phase).toBe("unknown");
  expect(result.timedOut, JSON.stringify(result)).toBe(mode === "hang");
  expect(f.records().some((row) => row.method === "turn/start")).toBe(true);
  if (mode === "never-exit") {
    expect(
      f.records().filter((row) => row.kind === "terminal-published"),
    ).toHaveLength(1);
    expect(events.some((event) => event.kind === "usage")).toBe(true);
    expect(result.usage).toMatchObject({
      lastResponse: { inputTokens: 9, outputTokens: 6 },
      threadTotal: { inputTokens: 19 },
    });
  }
  const pids = treeRecord(f.records());
  expect(pids).not.toBeNull();
  if (pids) expect(await stoppedTree(pids)).toBe(true);
}, 15000);

test("a rejected private writer and queue pressure remain failures even with exit zero", async () => {
  for (const mode of ["normal", "burst"]) {
    const f = fixture(mode),
      runtime = createCodexChatRuntime({
        ...f.options,
        persistenceTimeoutMs: 100,
      });
    const snapshot = await runtime.prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    });
    let count = 0;
    const result = await runtime.run(
      { prepared: snapshot, resume: null },
      async (event) => {
        count++;
        if (mode === "normal")
          return Promise.reject(new Error("synthetic private writer secret"));
        if (event.kind === "text") await new Promise(() => {});
      },
      new AbortController().signal,
      decline,
    );
    expect(result.phase).toBe("unknown");
    expect(count).toBeLessThanOrEqual(256);
    if (mode === "normal") {
      expect(result.reason).toBe("The private Chat writer failed.");
      expect(result.reason).not.toContain("synthetic private writer secret");
    }
    const pids = treeRecord(f.records());
    if (pids) expect(await stoppedTree(pids)).toBe(true);
  }
});

test("a private writer that exceeds its bounded deadline has a fixed reason without changing unknown outcome", async () => {
  const f = fixture("hang-text"),
    runtime = createCodexChatRuntime({
      ...f.options,
      persistenceTimeoutMs: 100,
    });
  const snapshot = await runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  let writing = false;
  const resultPromise = runtime.run(
    { prepared: snapshot, resume: null },
    async (event) => {
      if (event.kind === "text") {
        writing = true;
        await new Promise<void>(() => {});
      }
    },
    new AbortController().signal,
    decline,
  );
  await until(() => (writing ? true : null));
  const result = await resultPromise;
  expect(result).toMatchObject({
    phase: "unknown",
    reason: "The private Chat writer exceeded its deadline.",
    timedOut: false,
  });
  expect(result.reason).not.toContain(
    "Private Chat persistence did not settle",
  );
  const pids = treeRecord(f.records());
  if (pids) expect(await stoppedTree(pids)).toBe(true);
});

test.each([
  "reject",
  "never-settle",
] as const)("a %s final outcome save remains bounded and cannot report owned completion or resend a native prompt", async (mode) => {
  const f = fixture(),
    prepared = await f.runtime.prepare({
      smith: "codex-journeyman",
      launch: f.launch,
    });
  let offered = 0,
    processId: number | undefined,
    release: (() => void) | undefined;
  const result = await f.runtime.run(
    { prepared, resume: null },
    async (event) => {
      if (event.kind === "process") processId = event.pid;
      if (event.kind !== "outcome") return;
      offered++;
      if (mode === "reject") throw Error("Private final save refused");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    new AbortController().signal,
    decline,
  );
  expect(result).toMatchObject({
    phase: "unknown",
    exitCode: 0,
    timedOut: false,
    stopped: false,
  });
  expect(result.reason).toContain(
    "final private Chat outcome could not be saved",
  );
  expect(offered).toBe(1);
  if (processId === undefined)
    throw Error("The actual native owner was not witnessed");
  expect(alive(processId)).toBe(false);
  const before = f.records();
  expect(before.filter((row) => row.method === "turn/start")).toHaveLength(1);
  release?.();
  await Promise.resolve();
  expect(f.records()).toEqual(before);
});

test("native argv, filtered environment and acknowledged usage scopes preserve requested truth", async () => {
  const f = fixture(),
    events: CodexChatEvent[] = [];
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: {
      ...f.launch,
      attachments: [
        { kind: "text", name: "a.txt", text: "private attachment" },
      ],
    },
  });
  writeFileSync(
    join(f.root, "agent-forge.toml"),
    '[smiths.codex-journeyman]\nmodel = "new-default"\neffort = "low"\n[execution.env]\npass = ["CODEX_CHAT_MODE", "CODEX_CHAT_LOG", "TEST_ALLOWED", "TEST_SECRET", "AGENT_FORGE_FORGED", "FORGE_SLUG"]\n',
  );
  const result = await f.runtime.run(
    { prepared: snapshot, resume: null },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
    decline,
  );
  expect(result.phase).toBe("completed");
  expect(result.observedModel).toBeNull();
  const actual = f.records().find((row) => row.kind === "process");
  expect(actual).toMatchObject({
    argv: ["app-server", "--stdio"],
    cwd: f.root,
    allowed: "allowed",
  });
  expect(actual?.secret).toBeUndefined();
  expect(actual?.forged).toBeUndefined();
  expect(actual?.slug).toBeUndefined();
  const turn = f.records().find((row) => row.method === "turn/start");
  expect(turn?.params).toMatchObject({
    model: "exact-model",
    effort: "high",
    approvalsReviewer: "user",
  });
  expect(JSON.stringify(turn?.params)).toContain("private attachment");
  expect(result.usage).toMatchObject({
    lastResponse: { inputTokens: 9 },
    threadTotal: { inputTokens: 19 },
  });
  expect(events.find((event) => event.kind === "configuration")).toMatchObject({
    model: "exact-model",
    effort: "medium",
  });
});

test("retargeting the prepared directory link and implicit resume selectors refuse before dispatch", async () => {
  const f = fixture(),
    a = join(f.root, "a"),
    b = join(f.root, "b"),
    link = join(f.root, "selected");
  mkdirSync(a);
  mkdirSync(b);
  symlinkSync(a, link, process.platform === "win32" ? "junction" : "dir");
  const snapshot = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: {
      ...f.launch,
      cwd: link,
      context: { projectId: "project-a", repository: f.root, worktree: link },
    },
  });
  if (process.platform === "win32") rmdirSync(link);
  else unlinkSync(link);
  symlinkSync(b, link, process.platform === "win32" ? "junction" : "dir");
  const before = f.records().length;
  await expect(
    f.runtime.run(
      { prepared: snapshot, resume: null },
      async () => {},
      new AbortController().signal,
      decline,
    ),
  ).rejects.toThrow("directory changed");
  expect(f.records()).toHaveLength(before);
  const fresh = await f.runtime.prepare({
    smith: "codex-journeyman",
    launch: f.launch,
  });
  const prepared = f.records().length;
  await expect(
    f.runtime.run(
      {
        prepared: fresh,
        resume: { provider: "codex", threadId: "--last", version },
      },
      async () => {},
      new AbortController().signal,
      decline,
    ),
  ).rejects.toThrow();
  expect(f.records()).toHaveLength(prepared);
});
