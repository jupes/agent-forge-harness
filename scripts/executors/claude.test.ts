import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { BUILTIN_SMITHS } from "../config/defaults";
import { runVerdictWrite } from "../eval-verdict-cli";
import { comparableCheckout } from "../forge/runs";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { getSessionModel, getSubagentModels } from "../ledger/session-models";
import { RUN_CORRELATION_ENV, RUN_CORRELATIONS_DIR } from "../run-correlation";
import { scratchDirs } from "../test-scratch";
import { claudeAdapter, parseClaudeError, parseClaudeLine } from "./claude";
import { type ExecDeps, runExec } from "./exec-cli";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const fake = (mode = "ok") => [
  process.execPath,
  FAKE,
  "--fake-provider",
  "claude",
  "--fake-mode",
  mode,
];

const ledgers: string[] = [];
const scratch = scratchDirs();
afterEach(() => {
  // A ledger file still open cannot be removed on Windows: close first.
  for (const ledger of ledgers.splice(0)) closeLedger(ledger);
  scratch.cleanup();
});

/**
 * A harness root that is its own checkout, a run directory that is one too,
 * and a ledger file nothing else writes. The root is spelled the way the file
 * system reports it, which is how the ledger spells a checkout.
 */
function setup() {
  const root = realpathSync.native(scratch.make("forge claude "));
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
    adapters: { claude: claudeAdapter },
  };
  return { root, worktree, ledger, deps };
}

describe("claude adapter through forge:exec (fake binary)", () => {
  test("the default smith leaves session.started, prompt.submitted, a tool.called per tool and session.ended in the ledger, each carrying the smith", async () => {
    const { root, worktree, ledger, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-1",
        "--run",
        "run-1",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
      ],
      { ...deps, command: fake() },
    );
    expect(out.code).toBe(0);
    const data = out.body.data as Record<string, unknown>;

    const rows = queryEvents({ beadId: "b-1" }, { path: ledger });
    expect(rows.map((row) => row.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.called",
      "tool.called",
      "session.ended",
    ]);
    const smith = BUILTIN_SMITHS["claude-journeyman"];
    for (const row of rows) {
      expect(row.executor).toEqual({
        provider: "claude",
        model: smith?.model as string,
        effort: smith?.effort as string,
        smith: "claude-journeyman",
        sessionId: data.sessionId as string,
      });
      expect(row.sessionId).toBe(data.sessionId as string);
      expect(row.beadId).toBe("b-1");
      expect(row.runId).toBe("run-1");
      expect(row.workspace).toBe(comparableCheckout(root));
    }

    expect(data).toMatchObject({
      smith: "claude-journeyman",
      via: "default",
      events: 5,
      recorded: 5,
      notRecorded: 0,
      ledgerError: null,
      ledger,
    });
    expect(data).not.toHaveProperty("eventsFile");
    expect(existsSync(join(root, ".tmp", "work", "exec-events"))).toBe(false);
  });
});

describe("claude adapter through forge:exec: the model the stream reports (fake binary)", () => {
  test("is cached for the run's session, and a verdict filed in that session records it as observed; the events keep the smith that was asked for", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-1",
        "--run",
        "run-1",
        "--worktree",
        worktree,
        "--prompt",
        "review it",
      ],
      { ...deps, command: [...fake(), "--fake-model", "claude-sonnet-5-5"] },
    );
    expect(out.code).toBe(0);
    const sessionId = (out.body.data as { sessionId: string }).sessionId;
    expect(getSessionModel(sessionId, { path: ledger })).toEqual({
      provider: "claude",
      model: "claude-sonnet-5-5",
    });
    const smith = BUILTIN_SMITHS["claude-journeyman"];
    for (const row of queryEvents({ beadId: "b-1" }, { path: ledger })) {
      expect(row.executor?.model).toBe(smith?.model as string);
    }

    // forge:verdict, run in the child's worktree while the run's mirror names
    // its session, reads that cached model.
    const wrote = runVerdictWrite(
      [
        "--correlation",
        join(RUN_CORRELATIONS_DIR, "run-1.json"),
        "--verdict",
        "PASS",
        "--requested-provider",
        "claude",
        "--requested-model",
        "claude-opus-5-5",
        "--requested-rank",
        "master",
        "--review",
        "implement-1",
      ],
      {
        cwd: worktree,
        env: {},
        sessionMirror: () => sessionId,
        sessionModel: (id) => getSessionModel(id, { path: ledger }),
        subagentModels: (id) => getSubagentModels(id, { path: ledger }),
        builderSessions: () => [],
        smiths: () => Object.values(BUILTIN_SMITHS),
        runState: () => null,
      },
    );
    expect(wrote.code).toBe(0);
    expect(wrote.body.data).toMatchObject({
      beadsIssueId: "b-1",
      executionRunId: "run-1",
      evaluator: {
        requestedModel: "claude-opus-5-5",
        observedProvider: "claude",
        observedModel: "claude-sonnet-5-5",
        sessionId,
      },
    });
  });

  test("a stream whose responses name no model caches none", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      ["--bead", "b-1", "--worktree", worktree, "--prompt", "hi"],
      { ...deps, command: fake() },
    );
    expect(out.code).toBe(0);
    const sessionId = (out.body.data as { sessionId: string }).sessionId;
    expect(getSessionModel(sessionId, { path: ledger })).toBeNull();
  });
});

describe("forge:exec --run (fake binary): the ledger and the run correlation in one run", () => {
  test("the run's rows carry the bead and run, the envelope reports the correlation, and the child gets the pointer beside the adapter's variables", async () => {
    const { root, worktree, ledger, deps } = setup();
    const dump = join(root, "dump.json");
    const out = await runExec(
      [
        "--bead",
        "b-both",
        "--run",
        "run-both",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
      ],
      { ...deps, command: [...fake(), "--fake-dump", dump] },
    );
    expect(out.code).toBe(0);

    // The ledger half.
    const rows = queryEvents({ beadId: "b-both" }, { path: ledger });
    expect(rows.map((row) => row.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.called",
      "tool.called",
      "session.ended",
    ]);
    for (const row of rows) expect(row.runId).toBe("run-both");

    // The correlation half, in the same envelope.
    expect(out.body.data).toMatchObject({
      recorded: 5,
      notRecorded: 0,
      ledger,
      correlation: {
        pointer: `${RUN_CORRELATIONS_DIR}/run-both.json`,
        beadsIssueId: "b-both",
        executionRunId: "run-both",
      },
    });
    expect(out.body.data).not.toHaveProperty("correlationNote");

    // What the child received: the launcher's pointer and the adapter's own.
    const seen = JSON.parse(readFileSync(dump, "utf8")).env as Record<
      string,
      string
    >;
    const pointer = seen[RUN_CORRELATION_ENV] ?? "";
    expect(existsSync(pointer)).toBe(true);
    expect(pointer.replaceAll("\\", "/")).toEndWith(
      `${RUN_CORRELATIONS_DIR}/run-both.json`,
    );
    expect(seen).toMatchObject({
      AGENT_FORGE_ADAPTER: "1",
      AGENT_FORGE_BEAD_ID: "b-both",
      AGENT_FORGE_SMITH: "claude-journeyman",
      FORGE_SLUG: "run-both",
    });
  });
});

describe("claude adapter: shapes the real CLI printed, replayed by the fake binary", () => {
  test("a run that fails authentication (init, an assistant error message, an error result, exit 1) leaves session.started, prompt.submitted and session.ended with the failure, and no tool.called", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      ["--bead", "b-auth", "--worktree", worktree, "--prompt", "hi"],
      { ...deps, command: fake("auth") },
    );
    expect(out.code).toBe(2);
    expect(out.body.data).toMatchObject({ events: 3, recorded: 3 });

    const rows = queryEvents({ beadId: "b-auth" }, { path: ledger });
    expect(rows.map((row) => row.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "session.ended",
    ]);
    expect(rows[2]?.payload).toMatchObject({ reason: "failed: exit 1" });
  });

  test("a run that fails authentication: the session.ended row keeps the all-zero token counts and cost its result line reported", async () => {
    const { worktree, ledger, deps } = setup();
    await runExec(
      ["--bead", "b-auth-usage", "--worktree", worktree, "--prompt", "hi"],
      { ...deps, command: fake("auth") },
    );
    const [ended] = queryEvents(
      { beadId: "b-auth-usage", kinds: ["session.ended"] },
      { path: ledger },
    );
    expect(ended?.payload).toMatchObject({
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
    });
  });

  test("the reason an error result gives is in forge:exec's output, and stays out of the ledger", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      ["--bead", "b-auth-why", "--worktree", worktree, "--prompt", "hi"],
      { ...deps, command: fake("auth") },
    );
    expect(out.code).toBe(2);
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toBe("provider exited 1: not signed in (fake)");
    expect(out.body.data).toMatchObject({
      exitCode: 1,
      providerErrors: ["not signed in (fake)"],
    });

    const rows = queryEvents({ beadId: "b-auth-why" }, { path: ledger });
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain("not signed in");
  });
});

describe("claude adapter through forge:exec: usage (fake binary)", () => {
  test("the usage the result line reported reaches the session.ended row, and nothing else of the result does", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      ["--bead", "b-usage", "--worktree", worktree, "--prompt", "hi"],
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
        inputTokens: 12,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 4000,
        outputTokens: 56,
        costUsd: 0.0125,
      },
    });
  });
});

describe("parseClaudeLine", () => {
  const line = (value: unknown) => JSON.stringify(value);

  test("each tool_use block of an assistant message is one tool; text blocks are not", () => {
    const assistant = line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "working on it" },
          { type: "tool_use", id: "t1", name: "Write", input: { a: 1 } },
          { type: "tool_use", id: "t2", name: "Bash", input: { b: 2 } },
        ],
      },
    });
    expect(parseClaudeLine(assistant)).toEqual({
      tools: [
        { tool: "Write", input: { a: 1 } },
        { tool: "Bash", input: { b: 2 } },
      ],
    });
  });

  test("a block that is not a tool_use is not a tool, even when it carries a name", () => {
    const assistant = line({
      type: "assistant",
      message: {
        content: [
          { type: "tool_result", name: "Write", content: "done" },
          { type: "tool_use", id: "t1", name: "Read", input: { c: 3 } },
        ],
      },
    });
    expect(parseClaudeLine(assistant)).toEqual({
      tools: [{ tool: "Read", input: { c: 3 } }],
    });
  });

  test("a line that is not an assistant message yields nothing, even when it carries a tool_use block", () => {
    const echoed = {
      content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }],
    };
    const nothing = { tools: [] };
    expect(parseClaudeLine(line({ type: "user", message: echoed }))).toEqual(
      nothing,
    );
    expect(
      parseClaudeLine(line({ type: "system", subtype: "init", model: "m" })),
    ).toEqual(nothing);
    expect(
      parseClaudeLine(line({ type: "result", is_error: true, result: "no" })),
    ).toEqual(nothing);
    expect(parseClaudeLine("not json")).toEqual(nothing);
  });

  test("an assistant message reports the model its response named; a placeholder the CLI writes itself does not", () => {
    expect(
      parseClaudeLine(
        line({
          type: "assistant",
          message: {
            model: "claude-sonnet-5-5",
            content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
          },
        }),
      ),
    ).toEqual({
      tools: [{ tool: "Read", input: {} }],
      model: "claude-sonnet-5-5",
    });
    // The shape the CLI printed for a failed sign-in.
    expect(
      parseClaudeLine(
        line({
          type: "assistant",
          message: { model: "<synthetic>", content: [] },
          error: "authentication_failed",
        }),
      ),
    ).toEqual({ tools: [] });
    for (const model of ["", "  ", 7]) {
      expect(
        parseClaudeLine(
          line({ type: "assistant", message: { model, content: [] } }),
        ),
      ).toEqual({ tools: [] });
    }
  });

  test("the session id is the non-empty session_id string a line carries: on the init line, or on any other line", () => {
    expect(
      parseClaudeLine(
        line({ type: "system", subtype: "init", session_id: "sess-1" }),
      ).sessionId,
    ).toBe("sess-1");
    expect(
      parseClaudeLine(
        line({
          type: "assistant",
          message: { content: [] },
          session_id: "sess-2",
        }),
      ).sessionId,
    ).toBe("sess-2");
    for (const missing of [
      { type: "system", subtype: "init" },
      { type: "system", subtype: "init", session_id: "" },
      { type: "system", subtype: "init", session_id: 7 },
    ]) {
      expect(parseClaudeLine(line(missing))).not.toHaveProperty("sessionId");
    }
  });

  test("a result line reports its usage: each token count under its camelCase name and total_cost_usd as costUsd; other fields are not taken", () => {
    const result = line({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
        server_tool_use: { web_search_requests: 1 },
        service_tier: "standard",
      },
    });
    expect(parseClaudeLine(result).usage).toEqual({
      inputTokens: 10,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
      outputTokens: 40,
      costUsd: 0.5,
    });
  });

  test("a count that is not a non-negative integer, or a cost that is not a non-negative number, is left out; a result with neither reports no usage", () => {
    expect(
      parseClaudeLine(
        line({
          type: "result",
          total_cost_usd: 0.25,
          usage: {
            input_tokens: -1,
            output_tokens: 1.5,
            cache_read_input_tokens: "3",
          },
        }),
      ).usage,
    ).toEqual({ costUsd: 0.25 });
    expect(
      parseClaudeLine(
        line({
          type: "result",
          total_cost_usd: -2,
          usage: { output_tokens: "9" },
        }),
      ),
    ).toEqual({ tools: [] });
  });

  test("an assistant message's own usage is not the run's: only the result line reports usage", () => {
    const assistant = line({
      type: "assistant",
      message: { content: [], usage: { input_tokens: 5, output_tokens: 6 } },
    });
    expect(parseClaudeLine(assistant)).toEqual({ tools: [] });
  });
});

describe("parseClaudeError", () => {
  const line = (value: unknown) => JSON.stringify(value);

  test("a result line with is_error gives its result text, else its subtype, else says it had no message", () => {
    expect(
      parseClaudeError(
        line({ type: "result", is_error: true, result: " no sign-in " }),
      ),
    ).toBe("no sign-in");
    expect(
      parseClaudeError(
        line({ type: "result", is_error: true, subtype: "error_kind" }),
      ),
    ).toBe("error_kind");
    expect(parseClaudeError(line({ type: "result", is_error: true }))).toBe(
      "an error result with no message",
    );
  });

  test("a result without is_error, any other line and a line that is not JSON report no error", () => {
    expect(
      parseClaudeError(line({ type: "result", is_error: false, result: "x" })),
    ).toBeUndefined();
    expect(parseClaudeError(line({ type: "result" }))).toBeUndefined();
    expect(
      parseClaudeError(
        line({ type: "assistant", is_error: true, result: "x" }),
      ),
    ).toBeUndefined();
    expect(parseClaudeError("not json")).toBeUndefined();
  });
});
