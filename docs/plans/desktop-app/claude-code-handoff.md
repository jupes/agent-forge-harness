# Agent Forge desktop app: handoff to Claude Code

Generated: 2026-10-18 · Status: design complete for the screens and states in the brief. The decisions in §6 are settled. Nothing is built.

**Design:** https://claude.ai/artifact/TwudvqBhtBXoahuEGh2rWF (Design artifact, version 138; 60 boards on 10 pages). Dark Nocturne is the default. The light theme is P2 (Light-projects, Light-keeper, Light-session). The artifact is private to its owner account.

Where the brief and a board disagree, the brief's rules win (vocabulary, states, priorities, scope), and the board's layout and sample copy win for the look. The disagreements found in this pass are fixed in both (§4, §5 and §11).

## 1. Read the design

- **Index:** Artifact tool, `action: "read"`, the URL above, `path: "project/canvas.json"`. It lists every board with its page, title, frame size and whether it is interactive (prototype links).
- **Files:** `action: "list"`, `scope: "files"`, the same URL.
- **A board:** `action: "read"`, the same URL, `path: "project/<Board>.dc.html"`. Each board is one HTML file with inline CSS in `<helmet>`, `<x-dc>` markup and a small `DCLogic` script. Prototype links are plain `<a href="<Board>.dc.html">`.
- Copy the markup and class names of the Nocturne primitives in `docs/js/ds/`. Don't copy the boards' hand-drawn inline icons: brief §10 asks for Phosphor icons, and `docs/js/ds/icon-paths.ts` has them.
- The boards are not in this repo (60 files). Adding a copy would be a separate decision; ask first.

## 2. Build order

Build P0 first, then P1, then P2 (the priorities in brief §6). A slice is done when its boards' states and flows work in the app. The app goes in `apps/desktop/` (item 18): a Tauri 2 shell around the existing Preact dashboard, with the hearth as a supervised sidecar (items 1 and 2).

1. **Shell and hearth.** Window, hearth supervision, connection states, title-bar chips, rail and project sidebar. Boards: States-connection-sessions, States-hearth-providers, Layout-1100x700.
2. **Projects home and project frame.** Projects-A (item 20). Overview, Sessions-list. A project lives in the hearth's home, and a bead joins its project through an epic and a `project:<slug>` label.
3. **Forge Keeper.** Keeper, Keeper-drawer, Keeper-action-cards, Keeper-states, States-write-keeper. A standing session that acts only through approved cards (item 21).
4. **Sessions and composers.** Composer-Claude, Composer-Codex, Composer-Codex-from-bead, Composer-Claude-from-keeper, Session-Codex, Session-usage-limit, Session-shift, Session-observed, Session-teammate-plan. Multi-turn sessions (item 22), with every turn visible (item 28).
5. **Beads and Workbench.** Beads-ready, Beads-epics, Beads-new, Workbench, Workbench-start-shift, States-beads-queue, States-shifts-council-gates. Shifts run attended until local model execution lands (item 26).
6. **Providers and usage.** Providers, Composer-Gemini (Gemini CLI route), Composer-Grok (Grok Build is a v1 provider), Components-permission-modes, States-lists-three. Items 23 and 25.
7. **P1 screens.** Runs-list, Runs-detail, NewForgeRun, Reviews-new, Reviews-live, Reviews-result, Reviews-checkpoint-live, Reviews-checkpoint-result, Reviews-checkpoint-transcript, Activity, Inbox, Smiths, Palette, NewProject, Onboarding, Settings-project.
8. **P2 screens.** Settings-app, Tray-toasts, PopOut, the light theme (Light-projects, Light-keeper, Light-session), deep links (brief §11).

Composer-OpenRouter is in no slice. It is flagged for later (§11).

## 3. Screen map

| Brief | Priority | Boards | Notes |
|---|---|---|---|
| §6.1 Projects home | P0 | Projects-A | Option A, chosen (item 20). Projects-B and Projects-C stay on the canvas as alternates; not built. |
| §6.2 New project | P1 | NewProject | |
| §6.3 Project frame, §11 window | P0 | Layout-1100x700, and the sidebar and title bar on every project board | Eight project destinations (brief §5.2). Layout-1100x700 is the 1100×700 minimum. |
| §6.4 Overview | P0 | Overview | |
| §6.5 Forge Keeper | P0 | Keeper, Keeper-drawer, Keeper-action-cards, Keeper-states, States-write-keeper | Seven card types, plus approved, done, failed and dismissed. |
| §6.6 Sessions list | P0 | Sessions-list | |
| §6.7 New session | P0 | Composer-Claude, Composer-Codex, Composer-Gemini, Composer-Grok, Composer-Codex-from-bead, Composer-Claude-from-keeper | Grok is the signed-out variant. Two variants are pre-filled from a bead and from a Keeper card. Composer-OpenRouter is flagged (§11). |
| §6.8 Session view | P0 | Session-Codex, Session-usage-limit, Session-shift, Session-observed, Session-teammate-plan | |
| §6.9 Beads | P0 | Beads-ready, Beads-epics, Beads-new | |
| §6.10 Workbench | P0 | Workbench, Workbench-start-shift | |
| §6.11 Runs | P1 | Runs-list, Runs-detail, NewForgeRun | |
| §6.12 Reviews | P1 | Reviews-new, Reviews-live, Reviews-result, Reviews-checkpoint-live, Reviews-checkpoint-result, Reviews-checkpoint-transcript | The checkpoint boards carry flow 5. The transcript board is the target of "Full transcript · 3 rounds". |
| §6.13 Activity | P1 | Activity | |
| §6.14 Providers and usage | P0 | Providers | |
| §6.15 Smiths | P1 | Smiths | |
| §6.16 Inbox | P1 | Inbox | |
| §6.17 Command palette | P1 | Palette | |
| §6.18 Project settings | P1 | Settings-project | |
| §6.19 App settings | P2 | Settings-app | |
| §6.20 Onboarding | P1 | Onboarding | |
| §6.21 Tray and toasts | P2 | Tray-toasts | |
| §6.22 Pop-out session | P2 | PopOut | |
| §8 Components | — | Components-permission-modes | Build the components in §8 as shared components; the boards use them throughout. |
| §9 States | — | States-hearth-providers, States-connection-sessions, States-beads-queue, States-lists, States-lists-two, States-lists-three, States-shifts-council-gates, States-write-keeper | Gallery boards: what happened, what it means, what to do. |
| §10 Visual direction | — | Main (Foundations), Light-projects, Light-keeper, Light-session | The light theme is P2. |

## 4. Flows (brief §7)

Each flow is a path through the prototype links. Use them as acceptance tests.

1. **Morning check-in.** Projects-A → Overview → Keeper → Workbench (the Keeper's approve-beads card).
2. **Put Codex on a bead.** Beads-ready → Composer-Codex-from-bead → Session-Codex → Reviews-new (Send to council). The bead is x1gs.10.1.
3. **Leave it running.** Workbench → Workbench-start-shift → Workbench. Tray-toasts → Workbench (the halted bead). Workbench → Keeper (Ask the Keeper).
4. **Choose by headroom.** Overview's usage pill → Providers → Composer-Gemini (Start a session). Claude's 5-hour window is at 42%, and its weekly window, all models, is used up until Thu 09:00.
5. **Review a checkpoint.** Runs-list → Runs-detail → Reviews-checkpoint-live → Reviews-checkpoint-result → Runs-detail (Back to the run). "Full transcript · 3 rounds" on the result opens Reviews-checkpoint-transcript, which links back to the result. Approving the checkpoint with a note is a button with no link.

Brief §7 and the boards agree on these values: Needs you 9 (8 in Agent Forge, 1 in Billing API), bead x1gs.10.1 (open and unblocked; x1gs.4.4 is in progress), and the 5-hour window at 42%.

## 5. States (brief §9)

Covered on the boards: hearth (connecting, connected, reconnecting, stopped, version mismatch); provider (signed out, subscription, API key, usage exhausted, reporting unavailable, degraded, not installed); session (starting, running, needs permission, waiting for input, idle, ended, ended with error, stopped, timed out, stale, observed); bead (open, in progress, blocked, closed, P0–P4); queue (all eight states; Queued appears as may start and waits); shift (starting, throttled, stopping, stopped, failed to start, needs recovery); gate (pass, fail, skipped, not run); council (queued, reviewing, discussing, synthesizing, complete, failed, cancelled); forge run phases (complete, active, locked, gate failed); write (sending, done, refused, outcome unknown); lists (loading, empty, error, filtered to nothing).

Closed in this pass:

- **Not installed.** Onboarding labels a missing CLI "Not installed", and brief §6.20 says so too.
- **Shift starting.** States-shifts-council-gates, card c13.
- **Council queued and complete.** Cards c14 and c15. Complete links to the result.
- **Forge run phases.** Runs-detail's stepper labels complete, active and locked. Card c16 on States-shifts-council-gates shows the phases and a gate failure.
- **Keeper with its smith unavailable.** States-write-keeper offers codex-journeyman as the fallback and marks the Claude smith unavailable. The weekly limit covers every Claude model, so a Claude fallback cannot work.

## 6. Decisions (settled 2026-10-18)

The owner settled these on 2026-10-18. They are recorded in `../command-center/05-decisions.md` as items 20–30, with item 13 amended. The `design:` comment on the epic waits until Beads is installed (§11).

| # | Decision | Settled |
|---|---|---|
| 1 | Projects: storage and bead mapping | Stored in the hearth's home (`~/.agent-forge/`). A bead joins its project through an epic and a `project:<slug>` label. Both. |
| 2 | Forge Keeper | A standing session per project, with read access to everything. It acts only through cards the user approves. Item 5 stands: nothing starts without approval. |
| 3 | Multi-turn sessions | Each provider keeps its conversation through its own CLI: a resumed session, or a long-running process where the CLI needs one. Transcripts go to a per-session file the hearth owns. The ledger stays metadata-only. |
| 4 | Grok and OpenRouter as session providers | Grok Build is a v1 provider. OpenRouter through OpenCode is flagged for later, behind the shared ACP client. |
| 5 | Static snapshot mode of the dashboard | Retired (`ui-pruning.md`, R1). |
| 6 | Which Gemini binary | Gemini CLI first. Antigravity (`agy`) later, behind the same adapter contract. |
| 7 | Subscription terms and unattended runs | Each vendor's own unmodified CLI, under the user's own sign-in, and never a credential file. Unattended runs, shifts included, wait for local model execution (likely NemoClaw). Until then every run is attended, and every turn shows in the app as it happens. The Anthropic and Google questions stay open (§11). |
| 8 | Projects home | Option A, the prototype's entry point. B and C stay on the canvas as alternates. |
| 9–13, 15 | Design details | Agreed as proposed. §11 lists them under Settled. |
| 14 | Accessibility audit | The WCAG 2.2 AA and ADA compliance audit runs after the full feature set is built. The build follows the rules in §7 now. |

## 7. Visual rules

- Start from Nocturne (`docs/js/ds/tokens.css` and `components.css`). Dark is the default. The light theme comes from the same ramps.
- Dark values used on the boards: ground `#161826`, top bar `#1b1d2c`, side `#1d1f2e`, surface `#232532`, card `#1f2130`, border `#2f3242`, text `#e9e9ed`, muted `#9397ab`, accent `#9184d9`, accent text `#d2cefd`, accent fill `#2b2741`.
- Status, dark: ok text `#a6e3c5` on `#1f3a2f` with border `#2f6b4f`; warn `#f3d58f` on `#3b2f17` with border `#7a5d22`; danger `#f7b3ae` on `#3d2221` with border `#7d3a37`. Brief §10 asks for OKLCH ramps; these hex values are placeholders.
- Provider monograms, dark: Cl `#d98b5f`, Cx `#5fb3a7`, Ge `#6f9cff`, Gk `#c9ccd8`, OR `#f08fb0`, and FK (Forge Keeper) `#9184d9`. Monograms, never logos, and never colour alone.
- Light values used on the Light boards: ground `#f5f6fa`, surface `#ffffff`, accent `#6a5bd0`, accent text `#4a3fb0`. Monograms: Cl `#a85a30`, Cx `#2b7268`, Ge `#3558c4`, Gk `#4f5468`, OR `#a8426a`, FK `#5b4fc0`.
- Type: Inter at 400 and 500, headings never above 500. Mono for ids and code. Radii 4, 8 and 14. The 2px accent focus ring is never removed.
- Accessibility (brief §10): WCAG 2.2 AA text contrast; body text in the accent uses `--color-accent-300`; full keyboard operation; live regions for streaming text and notifications; hit targets 24px or more. Build to these now. The formal audit waits for the full feature set (decision 14).
- Motion: a pulse on running, a streaming caret, panel slides. Respect reduced motion.

## 8. Vocabulary and copy (brief §4)

- Never write: crew, tier, pool, drain, drained, ticket, agent pool.
- Write "bead", not "issue", in UI copy.
- A missing CLI is "Not installed", never "not found".
- Errors say what happened, what it means and what to do, in plain words. Never "Something went wrong."
- Use the sample data in brief §12 and on the boards. Don't invent facts beyond them.

## 9. Acceptance

- Each P0 screen shows the states that brief §9 lists for it.
- The five flows in §4 work end to end in the app.
- Nothing starts from a Keeper suggestion without approval (item 21, and item 5). Sessions and shifts start from a user action.
- Every run shows its turns in the session view as they happen, attended or not (item 28). The ledger stays metadata-only (item 10).
- No unattended run is built in v1 (item 26). Shifts run attended.
- No screen shows or stores provider passwords, OAuth tokens or API keys (brief §13). The app runs each vendor's own CLI under the user's own sign-in and never reads a credential file (item 27).
- The vocabulary rules in §8 hold for every UI string.
- Keyboard operation, visible focus and reduced motion. The WCAG 2.2 AA audit waits (item 30).
- Tests and quality gates follow the repo's rules (`bun run typecheck`, `bun run lint`, `bun test`). Behaviour is built red, green, then refactored.

## 10. Out of scope for v1 (brief §13)

- Accounts, sign-up, team members, sharing, comments by other people, cloud sync, billing for the app.
- A code editor or file tree. Open files in the user's editor.
- Merging pull requests from the app. The harness never merges.
- Routing work by remaining quota. The app informs; the user chooses.
- Showing provider passwords, OAuth tokens or API keys.
- Unattended runs, until local model execution (item 26).
- The pages removed by `ui-pruning.md`: Commands, Skill builder, Insights as a page, the separate Council document, and snapshot controls.

## 11. Settled, open and flagged

**Settled in this pass**

- **Claude usage.** A Claude plan has one 5-hour window and one weekly window, shared by every Claude model. Fable has its own weekly budget. When a Claude window runs out, every Claude model waits until it resets; other providers are unaffected (item 29). The boards show the 5-hour window at 42% and the weekly window, all models, at 100%, resetting Thu 09:00.
- **Projects home** is option A. B and C stay on the canvas as alternates.
- **Eight project destinations.** Sessions is one of them (brief §5.2). Brief §5.1's text now lists all eight.
- **Session-row labels** on States-connection-sessions (Resume, Restart, Start again, Check Activity) are the design.
- **Antigravity policy rows** (request review, strict, always proceed, skip permissions) are worded from their names, and the owner agreed to the wording. Check them against `agy`'s own help text when the Antigravity adapter is built.
- **Sidebars.** Beads-new has a simplified backdrop sidebar. Workbench-start-shift has none, because it is a dialog.
- **Transcript control.** "Full transcript · 3 rounds" opens Reviews-checkpoint-transcript.
- **Brief fixes.** Flows 1, 2 and 4 (brief §7); the eight destinations (brief §5.1); "Not installed" (brief §6.20); the usage wording (brief §6.8, §12 and Appendix A.2); the shift session's turns (§6.8); unattended runs (§6.10).

**Open**

- **Apprentice effort flag.** The apprentice smith (`claude-apprentice`, effort `low`, in `scripts/config/defaults.ts`) passes `--effort`. The repo cannot verify that its model accepts the flag; see the note in `scripts/executors/claude.ts` (lines 17–22). Check it with a live run before the first shift uses that smith.
- **Beads.** `bd` was not installed in this pass, so no epic is filed and no `design:` comment is recorded. Do both when Beads is available. The tracker stays local-only, as CLAUDE.md says.

**Flagged for later**

- **OpenRouter as a session provider**, through OpenCode behind the shared ACP client (item 23). Composer-OpenRouter and the OpenRouter row on Providers are designed but not built.
- **The Antigravity route** (`agy`) behind the same adapter contract, after Gemini CLI (item 25). Composer-Gemini shows the route; build it later, and until then do not offer it.
- **Unattended runs and shifts**, through local model execution (likely NemoClaw) (item 26).
- **WCAG 2.2 AA and ADA compliance audit**, after the full feature set is built (item 30). It includes the contrast check.
- **Subscription terms.** The Anthropic questions (automated access, and running Claude Code inside a product) and Google's question on Antigravity stay open (item 27). Check them again before the app goes to anyone else.

## 12. Paste-ready prompt for Claude Code

```text
Build the Agent Forge desktop app from the design. Read docs/plans/desktop-app/claude-code-handoff.md first, then docs/plans/desktop-app/design-brief.md. The decisions in §6 are settled, so don't reopen them; their register entries are items 20–30 and item 13 (amended) in docs/plans/command-center/05-decisions.md. The design is the Design canvas at https://claude.ai/artifact/TwudvqBhtBXoahuEGh2rWF. Read its index at project/canvas.json and the boards with the Artifact tool.

If bd is installed, record the settled decisions as a design: comment on the epic first. Then build slice 1 from §2 (shell and hearth) in apps/desktop/, with TDD and the repo's quality gates (bun run typecheck, bun run lint, bun test). Don't change the design. If a board disagrees with the brief, follow the brief and list the mismatch in your summary. Leave the flagged items in §11 out of the build.
```

## 13. Files in this folder

- This handoff, with the brief, the README, `ui-pruning.md` and `claude-design-prompt.md`.
- The decisions behind §6 are in `../command-center/05-decisions.md` (items 20–30, and item 13 as amended).
- The boards are not in the repo. Read them from the canvas.
