# AGENTS.md Workflow

Use this workflow to validate and scaffold `AGENTS.md` files at repository root and nested folders up to depth 2.

## Scope

- Includes: root (`.`), depth 1 folders, depth 2 folders.
- Excludes: hidden/system/runtime directories (for example `.git`, `.beads`, `.tmp`, `node_modules`, `repos`, `trees`).

## Step 1 — Validate Coverage

```bash
bun run agents-md validate
```

Output is structured JSON:
- `missingCount`: number of folders missing `AGENTS.md`
- `missingDirs`: relative directories that need files

## Step 2 — Scaffold Missing Files

If validation reports gaps, scaffold templates:

```bash
bun run agents-md scaffold --write
```

This creates `AGENTS.md` only in missing directories within depth 2.

## Step 3 — Review Templates

Each scaffolded file includes:
- local scope statement
- local rules section
- notes section for directory-specific constraints

Customize as needed for the directory's build/test ownership.

## Step 4 — Re-Validate

```bash
bun run agents-md validate
```

`missingCount` should be `0`.

## Step 5 — Ship

Run repository gates before shipping:

```bash
bun run typecheck
bun run lint
bun test
```
