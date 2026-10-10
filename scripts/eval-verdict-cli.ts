#!/usr/bin/env bun
/**
 * eval-verdict-cli.ts — write a run's evaluator verdict, once.
 *
 *   bun run forge:verdict --verdict <PASS|FAIL>
 *     [--blocker <n>] [--high <n>] [--medium <n>] [--low <n>]
 *     ( --human <operator|reviewer>
 *     | --requested-provider <id> --requested-model <id> --requested-rank <rank> )
 *     [--summary <text>] [--attest <dimension>=<0..5> ...]
 *     [--review <label>] [--correlation <pointer>] [--checkout <dir>]
 *
 * The only writer of schema 2 verdicts. The Beads issue and the run come from
 * the run correlation (`--correlation`, else `AGENT_FORGE_RUN_CORRELATION`)
 * and from nowhere else, and the file goes to the path that correlation's run
 * id declares, created once: a second write for the same run fails.
 *
 * Every argument is one of the flags above, as `--flag value` or
 * `--flag=value`, given once (`--attest` may repeat). Anything else is refused
 * before anything is written: the file cannot be corrected afterwards, so a
 * mistyped count must not become a verdict without that count.
 *
 * `--checkout` names the checkout the run builds in when that is not the one
 * the command runs in; the pointer is relative to it.
 *
 * A model evaluator says what was requested. What was observed is read, never
 * typed: the model the ledger has cached for the session working in the
 * worktree the command runs in (the session mirror the SessionStart hook
 * leaves there). That session is not an observation of the evaluator when it
 * is the one the run's state names as its builder: an Evaluator subagent
 * shares its spawner's session. Nothing observed means the observed fields
 * are absent; the request is never copied into them. The run's verdict is then
 * refused, as it is when the rank policy rejects the evaluator: the file is
 * written once, and one that can never satisfy strict completion would leave
 * the run without a verdict that can.
 *
 * `--review <label>` writes a review round's verdict for `forge:review`
 * instead: beside the run's verdict, once per label, and whatever was
 * observed.
 *
 * Output is always a single JSON object: { ok, data, error }. `data.file` is
 * the file's full path. Exit code 0 when ok, 2 when not.
 */

import { realpathSync } from "fs";
import type { EvaluatorIdentity, Smith } from "../types/hearth";
import {
  ATTESTATION_DIMENSIONS,
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
import { comparableCheckout } from "./forge/runs";
import { resolveCheckout } from "./ledger/workspace";
import { pointedRunCorrelation } from "./run-correlation-store";

type Env = Readonly<Record<string, string | undefined>>;

/** Everything the writer touches outside its arguments, so tests can replace it. */
export interface VerdictWriteDeps {
  cwd: string;
  env: Env;
  /** The id of the session working in a worktree, from its mirror file. */
  sessionMirror(worktree: string): string | null;
  /** The model the ledger has cached for a session: the machine source of an observation. */
  sessionModel(sessionId: string): { provider: string; model: string } | null;
  /** The smiths configured for the checkout: where a provider and model get a rank. */
  smiths(checkout: string): readonly Smith[];
  /** The stored state of a Forge run in a checkout, when it has one there. */
  runState(runId: string, checkout: string): ForgeState | null;
}

export interface VerdictWriteOutcome {
  code: 0 | 2;
  body: { ok: boolean; data: unknown; error: string | null };
}

const EVALUATOR_USAGE =
  "name the evaluator: --human <operator|reviewer>, or --requested-provider, --requested-model and --requested-rank";

const FINDING_FLAGS = ["blocker", "high", "medium", "low"] as const;

/** Every flag the command takes. Each has a value; all but `attest` are given once. */
const FLAGS = [
  "verdict",
  ...FINDING_FLAGS,
  "human",
  "requested-provider",
  "requested-model",
  "requested-rank",
  "summary",
  "attest",
  "review",
  "correlation",
  "checkout",
] as const;

type Flag = (typeof FLAGS)[number];

const REPEATABLE: ReadonlySet<Flag> = new Set<Flag>(["attest"]);

function refuse(error: string): VerdictWriteOutcome {
  return { code: 2, body: { ok: false, data: null, error } };
}

/**
 * The command line as flags and their values, or the first thing wrong with
 * it. Nothing is skipped: an argument that is not a known flag with a value
 * is an error, so a typo cannot quietly drop what its author meant to say.
 */
function parseArguments(
  argv: readonly string[],
):
  | { ok: true; values: Map<Flag, string>; attest: string[] }
  | { ok: false; error: string } {
  const values = new Map<Flag, string>();
  const attest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      return { ok: false, error: `unexpected argument "${arg}"` };
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    const flag = FLAGS.find((known) => known === name);
    if (flag === undefined) {
      return { ok: false, error: `unknown argument "--${name}"` };
    }
    // The value is what follows, whatever it looks like.
    const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
    if (value === undefined || value.length === 0) {
      return { ok: false, error: `--${flag} needs a value` };
    }
    if (REPEATABLE.has(flag)) {
      attest.push(value);
    } else if (values.has(flag)) {
      return { ok: false, error: `--${flag} was given more than once` };
    } else {
      values.set(flag, value);
    }
  }
  return { ok: true, values, attest };
}

/** What was observed of the evaluator, or why nothing was. */
type Observation =
  | { ok: true; sessionId: string; provider: string; model: string }
  | { ok: false; reason: string };

/**
 * The model the ledger has cached for the session working in the worktree the
 * command runs in. A session the run's state names as its builder is not an
 * observation of who judged its work.
 */
function observe(
  deps: VerdictWriteDeps,
  input: { sessionWorktree: string; builderSessions: ReadonlySet<string> },
): Observation {
  const sessionId = deps.sessionMirror(input.sessionWorktree);
  if (sessionId === null) {
    return {
      ok: false,
      reason:
        "no session is recorded as working in the worktree this command runs in (no session mirror there, or one older than a day)",
    };
  }
  if (input.builderSessions.has(sessionId)) {
    return {
      ok: false,
      reason:
        "the session filing this verdict is the one the run's state names as its builder, so its model is not an observation of the evaluator (an Evaluator subagent shares its spawner's session)",
    };
  }
  const cached = deps.sessionModel(sessionId);
  const provider = cached?.provider.trim() ?? "";
  const model = cached?.model.trim() ?? "";
  if (provider.length === 0 || model.length === 0) {
    return {
      ok: false,
      reason:
        "the ledger has no model cached for the session working in this worktree",
    };
  }
  return { ok: true, sessionId, provider, model };
}

/**
 * The evaluator the verdict will name. A human is what the flags say. A model
 * is the request from the flags plus what was observed, and the rank policy
 * applied to that observation as the gate will apply it.
 */
function evaluatorFrom(
  values: ReadonlyMap<Flag, string>,
  context: {
    observation: Observation;
    smiths: readonly Smith[];
    builder: ForgeState["executor"];
  },
): { ok: true; value: EvaluatorIdentity } | { ok: false; error: string } {
  const human = values.get("human");
  const requested = {
    requestedProvider: values.get("requested-provider"),
    requestedModel: values.get("requested-model"),
    requestedRank: values.get("requested-rank"),
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

  const { observation, builder } = context;
  const policy = observation.ok
    ? observedRankPolicy({
        observed: observation,
        ...(builder ? { builder } : {}),
        smiths: context.smiths,
      })
    : // Nothing was observed, so nothing has a rank.
      ({ decision: "rejected", rule: "evaluator-rank-unknown" } as const);
  return parseEvaluatorIdentity({
    kind: "model",
    ...requested,
    ...(observation.ok
      ? {
          observedProvider: observation.provider,
          observedModel: observation.model,
          // The session itself is the transport that ran the evaluator; the
          // model is the one its responses reported.
          providerEvidence: "selected-direct-transport",
          modelEvidence: "response-field",
        }
      : {}),
    rankPolicyDecision: policy.decision,
    rankPolicyRule: policy.rule,
    ...(observation.ok ? { sessionId: observation.sessionId } : {}),
  });
}

/** The verdict's own fields from the flags, as the object the parser will check. */
function bodyFrom(
  values: ReadonlyMap<Flag, string>,
  attest: readonly string[],
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const verdict = values.get("verdict");
  if (verdict !== "PASS" && verdict !== "FAIL") {
    return { ok: false, error: '--verdict must be "PASS" or "FAIL"' };
  }
  const findings: Record<string, number> = {};
  for (const name of FINDING_FLAGS) {
    const raw = values.get(name) ?? "0";
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
  const attestations = new Map<string, number>();
  for (const pair of attest) {
    const [name, score, ...rest] = pair.split("=");
    if (!name || score === undefined || rest.length > 0) {
      return { ok: false, error: "--attest takes <dimension>=<0..5>" };
    }
    const dimension = ATTESTATION_DIMENSIONS.find((known) => known === name);
    if (dimension === undefined) {
      return {
        ok: false,
        error: `--attest ${name} is not a known dimension (${ATTESTATION_DIMENSIONS.join("|")})`,
      };
    }
    attestations.set(
      dimension,
      /^\d+$/.test(score) ? Number(score) : Number.NaN,
    );
  }
  const summary = values.get("summary");
  return {
    ok: true,
    value: {
      verdict,
      findings,
      ...(summary !== undefined ? { summary } : {}),
      ...(attestations.size > 0
        ? { attestations: Object.fromEntries(attestations) }
        : {}),
    },
  };
}

/** The top level of the checkout `--checkout` names, or why it is not one. */
function namedCheckout(
  dir: string,
): { ok: true; root: string } | { ok: false; error: string } {
  let given: string;
  try {
    given = comparableCheckout(realpathSync.native(dir));
  } catch {
    return { ok: false, error: "--checkout names no directory" };
  }
  const root = resolveCheckout(dir).worktree;
  return given === root
    ? { ok: true, root }
    : { ok: false, error: "--checkout must be the top level of a checkout" };
}

export function runVerdictWrite(
  argv: readonly string[],
  deps: VerdictWriteDeps,
): VerdictWriteOutcome {
  const parsedArguments = parseArguments(argv);
  if (!parsedArguments.ok) return refuse(parsedArguments.error);
  const { values, attest } = parsedArguments;

  // Where the session is, and where the run builds: one checkout unless
  // --checkout says otherwise.
  const sessionWorktree = resolveCheckout(deps.cwd).worktree;
  const named = values.get("checkout");
  const where =
    named === undefined
      ? ({ ok: true, root: sessionWorktree } as const)
      : namedCheckout(named);
  if (!where.ok) return refuse(where.error);
  const checkout = where.root;

  const pointed = pointedRunCorrelation({ argv, env: deps.env, checkout });
  if (!pointed.linked) return refuse(pointed.reason);
  const { correlation } = pointed;

  const label = values.get("review");
  const file =
    label === undefined ? STRICT_VERDICT_FILE : reviewVerdictFile(label);
  if (file === null) {
    return refuse(
      "--review <label> must be lower-case letters, digits and dashes (at most 40), such as plan-2",
    );
  }
  const strict = file === STRICT_VERDICT_FILE;

  const body = bodyFrom(values, attest);
  if (!body.ok) return refuse(body.error);
  const smiths = deps.smiths(checkout);
  // The builder the rank policy is applied to is the one the gate will see:
  // the state stored in the checkout the run builds in. The session that built
  // the work is looked for in the launching checkout's state too.
  const state = deps.runState(correlation.executionRunId, checkout);
  const launcherState =
    sessionWorktree === checkout
      ? state
      : deps.runState(correlation.executionRunId, sessionWorktree);
  const builderSessions = new Set(
    [state?.executor?.sessionId, launcherState?.executor?.sessionId].filter(
      (id): id is string => id !== undefined,
    ),
  );
  const observation = observe(deps, { sessionWorktree, builderSessions });
  const evaluator = evaluatorFrom(values, {
    observation,
    smiths,
    builder: state?.executor,
  });
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
  const unobserved =
    verdict.evaluator.kind === "model" && !observation.ok
      ? observation.reason
      : null;
  if (strict && problem !== null) {
    return refuse(
      `not written: this verdict could never satisfy strict completion, and a run's verdict is written once. ${problem}${unobserved !== null ? `. Nothing was observed: ${unobserved}` : ""}`,
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
        file: `${checkout}/${wrote.path}`,
        sha256: wrote.sha256,
        bytes: wrote.bytes,
        beadsIssueId: verdict.beadsIssueId,
        executionRunId: verdict.executionRunId,
        strict,
        evaluator: verdict.evaluator,
        ...(problem !== null ? { evaluatorProblem: problem } : {}),
        ...(unobserved !== null ? { unobserved } : {}),
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
