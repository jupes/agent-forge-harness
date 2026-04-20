# `.tmp/work` TTL — wisps vs durable beads (MO-02)

`.tmp/work/*` holds **wisps**: short-lived, session-local artifacts (alignment docs, verdict JSON, planning notes, session handoff). `.tmp/` is gitignored; nothing in it is authoritative.

Durable truth lives in **Beads**: issues, AC, priorities, comments, dependencies.

This file defines the default retention so long-running harness usage does not accumulate stale wisps from closed or abandoned work.

## Rules

1. **Never commit `.tmp/work`** — enforced via `.gitignore`.
2. **Per-task wisps** follow the task: `.tmp/work/<TASK-ID>-*.md` / `.json`.
   - `alignment.md` — Lead/Worker/Evaluator agreed scope.
   - `verdict.json` — Evaluator output (see `evaluation-verdict.md`).
   - `plan.md` — Worker plan (feature workflow).
3. **Cross-cutting wisps** use a stable name:
   - `session-handoff.md` — next-session pickup.
   - `<EPIC-ID>-interfaces.md` — shared contracts.
4. **Default TTL is 14 days** since `mtime` for `<TASK-ID>-*` files whose Beads task is **closed**. Open/in-progress tasks are **never** swept automatically.
5. Cross-cutting files (`session-handoff.md`, `<EPIC-ID>-interfaces.md`) are **not** swept — operator deletes them when a milestone completes.

## Cleanup script

```bash
bun run tmp:cleanup              # dry-run listing + JSON envelope (default)
TTL_DAYS=30 bun run tmp:cleanup  # override retention
bun run tmp:cleanup --apply      # actually delete (only with explicit flag)
```

Safety:

- The script only touches `.tmp/work/<ID>-*` where `<ID>` matches a **closed** Beads issue id.
- `--apply` is required to delete. Without it, the script prints what it **would** remove.
- `<EPIC-ID>-interfaces.md` and `session-handoff.md` are always skipped.

## Wisps vs durable — quick table

| Signal | Wisp (`.tmp/work`) | Durable (Beads) |
|--------|--------------------|-----------------|
| Lifetime | Single task / short epic | Full work lifecycle |
| Storage | Gitignored files | Dolt-backed ledger |
| Authoritative | No | Yes |
| Swept automatically | Yes (closed tasks, TTL) | No |
