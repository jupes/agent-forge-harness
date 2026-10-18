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
- `QUEUE_TABLE` (`queue-table.ts`, pure and safe in a browser bundle; `queue.ts` re-exports it) is the only place that says which moves are legal and who may make them. `operatorMoves(entry)` is what the dashboard's Workbench offers from it: the operator's approve, queue, pause and resume, and reassign where a smith may change; for an unbacked label, what the table allows from outside the queue, which is propose (`x1gs.5.10`); nothing for a bead with two queue labels. A move is
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
  key, except that a bead paused from `running` resumes to `queued` (`resumeTarget`, `x1gs.5.4.4`):
  after a pause nothing runs it, and a shift starts it again from `queued`. So only `start` leads
  into `running`, and a value of `running` already on a bead is read the same way. `GET /queue`
  answers an entry's `resume` as where it goes (`queued` for `running`). A paused bead with no usable
  `queue_resume` is refused on resume.
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
  queue label. `QUEUED_EXACT_ARGS` is the `bd list` that prints the pickable set, and
  `pickable` is the same rule over the whole answer of `GET /queue`. Neither can leave out a bead
  whose second `queue:` label is not a state (`queue:teleported`, added by hand): `bd` matches
  `--exclude-label` literally, and `GET /queue` makes entries only for state labels. `start`
  refuses such a bead, so `readEligibility` (`GET /eligibility` and every shift) drops it from the
  listing's rows with `pickableRow` (`x1gs.5.9`); a reservation it holds then counts as one outside
  the queue. Any other reader of the listing must do the same.
- Tests are hermetic: `queue-fixture.ts` is an in-memory tracker that answers the queue's `bd` calls
  (`show` of one id or several, label/metadata `update`, and the `list` shapes of `GET /queue` and
  eligibility, via `answerQueueList`) as bd 1.1.0 was measured to; the browser suite's `bd` stand-in
  answers through it too, and the ledger and the lock are in temp directories. The shift's
  `comments add --json -- <id> <text>` is answered by `answerComment`, apart from `answer`, so the
  stand-in (which answers the hearth's comments itself) is not changed by it; the text is kept on
  the bead (`comments`). It answers no `create`: `childOf(parent, id)` makes a child as
  `bd create --parent` does (every label of the parent, none of its metadata); build inherited
  children with it, not by hand. The two stand-ins that answer `create` use it too (`x1gs.5.8`):
  the hermetic hearth's `fakeBd` (`scripts/hearth/testing.ts`, for a parent in its `issues`) and
  the browser suite's stand-in.
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
- Given `shiftsDir` (a shift gives its own; `forge:reservations reserve` by hand does not), `reserve`
  also refuses, as `conflict`, a bead that a worktree of another shift still holds while that shift
  has not stopped (`heldByShift`: its record says running, its process alive or not, or no record
  of it is read). This is where a second run of one bead is stopped (`x1gs.5.4.13`, the shift
  section): a shift reserves a run's worktree before the run and releases it only after, and starts
  no run without it, so of two shifts that both claimed a bead only one can run it. Not refused: a
  worktree made outside any shift, another worktree of the asking shift, and a stopped shift's
  leftover (it wrote `stopped` only once every run had ended). The check reads one record and asks
  after one pid per such hold, under the queue lock. A worktree is a shift's only when it is
  directly under `<main>/trees/` and named `<shift-id>-<n>` (`shiftOfWorktree`): one by hand with
  such a name anywhere else (`<main>/<name>`, `<main>/trees/x/<name>`, `<main>/trees-old/<name>`)
  is not, and `reservations.test.ts` checks it (it fails when the name alone is matched).
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
  - **An earlier run that may not have ended** (`x1gs.5.4.13`): a queued bead that holds a
    reservation in a shift's worktree (`<main>/trees/<shift-id>-<n>`, `shiftOfWorktree`) waits until
    that reservation is released, with `waitsOnShift` naming the shift, unless the shift's record
    says it stopped. A pause and a resume can both land before the shift running the bead reads it
    back (the queue section), leaving it `queued` while that run goes on; a shift releases a run's
    reservation only once the run has ended, so the bead waits exactly as long as the run can. This
    is the operator's view, and it keeps shifts from trying a bead `reserve` would refuse them
    (the guard itself is `reserve`, above). The `why` follows the shift's standing
    (`shiftStanding`): live, its earlier run "has not ended", and how to free the reservation by
    hand (`forge:reservations release <bead> <worktree>`) once the operator knows that shift is
    gone, since a pid the system gave to another program reads as live (and `forge:shift recover`
    refuses it as alive); dead (its process ended without stopping it), `forge:shift recover <id>`
    frees it; no record read (another harness home, or a reader given no `shiftsDir`), how the
    reservation is freed. The check comes after the epic, host and blocked checks and before every
    other; what the bead holds has claimed already, so nothing jumps it, and every other bead is
    answered as it would be without the shifts (`eligibility-invariants.test.ts` checks both).
  - A shift's own read is not exempt: its own bead in that state waits too, which changes nothing
    it does, since a shift never starts a bead twice (`setAside`), and keeps one answer for every
    reader.
  - A stopped shift's leftover reservation (its release failed in its `finally`; the record entry
    says `reservation: …`) holds nothing back: a shift writes `stopped` only once every run it
    started has ended. `forge:reservations release` frees it.
  - A reservation made outside any shift (`forge:reservations reserve`, by hand) holds its bead back
    no more than before: the bead is walked with the holders and may start, the shift reserving its
    own worktree beside it (`reserve` skips the same bead). That is safe only as far as the person
    who made it: the harness runs nothing in such a worktree and cannot tell whether anyone does, and
    nothing would ever release it if it held the bead back. Who reserves a bead by hand and also
    queues it decides that it runs.
- `readEligibility` and the CLI run bd in the main checkout (`localStateRoot`). A bd failure is an
  error, never an empty queue. `bd show` answers for partial ids, so only rows with exactly the asked
  id count. Exit 1 with "no issues found" means all the asked ids are gone. With `shiftsDir`
  (`<home>/shifts`; the shift, the hearth and `forge:eligible` pass it) it reads one record, and
  asks after one pid, per shift whose worktree holds a queued bead's reservation.
- **Not covered:**
  - A reservation outlives a shift that dies holding it until `forge:shift recover` frees it (the
    shift section). `forge:reservations list` shows it and `release` frees one by hand.
  - **A deadlock that is not resolved:** a queued bead that holds a reservation but is blocked by
    another queued bead whose map overlaps it. The blocker waits on the holder (`waitsOn` names
    it) and the holder waits on its blocker in Beads. Release the holder's reservation by hand.
  - `forge:reservations reserve` exists for by-hand use and demos. `forge:shift` reserves through
    the module function.
  - `reserve` does not ask bd whether the bead holding a conflicting reservation is closed. Read
    `forge:eligible` first, or release the stale one.
  - Host sampling (CPU and memory against `[shift] throttle`, which the shift passes on each
    call) is `host-load.ts`, called by the shift; eligibility only takes "busy".

## The shift (`shift.ts`, `shift-pr.ts`, `shift-store.ts`, `shift-recover.ts`, `host-load.ts`, `shift-cli.ts`)

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
- A queue move of the shift's own after the claim (`submit`, `release`, `halt`, the give-back of an
  admit that failed included) that fails as `failed` or `unknown` (bd failed, or ended with no exit
  status: killed, as a terminal's Ctrl-C kills the shift's own `bd` on Linux and macOS) is made
  again, `SETTLE_TRIES` (3) times in all, `SETTLE_RETRY_MS` (200 ms) apart (`x1gs.5.4.16`).
  - **Bounded:** all tries share `SETTLE_RETRY_BUDGET_MS` (4 s), including the first. It caps their
    queue-lock wait and every bd call they make (the runner's `timeoutMs`), and no try starts once
    it is spent. This also bounds a stop arriving while the first try is in flight: that try no
    longer has the lock's 10 s wait or bd's 30 s per-call limit. Retry sleeps add at most 400 ms.
  - **Not after `busy`:** that answer has already waited the whole lock wait, so the lock is
    stuck. Three such tries (about 30.4 s) would outlast the CLI's 30 s Ctrl-C grace
    (`INTERRUPT_GRACE_MS`) and end the process 130 with its record `running`.
  - **Never blindly:**
    - The move reads the bead under the queue lock before it writes, so a bead an earlier try did
      move is no longer `running`, and the try is refused without writing.
    - Each later try writes only while the ledger says this run still owns the bead. The check is
      `ownedOnly` in `shift-recover.ts`, recovery's own guard on `runOwnership`, read inside the
      lock just before the write. A bead another run started meanwhile is left to that run, and
      the try writes nothing.
  - **A try the queue refused** reads the bead back:
    - Found at the move's target (`review`, `queued`, `halted`) with no queue move recorded since
      this run's start, an earlier try wrote it although bd did not confirm it. The move counts:
      the entry gets the move's outcome, and a `submit` goes on to its pull request step. That
      move has no `bead.transitioned`, a gap `forge:queue reconcile` reports.
    - Found anywhere else, it is left there, and the end comment says where it was found.
    - If the read-back fails after a refusal, the end comment says it was not running when the
      queue refused it, with its exact state unreadable; it never claims it may still be running.
  - **Final:** a bead gone and a conflict.
  - **What the entry says:** its `error` lists each try. A move that never went through ends
    `left`, and its end comment names the reason: another run's start (`SHIFT_ENDINGS.takenAfter`),
    the state the bead was found in, or `unmoved`. Unless another run's start took the bead, or it
    was found elsewhere, the entry also says the bead may still be `running` with no run, and that
    a pause and a resume put it back in `queued`.
  - **Ownership is the ledger's word:**
    - A start of this run whose `bead.transitioned` was not stored (the move answered
      `recorded: false`) leaves an older move as the newest. Every try after the first is then
      vetoed, which fails safe: the bead is left as a ledger that cannot be read leaves it.
    - The other way round: the ledger can still name this run, a stale owner, while the bead is
      another run's. That needs two moves with no event. First the bead leaves `running` with no
      event: an operator's move whose append failed, or an earlier try of this run whose write
      bd did not confirm. Then another run starts it, and that start's append fails too. A later
      try of this run then takes the bead from that run. Recovery's rule has the same gap.
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
- Where each bound comes from: the option `runShift` was given (a `forge:shift run` flag), else
  the config's `[shift]` (`concurrency`, `for`, `max_beads`, `max_usd`, `repairs`), else its
  builtin; the host threshold is `[shift] throttle`. `runShift` loads the config first, from
  `deps.root` with the exec home and env (the load each run's `forge:exec` makes), and a config
  that does not load refuses the shift before anything is fetched or written. The record's
  `options` carry the values that applied, `throttle` included, and `shift.started` the five
  bounds; neither says where each came from: `bun run forge:config show` does
  (`scripts/config/AGENTS.md`). The builtins and the bounds live in `scripts/config/defaults.ts`
  (`BUILTIN_SHIFT`, `SHIFT_LIMITS`, `SHIFT_MAX_USD`, `SHIFT_THROTTLE`): `--for` up to 24h,
  `concurrency` 1 to 8, `maxBeads` 1 to 100, `maxUsd` above 0 and up to 1000, `repairs` 0 to 10,
  `throttle` 0.1 to 1. `SHIFT_DEFAULTS`, `LIMITS` and the usage line here read them, and
  `shiftOptions` uses the loader's checks, so a flag and `[shift]` out of bounds are refused in
  the same words after the name: `--for` / `shift.for` (`shiftLength`): `expected a duration of
  at most 24h`; `--max-beads` reaches `shiftOptions` as `maxBeads` / `shift.max_beads`:
  `expected a whole number from 1 to 100`. Only a caller that gives `forMs` itself (not the CLI)
  gets the whole-number words for it. `POST /shifts` passes only the fields its body gave as
  flags, so the child applies `[shift]` to the rest (`scripts/hearth/routes/shifts.test.ts`:
  "only the fields the body gave become flags").
- A bad `[shift]` (or any section that does not load) in the workspace or the machine file
  stops every config reader, not just the next shift: `forge:config`, every `forge:exec` (each
  run of a shift included), `forge:doctor --task`, the phase gate's executor flags, the auto loop,
  `eval-verdict`, and the hearth's `GET /config`, `GET /smiths` and `POST /queue/:id/reassign`.
  An edit by hand that breaks the file while a shift runs makes each later run's `forge:exec`
  refuse before its provider starts: the shift releases each such bead to `queued` unrun, and
  ends `drained` once nothing is left. Fix the file (`bun run forge:config show` names the file
  and key; `forge:config set` refuses a bad value before writing), check with `forge:queue` that
  the beads it let go are `queued` (re-queue any that are not), and start a new shift.
- Stopping: the deadline (`elapsed`), the stop request file or the in-process signal (`operator`),
  nothing running with the count reached (`count`) or the spend reached (`budget`), nothing running
  and nothing eligible (`drained`), three failed eligibility reads in a row or a failure of the loop
  itself (`halted`). On every one, each run is aborted and awaited, its bead released and its
  reservation freed, before `shift.stopped`. `shift.started` comes before anything else, and a
  ledger that does not store it starts nothing.
- The in-process signal (`ShiftDeps.signal`) wins over everything after it: the loop checks it
  again once a host sample or an eligibility read has come back (a stop meanwhile admits nothing
  more and ends `operator`, not `drained`), and a run that ends failed after it, before the loop has
  stopped that run, is released to `queued`, never repaired or halted (on Windows a console Ctrl-C
  reaches the provider as well as the shift). Such a run's failure is not hidden: its entry's
  `error` says `run <n> failed as the shift was stopping, and was not repaired or halted: <why>` and
  its end comment gives `SHIFT_ENDINGS.failedStopping`. Released rather than halted because the
  shift cannot tell a run the same Ctrl-C ended from one that failed of itself, and the same holds
  for a run that ends failed after `forge:shift stop` aborted it: a halt would need the operator's
  queue action for what may be the operator's own interrupt, and a release costs one more try with
  the record saying why. A signal already aborted once the base is fetched refuses the shift as a
  failed start would: nothing written, `the shift was stopped before it started (<reason>); nothing
  was started`. A signal that lands while a bead is admitted admits nothing further: it is checked
  after the start move, after the smith's read and after the reserve, and what was taken is given
  back (the reservation released, the bead released to `queued`, its entry `set-aside` with `the
  shift was stopped before its run started`), with no worktree and no comment. After the reserve
  nothing can land until the started comment (`makeWorktree` is synchronous); a signal during that
  comment reaches the run's own check, which gives the bead back before any run, with its end
  comment.
- Ctrl-C (`x1gs.5.4.14`): `shiftCliMain` (the CLI's main) makes `run` the process's interrupt owner
  (`ownInterrupts`, `scripts/executors/AGENTS.md`) from before its base is fetched until the shift
  has stopped, and passes the owner's `AbortSignal` as `ShiftDeps.signal`. The first `SIGINT` or
  `SIGTERM` aborts it, so the shift stops exactly as `forge:shift stop` stops it (runs stopped, beads
  back to `queued`, reservations freed, `shift.stopped` with reason `operator`), and writes to stderr
  `forge:shift: <signal>: stopping shift <id>: … (up to 30s). Press Ctrl-C again to exit now.` The
  process then prints the record and exits 0, as a shift stopped by `stop` does. A second signal is
  declined to the supervisor: every run's tree is killed and the process exits 130 at once, saying
  that what the shift holds stays held for `forge:shift recover <id>`. That hint is given only once
  the shift's record is written: a signal before it (a slow base fetch, which may take git's 2
  minutes, longer than the bound) means the shift will start nothing, and every notice says so
  (`stopping shift <id> before it has started: nothing will be started`, then `Nothing was started:
  it had not written its record`) instead of naming a recover that would find no shift. The bound: a stop not over
  within `INTERRUPT_GRACE_MS` (30 s, the hearth's `SHIFT_STOP_GRACE_MS`) is cut short the same way,
  saying so, so a run that will not stop (or a `bd` that never answers) cannot hang the process. A
  signal before the record (while the base is fetched) starts nothing and exits 1. After the shift
  has stopped the owner is released: a signal while the result is printed ends the process at once
  (130), and the other commands (`stop`, `recover`, `list`) register no owner. `shift-cli.test.ts`
  runs `fixtures/interruptible-shift.ts` (the real main, hermetic dependencies, the fake binary as
  the run, signals emitted with `process.emit`) for each case: a first `SIGINT` and a first `SIGTERM`,
  a second signal while the stop hangs, the deadline, a signal while the base is fetched, and one
  while a fetch outlasts the deadline.
- A bead the operator pauses or halts while it runs is found by reading each running bead back
  every `pollMs`; its run is stopped, its reservation freed, and its queue state left as the
  operator put it (`left`). Resuming it puts it in `queued` (the queue section): this shift has set
  it aside and does not start it again; a later shift does. A resume made before the read-back
  noticed the pause leaves the bead `queued` while its run still runs, until the next read-back
  stops it.
- No second run of one bead starts while a run of it goes on (`x1gs.5.4.13`). The guard is
  `reserve` (the reservations section): a shift reserves its worktree before a run and releases it
  only after, and its `reserve` of a bead another shift's worktree still holds is refused. A shift
  whose reserve is refused gives the bead back to `queued` (`release`, as for any step that fails),
  sets it aside and runs nothing, so two runs never overlap. It holds whichever shift claims
  first, and whatever eligibility read a shift acted on:
  - paused and resumed between a shift's `start` and its `reserve`, the bead is started and
    reserved by a second shift: the first one's reserve is refused, and its give-back moves the
    bead out of the second one's `running`;
  - a second shift acting on an eligibility read older than the first one's claim starts it after
    a pause and resume: the second one's reserve is refused;
  - the same when the ledger did not store that second start.
  The shift whose run went on reads the bead back out of `running` on its next tick and lets its
  run go as `left`: the restart the operator's pause and resume asked for. A give-back that fails
  is made again (above). Until it goes through, the refused shift's start is the bead's newest
  move, so a watch of the other shift that reads it then lets its run go as `taken`; either way
  the next try puts the bead in `queued`. Only a give-back that fails every try leaves it `running`
  with no run (not covered, below). The bead ends `queued`
  and is eligible again once that run has released its reservation. Meanwhile eligibility lists it
  as waiting on that shift (`waitsOnShift`), which is what the operator sees. Releasing a live
  shift's reservation by hand (`forge:reservations release`) takes this guard away while its run
  goes on: do it only for a shift that is gone.
- Defence in depth: a bead read back as `running` is also checked against the ledger
  (`runOwnership`, recovery's rule). When its newest recorded queue move is a start carrying
  another run's id, another run has it (one let in by a reservation released by hand, say), and
  this shift stops its own run as `left` without touching the bead (end comment
  `SHIFT_ENDINGS.taken`). Only that evidence stops a run: a ledger that cannot be read
  (`ShiftDeps.queryEvents` lets a test make it fail), a newest move of this run's own, and a start
  that names no run (an operator's, by hand) let it run on, so a start event the ledger failed to
  store never stops a healthy run. One ledger query per running bead per `pollMs`.
- Each bead's events carry its run id (`<bead>-<shift-id>`, else `<shift-id>-<n>`): the moves and
  reservations through an `appendEvent` that adds it, the session through `--run`. `forge:audit
  --run <id>` shows one bead from claim to release, and `forge:audit --shift <id>` shows the whole
  shift: its `shift.started` and `shift.stopped` and the events of every run id above, found from the
  ledger by that naming alone (`scripts/ledger/AGENTS.md`). A change to the naming here changes what
  `--shift` finds; `scripts/ledger/audit-cli.test.ts` builds its ids with `shiftRunId` to catch it.
  An operator's stop request (`operator.action`, `shift.stop`) is not part of that answer.
- `shift-store.ts`: the record `<home>/shifts/<id>.json` (a report, never read back by the shift
  to decide) and the stop request `<id>.stop`, written by `requestStop` for `forge:shift stop` and
  `POST /shifts/:id/stop`. Same home as the hearth, or the hearth cannot see, stop or recover the
  shift. `shiftIdInUse`: an id that is not a shift id, or that a record (readable or not) or a stop
  request already has, may not be given to a new shift. Two read helpers serve eligibility:
  `shiftOfWorktree` (whose worktree a path is, by its name under `<main>/trees/`) and
  `shiftStanding` (`live`, `dead`, `stopped` or `unknown`, from the record of this workspace and
  `processAlive`; a reused pid reads as live, as it does for recovery). `shift-store.ts` imports no
  path module of the registry: the ledger's queries import it.
- `run --id <shift-id>` runs the shift under that id instead of one minted at its start. It is
  refused (exit 1, nothing announced, fetched or written) for a value that is not a shift id and
  for an id `shiftIdInUse` says is taken: a new shift would overwrite the old record, or stop at
  its first tick on a stop request left for another. Checked once, before the fetch; a second
  start with the same id between that check and the record is not prevented. The hearth's
  `POST /shifts` mints the id (so its audit row names the shift) and starts `run --id <id>` with
  only the flags its body gave, in the hearth's root with the hearth's home (see
  `scripts/hearth/AGENTS.md`); it parses those flags with `runOptions` and checks them with
  `shiftOptions` first, so a start it accepts is one the CLI accepts. A shift it started is a
  shift like any other: its record, its stop and its recovery are the ones above.
- Recovery (`shift-recover.ts`, `recoverShift`, called by `forge:shift recover <id>` and
  `POST /shifts/:id/recover`): the way back for a shift whose process ended without stopping it
  (a second Ctrl-C, a stop past its deadline, a crash, a kill). Its runs died with it (the
  supervisor's exit hook, the tree guard),
  but its beads stay `running`, their reservations held, its record `running` and no
  `shift.stopped` is written. Until it is recovered, those reservations also refuse every other
  shift's `reserve` of their beads (`heldByShift`), even of a bead the operator paused and resumed:
  recovering (or `forge:reservations release` by hand) is what lets another shift run them.
  - Refused, with nothing written by the recovery (no bd call, no event, no file; the hearth's
    audit row is the runner's): an id that is not a shift's; no
    record, or the record of another workspace (`not-found`: bd runs on this workspace's tracker);
    a record whose fields recovery relies on are not what a shift writes (`unreadable`: a
    workspace that is not a string, a pid that is not `isProcessId`, a bead entry that is not an
    object with a Beads id, a string run id when it has one, a known outcome and a whole run
    count); a record already `stopped`; a record whose `pid` is alive (`processAlive`).
    `isProcessId` is 1 to 2^31 - 1: `process.kill` takes a signed 32-bit pid and throws for any
    other (a fraction, `2**32 + pid`), which `processAlive` reads as dead, and 0 and -1 name a
    group, not a process. `readShiftRecord` and `GET /shifts` are unchanged. A pid the system
    gave to another program after the shift ended reads as alive too: such a shift is not recovered
    until that process ends, and the refusal says so, and says the reservations it holds can be
    freed by hand meanwhile (`forge:reservations list`, then `release`). Nothing guesses whether a
    live pid is the shift's.
  - The beads it may still hold: every entry of the record with outcome `running`, and every bead
    whose `bead.transitioned` events carry one of this shift's run ids (`forge:audit --shift`'s
    rule) with no entry or a `set-aside` one. The second covers a bead claimed between two saves of
    the record: `admit` pushes the entry as `set-aside` before `start`, and saves it only later.
  - Ownership: the shift owns a bead when its newest recorded queue move (a `bead.transitioned`
    with `to`, in this workspace) is a move into `running` carrying this shift's run id for it. A
    record entry with no run id (or an empty one) owns nothing: it would match a start that names
    no run, such as an operator's by hand. The rule is `runOwnership`, which a running shift's
    watch uses too (above).
    Read from the ledger first (a bead it does not own is not moved), then again inside the queue
    lock just before the write: `release` is made through `createQueue(...).move(id, "release",
    "scheduler")` with a `bd` runner that answers that bead's `update` as refused once the ledger
    says otherwise. A `start` appends its event inside the same lock, so a start by another shift
    is either seen or made after this release. A bead it does not own is left as it is: an entry
    the record listed as `running` becomes `left` with `error` `recovered: <why>` (the move that
    took it: the operator's pause, another run's start with its run id, or a move of its own run
    that is not a start); a ledger-only one is not reported. A bead whose newest move could not
    be read (the read before the move, or the one inside the lock) is neither: listed or
    ledger-only, it stays `pending` and keeps the shift open. Not this shift's by the
    rule either: a start the ledger did not store, and one `forge:audit --compact` folded. Both
    leave the bead to the operator's queue actions. A bead another shift started whose start event
    was not stored would be released (the gap `forge:queue reconcile` reports).
  - A released bead's entry becomes `released` (`error` `recovered: …`; a bead the record did not
    list gets an entry), and the bead gets one `worklog:` comment (`recoveredComment`: the shift,
    the pid, the run id and that it is back in `queued`), made as the shift makes its own and
    posted only after the move. The move and the reservations' events carry the bead's run id.
  - Then every reservation the ledger holds in `<main>/trees/<shift-id>-<n>` (by `comparablePath`
    and `shiftOfWorktree`, the naming eligibility reads too; a name with anything after the digits
    is not the shift's) is released, whichever bead holds
    it: a bead that moved on, one set aside after its reservation was taken. `not-held` is `gone`.
  - Once nothing is left undone, `shift.stopped` with reason `recovered` is appended unless the
    ledger holds a `shift.stopped` for the shift already (one appended by a recovery that then
    failed to write the record), and the record is closed (`stopped`, `recovered`, `endedAt`, and
    `error` naming the pid). `recovered` is a reason of its own, not `halted`: `halted` is a shift
    that ended itself after a failure and cleaned up; a recovered one did not.
  - Repeat and race: the record is written after each bead, so a second recovery skips what the
    first settled; a bd failure, a busy lock, an unknown write or a ledger that cannot be read
    leaves the bead `running` (`pending` in the answer), the record `running` and no
    `shift.stopped`, and the answer (`complete: false`, `unfinished`) says what is left: recover
    again. Two recoveries never run at once: each holds `<home>/shifts/recover-lock.db` (the queue
    lock's mechanism, `withQueueLock`, on a file of its own, so it nests with no queue move; the
    operating system drops it with its holder, so nothing is ever stale, and the file is never
    removed because a waiter may hold it open) and reads the record again once it has it. The
    second waits up to 5 s, then answers `busy`; one that gets the lock after the first finished
    is refused as `stopped`. A recovery whose process ends between a bead's move and the record's
    write leaves that bead `queued` with its entry `running`: the next one finds its newest move is
    this shift's own release, reports it `left` and posts no comment (so the bead may have none).
- Never merges, and pushes nothing but a bead's own shift branch, by the shift itself. The run's
  prompt tells it not to push, open a pull request or merge, and the Claude adapter's tool
  allowlist has no `git push` and no `gh`.
- **Not covered:**
  - A shift that dies (a second Ctrl-C, a stop past its deadline, a crash, a kill) does not clean
    up after itself: the supervisor kills its runs' process trees, and its beads stay `running` and
    its reservations held until `forge:shift recover` (above).
  - A signal no handler sees: `SIGKILL`, and on Windows `TerminateProcess`, which is how the
    dashboard ends the hearth and how `Subprocess.kill` ends any process there. A real console
    Ctrl-C has not been sent in a test (Windows cannot send one to a child process); the tests emit
    the signal in the process.
  - On Windows a console Ctrl-C also reaches the provider, which may end on its own before the
    shift's handler has run; such a run is seen as failed. If that is seen before the shift's
    signal (they arrive together), the run is repaired or halted as any failure is.
  - Inferred, untested: on Linux and macOS a terminal's Ctrl-C signals the whole foreground
    process group. Only the provider is in a group of its own (`supervise` starts it detached); the
    shift's own `bd`, `git` and `gh` children (`bdRunner` uses `execFile` without `detached`) are in
    the shift's group and get the signal too. A `bd update` killed that way while the stop gives a
    bead back is made again (`x1gs.5.4.16`, above): the signal is delivered once, so the `bd`
    started after it is not killed. The process groups are not changed here; the tests answer the
    first try as a killed `bd` (no exit status), and no real signal is sent to a real `bd`.
  - A queue move after the claim that never goes through leaves the bead `running` with no run.
    The cases: bd failing on every try; a lock still busy after the first try's whole wait; the
    4 s for all tries spent; a ledger that cannot be read, so no try after the
    first may write; this run's own start not stored. The entry says so and names the way out, a
    pause and a resume (the operator's queue actions). `forge:shift recover` does not help: it refuses a live shift, and
    a stopped one. In the race above it is the refused shift's start that is the newest move, so
    the other shift's watch has let its own run go.
  - Untested: how the double wrapper (`bun run forge:shift` starting `bun scripts/…/shift-cli.ts`)
    passes a real Ctrl-C on; the tests run the CLI's main directly and emit the signal in it.
  - The shift does not run `bd update --claim`; the run's own workflow does.
  - A base that moves during a shift is not fetched again; a remote other than `origin`.
  - Uncommitted changes in a worktree are not in its pull request, and nothing says so.
  - The secret scan covers the PR title and body only: the branch's files and its full commit
    messages are pushed without one (the shift's own body lists only the first 50 subjects).
  - A shift the hearth started is asked to stop when the hearth closes (its `close()`, which
    `SIGINT` and `SIGTERM` run), but dies at once with a hearth killed outright: on Windows that
    is how the dashboard ends the hearth (`TerminateProcess`, which runs no code), and the tree
    guard then ends the shift. Such a shift needs `forge:shift recover`. A console Ctrl-C on
    Windows reaches the shift too, which stops itself as on its own first Ctrl-C (above), while
    the hearth's close asks it to stop; that combination is inferred from the two, each tested
    with an emitted signal, and has not been run.
- Tests: `shift.test.ts` drives the loop with the queue fixture (and `answerQueueList` for the list
  shapes), a temp ledger, lock and home, plain directories as worktrees, a git and a gh that record
  their calls and answer as the test says, and a fake adapter whose runs the test scripts. No test
  ends a shift with a short wall-clock `forMs` that races the shift's own steps (`pkcg`: on the
  4-thread Windows runner, in the isolation re-run, a step can take hundreds of ms): it stops the
  shift by its signal once the fake run has started, or moves the shift's clock (`ShiftDeps.now`)
  once what it waits for has happened (the time cap once both runs have started; a busy host once
  it was sampled three times). A held queue lock is a raw `BEGIN EXCLUSIVE` on the lock file, with
  `ShiftDeps.lockWaitMs` short (the shift's moves and reservations take it; 10 s otherwise). Its kill
  test runs the Claude adapter on the fake binary behind a guard that refuses a spawn without the
  override. `shift-pr.test.ts` runs the base and the pull request step with real git on a scratch
  repository whose origin is a bare repository in the OS temp dir, and the real `pr:check`.
  `shift-cli.test.ts` runs one shift end to end with the real registry and real git in such a
  repository (the checkout on a feature branch, origin ahead of it) and the fake binary. No test
  runs a real provider or the real `gh`, or reaches the real remote: every test's gh is a function.
