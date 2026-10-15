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

# A model Evaluator that ran as a subagent, filed by the session that spawned it
bun run forge:verdict --correlation <pointer> --verdict PASS --low 1 \
  --requested-provider claude --requested-model claude-opus-5-5 --requested-rank master \
  --subagent <agent id>
```

`<pointer>` is the run correlation's pointer: `data.correlation.pointer` from `forge:phase-gate … --write --bead <TASK-ID>`, or from `bun run forge:correlate --bead <TASK-ID> [--run <slug>]`. A launcher can set `AGENT_FORGE_RUN_CORRELATION` instead. The Beads id and the run id in the file are the correlation's; there is no flag for either, and none for what was observed.

Every argument is one of the flags below, written `--flag value` or `--flag=value`, and given once (`--attest` may repeat). **Anything else is refused and nothing is written**: an unknown flag, a flag with no value, a flag followed by something that looks like a flag where its value should be, a repeated flag or attestation dimension, a stray word. Anything that starts with two dashes and has no whitespace before its first `=` looks like a flag, whatever its name is made of (`--high_count=1`, `--high:1`). (Text that itself looks like a flag has to be given as `--summary=<text>`.) A finding count has at most nine digits. The file cannot be corrected afterwards, so a mistyped count must not become a verdict without that count.

| Flag | Meaning |
|------|---------|
| `--verdict PASS\|FAIL` | Required. A PASS has no blocker or high findings; a FAIL names at least one finding. |
| `--blocker` `--high` `--medium` `--low` | Finding counts; each defaults to 0. They must match the verdict narrative. |
| `--human operator\|reviewer` | The evaluator is a person, acting as that. |
| `--requested-provider` `--requested-model` `--requested-rank` | The evaluator is a model: what was asked for. All three, or `--human`, never both. |
| `--subagent <agent id>` | The model evaluator ran as that subagent of the session working where the command runs: its own model is what is observed. The spawning session has the id (the Agent tool gives it back); the subagent's own environment does not. Letters, digits, dashes and underscores; not with `--human`. |
| `--summary <text>` | Optional short rationale. |
| `--attest <dimension>=<0..5>` | Optional, repeatable: `quality`, `reliability`, `creativity`, `maintainability`, `ux`. |
| `--review <phase>-<round>` | Write a review round's verdict instead of the run's (see *Review rounds*). The phase is `research`, `plan`, `implement` or `ship`, and the round a positive integer: `plan-2`. Anything else is refused. |
| `--correlation <pointer>` | The run correlation. Relative pointers are relative to the checkout the run builds in. |
| `--checkout <dir>` | The top level of the checkout the run builds in, when that is not the checkout the command runs in. |

The command prints `{ ok, data, error }`: `data.path` is the file it wrote, relative to the run's checkout, and `data.file` is its full path (what to hand another command), with its SHA-256 and size.

**The run's verdict is refused, and nothing is written, when it could never satisfy strict completion:** a model evaluator with nothing observed, or one the rank policy rejects. The refusal says which, and when nothing was observed, why. The file is written once, so a verdict that cannot pass would leave the run without one that can. Have a person file it (`--human`), name the subagent that judged (`--subagent`), run the Evaluator as a session of its own, or re-run it at a rank at or above the builder's.

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
| `verdict` | yes | `"PASS"` or `"FAIL"`. A PASS counts no blocker or high finding, and a FAIL counts at least one finding: a file that says otherwise does not parse, in either schema, so it never satisfies strict completion. |
| `findings.*` | yes | Non-negative integers: `blocker`, `high`, `medium`, `low` |
| `evaluator` | yes | Who judged: see below. A file without one does not parse. |
| `summary` | no | String |
| `attestations` | no | Integer scores `0..5` for any subset of the five dimensions. Advisory: never blocks ship. Unknown keys are rejected. |
| `review` | no | Only in a review round's verdict: its round, `<phase>-<round>`, as given to `--review`. Anything else there does not parse. The run's own verdict has none: the writer puts a verdict in a round's file only when it names that round, and in the run's file only when it names none, and the strict gate refuses a `verdict.json` that names a round. |

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
| `sessionId` | The session the observation was read for: for a subagent, `<session>:<agent id>`, as the hooks key it. |

Provider, model and session values are short plain text: at most 200 characters, no control characters. They are copied into the gate log and the ledger.

The four observed fields are all present or all absent. When nothing was observed they are absent: a value is never copied from the request.

**Where an observation comes from today:** the model the event ledger has cached for the session working in the worktree `forge:verdict` runs in (the session mirror the SessionStart hook, or `forge:exec` for its child, leaves there), or with `--subagent` for that subagent of it. The cache is filled from machine sources only:

- for a session, the host's session start and the session's transcript;
- for a subagent, its own assistant records: the hooks read the ones carrying its agent id, in its own transcript (`<session>/subagents/agent-<agent id>.jsonl` beside the session's `<session>.jsonl`, the layout seen on Claude Code 2.1.295) or in the transcript the hook payload names, from its first tool call on;
- for a `forge:exec` run, the model the provider's stream says its responses came from: the Claude adapter reads an assistant message's `message.model`. The Codex stream, as recorded, names no model, so a Codex run has none.

There is no observation, and the fields are absent, when:

- that worktree has no session mirror, or one older than a day;
- the ledger has no model cached for that session, or with `--subagent` none of that subagent's own (its session's model is never taken in its place);
- without `--subagent`, the ledger has cached a subagent of that session on another model than the session's own: the command cannot tell whether that subagent is the one filing;
- the ledger shows that session building the work: it entered or completed a phase of this run, or of another run whose phase events carry the same Beads id (`forge:phase-gate` records both events). A phase event carries the `--bead` of its own write; without one, the `AGENT_FORGE_BEAD_ID` of the environment it ran in (`forge:exec` sets it for its child); without that, the Beads id the run kept from its last `--bead`; and until any is named, the run's `--epic`. The session that built the work is not an observation of who judged it, and an Evaluator subagent shares its spawner's session. With `--subagent` it is the subagent's own key the ledger is asked about: its session building the work does not stop it being observed;
- the ledger cannot be read to see who built the work, or which subagents the session ran.

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
3. From that buffer it requires: schema 2, with a verdict word its counts agree with and no review round named (see *Schema*); `beadsIssueId` and `executionRunId` equal to the correlation's; a human evaluator, or a model evaluator that was observed, whose own recorded decision is `allowed`, and whose observed provider and model pass the rank policy as the gate computes it.
4. **`verdict: "PASS"`** → the check passes. **`"FAIL"`** with `blocker > 0` or `high > 0` → it fails. **`"FAIL"`** with only medium/low → it passes (file follow-up beads). A PASS that counts a blocker or high finding, or a FAIL that counts none, never gets here: it does not parse, and the check fails with the parser's reason.
5. A verdict that got through step 3 is **bound**: the gate log entry carries `evaluatorArtifact` (the path, the SHA-256 and byte count of that buffer, both ids and the evaluator), and one `verdict.bound` ledger event carries the same path, digest, size and evaluator. The file is not opened again.
6. That log entry is the record of what satisfied strict completion. If it cannot be appended, a run that bound a verdict **fails**: its result gains a failing `gate-log` check, so what it prints, its `gate.ran` event and its exit code all say blocked. (The ledger events stay best-effort: a ledger that cannot be written is reported and does not block.)

When the variable is unset or not `strict`, the hook does not read the file. A `TeammateIdle` run never reads it, so a passing `TeammateIdle` says nothing about strict completion.

## Review rounds (`forge:review`)

An unattended run reviews each phase, possibly several times, so one run has several round verdicts. A round verdict is written with `--review <phase>-<round>` (for example `--review plan-2`): the same schema, naming its round in `review`, in the run's directory as `review-<phase>-<round>.json`, once per round. `<round>` is the round `forge:review` will record: one more than the rounds of that phase the run has recorded, an `UNREADABLE` round included (`bun run forge:review --slug <slug> --ledger` lists them). Because it names its round, two rounds' verdicts are never the same bytes, even two clean PASS verdicts with no summary. It is written whatever was observed, and the command reports what a strict gate would object to (`data.evaluatorProblem`).

`bun run forge:review --slug <slug> --phase <phase> --verdict <data.file>` then:

- for a **correlated** run, takes only a schema 2 verdict naming the correlation's bead and run; anything else is recorded `UNREADABLE` and halts the loop;
- for a run with **no correlation**, has nothing to check any verdict against: a schema 2 verdict and a legacy schema 1 verdict alike are recorded `UNREADABLE`, with the `forge:correlate` command that correlates the run. A run with no correlation has no round graded until it is correlated;
- refuses, and records nothing, a verdict of the run that does not name the round it would record (`<phase>-<round>`: the `--phase` it was given and that phase's next round number): one naming another round or another phase, and one naming none (the run's own verdict, or a round verdict filed before `forge:verdict` wrote its round into the file). The refusal names the round it expected and the `forge:verdict --review` line that files it;
- reads the file once and records its path, digest and size in the `verdict.bound` event, and the digest on the round;
- refuses, and records nothing, a file whose digest a round of the run was already graded from, whatever its path and whichever phase it is given for: a verdict grades one round. A round verdict names its round, so a file refused this way is an earlier round's verdict given again, never a second honest verdict that happens to have the same bytes: no `--summary` is needed to tell two rounds' verdicts apart;
- records the round `UNREADABLE` (a halt) when its model evaluator was **observed** on a provider and model that rank below the builder's (the rank policy's `evaluator-below-builder`, from the configured smiths and the run's recorded builder): a grader known to be weaker grades nothing. `data.verdictError` says so, and says the fix: a re-review with an evaluator of the builder's rank or above;
- stores, on every `UNREADABLE` round, why its verdict was unusable (`verdictError` on the round: one line of the cause `data.verdictError` prints, except that an unknown attestations key and the run or bead id a mismatched verdict names are left out, because the evaluator chose them: it says "the verdict names another run" or "another bead" and gives the run's own ids), and the halt reason is built from it: `The review of "<phase>" returned no usable verdict, so the run cannot grade itself: <cause>.` The run's state, `forge:runs`, the Stop reminder and the halt handoff therefore name the cause. A round recorded before this was stored keeps the generic reason;
- reports, without enforcing, anything else that would keep the evaluator from satisfying strict completion (`data.evaluatorProblem`): nothing observed, an observed model no ranked smith uses, a builder whose rank is unknown, a verdict that recorded its own rejection. That round is graded on its findings.

So a `verdict.bound` event is not by itself evidence of strict completion: `forge:review` emits one for a round's verdict whenever its evaluator is not observed to rank below the builder. Strict completion is a linked gate log entry whose `eval-verdict` check passed and which carries `evaluatorArtifact`.

## Legacy verdicts (schema 1)

Schema 1 files (`.tmp/work/<TASK-ID>-verdict.json`, with a `taskId` and no run or evaluator) are still **read** and are labelled legacy wherever they show up:

- The strict gate never reads the old path, and a schema 1 file at the declared path fails the check.
- `forge:review` grades no round from one: a schema 1 verdict names no run, so the round it is given for is recorded `UNREADABLE`, for a correlated run and for a run with no correlation alike (see *Review rounds*). A round recorded from one before that still says so: the round on the run's state records `verdictSchemaVersion: 1`, and the ledger event's file reference says schema 1. It carries no evaluator.
- On the dashboard, a gate entry whose verdict check passed with no `evaluatorArtifact` is shown as a **legacy verdict**: not evidence that the run was evaluated.

Nothing writes schema 1 any more.

## Limits

- **The gate checks what the verdict declares; it does not observe the evaluator itself.** The observation is made by `forge:verdict`. A hand-written file can declare anything, like every other file under `.tmp/work`: the directory is the working tree's own and is not protected from the session that works in it. The same goes for the run correlation, the run's state and the smith config the rank check reads.
- **A verdict can call itself human.** The gate takes a human verdict on its actor kind alone. The log entry and the ledger event record that it was a human verdict, so it can be seen.
- **A subagent is observed only when it is named, and only once it has called a tool.** An Evaluator subagent shares its session with whoever spawned it, and its environment carries that session's id and no agent id of its own, so it cannot name itself: its spawner files for it with `--subagent <agent id>`, and the subagent's own model is recorded. `--subagent` is typed: the spawner can name any subagent of its session that has a cached model, and the ledger cannot show which one judged, nor which one built the work (a phase gate run from a subagent is recorded under the session it shares). Without `--subagent`, a session is not taken as the evaluator once the ledger has cached a subagent of it on another model; but a subagent's model is cached only after its first tool call, so a subagent whose first tool call files the verdict is not seen, and is recorded as its session's model when the ledger shows no builder. Tracked in `agent-forge-harness-kxjr`.
- **Without `--subagent`, the observation is of a session.** When the ledger shows that session building the work, nothing is recorded as observed and strict completion needs `--subagent`, a person's verdict or an Evaluator running as a session of its own. When the ledger shows no builder for the work, the writer cannot tell who it is talking to: the filing session's model is recorded as the evaluator's. That is the case for a run with no phase gate, such as one made by `forge:correlate` alone, **including the re-evaluation run this protocol tells you to mint**, unless an earlier run's phase events carry this same Beads id (from a write's `--bead`, the `AGENT_FORGE_BEAD_ID` it ran with, the id its run kept, or its run's `--epic`: see the list above). The documented workflows name the run's issue on their phase-gate writes (`.claude/workflows/forge.md`, *Which bead a phase names*), so the re-evaluation of a documented Forge run is in this case only when it is minted for an issue none of that run's phase events carry: a task in the middle of a multi-task run, for example. There the building session can file a model verdict for its own work and be recorded as a master evaluator of it, and a subagent on a weaker model that the ledger has not seen yet is recorded as its session's model.
- **The session observed is whichever one's mirror is where the command runs.** The mirror is a file: it can name a session that has ended (it is trusted for a day), and anyone who can write the worktree can put another session's id in it. Without touching it, a command run from another worktree (with `--checkout`) records that worktree's session.
- **The gate looks for the builder where it runs.** When a run builds in another checkout than the one its phase gates ran in, the run's state is not in the checkout the gate runs in, so the gate sees no builder and accepts only a master evaluator or a person. The writer applies the policy the same way.
- **A hard link is not seen as a link.** The reader refuses symbolic links and junctions anywhere on the path. A `verdict.json` that is a hard link to another file is read like any file; what is recorded is still the digest of the bytes read.
- **A run that is rebound after its verdict was filed needs a new run.** `forge:correlate --bead` and `forge:phase-gate --bead` can point a run at another Beads issue. The verdict already filed names the earlier issue, the gate refuses it, and the run's one place is taken.
- **A writer that dies part-way leaves a scratch file.** The verdict is written beside its place (`.verdict.json.<pid>.<stamp>.tmp`) and linked in, so `verdict.json` is whole or absent and the run is not blocked. The scratch file stays until the sweep removes it, once it is older than the TTL (see *Cleanup*). It is never a verdict: a writer killed before the link filed nothing from it, and one killed after it left a second name for the bytes `verdict.json` already holds.

## Cleanup

`bun run tmp:cleanup` sweeps these files under the same closed-bead and age rule as other `.tmp/work` files (`.claude/protocols/tmp-work-ttl.md`), and only a file it can validate, whose digest the event ledger already holds. A writer's scratch file in a run's directory goes on its age alone, once it is older than the TTL; a run's directory goes when the sweep has emptied it.

## Related

- `.claude/agents/evaluator.md` — verdict steps and severity definitions
- `.claude/protocols/evaluation-rubric.md` — dimensions and skepticism rules
- `.claude/protocols/model-tier-policy.md` — ranks and grader ≥ subject
- `.claude/workflows/feature.md` — Step 8 Evaluator review, acting on verdict
- `scripts/eval-verdict.ts`, `scripts/eval-verdict-store.ts`, `scripts/eval-verdict-cli.ts` — schema, the file's one writer and reader, the command
