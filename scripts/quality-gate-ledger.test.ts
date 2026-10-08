/**
 * The ledger events the quality gate builds.
 *
 * These test the builders and the identity they resolve from seeded state.
 * They do not run `.claude/hooks/quality-gate.ts`: the gate runs the test
 * suite, so a test that spawned it would recurse. The call site inside the
 * gate is shown by running the gate by hand.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { EvalVerdictParsed } from "./eval-verdict";
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

describe("gateRanEvent", () => {
  test("a gate result becomes one gate.ran bound to its run, bead and executor", () => {
    const who = attach({
      beadId: "b-1",
      sessionId: "s-1",
      executor: { provider: "claude", model: "m-1", sessionId: "s-1" },
    });

    const passed = gateRanEvent({
      result: { passed: true, forgeSlug: "x" },
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
      result: { passed: false, forgeSlug: "x" },
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
      result: { passed: true, forgeSlug: null },
      durationMs: 5,
      attach: attach(),
    });
    for (const key of ["beadId", "runId", "sessionId", "executor"])
      expect(key in event).toBe(false);
    expect(validateLedgerEventInput(event).ok).toBe(true);
  });

  test("the run the gate established wins over the run the attach carries", () => {
    const event = gateRanEvent({
      result: { passed: true, forgeSlug: "from-gate" },
      durationMs: 5,
      attach: attach({ runId: "from-attach" }),
    });
    expect(event.runId).toBe("from-gate");
  });
});

describe("strictVerdictEvent", () => {
  const verdict: EvalVerdictParsed = {
    schemaVersion: 1,
    taskId: "bead-from-verdict",
    verdict: "FAIL",
    findings: { blocker: 0, high: 0, medium: 2, low: 0 },
    summary: "two medium findings",
  };

  test("a strict-gate verdict is bound to the bead named in the verdict", () => {
    const event = strictVerdictEvent({
      verdict,
      forgeSlug: "x",
      builder: { provider: "claude", model: "m-build" },
      attach: attach({ beadId: "bead-from-env", sessionId: "s-1" }),
    });
    expect(event).toEqual({
      kind: "verdict.bound",
      workspace: "c:/work/repo",
      beadId: "bead-from-verdict",
      runId: "x",
      sessionId: "s-1",
      payload: {
        verdict: "fail",
        builder: { provider: "claude", model: "m-build" },
        summary: "two medium findings",
      },
    });
    expect(validateLedgerEventInput(event).ok).toBe(true);
  });

  test("a verdict file names no evaluator, so the event carries none", () => {
    const event = strictVerdictEvent({
      verdict: { ...verdict, verdict: "PASS" },
      forgeSlug: null,
      attach: attach(),
    });
    expect(event.payload).toEqual({
      verdict: "pass",
      summary: "two medium findings",
    });
    expect("evaluator" in event.payload).toBe(false);
    expect("runId" in event).toBe(false);
  });
});

describe("gateAttach (the real resolver over seeded state, scratch ledger)", () => {
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
      forgeSlug: "x",
      state: runState({
        beadId: "b-run",
        executor: { provider: "claude", model: "m-stored", sessionId: "s-old" },
      }),
      path: box.path,
    });
    const event = gateRanEvent({
      result: { passed: true, forgeSlug: "x" },
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
    expect(event.beadId).toBe("b-run");
    expect(event.runId).toBe("x");

    // And it is stored and read back that way.
    expect(appendEvent(event, { path: box.path }).ok).toBe(true);
    const [stored] = queryEvents({ kinds: ["gate.ran"] }, { path: box.path });
    expect(stored?.sessionId).toBe("s-live");
    expect(stored?.executor?.model).toBe("m-live");
    expect(stored?.beadId).toBe("b-run");
    expect(stored?.runId).toBe("x");
  });

  test("with no session the gate falls back to the run's stored executor, and with neither it carries none", () => {
    const box = sandbox();
    const fromRun = gateAttach({
      cwd: box.cwd,
      env: {},
      forgeSlug: "x",
      state: runState({
        epic: "epic-1",
        executor: { provider: "claude", model: "m-stored", sessionId: "s-old" },
      }),
      path: box.path,
    });
    // The stored executor says who started the run, not who is live now.
    expect(fromRun.executor).toEqual({ provider: "claude", model: "m-stored" });
    expect("sessionId" in fromRun).toBe(false);
    expect(fromRun.beadId).toBe("epic-1");

    const bare = gateAttach({
      cwd: box.cwd,
      env: {},
      forgeSlug: null,
      state: null,
      path: box.path,
    });
    expect("executor" in bare).toBe(false);
    expect("runId" in bare).toBe(false);
    expect("beadId" in bare).toBe(false);
  });

  test("the bead named in the environment beats the run's bead", () => {
    const box = sandbox();
    const who = gateAttach({
      cwd: box.cwd,
      env: { AGENT_FORGE_BEAD_ID: "b-env" },
      forgeSlug: "x",
      state: runState({ beadId: "b-run" }),
      path: box.path,
    });
    expect(who.beadId).toBe("b-env");
  });
});
