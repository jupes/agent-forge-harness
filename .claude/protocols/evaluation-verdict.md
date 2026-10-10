# Evaluation verdict artifact (strict gate)

Machine-readable output of an **Evaluator** pass. The worker produces code; the evaluator records a structured verdict the harness can gate on. It is required when **`AGENT_FORGE_EVAL_VERDICT=strict`** is set (see `.claude/hooks/quality-gate.ts`) and is what `bun run forge:review` grades an unattended review round from.

A verdict belongs to one **execution run** of one Beads issue, and says who judged. It is written once and never replaced.

## Where it lives

```
.tmp/work/evaluations/<sha256 of the executionRunId>/verdict.json
```

The path is a rule, not a setting: it is derived from the `executionRunId` of the run's **run correlation** (`.claude/protocols/agent-onboarding.md`, *Run correlation*), in the checkout the run builds in. Nothing else selects a verdict: not the Beads id, not the host's task id, and no environment variable other than the one that points at the run correlation. Two runs of the same Beads issue have two different files.

- **One run, one verdict.** The file is created only where nothing is; a second write for the same run fails and says so. It appears whole or not at all.
- **A re-evaluation is a new run.** After a FAIL is repaired, `bun run forge:correlate --bead <TASK-ID>` mints a new run with its own path. The earlier file stays as evidence of the earlier run.
- **Once the sweep has removed a verdict** (see *Cleanup*) the run's place is free again. Its digest stays in the ledger until the ledger's own compaction of old events.
- The `.tmp/` tree is gitignored; the file is **not** committed.

## Writing it

Verdicts are written by one command, never by hand:

```bash
# A person filing the verdict
bun run forge:verdict --correlation <pointer> --verdict PASS --medium 2 \
  --human reviewer --summary "Two things to tidy."

# A model Evaluator: say what was requested; what ran is read, not typed
bun run forge:verdict --correlation <pointer> --verdict FAIL --high 1 \
  --requested-provider claude --requested-model claude-opus-5-5 --requested-rank master
```

`<pointer>` is the run correlation's pointer: `data.correlation.pointer` from `forge:phase-gate … --write --bead <TASK-ID>`, or from `bun run forge:correlate --bead <TASK-ID> [--run <slug>]`. A launcher can set `AGENT_FORGE_RUN_CORRELATION` instead. The Beads id and the run id in the file are the correlation's; there is no flag for either, and none for what was observed.

Every argument is one of the flags below, written `--flag value` or `--flag=value`, and given once (`--attest` may repeat). **Anything else is refused and nothing is written**: an unknown flag, a flag with no value, a flag followed by something that looks like a flag where its value should be, a repeated flag or attestation dimension, a stray word. (Text that itself looks like a flag has to be given as `--summary=<text>`.) A finding count has at most nine digits. The file cannot be corrected afterwards, so a mistyped count must not become a verdict without that count.

| Flag | Meaning |
|------|---------|
| `--verdict PASS\|FAIL` | Required. A PASS has no blocker or high findings; a FAIL names at least one finding. |
| `--blocker` `--high` `--medium` `--low` | Finding counts; each defaults to 0. They must match the verdict narrative. |
| `--human operator\|reviewer` | The evaluator is a person, acting as that. |
| `--requested-provider` `--requested-model` `--requested-rank` | The evaluator is a model: what was asked for. All three, or `--human`, never both. |
| `--summary <text>` | Optional short rationale. |
| `--attest <dimension>=<0..5>` | Optional, repeatable: `quality`, `reliability`, `creativity`, `maintainability`, `ux`. |
| `--review <label>` | Write a review round's verdict instead of the run's (see *Review rounds*). |
| `--correlation <pointer>` | The run correlation. Relative pointers are relative to the checkout the run builds in. |
| `--checkout <dir>` | The top level of the checkout the run builds in, when that is not the checkout the command runs in. |

The command prints `{ ok, data, error }`: `data.path` is the file it wrote, relative to the run's checkout, and `data.file` is its full path (what to hand another command), with its SHA-256 and size.

**The run's verdict is refused, and nothing is written, when it could never satisfy strict completion:** a model evaluator with nothing observed, or one the rank policy rejects. The refusal says which, and when nothing was observed, why. The file is written once, so a verdict that cannot pass would leave the run without one that can. Have a person file it (`--human`), run the Evaluator as a session of its own, or re-run it at a rank at or above the builder's.

## Schema (version 2)

```json
{
  "schemaVersion": 2,
  "beadsIssueId": "agent-forge-harness-uam",
  "executionRunId": "uam-verdict-binding",
  "verdict": "PASS",
  "findings": { "blocker": 0, "high": 0, "medium": 2, "low": 1 },
  "summary": "Optional short rationale.",
  "attestations": { "quality": 4, "reliability": 5 },
  "evaluator": {
    "kind": "model",
    "requestedProvider": "claude",
    "requestedModel": "claude-opus-5-5",
    "requestedRank": "master",
    "observedProvider": "claude",
    "observedModel": "claude-opus-5-5",
    "providerEvidence": "selected-direct-transport",
    "modelEvidence": "response-field",
    "rankPolicyDecision": "allowed",
    "rankPolicyRule": "evaluator-at-or-above-builder",
    "sessionId": "0f3c…"
  }
}
```

| Field | Required | Rules |
|-------|----------|--------|
| `schemaVersion` | yes | `2` |
| `beadsIssueId` | yes | The run correlation's Beads issue id |
| `executionRunId` | yes | The run correlation's run id (the Forge run id) |
| `verdict` | yes | `"PASS"` or `"FAIL"` |
| `findings.*` | yes | Non-negative integers: `blocker`, `high`, `medium`, `low` |
| `evaluator` | yes | Who judged: see below. A file without one does not parse. |
| `summary` | no | String |
| `attestations` | no | Integer scores `0..5` for any subset of the five dimensions. Advisory: never blocks ship. Unknown keys are rejected. |

### Evaluator identity

A **human** evaluator is `{ "kind": "human", "actorKind": "operator" | "reviewer" }`.

A **model** evaluator keeps what was requested apart from what ran:

| Field | Meaning |
|-------|---------|
| `requestedProvider`, `requestedModel`, `requestedRank` | What was asked for. Rank is `master`, `journeyman` or `apprentice`. |
| `observedProvider`, `observedModel` | What was observed to run. Read from a machine source the writer did not type. |
| `providerEvidence` | `selected-direct-transport` (the session or CLI that ran the evaluator) or `gateway-routing`. |
| `modelEvidence` | `response-field` (the model the responses reported) or `gateway-routing`. |
| `rankPolicyDecision`, `rankPolicyRule` | `allowed` or `rejected`, and the name of the rule that decided it (lower-case letters, digits and dashes; never free text). |
| `sessionId` | The session the observation was read for. |

Provider, model and session values are short plain text: at most 200 characters, no control characters. They are copied into the gate log and the ledger.

The four observed fields are all present or all absent. When nothing was observed they are absent: a value is never copied from the request.

**Where an observation comes from today:** the model the event ledger has cached for the session working in the worktree `forge:verdict` runs in (the session mirror the SessionStart hook leaves there; the cache is filled from the host's session start and the session's transcript). There is no observation, and the fields are absent, when:

- that worktree has no session mirror, or one older than a day;
- the ledger has no model cached for that session;
- the ledger shows that session building the work: it entered or completed a phase of this run, or of another run whose phase events carry the same Beads id (`forge:phase-gate` records both events; they carry the Beads id the run names with `--bead`, and until one is named the id given as `--epic`). The session that built the work is not an observation of who judged it, and an Evaluator subagent shares its spawner's session;
- the ledger cannot be read to see who built the work.

`gateway-routing` is named by the schema and produced by nothing here.

**Rank policy** (`.claude/protocols/model-tier-policy.md`, *Grader ≥ subject*). A provider and model have a rank through the `rank:*` tag of the smiths configured with them. When smiths of different ranks share a model, the evaluator is read at the lowest and the builder at the highest. The builder is the executor stored on the run's state.

| Situation | Decision | Rule |
|-----------|----------|------|
| Evaluator's rank at or above the builder's | allowed | `evaluator-at-or-above-builder` |
| Evaluator's rank below the builder's | rejected | `evaluator-below-builder` |
| No builder whose rank is known, master evaluator | allowed | `master-evaluator-builder-unknown` |
| No builder whose rank is known, any other evaluator | rejected | `builder-rank-unknown` |
| Evaluator not observed, or its model has no ranked smith | rejected | `evaluator-rank-unknown` |

A fallback that is weaker than what was requested but still at or above the builder's rank is allowed; the verdict records both.

## Strict gate behavior

When `AGENT_FORGE_EVAL_VERDICT=strict`, on a `TaskCompleted` run of the gate:

1. The gate **must** have been given a run correlation: `bun run quality-gate --correlation <pointer>`, or `AGENT_FORGE_RUN_CORRELATION` set by a launcher. Without one the check fails: an uncorrelated run cannot satisfy strict completion.
2. It reads the file at the path the correlation's run id declares, **once**, into one buffer. A path that is, or sits under, a link is refused, as is a file over 64 KiB.
3. From that buffer it requires: schema 2; `beadsIssueId` and `executionRunId` equal to the correlation's; a human evaluator, or a model evaluator that was observed, whose own recorded decision is `allowed`, and whose observed provider and model pass the rank policy as the gate computes it.
4. **`verdict: "PASS"`** → the check passes. **`"FAIL"`** with `blocker > 0` or `high > 0` → it fails. **`"FAIL"`** with only medium/low → it passes (file follow-up beads).
5. A verdict that got through step 3 is **bound**: the gate log entry carries `evaluatorArtifact` (the path, the SHA-256 and byte count of that buffer, both ids and the evaluator), and one `verdict.bound` ledger event carries the same path, digest, size and evaluator. The file is not opened again.
6. That log entry is the record of what satisfied strict completion. If it cannot be appended, a run that bound a verdict **fails**: its result gains a failing `gate-log` check, so what it prints, its `gate.ran` event and its exit code all say blocked. (The ledger events stay best-effort: a ledger that cannot be written is reported and does not block.)

When the variable is unset or not `strict`, the hook does not read the file. A `TeammateIdle` run never reads it, so a passing `TeammateIdle` says nothing about strict completion.

## Review rounds (`forge:review`)

An unattended run reviews each phase, possibly several times, so one run has several round verdicts. A round verdict is written with `--review <label>` (for example `--review plan-2`): the same schema, in the run's directory as `review-<label>.json`, once per label. It is written whatever was observed, and the command reports what a strict gate would object to (`data.evaluatorProblem`).

`bun run forge:review --slug <slug> --phase <phase> --verdict <data.file>` then:

- for a **correlated** run, takes only a schema 2 verdict naming the correlation's bead and run; anything else is recorded `UNREADABLE` and halts the loop;
- for a run with **no correlation**, cannot check a schema 2 verdict against anything and refuses it; it still takes a legacy schema 1 verdict and marks the round as one;
- reads the file once and records its path, digest and size in the `verdict.bound` event;
- reports, without enforcing, when the evaluator would not satisfy strict completion.

So a `verdict.bound` event is not by itself evidence of strict completion: `forge:review` emits one for a round's verdict whatever its evaluator. Strict completion is a linked gate log entry whose `eval-verdict` check passed and which carries `evaluatorArtifact`.

## Legacy verdicts (schema 1)

Schema 1 files (`.tmp/work/<TASK-ID>-verdict.json`, with a `taskId` and no run or evaluator) are still **read** and are labelled legacy wherever they show up:

- The strict gate never reads the old path, and a schema 1 file at the declared path fails the check.
- `forge:review` takes one only for a run with no correlation. The round on the run's state records `verdictSchemaVersion: 1`, the printed review comment ends `; legacy verdict)`, and the ledger event's file reference says schema 1. It carries no evaluator.
- On the dashboard, a gate entry whose verdict check passed with no `evaluatorArtifact` is shown as a **legacy verdict**: not evidence that the run was evaluated.

Nothing writes schema 1 any more.

## Limits

- **The gate checks what the verdict declares; it does not observe the evaluator itself.** The observation is made by `forge:verdict`. A hand-written file can declare anything, like every other file under `.tmp/work`: the directory is the working tree's own and is not protected from the session that works in it. The same goes for the run correlation, the run's state and the smith config the rank check reads.
- **A verdict can call itself human.** The gate takes a human verdict on its actor kind alone. The log entry and the ledger event record that it was a human verdict, so it can be seen.
- **The observation is of a session, never of a subagent.** An Evaluator subagent shares its session with whoever spawned it. When the ledger shows that session building the work, nothing is recorded as observed and strict completion needs a person's verdict or an Evaluator running as a session of its own. When the ledger shows no builder for the work, the writer cannot tell who it is talking to: the filing session's model is recorded as the evaluator's. That is the case for a run with no phase gate, such as one made by `forge:correlate` alone, **including the re-evaluation run this protocol tells you to mint**, unless an earlier run's phase gates were recorded under this same Beads id (`forge:phase-gate --bead`). The documented workflows name the run's issue on their phase-gate writes (`.claude/workflows/forge.md`, *Which bead a phase names*), so the re-evaluation of a documented Forge run is in this case only when it is minted for an issue none of that run's phase events carry: a task in the middle of a multi-task run, for example. There the building session can file a model verdict for its own work and be recorded as a master evaluator of it, and a subagent on a weaker model is recorded as its session's model. Tracked in `agent-forge-harness-5eqw`.
- **The session observed is whichever one's mirror is where the command runs.** The mirror is a file: it can name a session that has ended (it is trusted for a day), and anyone who can write the worktree can put another session's id in it. Without touching it, a command run from another worktree (with `--checkout`) records that worktree's session.
- **The gate looks for the builder where it runs.** When a run builds in another checkout than the one its phase gates ran in, the run's state is not in the checkout the gate runs in, so the gate sees no builder and accepts only a master evaluator or a person. The writer applies the policy the same way.
- **A hard link is not seen as a link.** The reader refuses symbolic links and junctions anywhere on the path. A `verdict.json` that is a hard link to another file is read like any file; what is recorded is still the digest of the bytes read.
- **A run that is rebound after its verdict was filed needs a new run.** `forge:correlate --bead` and `forge:phase-gate --bead` can point a run at another Beads issue. The verdict already filed names the earlier issue, the gate refuses it, and the run's one place is taken.
- **A writer that dies part-way leaves a scratch file.** The verdict is written beside its place (`.verdict.json.<pid>.<stamp>.tmp`) and linked in, so `verdict.json` is whole or absent and the run is not blocked. The scratch file stays; the sweep leaves it, and that run's directory, alone.

## Cleanup

`bun run tmp:cleanup` sweeps these files under the same closed-bead and age rule as other `.tmp/work` files (`.claude/protocols/tmp-work-ttl.md`), and only a file it can validate, whose digest the event ledger already holds.

## Related

- `.claude/agents/evaluator.md` — verdict steps and severity definitions
- `.claude/protocols/evaluation-rubric.md` — dimensions and skepticism rules
- `.claude/protocols/model-tier-policy.md` — ranks and grader ≥ subject
- `.claude/workflows/feature.md` — Step 8 Evaluator review, acting on verdict
- `scripts/eval-verdict.ts`, `scripts/eval-verdict-store.ts`, `scripts/eval-verdict-cli.ts` — schema, the file's one writer and reader, the command
