# AGENTS.md — scripts/scheduler

What decides which work may run, and beside what, and the shift that runs it. Today it holds: the
file map, the approval queue, the worktree registry, reservations with eligibility, and `forge:shift`.
Only the shift starts work, and only through `runExec` (`scripts/executors/`); every other module
here starts nothing. The other processes spawned are git (the registry, and the shift's base and
pull request step), gh (`pr create`, by the shift only) and `bun run pr:check`.

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
- `filemap-cli.ts` refuses a file that has a `Checkpoint` heading unless it is told what the file
  is: `--plan` reads each checkpoint, and `--description` reads it as one task's description, the
  way `--bd-json` reads the stored one.
- In a plan, a heading of level two or deeper above a checkpoint's level ends the checkpoint even
  inside a fence, so a fence the parser reads wrong never hands a checkpoint a plan-level `Files`
  section. A level-one `# …` line inside a fence does not end it: there it is a shell comment.
- `reservations.ts` and `eligibility.ts` consume file maps (below).

## The queue (`queue.ts`, `queue-lock.ts`, `queue-reconcile.ts`)

- A bead's queue state is one `queue:<state>` label on the bead. Beads is where it lives; the ledger
  records each move and is never read back to find a state. Beads `status` is read once (a closed
  bead is not started) and never written.
- `QUEUE_TABLE` (`queue-table.ts`, pure and safe in a browser bundle; `queue.ts` re-exports it) is the only place that says which moves are legal and who may make them. `operatorMoves(entry)` is what the dashboard's Workbench offers from it: the operator's approve, queue, pause and resume, and reassign where a smith may change; nothing for an unbacked label or a bead with two queue labels. A move is
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
- A `bd` call with no exit status is "`bd` could not be started, nothing was changed" only when
  `neverStarted` says so (the runtime's own message for a missing program, whole). Anything else
  with no exit status is `failed` on the read and `unknown` on the write, and the answer says the
  call was stopped before it answered or never started, not which: a call killed at the runner's
  limit and one the runtime could not spawn for another reason (its working directory gone, which
  Bun reports as `ENOENT: no such file or directory, uv_spawn 'bd'`) look alike here.
- A label counts as a state only when the queue wrote it. Every write sets metadata `queue_state`
  to the same state in the same call, because `bd create --parent` copies the parent's labels onto
  the child and not its metadata. A label with no such backing (inherited, or added by hand) is
  refused for every action but `propose`, which puts the bead in the queue as `proposed`. So queue
  state is not inherited, and neither is approval (decision 5, amended by `x1gs.5.7`): a child of an
  approved or queued bead reaches `approved` only by an operator's `approve` of that child.
  `queue.test.ts` tries every move from a child of a parent in each state until nothing new is
  reached; keep it when changing the table or the backing. Read only the issue's own top-level
  `labels` and `metadata`: `bd show` of a child also prints its parent's metadata, under
  `dependencies`.
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
  queue's own. A process that ends between the `bd update` and the append leaves the move (or the
  reassign) made with no `bead.transitioned` for it.
- `bun run forge:queue reconcile` (`queue-cli.ts` over `queue-reconcile.ts`) finds both afterwards.
  Under the queue lock it reads the list `GET /queue` makes (`QUEUE_LIST_ARGS`) and the workspace's
  `bead.transitioned` events, takes the moves (events without `action`), and walks each bead's moves
  as a chain: each starts where the one before ended (the first from outside the queue), and the
  last ends at the state the queue wrote on the bead now (`queueStateOf`; an unbacked label or two
  labels is no state). A link that does not hold is a `gap` (`recorded`, `found`, the ledger ids
  around it, and after the last move the bead's queue labels), or a `duplicate` when the two moves
  have the same `from` and `to`: the move recorded twice, or a move back between them that was not
  recorded, which the ledger cannot tell apart. It only reports. It writes nothing to Beads or to
  the ledger and makes up no event for a move made earlier: Beads holds the state, and a backfilled
  event would be history nobody recorded. Not found: moves `forge:audit --compact` removed (the
  oldest left is reported as a gap before it).
- Reconcile also compares the smith on each bead the list printed with the one its newest recorded
  reassign named, and reports a `smith` drift where they differ (`recorded` null: none recorded;
  `found` null: the bead carries none). It reads the workspace's `operator.action` rows too: with
  `askedEvent`, a `queue.reassign` row for the bead naming the smith found was stored after that
  reassign, so the operator API asked for it and the ledger missed the reassign. Without it, nothing
  asked for that smith through the operator API: set by hand, or by a writer that stores no audit
  row, which the ledger cannot tell apart. The row is stored before the reassign is made, so a
  request `bd` refused followed by the same smith set by hand reads as a missed reassign. Not
  compared: a bead the list did not print, and one whose newest reassign was recorded before the
  event named its smith.
- `reassign` records a smith as the bead's `smith` metadata, which is where smith resolution reads
  a bead's preference (`smithFor`, and section 9 of the architecture). It moves no state. Once `bd`
  confirmed the write, it appends `bead.transitioned` `{ action: "reassign", smith }` under the lock,
  the tracker-write form with no `from` or `to`, so that a page or a stream client that reads `/queue`
  again on that event finds the new smith, and reconcile can compare the smith on the bead. `complexityOf` and `smithFor` are pure: the `complexity:low|medium|high` label
  picks the bench, and a bead without one gets `workflow.default_crew`.
- `bd list --label queue:queued` prints the beads a shift may pick plus two kinds that `start`
  refuses, both made outside the queue: an inherited or hand-added label, and a bead with a second
  queue label. `QUEUED_EXACT_ARGS` is the `bd list` that prints exactly the pickable set, and
  `pickable` is the same rule over the whole answer of `GET /queue`.
- Tests are hermetic: `queue-fixture.ts` is an in-memory tracker that answers the queue's `bd` calls
  (`show` of one id or several, label/metadata `update`, and the `list` shapes of `GET /queue` and
  eligibility, via `answerQueueList`) as bd 1.1.0 was measured to; the browser suite's `bd` stand-in
  answers through it too, and the ledger and the lock are in temp directories. The shift's
  `comments add --json -- <id> <text>` is answered by `answerComment`, apart from `answer`, so the
  stand-in (which answers the hearth's comments itself) is not changed by it; the text is kept on
  the bead (`comments`). It answers no `create`: `childOf(parent, id)` makes a child as
  `bd create --parent` does (every label of the parent, none of its metadata); build inherited
  children with it, not by hand.
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
    not one, a start point that names no commit (empty, a leading `-`, whitespace, or
    `rev-parse --verify --quiet <ref>^{commit}` in the main checkout fails), a repository whose own
    ignore rules do not cover `trees/<id>`, and the OS home.
  - Branches from the request's `startPoint` when it has one (the shift gives the base commit it
    fetched), else from the HEAD of the checkout it runs in (`bun run worktree`).
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

## Reservations and eligibility (`reservations.ts`, `eligibility.ts`, `reservations-cli.ts`)

- A bead reserves the file map of its description, else of its acceptance criteria. A map that is
  missing, empty or malformed reserves `**`, and the reason travels with it (`conservative`).
- `globsOverlap` never misses an overlap in the file-map dialect, and may report one that only a
  different case or normalization form of a name gives:
  - It compares code points (so `?` is one character, also outside the BMP), folds case one
    character at a time as the lower case of the upper case (σ ς Σ meet), drops `.` segments, and
    compares the globs in NFC, in NFD and as written, each against each: a file name on disk may
    be in any of them.
  - A glob whose last segment has no wildcard covers what is under it.
  - A glob longer than 1024 characters, or with a segment longer than 255, is not compared: it
    overlaps everything, and a map holding one reserves `**`. The brute-force test in `reservations.test.ts`
    checks that no overlap is missed over ASCII paths; beyond ASCII, point tests cover it. Keep
    both when changing the matcher.
- `reserve` / `release` take the queue lock (the same file as queue moves, `queue-lock.db` in the
  harness home), read `activeReservations` and append `reservation.acquired|released`. The worktree
  is stored as `comparablePath` (lowercased on Windows). A release repeats the held event's worktree
  and globs exactly, because the ledger folds on those strings. Join stored worktrees to the registry
  only through `comparablePath`.
- `eligibility` is pure:
  - **Order:** `planBundles` layers over `blocks`/`requires` edges, then priority, then natural
    id. Beads in progress are walked first (they are running, and claim their current map before
    any other check), then beads that hold a reservation (they have in effect started), then the
    rest. A bead in progress never names a bead it waits on.
  - **No circles:** a bead is checked only against claims made before it in the walk, plus the
    reservations of beads outside the queue, so no two beads wait on each other. What a bead holds
    always claims.
  - **A holder whose map changed** since it reserved waits ("release and reserve again"). Two
    holders whose reservations overlap, which only a write past the lock can make, both wait and
    name no one.
  - `eligibility-invariants.test.ts` checks these over 3000 random queues from a fixed seed; keep
    it when changing the walk.
  - **Claims:** every bead that can run or is running (eligible, waiting on an overlap, or
    `in_progress`) claims its globs as it is passed, so nothing jumps an earlier bead.
  - **What claims nothing:** a blocked bead (not ready, not in progress), a bead held back only by a
    busy host, and a queued epic, except for what any of them already holds: a reservation always
    claims. A blocked bead with no reservation therefore never holds back its own blocker.
  - **Stale:** reservations of closed or deleted beads, ignored and reported.
- `readEligibility` and the CLI run bd in the main checkout (`localStateRoot`). A bd failure is an
  error, never an empty queue. `bd show` answers for partial ids, so only rows with exactly the asked
  id count. Exit 1 with "no issues found" means all the asked ids are gone.
- **Not covered:**
  - A reservation outlives a shift that dies holding it. `forge:reservations list` shows it and
    `release` frees it.
  - **A deadlock that is not resolved:** a queued bead that holds a reservation but is blocked by
    another queued bead whose map overlaps it. The blocker waits on the holder (`waitsOn` names
    it) and the holder waits on its blocker in Beads. Release the holder's reservation by hand.
  - `forge:reservations reserve` exists for by-hand use and demos. `forge:shift` reserves through
    the module function.
  - `reserve` does not ask bd whether the bead holding a conflicting reservation is closed. Read
    `forge:eligible` first, or release the stale one.
  - Host sampling (CPU and memory against the 85% default) is `host-load.ts`, called by the shift;
    eligibility only takes "busy".

## The shift (`shift.ts`, `shift-pr.ts`, `shift-store.ts`, `host-load.ts`, `shift-cli.ts`)

- `runShift` composes the modules above and repeats none of them: `readEligibility` says what may
  start, `createQueue(...).move(id, action, "scheduler")` moves a bead (`start` is the claim, then
  `submit`, `release` or `halt`), `reserve` / `release` claim and free its file map, the registry
  makes its worktree, and each run is `runExec` with an `AbortSignal`. Every outside call is a
  dependency (`ShiftDeps`: bd, git, gh, `pr:check`, the worktree maker, the host sampler);
  `shiftCliDeps` builds the real ones.
- The base: before anything else (no record, no event, no bd call) `fetchBase` runs
  `git fetch --no-tags origin +refs/heads/<base>:refs/remotes/origin/<base>` in the main checkout
  and resolves that ref to a commit. `base` is `--base`, default `master`: plain branch name parts,
  never `HEAD` and never a `shift/` branch (`isBaseBranch`). A base that cannot be fetched starts
  nothing (exit 1). The commit is pinned for the whole shift (`baseSha` on the record): every
  worktree starts there, whatever the checkout the shift runs in has checked out.
- Order for a bead: `start`, then its smith (`--smith`, else `smithFor` on the bead's own labels and
  metadata), then `reserve` for `<main>/trees/<shift-id>-<n>`, then the worktree (branch
  `shift/<shift-id>/<bead>`, from the base commit), then the started comment, then the runs. A step
  that fails gives back what the steps before it took (the reservation, the bead to `queued`) and
  sets the bead aside for the rest of the shift. The reservation is released in a `finally` after
  the runs (and the pull request step), whatever happened, and the end comment is posted after it.
  The worktree is kept: it holds the work.
- Runs: a success is `submit` (to `review`), then the pull request step. A failure is repaired, the
  next run told how the one before ended, up to `repairs` more runs, then `halt`. A run stopped by
  the shift, or timed out at the shift's deadline, is `release` (back to `queued`). A run `runExec`
  refused before starting the provider is released at once, with no repair. Each run gets
  `--timeout-ms` of the time left (or `runTimeoutMs` when that is less), so a run never outlives the
  shift. The pull request step is not bounded by the deadline; git and gh each have a 2 minute
  limit.
- The pull request step (`openDraftPr`, decision 7), only for a bead `submit` moved to `review`,
  each check a refusal before the next: the bead id is one (`isBeadId`) and the branch is exactly
  `shift/<shift-id>/<bead>` and not the base; the worktree is the directory the registry made, a
  plain directory (not a link) whose real path is exactly `<main>/trees/<id>` (kind `worktree`);
  it has commits after the base commit (`git log <baseSha>..refs/heads/<branch>`). The body is the
  run's `.tmp/work/pr-body.md` in the worktree (the prompt asks for it), else one the shift builds
  with the template's six sections, which says the run left no body and claims no test evidence.
  The run's body must be a file of the worktree's own: a symbolic link, a hard link (more than one
  name), a path whose real path leaves the worktree (a junction on `.tmp` or `.tmp/work`), or a
  file swapped between the check and the open (device and file id compared) is refused, never
  read. It is read once, into memory. The title and the body are then scanned with
  `redactSecrets`; anything found refuses the step as a `body` failure that names only the kinds.
  The text is written to a fresh file the shift owns, outside every worktree
  (`<home>/shifts/<shift-id>/<bead>-XXXXXX/pr-body.md`: `mkdtemp`, then `wx`), and that one path
  is what `bun run pr:check` reads and gh posts, so nothing done to the worktree afterwards changes
  what is checked or posted. The copies are kept beside the shift's record; that directory and its parent must be plain directories (a link is refused before `mkdtemp`, which spins forever under Bun on a junction). Then
  `git push --porcelain --no-follow-tags --recurse-submodules=no origin <sha>:refs/heads/<branch>`
  (the commit the branch named when it was listed and scanned, `rev-parse` before `git log`, so a commit added later is not pushed; the destination named in full, so no `remote.*.push` refspec applies; no tag whatever
  `push.followTags` says; no force, no upstream written to the shared config,
  `GIT_TERMINAL_PROMPT=0`) and
  `gh pr create --draft --base=<base> --head=<branch> --title=<bead>: <title> --body-file=<body>`,
  both run, like the `git log`, in the main checkout and never in the worktree: the branch is a ref
  of the repository they share, so a worktree swapped for a link after the checks cannot point git
  or gh at another repository. The worktree is only checked and its body read. The URL gh prints
  goes on the record entry (`prUrl`, and `prBody`: `run` or `shift`). Never merged, never marked
  ready, no step retried.
- A pull request step that fails leaves the bead in `review` and the shift going: `error` on its
  entry says `pull request: <kind>: <what git or gh said>` (secrets redacted, at most 300
  characters), and its end comment gives the fixed sentence `PR_FAILURES[kind]`.
- Comments: one `worklog:` comment when a bead starts (shift, run id, smith, worktree, branch) and
  one when it ends (`after <n> run(s): <outcome>.` and a fixed reason from `SHIFT_ENDINGS`, the PR
  link or `PR_FAILURES`, or the queue state the operator left it in). Each is one
  `bd comments add --json -- <id> <text>`, never repeated, confirmed by the comment bd prints on the
  issue. A comment that fails is written on the entry (`commentError`) and stops nothing. A bead set
  aside before its worktree was made never started and gets none. What a provider, git or gh printed
  never goes in a comment; it stays on the record.
- Bounds: concurrency, `forMs`, `maxBeads` (beads that ran, not beads set aside) and `maxUsd` (the
  sum of `session.ended` usage `costUsd`; a run that reports no cost adds nothing and is counted in
  `unpriced`). The count and the spend stop admission; runs in flight finish, so the spend can be
  overshot by them. A busy host (`host-load.ts`) pauses admission and never stops the shift.
- Stopping: the deadline (`elapsed`), the stop request file or the in-process signal (`operator`),
  nothing running with the count reached (`count`) or the spend reached (`budget`), nothing running
  and nothing eligible (`drained`), three failed eligibility reads in a row or a failure of the loop
  itself (`halted`). On every one, each run is aborted and awaited, its bead released and its
  reservation freed, before `shift.stopped`. `shift.started` comes before anything else, and a
  ledger that does not store it starts nothing.
- A bead the operator pauses or halts while it runs is found by reading each running bead back
  every `pollMs`; its run is stopped, its reservation freed, and its queue state left as the
  operator put it (`left`). Resuming a paused `running` bead returns it to `running` with nothing
  running it; no shift picks it up again.
- Each bead's events carry its run id (`<bead>-<shift-id>`, else `<shift-id>-<n>`): the moves and
  reservations through an `appendEvent` that adds it, the session through `--run`. `forge:audit
  --run <id>` shows one bead from claim to release, and `forge:audit --shift <id>` shows the whole
  shift: its `shift.started` and `shift.stopped` and the events of every run id above, found from the
  ledger by that naming alone (`scripts/ledger/AGENTS.md`). A change to the naming here changes what
  `--shift` finds; `scripts/ledger/audit-cli.test.ts` builds its ids with `shiftRunId` to catch it.
  An operator's stop request (`operator.action`, `shift.stop`) is not part of that answer.
- `shift-store.ts`: the record `<home>/shifts/<id>.json` (a report, never read back to decide) and
  the stop request `<id>.stop`, written by `requestStop` for `forge:shift stop` and
  `POST /shifts/:id/stop`. Same home as the hearth, or the hearth cannot see or stop the shift.
- Never merges, and pushes nothing but a bead's own shift branch, by the shift itself. The run's
  prompt tells it not to push, open a pull request or merge, and the Claude adapter's tool
  allowlist has no `git push` and no `gh`.
- **Not covered:**
  - A shift that dies (Ctrl-C, a crash, a kill): the supervisor kills its runs' process trees, but
    their beads stay `running` and their reservations held. `forge:reservations release` and the
    operator's queue actions are the way out; prefer `forge:shift stop`.
  - The shift does not run `bd update --claim`; the run's own workflow does.
  - A base that moves during a shift is not fetched again; a remote other than `origin`.
  - Uncommitted changes in a worktree are not in its pull request, and nothing says so.
  - The secret scan covers the PR title and body only: the branch's files and its full commit
    messages are pushed without one (the shift's own body lists only the first 50 subjects).
  - No `POST /shifts`.
- Tests: `shift.test.ts` drives the loop with the queue fixture (and `answerQueueList` for the list
  shapes), a temp ledger, lock and home, plain directories as worktrees, a git and a gh that record
  their calls and answer as the test says, and a fake adapter whose runs the test scripts. Its kill
  test runs the Claude adapter on the fake binary behind a guard that refuses a spawn without the
  override. `shift-pr.test.ts` runs the base and the pull request step with real git on a scratch
  repository whose origin is a bare repository in the OS temp dir, and the real `pr:check`.
  `shift-cli.test.ts` runs one shift end to end with the real registry and real git in such a
  repository (the checkout on a feature branch, origin ahead of it) and the fake binary. No test
  runs a real provider or the real `gh`, or reaches the real remote: every test's gh is a function.
