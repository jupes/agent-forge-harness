# `.tmp/work` TTL — wisps vs durable beads (MO-02)

`.tmp/work/*` holds **wisps**: short-lived, session-local artifacts (alignment docs, verdict JSON, session handoff). `.tmp/` is gitignored; nothing in it is authoritative.

Durable truth lives in **Beads**: issues, AC, priorities, comments, dependencies.

This file defines the default retention so long-running harness usage does not accumulate stale wisps from closed or abandoned work.

## Rules

1. **Never commit `.tmp/work`** — enforced via `.gitignore`.
2. **Per-task wisps** follow the task: `.tmp/work/<TASK-ID>-*.md` / `.json`.
   - `alignment.md` — Lead/Worker/Evaluator agreed scope.
   - `verdict.json` — a legacy (schema 1) Evaluator verdict. Nothing writes these any more; see
     `evaluation-verdict.md`.
   - Worker plans are durable artifacts in `plans/drafts/`, not `.tmp/work/`.
3. **Cross-cutting wisps** use a stable name:
   - `session-handoff.md` — next-session pickup.
   - `<EPIC-ID>-interfaces.md` — shared contracts.
3a. **Per-run wisps** follow the run: `.tmp/work/run-correlations/<runId>.json` (which Beads issue a run works on)
    and `.tmp/work/evaluations/<sha256 of the run id>/` (that run's evaluator verdict, `verdict.json`, and its review
    rounds, `review-<label>.json`; see `evaluation-verdict.md`).
4. **Default TTL is 14 days** since `mtime` for `<TASK-ID>-*` files whose Beads task is **closed**. Open/in-progress tasks are **never** swept automatically. Evaluator verdicts under `evaluations/` follow the same rule, by the Beads issue the verdict names, and are removed only once the event ledger holds their digest.
5. Cross-cutting files (`session-handoff.md`, `<EPIC-ID>-interfaces.md`) are **not** swept — operator deletes them when a milestone completes.

## Cleanup script

```bash
bun run tmp:cleanup                           # dry-run listing + JSON envelope (default)
TTL_DAYS=30 bun run tmp:cleanup               # override retention
bun run tmp:cleanup --apply                   # actually delete (only with explicit flag)
bun run tmp:cleanup --apply --allow-fallback  # delete even when bd did not answer (see below)
```

Safety:

- The script only touches `.tmp/work/<ID>-*` where `<ID>` matches a **closed** Beads issue id, and evaluator
  verdicts under `.tmp/work/evaluations/`.
- Which issues are closed comes from the live tracker (one `bd export`). Only when bd does not answer does the
  script use `.beads/issues.jsonl`, which may be older than the tracker: it says so on stderr before anything is
  removed, and the envelope's `data.source` names the file, when it was last written and why bd was not used.
  With neither, nothing is swept.
- On that file's statuses `--apply` removes nothing: the run is a dry run, `data.apply` is `false` and
  `data.dryRunReason` says why. A bead reopened since the file was written would otherwise lose its files. Pass
  `--allow-fallback` as well to delete by the file anyway; the warning still comes first.
- An evaluator verdict is removed only when all of this holds: it is where the path rule puts verdicts, with no link
  on the way; its bytes are a schema 2 verdict whose run id hashes to the directory it is in; the Beads issue it names
  is closed and the file is older than the TTL; and the event ledger holds a `verdict.bound` for that run with the
  file's SHA-256. Until the ledger holds it, the file is the only copy of that evidence. A run's directory is removed
  only by the sweep that emptied it; anything else found there is left alone. Evaluations are swept only when the
  script runs at the top level of a checkout.
- Run correlation files are not swept.
- `--apply` is required to delete. Without it, the script prints what it **would** remove.
- `<EPIC-ID>-interfaces.md` and `session-handoff.md` are always skipped.

## Wisps vs durable — quick table

| Signal | Wisp (`.tmp/work`) | Durable (Beads) |
|--------|--------------------|-----------------|
| Lifetime | Single task / short epic | Full work lifecycle |
| Storage | Gitignored files | Dolt-backed ledger |
| Authoritative | No | Yes |
| Swept automatically | Yes (closed tasks, TTL) | No |
