# Agent Forge Desktop — design inputs

Generated: 2026-10-18 · Status: **ready for a Claude Design pass; nothing built yet**

The desktop app turns the harness into one command center: **projects**, each with a **Forge Keeper** chat (the
project's owner agent, which can see every bead, run and session and summarizes on request), sessions with Claude,
Codex, Gemini, Grok and OpenRouter driven through each provider's own CLI and subscription, and the existing harness
features (beads, workbench and shifts, forge runs, council reviews, activity, smiths) in one window.

| File | What it is |
|---|---|
| [`claude-design-prompt.md`](claude-design-prompt.md) | The kickoff prompt and seven follow-up prompts to paste into Claude Design, in order |
| [`design-brief.md`](design-brief.md) | The supporting brief: product, vocabulary, information architecture, every screen, flows, components, states, visual direction, sample data, and what each provider's CLI offers |
| [`ui-pruning.md`](ui-pruning.md) | What to remove or fold from today's dashboard, with evidence and the order to do it in |

This suite builds on the command-center plan in [`../command-center/`](../command-center/00-README.md). It adds two
concepts that plan does not have: **projects** and the **Forge Keeper**. It also pushes against the plan in a few
places, all listed under "Decisions this needs" below. Those need an owner decision before anything is built.

## Running it through Claude Design

Claude Design is now the **Design** output of Claude artifacts (since 2026-09-16). Start there, not on the standalone
`claude.ai/design` site, which closes on 2026-12-14 without migrating projects. Design systems are a beta on paid plans.
Designs have no version history: ask Claude to keep a page before it tries another direction.

**Option A: in the Claude app**

1. Open a new chat and choose the Design output (or start one from the Artifacts tab).
2. Attach the brief. Uploads do not list `.md`, so either paste `design-brief.md` into the chat, or attach a copy
   renamed to `design-brief.txt` (or printed to PDF).
3. Optionally attach the current look as reference: the PNGs in `docs/images/nocturne/` (`after-dashboard.png`,
   `new-forge-run.png`, `after-council.png`, `new-repos.png`). They are a few weeks old: they still show a "Plan review"
   page and lack the Workbench and Timeline.
4. Paste **Prompt 1** from `claude-design-prompt.md`. Review, then send the follow-ups one at a time.

**Option B: from Claude Code in this repository**

1. Run `/design` (research preview; needs a recent Claude Code) and ask it to read
   `docs/plans/desktop-app/claude-design-prompt.md` and `docs/plans/desktop-app/design-brief.md` and run Prompt 1.
   Claude Code can read the brief and `docs/js/ds/tokens.css` directly, so nothing needs converting.
2. Optionally run `/design-sync` first to upload the Nocturne primitives as a design system. It targets React design
   systems; the dashboard is Preact, so check what it imports before relying on it.
3. When the design is done, the handoff comes back to Claude Code as a design to build from.

## Decisions this needs

Settle these before anything is built. Record each as a `design:` comment on the epic and an edit to
`../command-center/05-decisions.md` or `03-target-architecture.md` in the same PR.

1. **Projects** are a new top-level concept above workspaces. Where they are stored (likely the hearth's home,
   `~/.agent-forge/`), and how beads map to them (an epic, a `project:<slug>` label, or both).
2. **The Forge Keeper** is a standing session per project, with read access to everything and actions only through
   approved cards. It respects decision #5 (a human approves every start) but is new scope.
3. **Interactive, multi-turn sessions** in the app, not only one-shot headless runs. The adapters in
   `scripts/executors/` would need to resume a provider's session, or keep a long-lived protocol open, and the ledger
   would need opt-in bodies for transcripts (decision #10 keeps it metadata-only).
4. **Grok and OpenRouter as session providers.** Decision #13 names Gemini as the only third adapter. Neither needs
   the "direct provider HTTP execution" the architecture rules out:
   - Grok has an official CLI, Grok Build (`grok`), that signs in with an X / SuperGrok subscription, runs headless
     with JSON output and resumes sessions. It fits the adapter contract the way Claude and Codex do, and xAI allows
     its subscriptions in third-party harnesses.
   - OpenRouter has no subscription. It runs through an agent CLI pointed at it: OpenCode (built-in provider, local
     HTTP server with permission round-trips) or Ori, OpenRouter's own CLI (a 0.x preview). Its usage comes from
     OpenRouter's key endpoint, read with the key the council already uses.
5. **Retiring the static snapshot mode** of the dashboard (`ui-pruning.md`, R1), which §10 of the architecture keeps.
6. **Which Gemini binary.** Since 2026-06-18 Google AI Pro and Ultra subscribers (and the free tier) use Antigravity
   CLI (`agy`). Gemini CLI remains for API keys, Vertex AI and Code Assist organizations. `x1gs.4.4` targets Gemini
   CLI, so using a Google subscription needs an Antigravity adapter as well, or instead, and decision 7 first.
7. **Subscription terms, per provider.** The app must only ever run each vendor's own unmodified CLI under the user's
   own sign-in, and never read a credential file. Within that:
   - **Anthropic** does not let third-party developers offer Claude sign-in, route requests through Free, Pro or Max
     credentials, or collect, store or intermediate those credentials. It does let a user sign in to the unmodified
     Claude Code binary with their own plan, which is what this app does. Two things to confirm before relying on a
     plan for unattended shifts: the Consumer Terms' limit on automated access (the docs do endorse `claude -p` for
     scripts), and whether running Claude Code inside a product of your own falls under the Commercial Terms.
   - **OpenAI** invites building interfaces on `codex exec`, its SDK and its app-server.
   - **xAI** allows its subscriptions in third-party harnesses.
   - **Google** is the open question. Its Antigravity FAQ says wrapping `agy` inside third-party applications "is not
     supported under consumer plans". It also forbids reusing Gemini CLI's sign-in outside the CLI. Both were read only
     through search excerpts, and forum replies suggest a local, single-user child process may be tolerated. Until
     Google confirms otherwise, the safe Gemini route is an API key, Vertex AI or a business sign-in, not a Google AI
     Pro / Ultra plan.

   Check the terms again before the app is given to anyone else: everything above assumes one person's own use.

**Implementation note.** Every route has a way to hold a multi-turn chat, and most can ask the app for permission:

| Route | Multi-turn chat | Permission requests to the app |
|---|---|---|
| Claude Code | one process reading stream-json turns on stdin, or `--resume` | `--permission-prompt-tool` (an MCP tool the hearth serves) |
| Codex | `codex app-server` (JSON-RPC; experimental), or `exec resume` | app-server approval requests |
| Gemini CLI | `--acp` (Agent Client Protocol) | ACP |
| Antigravity | one process reading stream-json turns on stdin | none in that mode (rules set up front); its separate ACP server has them |
| Grok Build | `grok agent stdio` (ACP), or `--resume` | ACP |
| OpenCode (OpenRouter) | `opencode serve` (HTTP and an event stream), or ACP | yes, over HTTP or ACP |

One ACP client in `scripts/executors/` would cover Gemini CLI, Grok Build and OpenCode at once.
