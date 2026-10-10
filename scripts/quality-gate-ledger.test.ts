/**
 * The ledger events the quality gate builds.
 *
 * These test the builders and the identity they resolve from seeded state.
 * The gate script itself is run by `quality-gate-hook.test.ts`, which reads
 * back the `gate.ran` it appends.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type EvalVerdict, parseEvalVerdictJson } from "./eval-verdict";
import type { ForgeState } from "./forge/phases";
import { validateLedgerEventInput } from "./hearth/validate";
import { appendEvent } from "./ledger/append";
import { closeLedger } from "./ledger/db";
import { type Attach, writeSessionMirror } from "./ledger/identity";
import { queryEvents } from "./ledger/query";
import { setSessionModel } from "./ledger/session-models";
import {
  gateAttach,
  gateRanEvent,
  strictVerdictEvent,
} from "./quality-gate-ledger";
import { createRunCorrelation, type RunCorrelation } from "./run-correlation";

const temporary: string[] = [];

/** A scratch checkout and a ledger file, both under a path with a space. */
function sandbox(): { cwd: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "gate ledger test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return { cwd, path: join(root, "forge home", "ledger.db") };
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const attach = (extra: Partial<Attach> = {}): Attach => ({
  workspace: "c:/work/repo",
  worktree: "c:/work/repo",
  ...extra,
});

const runState = (extra: Partial<ForgeState> = {}): ForgeState => ({
  slug: "x",
  feature: "x",
  phase: "implement",
  completed: ["research", "plan"],
  artifacts: {},
  updatedAt: "2026-06-04T00:00:00.000Z",
  ...extra,
});

function correlation(cwd: string): RunCorrelation {
  const made = createRunCorrelation({
    executionRunId: "x",
    beadsIssueId: "b-correlated",
    checkout: cwd,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

/** Everything that used to name a gate event's bead or run, all at once. */
const OLD_SOURCES = {
  AGENT_FORGE_BEAD_ID: "b-env",
  FORGE_SLUG: "env-run",
  CLAUDE_TASK_ID: "b-task",
};

describe("gateRanEvent", () => {
  test("a gate result becomes one gate.ran bound to its run, bead and executor", () => {
    const who = attach({
      beadId: "b-1",
      runId: "x",
      sessionId: "s-1",
      executor: { provider: "claude", model: "m-1", sessionId: "s-1" },
    });

    const passed = gateRanEvent({
      result: { passed: true },
      durationMs: 1234.6,
      trigger: "TaskCompleted",
      attach: who,
    });
    expect(passed).toEqual({
      kind: "gate.ran",
      workspace: "c:/work/repo",
      beadId: "b-1",
      runId: "x",
      sessionId: "s-1",
      executor: { provider: "claude", model: "m-1", sessionId: "s-1" },
      payload: {
        gate: "quality-gate",
        passed: true,
        durationMs: 1235,
        exitCode: 0,
        trigger: "TaskCompleted",
      },
    });
    expect(validateLedgerEventInput(passed).ok).toBe(true);

    const failed = gateRanEvent({
      result: { passed: false },
      durationMs: 10,
      attach: who,
    });
    expect(failed.payload).toEqual({
      gate: "quality-gate",
      passed: false,
      durationMs: 10,
      exitCode: 2,
    });
    expect(failed.runId).toBe("x");
    expect("trigger" in failed.payload).toBe(false);
    expect(validateLedgerEventInput(failed).ok).toBe(true);
  });

  test("a gate with no known run or bead still produces a valid event", () => {
    const event = gateRanEvent({
      result: { passed: true },
      durationMs: 5,
      attach: attach(),
    });
    for (const key of ["beadId", "runId", "sessionId", "executor"])
      expect(key in event).toBe(false);
    expect(validateLedgerEventInput(event).ok).toBe(true);
  });
});

/** A schema 2 verdict as the strict check hands it over: parsed from a file's bytes. */
function boundVerdict(overrides: Record<string, unknown> = {}): EvalVerdict {
  const parsed = parseEvalVerdictJson(
    JSON.stringify({
      schemaVersion: 2,
      beadsIssueId: "b-correlated",
      executionRunId: "x",
      verdict: "FAIL",
      findings: { blocker: 0, high: 0, medium: 2, low: 0 },
      summary: "two medium findings",
      evaluator: {
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
        sessionId: "s-eval",
      },
      ...overrides,
    }),
  );
  if (!parsed.ok || parsed.value.schemaVersion !== 2) {
    throw new Error("fixture is not a schema 2 verdict");
  }
  return parsed.value;
}

describe("strictVerdictEvent", () => {
  test("a strict-gate verdict is bound to the bead and run it names, with the evaluator it declares", () => {
    const event = strictVerdictEvent({
      verdict: boundVerdict(),
      builder: { provider: "claude", model: "m-build" },
      // Whatever the attach says, the event is filed under the verdict's ids.
      attach: attach({ beadId: "b-other", runId: "y", sessionId: "s-1" }),
    });
    expect<unknown>(event).toEqual({
      kind: "verdict.bound",
      workspace: "c:/work/repo",
      beadId: "b-correlated",
      runId: "x",
      sessionId: "s-1",
      payload: {
        verdict: "fail",
        builder: { provider: "claude", model: "m-build" },
        // What was observed to run, never what was requested.
        evaluator: {
          provider: "claude",
          model: "claude-sonnet-5-5",
          sessionId: "s-eval",
        },
        evaluatorIdentity: boundVerdict().evaluator,
        summary: "two medium findings",
      },
    });
    expect(validateLedgerEventInput(event).ok).toBe(true);
  });

  test("a file reference handed to the builder goes on the event and into the ledger, digest intact", () => {
    const box = sandbox();
    const artifact = {
      path: ".tmp/work/evaluations/abc/verdict.json",
      sha256: "0f".repeat(32),
      bytes: 312,
      schemaVersion: 2,
    };
    const event = strictVerdictEvent({
      verdict: boundVerdict(),
      artifact,
      attach: attach(),
    });
    expect(event.payload.verdictArtifact).toEqual(artifact);
    expect(validateLedgerEventInput(event).ok).toBe(true);
    expect(appendEvent(event, { path: box.path }).ok).toBe(true);
    const [stored] = queryEvents(
      { kinds: ["verdict.bound"] },
      { path: box.path },
    );
    // A digest is not a secret: it is stored whole.
    expect(stored?.payload).toMatchObject({ verdictArtifact: artifact });
  });

  test("a human verdict is stored with its actor kind and no evaluator executor", () => {
    const box = sandbox();
    const event = strictVerdictEvent({
      verdict: boundVerdict({
        verdict: "PASS",
        evaluator: { kind: "human", actorKind: "operator" },
      }),
      attach: attach({ beadId: "b-correlated", runId: "x" }),
    });
    expect("evaluator" in event.payload).toBe(false);
    expect(appendEvent(event, { path: box.path }).ok).toBe(true);

    const [stored] = queryEvents(
      { kinds: ["verdict.bound"] },
      { path: box.path },
    );
    expect(stored?.payload).toEqual({
      verdict: "pass",
      evaluatorIdentity: { kind: "human", actorKind: "operator" },
      summary: "two medium findings",
    });
  });

  test("the ledger keeps the typed evaluator of a model verdict, cut to the contract's fields", () => {
    const box = sandbox();
    const verdict = boundVerdict();
    const event = strictVerdictEvent({
      verdict,
      attach: attach({ beadId: "b-correlated", runId: "x" }),
    });
    // The identity's own fields without its session id, on an object whose
    // prototype has one: an inherited value must not be read as the verdict's.
    const { sessionId: _own, ...ownFields } = verdict.evaluator as {
      sessionId?: string;
    };
    const smuggled = {
      ...event,
      payload: {
        ...event.payload,
        evaluatorIdentity: Object.assign(
          Object.create({ sessionId: "from-a-prototype" }),
          ownFields,
          { prompt: "a body that is not metadata" },
        ),
      },
    };
    // justification: the extra key is the point of the test; the ledger must drop it.
    expect(appendEvent(smuggled as typeof event, { path: box.path }).ok).toBe(
      true,
    );

    const [stored] = queryEvents(
      { kinds: ["verdict.bound"] },
      { path: box.path },
    );
    expect(stored?.beadId).toBe("b-correlated");
    expect(stored?.runId).toBe("x");
    const withoutSession = ownFields;
    expect<unknown>(stored?.payload).toEqual({
      verdict: "fail",
      evaluator: {
        provider: "claude",
        model: "claude-sonnet-5-5",
        sessionId: "s-eval",
      },
      // Neither the extra key nor the inherited one is stored.
      evaluatorIdentity: withoutSession,
      summary: "two medium findings",
    });
  });

  test("an evaluator identity or a verdict artifact that is not the contract's shape is not stored at all", () => {
    const event = strictVerdictEvent({
      verdict: boundVerdict(),
      attach: attach(),
    });
    const good = {
      path: ".tmp/work/evaluations/x/verdict.json",
      sha256: "0f".repeat(32),
      bytes: 312,
      schemaVersion: 2,
    };
    // One thing wrong at a time, so each rule is what drops the value.
    const malformed: Array<Record<string, unknown>> = [
      { evaluatorIdentity: { kind: "banana", actorKind: 42 } },
      { evaluatorIdentity: { kind: "human" } },
      { evaluatorIdentity: "claude-opus-5-5" },
      { verdictArtifact: { ...good, sha256: "not-a-digest" } },
      { verdictArtifact: { ...good, sha256: "0F".repeat(32) } },
      { verdictArtifact: { ...good, bytes: "312" } },
      { verdictArtifact: { ...good, bytes: -1 } },
      { verdictArtifact: { ...good, path: "" } },
      { verdictArtifact: { ...good, schemaVersion: "2" } },
    ];
    for (const extra of malformed) {
      const box = sandbox();
      const candidate = { ...event, payload: { verdict: "pass", ...extra } };
      // justification: malformed on purpose; the ledger must not store it.
      expect(
        appendEvent(candidate as unknown as typeof event, { path: box.path })
          .ok,
      ).toBe(true);
      const [stored] = queryEvents(
        { kinds: ["verdict.bound"] },
        { path: box.path },
      );
      expect(stored?.payload).toEqual({ verdict: "pass" });
      closeLedger();
    }
  });
});

describe("gateAttach (the real resolver over seeded state, scratch ledger)", () => {
  test("a correlated gate takes its bead and run from the correlation, whatever the environment and the run state say", () => {
    const box = sandbox();
    const who = gateAttach({
      cwd: box.cwd,
      env: OLD_SOURCES,
      correlation: correlation(box.cwd),
      state: runState({ slug: "state-run", beadId: "b-run", epic: "epic-1" }),
      path: box.path,
    });
    expect(who.beadId).toBe("b-correlated");
    expect(who.runId).toBe("x");
  });

  test("an uncorrelated gate names no bead and no run, with every old source at hand", () => {
    const box = sandbox();
    writeSessionMirror(box.cwd, "s-live");
    setSessionModel(
      { sessionId: "s-live", provider: "claude", model: "m-live" },
      { path: box.path },
    );
    const who = gateAttach({
      cwd: box.cwd,
      env: OLD_SOURCES,
      correlation: null,
      state: runState({ beadId: "b-run", epic: "epic-1" }),
      path: box.path,
    });
    expect("beadId" in who).toBe(false);
    expect("runId" in who).toBe(false);
    // Who ran it is still known; what it belongs to is not claimed.
    expect(who.sessionId).toBe("s-live");
    expect(who.executor?.model).toBe("m-live");

    const event = gateRanEvent({
      result: { passed: true },
      durationMs: 5,
      attach: who,
    });
    expect(appendEvent(event, { path: box.path }).ok).toBe(true);
    const [stored] = queryEvents({ kinds: ["gate.ran"] }, { path: box.path });
    expect(stored?.beadId).toBeUndefined();
    expect(stored?.runId).toBeUndefined();
    expect(stored?.sessionId).toBe("s-live");
  });

  test("a gate run in a worktree with a live session mirror is tagged with that session's model", () => {
    const box = sandbox();
    writeSessionMirror(box.cwd, "s-live");
    setSessionModel(
      {
        sessionId: "s-live",
        provider: "claude",
        model: "m-live",
        effort: "high",
      },
      { path: box.path },
    );

    const who = gateAttach({
      cwd: box.cwd,
      env: {},
      correlation: correlation(box.cwd),
      state: runState({
        beadId: "b-run",
        executor: { provider: "claude", model: "m-stored", sessionId: "s-old" },
      }),
      path: box.path,
    });
    const event = gateRanEvent({
      result: { passed: true },
      durationMs: 5,
      attach: who,
    });
    expect(event.sessionId).toBe("s-live");
    expect(event.executor).toEqual({
      provider: "claude",
      model: "m-live",
      effort: "high",
      sessionId: "s-live",
    });
    expect(event.beadId).toBe("b-correlated");
    expect(event.runId).toBe("x");

    // And it is stored and read back that way.
    expect(appendEvent(event, { path: box.path }).ok).toBe(true);
    const [stored] = queryEvents({ kinds: ["gate.ran"] }, { path: box.path });
    expect(stored?.sessionId).toBe("s-live");
    expect(stored?.executor?.model).toBe("m-live");
    expect(stored?.beadId).toBe("b-correlated");
    expect(stored?.runId).toBe("x");
  });

  test("with no session the gate falls back to the run's stored executor, and with neither it carries none", () => {
    const box = sandbox();
    const fromRun = gateAttach({
      cwd: box.cwd,
      env: {},
      correlation: correlation(box.cwd),
      state: runState({
        epic: "epic-1",
        executor: { provider: "claude", model: "m-stored", sessionId: "s-old" },
      }),
      path: box.path,
    });
    // The stored executor says who started the run, not who is live now.
    expect(fromRun.executor).toEqual({ provider: "claude", model: "m-stored" });
    expect("sessionId" in fromRun).toBe(false);
    // The run's epic is not the gate's bead: the correlation is.
    expect(fromRun.beadId).toBe("b-correlated");

    const bare = gateAttach({
      cwd: box.cwd,
      env: {},
      correlation: null,
      state: null,
      path: box.path,
    });
    expect("executor" in bare).toBe(false);
    expect("runId" in bare).toBe(false);
    expect("beadId" in bare).toBe(false);
  });
});
