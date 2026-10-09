import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEvent } from "../../types/hearth";
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
): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(["bun", "run", script, ...args], {
    cwd: box.cwd,
    env: childEnv(box.home, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
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
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      verdictFile(box, "v.json", "PASS", 0),
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

  test("a verdict file recorded by forge:review produces one verdict.bound for the run", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    await run(box, PHASE_GATE, [
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
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      verdictFile(box, "v.json", "PASS", 0, `looks right; key ${SECRET} seen`),
    ]);
    expect(reviewed.exitCode).toBe(0);

    const bound = runEvents(box, "x").filter((e) => e.kind === "verdict.bound");
    expect(bound).toHaveLength(1);
    const [event] = bound;
    expect(event?.runId).toBe("x");
    expect(event?.beadId).toBe("b-1");
    expect(event?.executor).toEqual({ provider: "claude", model: "m-1" });
    // The verdict file names no evaluator, so none is stored; the builder is
    // the executor the run recorded.
    expect(event?.payload).toEqual({
      verdict: "pass",
      builder: { provider: "claude", model: "m-1" },
      summary: "looks right; key [REDACTED:anthropic-api-key] seen",
    });
    expect(JSON.stringify(runEvents(box, "x"))).not.toContain(SECRET);
    // It is recorded before the round's decision.
    expect(
      runEvents(box, "x")
        .map((e) => e.kind)
        .slice(-2),
    ).toEqual(["verdict.bound", "review.recorded"]);
  }, 60_000);

  test("a schema 2 verdict recorded by forge:review stores its evaluator", async () => {
    const box = sandbox();
    writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
    await run(box, PHASE_GATE, [
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
    const file = join(box.cwd, "v2.json");
    writeFileSync(file, v2Json({ summary: "second opinion" }));
    const reviewed = await run(box, REVIEW, [
      "--slug",
      "x",
      "--phase",
      "research",
      "--verdict",
      file,
    ]);
    expect(reviewed.exitCode).toBe(0);
    expect(JSON.parse(reviewed.stdout).data.verdictError).toBeUndefined();

    const bound = runEvents(box, "x").filter((e) => e.kind === "verdict.bound");
    expect(bound).toHaveLength(1);
    expect(bound[0]?.beadId).toBe("b-1");
    expect<unknown>(bound[0]?.payload).toEqual({
      verdict: "pass",
      builder: { provider: "claude", model: "m-1" },
      evaluator: { provider: "claude", model: "claude-sonnet-5-5" },
      evaluatorIdentity: MODEL_EVALUATOR,
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
      const box = sandbox();
      writeFileSync(join(box.cwd, "plans", "research", "x.md"), "x");
      await run(box, PHASE_GATE, [
        "research",
        "--slug",
        "x",
        "--write",
        "--mode",
        "auto",
        "--bead",
        "b-1",
      ]);
      const file = join(box.cwd, "foreign.json");
      writeFileSync(file, v2Json(overrides));
      const reviewed = await run(box, REVIEW, [
        "--slug",
        "x",
        "--phase",
        "research",
        "--verdict",
        file,
      ]);
      expect(reviewed.exitCode).toBe(2);
      const data = JSON.parse(reviewed.stdout).data;
      expect(data.verdictError).toBe(error);
      expect(data.round.verdict).toBe("UNREADABLE");

      const bound = runEvents(box, "x").filter(
        (e) => e.kind === "verdict.bound",
      );
      expect(bound.map((event) => event.payload)).toEqual([
        { verdict: "unreadable" },
      ]);
      closeLedger();
    }
  }, 120_000);

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
