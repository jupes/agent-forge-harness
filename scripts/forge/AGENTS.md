# AGENTS.md — scripts\forge

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.
- `runs.ts`, `phases.ts` and `review-rules.ts` are bundled for the browser: no Node built-in and no import from `scripts/ledger/`. `review-rules.ts` imports only `./phases`.
- Ledger events are emitted from `ledger-events.ts`, which only the CLIs load, through a dynamic import inside their entry block (`if (isMain(import.meta))`). `phase-gate.ts`, `auto-loop.ts` and `runs-cli.ts` keep no static ledger import, because hooks and tests import their pure exports.
- `forge:review` appends `verdict.bound` (the verdict file as read, once, with its path, digest and size; `unreadable` when it could not be parsed or is not this run's) and then `review.recorded` (the decision) for every round. A correlated run takes only a schema 2 verdict naming its correlation's bead and run, and both rows of a round whose verdict was taken are filed under those ids (a refused round is filed under the run's own attach); a run with no correlation has no round graded: any verdict, schema 2 or legacy schema 1, is recorded `unreadable`. `verdictOfRun` returns only a schema 2 verdict, so nothing after it handles schema 1.
- `forge:phase-gate` reads its command line strictly (`parseGateArgs`): a flag it does not know, a flag given twice, a value flag with no value, a value still in its `<placeholder>` brackets and a `--mode` that is not one are refused, in both the `--flag value` and `--flag=value` forms, on an entry check as on a write. A write must never record a run without the bead it meant to name. Two things it does not refuse: the flags only a write uses (`--feature`, `--epic`, `--checkout`) are read and unused on an entry check, and a `--bead` the correlation store does not accept as a Beads id is reported on stderr while the run keeps the correlation it had (`scripts/run-correlation-launchers.test.ts`).
- `forge:review` reads its command line the same strict way (`parseReviewArgs`: an unknown flag, a flag given twice, a value flag with no value, a placeholder value and a word that is no flag's value are refused, in both forms), refuses a verdict file whose SHA-256 a round of the run was already graded from (`verdictSha256` on the round, `roundRecordedFrom`), for any phase, and refuses a verdict of the run that does not name the round it would record, `<phase>-<round>` with the round from `nextRoundOf` (`roundLabelProblem`: another round, another phase, or none). All three refusals exit 2 with `ok: false` and record nothing: no round, no ledger row, no handoff. Rounds recorded before the digest was stored carry none, so a file graded by one of them is not recognised.
- An `UNREADABLE` round stores why its verdict was unusable (`verdictError`, through `storedVerdictError` in `review-rules.ts`: one line, capped, with the one parser message that echoes evaluator-written text, an unknown attestations key, stored without it, and a verdict of another run or bead stored as "names another run" or "another bead" through `verdictOfRun`'s `cause`, not with the ids it names), and `decideNext` builds the halt reason from it; `runs.ts` cleans it again when it reads a state file. A round without it keeps the generic reason. The ledger rows are unchanged: `review.recorded` carries no text.
- `forge:runs` reads its command line strictly too (`parseRunsArgs`): an unknown flag, a flag given twice or given a value, a word after `list` or after the run `show` / `remove` names, and `--active` on `show` or `remove` are refused with exit 2 before anything is listed or removed.
- `forge:phase-gate --smith <name>` resolves the name through `scripts/config` (`resolveSmith`, the lookup `forge:exec` uses) into the executor it records. `executorFromFlags` stays pure: the smiths config arrives as a loader, called only when a smith is named, so a config that cannot be read never fails a call without the flag.
- Whether an auto run may move on is `reviewGate` and nothing else. There is no stored "halted" flag: a halt is the latest review round's recorded decision.

## Notes

- Add directory-specific conventions here (build/test commands, ownership, constraints).
