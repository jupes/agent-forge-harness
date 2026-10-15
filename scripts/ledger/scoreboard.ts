/**
 * The scoreboard: what the ledger holds per executor. Sessions and how they
 * ended, the Forge runs taken part in, gates, verdicts, review rounds and
 * their findings, council runs, and the usage and cost providers reported.
 * Served by `forge:audit --scoreboard` and `GET /scoreboard`, both through
 * `readScoreboard`, so the two answer the same numbers.
 *
 * Pure aggregation over stored events, and nothing inferred:
 *
 * - An event counts toward the executor it carries (`events.provider`,
 *   `model`, `smith`), keyed by smith, provider and model. For a
 *   `verdict.bound` or `review.recorded` that is the session that recorded the
 *   round (in a Forge run, the session running it), not the evaluator: the
 *   payload's `builder` and `evaluator` are not read. An event with no
 *   executor counts in the row whose executor is null.
 * - A value no event recorded is null, never 0: a pass rate with no gate run,
 *   a cost nobody reported. Council findings by severity are the sum of the
 *   `findings` counts on the finished runs that recorded them, and null where
 *   none did (a failed or cancelled run records none, and neither does a run
 *   written before the field existed); `runsWithFindings` says how many did.
 * - Only events still in the ledger are read. Days folded by `compact` keep a
 *   count per kind and nothing per executor, so they are not in it.
 */

import {
  type LedgerEventKind,
  PROVIDER_USAGE_COUNTS,
  type ProviderUsageCount,
  type Scoreboard,
  type ScoreboardExecutor,
  type ScoreboardRow,
} from "../../types/hearth";
import type { ReviewFindings } from "../forge/phases";
import { comparableCheckout } from "../forge/runs";
import { openLedger } from "./db";

/** The kinds the scoreboard reads. Tool calls and prompts are not among them. */
export const SCOREBOARD_KINDS = [
  "session.started",
  "session.ended",
  "run.phase.entered",
  "run.phase.completed",
  "gate.ran",
  "verdict.bound",
  "review.recorded",
  "council.run.started",
  "council.run.finished",
] as const satisfies readonly LedgerEventKind[];

export interface ScoreboardFilter {
  /** Any spelling of the checkout path; every workspace when absent. */
  workspace?: string;
  /** ISO 8601; events at or after this instant. */
  since?: string;
}

interface Stored {
  ts: string;
  kind: string;
  run_id: string | null;
  provider: string | null;
  model: string | null;
  smith: string | null;
  payload: string;
}

interface Tally {
  row: ScoreboardRow;
  runs: Set<string>;
  tokens: Map<ProviderUsageCount, number>;
}

function emptyRow(executor: ScoreboardExecutor | null): ScoreboardRow {
  return {
    executor,
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
    gates: { ran: 0, passed: 0, failed: 0, passRate: null },
    verdicts: { pass: 0, fail: 0, unreadable: 0 },
    reviews: {
      rounds: 0,
      pass: 0,
      fail: 0,
      unreadable: 0,
      findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    },
    council: {
      started: 0,
      finished: 0,
      pass: 0,
      fail: 0,
      unreadable: 0,
      cancelled: 0,
      costUsd: null,
      runsWithCost: 0,
      findings: null,
      runsWithFindings: 0,
    },
    usage: { sessions: 0, costUsd: null, sessionsWithCost: 0, tokens: {} },
  };
}

/** The executor a stored row carries, as the scoreboard keys it: none without a provider and a model. */
function executorOf(row: Stored): ScoreboardExecutor | null {
  if (row.provider === null || row.model === null) return null;
  return {
    provider: row.provider,
    model: row.model,
    ...(row.smith !== null ? { smith: row.smith } : {}),
  };
}

function keyOf(executor: ScoreboardExecutor | null): string {
  return executor === null
    ? "none"
    : JSON.stringify([
        executor.smith ?? null,
        executor.provider,
        executor.model,
      ]);
}

const SEVERITIES = ["blocker", "high", "medium", "low"] as const;

const NO_FINDINGS: ReviewFindings = { blocker: 0, high: 0, medium: 0, low: 0 };

/** A number a payload reported, when it is one. */
function reported(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * How a session ended, by the fixed reasons `scripts/executors/cli-adapter.ts`
 * writes. Any other reason, or none, is a host's (an interactive session's end).
 */
function ending(
  reason: unknown,
): "completed" | "failed" | "timedOut" | "stopped" | "other" {
  if (reason === "completed") return "completed";
  if (reason === "timeout") return "timedOut";
  if (typeof reason !== "string") return "other";
  if (reason.startsWith("failed:")) return "failed";
  if (reason.startsWith("stopped:")) return "stopped";
  return "other";
}

/** Add one event to its executor's tally. */
function count(tally: Tally, kind: string, payload: Record<string, unknown>) {
  const { row } = tally;
  switch (kind) {
    case "session.started":
      row.sessions.started++;
      return;
    case "session.ended": {
      row.sessions.ended++;
      row.sessions[ending(payload["reason"])]++;
      const usage = payload["usage"];
      if (typeof usage !== "object" || usage === null) return;
      const counts = record(usage);
      row.usage.sessions++;
      for (const name of PROVIDER_USAGE_COUNTS) {
        const value = reported(counts[name]);
        if (value !== undefined)
          tally.tokens.set(name, (tally.tokens.get(name) ?? 0) + value);
      }
      const cost = reported(counts["costUsd"]);
      if (cost !== undefined) {
        row.usage.costUsd = (row.usage.costUsd ?? 0) + cost;
        row.usage.sessionsWithCost++;
      }
      return;
    }
    case "gate.ran":
      row.gates.ran++;
      if (payload["passed"] === true) row.gates.passed++;
      else if (payload["passed"] === false) row.gates.failed++;
      return;
    case "verdict.bound": {
      const verdict = payload["verdict"];
      if (verdict === "pass" || verdict === "fail" || verdict === "unreadable")
        row.verdicts[verdict]++;
      return;
    }
    case "review.recorded": {
      row.reviews.rounds++;
      const verdict = payload["verdict"];
      if (verdict === "PASS") row.reviews.pass++;
      else if (verdict === "FAIL") row.reviews.fail++;
      else if (verdict === "UNREADABLE") row.reviews.unreadable++;
      const findings = record(payload["findings"]);
      for (const severity of SEVERITIES)
        row.reviews.findings[severity] += reported(findings[severity]) ?? 0;
      return;
    }
    case "council.run.started":
      row.council.started++;
      return;
    case "council.run.finished": {
      row.council.finished++;
      const outcome = payload["outcome"];
      if (
        outcome === "pass" ||
        outcome === "fail" ||
        outcome === "unreadable" ||
        outcome === "cancelled"
      )
        row.council[outcome]++;
      const cost = reported(payload["costUsd"]);
      if (cost !== undefined) {
        row.council.costUsd = (row.council.costUsd ?? 0) + cost;
        row.council.runsWithCost++;
      }
      // A run reports its findings when at least one severity is a number; a
      // run without them (failed, cancelled, or written before the field
      // existed) leaves the sum null, not zero.
      const findings = record(payload["findings"]);
      const counts = SEVERITIES.map((severity) => reported(findings[severity]));
      if (counts.some((value) => value !== undefined)) {
        const sum = row.council.findings ?? { ...NO_FINDINGS };
        SEVERITIES.forEach((severity, i) => {
          sum[severity] += counts[i] ?? 0;
        });
        row.council.findings = sum;
        row.council.runsWithFindings++;
      }
      return;
    }
    default:
      // A phase event counts only through its run.
      return;
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rows with a smith by smith name, then those without by provider and model, then no executor. */
function compareRows(a: ScoreboardRow, b: ScoreboardRow): number {
  const x = a.executor;
  const y = b.executor;
  if (x === null || y === null)
    return (x === null ? 1 : 0) - (y === null ? 1 : 0);
  return (
    (x.smith === undefined ? 1 : 0) - (y.smith === undefined ? 1 : 0) ||
    compareText(x.smith ?? "", y.smith ?? "") ||
    compareText(x.provider, y.provider) ||
    compareText(x.model, y.model)
  );
}

/**
 * The scoreboard of the events in scope, read in id order. Throws when the
 * ledger cannot be opened or `since` is not a date.
 */
export function readScoreboard(
  filter: ScoreboardFilter = {},
  opts: { path?: string } = {},
): Scoreboard {
  const where = [`kind IN (${SCOREBOARD_KINDS.map(() => "?").join(", ")})`];
  const params: string[] = [...SCOREBOARD_KINDS];
  if (filter.workspace !== undefined) {
    where.push("workspace = ?");
    params.push(comparableCheckout(filter.workspace));
  }
  if (filter.since !== undefined) {
    where.push("ts >= ?");
    params.push(new Date(filter.since).toISOString());
  }
  // By the kind index: tool calls are most of the ledger and none is read.
  const rows = openLedger(opts.path)
    .query<Stored, string[]>(
      `SELECT ts, kind, run_id, provider, model, smith, payload
       FROM events INDEXED BY events_kind
       WHERE ${where.join(" AND ")} ORDER BY id`,
    )
    .iterate(...params);

  const tallies = new Map<string, Tally>();
  let events = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const stored of rows) {
    events++;
    if (from === null || stored.ts < from) from = stored.ts;
    if (to === null || stored.ts > to) to = stored.ts;
    const executor = executorOf(stored);
    const key = keyOf(executor);
    let tally = tallies.get(key);
    if (tally === undefined) {
      tally = { row: emptyRow(executor), runs: new Set(), tokens: new Map() };
      tallies.set(key, tally);
    }
    if (stored.run_id !== null) tally.runs.add(stored.run_id);
    let payload: unknown;
    try {
      payload = JSON.parse(stored.payload);
    } catch {
      payload = {};
    }
    count(tally, stored.kind, record(payload));
  }

  const scored = [...tallies.values()].map(({ row, runs, tokens }) => {
    const tokenCounts: ScoreboardRow["usage"]["tokens"] = {};
    for (const name of PROVIDER_USAGE_COUNTS) {
      const value = tokens.get(name);
      if (value !== undefined) tokenCounts[name] = value;
    }
    return {
      ...row,
      runs: runs.size,
      gates: {
        ...row.gates,
        passRate: row.gates.ran === 0 ? null : row.gates.passed / row.gates.ran,
      },
      usage: { ...row.usage, tokens: tokenCounts },
    };
  });
  return { rows: scored.sort(compareRows), events, from, to };
}

function headOf(executor: ScoreboardExecutor | null): string {
  if (executor === null) return "no executor recorded";
  const what = `(${executor.provider} ${executor.model})`;
  return executor.smith !== undefined
    ? `${executor.smith} ${what}`
    : `no smith ${what}`;
}

const usd = (value: number): string => `$${value.toFixed(4)}`;

const countsText = (findings: ReviewFindings): string =>
  SEVERITIES.map((severity) => `${findings[severity]} ${severity}`).join(", ");

function block(row: ScoreboardRow): string {
  const { sessions, gates, verdicts, reviews, council, usage } = row;
  const rate =
    gates.passRate === null
      ? "unknown (no gate ran)"
      : `${(gates.passRate * 100).toFixed(1)}%`;
  const councilCost =
    council.costUsd === null
      ? `unknown (0 of ${council.finished} finished reported one)`
      : `${usd(council.costUsd)} (${council.runsWithCost} of ${council.finished} finished)`;
  const councilFindings =
    council.findings === null
      ? `not recorded (0 of ${council.finished} finished reported them)`
      : `${countsText(council.findings)} (${council.runsWithFindings} of ${council.finished} finished reported them)`;
  const usageCost =
    usage.costUsd === null
      ? `unknown (0 of ${sessions.ended} ended sessions reported one)`
      : `${usd(usage.costUsd)} (${usage.sessionsWithCost} of ${sessions.ended} ended sessions)`;
  const tokens = PROVIDER_USAGE_COUNTS.flatMap((name) => {
    const value = usage.tokens[name];
    return value === undefined ? [] : [`${name} ${value}`];
  });
  return [
    headOf(row.executor),
    `  runs ${row.runs}; sessions ${sessions.started} started, ${sessions.ended} ended: ${sessions.completed} completed, ${sessions.failed} failed, ${sessions.timedOut} timed out, ${sessions.stopped} stopped, ${sessions.other} other`,
    `  gates ${gates.ran} ran: ${gates.passed} passed, ${gates.failed} failed, pass rate ${rate}`,
    `  verdicts ${verdicts.pass} pass, ${verdicts.fail} fail, ${verdicts.unreadable} unreadable`,
    `  reviews ${reviews.rounds} rounds: ${reviews.pass} PASS, ${reviews.fail} FAIL, ${reviews.unreadable} UNREADABLE; findings ${countsText(reviews.findings)}`,
    `  council ${council.started} started, ${council.finished} finished: ${council.pass} pass, ${council.fail} fail, ${council.unreadable} unreadable, ${council.cancelled} cancelled`,
    `  council cost ${councilCost}`,
    `  council findings by severity: ${councilFindings}`,
    `  usage cost ${usageCost}`,
    `  usage tokens ${tokens.length > 0 ? tokens.join(", ") : "not reported"}`,
  ].join("\n");
}

/** The text view: a line on what was read, then one block per row. */
export function formatScoreboard(board: Scoreboard): string {
  if (board.events === 0) return "no events";
  return [
    `${board.events} events read, from ${board.from} to ${board.to}`,
    ...board.rows.map(block),
  ].join("\n\n");
}
