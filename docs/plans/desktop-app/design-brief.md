# Agent Forge Desktop — design brief

Version 1 · 2026-10-18 · Input for Claude Design, read with [`claude-design-prompt.md`](claude-design-prompt.md).
What to cut from today's dashboard is argued in [`ui-pruning.md`](ui-pruning.md); this brief already reflects it.

**How to read this.** Sections 1–4 say what the product is and the words it uses. Section 5 is the information
architecture. Section 6 specifies every screen, with a priority: **P0** must be designed, **P1** should be, **P2** if
there is room. Section 7 lists the flows to prototype end to end. Sections 8–11 cover components, states, visual
direction and platform. Section 12 is sample data to fill the screens with. Appendix A holds what each provider's CLI
can do, which drives the composer and usage screens. Appendix B maps every existing harness feature to its new home.

---

## 1. The product in one paragraph

Agent Forge Desktop is a local-first command center for one developer who runs many AI coding agents at once. Work is
grouped into **projects**. Every project has a **Forge Keeper**: a standing conversation with an agent that can see
everything in the project (the bead graph, the approval queue, forge runs, every session, reviews, usage) and tells you
what is going on when you ask, then proposes what to do next for you to approve. Beside the Keeper you open **sessions**
with any of five providers (Claude, Codex, Gemini, Grok and OpenRouter) and prompt them with the options that provider's
own CLI offers, using your own subscriptions. Everything every agent does lands in one local ledger, so one window shows
every session, from every provider, in every project.

## 2. Who it is for and what they are trying to do

One person: a senior engineer on Windows (macOS later) with paid plans at several AI providers, running several agent
workstreams in parallel across a few repositories. Their jobs:

1. **"Tell me what's going on."** Across projects, in plain language, without reading logs. The Keeper's job.
2. **"Put the right agent on this."** Start a session with the provider, model and mode that fit, bound to a bead, in
   an isolated git worktree.
3. **"Keep it moving while I'm away."** Approve work into a queue and let a bounded **shift** run it unattended. Be
   interrupted only when something needs them.
4. **"Don't waste my subscriptions."** See how much allowance is left at each provider before choosing one.
5. **"Trust, but verify."** Quality gates, checkpoints, multi-model council reviews, and an audit trail of every action.

## 3. Principles the design must express

1. **A human approves every start.** Agents and the Keeper *propose*; the user confirms. Nothing the Keeper suggests
   runs until the user presses a button on an action card. Unattended shifts take only work the user approved, open pull
   requests, and never merge.
2. **Local-first, single user.** No accounts, no app sign-in, no cloud sync, no teams, no sharing. The app talks only to
   a local server (the **hearth**) on this machine.
3. **Each provider through a CLI and its own login.** The vendor's own CLI wherever one exists (Appendix A). The app
   never asks for, stores or shows a provider password or OAuth token. "Sign in" opens that provider's own login flow.
   API keys, where a provider needs one, live in that provider's own configuration or the environment, never typed
   into or stored by the app.
4. **Show where every number comes from.** Live vs. last-known; reported by the provider vs. counted locally;
   unknown is shown as unknown ("—" with a reason), never as zero.
5. **Calm by default.** Ambient status, not alarms. Interrupt only for: approval needed, input needed (a permission
   request), a failure (gate failed, bead halted, shift stopped), a usage or budget threshold.
6. **Pro-tool density, keyboard first.** Compact, scannable, every action reachable from the keyboard and the command
   palette. Think of the density of a code editor or an issue tracker, not a consumer chat app.
7. **Everything links.** Any bead id, session, run, shift, worktree, PR or file mention is clickable wherever it appears.
8. **Safety is visible.** Risky permission modes are labelled as such; modes the harness forbids are shown locked, with
   the reason, rather than hidden.

## 4. Vocabulary: use exactly these words

The harness has a forge vocabulary. Use it consistently in labels, copy and empty states.

| Term | Meaning in the UI |
|---|---|
| **Project** | A named group of one or more repositories plus the beads, sessions, runs and reviews that belong to them. The top-level object. *(New concept.)* |
| **Forge Keeper** | The owner agent of a project: one standing chat per project, labelled "Forge Keeper". Sees everything in the project, summarizes on request, proposes actions as cards. Runs on a smith the user picks. *(New concept.)* |
| **Session** | One conversation or run with one provider's agent: a chat started in the app, a headless task, a terminal session observed through hooks, a teammate or subagent of another session. |
| **Provider** | Claude, Codex, Gemini, Grok, OpenRouter. Shown with a monogram and a provider color (see §10), never only by color. |
| **Smith** | A saved provider + model + effort combination with a name, e.g. `claude-master`, `codex-journeyman`. Used to start sessions and assigned to beads. |
| **Rank** | `master` / `journeyman` / `apprentice`: how capable (and costly) a smith is. A reviewer's rank must be ≥ the builder's. |
| **Bench** | The smiths used for a complexity class, with weights, e.g. *low = claude-apprentice 70%, codex-journeyman 30%*. |
| **Bead** | A tracked work item (task, feature, bug, epic, decision) with an id like `agent-forge-harness-x1gs.4.4`, status, priority P0–P4, acceptance criteria, dependencies and comments. |
| **Epic** | A bead that groups other beads. Shows progress. |
| **Queue state** | Where a bead stands in the approval queue: Proposed → Approved → Queued → Running → Review → Done, plus Paused and Halted. |
| **Workbench** | The board of queue states with the user's moves on each bead. |
| **Shift** | A bounded unattended run over approved beads: a time limit, a concurrency, a bead count, a spend cap. |
| **Forge run** | One pass of the research → plan → implement → ship pipeline for a feature, gated or unattended. |
| **Checkpoint** | A demo-able stop inside a forge run's implement phase that the user approves or sends back. |
| **Quality gate** | The checks run on a change: typecheck, lint, tests, clean tree, acceptance-criteria verify. |
| **Council / Review** | A panel of models from different providers reviews something independently, challenges each other, and a chair synthesizes findings (blocker / high / medium / low). |
| **Activity** | The ledger's events, shown in time order: sessions, tool calls, phases, gates, verdicts, queue moves, reviews. |
| **Hearth** | The local server the app runs and supervises. Users mostly see it only as a status chip. |
| **Worktree** | An isolated git checkout a session or shift works in, so parallel agents don't collide. |
| **Reservation** | A running bead's claim on a set of files, so two agents don't edit the same files at once. |

Never use: "crew", "tier", "pool", "drain", "ticket", "agent pool". Prefer "bead" over "issue" in UI copy, with a
tooltip ("a tracked work item") on first use.

## 5. Information architecture

### 5.1 Window frame

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ Title bar: ◆ Agent Forge  ›  Project switcher ▾   [ Search / ⌘K ]   ● Hearth  ▤ Usage  🔔 3  ⚙ │
├──────┬──────────────────────┬─────────────────────────────────────────────┬────────────────────┤
│ Rail │ Project sidebar      │ Main view                                   │ Inspector          │
│      │                      │                                             │ (contextual,       │
│ ⌂    │ ★ Forge Keeper       │                                             │  collapsible)      │
│ ✉    │ ─ Sessions ───────── │                                             │                    │
│ ▤    │  ● Codex · x1gs.4.4  │                                             │                    │
│ ⚒    │  ◐ Claude · research │                                             │                    │
│ ⚙    │  ○ Gemini · idle     │                                             │                    │
│      │ ─ Project ────────── │                                             │                    │
│      │  Overview            │                                             │                    │
│      │  Beads               │                                             │                    │
│      │  Workbench           │                                             │                    │
│      │  Runs                │                                             │                    │
│      │  Reviews             │                                             │                    │
│      │  Activity            │                                             │                    │
│      │  Settings            │                                             │                    │
└──────┴──────────────────────┴─────────────────────────────────────────────┴────────────────────┘
```

- **Title bar:** breadcrumb (Agent Forge › project), project switcher, global search / command palette (Ctrl/Cmd+K),
  hearth status chip (connected · reconnecting · stopped, with restart), usage chip (a tiny bar per provider; click
  opens Providers & usage), notification bell with count, settings.
- **Global rail** (icons with labels on hover): Projects (home), Inbox, Providers & usage, Smiths, Settings.
- **Project sidebar:** **Forge Keeper** pinned first with an unread dot. Then **Sessions**, live: grouped as Needs
  you / Running / Idle / Observed, each row a provider monogram, a short title, and a status glyph; a "+ New session"
  button. Then the project's destinations: Overview, Beads, Workbench, Runs, Reviews, Activity, Settings.
- **Inspector:** the right panel shows the selected object's details (a bead, a session, a run, an event) without
  leaving the current view. It collapses to give the main view room.
- **Keeper drawer:** from any project screen, Ctrl/Cmd+J slides the Forge Keeper chat in from the right with the
  current selection as context ("About: bead x1gs.4.4"). The full Keeper view is the same conversation.

### 5.2 Destinations

| Level | Destination | Priority | Purpose |
|---|---|---|---|
| Global | **Projects** (home) | P0 | Cards for every project, what needs you, subscription headroom |
| Global | **Inbox** | P1 | Everything waiting on the user, across projects |
| Global | **Providers & usage** | P0 | CLI install and sign-in state, usage windows, spend |
| Global | **Smiths** | P1 | Smiths, benches, scoreboard |
| Global | **Settings** | P2 | App, notifications, hearth, environment, integrations |
| Project | **Forge Keeper** | P0 | The project's owner agent, as a chat |
| Project | **Sessions** (list + session view) | P0 | Every session in the project, any provider; chat with one |
| Project | **Overview** | P0 | The project's state at a glance, with the Keeper's latest brief |
| Project | **Beads** | P0 | The bead graph: saved views, epics, detail panel |
| Project | **Workbench** | P0 | Approval queue board and shifts |
| Project | **Runs** | P1 | Forge runs: phases, checkpoints, gates |
| Project | **Reviews** | P1 | Council reviews: start, follow, read |
| Project | **Activity** | P1 | The project's ledger feed |
| Project | **Settings** | P1 | Repositories, scope, Keeper, defaults, budgets |

### 5.3 Where today's dashboard pages go

| Today | In the desktop app |
|---|---|
| Dashboard | Project **Overview** (counts, live stats, needs-you) and **Beads** saved views |
| All issues, Epics | **Beads** (tabs: Ready, In progress, Blocked, Recently closed, All, Epics) |
| Workbench | **Workbench**, plus shift controls it never had |
| Forge run | **Runs** |
| Timeline | **Activity** feed, and an Activity tab on every bead, run, session and shift |
| Council (separate page) | **Reviews**, plus "Send to council" on beads, checkpoints, queue cards and sessions |
| Repos & knowledge | Project **Settings › Repositories** |
| Insights | One throughput card on **Overview**; per-smith outcomes on **Smiths** |
| Bead builder | **New bead** dialog, reachable from anywhere |
| Skill builder, Commands | Gone as pages: prompt templates and `/` autocomplete in the composer; command palette |
| Snapshot label, Refresh snapshot, live-off banner | Gone: data is always live; one hearth status chip |
| "Writes to check" notices | **Inbox** and toasts |

---

## 6. Screens

Each screen lists its purpose, its content from top to bottom, its actions and its notable states. Data comes from the
hearth's API unless noted.

### 6.1 Projects home — P0

**Purpose.** Answer "where do I need to look?" across every project in one glance.

**Content.**
- **Needs you** strip at the top: a horizontal row of compact items across projects, e.g. "2 beads awaiting approval ·
  Agent Forge", "Permission request · Claude · Billing API", "Gate failed · x1gs.5.3", "Shift halted a bead". Each opens
  in place. Hidden when empty, replaced by a calm "Nothing needs you" line.
- **Project cards** in a responsive grid (3–4 across at 1440px). Each card:
  - Project icon (user-chosen glyph or emoji on a tinted tile), name, one-line description, repository count.
  - **Live row:** running sessions as provider monograms with a count ("◆ Claude 2 · ◇ Codex 1"); a pulsing dot when
    anything runs.
  - **Queue row:** small counts for Proposed · Running · Review · Halted, Halted in the danger color when non-zero.
  - **Run row:** the active forge run with a 4-step phase indicator (Research ▸ Plan ▸ Implement ▸ Ship), if any.
  - **Keeper line:** the first sentence of the Keeper's latest brief, with its age ("Keeper, 2h ago: Two beads moved to
    review; the Gemini adapter is blocked on a Windows test.").
  - Footer: last activity time, spend today, an unread badge for Keeper messages and notifications.
  - Hover actions: Open, Ask the Keeper, New session, Pin. Overflow: Settings, Archive.
- **New project** card at the end of the grid.
- **Subscriptions** strip at the bottom: one compact meter per provider (the same as §6.14's cards, shrunk), e.g.
  "Claude · 5-hour window 42% · resets 14:10".
- Sort and filter: Pinned first, then by "needs you", then by last activity; a filter for archived projects.

**States.** First run (no projects yet): a welcome panel that starts onboarding (§6.20). Hearth stopped: cards grey out
with last-known data and a single banner with Restart.

### 6.2 New project — P1

A dialog with 4 short steps (one screen each, with Back/Next):
1. **Name and look:** name, description, icon, color.
2. **Repositories:** pick one or more local checkouts (the harness root is suggested first; registered sub-repos
   listed; "Add a folder…" and "Clone from URL…").
3. **Scope:** which beads belong to this project: one or more epics, a label (`project:<slug>`, created if missing),
   or all beads of these repositories. A live count ("146 beads match").
4. **Forge Keeper:** pick the Keeper's smith (default `claude-master`), its autonomy (*Suggest only* or *Propose
   actions for my approval*, the default), and whether it writes a morning brief.

Finish lands on the new project's Overview with the Keeper writing its first brief.

### 6.3 Project frame and sidebar — P0

The frame from §5.1 with the sidebar filled in. Session rows show: provider monogram, title (first prompt, editable),
bound bead id in mono if any, and a status glyph: running (animated), needs you (accent dot), idle, ended, error,
observed (eye). Hover shows model and last activity. Right-click: Rename, Stop, Resume, Fork, Open in terminal,
Pop out, Archive.

### 6.4 Project overview — P0

**Purpose.** The project's state at a glance, led by the Keeper's own summary.

**Content.**
1. **Keeper brief** card (full width): "Brief · as of 09:12 · from 146 beads, 12 sessions, 3 runs". Three short
   sections: *Moving* (what progressed), *Waiting on you* (approvals, checkpoints, permission requests), *Stuck*
   (halted, failed gates, blocked chains, with why). Bead and session mentions are chips. Buttons: **Refresh brief**,
   **Ask a follow-up** (opens the Keeper with the brief quoted). A brief older than a few hours says so.
2. **Counts row:** Open · In progress · Blocked · Closed (beads); Runs in flight · Open sessions · Queued · File claims
   held (live).
3. **Needs you** list for this project (same items as the Inbox, filtered: the first three, then the total and a link to the Inbox for the rest).
4. **Live sessions** strip: cards for running sessions with provider, model, bead, current activity ("Editing
   `scripts/executors/gemini.ts`"), elapsed, tokens so far. Click opens the session.
5. **Workbench snapshot:** a mini bar of queue-state counts and any active shift (elapsed/limit, beads done/limit,
   spend/limit, Stop).
6. **Forge runs:** each in-flight run with its phase indicator and checkpoint progress (e.g. "1 of 4 checkpoints").
7. **Epics:** progress bars for the project's epics.
8. **Throughput:** beads closed per day over 30 days (one small chart), with closed-this-week and average per day.
9. **Usage in this project:** this week's tokens and cost per provider (a stacked bar), with a link to Providers.

### 6.5 Forge Keeper — P0

**Purpose.** A conversation with the project's owner agent: it knows the whole project and helps the user steer it.
This is the centerpiece of the app.

**Header.** Title "Forge Keeper" with the project name; a smith chip (e.g. "claude-master · Claude Opus 5.5 · high
effort", click to change); a **sees** chip ("Sees 146 beads · 12 sessions · 3 runs · activity since Oct 1", click for
the scope); a context meter (how full the Keeper's context is, with "Start fresh" which keeps a summary); menu: Keeper
settings, Export conversation.

**Conversation.**
- Day separators. The user's messages right-aligned or as compact blocks (designer's choice, consistent with sessions).
- Keeper messages render Markdown: headings, lists, tables, code. Bead mentions render as **bead chips** (mono id,
  short title, status color dot), sessions as **session chips** (provider monogram + title), runs, PRs and files as
  link chips. Hovering a chip previews it in the inspector.
- **What the Keeper looked at:** a one-line collapsible trace under a reply ("Read 42 beads, 380 activity events,
  3 sessions · 4.1 s"), expanding to the list of reads.
- **Action cards.** Whenever the Keeper wants something done, it proposes a card instead of doing it. A card has a
  title, what will happen in one or two lines, the objects affected as chips, cost or risk where relevant, and buttons
  **Approve** / **Edit** / **Dismiss**. After approval the card shows the result and links to the Activity entry.
  Card types to design:
  - Approve beads into the queue (one or several, each with a checkbox).
  - Start a session (provider, smith, bead, worktree): **Review & start** opens the composer pre-filled.
  - Start a shift (duration, concurrency, bead count, spend cap).
  - Send to council (source, profile, estimated cost).
  - Create beads (a short list of proposed beads with type, priority, parent; created in the Proposed state).
  - Pause, resume, reassign smith on a bead.
  - Record a decision (adds a `design:` comment to a bead).
- **Brief messages:** the scheduled or on-demand brief appears in the conversation as a distinct card (same layout as
  §6.4's brief).
- **Errors:** "The Keeper couldn't read the queue (hearth didn't answer). The answer below may be incomplete." Shown
  inline, not as a modal.

**Composer.** A multi-line input with suggestion chips when empty: "What changed since yesterday?", "What's blocked and
why?", "What should I approve next?", "How much Claude allowance is left this week?", "Summarize the Gemini adapter
work". `@` mentions beads, sessions, runs and files; `/` lists harness commands. Send (Ctrl/Cmd+Enter), Stop while
answering.

**Inspector (right).** *What the Keeper sees*: repositories, epics and labels in scope, with toggles. *Keeper notes*:
decisions and standing instructions the Keeper keeps for this project ("Prefer Codex for refactors", "Never start
shifts on Fridays"). *Earlier briefs*: a list.

**States.** First open (writing the first brief), thinking (streaming), the Keeper's smith unavailable (usage exhausted
or provider signed out: suggest switching the Keeper to another smith), conversation context nearly full.

### 6.6 Sessions list — P0

**Purpose.** Every session in the project, from every provider, in one table.

**Content.** A table, grouped by state (Needs you, Running, Idle, Ended today, Observed, Older):

| Column | Example |
|---|---|
| Provider | monogram + name: ◆ Claude |
| Title | "Gemini adapter: stream-json parser" |
| Model · effort | Claude Opus 5.5 · high |
| Smith | claude-master (or "custom") |
| Kind | Chat · Task · Terminal · Teammate · Subagent · Shift |
| Bead | `x1gs.4.4` chip |
| Where | worktree `trees/a1b2c3` · branch `feat/gemini-adapter` |
| Status | Running 12m · Needs permission · Idle · Ended ✓ · Ended ✕ · Stale |
| Last activity | "Ran `bun test scripts/executors` · 14s ago" |
| Usage | 182k tokens · ≈ $0.84 (an estimate at list price on a plan; exact on an API key or credits) |

Teammates and subagents nest under their parent session (indented, with a thread line). Filters: provider, kind,
status, bead, smith; search. Selecting a row shows it in the inspector; opening it goes to the session view. Bulk: Stop.

### 6.7 New session composer — P0

**Purpose.** "Select my provider and prompt towards that provider with all the options that CLI provider has." It opens
as a large dialog (or a full main-view page) from "+ New session", from a bead, from a Keeper action card, or from the
command palette.

**Layout, top to bottom.**
1. **Provider picker:** five large segmented tiles: Claude, Codex, Gemini, Grok, OpenRouter. Each tile shows the
   provider monogram, how it is connected ("Max plan", "ChatGPT Pro", "Gemini API key", "SuperGrok", "API key ·
   credits"), the CLI it runs through where there is a choice (Gemini: Antigravity or Gemini CLI; OpenRouter: OpenCode
   or Ori), and its headroom ("5-hour window 42% used, resets 14:10" / "$41.80 left this month" / "usage not
   reported"). A tile is disabled with a reason and a fix when the CLI is missing ("Install…") or signed out
   ("Sign in…", which opens the provider's own login in a terminal).
2. **Prompt:** a large input (Markdown-aware), attachments (files, images where the provider accepts them), `@` for
   beads/files/sessions, `/` for harness commands (e.g. `/forgemaster`, `/review`), and **Templates** (New skill,
   Fix a bug, Review a PR, Research a question, Plan a feature) that fill the prompt.
3. **Context:**
   - *Repository* (one of the project's), *Where it runs*: **New worktree** from a base branch (recommended),
     **Existing worktree**, or **Main checkout** (warning: "Edits land in your working copy").
   - *Bead* (optional): binds the session to a bead, so its activity, file reservations and usage are attributed.
   - *Run as*: **Chat** (multi-turn, stays open) or **Task** (one headless run that ends when done, with an optional
     output format).
4. **Smith preset:** pick a smith to fill model and effort in one go, or "Custom". "Save as smith…" stores the current
   options under a name.
5. **Provider options:** a panel whose fields change with the provider, grouped as *Model*, *Reasoning*,
   *Permissions & sandbox*, *Tools*, *Context*, *Limits*, *Output* and *Advanced (raw flags)*. Appendix A lists the
   exact fields for each provider. Every field shows the CLI's default when untouched. Options the harness forbids are
   shown **locked** with the reason (e.g. "Skip all permission checks: blocked by harness policy").
6. **Footer:** an **Equivalent command** preview in mono, updated live and copyable
   (`claude -p --model claude-opus-5-5 --permission-mode acceptEdits --output-format stream-json …`); a short usage
   note ("Uses your Max plan; this window resets 14:10"); buttons **Start** (Ctrl/Cmd+Enter) and **Cancel**.

**Variants to design.** One per provider (5), showing how the options panel differs; a disabled-provider state; a
pre-filled-from-bead state; a pre-filled-from-Keeper-card state.

### 6.8 Session view — P0

**Purpose.** A live conversation with one provider's agent, or a live view of a session running elsewhere.

**Header.** Provider monogram and name; editable title; chips for model, effort, permission mode (each changeable for
the next turn where the CLI allows, otherwise read-only with a tooltip); bead chip; worktree and branch chip; status;
this session's usage (tokens, cost, and the provider window it is drawing on). Actions: **Stop**, **Resume** (when
idle), **Fork…** (continue in a new session, optionally with another provider, carrying a summary), **Open in
terminal** (hands the same session to the real CLI), **Send to council**, **Activity**, overflow (Export transcript,
Copy CLI command, Pop out window, Archive).

**Transcript.**
- User turns and agent replies (Markdown, streaming with a caret).
- Reasoning / thinking, collapsed by default ("Thought for 12 s").
- **Tool activity** as compact rows grouped per turn: Read file, Search, Edit file (with an inline diff preview,
  expandable), Write file, Run command (command + exit code + last lines of output), Web fetch/search, MCP tool calls
  (the Forge tools appear as "Forge: read 12 beads").
- **Files changed** summary card at the end of a turn: files with +/− counts, "Open diff", "Open in editor".
- **Permission request card** (inline, also raised in Inbox and as an OS notification): what the agent wants to do
  (command or diff preview), why if given, and **Allow once**, **Allow for this session**, **Deny** (with an optional
  note back to the agent). Shows a countdown if the CLI times the request out. A provider route that cannot ask
  (Appendix A) runs with rules set in the composer instead, and a tool those rules refused shows as a "Denied by rule"
  row with **Allow next time**.
- **Plan / to-do blocks** when the provider emits them.
- **Turn footer:** duration, tokens in/out, cost if reported, model actually used (if it differs from the requested
  one, say so: "Requested Opus 5.5 · served Sonnet 5.5").
- **Inline errors:** usage limit reached ("Claude Opus weekly limit reached; resets Thu 09:00.", with **Continue on another
  provider**), CLI crashed (exit code + stderr tail + **Restart**), network or auth errors with the provider's own words.

**Composer.** Same as §6.7's prompt area, with the provider fixed. A compact options strip above the input shows the
current model, effort and mode; clicking opens the options panel for the next turn.

**Inspector tabs.** Details (session id, provider's session id, started, working directory, CLI version, flags used),
Files changed, Activity (this session's ledger events), Usage.

**Variants.**
- **Observed session**: a Claude Code session running in the user's own terminal, attached through hooks. Banner:
  "Observed: running in a terminal on this machine. Activity is live; the conversation stays in the terminal." Shows
  tool activity (names, files, durations: metadata only, since the ledger stores no bodies) and status. Actions: Resume
  here (once it has ended), Activity.
- **Shift session**: a headless run started by a shift for a bead. Read-only while running ("Started by shift
  `shift-20261018-0900-a1b2` for `x1gs.9.3`"), with Stop; resumable as a chat once it ends.
- **Teammate / subagent**: breadcrumb to the parent session.

### 6.9 Beads — P0

**Saved views as tabs:** Ready (unblocked and unclaimed) · In progress · Blocked · Recently closed · All · Epics.
**Toolbar:** search (id or title), filters (type, priority, status, queue state, label, epic, assignee), group by
(epic, status, none), and **New bead**.

**Table columns:** id (mono, copy on click), title (with "Blocked by x, y" under it when blocked), type icon, status,
priority (P0–P4), queue state, smith, updated. Selecting a row opens the **bead panel** in the inspector; double-click
or Enter opens it full-width.

**Bead panel.**
- Header: id, title, status, priority, type, epic breadcrumb.
- **Actions:** Claim · Comment · Close (asks for evidence) · queue move for its state (Propose / Approve / Queue / Pause
  / Resume) · **Start session** (opens the composer bound to this bead) · **Send to council** · **Ask the Keeper**.
- Tabs: **Details** (acceptance criteria as a checklist, description, labels, estimate and time spent, owner/assignee,
  due, work branches found in comments, PR links); **Dependencies** (blocks / blocked by, with a small graph);
  **Comments** (each typed by its prefix as a small badge: worklog, ac, design, deps, review; council verdict comments
  styled as a verdict); **Sessions** (sessions bound to this bead); **Files** (the bead's file map and any active
  reservation); **Activity**.
- Write outcomes: each action shows pending → done, or refused with `bd`'s words, or "outcome unknown: check the bead"
  (also sent to the Inbox).

**Epics tab.** Cards: epic id, title, status, due date, progress bar (closed of total), counts by status, and the
number of blocked children. Epic detail: its child beads table plus a dependency graph (nodes colored by status).

**New bead dialog.** Type, title (imperative), description, acceptance criteria (one per line), priority (with a short
hint per level), parent epic, labels, complexity (low / medium / high: picks the bench), file map (one glob per line),
and whether it starts as Proposed (default when created from a Keeper card) or Open.

### 6.10 Workbench and shifts — P0

**Board.** Columns: Proposed · Approved · Queued · Running · Review · Done (collapsed by default) · Paused · Halted.
Column headers show counts. Cards show: title, id, priority, complexity, smith ("default smith claude-journeyman" or
assigned), and per state:
- Queued: **May start**, or **Waits** with why ("blocked by x1gs.4.3", "files reserved by x1gs.8.1: `docs/js/**`",
  "host busy (CPU 91%)", "no free slot in the shift").
- Running: the session as a chip (provider, elapsed), the worktree.
- Review: the draft PR link, gate result, checkpoint status.
- Halted: why, and repair attempts used ("3 of 3").
- Moves as buttons, valid moves only (Propose, Approve, Queue, Pause, Resume), **Reassign smith** (select + apply),
  **Send to council**. Drag-and-drop between columns may be offered, highlighting only the columns that move is
  allowed into.

**Shift panel** above the board: each active shift as a row: id, started, elapsed / limit (e.g. 1h12m / 2h),
concurrency, beads done / limit, spend / cap (e.g. $3.40 / $10), host load (CPU and memory vs. the 85% throttle),
state (running, throttled, stopping), **Stop**. A shift whose process died shows **Recover**. **Start shift** opens a
dialog: duration (default 2h), concurrency (1–8, default 2), max beads (default 4), spend cap (default $10), repairs
(0–10, default 3), epic filter, smith override, base branch, per-run timeout. Each default shows where it came from
("from agent-forge.toml"). Copy reminds: "Shifts open draft pull requests and never merge."

### 6.11 Runs — P1

**List:** run slug, title, route (Full / Mini), mode (Gated / Unattended), current phase, health (On track, Waiting on
you, Gate failed, Shipped), started, sessions involved.

**Run detail:**
- **Phase stepper:** Research → Plan → Implement → Ship, each with status (complete, active, locked), a one-line
  description, its artifact (research doc, plan, ship report) opening in an in-app Markdown viewer, and review rounds
  (pass/fail, findings by severity).
- **Checkpoints:** list with status and "waiting on"; the active one has a **Review checkpoint** box: note, **Approve
  checkpoint**, **Request changes** (needs a note), **Send to council**.
- **Quality gate:** five checks (typecheck, lint, tests, clean tree, AC verify) as pass / fail / skipped with the
  message ("Found 2 errors", "no test files"), the checkout and branch, and gate history.
- **Sessions** that worked on this run; **Activity**.

**New forge run:** from a feature bead or free text; choose Gated or Unattended and Full / Mini / auto-route. It starts
a Claude session with the pipeline's command, so it opens in the composer pre-filled.

### 6.12 Reviews (council) — P1

**List:** each review's source (bead, PR, plan, research file, pasted text), profile, status, recommendation,
findings by severity, cost, duration.

**New review:** source picker (Bead, GitHub pull request, Local plan, Local research or text file, Paste); profile with
its **seats** shown as small cards (role, provider/model, readiness: ready / needs key / unsupported); budget in USD;
"Redact detected secrets; otherwise reject"; routing policy (for OpenRouter seats); deep discussion toggle; estimated
cost; **Convene council**.

**Live review:** the seats grid with each seat's progress (reviewing → discussing round n → done / failed), a
discussion round selector, and **Stop review**.

**Result:** a recommendation banner; findings list with severity, resolution (consensus, contested, unreviewed,
rejected) and a "severity disputed" flag; "Why reviewers agreed or objected"; discussion rounds (what changed each
round, new findings, strengths, unknowns); limitations and provider failures; supplied evidence; full transcript; and
a preview of the `review: COUNCIL …` comment posted back to the bead.

### 6.13 Activity — P1

The project's ledger as a virtualized feed grouped by time, each event one line: time, kind icon, actor (provider
monogram or "you"), summary ("Codex edited 3 files in `scripts/executors/`", "Gate failed: lint", "You approved
x1gs.4.4"), and chips. Filters: kind (sessions, tool calls, prompts, phases, reviews, gates, verdicts, bead changes,
reservations, shifts, council, operator actions), provider, bead, run, session, shift; time range. An event opens in
the inspector with its metadata (sizes, hashes, durations; no bodies, by design). The same component is the Activity
tab on beads, runs, sessions and shifts.

### 6.14 Providers & usage — P0

**Purpose.** One place to see each provider's state and how much of each subscription is left.

**Top summary:** "Where you have room": providers ranked by remaining headroom right now, as information only (the app
never routes work by quota on its own).

**One card per provider** (Claude, Codex, Gemini, Grok, OpenRouter):
- Monogram, name, connection: CLI installed (version, path) or "Not found" with install guidance; signed in with a
  subscription (plan name), with an API key, or signed out ("Sign in…" opens the provider's own login).
- **Usage meters** in the provider's own terms (Appendix A says what each one reports): rolling windows with percent
  used and a reset countdown, daily request counts, monthly spend, or a credit balance. Where the provider does not
  report it, say "Not reported by this CLI" and show what the app counted itself (tokens and cost from its own
  sessions this week), labelled as counted locally.
- **By project this week:** a stacked bar of usage per project.
- Models available, smiths that use this provider, last doctor check with "Run doctor".
- Alert thresholds ("Notify me at 80% of a window").

**States:** not installed, installed but signed out, subscription, API key, usage exhausted ("resets in 1h 12m"),
reporting unavailable, CLI version too old for a feature.

### 6.15 Smiths — P1

- **Smiths table:** name, provider, model, effort, rank, enabled, tags, and **provenance** for each value (built-in,
  machine config, workspace config, environment), shown as a small source badge with the file path on hover. Edit and
  New smith open a dialog that writes the config and shows which file it will write.
- **Benches:** low / medium / high, each a weighted bar of smiths (e.g. 70% claude-apprentice, 30% codex-journeyman),
  editable; the **default smith**.
- **Scoreboard:** per smith over a chosen range: sessions started / completed / failed / timed out, gate pass rate,
  evaluator verdicts, review rounds and findings by severity, council runs and cost, tokens and cost. Unknown values
  show as "—", never 0.

### 6.16 Inbox — P1

Everything waiting on the user, across projects, newest first, grouped by project: beads awaiting approval,
checkpoints awaiting review, permission requests, failed gates, halted beads, stopped shifts, council verdicts, bead
writes with unknown outcome, usage thresholds. Each item has its action inline (Approve, Review, Allow / Deny, Open,
Retry) plus Snooze and Mark done. Filters by type and project.

### 6.17 Command palette — P1

Ctrl/Cmd+K. Fuzzy search across projects, beads, sessions, runs, reviews, smiths and settings; actions (New session,
New bead, Ask the Keeper, Approve…, Start shift, Send to council, Switch project, Toggle theme); harness slash commands
with their argument hints. Shows recent items when empty. Keyboard hints on every row.

### 6.18 Project settings — P1

- **General:** name, description, icon, color, archive / delete project (the project record only; never repositories
  or beads).
- **Repositories:** each repository's path, branch, clone state, knowledge file age (stale after 30 days, with
  **Refresh knowledge**), and its worktrees (branch, path, created, state: present / path missing, with Clean up).
- **Scope:** epics and labels included, with the live bead count.
- **Forge Keeper:** smith, autonomy, brief schedule, what it can see.
- **Defaults:** default smith per provider for new sessions; default "where it runs"; default run-as.
- **Budgets:** shift spend cap; a daily cap for API-key providers.
- **Notifications:** per-event toggles for this project.

### 6.19 App settings — P2

General (launch at login, keep running in the tray, theme: dark / light / system, density); Notifications (quiet
hours, which events notify); Hearth (status, port, restart, logs, ledger location and size, nightly backups kept 14
days, events older than 90 days compacted); Execution environment (which environment variables spawned agents may
see); Integrations (register the Forge MCP tools for Claude Code, Codex and Cursor); Updates; About and doctor.

### 6.20 First-run onboarding — P1

1. Welcome: what the app does in three lines.
2. **Providers:** the app checks each CLI. Each row: found / not found (with the install command to copy) and signed in /
   signed out (with "Sign in…" opening that provider's login). Any provider can be skipped.
3. **First project:** pick the folder (the harness root is suggested), name it.
4. **Meet the Keeper:** the Keeper writes its first brief while the user watches; then lands on Overview.

### 6.21 Tray and OS notifications — P2

- **Tray icon** with a badge for "needs you". Menu: Running n · Needs you n · In review n; the last five
  notifications; Pause all shifts; Quiet hours on/off; Open Agent Forge; Quit (asks whether to stop running shifts).
- **Notifications** (Windows toast style), each with up to two actions: "x1gs.9.1 is waiting for approval" (Approve,
  Open); "Claude wants to run `bun install` in Billing API" (Allow, Open); "Gate failed on x1gs.5.3: lint" (Open);
  "Shift halted x1gs.9.3 after 3 repairs" (Open); "Council verdict on x1gs.7.2: revise, 1 high" (Open); "Claude 5-hour
  window at 80%" (Open usage).

### 6.22 Pop-out session window — P2

A session in its own compact window (the transcript and composer, no sidebars), so the user can watch several side by
side.

---

## 7. Flows to prototype end to end

1. **Morning check-in.** Projects home shows "Needs you: 3" → open *Agent Forge* → Overview's Keeper brief → ask the
   Keeper "What's blocked and why?" → the answer with bead chips → an action card "Approve 2 beads into the queue" →
   Approve → the cards update on the Workbench.
2. **Put Codex on a bead.** Beads › Ready → select `x1gs.4.4` → **Start session** → composer pre-filled (bead bound,
   new worktree) → pick Codex, model, reasoning effort, sandbox mode → Start → the session streams tool activity → a
   permission request card → Allow once → files-changed card → **Send to council**.
3. **Leave it running.** Workbench → approve three beads → **Start shift** (2h, concurrency 2, $10 cap) → shift panel
   live → one bead halts → OS notification → open the halted bead → **Ask the Keeper** "why did this halt?" → the
   Keeper explains from the activity log and proposes a fix bead.
4. **Choose by headroom.** Usage chip shows Claude's 5-hour window at 82% → Providers & usage → start the next session
   on Gemini from the provider card.
5. **Review a checkpoint.** Runs → active run → checkpoint "Build the primitives" → Send to council → live seats → result
   → Approve checkpoint with a note.

## 8. Components to design

Extend the existing primitives (Button, Tag, Card, Table, Field/Input/Textarea/Select, StatCard, ProgressBar,
EmptyState, Dialog, Icon, AppShell) with:

- **Provider monogram** (5 providers + "you" + "Keeper"), sizes 16/20/28/40, with a status ring (running, needs you,
  error).
- **Bead chip**, **session chip**, **run chip**, **PR chip**, **file chip**; hover preview.
- **Status glyphs** for session, bead, queue, gate, shift and council states (one consistent family).
- **Chat message** (user, agent, Keeper), **streaming caret**, **reasoning block**, **tool activity row** (per tool
  kind), **diff preview**, **command output block**, **files-changed card**, **permission request card**, **Keeper
  action card** (pending, approved, done, failed, dismissed), **brief card**.
- **Composer** with attachment tray, `@`/`/` popovers, templates menu, options strip and options panel.
- **Option controls** for the provider panel: segmented control, model picker (with model descriptions), effort
  slider (named steps), permission-mode selector (with a risk badge per mode), tool allow/deny list editor, key/value
  editor (MCP servers, environment), locked-option row.
- **Usage meter** (rolling window with reset countdown; daily count; credit balance; monthly spend; unknown), small
  (title bar) and large (provider card).
- **Phase stepper**, **checkpoint row**, **gate check tile**, **queue column** and **queue card**, **shift row**,
  **seat card**, **finding row** (severity + resolution), **dependency mini-graph**, **activity row**.
- **Inspector panel**, **drawer**, **toast**, **inbox item**, **command palette row**, **title-bar chips**.
- **Equivalent-command block** (mono, copy button, wraps long flags).

## 9. States to cover

| Object | States |
|---|---|
| Hearth | Connecting · Connected · Reconnecting (with attempt) · Stopped (Restart) · Version mismatch |
| Provider | Not installed · Signed out · Subscription · API key · Usage exhausted (resets at) · Reporting unavailable · Degraded (errors) |
| Session | Starting · Running · Needs permission · Waiting for input · Idle (resumable) · Ended ✓ · Ended with error · Stopped · Timed out · Stale (no events for a while) · Observed |
| Bead | Open · In progress · Blocked · Closed; P0–P4 |
| Queue | Proposed · Approved · Queued (may start / waits) · Running · Review · Done · Paused · Halted |
| Shift | Starting · Running · Throttled (host busy) · Stopping · Stopped (elapsed, operator, budget, count, drained, halted, throttle) · Failed to start · Needs recovery |
| Forge run phase | Complete · Active · Locked · Gate failed |
| Gate check | Pass · Fail · Skipped · Not run |
| Council | Queued · Reviewing · Discussing · Synthesizing · Complete · Failed · Cancelled |
| Write (any action) | Sending · Done · Refused (with reason) · Outcome unknown |
| Lists | Loading (skeleton rows) · Empty (with the next step) · Error (what happened, what it means, what to do) · Filtered to nothing |

Copy rule for errors: say what happened, what it means, and what to do, in plain words. Never "Something went wrong."

## 10. Visual direction

**Start from Nocturne, the harness's existing design system** (`docs/js/ds/tokens.css`, `docs/js/ds/components.css`,
`docs/js/ds/README.md`; screenshots in `docs/images/nocturne/`). Keep its character: a near-neutral blue-grey ground
(`#161826`), surfaces at `#232532`, text `#e9e9ed`, one lavender accent (`#9184d9`) used as a line and a glow rather
than a flood, Inter at 400/500 (headings never bolder than 500), a mono face for ids and code, compact spacing (a 0.7×
density scale, 2.8–22.4px), 8px radii (4/8/14), elevation as a hairline edge plus ambient darkness, Phosphor icons,
and a 2px accent focus ring that is never removed.

**Extend it where the desktop app needs more:**
- **Semantic status roles.** Nocturne has none today (tags are neutral / accent / outline / muted only). Add
  success, warning, danger and info ramps, generated like the existing ones (OKLCH, the same lightness scale), so
  failures, halts and usage warnings read at a glance without breaking the calm.
- **Provider colors.** Five distinguishable hues for Claude, Codex, Gemini, Grok and OpenRouter, plus the accent for
  the Forge Keeper. Always paired with a monogram and name; never the only cue. Do not use the providers' logos; use
  neutral monograms.
- **A light theme** derived from the same ramps, selectable in settings (dark stays the default).
- **Chat and terminal surfaces:** transcript typography, code blocks, diff colors, command output.
- **Motion:** subtle and functional only: a pulse on "running", a streaming caret, panel slides. Respect reduced motion.

**Accessibility.** WCAG 2.2 AA text contrast (the accent at ~3:1 is for icons and large text only; body text in the
accent uses `--color-accent-300`); full keyboard operation; visible focus; live regions for streaming text and
notifications; hit targets ≥ 24px; never color alone for status.

## 11. Platform and window

- Desktop app built with **Tauri 2** around the web UI (Preact), Windows first (WebView2), macOS second. Design at
  **1440×900**; must work down to **1100×700** (inspector collapses, sidebar narrows to icons) and up to ultra-wide
  (main view max line length for transcripts).
- Native window controls on Windows; a custom title bar that holds the chips in §5.1 is welcome.
- Multiple windows: the main window plus popped-out sessions.
- Deep links: `agent-forge://project/<id>`, `agent-forge://bead/<id>`, `agent-forge://session/<id>`.
- The app starts and supervises the hearth itself; the user never starts a server.

## 12. Sample data (illustrative; use it to fill the screens)

**Projects**
| Project | Repositories | Beads open / in progress / blocked / closed | Live |
|---|---|---|---|
| Agent Forge | agent-forge-harness | 94 / 3 / 24 / 452 | Keeper; Codex on x1gs.4.4; Claude Code in a terminal; one shift |
| Billing API | billing-api | 31 / 3 / 4 / 210 | Claude chat; a permission request waiting |
| Mobile App | mobile-app, web-client | 58 / 1 / 9 / 133 | Gemini task running |
| Legacy Worker | legacy-worker | 12 / 0 / 1 / 77 | Idle 6 days; knowledge file 45 days old |

**Beads (Agent Forge)**
| Id | Title | Type | P | Status | Queue |
|---|---|---|---|---|---|
| `agent-forge-harness-x1gs.4.4` | Third adapter: Gemini CLI | task | P3 | in progress | Running |
| `agent-forge-harness-x1gs.8.3` | Sessions board: who is running, where, with which smith | task | P2 | open | Queued (waits: files reserved by x1gs.8.1) |
| `agent-forge-harness-x1gs.9.1` | Tauri 2 desktop shell: window, sidecar, tray, deep links | task | P2 | open | Proposed |
| `agent-forge-harness-x1gs.9.3` | Claude Code mod: band with counts, queue pane, /forge-board | task | P2 | in progress | Running (shift) |
| `agent-forge-harness-x1gs.5.3` | File reservations and eligibility | task | P2 | in progress | Review (gate failed: lint) |
| `agent-forge-harness-t1b1.6` | Calibrate council quality, cost, and stopping rules | task | P2 | open | Approved |
| `agent-forge-harness-x1gs` | Agent Forge Command Center | epic | P2 | open | — (61% of 52 children closed) |

**Smiths:** `claude-master` (Claude, claude-opus-5-5, high, master) · `claude-journeyman` (Claude, claude-sonnet-5-5,
medium, journeyman, default) · `claude-apprentice` (Claude, claude-haiku-5-5, low, apprentice) · `codex-journeyman` (Codex,
gpt-5-codex, medium, journeyman). Benches: low = claude-apprentice 70 / codex-journeyman 30; medium =
claude-journeyman 70 / codex-journeyman 30; high = claude-master 100.

**Sessions**
| Project | Title | Provider · model · effort | Kind | Bead | Status |
|---|---|---|---|---|---|
| Agent Forge | Forge Keeper | Claude · claude-opus-5-5 · high | Keeper | — | Idle; brief 09:12 |
| Agent Forge | Gemini adapter: stream-json parser | Codex · gpt-5-codex · high | Chat | `x1gs.4.4` | Running 40m · 182k tokens |
| Agent Forge | Fix the rebuild-pages flake | Claude · claude-sonnet-5-5 | Terminal (observed) | — | Running · last: Edit `scripts/dashboard/rebuild-pages.ts` |
| Agent Forge | Claude Code mod: band and queue pane | Claude · claude-sonnet-5-5 · medium | Shift | `x1gs.9.3` | Running 22m |
| Agent Forge | Compare OpenRouter routing options | OpenRouter via OpenCode · deepseek/deepseek-v4-pro | Task | — | Ended ✓ · $0.12 |
| Agent Forge | Draft release notes for 0.2 | Grok · grok-4.7 · medium | Chat | — | Idle 2h |
| Billing API | Upgrade the Stripe SDK | Claude · claude-sonnet-5-5 · medium | Chat | `billing-api-k2p` | Needs permission: `bun install` |
| Mobile App | Migrate navigation to the new router | Gemini · Pro (Gemini CLI, API key) | Task | `mobile-app-77f` | Running 9m |

**Usage (Providers & usage, title-bar chip)**
| Provider | Connected as | What the meters show |
|---|---|---|
| Claude | Max plan | 5-hour window 42% used, resets 14:10 · Opus weekly 100% used, resets Thu 09:00 · weekly 61%, resets Thu 09:00 |
| Codex | ChatGPT Pro | Weekly window 18% used, resets Mon 00:00 (no 5-hour window on Pro) |
| Gemini | Gemini API key (Gemini CLI) | 212 requests today, counted locally · $1.90 this month |
| Grok | SuperGrok (Grok Build) | Weekly allowance: not reported by this CLI · 1.2M tokens this week, counted locally |
| OpenRouter | API key, prepaid credits | $41.80 of the key's $100 monthly limit left · $58.20 spent this month |

**Shift:** `shift-20261018-0900-a1b2`: started 09:00, 1h12m of 2h, concurrency 2, 1 of 4 beads done, $3.40 of $10,
CPU 63% / memory 71%.

**Forge run:** `design-system`, "Adopt a shared design system": Research ✓, Plan ✓, Implement (active, 1 of 4
checkpoints), Ship locked; gate: typecheck ✓, lint ✕ "Found 2 errors", tests ○ "no test files", clean tree ✓,
AC verify ✓.

**Keeper brief (example):** *Moving:* x1gs.4.4 (Gemini adapter) has a working stream parser; Codex has been on it 40
minutes. *Waiting on you:* x1gs.9.1 is proposed; checkpoint "Build the primitives" needs review; Billing API's Claude
session wants to run `bun install`. *Stuck:* x1gs.8.3 waits on files x1gs.8.1 holds; x1gs.5.3 failed lint twice. Spend
today: $6.20 across API-key providers; Claude's 5-hour window 42% used.

## 13. Out of scope: do not design

- Accounts, sign-up, team members, sharing, comments by other people, cloud sync, billing for the app.
- A code editor or file tree (open files in the user's editor instead).
- Merging pull requests from the app (the harness never merges).
- Automatic routing of work by remaining quota ("subscription arbitrage" is a non-goal; the app informs, the user
  chooses).
- Entering or showing provider passwords, OAuth tokens or API keys.
- The pages removed in `ui-pruning.md`: Commands, Skill builder, Insights as a page, the separate Council document,
  snapshot controls.

---

## Appendix A — Providers: connection, composer options, usage

The composer (§6.7), the session view (§6.8) and Providers & usage (§6.14) depend on what each provider's own CLI can
do. The design should show each provider in its real shape rather than flatten them into one form.

### A.1 Summary

| Provider | Reached through | How it signs in | Runs today in the harness |
|---|---|---|---|
| **Claude** | Claude Code CLI (`claude`): `-p` for tasks, a long-lived stream-json process or `--resume` for chats | Claude plan, signed in to the CLI by the user, or an Anthropic API key | Yes: headless adapter `scripts/executors/claude.ts` |
| **Codex** | Codex CLI (`codex`): `exec` for tasks, the app-server for chats | Sign in with ChatGPT (subscription), or an OpenAI API key | Yes: headless adapter `scripts/executors/codex.ts` |
| **Gemini** | Antigravity CLI (`agy`) for Google AI Pro / Ultra; Gemini CLI (`gemini`) for API keys, Vertex AI and Code Assist | Google sign-in (consumer route under a terms question: A.4), a Gemini API key, Vertex AI, or a business sign-in | Planned for Gemini CLI only: `x1gs.4.4` |
| **Grok** | Grok Build (`grok`), xAI's official open-source CLI | X / SuperGrok subscription (browser or device-code sign-in), or an xAI API key | No |
| **OpenRouter** | An agent CLI pointed at OpenRouter: OpenCode (built-in provider) or Ori (OpenRouter's own CLI, a 0.x preview) | OpenRouter API key, or `ori login`; prepaid credits, no subscription | Council reviews only (`scripts/council/providers.ts`) |

### A.2 Claude (Claude Code CLI)

- **Sign-in.** A Claude plan (Pro, Max, Team, Enterprise) that the user signed in to the unmodified `claude` binary
  themselves, or an Anthropic API key. `claude auth status` tells the app which. In plan mode the app keeps
  `ANTHROPIC_API_KEY` out of the child's environment, because a key that is present always wins in headless runs.
- **Session modes.** Task: `claude -p` with `--output-format stream-json` (init, assistant and tool messages, partial
  text, rate-limit events, and a result with cost and usage) and optionally `--json-schema` for structured output.
  Chat: one long-lived process that reads turns as JSON lines on stdin (`--input-format stream-json`), or one run per
  turn with `--resume <id>`. The app can choose the session id itself (`--session-id`) and fork a session
  (`--fork-session`).
- **Permission requests.** `--permission-prompt-tool` hands each approval to an MCP tool. Pointing it at the hearth's
  own MCP server makes the permission card (§6.8) native for Claude.
- **Composer fields.**
  - Model: the Opus, Sonnet, Haiku and Fable aliases, "opusplan", 1M-context variants, or a full id such as
    `claude-opus-5-5`; up to three fallback models.
  - Effort: low, medium, high, xhigh, max, ultracode. Thinking on or off where the model allows it (always on for the
    5.5 models and Fable).
  - Permission mode: Default, Accept edits, Plan, Auto, Don't ask. "Bypass permissions" is locked (decision #6).
  - Tools: allowed and disallowed tools, the tool set itself, agents, plugins.
  - Context: extra directories, MCP servers (with "only these" strict mode), settings, text appended to or replacing
    the system prompt.
  - Limits, for tasks: maximum turns, a maximum spend in USD (a list-price estimate, not the plan's allowance), an
    output schema.
  - Where: a worktree.
  - Images: sent as content in the input stream; there is no flag for them.
- **Usage the app can show.** Per run, tokens by model and a cost estimate at list prices, labelled as an estimate
  because a plan is not billed per token. For the plan itself, the stream's rate-limit events say allowed, warning or
  rejected, with a reset time, and an experimental usage report gives the 5-hour session window and the weekly windows
  as percent used with reset times. Running out arrives as a recognizable error ("session limit · resets 3:45pm").
  Show these as reported, marked "experimental" where they are.

### A.3 Codex (Codex CLI)

- **Sign-in.** A ChatGPT plan (Plus, Pro, Business, Edu, Enterprise) or an OpenAI API key. The app learns which, and
  the plan's name, from the CLI itself (`codex login status`, or the app-server's account read).
- **Session modes.** Task: `codex exec --json`, a JSON-lines stream of thread, turn and item events (agent message,
  reasoning, command run, file change, MCP tool call, web search, to-do list), with token counts on each completed
  turn. Chat: `codex exec resume <id>` per turn, or the long-lived **app-server** (JSON-RPC over stdio; marked
  experimental), which streams text deltas, lists threads and models, and sends **approval requests** for commands and
  file changes back to the app, so the permission card (§6.8) is native. `codex exec fork <id>` branches a session.
- **Composer fields.**
  - Model, from the CLI's own model list.
  - Reasoning effort as named steps, only those the chosen model supports (from none and minimal up to xhigh and
    beyond); reasoning summary; verbosity.
  - Sandbox: Read only, Workspace write, Full access (danger badge). The combined "bypass approvals and sandbox"
    switch is locked.
  - Approvals: On request, Never, or the automatic reviewer.
  - Working directory, extra writable directories, worktree.
  - Images; web search: off, cached, indexed or live.
  - MCP servers; config profile; service tier (default, priority, flex); output schema for tasks.
- **Usage the app can show.** Token counts per turn. With ChatGPT sign-in, the app-server reports each limit window as
  percent used, window length and reset time (typically a 5-hour and a weekly window; Pro has no 5-hour window), plus
  any credits, and pushes an update when they change. `codex exec` alone reports no windows, so the usage meters come
  from the app-server. With an API key there are no plan windows: show spend counted locally.

### A.4 Gemini (Antigravity CLI or Gemini CLI)

- **Which binary.** Since 2026-06-18 Google's consumer plans (Google AI Pro and Ultra) and its free tier use
  **Antigravity CLI** (`agy`) instead of Gemini CLI. **Gemini CLI** (`gemini`) remains for Gemini API keys, Vertex AI,
  and organizations with a Gemini Code Assist license. The provider tile says which route it runs ("Gemini · via
  Antigravity, Google AI Pro" or "Gemini · via Gemini CLI, API key"), and the composer has a route selector when both
  are set up. The planned adapter (`x1gs.4.4`) covers only Gemini CLI (decision 6 in `README.md`).
- **Terms warning for the Antigravity route.** Google's FAQ says wrapping `agy` inside third-party applications is not
  supported under consumer plans. The design shows the route, but marks it as needing the owner's decision until
  that is settled (decision 7); an API-key or business sign-in route is the safe default.

**Antigravity CLI (`agy`)**
- **Session modes.** Task: `agy -p` with `--output-format json` or `stream-json` (init, typed step updates, and a
  result with status, response, structured output and usage). Chat: `--conversation <id>` or `--continue`, or one
  long-lived process reading turns as JSON lines on stdin. Approval requests do not reach the app in this mode: a tool
  the session's rules don't allow is denied, so the composer sets the allow rules before the run. Google's separate ACP
  server (`antigravity-acp`) does send permission requests, but signs in on its own and reports no usage.
- **Composer fields.** Model (Gemini models, plus the Claude and GPT models Google's plans include, listed by the CLI
  itself); effort (low, medium, high); mode (Default, Accept edits, Plan; Auto is not available on Windows); tool
  permission policy (request review, always proceed, strict; "skip permissions" locked); sandbox (Windows 11 24H2 or
  later); extra directories; files, images, PDFs and audio attached by `@`; MCP servers; plugins; an output schema for
  tasks.
- **Usage the app can show.** The best of any provider: `agy -p "/usage" --output-format json` reports, without
  spending quota, each model group's 5-hour and weekly windows as the share remaining and the reset time, and AI
  credits once the plan's quota is used up.

**Gemini CLI (`gemini`)**
- **Session modes.** Task: `gemini -p` with `--output-format json` or `stream-json` (init, message, tool
  use, tool result, error, and a result with token statistics). Chat: `--resume latest|<id>`, or start under the app's
  own id with `--session-id`. Long-lived: the Agent Client Protocol (`gemini --acp`), with session modes and model
  switching.
- **Composer fields.** Model (Auto, Pro, Flash, Flash-Lite); thinking budget (a settings value, not a flag: an advanced
  field); approval mode (Default, Auto-edit, Plan; "YOLO" locked); a policy file; sandbox (Docker, Podman, LXC, Windows
  native, Seatbelt on macOS); included directories; worktree (experimental); files and images attached by `@path`;
  Google web search on or off; MCP servers; extensions; checkpointing. There is no output-schema option.
- **Usage the app can show.** Token statistics per run. The remaining daily quota appears only inside the CLI's
  interactive stats, so the app shows "Not reported by this CLI" beside the requests it counted today, against the
  documented cap for the tier (for example 1,500 requests a day on Code Assist Standard, 2,000 on Enterprise). Running
  out arrives as an error the app can name ("daily quota reached").

### A.5 Grok (Grok Build)

- **Shape.** xAI's official, open-source coding CLI, `grok` (`xai-org/grok-build`, 1.0.x; WinGet `xAI.GrokBuild`). It
  signs in with the user's X / SuperGrok subscription, whose usage comes from one weekly pool shared across Grok
  products, or with `XAI_API_KEY` (billed separately). xAI explicitly allows its subscriptions in third-party
  harnesses. An unofficial community `grok-cli` installs a binary with the same name: the doctor must tell them apart.
- **Session modes.** Task: `grok -p` with `--output-format json` or `streaming-json`; the result carries the session
  id, stop reason, token usage (including reasoning tokens), turns and cost. Chat: `--resume <id>`, `--continue`,
  `--fork-session`. Long-lived: Agent Client Protocol over stdio (`grok agent stdio`).
- **Composer fields.** Model (`grok-4.7`, the default; `grok-build-0.1`, the coding model; others); effort, from none
  to max, limited to the levels each model accepts; permission mode (Default, Accept edits, Plan, Auto, Don't ask;
  "Bypass permissions" and `--yolo` shown locked); allow / deny rules such as `Bash(git *)`; tools and disallowed tools;
  sandbox; agents; worktree; maximum turns; working directory; MCP servers (it also imports the project's `.mcp.json`).
- **Usage the app can show.** Tokens and cost per session (`grok usage <session-id>` and each run's result). The
  subscription's weekly pool appears only in the CLI's interactive `/usage`, so the app shows "Not reported by this
  CLI" for it, beside locally counted usage. With an API key, every response's cost is reported; the account balance
  needs a management key: optional.

### A.6 OpenRouter

- **Shape.** One account reaching hundreds of models from many vendors, billed from prepaid credits. There is no
  subscription. A session runs through an agent CLI pointed at OpenRouter (decision 4 in `README.md`):
  - **OpenCode** (open source, many providers, OpenRouter built in): `opencode run --format json` for tasks, and
    `opencode serve`, a local HTTP server with an event stream and permission round-trips, for chats. It is moving
    from v1 to v2, so a version must be pinned.
  - **Ori**, OpenRouter's own CLI (0.x, a preview): `ori login` signs in without a pasted key; `ori code -p` is its
    own agent; its harness mode starts Claude Code, Codex, OpenCode or Grok Build pointed at OpenRouter.
  - Claude Code can be pointed at OpenRouter for Anthropic models only, and Codex through a custom provider that speaks
    the Responses API. Neither is the main route.
- **Composer fields.** The agent it runs through (OpenCode or Ori); model as a searchable list with vendor, context
  length and price per million tokens (e.g. `x-ai/grok-4.7`, `deepseek/deepseek-v4-pro`, `qwen/qwen3.8-max-0902`);
  reasoning variant; approvals (OpenCode's "approve anything not explicitly denied" shown locked); provider routing
  preferences, the same "gateway routing policy" the council already offers.
- **Usage the app can show.** All of it, from OpenRouter's key endpoint (`GET /api/v1/key`): the key's limit, what
  remains, when the limit resets, spend today / this week / this month, and free-model requests left today. Every
  response also reports its own cost, so each session shows exact spend. Out of credits arrives as a clear error
  ("402: add credits"). The hearth reads the endpoint with the key it already uses for council reviews
  (`OPENROUTER_API_KEY` in the environment). The account's total balance needs a separate management key: optional.

### A.7 Rules that apply to every provider

- The app runs the provider's own, unmodified CLI with the user's own sign-in. It never handles the provider's
  password, OAuth token or API key, and never reads a CLI's credential file: Anthropic and Google both forbid reusing
  their CLIs' sign-in outside those CLIs.
- Every option shows the CLI's own default when untouched, and the equivalent command line shows exactly what will run.
- Options that can skip permission checks or the sandbox are visible but locked, with the reason.
- A provider that reports nothing about remaining allowance is shown as "Not reported by this CLI", never as 0% used.

## Appendix B — Existing harness features and where they live

| Capability (exists today) | Where it is | Screen in the app |
|---|---|---|
| Beads tracker: create, claim, comment, close | `bd`; hearth `POST /beads…` | Beads, bead panel, New bead |
| Approval queue and its moves | `scripts/scheduler/queue.ts`; `GET /queue`, `POST /queue/:id/<move>` | Workbench |
| Why a queued bead waits (eligibility, reservations) | `GET /eligibility`, `GET /reservations` | Workbench cards, bead panel |
| Shifts: start, stop, recover | `forge:shift`; `GET/POST /shifts…` | Workbench shift panel |
| Forge runs (phases, checkpoints, review rounds) | `scripts/forge/`; `GET /runs`, `GET /runs/:slug` | Runs |
| Checkpoint review | `POST /dev-api/forge-run/review` | Runs › checkpoint |
| Quality gate results | `.claude/hooks/quality-gate.ts`; ledger `gate.ran` | Runs, bead panel |
| Ledger of every event | `scripts/ledger/`; `GET /events`, `GET /stream` | Activity, every Activity tab |
| Sessions across providers | `GET /sessions` | Sessions list, sidebar |
| Headless execution through provider CLIs | `forge:exec`; adapters in `scripts/executors/` (Claude, Codex) | Composer "Task", shift sessions |
| Provider CLI checks | `forge:doctor` | Providers & usage, onboarding |
| Smiths, benches, config with provenance | `forge:config`; `GET /smiths`, `GET /config` | Smiths, Settings |
| Scoreboard per smith | `forge:audit --scoreboard`; `GET /scoreboard` | Smiths, Overview |
| Council reviews | `scripts/council/`; `POST /council/runs`, preview, cancel | Reviews, "Send to council" |
| Worktrees | `bun run worktree`; `GET /worktrees` | Project settings, session header |
| Repositories and knowledge files | `repos/repos.json`, `knowledge/` | Project settings › Repositories |
| Forge MCP tools for agents | `bun run hearth:mcp` (`forge_*`, `council_*`) | Settings › Integrations; the Keeper's own tools |
| Slash commands and skills | `.claude/commands/`, `.claude/skills/` | Composer `/` menu, templates, palette |
| Notifications (planned) | `x1gs.9.2` | Tray, OS notifications, Inbox |
