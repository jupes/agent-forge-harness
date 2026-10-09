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
import { closeLedger } from "./ledger/db";
import { writeSessionMirror } from "./ledger/identity";
import { setSessionModel } from "./ledger/session-models";
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
  /** The session the worktree's mirror names, if any. */
  session?: string;
  /** The model the ledger has cached for a session. */
  models?: Record<string, { provider: string; model: string }>;
  /** Who the run's state says built the work. */
  builder?: Executor;
}

function deps(box: Box, world: World = {}): VerdictWriteDeps {
  return {
    cwd: box.cwd,
    env: {},
    sessionMirror: () => world.session ?? null,
    sessionModel: (sessionId) => world.models?.[sessionId] ?? null,
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

describe("forge:verdict, a model verdict", () => {
  test("records what the ledger cached for the worktree's session as observed, and the gate accepts it", () => {
    const box = sandbox();
    const world = {
      session: "session-9",
      models: { "session-9": OPUS },
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
    expect(
      readVerdictOnce({ checkout: box.cwd, executionRunId: "run-1" }),
    ).toMatchObject({ ok: false, missing: true });
  });

  test("with no session to observe, or no model cached for it, the run's verdict is refused rather than written from the request", () => {
    for (const world of [
      {},
      { session: "session-9" },
      { session: "session-9", models: { "another-session": OPUS } },
    ]) {
      const box = sandbox();
      const wrote = write(box, [...PASS, ...REQUEST_MASTER], world);
      expect(wrote.code).toBe(2);
      expect(wrote.body.error).toBe(
        "not written: this verdict could never satisfy strict completion, and a run's verdict is written once. the verdict records no observed evaluator provider and model (requested claude/claude-opus-5-5 is not evidence of what ran)",
      );
      expect(
        readVerdictOnce({ checkout: box.cwd, executionRunId: "run-1" }),
      ).toMatchObject({ ok: false, missing: true });
    }
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
    expect(
      readVerdictOnce({ checkout: box.cwd, executionRunId: "run-1" }),
    ).toMatchObject({ ok: false, missing: true });

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

describe("forge:verdict, what it refuses", () => {
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

    // The environment pointer works like the flag.
    const viaEnv = runVerdictWrite([...PASS, ...AS_REVIEWER], {
      ...deps(box),
      env: { AGENT_FORGE_RUN_CORRELATION: box.pointer },
    });
    expect(viaEnv.code).toBe(0);
  });

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
        "attestations.vibes is not a known dimension (quality|reliability|creativity|maintainability|ux)",
      ],
      [
        [...PASS, ...AS_REVIEWER, "--attest", "quality"],
        "--attest takes <dimension>=<0..5>",
      ],
    ];
    for (const [argv, error] of cases) {
      const wrote = write(box, argv);
      expect(wrote.code).toBe(2);
      expect(wrote.body.error).toBe(error);
    }
    expect(
      readVerdictOnce({ checkout: box.cwd, executionRunId: "run-1" }),
    ).toMatchObject({ ok: false, missing: true });
  });
});

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

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(CLAUDE_|AGENT_FORGE_|FORGE_)/.test(key)) continue;
      env[key] = value;
    }
    env.AGENT_FORGE_HOME = box.home;
    env.HOME = join(box.root, "user home");
    env.USERPROFILE = env.HOME;
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
});
