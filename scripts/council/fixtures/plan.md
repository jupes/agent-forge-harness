# Plan fixture: rename account display name

Goal: rename `accounts.display_name` to `accounts.label` with zero downtime across a rolling deployment. Readers and writers must continue working throughout deployment, and rollback must be possible.

Proposed steps:
1. Drop the `display_name` database column and add `label` as NOT NULL.
2. Deploy new application pods that read and write `label`.
3. Terminate old application pods once new pods are healthy.

Current code evidence:
```ts
// Old pods remain active during step 2.
await database.query('SELECT display_name FROM accounts WHERE id = $1', [id]);
```

No backfill, dual-read/write transition, data copy, or rollback path is described. The database supports transactional schema changes; transaction support alone does not make old application queries compatible.
