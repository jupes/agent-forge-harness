import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BUILTIN_SMITHS } from "../config/defaults";
import { comparableCheckout } from "../forge/runs";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { claudeAdapter, parseClaudeLine } from "./claude";
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
afterAll(() => {
  for (const ledger of ledgers) closeLedger(ledger);
});

/**
 * A harness root that is its own checkout, a run directory that is one too,
 * and a ledger file nothing else writes. The root is spelled the way the file
 * system reports it, which is how the ledger spells a checkout.
 */
function setup() {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge claude ")),
  );
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
  test("the default smith leaves session.started, a tool.called per tool and session.ended in the ledger, each carrying the smith", async () => {
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
      events: 4,
      recorded: 4,
      notRecorded: 0,
      ledgerError: null,
      ledger,
    });
    expect(data).not.toHaveProperty("eventsFile");
    expect(existsSync(join(root, ".tmp", "work", "exec-events"))).toBe(false);
  });
});

describe("claude adapter: shapes the real CLI printed, replayed by the fake binary", () => {
  test("a run that fails authentication (init, an assistant error message, an error result, exit 1) leaves session.started and session.ended with the failure, and no tool.called", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      ["--bead", "b-auth", "--worktree", worktree, "--prompt", "hi"],
      { ...deps, command: fake("auth") },
    );
    expect(out.code).toBe(2);
    expect(out.body.error).toBe("provider exited 1");
    expect(out.body.data).toMatchObject({ events: 2, recorded: 2 });

    const rows = queryEvents({ beadId: "b-auth" }, { path: ledger });
    expect(rows.map((row) => row.kind)).toEqual([
      "session.started",
      "session.ended",
    ]);
    expect(rows[1]?.payload).toMatchObject({ reason: "failed: exit 1" });
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
    expect(parseClaudeLine(assistant)).toEqual([
      { tool: "Write", input: { a: 1 } },
      { tool: "Bash", input: { b: 2 } },
    ]);
  });

  test("a line that is not an assistant message yields nothing, even when it carries a tool_use block", () => {
    const echoed = {
      content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }],
    };
    expect(parseClaudeLine(line({ type: "user", message: echoed }))).toEqual(
      [],
    );
    expect(
      parseClaudeLine(line({ type: "system", subtype: "init", model: "m" })),
    ).toEqual([]);
    expect(
      parseClaudeLine(line({ type: "result", is_error: true, result: "no" })),
    ).toEqual([]);
    expect(parseClaudeLine("not json")).toEqual([]);
  });
});
