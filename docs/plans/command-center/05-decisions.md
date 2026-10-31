# Decision register — Agent Forge Command Center

Decided by the owner on 2026-10-06, before execution, so that no bead carries an open question. Executors treat these as settled; changing one requires a `design:` comment on the affected bead **and** an edit here in the same PR.

## Vocabulary (forge brand)

| Concept | Term | Used for |
|---|---|---|
| A configured provider + model + effort that does work | **smith** | `[smiths.<name>]` in config, `--smith <name>` on commands, `smith` field on runs and events |
| Policy level that maps work onto smiths | **rank**: `master` / `journeyman` / `apprentice` | Replaces Top / Default / Cheap in `model-tier-policy.md`; evaluator rank ≥ builder rank |
| Weighted set of smiths for a complexity class | **bench** | `[benches] low = ["claude-apprentice:70", "codex-journeyman:30"]` |
| Bounded unattended loop over approved work | **shift** | `bun run forge:shift --for 2h --concurrency 2` |
| The always-on local control-plane server | **hearth** | `bun run hearth`, `bun run hearth:mcp`, `scripts/hearth/`, `types/hearth.ts` |
| Board of approved and running work | **workbench** | Dashboard route `/workbench`, Claude Code pane |
| Unchanged | ledger, session, reservation, friction, scoreboard, timeline, council, bead, run | Plain words stay plain |

Built-in smiths: `claude-master` (highest Claude rank, effort high), `claude-journeyman` (default Claude), `claude-apprentice` (cheapest Claude), `codex-journeyman`. Default smith: `claude-journeyman`. Benches: `low`, `medium`, `high` keyed by the bead's `complexity:*` label.

## Architecture

1. **Desktop shell:** Tauri 2 wrapping the existing Preact dashboard; the hearth compiled with `bun build --compile` as a supervised sidecar. The D1 spike is folded into `f8-shell` as its first checkpoint.
2. **Process model:** one hearth per machine serving every registered workspace. Lock file `~/.agent-forge/hearth.lock` with pid, port, token. Vite dev, the desktop shell and `bun run hearth` may all start it; the lock prevents duplicates.
3. **Ledger location:** one `~/.agent-forge/ledger.db` with a `workspace` column; workspace-scoped queries. Absorbs the `ulpz.3` schema (see Scope 11).
4. **Session attach:** Claude Code hooks append in-process; spawned CLIs stream through their adapter; remote workers POST to the hearth. Identity is the provider's session id, mirrored by the SessionStart hook into `<worktree>/.agent-forge-session` so script emitters can attach to the live session; a ULID is minted there only when the provider gives none. One line, the id verbatim; freshness is the file's mtime. (Amended 2026-10-07 by `x1gs.2.2`: the file was originally written only for minted ids.)

## Execution safety

5. **Approval:** a human approves the start of every task or task family. Work minted by auto-tasks or `/forge-orchestrate` waits as `queue:proposed`; a shift only consumes `queue:approved`/`queued` beads. A `/forgemaster` or `/forgemaster-auto` run the operator launched by hand counts as approved for that feature. (Amended 2026-10-14 by `x1gs.5.7`: approval is not inherited. `bd create --parent` copies the parent's labels onto the child, a `queue:*` label included, and the queue counts a label as a state only when it wrote it, so a child created under a parent in the queue is in no state. It enters the queue by `propose` and waits for an operator's `approve` of that child before a shift may pick it, however it was created: through the hearth, by an agent, or with `bd create` by hand.)
6. **Headless permissions:** spawned `claude -p` runs use `acceptEdits` inside their worktree with Bash allowlisted to the project's known scripts. `dangerously-skip-permissions` is never used.
7. **PRs:** shifts open PRs with the canonical template, never merge, never push to `master`.
8. **Shift defaults:** concurrency 2, duration 2h, admission paused above 85% CPU or memory, 3 repair attempts per bead then `queue:halted`.
9. **Council:** on demand only. `[review] before_pr` exists as a toggle, default off; when on, per-run ceiling 1.00 USD.
10. **Ledger bodies:** metadata only in v1 (hashes, sizes, names, durations). Evaluator verdict text and council summaries are stored because they already exist as files.
11. **Backup and retention:** nightly copy of the ledger to `~/.agent-forge/backups/` keeping 14 days; events older than 90 days compacted to daily summaries.

## Scope

12. **`ulpz.3` is folded into F1** (`f1-core` delivers the schema). `ulpz.3` is blocked by `f1-core` and closes with a pointer when it lands; `ulpz.5` stays in the self-host epic and implements the executor adapter interface later.
13. **Third adapter:** Gemini CLI. OpenCode only if Gemini's headless mode fails on Windows at build time (record the evidence on the bead). (Amended 2026-10-18 by item 23: Grok Build is a v1 adapter as well. OpenRouter through OpenCode is flagged for later, behind the shared ACP client.)
14. **Molecules are retired.** The shift takes its DAG from Beads dependencies. `f5-molecules` is closed; a small F9 task marks the README historical and removes `molecules:check`.
15. **Platforms:** Windows first; macOS a build target only after the Windows installer works; Linux containment stays with `ulpz`. Multi-machine shifts and replicas are out of this epic.
16. **Codex and Cursor surfaces** stay in scope at P3, last.

## Layout and notifications

17. **Config:** `agent-forge.toml` at the harness root (workspace) and `~/.agent-forge/config.toml` (machine); a pinned small TOML library, justified in the PR. Merged with provenance; security keys never inherited once a workspace file exists.
18. **Desktop app location:** `apps/desktop/` in this repository.
19. **Notifications:** shift halted, gate failed, council verdict, bead awaiting approval. Nothing per tool call.

## Desktop app (decided by the owner on 2026-10-18)

Settled from the desktop app's design handoff (`docs/plans/desktop-app/claude-code-handoff.md` §6). The `design:` comments on the affected beads wait until Beads is installed.

20. **Projects:** a project is a hearth-level object above workspaces, stored in the hearth's home (`~/.agent-forge/`). A bead joins a project through an epic and a `project:<slug>` label. The projects home is option A of the design.
21. **Forge Keeper:** one standing session per project, with read access to every bead, run and session. It acts only through cards a user approves. Item 5 stands: a human approves each start, and the Keeper never starts work from its own suggestion.
22. **Multi-turn sessions:** each provider keeps its conversation through its own CLI, by resuming the provider's session or by a long-running process where the CLI needs one. Transcript bodies go to a per-session file the hearth owns. The ledger stays metadata-only (item 10).
23. **Providers in v1:** Claude Code, Codex, Gemini through Gemini CLI, and Grok Build. OpenRouter through OpenCode is flagged for later, behind the shared ACP client.
24. **Snapshot mode retired:** the dashboard's static snapshot mode goes, as `ui-pruning.md` R1 says.
25. **Gemini binary:** Gemini CLI first. Antigravity (`agy`) follows later, behind the same adapter contract. Until Google's terms are confirmed, the Gemini route uses an API key, Vertex AI or a business sign-in (item 27), not a Google AI Pro or Ultra plan.
26. **Unattended runs wait:** unattended runs, shifts included, wait for local model execution (likely NemoClaw). Until then every run is attended.
27. **Terms:** the app runs each vendor's own unmodified CLI under the user's own sign-in, and never reads a credential file or stores a token, key or password. The Anthropic questions (automated access under the Consumer Terms, and running Claude Code inside a product under the Commercial Terms) and Google's question on Antigravity are open. Check them again before the app is given to anyone else.
28. **Visibility:** every run shows its turns in the app as they happen, attended or not, as Claude Code's transcript does. This is the view, not a notification: item 19 still sends nothing per tool call.
29. **Usage windows:** a Claude plan has one 5-hour window and one weekly window, shared by every Claude model. Fable has its own weekly budget. When a Claude window runs out, every Claude model waits for its reset; other providers are unaffected. This is the owner's account of the plan.
30. **Accessibility:** the WCAG 2.2 AA and ADA compliance audit runs after the full feature set is built. Until then the build follows the design's accessibility rules.
