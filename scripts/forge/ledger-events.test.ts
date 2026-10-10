import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { LedgerEvent, LedgerEventOf } from "../../types/hearth";
import { type EvalVerdictParsed, parseEvalVerdictJson } from "../eval-verdict";
import { closeLedger } from "../ledger/db";
import type { Attach } from "../ledger/identity";
import { queryEvents } from "../ledger/query";
import {
  emitPhaseEntered,
  emitRunEvent,
  executorToPersist,
  phaseCompleted,
  reviewRecorded,
  verdictBound,
  withLiveSession,
} from "./ledger-events";
import { parseState } from "./runs";

const temporary: string[] = [];

interface Box {
  cwd: string;
  home: string;
  path: string;
}

/** A scratch checkout and a ledger home, both under a path with a space. */
function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "ledger test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  const home = join(root, "forge home");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(join(cwd, "plans", "research"), { recursive: true });
  mkdirSync(join(cwd, "plans", "drafts"), { recursive: true });
  return { cwd, home, path: join(home, "ledger.db") };
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const PHASE_GATE = join(import.meta.dir, "phase-gate.ts");
const REVIEW = join(import.meta.dir, "auto-loop-cli.ts");
const RUNS = join(import.meta.dir, "runs-cli.ts");
const AUDIT = join(import.meta.dir, "..", "ledger", "audit-cli.ts");
const CORRELATE = join(import.meta.dir, "..", "run-correlation-cli.ts");
const VERDICT = join(import.meta.dir, "..", "eval-verdict-cli.ts");
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";

/** The parent's environment minus anything that names a live session, run or ledger. */
function childEnv(
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE_|AGENT_FORGE_|FORGE_)/.test(key)) continue;
    env[key] = value;
  }
  env.AGENT_FORGE_HOME = home;
  return { ...env, ...extra };
}

async function run(
  box: Box,
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", script, ...args], {
    cwd: box.cwd,
    env: childEnv(box.home, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

function verdictFile(
  box: Box,
  name: string,
  verdict: "PASS" | "FAIL",
  high: number,
  summary?: string,
): string {
  const path = join(box.cwd, name);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      taskId: "t",
      verdict,
      findings: { blocker: 0, high, medium: 0, low: 0 },
      ...(summary !== undefined ? { summary } : {}),
    }),
  );
  return path;
}

function runEvents(box: Box, runId: string): LedgerEvent[] {
  return queryEvents({ runId }, { path: box.path });
}

const MODEL_EVALUATOR = {
  kind: "model",
  requestedProvider: "claude",
  requestedModel: "claude-opus-5-5",
  requestedRank: "master",
  observedProvider: "claude",
  observedModel: "claude-sonnet-5-5",
  providerEvidence: "selected-direct-transport",
  modelEvidence: "response-field",
  rankPolicyDecision: "allowed",
  rankPolicyRule: "evaluator-at-or-above-builder",
} as const;

/** A schema 2 verdict's JSON for run `x` and bead `b-1`, unless overridden. */
function v2Json(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    beadsIssueId: "b-1",
    executionRunId: "x",
    verdict: "PASS",
    findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    evaluator: MODEL_EVALUATOR,
    ...overrides,
  });
}

function parsedVerdict(json: string): EvalVerdictParsed {
  const parsed = parseEvalVerdictJson(json);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("verdictBound", () => {
  test("a schema 2 model verdict fills the evaluator from what was observed and keeps the typed identity", () => {
    expect<unknown>(
      verdictBound({ verdict: parsedVerdict(v2Json()) }).payload,
    ).toEqual({
      verdict: "pass",
      evaluator: { provider: "claude", model: "claude-sonnet-5-5" },
      evaluatorIdentity: MODEL_EVALUATOR,
    });
  });

  test("a model verdict with nothing observed has no evaluator executor: the request is not used", () => {
    const {
      observedProvider: _provider,
      observedModel: _model,
      providerEvidence: _providerEvidence,
      modelEvidence: _modelEvidence,
      ...requestedOnly
    } = MODEL_EVALUATOR;
    const { payload } = verdictBound({
      verdict: parsedVerdict(v2Json({ evaluator: requestedOnly })),
    });
    expect("evaluator" in payload).toBe(false);
    expect<unknown>(payload.evaluatorIdentity).toEqual(requestedOnly);
  });

  test("a human verdict has a typed identity and no evaluator executor", () => {
    expect<unknown>(
      verdictBound({
        verdict: parsedVerdict(
          v2Json({ evaluator: { kind: "human", actorKind: "reviewer" } }),
        ),
      }).payload,
    ).toEqual({
      verdict: "pass",
      evaluatorIdentity: { kind: "human", actorKind: "reviewer" },
    });
  });

  test("a legacy verdict yields no evaluator of either kind", () => {
    expect(
      verdictBound({
        verdict: parsedVerdict(
          JSON.stringify({
            schemaVersion: 1,
            taskId: "b-1",
            verdict: "FAIL",
            findings: { blocker: 0, high: 1, medium: 0, low: 0 },
          }),
        ),
        builder: { provider: "claude", model: "m-1" },
      }).payload,
    ).toEqual({
      verdict: "fail",
      builder: { provider: "claude", model: "m-1" },
    });
  });
});

describe("the Forge CLIs write run events to the ledger (spawned scripts, scratch ledger)", () => {
  test("a phase-gate write and a review round appear in order under the run", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    const wrote = await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--bead",
      "b-1",
      "--provider",
      "claude",
      "--model",
      "m-1",
    ]);
    expect(wrote.exitCode).toBe(0);
    // The run named its bead, so it is correlated: its verdict is schema 2.
    const verdict = join(box.cwd, "v.json");
    writeFileSync(verdict, v2Json());
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      verdict,
    ]);
    expect(reviewed.exitCode).toBe(0);

    const events = queryEvents(
      { runId: "x", kinds: ["run.phase.completed", "review.recorded"] },
      { path: box.path },
    );
    expect(events.map((e) => e.kind)).toEqual([
      "run.phase.completed",
      "review.recorded",
    ]);
    for (const event of events) {
      expect(event.beadId).toBe("b-1");
      expect(event.executor?.provider).toBe("claude");
      expect(event.executor?.model).toBe("m-1");
      // No live session in the scrubbed environment: nothing is invented.
      expect(event.sessionId).toBeUndefined();
    }
    const [completed, review] = events;
    expect(completed?.payload).toEqual({
      phase: "research",
      artifact: "plans/research/x.md",
    });
    expect(review?.payload).toMatchObject({
      phase: "research",
      round: 1,
      verdict: "PASS",
      action: "advance",
    });

    // The same history through the real query CLI, as `forge:audit --run` runs it.
    closeLedger();
    const audit = await run(box, AUDIT, ["--run", "x", "--json"]);
    expect(audit.exitCode).toBe(0);
    const listed = JSON.parse(audit.stdout) as {
      ok: boolean;
      data: LedgerEvent[];
    };
    expect(listed.ok).toBe(true);
    expect(listed.data.map((e) => e.kind)).toEqual([
      "run.phase.completed",
      "verdict.bound",
      "review.recorded",
    ]);
    expect(listed.data.every((e) => e.runId === "x")).toBe(true);

    // The run file kept the executor and bead it was given.
    const state = parseState(
      readFileSync(
        join(box.cwd, ".tmp", "work", "forge-runs", "x.json"),
        "utf8",
      ),
    );
    expect(state?.schemaVersion).toBe(2);
    expect(state?.beadId).toBe("b-1");
    expect(state?.executor).toEqual({ provider: "claude", model: "m-1" });
    expect(state?.reviews?.[0]?.action).toBe("advance");
  }, 60_000);

  test("a halting review is stored as a halt, exits 2, and the next phase is refused", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
    ]);
    // One failing round with no revision budget: a halt the default budget
    // would have called a revision.
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      verdictFile(box, "v.json", "FAIL", 1),
      "--max-revisions",
      "0",
    ]);
    expect(reviewed.exitCode).toBe(2);

    const review = runEvents(box, "x").find(
      (e) => e.kind === "review.recorded",
    );
    expect(review?.payload).toMatchObject({ verdict: "FAIL", action: "halt" });

    const state = parseState(
      readFileSync(
        join(box.cwd, ".tmp", "work", "forge-runs", "x.json"),
        "utf8",
      ),
    );
    const latest = state?.reviews?.[state.reviews.length - 1];
    expect(latest?.action).toBe("halt");
    expect(latest?.reason).toContain("0 revision rounds");

    closeLedger();
    const enter = await run(box, PHASE_GATE, ["plan", "--slug", "x"]);
    expect(enter.exitCode).toBe(2);
    const refused = JSON.parse(enter.stdout) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('"research" is halted');

    const table = await run(box, RUNS, []);
    expect(table.stdout).toContain("next: halted in research");
    expect(table.stdout).not.toContain("/forge-plan");

    // The refused entry check recorded nothing.
    expect(
      runEvents(box, "x").filter((e) => e.kind === "run.phase.entered"),
    ).toEqual([]);
  }, 60_000);

  test("a schema 1 verdict recorded by forge:review for an uncorrelated run produces one verdict.bound, labelled legacy", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--epic",
      "b-1",
      "--provider",
      "claude",
      "--model",
      "m-1",
    ]);
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      verdictFile(box, "v.json", "PASS", 0, `looks right; key ${SECRET} seen`),
    ]);
    expect(reviewed.exitCode).toBe(0);
    // The command says the verdict it took was a legacy one.
    const printed = JSON.parse(reviewed.stdout).data;
    expect(printed.verdictSchemaVersion).toBe(1);
    expect(printed.comment).toEndWith("(research round 1; legacy verdict)");
    // And so does the round stored on the run.
    expect(printed.round).toMatchObject({ verdictSchemaVersion: 1 });
    const ledgerOfRounds = await run(box, REVIEW, ["--slug", "x", "--ledger"]);
    expect(JSON.parse(ledgerOfRounds.stdout).data).toMatchObject([
      { verdict: "PASS", verdictSchemaVersion: 1 },
    ]);

    const bound = runEvents(box, "x").filter((e) => e.kind === "verdict.bound");
    expect(bound).toHaveLength(1);
    const [event] = bound;
    expect(event?.runId).toBe("x");
    expect(event?.beadId).toBe("b-1");
    expect(event?.executor).toEqual({ provider: "claude", model: "m-1" });
    // The verdict file names no evaluator, so none is stored; the builder is
    // the executor the run recorded. The file reference says it was schema 1.
    expect(event?.payload).toMatchObject({
      verdict: "pass",
      builder: { provider: "claude", model: "m-1" },
      verdictArtifact: { path: "v.json", schemaVersion: 1 },
      summary: "looks right; key [REDACTED:anthropic-api-key] seen",
    });
    expect("evaluator" in (event?.payload ?? {})).toBe(false);
    expect("evaluatorIdentity" in (event?.payload ?? {})).toBe(false);
    expect(JSON.stringify(runEvents(box, "x"))).not.toContain(SECRET);
    // It is recorded before the round's decision.
    expect(
      runEvents(box, "x")
        .map((e) => e.kind)
        .slice(-2),
    ).toEqual(["verdict.bound", "review.recorded"]);
  }, 60_000);

  /** A run `x` whose phase gate named bead `b-1`, which is what correlates it. */
  async function correlatedRun(extra: string[] = []): Promise<Box> {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    const written = await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--bead",
      "b-1",
      ...extra,
    ]);
    expect(JSON.parse(written.stdout).data.correlation).toMatchObject({
      beadsIssueId: "b-1",
      executionRunId: "x",
    });
    return box;
  }

  async function review(
    box: Box,
    json: string,
    env: Record<string, string> = {},
  ): Promise<{
    exitCode: number;
    data: Record<string, unknown>;
    /** The verdict file's name, which is its path relative to the checkout. */
    file: string;
    stderr: string;
  }> {
    const name = `verdict-${Math.random().toString(36).slice(2)}.json`;
    const file = join(box.cwd, name);
    writeFileSync(file, json);
    const reviewed = await run(
      box,
      REVIEW,
      ["--slug", "x", "--phase", "research", "--verdict", file],
      { ...scratchHome(box), ...env },
    );
    return {
      exitCode: reviewed.exitCode,
      data: JSON.parse(reviewed.stdout).data,
      file: name,
      stderr: reviewed.stderr,
    };
  }

  /** A user home of the test's own: the developer's smith config is not read. */
  function scratchHome(box: Box): Record<string, string> {
    const home = join(dirname(box.cwd), "user home");
    mkdirSync(home, { recursive: true });
    return { HOME: home, USERPROFILE: home };
  }

  function boundRows(box: Box): LedgerEventOf<"verdict.bound">[] {
    return queryEvents({ kinds: ["verdict.bound"] }, { path: box.path }).filter(
      (event) => event.kind === "verdict.bound",
    );
  }

  test("a schema 2 verdict recorded by forge:review stores its evaluator", async () => {
    const box = await correlatedRun(["--provider", "claude", "--model", "m-1"]);
    const json = v2Json({ summary: "second opinion" });
    const reviewed = await review(box, json);
    expect(reviewed.exitCode).toBe(0);
    expect(reviewed.data.verdictError).toBeUndefined();
    expect(reviewed.data.verdictSchemaVersion).toBe(2);

    const bound = boundRows(box);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.beadId).toBe("b-1");
    expect(bound[0]?.runId).toBe("x");
    expect<unknown>(bound[0]?.payload).toEqual({
      verdict: "pass",
      builder: { provider: "claude", model: "m-1" },
      evaluator: { provider: "claude", model: "claude-sonnet-5-5" },
      evaluatorIdentity: MODEL_EVALUATOR,
      // The file as it was read, once: its path in the checkout and its bytes' digest.
      verdictArtifact: {
        path: reviewed.file,
        sha256: createHash("sha256").update(json).digest("hex"),
        bytes: Buffer.byteLength(json),
        schemaVersion: 2,
      },
      summary: "second opinion",
    });
  }, 60_000);

  test("a schema 2 verdict for another run, or another bead, is recorded as unreadable and halts", async () => {
    for (const [overrides, error] of [
      [
        { executionRunId: "y" },
        'verdict executionRunId "y" is not this run ("x")',
      ],
      [
        { beadsIssueId: "b-9" },
        'verdict beadsIssueId "b-9" is not this run\'s bead ("b-1")',
      ],
    ] as const) {
      const box = await correlatedRun();
      const reviewed = await review(box, v2Json(overrides));
      expect(reviewed.exitCode).toBe(2);
      expect(reviewed.data.verdictError).toBe(error);
      expect(reviewed.data.round).toMatchObject({ verdict: "UNREADABLE" });
      expect(boundRows(box).map((event) => event.payload)).toEqual([
        { verdict: "unreadable" },
      ]);
      closeLedger();
    }
  }, 120_000);

  test("the bead a schema 2 verdict must name is the run correlation's, not the run state's", async () => {
    const box = await correlatedRun();
    // The run is rebound to a narrower issue; its state still says b-1.
    const rebound = await run(box, CORRELATE, ["--bead", "b-2", "--run", "x"]);
    expect(rebound.exitCode).toBe(0);

    const stale = await review(box, v2Json({ beadsIssueId: "b-1" }));
    expect(stale.exitCode).toBe(2);
    expect(stale.data.verdictError).toBe(
      'verdict beadsIssueId "b-1" is not this run\'s bead ("b-2")',
    );

    const current = await review(box, v2Json({ beadsIssueId: "b-2" }));
    expect(current.data.verdictError).toBeUndefined();
    expect(current.data.round).toMatchObject({ verdict: "PASS" });
    // Filed under the bead the verdict names, which is the correlation's.
    expect(boundRows(box).map((event) => event.beadId)).toEqual(["b-1", "b-2"]);
    expect(boundRows(box).map((event) => event.payload.verdict)).toEqual([
      "unreadable",
      "pass",
    ]);
    // The decision about a round is filed where its verdict is.
    expect(
      queryEvents({ kinds: ["review.recorded"] }, { path: box.path }).map(
        (event) => event.beadId,
      ),
    ).toEqual(["b-1", "b-2"]);
    expect(current.data.round).toMatchObject({ verdictSchemaVersion: 2 });
    expect("verdictSchemaVersion" in (stale.data.round as object)).toBe(false);
  }, 120_000);

  test("a run correlation that exists and does not validate refuses every verdict, schema 1 included", async () => {
    const box = await correlatedRun();
    writeFileSync(
      join(box.cwd, ".tmp", "work", "run-correlations", "x.json"),
      "{ not json",
    );
    const error =
      'run "x" has a run correlation that cannot be used (not valid JSON), so no verdict can be checked against it';
    const current = await review(box, v2Json());
    expect(current.exitCode).toBe(2);
    expect(current.data.verdictError).toBe(error);
    const legacy = await review(
      box,
      JSON.stringify({
        schemaVersion: 1,
        taskId: "b-1",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(legacy.exitCode).toBe(2);
    expect(legacy.data.verdictError).toBe(error);

    // The same from a run whose state names a directory inside the checkout,
    // not its top level: the correlation is looked for where the loader looks.
    const statePath = join(box.cwd, ".tmp", "work", "forge-runs", "x.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const nested = join(box.cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(statePath, JSON.stringify({ ...state, checkout: nested }));
    const fromNested = await review(
      box,
      JSON.stringify({
        schemaVersion: 1,
        taskId: "b-1",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(fromNested.exitCode).toBe(2);
    expect(fromNested.data.verdictError).toBe(error);
  }, 120_000);

  test("the correlation is the one in the checkout the run builds in, not the directory forge:review runs in", async () => {
    const box = sandbox();
    const building = join(dirname(box.cwd), "build tree");
    mkdirSync(join(building, ".git"), { recursive: true });
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    const written = await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--bead",
      "b-1",
      "--checkout",
      building,
    ]);
    expect(JSON.parse(written.stdout).data.correlation).toMatchObject({
      beadsIssueId: "b-1",
    });
    // Nothing correlates the run in the directory the command runs in.
    expect(
      existsSync(join(box.cwd, ".tmp", "work", "run-correlations", "x.json")),
    ).toBe(false);

    const reviewed = await review(box, v2Json());
    expect(reviewed.exitCode).toBe(0);
    expect(reviewed.data.verdictError).toBeUndefined();
    expect(boundRows(box).map((event) => event.beadId)).toEqual(["b-1"]);
  }, 60_000);

  test("a schema 2 verdict's event is filed under the verdict's bead, whatever the environment names", async () => {
    const box = await correlatedRun();
    const reviewed = await review(box, v2Json(), {
      AGENT_FORGE_BEAD_ID: "b-env",
    });
    expect(reviewed.exitCode).toBe(0);
    const [event] = boundRows(box);
    expect(event?.beadId).toBe("b-1");
    expect(event?.runId).toBe("x");
  }, 60_000);

  test("a run with no correlation cannot take a schema 2 verdict: there is nothing to check its ids against", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--epic",
      "e-1",
    ]);
    const reviewed = await review(box, v2Json({ beadsIssueId: "b-999" }));
    expect(reviewed.exitCode).toBe(2);
    expect(reviewed.data.verdictError).toBe(
      'run "x" has no run correlation, so a schema 2 verdict cannot be checked against it (bun run forge:correlate --bead <id> --run x)',
    );
    expect(boundRows(box).map((event) => event.payload)).toEqual([
      { verdict: "unreadable" },
    ]);
  }, 60_000);

  test("a correlated run refuses a schema 1 verdict: it names no run", async () => {
    const box = await correlatedRun();
    const reviewed = await review(
      box,
      JSON.stringify({
        schemaVersion: 1,
        taskId: "some-other-bead",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(reviewed.exitCode).toBe(2);
    expect(reviewed.data.verdictError).toBe(
      'run "x" is correlated to b-1, so its verdict must be schema 2; the verdict is schema 1 (legacy): it names no run and no evaluator',
    );
    expect(boundRows(box).map((event) => event.payload)).toEqual([
      { verdict: "unreadable" },
    ]);
  }, 60_000);

  test("forge:review says when the evaluator would not satisfy strict completion, and still records the round", async () => {
    const box = await correlatedRun([
      "--provider",
      "claude",
      "--model",
      "claude-opus-5-5",
    ]);
    const hermetic = scratchHome(box);
    const weaker = await review(
      box,
      v2Json({
        evaluator: {
          ...MODEL_EVALUATOR,
          observedModel: "claude-haiku-4-5-20251001",
        },
      }),
      hermetic,
    );
    expect(weaker.exitCode).toBe(0);
    expect(weaker.stderr).not.toContain("smith config not readable");
    expect(weaker.data.evaluatorProblem).toBe(
      "observed evaluator claude/claude-haiku-4-5-20251001 (rank apprentice) is below the builder's rank (master)",
    );
    expect(weaker.data.round).toMatchObject({ verdict: "PASS" });

    const human = await review(
      box,
      v2Json({ evaluator: { kind: "human", actorKind: "operator" } }),
      hermetic,
    );
    expect("evaluatorProblem" in human.data).toBe(false);

    // A smith config that cannot be loaded ranks nobody, and the command says
    // why on stderr instead of only reporting "no rank".
    writeFileSync(join(box.cwd, "agent-forge.toml"), "[smiths.broken\n");
    const unranked = await review(box, v2Json(), hermetic);
    expect(unranked.data.evaluatorProblem).toBe(
      "observed evaluator claude/claude-sonnet-5-5 has no rank: no configured smith with a rank:* tag uses that provider and model",
    );
    expect(unranked.stderr).toContain(
      "forge:review: smith config not readable, so no evaluator has a rank:",
    );
  }, 180_000);

  /**
   * Run the verdict writer as the documents have the Evaluator run it, as a
   * model evaluator, and return what it printed. No session works in the
   * scratch checkout, so nothing is observed: the round is written with the
   * request alone.
   */
  async function fileRoundVerdict(
    box: Box,
    args: string[],
  ): Promise<{
    exitCode: number;
    data: Record<string, unknown> | null;
    error: string | null;
  }> {
    const wrote = await run(
      box,
      VERDICT,
      [
        "--verdict",
        "PASS",
        "--requested-provider",
        "claude",
        "--requested-model",
        "claude-opus-5-5",
        "--requested-rank",
        "master",
        "--review",
        "research-1",
        ...args,
      ],
      scratchHome(box),
    );
    const printed = JSON.parse(wrote.stdout);
    return {
      exitCode: wrote.exitCode,
      data: printed.data,
      error: printed.error,
    };
  }

  test("the unattended review step's commands, in one checkout: the phase gate's pointer, forge:verdict as a model Evaluator, then forge:review with the file it printed", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    const gate = await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--bead",
      "b-1",
    ]);
    const pointer = JSON.parse(gate.stdout).data.correlation.pointer as string;

    const wrote = await fileRoundVerdict(box, ["--correlation", pointer]);
    expect(wrote.exitCode).toBe(0);
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      String(wrote.data?.file),
    ]);
    expect(reviewed.exitCode).toBe(0);
    const outcome = JSON.parse(reviewed.stdout).data;
    expect(outcome.round).toMatchObject({
      verdict: "PASS",
      verdictSchemaVersion: 2,
    });
    // Nothing was observed of the evaluator: the writer said so, forge:review
    // says a strict gate would object, and the round still advances.
    expect(wrote.data?.unobserved).toBe(
      "no session is recorded as working in the worktree this command runs in (no session mirror there, or one older than a day)",
    );
    expect(outcome.evaluatorProblem).toBe(
      "the verdict records no observed evaluator provider and model (requested claude/claude-opus-5-5 is not evidence of what ran)",
    );
    expect(outcome.decision).toMatchObject({ action: "advance" });
    const [bound] = boundRows(box);
    expect(bound?.payload).toMatchObject({
      verdict: "pass",
      evaluatorIdentity: {
        kind: "model",
        requestedModel: "claude-opus-5-5",
        rankPolicyDecision: "rejected",
      },
      verdictArtifact: { path: wrote.data?.path, sha256: wrote.data?.sha256 },
    });
    expect("evaluator" in (bound?.payload ?? {})).toBe(false);
  }, 120_000);

  test("the same commands when the run builds in another checkout: --checkout on the writer, and the full path it prints", async () => {
    const box = sandbox();
    const building = join(dirname(box.cwd), "build tree");
    mkdirSync(join(building, ".git"), { recursive: true });
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    const gate = await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--bead",
      "b-1",
      "--checkout",
      building,
    ]);
    const pointer = JSON.parse(gate.stdout).data.correlation.pointer as string;

    // The pointer is relative to the checkout the run builds in: without
    // --checkout the writer looks where it runs, and says what it did not find.
    const lost = await fileRoundVerdict(box, ["--correlation", pointer]);
    expect(lost.exitCode).toBe(2);
    expect(lost.error).toBe(
      "run correlation refused: the pointer names no readable file",
    );

    const wrote = await fileRoundVerdict(box, [
      "--correlation",
      pointer,
      "--checkout",
      building,
    ]);
    expect(wrote.exitCode).toBe(0);
    expect(existsSync(String(wrote.data?.file))).toBe(true);
    expect(existsSync(join(building, String(wrote.data?.path)))).toBe(true);

    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      String(wrote.data?.file),
    ]);
    expect(reviewed.exitCode).toBe(0);
    expect(JSON.parse(reviewed.stdout).data.verdictError).toBeUndefined();
  }, 120_000);

  test("a run that named no bead: forge:review's hint is a command that works for the checkout the run builds in", async () => {
    const box = sandbox();
    const building = join(dirname(box.cwd), "build tree");
    mkdirSync(join(building, ".git"), { recursive: true });
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--mode",
      "auto",
      "--checkout",
      building,
    ]);
    const before = await review(box, v2Json());
    const hint = String(before.data.verdictError);
    expect(hint).toStartWith(
      'run "x" has no run correlation, so a schema 2 verdict cannot be checked against it (bun run forge:correlate --bead <id> --run x --checkout ',
    );

    // The hinted command, with the bead filled in.
    const correlated = await run(box, CORRELATE, [
      "--bead",
      "b-1",
      "--run",
      "x",
      "--checkout",
      building,
    ]);
    const pointer = JSON.parse(correlated.stdout).data.correlation
      .pointer as string;
    const wrote = await fileRoundVerdict(box, [
      "--correlation",
      pointer,
      "--checkout",
      building,
      "--review",
      "research-2",
    ]);
    // --review was given twice (the helper's and this one): refused, not guessed.
    expect(wrote.error).toBe("--review was given more than once");
    const filed = await run(
      box,
      VERDICT,
      [
        "--verdict",
        "PASS",
        "--requested-provider",
        "claude",
        "--requested-model",
        "claude-opus-5-5",
        "--requested-rank",
        "master",
        "--review",
        "research-2",
        "--correlation",
        pointer,
        "--checkout",
        building,
      ],
      scratchHome(box),
    );
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      String(JSON.parse(filed.stdout).data.file),
    ]);
    expect(JSON.parse(reviewed.stdout).data.verdictError).toBeUndefined();
    expect(JSON.parse(reviewed.stdout).data.round).toMatchObject({
      verdict: "PASS",
    });
  }, 180_000);

  test("a verdict file over the size a verdict has is refused without being taken in", async () => {
    const box = await correlatedRun();
    const reviewed = await review(
      box,
      v2Json({ summary: "x".repeat(70 * 1024) }),
    );
    expect(reviewed.exitCode).toBe(2);
    expect(String(reviewed.data.verdictError)).toEndWith(
      "is larger than 65536 bytes",
    );
    expect(boundRows(box).map((event) => event.payload)).toEqual([
      { verdict: "unreadable" },
    ]);
  }, 60_000);

  test("an unreadable verdict file is bound as unreadable", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    await run(box, PHASE_GATE, ["research", "--slug", "x", "--write"]);
    const broken = join(box.cwd, "broken.json");
    writeFileSync(broken, "{ not json");
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      broken,
    ]);
    expect(reviewed.exitCode).toBe(2);

    const bound = runEvents(box, "x").filter((e) => e.kind === "verdict.bound");
    expect(bound).toHaveLength(1);
    expect(bound[0]?.payload).toEqual({ verdict: "unreadable" });
    expect(bound[0]?.executor).toBeUndefined();
  }, 60_000);

  test("two enter-checks in a row record one run.phase.entered", async () => {
    const box = sandbox();
    expect(
      (await run(box, PHASE_GATE, ["research", "--slug", "x"])).exitCode,
    ).toBe(0);
    expect(
      (await run(box, PHASE_GATE, ["research", "--slug", "x"])).exitCode,
    ).toBe(0);
    const entered = runEvents(box, "x").filter(
      (e) => e.kind === "run.phase.entered",
    );
    expect(entered).toHaveLength(1);
    expect(entered[0]?.payload).toEqual({ phase: "research" });
  }, 60_000);

  test("a different FORGE_SLUG in the environment does not move a run's events", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    const wrote = await run(
      box,
      PHASE_GATE,
      ["research", "--slug", "x", "--write"],
      { FORGE_SLUG: "y" },
    );
    expect(wrote.exitCode).toBe(0);
    expect(runEvents(box, "x").map((e) => e.kind)).toEqual([
      "run.phase.completed",
    ]);
    expect(runEvents(box, "y")).toEqual([]);
  }, 60_000);

  test("--provider without --model is refused and nothing is written", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    const wrote = await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "x",
      "--write",
      "--provider",
      "claude",
    ]);
    expect(wrote.exitCode).toBe(2);
    expect((JSON.parse(wrote.stdout) as { ok: boolean }).ok).toBe(false);
    const listed = await run(box, RUNS, ["--json"]);
    expect((JSON.parse(listed.stdout) as { data: unknown[] }).data).toEqual([]);
  }, 60_000);
});

describe("run event helpers (in-process, scratch ledger)", () => {
  const attach = (extra: Partial<Attach> = {}): Attach => ({
    workspace: "c:/work/repo",
    worktree: "c:/work/repo",
    runId: "x",
    ...extra,
  });

  test("an entered event is appended again once the phase has completed in between", () => {
    const box = sandbox();
    const opts = { path: box.path };
    expect(emitPhaseEntered(attach(), "plan", opts)?.ok).toBe(true);
    expect(emitPhaseEntered(attach(), "plan", opts)).toBeNull();
    emitRunEvent(attach(), phaseCompleted("plan"), opts);
    expect(emitPhaseEntered(attach(), "plan", opts)?.ok).toBe(true);
    expect(runEvents(box, "x").map((e) => e.kind)).toEqual([
      "run.phase.entered",
      "run.phase.completed",
      "run.phase.entered",
    ]);
  });

  test("a review event carries the counts and the decision but not the summary text", () => {
    const box = sandbox();
    emitRunEvent(
      attach({ beadId: "b-1" }),
      reviewRecorded(
        {
          phase: "plan",
          round: 2,
          verdict: "FAIL",
          findings: { blocker: 1, high: 2, medium: 3, low: 4 },
          summary: "the evaluator's prose",
          reason: "why it halted",
          at: "2026-06-04T00:00:00.000Z",
        },
        "halt",
      ),
      { path: box.path },
    );
    const [event] = runEvents(box, "x");
    expect(event?.payload).toEqual({
      phase: "plan",
      round: 2,
      verdict: "FAIL",
      findings: { blocker: 1, high: 2, medium: 3, low: 4 },
      action: "halt",
    });
    expect(JSON.stringify(event)).not.toContain("prose");
  });

  test("an unwritable ledger is reported, not thrown", () => {
    const box = sandbox();
    const blocker = join(box.cwd, "a file");
    writeFileSync(blocker, "x");
    const result = emitRunEvent(attach(), phaseCompleted("plan"), {
      path: join(blocker, "ledger.db"),
    });
    expect(result.ok).toBe(false);
  });

  test("the executor to store is the flagged one, else the live session's, else the stored one", () => {
    const flagged = { provider: "claude", model: "m-flag" };
    const stored = { provider: "claude", model: "m-old", sessionId: "s-old" };
    const live = { provider: "claude", model: "m-live", sessionId: "s-1" };

    expect(executorToPersist(attach(), flagged, stored)).toEqual(flagged);
    expect(
      executorToPersist(attach({ sessionId: "s-1" }), flagged, stored),
    ).toEqual({ ...flagged, sessionId: "s-1" });
    expect(
      executorToPersist(
        attach({ sessionId: "s-1", executor: live }),
        undefined,
        stored,
      ),
    ).toEqual(live);
    // The resolver fell back to the stored executor (no session id on it):
    // the stored one is kept as it was.
    expect(
      executorToPersist(
        attach({ executor: { provider: "claude", model: "m-old" } }),
        undefined,
        stored,
      ),
    ).toEqual(stored);
    expect(executorToPersist(attach(), undefined, undefined)).toBeUndefined();
  });

  test("a review refreshes the stored executor's session only when a session is known", () => {
    const stored = { provider: "claude", model: "m-old", sessionId: "s-old" };
    expect(withLiveSession(stored, attach({ sessionId: "s-2" }))).toEqual({
      ...stored,
      sessionId: "s-2",
    });
    expect(withLiveSession(stored, attach())).toEqual(stored);
    expect(
      withLiveSession(undefined, attach({ sessionId: "s-2" })),
    ).toBeUndefined();
  });
});
