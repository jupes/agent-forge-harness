# AGENTS.md — scripts/scheduler

What decides which work may run, and beside what. Today it holds one thing: the file map.

- `filemap.ts` is pure: text in, globs or a typed refusal out. It reads no file, asks Beads nothing
  and knows no repository. Keep it that way. `filemap-cli.ts` is the only part that reads a file (or
  standard input); its logic is `runFileMapCli`, tested with an injected reader.
- The glob dialect is small on purpose: `*` inside one path segment, `**` for any number of
  segments, `?` for one character, every other character for itself (brackets included), and no
  `{a,b}` alternation. A consumer that hands these globs to a library must not let the library read
  more into them than that.
- The format is documented where authors meet it, in `.claude/skills/forge-plan/SKILL.md`, and that
  skill's template and `references/example-plan.md` are parsed in `filemap.test.ts`. Change the
  format in all three or the test fails.
- The parser refuses rather than guesses: one line that is not a glob refuses the whole map, and a
  line is judged as the glob it becomes once its bullet, backticks and `./` are dropped. What a
  missing, empty or invalid map means for a task (for example reserving everything) is the caller's
  decision and is not made here.
- A task's description must reach the parser as it was written: `bd show <id> --json`, field
  `description`. Plain `bd show` renders Markdown and garbles a glob that holds `*`.
- Nothing consumes a file map yet. Reservations and eligibility are not in this directory.
