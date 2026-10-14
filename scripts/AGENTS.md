# AGENTS.md — scripts

Local agent guidance for this directory.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Keep edits focused on files within this subtree.
- Follow repository-level quality gates before shipping.

## Notes

- Add directory-specific conventions here (build/test commands, ownership, constraints).
- A CLI checks that it is the entry point with `if (isMain(import.meta))` from `is-main.ts`, not `if (import.meta.main)`. Bun sets `import.meta.main` to false when `bun run` gets a relative path from a cwd spelled with a Windows 8.3 short name, and the CLI then exits 0 having done nothing. `is-main.test.ts` fails if a script or hook checks `import.meta.main` itself.
