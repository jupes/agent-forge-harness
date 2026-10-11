# AGENTS.md — scripts/scheduler

What decides which work may run, and beside what. Today it holds two things: the file map and the
approval queue. Nothing here starts work: no process is spawned and no bead is claimed.

## The file map

- `filemap.ts` is pure: text in, globs or a typed refusal out. It reads no file, asks Beads nothing
  and knows no repository. Keep it that way. `filemap-cli.ts` is the only part that reads a file (or
  standard input); its logic is `runFileMapCli`, tested with an injected reader.
- The glob dialect is small on purpose: `*` inside one path segment, `?` for one character, a
  segment that is exactly `**` for any number of segments, every other character for itself
  (brackets included), and no `{a,b}` alternation. A consumer that hands these globs to a library must not let the library read
  more into them than that.
- The format is documented where authors meet it, in `.claude/skills/forge-plan/SKILL.md`, and that
  skill's template and `references/example-plan.md` are parsed in `filemap.test.ts`. Change the
  format in all three or the test fails.
- The parser refuses rather than guesses: one line that is not a glob refuses the whole map, and a
  line is judged as the glob it becomes once its bullet, backticks and `./` are dropped. What a
  missing, empty or invalid map means for a task (for example reserving everything) is the caller's
  decision and is not made here.
- A task's description must reach the parser as it was written: `bd show <id> --json`, field
  `description` (`filemap-cli.ts - --bd-json` takes that output as it is). Plain `bd show` renders
  Markdown and garbles a glob that holds `*`; the garbled form is refused, because it puts `**`
  inside a segment.
- Nothing consumes a file map yet. Reservations and eligibility are not in this directory.

## The queue (`queue.ts`, `queue-lock.ts`)

- A bead's queue state is one `queue:<state>` label on the bead. Beads is where it lives; the ledger
  records each move and is never read back to find a state. Beads `status` is read once (a closed
  bead is not started) and never written.
- `QUEUE_TABLE` is the only place that says which moves are legal and who may make them. A move is
  an action (`propose`, `approve`, `queue`, `start`, `submit`, `complete`, `rework`, `release`,
  `pause`, `resume`, `halt`) taken by an actor (`operator`, a person through the hearth's rows;
  `scheduler`, a shift or an auto-task). It encodes decision 5: work enters as `proposed`, only an
  operator's `approve` moves it on, only approved or queued work becomes `running`, and the
  scheduler starts only what is `queued`. Add a move by adding a row, and add its pair to the table
  written out again in `queue.test.ts`: that test walks every pair of states and fails for a row it
  was not told about.
- `createQueue(deps).move(id, action, by)` is the one function that moves a bead: validate the id,
  take the lock, read with `bd show --readonly --json -- <id>`, check the table, write with one
  `bd update` (every value as `--flag=value`, the id after `--`), confirm from what `bd` printed,
  append `bead.transitioned` `{ from, to, reason: "<action>:<actor>" }`. The event is appended
  before the lock is released. A refusal names the current state and every move allowed from it,
  and writes nothing. Do not write a queue label anywhere else.
- A label counts as a state only when the queue wrote it. Every write sets metadata `queue_state`
  to the same state in the same call, because `bd create --parent` copies the parent's labels onto
  the child and not its metadata. A label with no such backing (inherited, or added by hand) is
  refused for every action but `propose`, which puts the bead in the queue as `proposed`. So queue
  state is not inherited. Read only the issue's own top-level `labels` and `metadata`: `bd show` of
  a child also prints its parent's metadata, under `dependencies`.
- A bead with two queue labels, or a `queue:` label that is not a state, is in no state: every
  action is refused and the message says how to take it out by hand. Any by-hand removal of a queue
  label must also unset `queue_state` and `queue_resume`, or a label put back later would count as
  the queue's.
- `pause` records where the bead was (`queue_resume`) and `resume` returns it there and removes the
  key. A paused bead with no usable `queue_resume` is refused on resume.
- Never send `--remove-label=X --add-label=X`: `bd` adds before it removes and the bead is left
  with no label. Removing a label that is not there is silent. `--add-label=a,b` is two labels.
- `bd` has no compare-and-set for labels, and nothing it prints tells the second of two writers it
  was second (measured: two processes making the same move both print exactly the target). So the
  read, the check and the write happen under `withQueueLock`: a `BEGIN EXCLUSIVE` transaction on a
  small SQLite file, `queue-lock.db` in the harness home. The operating system drops it when the
  holder's process ends, so there is no stale lock and nothing to take over. It is one lock for all
  queue moves, and it serializes only the processes given the same file: a shift must be given the
  hearth's (`AGENT_FORGE_HOME`). A failed attempt costs about 30 ms of synchronous time, so callers
  of one process wait in a line and only its head asks SQLite, 50 to 100 ms apart.
- A writer that does not go through `queue.ts` (a hand edit, another machine) is not serialized.
  It is found after the fact: the write is confirmed as exactly one queue label, the target, with
  `queue_state` the target, and anything else is `conflict` or `unknown` with no event and no
  compensating write.
- `reassign` records a smith as the bead's `smith` metadata, which is where smith resolution reads
  a bead's preference (`smithFor`, and section 9 of the architecture). It moves no state and appends
  no transition. `complexityOf` and `smithFor` are pure: the `complexity:low|medium|high` label
  picks the bench, and a bead without one gets `workflow.default_crew`.
- `bd list --label queue:queued` prints the beads a shift may pick plus two kinds that `start`
  refuses, both made outside the queue: an inherited or hand-added label, and a bead with a second
  queue label. `QUEUED_EXACT_ARGS` is the `bd list` that prints exactly the pickable set, and
  `pickable` is the same rule over the whole answer of `GET /queue`.
- Tests are hermetic: `queue-fixture.ts` is an in-memory tracker that answers the queue's two `bd`
  calls as bd 1.1.0 was measured to, and the ledger and the lock are in temp directories.
  `queue-bd.test.ts` compares that fixture with a real `bd` and walks the machine on it; it is
  skipped unless `AGENT_FORGE_SCRATCH_TRACKER` names a scratch tracker (its own git repository, no
  remote of either kind), and is run by hand after any change to the `bd` calls or the fixture.
  `queue-lock.test.ts` starts real `bun` processes: the file is its own child.
