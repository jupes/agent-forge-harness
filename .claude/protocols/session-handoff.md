# Session handoff artifact

Use when **starting a fresh agent session** after a context reset, compaction-heavy pause, or epic handoff — so the next agent does not re-derive state from chat history alone.

Inspired by structured handoffs for long-running agentic work (see `knowledge/_shared.yaml` → `anthropic_long_running_harness`).

---

## Where to write it

Save as:

`.tmp/work/session-handoff.md`

(`.tmp/` is gitignored — copy any long-lived summary into Beads comments or the epic if the team needs persistence.)

---

## Template

```markdown
# Session handoff

## Continuation ID
- Beads: <epic or task id>
- Branch: <name>
- Last commit: <sha> — <one-line summary>

## Goal (one paragraph)
<What we are trying to ship and why it matters.>

## Decisions already made
- <Decision> — <rationale / link to PR or comment>

## Current state
- Done: <bullets>
- In progress: <bullets>
- Not started: <bullets>

## Next actions (ordered)
1. <Concrete next step with file or command hint>
2. <…>
3. <…>

## Verification
- Last green checks: `bun run typecheck` / `bun test` / `bun run lint` — <PASS|FAIL + notes>

## Known issues / do not repeat
- <Bug or wrong path the next agent must avoid>

## Files / areas of focus
- `<path>` — <why it matters>
```

---

## Consumer rules

1. **Read this file first** in the new session (after `bd ready` / task pick), before editing code.
2. If it **conflicts** with Beads AC or alignment docs, **Beads + alignment win** — update this handoff after reconciling.
3. When closing out a milestone, **delete or replace** the handoff so stale state does not mislead a future session.

## Wisps and retention

`.tmp/work/*` is treated as **wisps** (short-lived). See `.claude/protocols/tmp-work-ttl.md` for the default TTL, the `bun run tmp:cleanup` sweep, and which names are never auto-swept.
