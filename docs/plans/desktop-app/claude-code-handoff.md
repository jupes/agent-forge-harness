# Agent Forge desktop app: handoff to Claude Code

Generated: 2026-10-18 · Status: design complete for the screens and states in the brief; decisions in §6 pending; nothing built.

**Design:** https://claude.ai/artifact/TwudvqBhtBXoahuEGh2rWF (canvas version 125; 59 boards on 10 pages; dark Nocturne is the default, with a light theme on the States page). The canvas is private to its owner account.

Where the brief and a board disagree, the brief's rules win (vocabulary, states, priorities, scope), and the board's layout and sample copy win for the look. §4, §5 and §11 list the disagreements found in this pass.

## 1. Read the design

- **Index:** Artifact tool, `action: "read"`, the URL above, `path: "project/canvas.json"`. It lists every board with its page, title, frame size and whether it is interactive (prototype links).
- **Files:** `action: "list"`, `scope: "files"`, the same URL.
- **A board:** `action: "read"`, the same URL, `path: "project/<Board>.dc.html"`. Each board is one HTML file with inline CSS in `<helmet>`, `<x-dc>` markup and a small `DCLogic` script. Prototype links are plain `<a href="<Board>.dc.html">`.
- Copy the markup and class names of the Nocturne primitives in `docs/js/ds/`. Don't copy the boards' hand-drawn inline icons: brief §10 asks for Phosphor icons, and `docs/js/ds/icon-paths.ts` has them.
- The boards are not in this repo. A snapshot would add the 59 board files; ask before adding them.

## 2. Build order

Build P0 first, then P1, then P2 (the priorities in brief §6). A slice is done when its boards' states and flows work in the app.

1. **Shell and hearth.** Tauri 2 window, hearth supervision, connection states, title-bar chips, rail and project sidebar. Boards: States-connection-sessions, States-hearth-providers, Layout-1100x700. No open decision.
2. **Projects home and project frame.** Projects-A (the prototype's entry point), Overview, Sessions-list. Needs decision 1.
3. **Forge Keeper.** Keeper, Keeper-drawer, Keeper-action-cards, Keeper-states. Needs decision 2.
4. **Sessions and composers.** Composer-Claude, Composer-Codex, Composer-Codex-from-bead, Composer-Claude-from-keeper, Session-Codex, Session-usage-limit, Session-shift, Session-observed, Session-teammate-plan. Chat mode needs decision 3.
5. **Beads and Workbench.** Beads-ready, Beads-epics, Beads-new, Workbench, Workbench-start-shift, States-beads-queue, States-shifts-council-gates. No open decision.
6. **Providers and usage.** Providers, Composer-Gemini, Composer-Grok, Composer-OpenRouter, Components-permission-modes, States-lists-three. Needs decisions 4, 6 and 7.
7. **P1 screens.** Runs-list, Runs-detail, NewForgeRun, Reviews-new, Reviews-live, Reviews-result, Reviews-checkpoint-live, Reviews-checkpoint-result, Activity, Inbox, Smiths, Palette, NewProject, Onboarding, Settings-project.
8. **P2 screens.** Settings-app, Tray-toasts, PopOut, the light theme (Light-projects, Light-keeper, Light-session), deep links (brief §11).

## 3. Screen map

| Brief | Priority | Boards | Notes |
|---|---|---|---|
| §6.1 Projects home | P0 | Projects-A, Projects-B, Projects-C | Three options. The prototype starts at A. Choose one. |
| §6.2 New project | P1 | NewProject | |
| §6.3 Project frame, §11 window | P0 | Layout-1100x700, and the sidebar and title bar on every project board | Eight project destinations (§11). Layout-1100x700 is the 1100×700 minimum. |
| §6.4 Overview | P0 | Overview | |
| §6.5 Forge Keeper | P0 | Keeper, Keeper-drawer, Keeper-action-cards, Keeper-states | Seven card types, plus approved, done, failed and dismissed. |
| §6.6 Sessions list | P0 | Sessions-list | |
| §6.7 New session | P0 | Composer-Claude, Composer-Codex, Composer-Gemini, Composer-Grok, Composer-OpenRouter, Composer-Codex-from-bead, Composer-Claude-from-keeper | Grok is the signed-out variant. Two variants are pre-filled from a bead and from a Keeper card. |
| §6.8 Session view | P0 | Session-Codex, Session-usage-limit, Session-shift, Session-observed, Session-teammate-plan | |
| §6.9 Beads | P0 | Beads-ready, Beads-epics, Beads-new | |
| §6.10 Workbench | P0 | Workbench, Workbench-start-shift | |
| §6.11 Runs | P1 | Runs-list, Runs-detail, NewForgeRun | |
| §6.12 Reviews | P1 | Reviews-new, Reviews-live, Reviews-result, Reviews-checkpoint-live, Reviews-checkpoint-result | The two checkpoint boards carry flow 5. |
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
| §10 Visual direction | — | Main (Foundations), Light-projects, Light-keeper, Light-session | Light theme is P2. |

## 4. Flows (brief §7)

Each flow is a path through the prototype links. Use them as acceptance tests.

1. **Morning check-in.** Projects-A → Overview → Keeper → Workbench (the Keeper's approve-beads card).
2. **Put Codex on a bead.** Beads-ready → Composer-Codex-from-bead → Session-Codex → Reviews-new (Send to council).
3. **Leave it running.** Workbench → Workbench-start-shift → Workbench. Tray-toasts → Workbench (the halted bead). Workbench → Keeper (Ask the Keeper).
4. **Choose by headroom.** Overview's usage pill → Providers → Composer-Gemini (Start a session).
5. **Review a checkpoint.** Runs-list → Runs-detail → Reviews-checkpoint-live → Reviews-checkpoint-result → Runs-detail (Back to the run). Approving the checkpoint with a note is a button with no link.

Three places where brief §7 and the boards disagree. Decide which is right and fix the other:

- Flow 1 says "Needs you: 3". The boards show 9 for the sample data (8 in Agent Forge, 1 in Billing API).
- Flow 2 starts from bead x1gs.4.4. That bead is In progress, so it is not in Ready. The boards use x1gs.10.1 (open and unblocked) for the same flow.
- Flow 4 says Claude's 5-hour window is at 82%. §12 and the boards say 42%.

## 5. States (brief §9)

Covered on the boards: hearth (connecting, connected, reconnecting, stopped, version mismatch); provider (signed out, subscription, API key, usage exhausted, reporting unavailable, degraded); session (starting, running, needs permission, waiting for input, idle, ended, ended with error, stopped, timed out, stale, observed); bead (open, in progress, blocked, closed, P0–P4); queue (all eight states; Queued appears as may start and waits); shift (throttled, stopping, stopped, failed to start, needs recovery); gate (pass, fail, skipped, not run); council (reviewing, discussing, synthesizing, failed, cancelled); write (sending, done, refused, outcome unknown); lists (loading, empty, error, filtered to nothing).

Gaps to close:

- **"Not installed"** (provider) is not on any board. Onboarding says "not found". Use one label.
- **Shift "Starting"** is not drawn as a state.
- **Council "Queued" and "Complete"** are not drawn as states. The result board has no state label.
- **Forge run phases "Complete" and "Active"** are not labelled on Runs-detail. Check its stepper wording.

## 6. Decisions to settle first

From `README.md`. Record each as a `design:` comment on the epic, and as an edit to `../command-center/05-decisions.md` in the same change.

1. **Projects.** Where they are stored (likely the hearth's home), and how beads map to them (an epic, a `project:<slug>` label, or both). Blocks Projects home and the project frame.
2. **Forge Keeper.** A standing session per project, with read access to everything and actions only through approved cards. Blocks the Keeper boards.
3. **Multi-turn sessions.** The adapters must resume a provider's session or keep a protocol open, and the ledger needs opt-in transcript bodies (decision 10 keeps it metadata-only). Blocks Chat mode in the composers and the session view.
4. **Grok and OpenRouter as session providers.** Blocks Composer-Grok and Composer-OpenRouter.
5. **Retiring the static snapshot mode** of the dashboard (`ui-pruning.md`, R1). Affects the old dashboard only.
6. **Which Gemini binary.** Antigravity (`agy`) for Google AI Pro and Ultra subscriptions; Gemini CLI for API keys and Vertex AI. Blocks the Gemini route in Composer-Gemini and Providers.
7. **Subscription terms per provider.** Blocks plan-based usage and unattended shifts on a Claude or Google plan. Anthropic's consumer-terms question on automated access, and Google's open question, are unresolved.

## 7. Visual rules

- Start from Nocturne (`docs/js/ds/tokens.css` and `components.css`). Dark is the default. The light theme comes from the same ramps.
- Dark values used on the boards: ground `#161826`, top bar `#1b1d2c`, side `#1d1f2e`, surface `#232532`, card `#1f2130`, border `#2f3242`, text `#e9e9ed`, muted `#9397ab`, accent `#9184d9`, accent text `#d2cefd`, accent fill `#2b2741`.
- Status, dark: ok text `#a6e3c5` on `#1f3a2f` with border `#2f6b4f`; warn `#f3d58f` on `#3b2f17` with border `#7a5d22`; danger `#f7b3ae` on `#3d2221` with border `#7d3a37`. Brief §10 asks for OKLCH ramps; these hex values are placeholders.
- Provider monograms, dark: Cl `#d98b5f`, Cx `#5fb3a7`, Ge `#6f9cff`, Gk `#c9ccd8`, OR `#f08fb0`, and FK (Forge Keeper) `#9184d9`. Monograms, never logos, and never colour alone.
- Light values used on the Light boards: ground `#f5f6fa`, surface `#ffffff`, accent `#6a5bd0`, accent text `#4a3fb0`. Monograms: Cl `#a85a30`, Cx `#2b7268`, Ge `#3558c4`, Gk `#4f5468`, OR `#a8426a`, FK `#5b4fc0`.
- Type: Inter at 400 and 500, headings never above 500. Mono for ids and code. Radii 4, 8 and 14. The 2px accent focus ring is never removed.
- Accessibility (brief §10): WCAG 2.2 AA text contrast; body text in the accent uses `--color-accent-300`; full keyboard operation; live regions for streaming text and notifications; hit targets 24px or more. Prompt 7 asked for a contrast check. It was not re-run in this pass, so run it before the build.
- Motion: a pulse on running, a streaming caret, panel slides. Respect reduced motion.

## 8. Vocabulary and copy (brief §4)

- Never write: crew, tier, pool, drain, drained, ticket, agent pool.
- Write "bead", not "issue", in UI copy.
- Errors say what happened, what it means and what to do, in plain words. Never "Something went wrong."
- Use the sample data in brief §12 and on the boards. Don't invent facts beyond them.

## 9. Acceptance

- Each P0 screen shows the states that brief §9 lists for it.
- The five flows in §4 work end to end in the app.
- Nothing starts from a Keeper suggestion without approval (decision 2). Sessions and shifts start from a user action.
- No screen shows or stores provider passwords, OAuth tokens or API keys (brief §13). The app runs each vendor's own CLI under the user's own sign-in and never reads a credential file (README decision 7).
- The vocabulary rules in §8 hold for every UI string.
- Keyboard operation, visible focus, reduced motion, and WCAG 2.2 AA contrast.
- Tests and quality gates follow the repo's rules (`bun run typecheck`, `bun run lint`, `bun test`). Behaviour is built red, green, then refactored.

## 10. Out of scope (brief §13)

- Accounts, sign-up, team members, sharing, comments by other people, cloud sync, billing for the app.
- A code editor or file tree. Open files in the user's editor.
- Merging pull requests from the app. The harness never merges.
- Routing work by remaining quota. The app informs; the user chooses.
- Showing provider passwords, OAuth tokens or API keys.
- The pages removed by `ui-pruning.md`: Commands, Skill builder, Insights as a page, the separate Council document, and snapshot controls.

## 11. Unverified, assumed or open (check before the build)

- **Claude usage windows.** The boards show a 5-hour window, and an Opus weekly window that resets Thursday 09:00. The per-model weekly window on Claude plans is an assumption to verify.
- **Apprentice smith effort flag.** The apprentice smith (`scripts/config/defaults.ts`) is set to a model that is passed `--effort`. The repo cannot verify that the model accepts the flag; see the note in `scripts/executors/claude.ts`.
- **Antigravity policy rows.** Request review, strict, always proceed and skip permissions are worded from their names. The brief defines none of them.
- **Session-row actions.** The connection board's action labels (Resume, Restart, Start again, Check Activity) are design choices.
- **Eight project destinations.** Sessions is included as a destination (brief §5.2). Brief §5.1 lists seven.
- **Projects home.** Three options: A (the prototype's entry point), B and C. Choose one.
- **Sidebars.** Beads-new has a simplified backdrop sidebar. Workbench-start-shift has none, because it is a dialog.
- **Transcript control.** "Full transcript · 3 rounds" on the checkpoint result is a button with no target.
- **Brief discrepancies.** The three in §4, and the "Not installed" label in §5.

## 12. Paste-ready prompt for Claude Code

```text
Build the Agent Forge desktop app from the design. Read docs/plans/desktop-app/claude-code-handoff.md first, then docs/plans/desktop-app/design-brief.md. The design is the Design canvas at https://claude.ai/artifact/TwudvqBhtBXoahuEGh2rWF. Read its index at project/canvas.json and the boards with the Artifact tool.

Before any code, settle the seven decisions in §6 with the owner, and record each as a design: comment on the epic. Then build slice 1 from §2 (shell and hearth) with TDD and the repo's quality gates. Don't change the design. If a board disagrees with the brief, follow the brief and list the mismatch in the PR.
```

## 13. Files in this folder

- This handoff, with the brief, the README, `ui-pruning.md` and `claude-design-prompt.md`.
- The boards are not in the repo. Read them from the canvas.
