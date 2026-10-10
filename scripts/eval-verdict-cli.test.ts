/**
 * `bun run forge:verdict`: the one writer of evaluator verdicts.
 *
 * In process: `runVerdictWrite` with a scratch checkout, a real run
 * correlation and injected session, smith and run-state lookups. As a
 * subprocess: the real script against a scratch ledger seeded with a session's
 * model, which is the machine source an observed evaluator comes from.
 *
 * No test here runs a real evaluator session: the session model is seeded.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type GateDeps, runQualityGate } from "../.claude/hooks/quality-gate";
import type { Executor } from "../types/hearth";
import { BUILTIN_SMITHS } from "./config/defaults";
import { parseEvalVerdictJson } from "./eval-verdict";
import { runVerdictWrite, type VerdictWriteDeps } from "./eval-verdict-cli";
import {
  evaluationDir,
  evaluatorVerdictPath,
  readVerdictOnce,
  sha256Hex,
} from "./eval-verdict-store";
import { appendEvent } from "./ledger/append";
import { closeLedger } from "./ledger/db";
import { writeSessionMirror } from "./ledger/identity";
import { setSessionModel } from "./ledger/session-models";
import { resolveCheckout } from "./ledger/workspace";
import { initRunCorrelation } from "./run-correlation-store";

const CLI = join(import.meta.dir, "eval-verdict-cli.ts");

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
  cwd: string;
  home: string;
  pointer: string;
}

/** A scratch checkout whose run `run-1` is correlated to `bead-1`. */
function sandbox(run = "run-1"): Box {
  const root = mkdtempSync(join(tmpdir(), "verdict cli test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const made = initRunCorrelation({
    checkout: cwd,
    beadsIssueId: "bead-1",
    executionRunId: run,
  });
  if (!made.ok) throw new Error(made.error);
  return { root, cwd, home: join(root, "forge home"), pointer: made.path };
}

const OPUS = { provider: "claude", model: "claude-opus-5-5" };
const SONNET = { provider: "claude", model: "claude-sonnet-5-5" };
const HAIKU = { provider: "claude", model: "claude-haiku-4-5-20251001" };

interface World {
  /** The session the mirror of the worktree the command runs in names, if any. */
  session?: string;
  /** The model the ledger has cached for a session. */
  models?: Record<string, { provider: string; model: string }>;
  /** Who the run's state says built the work. */
  builder?: Executor;
  /** The sessions the ledger shows building this run's work. */
  builderSessions?: string[];
  env?: Record<string, string>;
  /** Where the command runs, when that is not the run's checkout. */
  cwd?: string;
}

function deps(box: Box, world: World = {}): VerdictWriteDeps {
  return {
    cwd: world.cwd ?? box.cwd,
    env: world.env ?? {},
    // A session's mirror is in the worktree that session works in.
    sessionMirror: (worktree) =>
      worktree === resolveCheckout(world.cwd ?? box.cwd).worktree
        ? (world.session ?? null)
        : null,
    sessionModel: (sessionId) => world.models?.[sessionId] ?? null,
    builderSessions: (run) =>
      run.executionRunId === "run-1" && run.beadsIssueId === "bead-1"
        ? (world.builderSessions ?? [])
        : [],
    smiths: () => Object.values(BUILTIN_SMITHS),
    runState: (runId) =>
      world.builder
        ? {
            slug: runId,
            feature: runId,
            phase: "implement",
            completed: ["research", "plan"],
            artifacts: {},
            updatedAt: "2026-06-04T00:00:00.000Z",
            executor: world.builder,
          }
        : null,
  };
}

const PASS = ["--verdict", "PASS"];
const AS_REVIEWER = ["--human", "reviewer"];
const REQUEST_MASTER = [
  "--requested-provider",
  "claude",
  "--requested-model",
  "claude-opus-5-5",
  "--requested-rank",
  "master",
];

function write(box: Box, argv: string[], world: World = {}) {
  return runVerdictWrite(
    ["--correlation", box.pointer, ...argv],
    deps(box, world),
  );
}

function stored(box: Box, relative: string | null): Record<string, unknown> {
  return JSON.parse(readFileSync(join(box.cwd, relative ?? ""), "utf8"));
}

/** What the run's verdict file holds, or null when there is none. */
function runVerdict(box: Box, run = "run-1"): Record<string, unknown> | null {
  const read = readVerdictOnce({ checkout: box.cwd, executionRunId: run });
  return read.ok ? JSON.parse(read.buffer.toString("utf8")) : null;
}

/** The strict gate over the same checkout, as a second opinion on what was written. */
function gateCheck(box: Box, builder?: Executor) {
  const gateDeps: GateDeps = {
    cwd: box.cwd,
    env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    run: (cmd) =>
      cmd.startsWith("git rev-parse --show-toplevel")
        ? { ok: false, output: "" }
        : { ok: true, output: cmd.startsWith("git log") ? "a.test.ts" : "" },
    execFile: () => ({ ok: false, output: "" }),
    hasScript: () => true,
    hasTestFiles: () => true,
    smiths: () => Object.values(BUILTIN_SMITHS),
    runState: deps(box, builder ? { builder } : {}).runState,
    readVerdict: (checkout, executionRunId) =>
      readVerdictOnce({ checkout, executionRunId }),
  };
  const outcome = runQualityGate({
    stdin: { kind: "none", reason: "terminal" },
    argv: ["--correlation", box.pointer],
    deps: gateDeps,
  });
  if (outcome.kind !== "ran") throw new Error(outcome.error);
  return {
    check: outcome.result.checks.find((entry) => entry.name === "eval-verdict"),
    artifact: outcome.result.evaluatorArtifact,
  };
}

describe("forge:verdict, a human verdict", () => {
  test("is written once at the run's declared path, with the correlation's ids, and satisfies the strict gate", () => {
    const box = sandbox();
    const wrote = write(box, [
      ...PASS,
      ...AS_REVIEWER,
      "--medium",
      "2",
      "--summary",
      "two things to tidy",
      "--attest",
      "quality=4",
      "--attest",
      "ux=3",
    ]);
    expect(wrote.code).toBe(0);
    const path = evaluatorVerdictPath("run-1");
    expect(stored(box, path)).toEqual({
      schemaVersion: 2,
      beadsIssueId: "bead-1",
      executionRunId: "run-1",
      verdict: "PASS",
      findings: { blocker: 0, high: 0, medium: 2, low: 0 },
      summary: "two things to tidy",
      attestations: { quality: 4, ux: 3 },
      evaluator: { kind: "human", actorKind: "reviewer" },
    });
    const bytes = readFileSync(join(box.cwd, path ?? ""));
    expect(wrote.body).toEqual({
      ok: true,
      data: {
        path,
        // The same file by its full path: what another command is handed.
        file: `${resolveCheckout(box.cwd).worktree}/${path}`,
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
        beadsIssueId: "bead-1",
        executionRunId: "run-1",
        strict: true,
        evaluator: { kind: "human", actorKind: "reviewer" },
      },
      error: null,
    });

    const gate = gateCheck(box);
    expect(gate.check).toMatchObject({ passed: true });
    expect(gate.artifact).toMatchObject({
      path,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    });
  });

  test("a second write for the same run fails, says so, and leaves the first verdict as it was", () => {
    const box = sandbox();
    write(box, [...PASS, ...AS_REVIEWER]);
    const before = readFileSync(
      join(box.cwd, evaluatorVerdictPath("run-1") ?? ""),
    );
    const again = write(box, [
      "--verdict",
      "FAIL",
      "--blocker",
      "1",
      "--human",
      "operator",
    ]);
    expect(again).toEqual({
      code: 2,
      body: {
        ok: false,
        data: null,
        error: `a verdict already exists at ${evaluatorVerdictPath("run-1")}: it is written once and never replaced. A re-evaluation is a new run: bun run forge:correlate --bead bead-1`,
      },
    });
    expect(
      readFileSync(join(box.cwd, evaluatorVerdictPath("run-1") ?? "")),
    ).toEqual(before);
  });
});

describe("forge:verdict, its arguments", () => {
  test("a flag is taken in either spelling, and a blocking count is never lost to a spelling", () => {
    for (const argv of [
      ["--verdict", "FAIL", "--high", "1", "--low", "1", "--human", "reviewer"],
      ["--verdict=FAIL", "--high=1", "--low=1", "--human=reviewer"],
    ]) {
      const box = sandbox();
      expect(write(box, argv).code).toBe(0);
      expect(runVerdict(box)).toMatchObject({
        verdict: "FAIL",
        findings: { blocker: 0, high: 1, medium: 0, low: 1 },
      });
      // The verdict blocks, as its writer meant.
      expect(gateCheck(box).check).toMatchObject({
        passed: false,
        output:
          'verdict FAIL with blocker/high — {"blocker":0,"high":1,"medium":0,"low":1}',
      });
    }
  });

  test("anything it does not know, cannot pair with a value, or is told twice is refused, and nothing is written", () => {
    const FAIL_LOW = ["--verdict", "FAIL", "--low", "1", ...AS_REVIEWER];
    const cases: Array<[string[], string]> = [
      // A typo of a count must not become a verdict without that count.
      [
        [
          "--verdict",
          "FAIL",
          "--blockers",
          "2",
          "--medium",
          "1",
          ...AS_REVIEWER,
        ],
        'unknown argument "--blockers"',
      ],
      [[...FAIL_LOW, "--high"], "--high needs a value"],
      [[...FAIL_LOW, "--high="], "--high needs a value"],
      [[...PASS, ...AS_REVIEWER, "--review"], "--review needs a value"],
      // A forgotten value must not swallow the flag that follows it.
      [
        [
          "--verdict",
          "FAIL",
          "--low",
          "1",
          ...AS_REVIEWER,
          "--summary",
          "--high=1",
        ],
        "--summary needs a value: the next argument is the flag --high (for text that starts with dashes, write --summary=<text>)",
      ],
      [
        [...PASS, ...AS_REVIEWER, "--summary", "--review=plan-1"],
        "--summary needs a value: the next argument is the flag --review (for text that starts with dashes, write --summary=<text>)",
      ],
      [
        [...PASS, ...AS_REVIEWER, "--summary", "--human"],
        "--summary needs a value: the next argument is the flag --human (for text that starts with dashes, write --summary=<text>)",
      ],
      [
        [
          ...PASS,
          ...AS_REVIEWER,
          "--attest",
          "quality=4",
          "--attest",
          "quality=1",
        ],
        "--attest quality was given more than once",
      ],
      [
        [...PASS, "--verdict", "FAIL", ...AS_REVIEWER],
        "--verdict was given more than once",
      ],
      [[...PASS, ...AS_REVIEWER, "extra"], 'unexpected argument "extra"'],
      // Ids and the observation have no flag: they are not typed.
      [
        [...PASS, ...AS_REVIEWER, "--bead", "bead-9"],
        'unknown argument "--bead"',
      ],
      [[...PASS, ...AS_REVIEWER, "--run", "run-9"], 'unknown argument "--run"'],
      [
        [...PASS, ...REQUEST_MASTER, "--observed-model", "claude-opus-5-5"],
        'unknown argument "--observed-model"',
      ],
      [
        [...PASS, ...REQUEST_MASTER, "--session", "session-9"],
        'unknown argument "--session"',
      ],
      [
        [...PASS, ...AS_REVIEWER, "--attest", "__proto__=1"],
        "--attest __proto__ is not a known dimension (quality|reliability|creativity|maintainability|ux)",
      ],
    ];
    for (const [argv, error] of cases) {
      const box = sandbox();
      const wrote = write(box, argv);
      expect({ argv, code: wrote.code, error: wrote.body.error }).toEqual({
        argv,
        code: 2,
        error,
      });
      expect(runVerdict(box)).toBeNull();
    }
  });

  test("--review in either spelling writes the round's file and leaves the run's verdict unwritten", () => {
    for (const argv of [["--review", "plan-1"], ["--review=plan-1"]]) {
      const box = sandbox();
      const wrote = write(box, [...PASS, ...AS_REVIEWER, ...argv]);
      expect(wrote.body.data).toMatchObject({
        path: `${evaluationDir("run-1")}/review-plan-1.json`,
        strict: false,
      });
      expect(runVerdict(box)).toBeNull();
    }
  });

  test("text that starts with dashes is still a value: after the flag when it is not itself a flag, with = when it is", () => {
    const spaced = sandbox();
    expect(
      write(spaced, [...PASS, ...AS_REVIEWER, "--summary", "--human was right"])
        .code,
    ).toBe(0);
    expect(runVerdict(spaced)).toMatchObject({
      summary: "--human was right",
      evaluator: { kind: "human", actorKind: "reviewer" },
    });

    const inline = sandbox();
    expect(
      write(inline, [...PASS, ...AS_REVIEWER, "--summary=--high=1"]).code,
    ).toBe(0);
    expect(runVerdict(inline)).toMatchObject({
      summary: "--high=1",
      findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    });
  });

  test("the run is the one --correlation names, never a pointer that appears inside another flag's value", () => {
    const box = sandbox();
    const other = initRunCorrelation({
      checkout: box.cwd,
      beadsIssueId: "bead-2",
      executionRunId: "run-2",
    });
    if (!other.ok) throw new Error(other.error);
    const wrote = write(box, [
      ...PASS,
      ...AS_REVIEWER,
      `--summary=--correlation=${other.path}`,
    ]);
    expect(wrote.code).toBe(0);
    expect(wrote.body.data).toMatchObject({
      beadsIssueId: "bead-1",
      executionRunId: "run-1",
    });
    expect(runVerdict(box, "run-2")).toBeNull();
  });
});

describe("forge:verdict, a model verdict", () => {
  test("records what the ledger cached for the session working where the command runs as observed, and the gate accepts it", () => {
    const box = sandbox();
    const world = {
      session: "session-9",
      // The cache's strings are taken as plain text.
      models: {
        "session-9": { provider: " claude ", model: " claude-opus-5-5 " },
      },
      builder: SONNET,
    };
    const wrote = write(box, [...PASS, ...REQUEST_MASTER], world);
    expect(wrote.code).toBe(0);
    expect(stored(box, evaluatorVerdictPath("run-1")).evaluator).toEqual({
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
      sessionId: "session-9",
    });
    expect(gateCheck(box, SONNET).check).toMatchObject({ passed: true });
  });

  test("the observed model is the session's, never the requested one: a weaker session is refused for the run's verdict", () => {
    const box = sandbox();
    const wrote = write(box, [...PASS, ...REQUEST_MASTER], {
      session: "session-9",
      models: { "session-9": HAIKU },
      builder: SONNET,
    });
    expect(wrote).toEqual({
      code: 2,
      body: {
        ok: false,
        data: null,
        error:
          "not written: this verdict could never satisfy strict completion, and a run's verdict is written once. observed evaluator claude/claude-haiku-4-5-20251001 (rank apprentice) is below the builder's rank (journeyman)",
      },
    });
    expect(runVerdict(box)).toBeNull();
  });

  test("with nothing to observe the run's verdict is refused rather than written from the request, and the refusal says what was missing", () => {
    const cases: Array<[World, string]> = [
      [
        {},
        "no session is recorded as working in the worktree this command runs in (no session mirror there, or one older than a day)",
      ],
      [
        { session: "session-9" },
        "the ledger has no model cached for the session working in this worktree",
      ],
      [
        { session: "session-9", models: { "another-session": OPUS } },
        "the ledger has no model cached for the session working in this worktree",
      ],
    ];
    for (const [world, reason] of cases) {
      const box = sandbox();
      const wrote = write(box, [...PASS, ...REQUEST_MASTER], world);
      expect(wrote.code).toBe(2);
      expect(wrote.body.error).toBe(
        `not written: this verdict could never satisfy strict completion, and a run's verdict is written once. the verdict records no observed evaluator provider and model (requested claude/claude-opus-5-5 is not evidence of what ran). Nothing was observed: ${reason}`,
      );
      expect(runVerdict(box)).toBeNull();
    }
  });

  test("a session the ledger shows building the work is not an observation of who judged it", () => {
    const sameSession: World = {
      session: "session-9",
      models: { "session-9": OPUS },
      builder: OPUS,
      // The ledger has this very session entering or completing the run's phases.
      builderSessions: ["session-9"],
    };
    const strict = sandbox();
    const refused = write(strict, [...PASS, ...REQUEST_MASTER], sameSession);
    expect(refused.code).toBe(2);
    expect(refused.body.error).toEndWith(
      "Nothing was observed: the session filing this verdict is one the ledger shows building this work (it entered or completed a phase of this run, or of another run of the same Beads issue), so its model is not an observation of the evaluator (an Evaluator subagent shares its spawner's session)",
    );
    expect(runVerdict(strict)).toBeNull();

    // A round's verdict is still written, with nothing observed.
    const round = sandbox();
    const wrote = write(
      round,
      [...PASS, ...REQUEST_MASTER, "--review", "plan-1"],
      sameSession,
    );
    expect(wrote.code).toBe(0);
    expect(wrote.body.data).toMatchObject({
      unobserved:
        "the session filing this verdict is one the ledger shows building this work (it entered or completed a phase of this run, or of another run of the same Beads issue), so its model is not an observation of the evaluator (an Evaluator subagent shares its spawner's session)",
    });
    const evaluator = stored(
      round,
      `${evaluationDir("run-1")}/review-plan-1.json`,
    ).evaluator as Record<string, unknown>;
    expect("observedModel" in evaluator).toBe(false);
    expect("sessionId" in evaluator).toBe(false);
  });

  test("who built the work is what the ledger shows, not the session the run's state was last pointed at", () => {
    // A separate evaluator session ran forge:review, which repointed the
    // run state's executor at it. The builder is still the builder.
    const world: World = {
      session: "evaluator-session",
      models: { "evaluator-session": OPUS, "builder-session": OPUS },
      builder: { ...SONNET, sessionId: "evaluator-session" },
      builderSessions: ["builder-session"],
    };
    const evaluator = sandbox();
    expect(write(evaluator, [...PASS, ...REQUEST_MASTER], world).code).toBe(0);
    expect(runVerdict(evaluator)).toMatchObject({
      evaluator: { sessionId: "evaluator-session" },
    });

    // And the builder filing for itself is refused, whatever the state says.
    const builder = sandbox();
    expect(
      write(builder, [...PASS, ...REQUEST_MASTER], {
        ...world,
        session: "builder-session",
      }).code,
    ).toBe(2);
    expect(runVerdict(builder)).toBeNull();
  });

  test("the builder the rank policy sees is the one the gate will see: the state in the checkout the run builds in", () => {
    const box = sandbox();
    const elsewhere = join(box.root, "session tree");
    mkdirSync(join(elsewhere, ".git"), { recursive: true });
    const runRoot = resolveCheckout(box.cwd).worktree;
    const base = deps(box, {
      cwd: elsewhere,
      session: "session-9",
      models: { "session-9": SONNET },
      // Only the launching checkout's state names a builder: an apprentice.
      builder: HAIKU,
    });
    const launcherOnly: VerdictWriteDeps = {
      ...base,
      runState: (runId, checkout) =>
        checkout === runRoot ? null : base.runState(runId, checkout),
    };
    const wrote = runVerdictWrite(
      [
        "--correlation",
        ".tmp/work/run-correlations/run-1.json",
        "--checkout",
        box.cwd,
        ...PASS,
        "--requested-provider",
        "claude",
        "--requested-model",
        "claude-sonnet-5-5",
        "--requested-rank",
        "journeyman",
      ],
      launcherOnly,
    );
    // A journeyman may grade an apprentice, but the gate, running where the
    // run builds, will find no builder there: the writer says what it will say.
    expect(wrote.body.error).toBe(
      "not written: this verdict could never satisfy strict completion, and a run's verdict is written once. the run records no builder whose rank is known, so only a master evaluator satisfies grader >= subject; observed evaluator claude/claude-sonnet-5-5 is rank journeyman",
    );
  });
});

describe("forge:verdict --review, a review round's verdict", () => {
  test("is written once per label beside the run's verdict, even when nothing was observed, and says what a strict gate would object to", () => {
    const box = sandbox();
    const wrote = write(box, [
      "--verdict",
      "FAIL",
      "--high",
      "1",
      ...REQUEST_MASTER,
      "--review",
      "plan-1",
    ]);
    expect(wrote.code).toBe(0);
    const path = `${evaluationDir("run-1")}/review-plan-1.json`;
    expect(wrote.body.data).toMatchObject({
      path,
      strict: false,
      evaluatorProblem:
        "the verdict records no observed evaluator provider and model (requested claude/claude-opus-5-5 is not evidence of what ran)",
      unobserved:
        "no session is recorded as working in the worktree this command runs in (no session mirror there, or one older than a day)",
    });
    const file = stored(box, path);
    expect(file.evaluator).toEqual({
      kind: "model",
      requestedProvider: "claude",
      requestedModel: "claude-opus-5-5",
      requestedRank: "master",
      rankPolicyDecision: "rejected",
      rankPolicyRule: "evaluator-rank-unknown",
    });
    // The reader's parser accepts what the writer wrote.
    expect(
      parseEvalVerdictJson(readFileSync(join(box.cwd, path), "utf8")).ok,
    ).toBe(true);
    // The run's own verdict is still unwritten: a round is not it.
    expect(runVerdict(box)).toBeNull();

    expect(
      write(box, [...PASS, ...AS_REVIEWER, "--review", "plan-1"]),
    ).toMatchObject({ code: 2 });
    expect(
      write(box, [...PASS, ...AS_REVIEWER, "--review", "plan-2"]),
    ).toMatchObject({ code: 0 });
    expect(
      write(box, [...PASS, ...AS_REVIEWER, "--review", "Plan 3"]).body.error,
    ).toBe(
      "--review <label> must be lower-case letters, digits and dashes (at most 40), such as plan-2",
    );
  });
});

describe("forge:verdict, where the run and the session are", () => {
  test("the ids are the correlation's, whatever the environment names", () => {
    const box = sandbox();
    const wrote = runVerdictWrite(
      [...PASS, ...AS_REVIEWER],
      deps(box, {
        env: {
          AGENT_FORGE_RUN_CORRELATION: box.pointer,
          AGENT_FORGE_BEAD_ID: "bead-from-the-environment",
          FORGE_SLUG: "run-from-the-environment",
          AGENT_FORGE_SMITH: "claude-master",
        },
      }),
    );
    expect(wrote.code).toBe(0);
    expect(runVerdict(box)).toMatchObject({
      beadsIssueId: "bead-1",
      executionRunId: "run-1",
    });
  });

  test("no correlation, or one that does not validate: the ids come from nowhere else", () => {
    const box = sandbox();
    const none = runVerdictWrite([...PASS, ...AS_REVIEWER], deps(box));
    expect(none.code).toBe(2);
    expect(none.body.error).toBe(
      "no run correlation was given (--correlation <path> or AGENT_FORGE_RUN_CORRELATION)",
    );
    const bad = runVerdictWrite(
      ["--correlation", join(box.cwd, "nowhere.json"), ...PASS, ...AS_REVIEWER],
      deps(box),
    );
    expect(bad.body.error).toBe(
      "run correlation refused: the pointer names no readable file",
    );
    expect(runVerdict(box)).toBeNull();
  });

  test("--checkout names the checkout the run builds in; the session observed is the one where the command runs", () => {
    // The run builds in `box.cwd`; the command runs in another checkout.
    const box = sandbox();
    const elsewhere = join(box.root, "session tree");
    mkdirSync(join(elsewhere, ".git"), { recursive: true });
    const world: World = {
      cwd: elsewhere,
      session: "session-9",
      models: { "session-9": OPUS },
    };

    // Without --checkout the correlation is looked for where the command runs.
    const lost = runVerdictWrite(
      [
        "--correlation",
        ".tmp/work/run-correlations/run-1.json",
        ...PASS,
        ...REQUEST_MASTER,
      ],
      deps(box, world),
    );
    expect(lost.body.error).toBe(
      "run correlation refused: the pointer names no readable file",
    );

    const wrote = runVerdictWrite(
      [
        "--correlation",
        ".tmp/work/run-correlations/run-1.json",
        "--checkout",
        box.cwd,
        ...PASS,
        ...REQUEST_MASTER,
      ],
      deps(box, world),
    );
    expect(wrote.code).toBe(0);
    expect(wrote.body.data).toMatchObject({
      path: evaluatorVerdictPath("run-1"),
      file: `${resolveCheckout(box.cwd).worktree}/${evaluatorVerdictPath("run-1")}`,
      evaluator: { observedModel: "claude-opus-5-5", sessionId: "session-9" },
    });
    expect(runVerdict(box)).not.toBeNull();

    // A directory inside a checkout is not that checkout.
    const nested = join(box.cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(
      runVerdictWrite(
        [
          "--correlation",
          box.pointer,
          "--checkout",
          nested,
          ...PASS,
          ...AS_REVIEWER,
        ],
        deps(box, world),
      ).body.error,
    ).toBe("--checkout must be the top level of a checkout");
  });
});

describe("forge:verdict, what it refuses", () => {
  test("a verdict that contradicts its own counts, and an evaluator that is not exactly one kind", () => {
    const box = sandbox();
    const cases: Array<[string[], string]> = [
      [AS_REVIEWER, '--verdict must be "PASS" or "FAIL"'],
      [
        [...PASS, ...AS_REVIEWER, "--high", "1"],
        "a PASS has no blocker or high findings",
      ],
      [
        ["--verdict", "FAIL", ...AS_REVIEWER],
        "a FAIL names at least one finding",
      ],
      [
        [...PASS, ...AS_REVIEWER, "--low", "-1"],
        "--low must be a non-negative integer",
      ],
      [
        PASS,
        "name the evaluator: --human <operator|reviewer>, or --requested-provider, --requested-model and --requested-rank",
      ],
      [
        [...PASS, ...AS_REVIEWER, ...REQUEST_MASTER],
        "name the evaluator: --human <operator|reviewer>, or --requested-provider, --requested-model and --requested-rank",
      ],
      [
        [...PASS, "--human", "robot"],
        "evaluator actorKind must be operator or reviewer",
      ],
      [
        [...PASS, ...REQUEST_MASTER.slice(0, 5), "grandmaster"],
        "evaluator requestedRank must be apprentice, journeyman, master",
      ],
      [
        [...PASS, ...AS_REVIEWER, "--attest", "vibes=5"],
        "--attest vibes is not a known dimension (quality|reliability|creativity|maintainability|ux)",
      ],
      [
        [...PASS, ...AS_REVIEWER, "--attest", "quality"],
        "--attest takes <dimension>=<0..5>",
      ],
      [
        [...PASS, ...AS_REVIEWER, "--attest", "quality=9"],
        "attestations.quality must be an integer 0..5",
      ],
    ];
    for (const [argv, error] of cases) {
      const wrote = write(box, argv);
      expect(wrote.code).toBe(2);
      expect(wrote.body.error).toBe(error);
    }
    expect(runVerdict(box)).toBeNull();
  });
});

/** The parent's environment minus anything that names a live session, run or ledger, with scratch homes. */
function scratchEnv(box: Box): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE_|AGENT_FORGE_|FORGE_)/.test(key)) continue;
    env[key] = value;
  }
  env.AGENT_FORGE_HOME = box.home;
  env.HOME = join(box.root, "user home");
  env.USERPROFILE = env.HOME;
  return env;
}

describe("forge:verdict, spawned against a scratch ledger", () => {
  test("reads the evaluator's model from the session the worktree's mirror names and the ledger cached", async () => {
    const box = sandbox();
    const ledger = join(box.home, "ledger.db");
    mkdirSync(box.home, { recursive: true });
    expect(writeSessionMirror(box.cwd, "session-live")).toBe(true);
    expect(
      setSessionModel(
        { sessionId: "session-live", ...OPUS, effort: "high" },
        { path: ledger },
      ),
    ).toBe(true);
    closeLedger();

    const env = scratchEnv(box);
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        CLI,
        "--correlation",
        box.pointer,
        ...PASS,
        ...REQUEST_MASTER,
      ],
      { cwd: box.cwd, env, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const printed = JSON.parse(stdout);
    expect(printed.data.evaluator).toEqual({
      kind: "model",
      requestedProvider: "claude",
      requestedModel: "claude-opus-5-5",
      requestedRank: "master",
      observedProvider: "claude",
      observedModel: "claude-opus-5-5",
      providerEvidence: "selected-direct-transport",
      modelEvidence: "response-field",
      // No builder on record for the run: a master may still grade it.
      rankPolicyDecision: "allowed",
      rankPolicyRule: "master-evaluator-builder-unknown",
      sessionId: "session-live",
    });
    expect(stored(box, evaluatorVerdictPath("run-1")).evaluator).toEqual(
      printed.data.evaluator,
    );
  }, 60_000);

  test("takes no observation from a session the ledger shows building the run, or another run of the same bead", async () => {
    for (const built of [
      { runId: "run-1" },
      { runId: "an-earlier-run", beadId: "bead-1" },
    ]) {
      const box = sandbox();
      const ledger = join(box.home, "ledger.db");
      mkdirSync(box.home, { recursive: true });
      expect(writeSessionMirror(box.cwd, "session-live")).toBe(true);
      setSessionModel({ sessionId: "session-live", ...OPUS }, { path: ledger });
      // The same session completed a phase: it is the builder.
      expect(
        appendEvent(
          {
            kind: "run.phase.completed",
            workspace: box.cwd,
            sessionId: "session-live",
            ...built,
            payload: { phase: "implement" },
          },
          { path: ledger },
        ).ok,
      ).toBe(true);
      closeLedger();

      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          CLI,
          "--correlation",
          box.pointer,
          ...PASS,
          ...REQUEST_MASTER,
        ],
        { cwd: box.cwd, env: scratchEnv(box), stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      expect(await child.exited).toBe(2);
      expect(JSON.parse(stdout).error).toEndWith(
        "Nothing was observed: the session filing this verdict is one the ledger shows building this work (it entered or completed a phase of this run, or of another run of the same Beads issue), so its model is not an observation of the evaluator (an Evaluator subagent shares its spawner's session)",
      );
      expect(runVerdict(box)).toBeNull();
    }
  }, 120_000);
});
