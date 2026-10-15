/**
 * A ledger for the scoreboard's tests: two smiths, an interactive session
 * that names no smith, events that carry no executor, a tool call (which the
 * scoreboard does not read) and one event from another checkout. Shared by
 * `scoreboard.test.ts` and the hearth route's test, so the CLI and the route
 * are compared over the same events.
 */

import type { Executor, LedgerEventInput } from "../../types/hearth";

/** An event as an emitter hands it over, before it is given a workspace. */
export type FixtureEvent = Omit<LedgerEventInput, "workspace">;

export const JOURNEYMAN: Executor = {
  provider: "claude",
  model: "claude-sonnet-4-5",
  effort: "medium",
  smith: "claude-journeyman",
};

export const CODEX: Executor = {
  provider: "codex",
  model: "gpt-5-codex",
  effort: "medium",
  smith: "codex-journeyman",
};

/** An interactive session: its model is known, no smith resolved to it. */
export const LEAD: Executor = { provider: "claude", model: "claude-opus-4-1" };

const day1 = (time: string): string => `2026-10-01T${time}:00Z`;
const day10 = (time: string): string => `2026-10-10T${time}:00Z`;

/** Every event of the fixture checkout, in the order they are appended. */
export const SCOREBOARD_EVENTS: readonly FixtureEvent[] = [
  // claude-journeyman: run-a on day 1, run-b on day 10.
  {
    kind: "session.started",
    ts: day1("10:00"),
    sessionId: "journeyman-1",
    beadId: "b-1",
    runId: "run-a",
    executor: JOURNEYMAN,
    payload: { kind: "headless", worktree: "trees/a" },
  },
  {
    kind: "gate.ran",
    ts: day1("10:05"),
    sessionId: "journeyman-1",
    runId: "run-a",
    executor: JOURNEYMAN,
    payload: { gate: "quality-gate", passed: false, exitCode: 2 },
  },
  {
    kind: "gate.ran",
    ts: day1("10:10"),
    sessionId: "journeyman-1",
    runId: "run-a",
    executor: JOURNEYMAN,
    payload: { gate: "quality-gate", passed: true, exitCode: 0 },
  },
  {
    kind: "session.ended",
    ts: day1("10:15"),
    sessionId: "journeyman-1",
    runId: "run-a",
    executor: JOURNEYMAN,
    payload: {
      reason: "completed",
      durationMs: 900_000,
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 50,
        costUsd: 0.5,
      },
    },
  },
  {
    kind: "verdict.bound",
    ts: day1("10:20"),
    beadId: "b-1",
    runId: "run-a",
    executor: JOURNEYMAN,
    payload: { verdict: "pass" },
  },
  {
    kind: "review.recorded",
    ts: day1("10:20"),
    beadId: "b-1",
    runId: "run-a",
    executor: JOURNEYMAN,
    payload: {
      phase: "implement",
      round: 1,
      verdict: "PASS",
      findings: { blocker: 0, high: 0, medium: 1, low: 2 },
      action: "advance",
    },
  },
  {
    kind: "session.started",
    ts: day10("09:00"),
    sessionId: "journeyman-2",
    runId: "run-b",
    executor: JOURNEYMAN,
    payload: { kind: "headless" },
  },
  {
    kind: "gate.ran",
    ts: day10("09:20"),
    sessionId: "journeyman-2",
    runId: "run-b",
    executor: JOURNEYMAN,
    payload: { gate: "quality-gate", passed: true, exitCode: 0 },
  },
  {
    kind: "session.ended",
    ts: day10("09:30"),
    sessionId: "journeyman-2",
    runId: "run-b",
    executor: JOURNEYMAN,
    payload: {
      reason: "failed: exit 1",
      usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.25 },
    },
  },
  {
    kind: "verdict.bound",
    ts: day10("09:40"),
    runId: "run-b",
    executor: JOURNEYMAN,
    payload: { verdict: "fail" },
  },
  {
    kind: "review.recorded",
    ts: day10("09:40"),
    runId: "run-b",
    executor: JOURNEYMAN,
    payload: {
      phase: "implement",
      round: 1,
      verdict: "FAIL",
      findings: { blocker: 1, high: 1, medium: 0, low: 0 },
      action: "revise",
    },
  },
  {
    kind: "council.run.started",
    ts: day10("09:45"),
    runId: "run-b",
    executor: JOURNEYMAN,
    payload: { councilRunId: "c-1", profile: "default-review", budgetUsd: 1 },
  },
  {
    kind: "council.run.finished",
    ts: day10("09:50"),
    runId: "run-b",
    executor: JOURNEYMAN,
    payload: { councilRunId: "c-1", outcome: "pass", costUsd: 0.1 },
  },
  // A tool call names a run of its own; the scoreboard reads no tool calls.
  {
    kind: "tool.called",
    ts: day10("10:00"),
    sessionId: "journeyman-2",
    runId: "run-z",
    executor: JOURNEYMAN,
    payload: { tool: "Bash", argsHash: "sha256:ab12" },
  },
  // codex-journeyman: run-c; one session timed out, one was stopped.
  {
    kind: "session.started",
    ts: day1("11:00"),
    sessionId: "codex-1",
    runId: "run-c",
    executor: CODEX,
    payload: { kind: "headless" },
  },
  {
    kind: "session.ended",
    ts: day1("11:30"),
    sessionId: "codex-1",
    runId: "run-c",
    executor: CODEX,
    payload: { reason: "timeout" },
  },
  {
    kind: "session.started",
    ts: day10("11:00"),
    sessionId: "codex-2",
    executor: CODEX,
    payload: { kind: "headless" },
  },
  {
    kind: "gate.ran",
    ts: day10("11:10"),
    sessionId: "codex-2",
    executor: CODEX,
    payload: { gate: "quality-gate", passed: false, exitCode: 2 },
  },
  {
    kind: "session.ended",
    ts: day10("11:20"),
    sessionId: "codex-2",
    executor: CODEX,
    payload: {
      reason: "stopped: operator",
      usage: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 },
    },
  },
  {
    kind: "verdict.bound",
    ts: day10("11:25"),
    runId: "run-c",
    executor: CODEX,
    payload: { verdict: "unreadable" },
  },
  // An interactive session that entered a run's phase; its end reason is its host's.
  {
    kind: "session.started",
    ts: day10("08:00"),
    sessionId: "lead-1",
    executor: LEAD,
    payload: { kind: "interactive" },
  },
  {
    kind: "run.phase.entered",
    ts: day10("08:30"),
    sessionId: "lead-1",
    runId: "run-lead",
    executor: LEAD,
    payload: { phase: "research" },
  },
  {
    kind: "session.ended",
    ts: day10("12:00"),
    sessionId: "lead-1",
    executor: LEAD,
    payload: { reason: "prompt_input_exit" },
  },
  // No executor: a gate with no session, a council run the operator started.
  {
    kind: "gate.ran",
    ts: day10("12:30"),
    payload: { gate: "quality-gate", passed: true, exitCode: 0 },
  },
  {
    kind: "council.run.started",
    ts: day10("12:40"),
    beadId: "b-2",
    payload: { councilRunId: "c-2", profile: "default-review" },
  },
  {
    kind: "council.run.finished",
    ts: day10("12:45"),
    beadId: "b-2",
    payload: { councilRunId: "c-2", outcome: "cancelled" },
  },
];

/** What another checkout on the same machine recorded: in no workspace-scoped answer. */
export const ELSEWHERE_EVENTS: readonly FixtureEvent[] = [
  {
    kind: "gate.ran",
    ts: day10("13:00"),
    runId: "run-elsewhere",
    executor: JOURNEYMAN,
    payload: { gate: "quality-gate", passed: false, exitCode: 2 },
  },
];

/** The fixture's workspace for a ledger written without a checkout on disk. */
export const FIXTURE_WORKSPACE = "c:/work/scoreboard-fixture";
export const ELSEWHERE_WORKSPACE = "c:/work/another-checkout";
