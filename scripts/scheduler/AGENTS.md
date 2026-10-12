# AGENTS.md — scripts/scheduler

What decides which work may run, and beside what. Today it holds three things: the file map, the
approval queue and the worktree registry. Nothing here starts work: no bead is claimed, and the only
process spawned is git, by the registry.

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
  of one process wait in a line and only its head asks SQLite, 50 to 100 ms apart. A caller whose
  turn comes after its deadline answers busy without an attempt.
- A writer that does not take this lock (a hand edit, a process given another lock file, another
  machine) is not serialized, and it is found only when it leaves something other than the target:
  the write is confirmed as exactly one queue label, the target, with `queue_state` the target, and
  anything else is `conflict` or `unknown` with no event and no compensating write. One that makes
  the same move at the same time leaves exactly the target, so it is not found; when both writers
  are `queue.ts` (two lock files), the move is recorded twice.
- `queue_state` and `queue_resume` are trusted as written: metadata set by hand is read as the
  queue's own. A process that ends between the `bd update` and the append leaves the move made with
  no `bead.transitioned` for it.
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

## The worktree registry (`worktrees.ts`)

- `git worktree list --porcelain -z`, run in the main checkout, is the source of truth. `-z` is used
  because lock and prune reasons are free text. `<main>/trees/.state.json` is a cache of what git
  does not know about a worktree `create` made: its id, when it was made, its bead and the session
  that made it. A cached worktree git does not list is reported `missing`, not hidden.
- The cache is trusted only for what `create` could have written. A record is kept only when its id is a
  plain name and its path is `<main>/trees/<id>`, so a record that names any other path can never
  make `remove` reach a worktree this module did not make.
- A cache larger than 1 MB, or one that does not parse, is not read for a listing and not written
  over. `create` is refused before git makes anything.
- A write reads the cache again just before writing and replaces it whole through a temporary file.
  There is no lock: two writers in the same instant can still lose one record. That record's worktree
  is then listed without an id, and `git worktree remove` removes it by hand.
- Paths are compared through `comparablePath` only (`realpathSync.native` and
  `comparableCheckout`). git prints `C:/Users/...`, Node prints backslashes or the 8.3 short form,
  and drive letters compare without case.
- git is run with argument arrays (`gitRun`), never a shell, and a path goes after `--`. Reads use a
  5 s limit, because the hearth answers other routes on the same thread. A git failure is an error,
  never an empty list. A directory that is not the top of a repository has no worktrees: git asked
  from such a directory answers for a repository further up, such as the OS home's.
- A read writes nothing. A worktree's bead is the cache's, else the newest forge run whose
  `checkout` is that worktree. Run states are read from the main checkout and every worktree with
  `parseState`, never through `listRuns`, which migrates legacy state.
- `create`:
  - Refuses before anything is made: a name that is not a new branch (`check-ref-format --branch`
    must print the name back, and `@` and a leading `-` are refused), a bead or session id that is
    not one, a repository whose own ignore rules do not cover `trees/<id>`, and the OS home.
  - Branches from the HEAD of the checkout it runs in.
  - If git made the branch and then failed, the branch is deleted. No `git worktree prune`: it would
    touch other sessions' worktrees.
- `remove`:
  - Takes only an id from the cache, so the desktop app's and hand-made worktrees are never removed.
  - Without `force`, git refuses a worktree with changes, and the record stays.
- No ledger event is emitted (`reservation.*` belongs to `x1gs.5.3`). The stash warning
  (`STASH_WARNING`) is printed by `create` and `list`.
- `worktrees.test.ts` and `scripts/worktree.test.ts` use real git in scratch repositories whose
  paths have spaces. Each gets its own `git init`, a local user and a `.gitignore` listing `trees/`.
  Roots stay short (`mkdtemp(tmpdir(), "wt ")`), because git fails on very long paths.
