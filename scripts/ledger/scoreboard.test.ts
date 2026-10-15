import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  LedgerEventInput,
  Scoreboard,
  ScoreboardRow,
} from "../../types/hearth";
import { validateOperatorEnvelope } from "../hearth/validate";
import { appendEvent } from "./append";
import { parseAuditArgs, runAudit } from "./audit-cli";
import { closeLedger } from "./db";
import { formatScoreboard, readScoreboard } from "./scoreboard";
import {
  ELSEWHERE_EVENTS,
  ELSEWHERE_WORKSPACE,
  FIXTURE_WORKSPACE,
  type FixtureEvent,
  SCOREBOARD_EVENTS,
} from "./scoreboard-fixture";
import { resolveCheckout } from "./workspace";

const temporary: string[] = [];

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A ledger home and a fake checkout to run the CLI from, under a path with a space. */
function sandbox(): { cwd: string; home: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "scoreboard test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  const home = join(root, "forge home");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return { cwd, home, path: join(home, "ledger.db") };
}

function seed(
  path: string,
  workspace: string,
  events: readonly FixtureEvent[],
): void {
  for (const event of events) {
    // justification: the fixture keeps each kind with its payload; only the workspace is added.
    const stored = appendEvent({ ...event, workspace } as LedgerEventInput, {
      path,
    });
    if (!stored.ok || !("id" in stored))
      throw new Error(`fixture event not stored: ${event.kind}`);
  }
}

/** The fixture ledger: its own checkout's events, and one from another checkout. */
function fixtureLedger(workspace = FIXTURE_WORKSPACE): string {
  const { path } = sandbox();
  seed(path, workspace, SCOREBOARD_EVENTS);
  seed(path, ELSEWHERE_WORKSPACE, ELSEWHERE_EVENTS);
  return path;
}

const NO_FINDINGS = { blocker: 0, high: 0, medium: 0, low: 0 };

const NO_COUNCIL: ScoreboardRow["council"] = {
  started: 0,
  finished: 0,
  pass: 0,
  fail: 0,
  unreadable: 0,
  cancelled: 0,
  costUsd: null,
  runsWithCost: 0,
  findings: null,
};

const NO_USAGE: ScoreboardRow["usage"] = {
  sessions: 0,
  costUsd: null,
  sessionsWithCost: 0,
  tokens: {},
};

const JOURNEYMAN_ROW: ScoreboardRow = {
  executor: {
    provider: "claude",
    model: "claude-sonnet-4-5",
    smith: "claude-journeyman",
  },
  runs: 2,
  sessions: {
    started: 2,
    ended: 2,
    completed: 1,
    failed: 1,
    timedOut: 0,
    stopped: 0,
    other: 0,
  },
  gates: { ran: 3, passed: 2, failed: 1, passRate: 2 / 3 },
  verdicts: { pass: 1, fail: 1, unreadable: 0 },
  reviews: {
    rounds: 2,
    pass: 1,
    fail: 1,
    unreadable: 0,
    findings: { blocker: 1, high: 1, medium: 1, low: 2 },
  },
  council: {
    ...NO_COUNCIL,
    started: 1,
    finished: 1,
    pass: 1,
    costUsd: 0.1,
    runsWithCost: 1,
  },
  usage: {
    sessions: 2,
    costUsd: 0.75,
    sessionsWithCost: 2,
    tokens: { inputTokens: 1010, outputTokens: 200, cacheReadInputTokens: 50 },
  },
};

const CODEX_ROW: ScoreboardRow = {
  executor: {
    provider: "codex",
    model: "gpt-5-codex",
    smith: "codex-journeyman",
  },
  runs: 1,
  sessions: {
    started: 2,
    ended: 2,
    completed: 0,
    failed: 0,
    timedOut: 1,
    stopped: 1,
    other: 0,
  },
  gates: { ran: 1, passed: 0, failed: 1, passRate: 0 },
  verdicts: { pass: 0, fail: 0, unreadable: 1 },
  reviews: {
    rounds: 0,
    pass: 0,
    fail: 0,
    unreadable: 0,
    findings: NO_FINDINGS,
  },
  council: NO_COUNCIL,
  usage: {
    sessions: 1,
    costUsd: null,
    sessionsWithCost: 0,
    tokens: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 },
  },
};

const LEAD_ROW: ScoreboardRow = {
  executor: { provider: "claude", model: "claude-opus-4-1" },
  // From its `run.phase.entered`.
  runs: 1,
  sessions: {
    started: 1,
    ended: 1,
    completed: 0,
    failed: 0,
    timedOut: 0,
    stopped: 0,
    other: 1,
  },
  gates: { ran: 0, passed: 0, failed: 0, passRate: null },
  verdicts: { pass: 0, fail: 0, unreadable: 0 },
  reviews: {
    rounds: 0,
    pass: 0,
    fail: 0,
    unreadable: 0,
    findings: NO_FINDINGS,
  },
  council: NO_COUNCIL,
  usage: NO_USAGE,
};

const NOBODY_ROW: ScoreboardRow = {
  executor: null,
  runs: 0,
  sessions: {
    started: 0,
    ended: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    stopped: 0,
    other: 0,
  },
  gates: { ran: 1, passed: 1, failed: 0, passRate: 1 },
  verdicts: { pass: 0, fail: 0, unreadable: 0 },
  reviews: {
    rounds: 0,
    pass: 0,
    fail: 0,
    unreadable: 0,
    findings: NO_FINDINGS,
  },
  council: { ...NO_COUNCIL, started: 1, finished: 1, cancelled: 1 },
  usage: NO_USAGE,
};

describe("readScoreboard over a fixture ledger with two smiths", () => {
  test("one row per executor: each smith's sessions, gates, verdicts, reviews, council runs and usage, then the interactive session, then the events with no executor", () => {
    const path = fixtureLedger();
    const board = readScoreboard({ workspace: FIXTURE_WORKSPACE }, { path });
    expect(board).toEqual({
      rows: [JOURNEYMAN_ROW, CODEX_ROW, LEAD_ROW, NOBODY_ROW],
      // Every fixture event of this checkout but the tool call.
      events: SCOREBOARD_EVENTS.length - 1,
      from: "2026-10-01T10:00:00.000Z",
      to: "2026-10-10T12:45:00.000Z",
    });
  });

  test("what no event recorded is null, never 0: a pass rate with no gate, a cost no session or council run reported, and council findings", () => {
    const path = fixtureLedger();
    const [journeyman, codex, lead, nobody] = readScoreboard(
      { workspace: FIXTURE_WORKSPACE },
      { path },
    ).rows;
    expect(lead?.gates.passRate).toBeNull();
    expect(codex?.usage.costUsd).toBeNull();
    expect(codex?.council.costUsd).toBeNull();
    expect(nobody?.council.costUsd).toBeNull();
    for (const row of [journeyman, codex, lead, nobody])
      expect(row?.council.findings).toBeNull();
    // A count is only as wide as what was reported: codex reported no cache reads.
    expect(Object.keys(codex?.usage.tokens ?? {}).sort()).toEqual([
      "cachedInputTokens",
      "inputTokens",
      "outputTokens",
    ]);
  });

  test("the scope is one workspace when given, and every workspace when not", () => {
    const path = fixtureLedger();
    const everywhere = readScoreboard({}, { path });
    expect(everywhere.events).toBe(SCOREBOARD_EVENTS.length);
    const journeyman = everywhere.rows[0];
    expect(journeyman?.gates).toEqual({
      ran: 4,
      passed: 2,
      failed: 2,
      passRate: 0.5,
    });
    expect(journeyman?.runs).toBe(3);

    expect(
      readScoreboard({ workspace: "c:/work/nothing-here" }, { path }),
    ).toEqual({ rows: [], events: 0, from: null, to: null });
  });

  test("since keeps the events at or after the instant", () => {
    const path = fixtureLedger();
    const board = readScoreboard(
      { workspace: FIXTURE_WORKSPACE, since: "2026-10-10T09:00:00Z" },
      { path },
    );
    expect(board.from).toBe("2026-10-10T09:00:00.000Z");
    const journeyman = board.rows[0];
    expect(journeyman?.runs).toBe(1);
    expect(journeyman?.sessions).toEqual({
      started: 1,
      ended: 1,
      completed: 0,
      failed: 1,
      timedOut: 0,
      stopped: 0,
      other: 0,
    });
    expect(journeyman?.usage).toEqual({
      sessions: 1,
      costUsd: 0.25,
      sessionsWithCost: 1,
      tokens: { inputTokens: 10, outputTokens: 0 },
    });
    // The interactive session started before the instant; only its end is in.
    expect(board.rows[2]?.sessions.started).toBe(0);
    expect(board.rows[2]?.sessions.other).toBe(1);
  });

  test("a ledger with no events answers an empty scoreboard", () => {
    const { path } = sandbox();
    expect(readScoreboard({}, { path })).toEqual({
      rows: [],
      events: 0,
      from: null,
      to: null,
    });
  });
});

describe("forge:audit --scoreboard", () => {
  function context(): {
    cwd: string;
    env: Record<string, string>;
    path: string;
    workspace: string;
  } {
    const box = sandbox();
    const workspace = resolveCheckout(box.cwd).workspace;
    seed(box.path, workspace, SCOREBOARD_EVENTS);
    seed(box.path, ELSEWHERE_WORKSPACE, ELSEWHERE_EVENTS);
    return {
      cwd: box.cwd,
      env: { AGENT_FORGE_HOME: box.home },
      path: box.path,
      workspace,
    };
  }

  test("--json answers the scoreboard of the checkout it runs from in the envelope", () => {
    const ctx = context();
    const outcome = runAudit(["--scoreboard", "--json"], ctx);
    expect(outcome.code).toBe(0);
    const envelope = JSON.parse(outcome.stdout) as {
      ok: boolean;
      data: Scoreboard;
    };
    expect(validateOperatorEnvelope(envelope).ok).toBe(true);
    expect(envelope.data.rows).toEqual([
      JOURNEYMAN_ROW,
      CODEX_ROW,
      LEAD_ROW,
      NOBODY_ROW,
    ]);
    expect(envelope.data).toEqual(
      readScoreboard({ workspace: ctx.workspace }, { path: ctx.path }),
    );
  });

  test("--since and --all-workspaces narrow and widen it as they do a query", () => {
    const ctx = context();
    const since = runAudit(
      ["--scoreboard", "--since", "2026-10-10T09:00:00Z", "--json"],
      ctx,
    );
    expect((JSON.parse(since.stdout) as { data: Scoreboard }).data).toEqual(
      readScoreboard(
        { workspace: ctx.workspace, since: "2026-10-10T09:00:00Z" },
        { path: ctx.path },
      ),
    );
    const everywhere = runAudit(
      ["--scoreboard", "--all-workspaces", "--json"],
      ctx,
    );
    expect(
      (JSON.parse(everywhere.stdout) as { data: Scoreboard }).data,
    ).toEqual(readScoreboard({}, { path: ctx.path }));
  });

  test("run from a checkout the ledger refuses, it answers an empty scoreboard and says why on stderr, as a query does", () => {
    const box = sandbox();
    // An ordinary name the secret scanner flags, put together so the file does not carry it.
    const flagged = ["ask", "the", "docs", "chatbot", "service"].join("-");
    const cwd = join(box.cwd, "..", flagged);
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const env = { AGENT_FORGE_HOME: box.home };
    const outcome = runAudit(["--scoreboard", "--json"], { cwd, env });
    expect(outcome.code).toBe(0);
    expect((JSON.parse(outcome.stdout) as { data: Scoreboard }).data).toEqual({
      rows: [],
      events: 0,
      from: null,
      to: null,
    });
    expect(outcome.stderr).toContain(
      "the checkout of the current directory looks like a secret to the ledger's scanner",
    );
    expect(
      runAudit(["--scoreboard", "--all-workspaces", "--json"], { cwd, env })
        .stderr,
    ).toBeUndefined();
  });

  test("it takes no flag but --since, --all-workspaces and --json", () => {
    for (const other of [
      ["--bead", "b-1"],
      ["--run", "run-a"],
      ["--session", "s-1"],
      ["--kind", "gate.ran"],
      ["--limit", "5"],
      ["--after-id", "1"],
      ["--backup"],
      ["--compact"],
    ]) {
      const parsed = parseAuditArgs(["--scoreboard", ...other]);
      expect({ other, ok: parsed.ok }).toEqual({ other, ok: false });
      if (!parsed.ok) expect(parsed.error).toContain("--scoreboard");
    }
    expect(
      parseAuditArgs([
        "--scoreboard",
        "--since",
        "2026-10-01T00:00:00Z",
        "--all-workspaces",
        "--json",
      ]),
    ).toEqual({
      ok: true,
      value: {
        command: "scoreboard",
        json: true,
        allWorkspaces: true,
        filter: { since: "2026-10-01T00:00:00Z" },
      },
    });
  });

  test("the text view names each executor and says unknown where the ledger recorded nothing", () => {
    const ctx = context();
    const outcome = runAudit(["--scoreboard"], ctx);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe(
      formatScoreboard(
        readScoreboard({ workspace: ctx.workspace }, { path: ctx.path }),
      ),
    );
    const [summary, ...blocks] = outcome.stdout.split("\n\n");
    expect(summary).toBe(
      `${SCOREBOARD_EVENTS.length - 1} events read, from 2026-10-01T10:00:00.000Z to 2026-10-10T12:45:00.000Z`,
    );
    expect(blocks).toHaveLength(4);
    expect(blocks[0]?.split("\n")[0]).toBe(
      "claude-journeyman (claude claude-sonnet-4-5)",
    );
    expect(blocks[0]).toContain(
      "gates 3 ran: 2 passed, 1 failed, pass rate 66.7%",
    );
    expect(blocks[0]).toContain("council cost $0.1000 (1 of 1 finished)");
    expect(blocks[1]?.split("\n")[0]).toBe(
      "codex-journeyman (codex gpt-5-codex)",
    );
    expect(blocks[0]).toContain("usage cost $0.7500 (2 of 2 ended sessions)");
    expect(blocks[1]).toContain(
      "usage cost unknown (0 of 2 ended sessions reported one)",
    );
    expect(blocks[1]).toContain("council cost unknown");
    expect(blocks[2]?.split("\n")[0]).toBe("no smith (claude claude-opus-4-1)");
    expect(blocks[2]).toContain("pass rate unknown (no gate ran)");
    expect(blocks[3]?.split("\n")[0]).toBe("no executor recorded");
    for (const block of blocks)
      expect(block).toContain("council findings by severity: not recorded");
    expect(
      formatScoreboard({ rows: [], events: 0, from: null, to: null }),
    ).toBe("no events");
  });
});
