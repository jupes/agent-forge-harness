---
name: migrate-to-shoehorn
description: Replace unsafe TypeScript test-fixture assertions with Shoehorn helpers. Use for a requested assertion migration or partial and invalid test fixtures.
---

# migrate-to-shoehorn

Use this skill to migrate **test code only** from TypeScript `as` assertions to `@total-typescript/shoehorn` helpers.

Shoehorn is for tests, fixtures, and test-only helpers. Do not recommend it for production or source files, and do not add `@total-typescript/shoehorn` imports outside `*.test.*` or `*.spec.*` files.

## Install

Install Shoehorn only when the target repository does not already depend on it, and use the package manager already used by that repository:

```bash
# bun.lock or bun.lockb
bun add -d @total-typescript/shoehorn

# pnpm-lock.yaml
pnpm add -D @total-typescript/shoehorn

# yarn.lock
yarn add -D @total-typescript/shoehorn

# package-lock.json or npm-shrinkwrap.json
npm install --save-dev @total-typescript/shoehorn
```

Do not switch package managers. If multiple lockfiles exist, ask which package manager owns the repo before installing.

## Find Candidate Tests

Search only test files and review every result manually:

```bash
rg "\bas\s+[A-Z][A-Za-z0-9_$]*(<[^>]+>)?" --glob "*.{test,spec}.{ts,tsx}"
rg "\bas\s+unknown\s+as\s+" --glob "*.{test,spec}.{ts,tsx}"
```

Avoid broad replacements. Migrate one assertion at a time so the new helper matches the test intent.

Before choosing a helper, read [migration patterns](references/patterns.md). Check the installed package declarations for supported exports.

## Workflow

1. Confirm the target files are tests (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx`).
2. Check whether `@total-typescript/shoehorn` is already installed.
3. If installation is needed, use the existing package manager from the repo lockfile.
4. Search for candidate assertions with the `rg` commands above.
5. Replace `value as Type` with `fromPartial(value)` when the supplied data is partial but type-valid.
6. Replace `value as unknown as Type` with `fromAny(value)` when the supplied data is intentionally invalid.
7. Use `fromExact()` only for full-shape fixtures or short-lived migration steps.
8. Add the narrowest import needed from `@total-typescript/shoehorn`.
9. Run the target test file, the repo test suite, and the typecheck command.

## Validation

After migrating, run the repository's normal checks. For a Bun-based repo, use:

```bash
bun run typecheck
bun test
```

Verify Shoehorn remains test-only:

```bash
rg "@total-typescript/shoehorn"
rg "@total-typescript/shoehorn" --glob "!*.{test,spec}.{ts,tsx}"
```

The first command should show only intended test imports. The second command should return no source-file imports; if it finds any, remove Shoehorn from production/source code and fix the underlying type boundary instead.
