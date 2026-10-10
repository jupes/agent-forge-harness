/**
 * The quality gate, two ways.
 *
 * In process: `runQualityGate` with a constructed stdin result and recording
 * command runners, so every command line and every `bd` argument list the gate
 * produces can be inspected. The correlation and verdict files are real files
 * in a scratch checkout; the verdict is read by the real reader, wrapped so a
 * test can count its reads and change the file behind it.
 *
 * As a subprocess: the real `.claude/hooks/quality-gate.ts` with JSON piped on
 * stdin, in a scratch directory that is not a repository and has no
 * package.json, with a PATH that reaches no real `bun` or `git`: empty; or
 * system directories only (so a shell is reachable); or, for two tests, a
 * directory of stand-ins in front of those. It therefore never runs this
 * suite again. With no stand-ins its own checks fail fast, and what is
 * asserted is the event, the identity it logs and the ledger rows; with a
 * stand-in `bun` and `git` every base check passes without running
 * anything, and the exit code is asserted too.
 *
 * Neither proves a live host session calls the hook.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  type GateDeps,
  type GateOutcome,
  type GateResult,
  runQualityGate,
  unrecordedVerdict,
} from "../.claude/hooks/quality-gate";
import type { HookStdin } from "../.claude/hooks/utils/hook-input";
import type { Executor } from "../types/hearth";
import { BUILTIN_SMITHS } from "./config/defaults";
import {
  EVALUATIONS_DIR,
  evaluatorVerdictPath,
  readVerdictOnce,
} from "./eval-verdict-store";
import { closeLedger } from "./ledger/db";
import { queryEvents } from "./ledger/query";
import { RUN_CORRELATION_ENV } from "./run-correlation";
import { initRunCorrelation } from "./run-correlation-store";

const GATE = join(import.meta.dir, "..", ".claude", "hooks", "quality-gate.ts");

const temporary: string[] = [];

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A ledger file a child still holds on Windows: the OS temp directory reclaims it.
    }
  }
});

interface Box {
  root: string;
  /** A scratch checkout: a directory with `.git`. */
  cwd: string;
  home: string;
  userHome: string;
  emptyPath: string;
  ledger: string;
}

function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "quality gate test "));
  temporary.push(root);
  const box = {
    root,
    cwd: join(root, "check out"),
    home: join(root, "forge home"),
    userHome: join(root, "user home"),
    emptyPath: join(root, "empty path"),
    ledger: join(root, "forge home", "ledger.db"),
  };
  mkdirSync(join(box.cwd, ".git"), { recursive: true });
  mkdirSync(box.userHome, { recursive: true });
  mkdirSync(box.emptyPath, { recursive: true });
  return box;
}

/** The run's correlation, written the way a launcher writes it. */
function correlate(box: Box, bead = "bead-1", run = "run-1"): string {
  const made = initRunCorrelation({
    checkout: box.cwd,
    beadsIssueId: bead,
    executionRunId: run,
  });
  if (!made.ok) throw new Error(made.error);
  return made.path;
}

/** A schema 2 verdict for bead-1 / run-1 by a human reviewer, unless `body` says otherwise. */
function v2(body: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    beadsIssueId: "bead-1",
    executionRunId: "run-1",
    verdict: "PASS",
    findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    evaluator: { kind: "human", actorKind: "reviewer" },
    ...body,
  };
}

/** A model evaluator that asked for a master and, unless told otherwise, observed one. */
function modelEvaluator(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "model",
    requestedProvider: "claude",
    requestedModel: "claude-opus-5-5",
    requestedRank: "master",
    observedProvider: "claude",
    observedModel: "claude-opus-5-5",
    providerEvidence: "selected-direct-transport",
    modelEvidence: "response-field",
    rankPolicyDecision: "allowed",
    rankPolicyRule: "evaluator-at-or-above-builder",
    ...overrides,
  };
}

/**
 * Put `content` at the declared verdict path of run `runId`: plain bytes, so
 * a test can plant what no writer would. Returns the bytes.
 */
function verdict(
  box: Box,
  runId: string,
  content: Record<string, unknown> = v2(),
): string {
  const file = join(box.cwd, evaluatorVerdictPath(runId) ?? "");
  mkdirSync(dirname(file), { recursive: true });
  const bytes = JSON.stringify(content);
  writeFileSync(file, bytes);
  return bytes;
}

/** Where the strict check looked before verdicts were bound to runs. */
function taskScopedVerdict(
  box: Box,
  bead: string,
  content: Record<string, unknown>,
): void {
  const file = join(box.cwd, ".tmp", "work", `${bead}-verdict.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(content));
}

const sha256 = (data: string) =>
  createHash("sha256").update(data).digest("hex");

const payload = (input: Record<string, unknown>): HookStdin => ({
  kind: "payload",
  input,
});
const BY_HAND: HookStdin = { kind: "none", reason: "terminal" };

const GIT_LOG = "git log --oneline --name-only -5";

interface Recorded {
  outcome: GateOutcome;
  /** Every command line handed to a shell. */
  commands: string[];
  /** Every program run with an argument array. */
  execs: Array<{ file: string; args: string[] }>;
  /** Every run id whose verdict file the gate read. */
  reads: string[];
}

/** Run the gate in process: every base check passes unless `answers` says otherwise. */
function gate(
  box: Box,
  input: {
    stdin?: HookStdin;
    argv?: string[];
    env?: Record<string, string>;
    answers?: Record<string, { ok: boolean; output: string }>;
    bd?: Record<string, { ok: boolean; output: string }>;
    /** Who the run's state says built the work. */
    builder?: Executor;
    /** Runs right after the gate has read a verdict file, before it uses it. */
    afterRead?: () => void;
  } = {},
): Recorded {
  const commands: string[] = [];
  const execs: Array<{ file: string; args: string[] }> = [];
  const reads: string[] = [];
  const answers: Record<string, { ok: boolean; output: string }> = {
    [GIT_LOG]: { ok: true, output: "abc1234 a change\nscripts/a.test.ts" },
    "git rev-parse --show-toplevel": { ok: false, output: "" },
    "git rev-parse --abbrev-ref HEAD": { ok: true, output: "feat/x" },
    ...input.answers,
  };
  const deps: GateDeps = {
    cwd: box.cwd,
    env: input.env ?? {},
    run: (cmd) => {
      commands.push(cmd);
      return answers[cmd] ?? { ok: true, output: "" };
    },
    execFile: (file, args) => {
      execs.push({ file, args: [...args] });
      return input.bd?.[args.join(" ")] ?? { ok: false, output: "" };
    },
    hasScript: () => true,
    hasTestFiles: () => true,
    smiths: () => Object.values(BUILTIN_SMITHS),
    readVerdict: (checkout, executionRunId) => {
      reads.push(executionRunId);
      const read = readVerdictOnce({ checkout, executionRunId });
      input.afterRead?.();
      return read;
    },
    runState: (runId) =>
      input.builder
        ? {
            slug: runId,
            feature: runId,
            phase: "implement",
            completed: ["research", "plan"],
            artifacts: {},
            updatedAt: "2026-06-04T00:00:00.000Z",
            executor: input.builder,
          }
        : null,
  };
  const outcome = runQualityGate({
    stdin: input.stdin ?? BY_HAND,
    argv: input.argv ?? [],
    deps,
  });
  return { outcome, commands, execs, reads };
}

function ran(recorded: Recorded): Extract<GateOutcome, { kind: "ran" }> {
  if (recorded.outcome.kind !== "ran") {
    throw new Error(`gate refused: ${recorded.outcome.error}`);
  }
  return recorded.outcome;
}

function check(recorded: Recorded, name: string) {
  return ran(recorded).result.checks.find((entry) => entry.name === name);
}

const BASE_COMMANDS = [
  "bun run typecheck",
  "bun run lint",
  "bun run test",
  "git status --porcelain",
];

describe("an unbound host event", () => {
  test("TaskCompleted on stdin with no correlation runs the base gates and is logged unlinked", () => {
    const box = sandbox();
    const recorded = gate(box, {
      stdin: payload({
        hook_event_name: "TaskCompleted",
        session_id: "host-session",
        task_id: "7",
        team_name: "night-shift",
      }),
    });
    const { result } = ran(recorded);

    expect(result).toMatchObject({
      schemaVersion: 2,
      event: "TaskCompleted",
      eventSource: "stdin",
      stdin: "payload",
      beadsIssueId: null,
      executionRunId: null,
      host: {
        hostTaskScope: { kind: "agent-team", id: "night-shift" },
        hostTaskId: "7",
        completerHostSessionId: "host-session",
      },
      passed: true,
    });
    expect(result.unlinkedReason).toContain("no run correlation");
    expect("taskId" in result).toBe(false);
    expect("forgeSlug" in result).toBe(false);
    for (const command of BASE_COMMANDS) {
      expect(recorded.commands).toContain(command);
    }
    // Nothing about the issue is asked of Beads: there is no Beads id to ask with.
    expect(recorded.execs).toEqual([]);
    for (const name of ["ac-verify", "close-testing-attestation"]) {
      expect(check(recorded, name)).toMatchObject({
        skipped: true,
        skipReason: "no run correlation",
      });
    }
  });

  test("cannot satisfy strict completion, even with a passing verdict filed under the host's task id", () => {
    const box = sandbox();
    taskScopedVerdict(box, "host-task", v2({ beadsIssueId: "host-task" }));
    verdict(box, "host-task", v2({ beadsIssueId: "host-task" }));
    const recorded = gate(box, {
      stdin: payload({
        hook_event_name: "TaskCompleted",
        task_id: "host-task",
      }),
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });
    const { result } = ran(recorded);

    expect(result.passed).toBe(false);
    expect(result.blockingFailures).toEqual(["eval-verdict"]);
    expect(check(recorded, "eval-verdict")).toMatchObject({ passed: false });
    expect(check(recorded, "eval-verdict")?.output).toContain(
      "requires a run correlation",
    );
    expect(ran(recorded).boundVerdict).toBeNull();
  });

  test("the variables that used to carry identity carry none", () => {
    const box = sandbox();
    verdict(box, "bead-1", {});
    const recorded = gate(box, {
      env: {
        CLAUDE_TASK_ID: "bead-1",
        CLAUDE_HOOK_EVENT: "TeammateIdle",
        AGENT_FORGE_BEAD_ID: "bead-1",
        FORGE_SLUG: "run-1",
        AGENT_FORGE_EVAL_VERDICT: "strict",
      },
    });
    const { result } = ran(recorded);

    expect(result.event).toBe("TaskCompleted");
    expect(result.eventSource).toBe("default");
    expect(result.beadsIssueId).toBeNull();
    expect(result.executionRunId).toBeNull();
    expect("forgeSlug" in result).toBe(false);
    expect(recorded.execs).toEqual([]);
    expect(result.blockingFailures).toEqual(["eval-verdict"]);
  });

  test("an environment pointer that does not validate leaves the run unlinked, says why, and does not block", () => {
    const box = sandbox();
    const outside = join(box.root, "elsewhere", "run-1.json");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, readFileSync(correlate(box)));
    const recorded = gate(box, { env: { [RUN_CORRELATION_ENV]: outside } });
    const { result } = ran(recorded);

    expect(result.beadsIssueId).toBeNull();
    expect(result.unlinkedReason).toBe(
      "run correlation refused: the file is outside this checkout",
    );
    expect(ran(recorded).notice).toBe(
      "run correlation refused: the file is outside this checkout",
    );
    expect(result.passed).toBe(true);
    expect(recorded.execs).toEqual([]);
  });

  test("a --correlation flag that does not validate is refused before any check runs", () => {
    const box = sandbox();
    const outside = join(box.root, "elsewhere", "run-1.json");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, readFileSync(correlate(box)));
    for (const argv of [["--correlation", outside], ["--correlation"]]) {
      const recorded = gate(box, { argv });
      expect(recorded.outcome.kind).toBe("refused");
      for (const command of BASE_COMMANDS) {
        expect(recorded.commands).not.toContain(command);
      }
      expect(recorded.execs).toEqual([]);
    }
    expect(gate(box, { argv: ["--correlation", outside] }).outcome).toEqual({
      kind: "refused",
      error: "run correlation refused: the file is outside this checkout",
    });
  });
});

describe("a correlated run", () => {
  test("takes its bead and run from the file the --correlation flag points at", () => {
    const box = sandbox();
    const recorded = gate(box, {
      argv: ["--correlation", correlate(box)],
      bd: {
        "show bead-1 --json": {
          ok: true,
          output: JSON.stringify([{ issue_type: "task" }]),
        },
        "show bead-1": { ok: true, output: "ac: it works" },
      },
    });
    const { result, correlation } = ran(recorded);

    expect<unknown>(result).toMatchObject({
      schemaVersion: 2,
      beadsIssueId: "bead-1",
      executionRunId: "run-1",
      passed: true,
    });
    expect("unlinkedReason" in result).toBe(false);
    expect(String(correlation?.beadsIssueId)).toBe("bead-1");
    expect(recorded.execs).toEqual([
      { file: "bd", args: ["show", "bead-1", "--json"] },
      { file: "bd", args: ["show", "bead-1"] },
      { file: "bd", args: ["comments", "bead-1", "--json"] },
    ]);
    expect(check(recorded, "ac-verify")).toMatchObject({
      passed: true,
      output: "AC found — verify before closing task",
    });
  });

  test("takes them from the environment pointer too, and the flag wins over it", () => {
    const box = sandbox();
    const first = correlate(box, "bead-1", "run-1");
    const second = correlate(box, "bead-2", "run-2");

    const viaEnv = ran(gate(box, { env: { [RUN_CORRELATION_ENV]: first } }));
    expect<unknown>(viaEnv.result.beadsIssueId).toBe("bead-1");

    const both = ran(
      gate(box, {
        argv: [`--correlation=${second}`],
        env: { [RUN_CORRELATION_ENV]: first },
      }),
    );
    expect<unknown>(both.result.beadsIssueId).toBe("bead-2");
    expect(both.result.executionRunId).toBe("run-2");
  });

  test("when bd cannot show the correlated issue, both issue checks say so", () => {
    const box = sandbox();
    const recorded = gate(box, { argv: ["--correlation", correlate(box)] });
    for (const name of ["ac-verify", "close-testing-attestation"]) {
      expect(check(recorded, name)).toMatchObject({
        passed: true,
        skipped: true,
        skipReason: "bd could not show the correlated issue",
      });
    }
    expect(ran(recorded).result.passed).toBe(true);
  });

  test("a feature with no testing attestation still blocks, read through the correlated bead", () => {
    const box = sandbox();
    const recorded = gate(box, {
      argv: ["--correlation", correlate(box)],
      bd: {
        "show bead-1 --json": {
          ok: true,
          output: JSON.stringify([{ issue_type: "feature" }]),
        },
        "comments bead-1 --json": { ok: true, output: "[]" },
      },
    });
    expect(ran(recorded).result.blockingFailures).toEqual([
      "close-testing-attestation",
    ]);
  });

  test("strict mode binds a schema 2 verdict that names the correlated bead and run", () => {
    const box = sandbox();
    verdict(box, "run-1", v2({ summary: "looks right" }));
    const passing = gate(box, {
      argv: ["--correlation", correlate(box)],
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });
    expect(check(passing, "eval-verdict")).toEqual({
      name: "eval-verdict",
      passed: true,
      output: "PASS B=0 H=0; evaluator: human reviewer",
    });
    expect<unknown>(ran(passing).boundVerdict).toMatchObject({
      schemaVersion: 2,
      beadsIssueId: "bead-1",
      executionRunId: "run-1",
      verdict: "PASS",
      evaluator: { kind: "human", actorKind: "reviewer" },
    });
  });
});

/** The strict check of a correlated run (bead-1 / run-1) over one verdict file. */
function strict(
  content: Record<string, unknown>,
  builder?: Executor,
): Recorded {
  const box = sandbox();
  verdict(box, "run-1", content);
  return gate(box, {
    argv: ["--correlation", correlate(box)],
    env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    ...(builder ? { builder } : {}),
  });
}

/** The strict check of one correlated run of bead-1 in `box`. */
function strictRun(
  box: Box,
  run: string,
  extra: { afterRead?: () => void } = {},
): Recorded {
  return gate(box, {
    argv: ["--correlation", correlate(box, "bead-1", run)],
    env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    ...extra,
  });
}

function refusedWith(recorded: Recorded, output: string): void {
  expect(check(recorded, "eval-verdict")).toEqual({
    name: "eval-verdict",
    passed: false,
    output,
  });
  expect(ran(recorded).result.blockingFailures).toEqual(["eval-verdict"]);
  expect(ran(recorded).boundVerdict).toBeNull();
}

const SONNET_BUILDER: Executor = {
  provider: "claude",
  model: "claude-sonnet-5-5",
};

describe("strict completion: whose verdict it is", () => {
  test("a schema 1 file under the right bead is a legacy verdict and does not satisfy it", () => {
    refusedWith(
      strict({
        schemaVersion: 1,
        taskId: "bead-1",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      }),
      "the verdict is schema 1 (legacy): it names no run and no evaluator",
    );
  });

  test("a stale verdict, left by an earlier run of the same bead, is refused", () => {
    refusedWith(
      strict(v2({ executionRunId: "run-0" })),
      'verdict executionRunId "run-0" is not this run ("run-1")',
    );
  });

  test("a verdict for another bead is refused", () => {
    refusedWith(
      strict(v2({ beadsIssueId: "bead-9" })),
      'verdict beadsIssueId "bead-9" is not this run\'s bead ("bead-1")',
    );
  });

  test("a FAIL with a blocker is this run's verdict, and blocks", () => {
    const recorded = strict(
      v2({
        verdict: "FAIL",
        findings: { blocker: 1, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(check(recorded, "eval-verdict")).toMatchObject({
      passed: false,
      output:
        'verdict FAIL with blocker/high — {"blocker":1,"high":0,"medium":0,"low":0}',
    });
    expect(ran(recorded).boundVerdict).toMatchObject({ verdict: "FAIL" });
  });
});

describe("strict completion: where the verdict is read", () => {
  test("only the path the correlation's run id declares is read: a passing verdict filed under the bead is not seen", () => {
    const box = sandbox();
    taskScopedVerdict(box, "bead-1", v2());
    const recorded = strictRun(box, "run-1");
    refusedWith(
      recorded,
      `no evaluator verdict at ${evaluatorVerdictPath("run-1")}`,
    );
    expect(recorded.reads).toEqual(["run-1"]);
  });

  test("two runs of one bead, concurrent or retried: each gate binds its own run's verdict and never the other's", () => {
    const box = sandbox();
    const first = verdict(box, "run-a", v2({ executionRunId: "run-a" }));

    // The second run has no verdict yet: the first run's is not it.
    refusedWith(
      strictRun(box, "run-b"),
      `no evaluator verdict at ${evaluatorVerdictPath("run-b")}`,
    );
    const a = strictRun(box, "run-a");
    expect(check(a, "eval-verdict")).toMatchObject({ passed: true });

    // The retry fails its own evaluation; the first run still passes on its own.
    const second = verdict(
      box,
      "run-b",
      v2({
        executionRunId: "run-b",
        verdict: "FAIL",
        findings: { blocker: 0, high: 2, medium: 0, low: 0 },
      }),
    );
    const b = strictRun(box, "run-b");
    expect(check(b, "eval-verdict")).toMatchObject({ passed: false });
    expect(check(strictRun(box, "run-a"), "eval-verdict")).toMatchObject({
      passed: true,
    });

    expect(ran(a).result.evaluatorArtifact).toMatchObject({
      path: evaluatorVerdictPath("run-a"),
      sha256: sha256(first),
      executionRunId: "run-a",
      beadsIssueId: "bead-1",
    });
    expect(ran(b).result.evaluatorArtifact).toMatchObject({
      path: evaluatorVerdictPath("run-b"),
      sha256: sha256(second),
      executionRunId: "run-b",
      beadsIssueId: "bead-1",
    });
  });

  test("a stale verdict copied to this run's path is refused by what its bytes say", () => {
    const box = sandbox();
    const earlier = v2({ executionRunId: "run-a" });
    verdict(box, "run-a", earlier);
    verdict(box, "run-b", earlier);
    refusedWith(
      strictRun(box, "run-b"),
      'verdict executionRunId "run-a" is not this run ("run-b")',
    );
  });

  test("a verdict behind a link is refused, even a valid one for this very run", () => {
    const box = sandbox();
    const outside = join(box.root, "outside");
    const planted = join(outside, sha256("run-1"), "verdict.json");
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, JSON.stringify(v2()));
    mkdirSync(join(box.cwd, ".tmp", "work"), { recursive: true });
    symlinkSync(outside, join(box.cwd, EVALUATIONS_DIR), "junction");
    refusedWith(
      strictRun(box, "run-1"),
      `${evaluatorVerdictPath("run-1")} is, or sits under, a link: a verdict is only read from the checkout's own directory`,
    );
  });
});

describe("strict completion: what the gate entry records", () => {
  test("the path, SHA-256, byte count, both ids and the evaluator of the bytes it read, in the one entry", () => {
    const box = sandbox();
    const bytes = verdict(
      box,
      "run-1",
      v2({ evaluator: modelEvaluator({ sessionId: "session-9" }) }),
    );
    const recorded = strictRun(box, "run-1");
    expect<unknown>(ran(recorded).result.evaluatorArtifact).toEqual({
      kind: "evaluator-verdict",
      path: evaluatorVerdictPath("run-1"),
      sha256: sha256(bytes),
      bytes: Buffer.byteLength(bytes),
      verdictSchemaVersion: 2,
      executionRunId: "run-1",
      beadsIssueId: "bead-1",
      evaluator: modelEvaluator({ sessionId: "session-9" }),
    });
    // The entry's own ids are the same two.
    expect<unknown>(ran(recorded).result).toMatchObject({
      beadsIssueId: "bead-1",
      executionRunId: "run-1",
    });
  });

  test("a blocking verdict is recorded too; a verdict that is not this run's leaves no artifact", () => {
    const blocking = strict(
      v2({
        verdict: "FAIL",
        findings: { blocker: 1, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(ran(blocking).result.evaluatorArtifact).toMatchObject({
      kind: "evaluator-verdict",
    });
    for (const content of [
      v2({ executionRunId: "run-0" }),
      v2({ evaluator: modelEvaluator({ observedModel: "claude-next" }) }),
      {
        schemaVersion: 1,
        taskId: "bead-1",
        verdict: "PASS",
        findings: v2().findings,
      },
    ]) {
      expect("evaluatorArtifact" in ran(strict(content)).result).toBe(false);
    }
  });

  test("the file is read once, and overwriting it after the read changes nothing the gate records", () => {
    const box = sandbox();
    const original = verdict(box, "run-1", v2({ summary: "as validated" }));
    const recorded = strictRun(box, "run-1", {
      // Swap the file the moment the gate has read it: a blocking verdict by
      // another evaluator, larger than the original.
      afterRead: () =>
        verdict(
          box,
          "run-1",
          v2({
            verdict: "FAIL",
            findings: { blocker: 3, high: 0, medium: 0, low: 0 },
            evaluator: { kind: "human", actorKind: "operator" },
            summary: "swapped in after the read",
          }),
        ),
    });

    expect(recorded.reads).toEqual(["run-1"]);
    expect(check(recorded, "eval-verdict")).toMatchObject({ passed: true });
    expect(ran(recorded).result.evaluatorArtifact).toMatchObject({
      sha256: sha256(original),
      bytes: Buffer.byteLength(original),
      evaluator: { kind: "human", actorKind: "reviewer" },
    });
    expect(ran(recorded).boundVerdict).toMatchObject({
      verdict: "PASS",
      summary: "as validated",
    });
  });

  test("without strict mode, and for an uncorrelated run, no verdict file is read", () => {
    const box = sandbox();
    verdict(box, "run-1", v2());
    expect(
      gate(box, { argv: ["--correlation", correlate(box)] }).reads,
    ).toEqual([]);
    expect(
      gate(box, { env: { AGENT_FORGE_EVAL_VERDICT: "strict" } }).reads,
    ).toEqual([]);
  });
});

describe("strict completion: the evidence has to be on record", () => {
  /** A passing result as the gate builds it, bound to a verdict or not. */
  function passing(bound: boolean): GateResult {
    const box = sandbox();
    verdict(box, "run-1", v2());
    return ran(
      gate(box, {
        argv: ["--correlation", correlate(box)],
        env: bound ? { AGENT_FORGE_EVAL_VERDICT: "strict" } : {},
      }),
    ).result;
  }

  test("a run that bound a verdict and could not write its log entry is a failed run, in the result itself", () => {
    const result = passing(true);
    expect(result.passed).toBe(true);
    const unrecorded = unrecordedVerdict(result, { logged: false });
    expect(unrecorded.passed).toBe(false);
    expect(unrecorded.blockingFailures).toEqual(["gate-log"]);
    expect(unrecorded.checks.at(-1)).toEqual({
      name: "gate-log",
      passed: false,
      output:
        "the gate log could not be written, so the bound verdict's evidence is not on record: strict completion is blocked",
    });
    // Logged, it is as it was.
    expect(unrecordedVerdict(result, { logged: true })).toBe(result);
  });

  test("a run that bound no verdict is not held to its log, as before", () => {
    const result = passing(false);
    expect("evaluatorArtifact" in result).toBe(false);
    expect(unrecordedVerdict(result, { logged: false })).toBe(result);
  });
});

describe("strict completion: who judged", () => {
  test("a verdict with no evaluator identity is refused", () => {
    const { evaluator: _evaluator, ...anonymous } = v2();
    refusedWith(strict(anonymous), "evaluator must be an object");
    refusedWith(
      strict(v2({ evaluator: { kind: "human" } })),
      "evaluator actorKind must be operator or reviewer",
    );
  });

  test("a model evaluator observed at or above the builder's rank satisfies it", () => {
    const recorded = strict(
      v2({ evaluator: modelEvaluator() }),
      SONNET_BUILDER,
    );
    expect(check(recorded, "eval-verdict")).toEqual({
      name: "eval-verdict",
      passed: true,
      output:
        "PASS B=0 H=0; evaluator: model claude/claude-opus-5-5 (requested claude/claude-opus-5-5, rank master)",
    });
    expect(ran(recorded).boundVerdict).toMatchObject({
      evaluator: { kind: "model", observedModel: "claude-opus-5-5" },
    });
  });

  test("a model evaluator with nothing observed is refused: the request is not evidence", () => {
    const {
      observedProvider: _provider,
      observedModel: _model,
      providerEvidence: _providerEvidence,
      modelEvidence: _modelEvidence,
      ...requestedOnly
    } = modelEvaluator();
    refusedWith(
      strict(v2({ evaluator: requestedOnly }), SONNET_BUILDER),
      "the verdict records no observed evaluator provider and model (requested claude/claude-opus-5-5 is not evidence of what ran)",
    );
  });

  test("a weaker fallback is refused: a master was requested, an apprentice answered a journeyman's work", () => {
    refusedWith(
      strict(
        v2({
          evaluator: modelEvaluator({
            observedModel: "claude-haiku-4-5-20251001",
          }),
        }),
        SONNET_BUILDER,
      ),
      "observed evaluator claude/claude-haiku-4-5-20251001 (rank apprentice) is below the builder's rank (journeyman)",
    );
  });

  test("with no builder on the run's state, only a master evaluator satisfies it", () => {
    expect(
      check(strict(v2({ evaluator: modelEvaluator() })), "eval-verdict"),
    ).toMatchObject({ passed: true });
    refusedWith(
      strict(
        v2({
          evaluator: modelEvaluator({ observedModel: "claude-sonnet-5-5" }),
        }),
      ),
      "the run records no builder whose rank is known, so only a master evaluator satisfies grader >= subject; observed evaluator claude/claude-sonnet-5-5 is rank journeyman",
    );
  });
});

describe("hostile stdin", () => {
  const MARK = "PWNED";
  const hostile = (label: string): string =>
    `${label}-${MARK}"; echo ${MARK} > pwned.txt; $(echo ${MARK}) \`echo ${MARK}\` & echo ${MARK} | --json ../../x`;

  const everyField = (taskId: string): HookStdin =>
    payload({
      hook_event_name: "TaskCompleted",
      session_id: hostile("session"),
      transcript_path: hostile("transcript"),
      cwd: hostile("cwd"),
      task_id: taskId,
      task_subject: hostile("subject"),
      task_description: hostile("description"),
      team_name: hostile("team"),
      teammate_name: hostile("teammate"),
      [hostile("key")]: hostile("value"),
    });

  test("reaches no command line and no bd argument, linked or not", () => {
    const box = sandbox();
    const unlinked = gate(box, { stdin: everyField(hostile("task")) });
    const linked = gate(box, {
      stdin: everyField(hostile("task")),
      argv: ["--correlation", correlate(box)],
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });

    for (const recorded of [unlinked, linked]) {
      expect(recorded.commands.length).toBeGreaterThan(0);
      for (const command of recorded.commands) {
        expect(command).not.toContain(MARK);
      }
      for (const call of recorded.execs) {
        expect(call.file).toBe("bd");
        expect(call.args.join(" ")).not.toContain(MARK);
      }
    }
    expect(unlinked.execs).toEqual([]);
    expect(linked.execs.map((call) => call.args)).toEqual([
      ["show", "bead-1", "--json"],
      ["show", "bead-1"],
      ["comments", "bead-1", "--json"],
    ]);
  });

  test("appears in the result only inside the host object", () => {
    const box = sandbox();
    const { result } = ran(gate(box, { stdin: everyField(hostile("task")) }));
    const { host, ...rest } = result;
    expect(JSON.stringify(rest)).not.toContain(MARK);
    expect(JSON.stringify(host)).toContain(MARK);
    expect(Object.keys(host ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "completerHostSessionId",
      "completerTeammateName",
      "hostTaskId",
      "hostTaskScope",
    ]);
  });

  test("a host task id that is itself a plausible Beads id selects neither the bead nor the verdict", () => {
    const box = sandbox();
    // The host's id has a passing verdict on file; the correlated bead's fails.
    taskScopedVerdict(box, "other-bead", v2({ beadsIssueId: "other-bead" }));
    verdict(box, "other-bead", v2({ beadsIssueId: "other-bead" }));
    verdict(
      box,
      "run-1",
      v2({
        verdict: "FAIL",
        findings: { blocker: 1, high: 0, medium: 0, low: 0 },
      }),
    );
    const recorded = gate(box, {
      stdin: payload({
        hook_event_name: "TaskCompleted",
        task_id: "other-bead",
      }),
      argv: ["--correlation", correlate(box)],
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });

    expect(recorded.execs.flatMap((call) => call.args)).not.toContain(
      "other-bead",
    );
    expect(check(recorded, "eval-verdict")).toMatchObject({ passed: false });
    expect(check(recorded, "eval-verdict")?.output).toContain(
      "verdict FAIL with blocker/high",
    );
    expect<unknown>(ran(recorded).result.beadsIssueId).toBe("bead-1");
    expect(ran(recorded).result.host).toEqual({ hostTaskId: "other-bead" });
  });
});

describe("TeammateIdle", () => {
  test("is logged as TeammateIdle and runs the base gates only, strict mode or not", () => {
    const box = sandbox();
    const recorded = gate(box, {
      stdin: payload({
        hook_event_name: "TeammateIdle",
        team_name: "night-shift",
        teammate_name: "worker-2",
      }),
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });
    const { result } = ran(recorded);

    expect(result.event).toBe("TeammateIdle");
    expect(result.eventSource).toBe("stdin");
    expect(result.host).toEqual({
      hostTaskScope: { kind: "agent-team", id: "night-shift" },
      idleTeammateName: "worker-2",
    });
    expect(result.checks.map((entry) => entry.name)).toEqual([
      "typecheck",
      "lint",
      "tests",
      "clean-tree",
    ]);
    expect(recorded.commands).not.toContain(GIT_LOG);
    expect(result.passed).toBe(true);
    expect(ran(recorded).trigger).toBe("TeammateIdle");
  });

  test("a run by hand can still ask for it by name, and has no trigger", () => {
    const box = sandbox();
    const recorded = gate(box, { argv: ["TeammateIdle"] });
    expect(ran(recorded).result.event).toBe("TeammateIdle");
    expect(ran(recorded).result.eventSource).toBe("argv");
    expect(ran(recorded).trigger).toBeUndefined();
  });
});

describe("malformed stdin", () => {
  test("is refused before any check runs", () => {
    const box = sandbox();
    for (const stdin of [
      { kind: "malformed", error: "stdin is not valid JSON" } as const,
      payload({ hook_event_name: "Stop" }),
      payload({ task_id: "7" }),
      // A payload that disagrees with the command line about the event.
      payload({ hook_event_name: "TeammateIdle" }),
    ]) {
      const recorded = gate(box, { stdin, argv: ["TaskCompleted"] });
      expect(recorded.outcome.kind).toBe("refused");
      expect(recorded.commands).toEqual([]);
      expect(recorded.execs).toEqual([]);
    }
  });
});

// ── The real entrypoint, spawned ────────────────────────────────────────────

/** Nothing of the parent's is inherited except what a Windows child needs to start. */
function childEnv(
  box: Box,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_FORGE_HOME: box.home,
    HOME: box.userHome,
    USERPROFILE: box.userHome,
    PATH: box.emptyPath,
  };
  for (const name of ["SystemRoot", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

interface Spawned {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

async function spawnGate(
  box: Box,
  stdin: string | "never-closed",
  extraEnv: Record<string, string> = {},
  args: string[] = [],
): Promise<Spawned> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "run", GATE, ...args], {
    cwd: box.cwd,
    env: childEnv(box, extraEnv),
    stdin: stdin === "never-closed" ? "pipe" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  const pipe = child.stdin;
  if (typeof pipe === "object" && pipe !== null) {
    try {
      pipe.end();
    } catch {
      // The child is gone; so is its end of the pipe.
    }
  }
  return { exitCode, stdout, stderr, ms: performance.now() - started };
}

/** The lines the child appended to its (temp) gate log. */
function gateLog(box: Box): Array<Record<string, unknown>> {
  const base = join(box.userHome, ".claude", "logs", "agent-forge");
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((day) => {
    const file = join(base, day, "quality-gate.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  });
}

const SPAWN_TIMEOUT_MS = 60_000;

/**
 * A PATH on which the gate's command runner finds a shell and nothing the
 * gate asks for by name (`bun` and `bd` are not installed in system
 * directories; where `git` is, the scratch checkout is not a repository).
 */
const SHELL_ONLY_PATH =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
    : "/bin:/usr/bin";

describe("the gate entrypoint, spawned with stdin piped", () => {
  test(
    "malformed JSON fails explicitly with the blocking exit code and checks nothing",
    async () => {
      const box = sandbox();
      const out = await spawnGate(box, '{"hook_event_name": "TaskComp');
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain("quality-gate: stdin is not valid JSON");
      expect(out.stderr).toContain("Nothing was checked");
      expect(out.stdout).toBe("");
      expect(gateLog(box)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a payload for another event is refused the same way",
    async () => {
      const box = sandbox();
      const out = await spawnGate(
        box,
        JSON.stringify({ hook_event_name: "Stop", session_id: "S" }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(
        "stdin hook_event_name must be TaskCompleted or TeammateIdle",
      );
      expect(gateLog(box)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a payload over the gate's size bound is refused, however well formed",
    async () => {
      const box = sandbox();
      const out = await spawnGate(
        box,
        JSON.stringify({
          hook_event_name: "TaskCompleted",
          task_description: "x".repeat(1_200_000),
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(
        "quality-gate: stdin is larger than 1048576 bytes. Nothing was checked.",
      );
      expect(out.stdout).toBe("");
      expect(gateLog(box)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "TeammateIdle JSON with no identity variables is logged as TeammateIdle, unlinked",
    async () => {
      const box = sandbox();
      const out = await spawnGate(
        box,
        JSON.stringify({
          hook_event_name: "TeammateIdle",
          session_id: "host-session",
          cwd: box.cwd,
          team_name: "night-shift",
          teammate_name: "worker-2",
        }),
      );
      const printed = JSON.parse(out.stdout) as Record<string, unknown>;
      const [logged, ...others] = gateLog(box);

      expect(others).toEqual([]);
      expect(logged).toEqual(printed);
      expect(logged).toMatchObject({
        schemaVersion: 2,
        event: "TeammateIdle",
        eventSource: "stdin",
        stdin: "payload",
        beadsIssueId: null,
        executionRunId: null,
        host: {
          hostTaskScope: { kind: "agent-team", id: "night-shift" },
          idleTeammateName: "worker-2",
        },
      });
      expect(
        (logged?.checks as Array<{ name: string }>).map((entry) => entry.name),
      ).toEqual(["typecheck", "lint", "tests", "clean-tree"]);
      // In this sandbox `bun` and `git` are not on PATH, so the gate itself fails.
      expect(out.exitCode).toBe(2);

      const [event] = queryEvents(
        { kinds: ["gate.ran"] },
        { path: box.ledger },
      );
      expect(event?.payload).toMatchObject({
        gate: "quality-gate",
        passed: false,
        exitCode: 2,
        trigger: "TeammateIdle",
      });
      expect(event?.beadId).toBeUndefined();
      expect(event?.runId).toBeUndefined();
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "TaskCompleted JSON with a launcher's pointer in the environment is logged with the correlation's ids, not the host's",
    async () => {
      const box = sandbox();
      const pointer = correlate(box, "bead-1", "run-1");
      const bytes = verdict(box, "run-1", v2({ summary: "looks right" }));
      // Unlike the other spawned cases this one can reach a shell (and nothing
      // else), so a host id spliced into a command line would run: under
      // cmd.exe and under sh alike, this one writes the canary file.
      const hostileTaskId =
        "x & echo PWNED > pwned.txt & rem ; echo PWNED > pwned.txt #";
      const out = await spawnGate(
        box,
        JSON.stringify({
          hook_event_name: "TaskCompleted",
          session_id: "host-session",
          cwd: box.cwd,
          task_id: hostileTaskId,
        }),
        {
          [RUN_CORRELATION_ENV]: pointer,
          AGENT_FORGE_EVAL_VERDICT: "strict",
          PATH: SHELL_ONLY_PATH,
        },
      );
      const [logged] = gateLog(box);

      expect(logged).toMatchObject({
        schemaVersion: 2,
        event: "TaskCompleted",
        eventSource: "stdin",
        beadsIssueId: "bead-1",
        executionRunId: "run-1",
        host: {
          hostTaskId: hostileTaskId,
          completerHostSessionId: "host-session",
        },
      });
      expect(logged && "unlinkedReason" in logged).toBe(false);
      expect(logged && "taskId" in logged).toBe(false);
      const strict = (
        logged?.checks as Array<{
          name: string;
          passed: boolean;
          output?: string;
        }>
      ).find((entry) => entry.name === "eval-verdict");
      // The verdict read is the one at the correlated run's declared path.
      expect(strict).toMatchObject({
        passed: true,
        output: "PASS B=0 H=0; evaluator: human reviewer",
      });
      expect(existsSync(join(box.cwd, "pwned.txt"))).toBe(false);
      // The base checks still fail here: no bun and no usable git.
      expect(out.exitCode).toBe(2);

      // Both ledger rows carry the correlation's bead and run.
      const events = queryEvents(
        { kinds: ["gate.ran", "verdict.bound"] },
        { path: box.ledger },
      );
      expect(events.map((event) => event.kind)).toEqual([
        "verdict.bound",
        "gate.ran",
      ]);
      for (const event of events) {
        expect(event.beadId).toBe("bead-1");
        expect(event.runId).toBe("run-1");
      }
      expect(events[0]?.payload).toMatchObject({
        verdict: "pass",
        summary: "looks right",
        evaluatorIdentity: { kind: "human", actorKind: "reviewer" },
      });
      // A human is not an executor: there is no observed model to record.
      expect(events[0]?.payload && "evaluator" in events[0].payload).toBe(
        false,
      );

      // The entry and the event name the same file by the same bytes.
      const artifact = {
        path: evaluatorVerdictPath("run-1"),
        sha256: sha256(bytes),
        bytes: Buffer.byteLength(bytes),
      };
      expect(logged?.evaluatorArtifact).toEqual({
        kind: "evaluator-verdict",
        ...artifact,
        verdictSchemaVersion: 2,
        executionRunId: "run-1",
        beadsIssueId: "bead-1",
        evaluator: { kind: "human", actorKind: "reviewer" },
      });
      expect(events[0]?.payload).toMatchObject({
        verdictArtifact: { ...artifact, schemaVersion: 2 },
      });
      expect(events[1]?.payload).toMatchObject({ trigger: "TaskCompleted" });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "two gate runs over a verdict that was overwritten between them each record the bytes they read",
    async () => {
      const box = sandbox();
      const pointer = correlate(box, "bead-1", "run-1");
      const env = {
        [RUN_CORRELATION_ENV]: pointer,
        AGENT_FORGE_EVAL_VERDICT: "strict",
      };
      const first = verdict(box, "run-1", v2({ summary: "first" }));
      await spawnGate(box, "", env);
      // Nothing stops a plain write under .tmp: the evidence is what was read.
      const second = verdict(
        box,
        "run-1",
        v2({
          verdict: "FAIL",
          findings: { blocker: 1, high: 0, medium: 0, low: 0 },
          summary: "second",
        }),
      );
      await spawnGate(box, "", env);

      expect(
        gateLog(box).map(
          (entry) => (entry.evaluatorArtifact as { sha256: string }).sha256,
        ),
      ).toEqual([sha256(first), sha256(second)]);
      const bound = queryEvents(
        { kinds: ["verdict.bound"] },
        { path: box.ledger },
      );
      expect(
        bound.map((event) =>
          event.kind === "verdict.bound"
            ? [event.payload.verdict, event.payload.verdictArtifact?.sha256]
            : [],
        ),
      ).toEqual([
        ["pass", sha256(first)],
        ["fail", sha256(second)],
      ]);
    },
    SPAWN_TIMEOUT_MS * 2,
  );

  /** Put a command of that name, for cmd.exe and for sh, in `bin`. */
  function standIn(
    bin: string,
    name: string,
    body: { windows: string[]; posix: string[] },
  ): void {
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, `${name}.cmd`),
      ["@echo off", ...body.windows, ""].join("\r\n"),
    );
    const script = join(bin, name);
    writeFileSync(script, ["#!/bin/sh", ...body.posix, ""].join("\n"));
    chmodSync(script, 0o755);
  }

  /**
   * A directory holding a stand-in `git` for the spawned gate: it does nothing
   * but, when asked for the branch name, run `onBranch`. The gate asks for the
   * branch after it has read and judged the verdict and before it writes its
   * log entry and its ledger rows, so this is a way to change the file between
   * the two without any switch in the gate.
   */
  function standInGit(
    box: Box,
    onBranch: { windows: string; posix: string },
  ): string {
    const bin = join(box.root, "stand-in bin");
    standIn(bin, "git", {
      windows: [`if "%2"=="--abbrev-ref" ${onBranch.windows}`, "exit /b 1"],
      posix: [
        `if [ "$2" = "--abbrev-ref" ]; then ${onBranch.posix}; fi`,
        "exit 1",
      ],
    });
    return bin;
  }

  /**
   * Stand-ins under which every base check of the gate passes without running
   * anything: a `bun` that succeeds at whatever it is asked, and a `git` with
   * a clean tree whose recent commits name a test file. The scratch checkout
   * has no package.json and no test files, so lint and tests are skipped.
   */
  function passingChecks(box: Box): string {
    const bin = join(box.root, "passing bin");
    standIn(bin, "bun", { windows: ["exit /b 0"], posix: ["exit 0"] });
    standIn(bin, "git", {
      windows: [
        'if "%1"=="status" exit /b 0',
        'if "%1"=="log" echo a.test.ts',
        'if "%1"=="log" exit /b 0',
        "exit /b 1",
      ],
      posix: [
        'case "$1" in',
        "  status) exit 0 ;;",
        "  log) echo a.test.ts; exit 0 ;;",
        "esac",
        "exit 1",
      ],
    });
    return `${bin}${process.platform === "win32" ? ";" : ":"}${SHELL_ONLY_PATH}`;
  }

  test(
    "a strict run whose checks all pass exits 0 with its verdict on record; when the record cannot be written it is blocked, and its output and its ledger row say so",
    async () => {
      const strictEnv = (box: Box) => ({
        [RUN_CORRELATION_ENV]: correlate(box, "bead-1", "run-1"),
        AGENT_FORGE_EVAL_VERDICT: "strict",
        PATH: passingChecks(box),
      });
      const gateRan = (box: Box) =>
        queryEvents({ kinds: ["gate.ran"] }, { path: box.ledger }).map(
          (event) => event.payload,
        );

      // The record can be written: a pass, logged.
      const recorded = sandbox();
      verdict(recorded, "run-1", v2());
      const passed = await spawnGate(recorded, "", strictEnv(recorded));
      expect(passed.exitCode).toBe(0);
      expect(JSON.parse(passed.stdout)).toMatchObject({
        passed: true,
        blockingFailures: [],
      });
      expect(gateLog(recorded)).toHaveLength(1);
      expect(gateRan(recorded)).toMatchObject([{ passed: true, exitCode: 0 }]);

      // The same run with nowhere to write its log entry.
      const unrecorded = sandbox();
      verdict(unrecorded, "run-1", v2());
      writeFileSync(join(unrecorded.userHome, ".claude"), "not a directory");
      const blocked = await spawnGate(unrecorded, "", strictEnv(unrecorded));
      expect(blocked.exitCode).toBe(2);
      expect(blocked.stderr).toContain(
        "quality-gate: the gate log could not be written, so the bound verdict's evidence is not on record: strict completion is blocked.",
      );
      expect(JSON.parse(blocked.stdout)).toMatchObject({
        passed: false,
        blockingFailures: ["gate-log"],
      });
      expect(gateRan(unrecorded)).toMatchObject([
        { passed: false, exitCode: 2 },
      ]);
    },
    SPAWN_TIMEOUT_MS * 2,
  );

  test(
    "a verdict swapped between the gate's read and its recording changes neither the log entry nor the ledger row",
    async () => {
      const box = sandbox();
      const pointer = correlate(box, "bead-1", "run-1");
      const validated = verdict(box, "run-1", v2({ summary: "as validated" }));
      const place = join(box.cwd, evaluatorVerdictPath("run-1") ?? "");
      // What gets copied over the verdict once the gate has read it.
      const swapped = JSON.stringify(
        v2({
          verdict: "FAIL",
          findings: { blocker: 2, high: 0, medium: 0, low: 0 },
          evaluator: { kind: "human", actorKind: "operator" },
          summary: "swapped in after the read",
        }),
      );
      const source = join(box.root, "swapped.json");
      writeFileSync(source, swapped);
      const bin = standInGit(box, {
        windows: 'copy /Y "%SWAP_SOURCE%" "%SWAP_TARGET%" >nul',
        posix: 'cp "$SWAP_SOURCE" "$SWAP_TARGET"',
      });

      await spawnGate(box, "", {
        [RUN_CORRELATION_ENV]: pointer,
        AGENT_FORGE_EVAL_VERDICT: "strict",
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${SHELL_ONLY_PATH}`,
        SWAP_SOURCE: source,
        SWAP_TARGET: place,
      });

      // The swap happened: the file now holds other bytes.
      expect(readFileSync(place, "utf8")).toBe(swapped);
      // What the gate recorded is what it read and judged.
      const [logged] = gateLog(box);
      expect(logged?.evaluatorArtifact).toMatchObject({
        sha256: sha256(validated),
        bytes: Buffer.byteLength(validated),
        evaluator: { kind: "human", actorKind: "reviewer" },
      });
      const [bound] = queryEvents(
        { kinds: ["verdict.bound"] },
        { path: box.ledger },
      );
      expect(bound?.payload).toMatchObject({
        verdict: "pass",
        summary: "as validated",
        verdictArtifact: {
          sha256: sha256(validated),
          bytes: Buffer.byteLength(validated),
        },
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a bound verdict whose log entry cannot be written is said to be unrecorded",
    async () => {
      const box = sandbox();
      const pointer = correlate(box, "bead-1", "run-1");
      verdict(box, "run-1", v2());
      // A file where the log's directory tree would start: nothing can be appended.
      writeFileSync(join(box.userHome, ".claude"), "not a directory");
      const out = await spawnGate(box, "", {
        [RUN_CORRELATION_ENV]: pointer,
        AGENT_FORGE_EVAL_VERDICT: "strict",
      });
      expect(gateLog(box)).toEqual([]);
      expect(out.stderr).toContain(
        "quality-gate: the gate log could not be written, so the bound verdict's evidence is not on record: strict completion is blocked.",
      );
      expect(out.exitCode).toBe(2);
    },
    SPAWN_TIMEOUT_MS,
  );

  /** The eval-verdict check of a spawned strict run over one model verdict. */
  async function spawnedStrictCheck(
    box: Box,
    evaluator: Record<string, unknown>,
  ): Promise<{ check: Record<string, unknown> | undefined; stderr: string }> {
    const pointer = correlate(box, "bead-1", "run-1");
    verdict(box, "run-1", v2({ evaluator }));
    const out = await spawnGate(box, "", {
      [RUN_CORRELATION_ENV]: pointer,
      AGENT_FORGE_EVAL_VERDICT: "strict",
    });
    const [logged] = gateLog(box);
    return {
      check: (logged?.checks as Array<Record<string, unknown>>).find(
        (entry) => entry.name === "eval-verdict",
      ),
      stderr: out.stderr,
    };
  }

  test(
    "strict mode ranks a model evaluator from the smiths configured for the checkout",
    async () => {
      // Built-in smiths only: an observed master passes with no builder on record.
      const builtin = await spawnedStrictCheck(sandbox(), modelEvaluator());
      expect(builtin.check).toMatchObject({ passed: true });

      // A model only the checkout's own config ranks.
      const local = { observedModel: "house-model", requestedModel: "x" };
      const unranked = await spawnedStrictCheck(
        sandbox(),
        modelEvaluator(local),
      );
      expect(unranked.check).toEqual({
        name: "eval-verdict",
        passed: false,
        output:
          "observed evaluator claude/house-model has no rank: no configured smith with a rank:* tag uses that provider and model",
      });

      const configured = sandbox();
      writeFileSync(
        join(configured.cwd, "agent-forge.toml"),
        [
          "[smiths.house]",
          'provider = "claude"',
          'model = "house-model"',
          'effort = "high"',
          'tags = ["rank:master"]',
          "",
        ].join("\n"),
      );
      const ranked = await spawnedStrictCheck(
        configured,
        modelEvaluator(local),
      );
      expect(ranked.check).toMatchObject({ passed: true });
    },
    SPAWN_TIMEOUT_MS * 3,
  );

  test(
    "strict mode fails closed when the smith config cannot be read, and says so",
    async () => {
      const box = sandbox();
      writeFileSync(join(box.cwd, "agent-forge.toml"), "[smiths.broken\n");
      const broken = await spawnedStrictCheck(box, modelEvaluator());
      expect(broken.check).toEqual({
        name: "eval-verdict",
        passed: false,
        output:
          "observed evaluator claude/claude-opus-5-5 has no rank: no configured smith with a rank:* tag uses that provider and model",
      });
      expect(broken.stderr).toContain(
        "quality-gate: smith config not readable, so no evaluator has a rank:",
      );

      // A human verdict needs no rank: the config is not read for it.
      const human = sandbox();
      writeFileSync(join(human.cwd, "agent-forge.toml"), "[smiths.broken\n");
      const judged = await spawnedStrictCheck(human, {
        kind: "human",
        actorKind: "operator",
      });
      expect(judged.check).toMatchObject({ passed: true });
      expect(judged.stderr).not.toContain("smith config not readable");
    },
    SPAWN_TIMEOUT_MS * 2,
  );

  test(
    "a --correlation flag that points at nothing fails explicitly; an environment pointer that does is reported and logged unlinked",
    async () => {
      const box = sandbox();
      const missing = join(
        box.cwd,
        ".tmp",
        "work",
        "run-correlations",
        "x.json",
      );

      const flagged = await spawnGate(box, "", {}, ["--correlation", missing]);
      expect(flagged.exitCode).toBe(2);
      expect(flagged.stderr).toContain(
        "quality-gate: run correlation refused: the pointer names no readable file. Nothing was checked.",
      );
      expect(flagged.stdout).toBe("");
      expect(gateLog(box)).toEqual([]);

      const viaEnv = await spawnGate(box, "", {
        [RUN_CORRELATION_ENV]: missing,
      });
      expect(viaEnv.stderr).toContain(
        "quality-gate: run correlation refused: the pointer names no readable file",
      );
      expect(viaEnv.stderr).not.toContain("Nothing was checked");
      const [logged] = gateLog(box);
      expect(logged).toMatchObject({
        beadsIssueId: null,
        executionRunId: null,
        unlinkedReason:
          "run correlation refused: the pointer names no readable file",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "empty piped input is a run with no payload: the default event, no trigger",
    async () => {
      const box = sandbox();
      await spawnGate(box, "");
      const [logged] = gateLog(box);
      expect(logged).toMatchObject({
        event: "TaskCompleted",
        eventSource: "default",
        stdin: "empty",
        beadsIssueId: null,
      });
      expect(logged && "host" in logged).toBe(false);
      const [event] = queryEvents(
        { kinds: ["gate.ran"] },
        { path: box.ledger },
      );
      expect(event?.payload && "trigger" in event.payload).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a pipe nobody closes cannot hang the hook",
    async () => {
      const box = sandbox();
      const out = await spawnGate(box, "never-closed");
      const [logged] = gateLog(box);
      // Recorded as a payload that never came, not as a run by hand.
      expect(logged).toMatchObject({
        event: "TaskCompleted",
        eventSource: "default",
        stdin: "silent",
      });
      expect(out.exitCode).toBe(2);
      expect(out.ms).toBeLessThan(30_000);
    },
    SPAWN_TIMEOUT_MS,
  );
});
