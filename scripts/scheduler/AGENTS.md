# AGENTS.md — scripts/scheduler

What decides which work may run, and beside what. Today it holds one thing: the file map.

- `filemap.ts` is pure: text in, globs or a typed refusal out. It reads no file, asks Beads nothing
  and knows no repository. Keep it that way; callers fetch the description.
- The format is documented where authors meet it, in `.claude/skills/forge-plan/SKILL.md`, and that
  skill's template and `references/example-plan.md` are parsed in `filemap.test.ts`. Change the
  format in all three or the test fails.
- The parser refuses rather than guesses: one line that is not a glob refuses the whole map. What a
  missing, empty or invalid map means for a task (for example reserving everything) is the caller's
  decision and is not made here.
- Nothing consumes a file map yet. Reservations and eligibility are not in this directory.
