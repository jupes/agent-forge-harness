import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { LedgerEvent } from "../../types/hearth";
import { BUILTIN_SMITHS } from "../config/defaults";
import { comparableCheckout } from "../forge/runs";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { scratchDirs } from "../test-scratch";
import {
  codexSyncDirectory,
  createCodexAdapter,
  parseCodexError,
  parseCodexLine,
} from "./codex";
import { buildChildEnv } from "./env";
import { type ExecDeps, runExec } from "./exec-cli";
import type { SpawnRequest } from "./types";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const fake = (mode = "ok") => [
  process.execPath,
  FAKE,
  "--fake-provider",
  "codex",
  "--fake-mode",
  mode,
];

test("attended approval never is explicit while ordinary Codex argv retains its original bytes", async () => {
  const f = setup(),
    smith = BUILTIN_SMITHS["codex-journeyman"];
  if (!smith) throw Error("Fixture smith missing");
  const original = [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--model",
    smith.model,
    "-c",
    `model_reasoning_effort=${smith.effort}`,
    "--cd",
    f.worktree,
    "-",
  ];
  for (const attended of [false, true]) {
    const dump = join(f.root, `argv-${attended}.json`);
    const adapter = createCodexAdapter({
      prepare: () => {},
      ...(attended ? { approvalPolicy: "never" as const } : {}),
    });
    const handle = await adapter.spawn({
      beadId: "b-approval",
      workspace: f.root,
      worktree: f.worktree,
      smith,
      prompt: "inert fixture",
      env: buildChildEnv(process.env, []),
      command: [...fake(), "--fake-dump", dump],
      timeoutMs: 5000,
    });
    try {
      expect((await handle.done).exitCode).toBe(0);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(dump, "utf8"));
      } catch {
        throw Error("No atomic fixture argv record");
      }
      if (
        !raw ||
        typeof raw !== "object" ||
        !("argv" in raw) ||
        !Array.isArray(raw.argv)
      )
        throw Error("Invalid fixture argv");
      expect(raw.argv.slice(6)).toEqual(
        attended
          ? [
              ...original.slice(0, -1),
              "--config",
              'approval_policy="never"',
              "-",
            ]
          : original,
      );
    } finally {
      await handle.stop("fixture cleanup");
      await handle.done;
    }
  }
});

const ledgers: string[] = [];
const scratch = scratchDirs();
afterEach(() => {
  // A ledger file still open cannot be removed on Windows: close first.
  for (const ledger of ledgers.splice(0)) closeLedger(ledger);
  scratch.cleanup();
});

/** A harness root and a run directory that are each their own checkout, and a ledger file nothing else writes. */
function setup() {
  const root = realpathSync.native(scratch.make("forge codex "));
  mkdirSync(join(root, ".git"));
  const worktree = join(root, "wt dir");
  mkdirSync(join(worktree, ".git"), { recursive: true });
  const ledger = join(root, "forge home", "ledger.db");
  ledgers.push(ledger);
  const deps: ExecDeps = {
    harnessRoot: root,
    home: root,
    cwd: root,
    ledgerPath: ledger,
    env: { PATH: process.env.PATH },
    adapters: { codex: createCodexAdapter({ prepare: () => undefined }) },
  };
  return { root, worktree, ledger, deps };
}

/** What the planted `codex:sync` writes in the directory it runs in: that directory. */
const SYNC_MARKER = "codex-synced.txt";

/** A `codex:sync` script in `dir` that only records where it ran. */
function plantSyncScript(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "planted-harness",
      private: true,
      scripts: { "codex:sync": "bun mark-synced.ts" },
    }),
  );
  writeFileSync(
    join(dir, "mark-synced.ts"),
    `require("fs").writeFileSync(${JSON.stringify(SYNC_MARKER)}, process.cwd());\n`,
  );
}

/**
 * A harness checkout and a linked worktree of it, laid out as git lays them
 * out (the worktree's `.git` file names its admin directory, whose
 * `commondir` leads back to the main checkout's `.git`), each with a planted
 * `codex:sync`.
 */
function harnessWithLinkedWorktree() {
  const root = realpathSync.native(scratch.make("codex sync "));
  const main = join(root, "harness main");
  const admin = join(main, ".git", "worktrees", "linked");
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "commondir"), "../..\n");
  const linked = join(root, "harness linked");
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${admin}\n`);
  plantSyncScript(main);
  plantSyncScript(linked);
  return { root, main, linked };
}

/** One run of the codex adapter with its default preparation; the reason its session ended. */
async function runDefaultCodex(where: { workspace: string; worktree: string }) {
  const handle = await createCodexAdapter().spawn({
    beadId: "b-sync",
    ...where,
    smith: BUILTIN_SMITHS["codex-journeyman"] as SpawnRequest["smith"],
    prompt: "x",
    env: buildChildEnv(process.env, []),
    command: fake(),
  });
  let reason: string | undefined;
  for await (const event of handle.events) {
    if (event.kind === "session.ended") reason = event.payload.reason;
  }
  return reason;
}

type ToolCalled = Extract<LedgerEvent, { kind: "tool.called" }>;

describe("codex adapter through forge:exec (fake binary)", () => {
  test("--smith codex-journeyman leaves the session and its shell commands in the ledger, with each command's exit code", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-2",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
        "--smith",
        "codex-journeyman",
      ],
      { ...deps, command: fake() },
    );
    expect(out.code).toBe(0);
    expect(out.body.data).toMatchObject({
      provider: "codex",
      via: "explicit",
      recorded: 5,
      notRecorded: 0,
      ledgerError: null,
    });

    const rows = queryEvents({ beadId: "b-2" }, { path: ledger });
    expect(rows.map((row) => row.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.called",
      "tool.called",
      "session.ended",
    ]);
    for (const row of rows) {
      expect(row.executor?.provider).toBe("codex");
      expect(row.executor?.smith).toBe("codex-journeyman");
    }
    const tools = rows.filter(
      (row): row is ToolCalled => row.kind === "tool.called",
    );
    for (const tool of tools) {
      expect(tool.payload.tool).toBe("shell");
      expect(tool.payload.exitCode).toBe(0);
      expect(tool.payload.argsHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("codex adapter through forge:exec: the thread id is the session id (fake binary)", () => {
  test("the envelope's sessionId and every row's session are the thread_id the stream printed on thread.started", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-thread",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
        "--smith",
        "codex-journeyman",
      ],
      { ...deps, command: [...fake(), "--fake-session-id", "thread-42"] },
    );
    expect(out.code).toBe(0);
    expect(out.body.data).toMatchObject({ sessionId: "thread-42" });
    const rows = queryEvents({ beadId: "b-thread" }, { path: ledger });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.sessionId).toBe("thread-42");
      expect(row.executor?.sessionId).toBe("thread-42");
    }
  });
});

describe("codex adapter through forge:exec: usage (fake binary)", () => {
  test("the usage turn.completed reported reaches the session.ended row", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-usage",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
        "--smith",
        "codex-journeyman",
      ],
      { ...deps, command: fake() },
    );
    expect(out.code).toBe(0);
    const [ended] = queryEvents(
      { beadId: "b-usage", kinds: ["session.ended"] },
      { path: ledger },
    );
    expect(ended?.payload).toEqual({
      reason: "completed",
      durationMs: expect.any(Number),
      usage: {
        inputTokens: 2400,
        cachedInputTokens: 1800,
        cacheWriteInputTokens: 5,
        outputTokens: 90,
        reasoningOutputTokens: 40,
      },
    });
  });
});

describe("codex adapter", () => {
  test("runs its prepare step (codex:sync) before spawning", async () => {
    const prepared: string[] = [];
    const adapter = createCodexAdapter({
      prepare: (request) => {
        prepared.push(request.workspace);
      },
    });
    const root = scratch.make("codex prep ");
    mkdirSync(join(root, ".git"));
    const handle = await adapter.spawn({
      beadId: "b",
      worktree: root,
      workspace: root,
      smith: BUILTIN_SMITHS["codex-journeyman"] as SpawnRequest["smith"],
      prompt: "x",
      env: buildChildEnv(process.env, []),
      command: [process.execPath, FAKE, "--fake-provider", "codex"],
    });
    for await (const _ of handle.events) {
      // drain
    }
    expect(prepared).toEqual([root]);
  });

  test("by default codex:sync runs in the linked worktree of the harness the executor runs in, not in the harness checkout it was launched from", async () => {
    const { main, linked } = harnessWithLinkedWorktree();
    const ended = await runDefaultCodex({ workspace: main, worktree: linked });
    expect(ended).toBe("completed");
    expect(
      comparableCheckout(readFileSync(join(linked, SYNC_MARKER), "utf8")),
    ).toBe(comparableCheckout(linked));
    expect(existsSync(join(main, SYNC_MARKER))).toBe(false);
  });

  test("by default codex:sync does not run when the executor's checkout is not the harness's (a repository of its own), and the run goes ahead", async () => {
    const { root, main } = harnessWithLinkedWorktree();
    const own = join(root, "own repo");
    mkdirSync(join(own, ".git"), { recursive: true });
    plantSyncScript(own);
    const ended = await runDefaultCodex({ workspace: main, worktree: own });
    expect(ended).toBe("completed");
    expect(existsSync(join(own, SYNC_MARKER))).toBe(false);
    expect(existsSync(join(main, SYNC_MARKER))).toBe(false);
  });

  test("codexSyncDirectory: the top level of the executor's checkout when it is the harness's (from either side of a linked worktree, or a directory inside one); none for another repository", () => {
    const { root, main, linked } = harnessWithLinkedWorktree();
    const inside = join(linked, "src", "deep");
    mkdirSync(inside, { recursive: true });
    const own = join(root, "own repo");
    mkdirSync(join(own, ".git"), { recursive: true });

    const at = (workspace: string, worktree: string) =>
      codexSyncDirectory({ workspace, worktree });
    expect(at(main, main)).toBe(comparableCheckout(main));
    expect(at(main, linked)).toBe(comparableCheckout(linked));
    expect(at(linked, main)).toBe(comparableCheckout(main));
    expect(at(main, inside)).toBe(comparableCheckout(linked));
    expect(at(main, own)).toBeUndefined();
    expect(at(own, main)).toBeUndefined();
  });

  test("maps command_execution items to tool calls with exit codes", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "ls", exit_code: 2 },
    });
    expect(parseCodexLine(line).tools).toEqual([
      { tool: "shell", input: "ls", exitCode: 2 },
    ]);
    expect(parseCodexLine("nope")).toEqual({ tools: [] });
  });

  test("the session id is the non-empty thread_id string of thread.started; no other line reports one", () => {
    const line = (value: unknown) => JSON.stringify(value);
    expect(
      parseCodexLine(line({ type: "thread.started", thread_id: "thread-1" })),
    ).toEqual({ tools: [], sessionId: "thread-1" });
    for (const missing of [
      { type: "thread.started" },
      { type: "thread.started", thread_id: "" },
      { type: "thread.started", thread_id: 7 },
      { type: "turn.started", thread_id: "thread-1" },
    ]) {
      expect(parseCodexLine(line(missing))).toEqual({ tools: [] });
    }
  });

  test("turn.completed reports its usage: the five token counts under camelCase names, a count that is not a non-negative integer left out; no other line reports usage", () => {
    const line = (value: unknown) => JSON.stringify(value);
    expect(
      parseCodexLine(
        line({
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 60,
            cache_write_input_tokens: 2,
            output_tokens: 9,
            reasoning_output_tokens: 4,
          },
        }),
      ),
    ).toEqual({
      tools: [],
      usage: {
        inputTokens: 100,
        cachedInputTokens: 60,
        cacheWriteInputTokens: 2,
        outputTokens: 9,
        reasoningOutputTokens: 4,
      },
    });
    expect(
      parseCodexLine(
        line({
          type: "turn.completed",
          usage: {
            input_tokens: 7,
            output_tokens: -1,
            cached_input_tokens: "3",
          },
        }),
      ).usage,
    ).toEqual({ inputTokens: 7 });
    for (const without of [
      { type: "turn.completed" },
      { type: "turn.completed", usage: { input_tokens: "1" } },
      { type: "turn.failed", usage: { input_tokens: 1 } },
    ]) {
      expect(parseCodexLine(line(without))).toEqual({ tools: [] });
    }
  });

  test("a command the stream reports twice (item.started, then item.completed) is one tool call, with the completed item's exit code", () => {
    const item = {
      id: "item_1",
      type: "command_execution",
      command: "write-file hello.txt",
      aggregated_output: "",
    };
    const started = JSON.stringify({
      type: "item.started",
      item: { ...item, exit_code: null, status: "in_progress" },
    });
    const completed = JSON.stringify({
      type: "item.completed",
      item: { ...item, exit_code: 0, status: "completed" },
    });
    expect(
      [started, completed].flatMap((line) => parseCodexLine(line).tools),
    ).toEqual([{ tool: "shell", input: "write-file hello.txt", exitCode: 0 }]);
  });

  test("parseCodexError: an error item, error and turn.failed give their message, or their type when it has none; other lines report no error", () => {
    const line = (value: unknown) => JSON.stringify(value);
    expect(
      parseCodexError(
        line({
          type: "item.completed",
          item: { id: "i", type: "error", message: " no host " },
        }),
      ),
    ).toBe("no host");
    expect(parseCodexError(line({ type: "error", message: "gone" }))).toBe(
      "gone",
    );
    expect(
      parseCodexError(line({ type: "turn.failed", error: { message: "no" } })),
    ).toBe("no");
    expect(
      parseCodexError(
        line({ type: "item.completed", item: { type: "error" } }),
      ),
    ).toBe("error item");
    expect(parseCodexError(line({ type: "error" }))).toBe("error");
    expect(parseCodexError(line({ type: "turn.failed" }))).toBe("turn.failed");

    expect(
      parseCodexError(
        line({
          type: "item.completed",
          item: { type: "agent_message", text: "I could not do it" },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseCodexError(line({ type: "item.started", item: { type: "error" } })),
    ).toBeUndefined();
    expect(parseCodexError(line({ type: "turn.completed" }))).toBeUndefined();
    expect(parseCodexError("not json")).toBeUndefined();
  });
});

describe("codex adapter: shapes the real CLI printed, replayed by the fake binary", () => {
  test("a run whose model is rejected (an error item, error, turn.failed, exit 1) leaves session.started, prompt.submitted and session.ended with the failure, and no tool.called", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-model",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
        "--smith",
        "codex-journeyman",
      ],
      { ...deps, command: fake("model") },
    );
    expect(out.code).toBe(2);
    expect(out.body.data).toMatchObject({ events: 3, recorded: 3 });

    const rows = queryEvents({ beadId: "b-model" }, { path: ledger });
    expect(rows.map((row) => row.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "session.ended",
    ]);
    expect(rows[2]?.payload).toMatchObject({ reason: "failed: exit 1" });
  });

  test("a rejected model: the message its error item, error and turn.failed carry is in forge:exec's output once, and stays out of the ledger", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-model-why",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
        "--smith",
        "codex-journeyman",
      ],
      { ...deps, command: fake("model") },
    );
    expect(out.code).toBe(2);
    expect(out.body.error).toBe(
      "provider exited 1: the model is not supported (fake)",
    );
    expect(out.body.data).toMatchObject({
      providerErrors: ["the model is not supported (fake)"],
    });

    const rows = queryEvents({ beadId: "b-model-why" }, { path: ledger });
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain("not supported");
  });

  test("a copy with no tool host (an error item, an agent message, turn.completed, exit 0) is not reported as success: exit 2, the provider's message in the output, and session.ended says the provider reported an error", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-no-host",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
        "--smith",
        "codex-journeyman",
      ],
      { ...deps, command: fake("no-tool-host") },
    );
    expect(out.code).toBe(2);
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toBe(
      "provider exited 0 but reported an error: the tool host was not found, so no command can run (fake)",
    );
    expect(out.body.data).toMatchObject({
      exitCode: 0,
      providerErrors: [
        "the tool host was not found, so no command can run (fake)",
      ],
    });

    const rows = queryEvents({ beadId: "b-no-host" }, { path: ledger });
    expect(rows.map((row) => row.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "session.ended",
    ]);
    expect(rows[2]?.payload).toMatchObject({
      reason: "failed: exit 0, provider reported an error",
    });
    expect(JSON.stringify(rows)).not.toContain("tool host");
  });
});
