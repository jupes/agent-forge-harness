import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEvent } from "../../types/hearth";
import { BUILTIN_SMITHS } from "../config/defaults";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { claudeAdapter } from "./claude";
import { createCodexAdapter, parseCodexLine } from "./codex";
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

const ledgers: string[] = [];
afterAll(() => {
  for (const ledger of ledgers) closeLedger(ledger);
});

/** A harness root and a run directory that are each their own checkout, and a ledger file nothing else writes. */
function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "forge codex ")));
  mkdirSync(join(root, ".git"));
  const worktree = join(root, "wt dir");
  mkdirSync(join(worktree, ".git"), { recursive: true });
  const ledger = join(root, "forge home", "ledger.db");
  ledgers.push(ledger);
  const deps: ExecDeps = {
    harnessRoot: root,
    home: root,
    ledgerPath: ledger,
    env: { PATH: process.env.PATH },
    adapters: { codex: createCodexAdapter({ prepare: () => undefined }) },
  };
  return { root, worktree, ledger, deps };
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
      recorded: 4,
      notRecorded: 0,
      ledgerError: null,
    });

    const rows = queryEvents({ beadId: "b-2" }, { path: ledger });
    expect(rows.map((row) => row.kind)).toEqual([
      "session.started",
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

describe("codex adapter", () => {
  test("runs its prepare step (codex:sync) before spawning", async () => {
    const prepared: string[] = [];
    const adapter = createCodexAdapter({
      prepare: (request) => {
        prepared.push(request.workspace);
      },
    });
    const root = mkdtempSync(join(tmpdir(), "codex prep "));
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

  test("maps command_execution items to tool calls with exit codes", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "ls", exit_code: 2 },
    });
    expect(parseCodexLine(line)).toEqual([
      { tool: "shell", input: "ls", exitCode: 2 },
    ]);
    expect(parseCodexLine("nope")).toEqual([]);
  });
});

describe("doctor", () => {
  test("a missing binary is data (found:false), not a throw", async () => {
    const report = await claudeAdapter.doctor([
      join(tmpdir(), "definitely-not-a-real-binary-xyz"),
    ]);
    expect(report.provider).toBe("claude");
    expect(report.found).toBe(true); // override given, but it cannot run
    expect(report.ok).toBe(false);
    expect(report.reason).toBeTruthy();
  });
});
