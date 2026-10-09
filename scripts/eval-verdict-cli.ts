#!/usr/bin/env bun

/**
 * eval-verdict-cli.ts — write a run's evaluator verdict, once.
 *
 *   bun run forge:verdict --verdict <PASS|FAIL>
 *     [--blocker <n>] [--high <n>] [--medium <n>] [--low <n>]
 *     ( --human <operator|reviewer>
 *     | --requested-provider <id> --requested-model <id> --requested-rank <rank> )
 *     [--summary <text>] [--attest <dimension>=<0..5> ...]
 *     [--review <label>] [--correlation <pointer>]
 *
 * The only writer of schema 2 verdicts. The Beads issue and the run come from
 * the run correlation (`--correlation`, else `AGENT_FORGE_RUN_CORRELATION`)
 * and from nowhere else, and the file goes to the path that correlation's run
 * id declares, created exclusively: a second write for the same run fails.
 *
 * A model evaluator says what was requested. What was observed is read, never
 * typed: the model the ledger has cached for the session working in this
 * worktree (the session mirror the SessionStart hook leaves there). Nothing
 * observed means the observed fields are absent; the request is never copied
 * into them. The run's verdict is then refused, as it is when the rank policy
 * rejects the evaluator: the file is written once, and one that can never
 * satisfy strict completion would leave the run without a verdict that can.
 *
 * `--review <label>` writes a review round's verdict for `forge:review`
 * instead: beside the run's verdict, once per label, and whatever was
 * observed.
 *
 * Output is always a single JSON object: { ok, data, error }.
 * Exit code 0 when ok, 2 when not.
 */

import type { EvaluatorIdentity, Smith } from "../types/hearth";
import {
  EVAL_VERDICT_SCHEMA_VERSION,
  type EvalVerdict,
  parseEvaluatorIdentity,
  parseEvalVerdictJson,
} from "./eval-verdict";
import {
  reviewVerdictFile,
  STRICT_VERDICT_FILE,
  writeVerdictOnce,
} from "./eval-verdict-store";
import { observedRankPolicy, strictEvaluatorProblem } from "./evaluator-policy";
import type { ForgeState } from "./forge/phases";
import { resolveCheckout } from "./ledger/workspace";
import { pointedRunCorrelation } from "./run-correlation-store";

type Env = Readonly<Record<string, string | undefined>>;

/** Everything the writer touches outside its arguments, so tests can replace it. */
export interface VerdictWriteDeps {
  cwd: string;
  env: Env;
  /** The id of the session working in the worktree, from its mirror file. */
  sessionMirror(worktree: string): string | null;
  /** The model the ledger has cached for a session: the machine source of an observation. */
  sessionModel(sessionId: string): { provider: string; model: string } | null;
  /** The smiths configured for the checkout: where a provider and model get a rank. */
  smiths(checkout: string): readonly Smith[];
  /** The stored state of a Forge run in the checkout, when it has one. */
  runState(runId: string, checkout: string): ForgeState | null;
}

export interface VerdictWriteOutcome {
  code: 0 | 2;
  body: { ok: boolean; data: unknown; error: string | null };
}

const EVALUATOR_USAGE =
  "name the evaluator: --human <operator|reviewer>, or --requested-provider, --requested-model and --requested-rank";

const FINDING_FLAGS = ["blocker", "high", "medium", "low"] as const;

function refuse(error: string): VerdictWriteOutcome {
  return { code: 2, body: { ok: false, data: null, error } };
}

/** The value after `--name`, or undefined when the flag is absent or last. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** Every value given for a flag that may repeat. */
function flagValues(argv: readonly string[], name: string): string[] {
  return argv.flatMap((arg, index) => {
    const value = argv[index + 1];
    return arg === `--${name}` && value !== undefined ? [value] : [];
  });
}

/**
 * The evaluator the verdict will name. A human is what the flags say. A model
 * is the request from the flags plus what was observed for the worktree's
 * session, and the rank policy applied to that observation.
 */
function evaluatorFrom(
  argv: readonly string[],
  deps: VerdictWriteDeps,
  context: {
    checkout: string;
    smiths: readonly Smith[];
    state: ForgeState | null;
  },
): { ok: true; value: EvaluatorIdentity } | { ok: false; error: string } {
  const human = flagValue(argv, "human");
  const requested = {
    requestedProvider: flagValue(argv, "requested-provider"),
    requestedModel: flagValue(argv, "requested-model"),
    requestedRank: flagValue(argv, "requested-rank"),
  };
  const anyRequested = Object.values(requested).some(
    (value) => value !== undefined,
  );
  const allRequested = Object.values(requested).every(
    (value) => value !== undefined,
  );
  if (
    (human !== undefined) === anyRequested ||
    (anyRequested && !allRequested)
  ) {
    return { ok: false, error: EVALUATOR_USAGE };
  }
  if (human !== undefined) {
    return parseEvaluatorIdentity({ kind: "human", actorKind: human });
  }

  const sessionId = deps.sessionMirror(context.checkout);
  const cached = sessionId !== null ? deps.sessionModel(sessionId) : null;
  const builder = context.state?.executor;
  const policy = cached
    ? observedRankPolicy({
        observed: cached,
        ...(builder ? { builder } : {}),
        smiths: context.smiths,
      })
    : // Nothing was observed, so nothing has a rank.
      ({ decision: "rejected", rule: "evaluator-rank-unknown" } as const);
  return parseEvaluatorIdentity({
    kind: "model",
    ...requested,
    ...(cached
      ? {
          observedProvider: cached.provider,
          observedModel: cached.model,
          // The session itself is the transport that ran the evaluator; the
          // model is the one its responses reported.
          providerEvidence: "selected-direct-transport",
          modelEvidence: "response-field",
        }
      : {}),
    rankPolicyDecision: policy.decision,
    rankPolicyRule: policy.rule,
    ...(cached && sessionId !== null ? { sessionId } : {}),
  });
}

/** The verdict's own fields from the flags, as the object the parser will check. */
function bodyFrom(
  argv: readonly string[],
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const verdict = flagValue(argv, "verdict");
  if (verdict !== "PASS" && verdict !== "FAIL") {
    return { ok: false, error: '--verdict must be "PASS" or "FAIL"' };
  }
  const findings: Record<string, number> = {};
  for (const name of FINDING_FLAGS) {
    const raw = flagValue(argv, name) ?? "0";
    if (!/^\d+$/.test(raw)) {
      return { ok: false, error: `--${name} must be a non-negative integer` };
    }
    findings[name] = Number(raw);
  }
  // A verdict is one statement: it cannot say PASS and count a blocker.
  if (verdict === "PASS" && (findings.blocker !== 0 || findings.high !== 0)) {
    return { ok: false, error: "a PASS has no blocker or high findings" };
  }
  if (
    verdict === "FAIL" &&
    FINDING_FLAGS.every((name) => findings[name] === 0)
  ) {
    return { ok: false, error: "a FAIL names at least one finding" };
  }
  const attestations: Record<string, number> = {};
  for (const pair of flagValues(argv, "attest")) {
    const [dimension, score, ...rest] = pair.split("=");
    if (!dimension || score === undefined || rest.length > 0) {
      return { ok: false, error: "--attest takes <dimension>=<0..5>" };
    }
    attestations[dimension] = /^\d+$/.test(score) ? Number(score) : Number.NaN;
  }
  const summary = flagValue(argv, "summary");
  return {
    ok: true,
    value: {
      verdict,
      findings,
      ...(summary !== undefined ? { summary } : {}),
      ...(Object.keys(attestations).length > 0 ? { attestations } : {}),
    },
  };
}

export function runVerdictWrite(
  argv: readonly string[],
  deps: VerdictWriteDeps,
): VerdictWriteOutcome {
  const checkout = resolveCheckout(deps.cwd).worktree;
  const pointed = pointedRunCorrelation({ argv, env: deps.env, checkout });
  if (!pointed.linked) return refuse(pointed.reason);
  const { correlation } = pointed;

  const label = flagValue(argv, "review");
  const file =
    label === undefined ? STRICT_VERDICT_FILE : reviewVerdictFile(label);
  if (file === null) {
    return refuse(
      "--review <label> must be lower-case letters, digits and dashes (at most 40), such as plan-2",
    );
  }
  const strict = file === STRICT_VERDICT_FILE;

  const body = bodyFrom(argv);
  if (!body.ok) return refuse(body.error);
  const smiths = deps.smiths(checkout);
  const state = deps.runState(correlation.executionRunId, checkout);
  const evaluator = evaluatorFrom(argv, deps, { checkout, smiths, state });
  if (!evaluator.ok) return refuse(evaluator.error);

  // What goes to disk is what the reader's own parser makes of it: the writer
  // never produces a file the gate would refuse to parse.
  const parsed = parseEvalVerdictJson(
    JSON.stringify({
      schemaVersion: EVAL_VERDICT_SCHEMA_VERSION,
      beadsIssueId: correlation.beadsIssueId,
      executionRunId: correlation.executionRunId,
      ...body.value,
      evaluator: evaluator.value,
    }),
  );
  if (!parsed.ok) return refuse(parsed.error);
  if (parsed.value.schemaVersion !== EVAL_VERDICT_SCHEMA_VERSION) {
    return refuse("the verdict did not parse as schema 2");
  }
  const verdict: EvalVerdict = parsed.value;

  const problem = strictEvaluatorProblem(verdict.evaluator, {
    smiths,
    ...(state?.executor ? { builder: state.executor } : {}),
  });
  if (strict && problem !== null) {
    return refuse(
      `not written: this verdict could never satisfy strict completion, and a run's verdict is written once. ${problem}`,
    );
  }

  const wrote = writeVerdictOnce({
    checkout,
    executionRunId: correlation.executionRunId,
    file,
    content: `${JSON.stringify(verdict, null, 2)}\n`,
  });
  if (!wrote.ok) {
    return refuse(
      wrote.exists && strict
        ? `${wrote.error}. A re-evaluation is a new run: bun run forge:correlate --bead ${correlation.beadsIssueId}`
        : wrote.error,
    );
  }
  return {
    code: 0,
    body: {
      ok: true,
      data: {
        path: wrote.path,
        sha256: wrote.sha256,
        bytes: wrote.bytes,
        beadsIssueId: verdict.beadsIssueId,
        executionRunId: verdict.executionRunId,
        strict,
        evaluator: verdict.evaluator,
        ...(problem !== null ? { evaluatorProblem: problem } : {}),
      },
      error: null,
    },
  };
}

if (import.meta.main) {
  // Loaded here, not at the top: these reach Bun's SQLite and the config
  // files, which the function above is tested without.
  const { loadConfig } = await import("./config/load");
  const { readRunState } = await import("./forge/runs-store");
  const { readSessionMirror } = await import("./ledger/identity");
  const { getSessionModel } = await import("./ledger/session-models");
  const outcome = runVerdictWrite(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    sessionMirror: (worktree) => readSessionMirror(worktree),
    sessionModel: (sessionId) => getSessionModel(sessionId),
    smiths: (checkout) => {
      try {
        return Object.values(
          loadConfig({ harnessRoot: checkout }).config.smiths,
        );
      } catch (error) {
        console.error(
          `forge:verdict: smith config not readable, so no evaluator has a rank: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    },
    runState: readRunState,
  });
  console.log(JSON.stringify(outcome.body, null, 2));
  process.exit(outcome.code);
}
