# Plan: agent-forge-harness-a9b — Maximize Q1 + Q2 answer quality (Python)

Generated: 2026-05-21
Repo: repos/marops-coding-interview-main (Python only)

## Session Goal

Produce excellent answers to two specific questions against the existing Python agent at [repos/marops-coding-interview-main/python/agent.py](repos/marops-coding-interview-main/python/agent.py).

**Q1:** "Give me a full briefing on account ACC-042. What should I know before a call with them?"
**Q2:** "Which accounts have renewals coming up in the next 90 days that we should be worried about? For each risky account, tell me what's driving the risk."

ACC-042 is a high-volume account (26 opportunities, 59 tickets) — the briefing must handle volume gracefully. Q2 is currently **unanswerable** because every tool requires a known `account_id`.

Constraints: model is locked to `gpt-4.1-nano` (do not change). TypeScript implementation is explicitly out of scope.

## What Each Question Needs

| Need | Q1 (ACC-042 briefing) | Q2 (at-risk renewals) | Bead |
|------|-----------------------|------------------------|------|
| Cross-account search by `renewal_date` | — | **required (unblocker)** | [7jq](agent-forge-harness-7jq.md) W4 |
| `contacts` (stakeholders, leaving_date) | required | risk signal | [0om](agent-forge-harness-0om.md) W2 |
| `activity_log` (recent touches) | required | secondary | [0om](agent-forge-harness-0om.md) W2 |
| Briefing- and risk-shaped output format | required | required | [7p4](agent-forge-harness-7p4.md) W3 |
| Notes grouped by parent opportunity | helpful (26 opps) | — | [fmb](agent-forge-harness-fmb.md) W5 |
| `features_used` parsed to array | helpful | — | [y4f](agent-forge-harness-y4f.md) W6 |

The critical path is **W4 + W2 + W3** (tools + prompt). W5 and W6 are quality polish — useful for Q1 but not gating.

## Beads Structure

```
agent-forge-harness-a9b  EPIC  Maximize Q1 + Q2 answer quality
├── agent-forge-harness-7jq  feature  P1  W4 — cross-account renewal tool
├── agent-forge-harness-0om  feature  P2  W2 — contacts + activity_log tools
├── agent-forge-harness-7p4  task     P1  W3 — system prompt revamp  (depends on 0om + 7jq)
├── agent-forge-harness-fmb  task     P2  W5 — note aggregation
└── agent-forge-harness-y4f  task     P3  W6 — features_used parsing
```

The epic-to-child link is documented in each child's description (Beads' `bd dep add` doesn't accept epic↔task block relationships in this configuration).

## Execution Order

Run W4 + W2 + W5 + W6 in any order (independent edits to [python/agent.py](repos/marops-coding-interview-main/python/agent.py)). Then run W3 last so the new system prompt references real tool names.

```
W4 (7jq) ──┐
W2 (0om) ──┼──> W3 (7p4) ──> verify Q1 + Q2
W5 (fmb) ──┤
W6 (y4f) ──┘
```

Total estimate: ~75–95 minutes if done sequentially; ~50 if W2/W4/W5/W6 batched into a single editing pass on [python/agent.py](repos/marops-coding-interview-main/python/agent.py).

## Per-Child Summary

Each child has its own description in Beads. Short version:

- **W4 — [7jq](agent-forge-harness-7jq.md): `list_accounts_by_renewal(window_days=90, tier=None)`** — new tool. SELECT account_id, name, tier, arr_usd, renewal_date FROM accounts WHERE renewal_date BETWEEN today AND today+N days, ORDER BY renewal_date ASC, cap ~50 rows. Q2's only unblocker.

- **W2 — [0om](agent-forge-harness-0om.md): `get_contacts(account_id)` + `get_activity_log(account_id, limit=20)`** — two new focused tools. Activity is most-recent-first with a default limit (998 rows total). Detailed in [plans/drafts/agent-forge-harness-0om.md](agent-forge-harness-0om.md).

- **W3 — [7p4](agent-forge-harness-7p4.md): rewrite `SYSTEM_PROMPT`** — persona (senior account research assistant for a sales rep / CSM), tool-use guidance (single vs multi-account branching), two output shapes (BRIEFING and AT-RISK RENEWALS), formatting rules (currency with K/M, dates YYYY-MM-DD), grounding rule (no facts beyond tool output). Single highest-leverage change.

- **W5 — [fmb](agent-forge-harness-fmb.md): aggregate `opportunity_notes` into parent opportunities** in `get_account_details`. Same SQL; regroup in Python; cap 10 most-recent notes per opportunity. Mostly relevant to ACC-042 with its 26 opportunities.

- **W6 — [y4f](agent-forge-harness-y4f.md): parse `usage.features_used`** from comma-string to `list[str]` in `get_account_details`. One comprehension. Polish.

## Files Touched

| File | Changes | From beads |
|------|---------|------------|
| [repos/marops-coding-interview-main/python/agent.py](repos/marops-coding-interview-main/python/agent.py) | +3 tool functions, +3 tool schemas, +3 `TOOL_FUNCTIONS` entries, modified `get_account_details`, rewritten `SYSTEM_PROMPT` | W2, W3, W4, W5, W6 |

Single file modified across the entire epic.

## Verification — End-to-End

After all five children land, run both target questions and judge against the rubric below.

```bash
cd repos/marops-coding-interview-main/python
python agent.py "Give me a full briefing on account ACC-042. What should I know before a call with them?"
python agent.py "Which accounts have renewals coming up in the next 90 days that we should be worried about? For each risky account, tell me what's driving the risk."
```

### Q1 acceptance — briefing on ACC-042

Output should be a markdown briefing with these sections, in order:

- **Header** — account name, tier, ARR (formatted as USD with K/M), region, primary product, sales rep, renewal date.
- **Renewal & Risk Snapshot** — renewal date + days from now; usage trend; open ticket counts by severity; CSAT signal if available.
- **Active Opportunities** — top 5 by amount, grouped with their most recent notes (not a flat note list).
- **Recent Activity** — last 30 days, max 10 items from `activity_log`, with date + type + subject.
- **Key Contacts** — 3–5 most relevant from `contacts`; explicitly flag any with `leaving_date` in the next 90 days.
- **Open Tickets** — counts by severity; list P1/P2 with subject and status.
- **Talking Points** — 3–5 bullets the rep should raise on the call.

Tool calls visible in stderr should include `get_account_details`, `get_contacts`, and `get_activity_log` (all three).

### Q2 acceptance — at-risk renewals

Output should be a ranked list. For each account:

- Name + tier + ARR (formatted) + days to renewal
- Risk drivers, picking from: declining `usage_trend`; open P1/P2 tickets; low CSAT; primary contact with `leaving_date` inside the renewal window; stalled late-stage opportunities (Negotiation / Proposal / Technical Evaluation without recent activity).
- One-line recommendation per account.

Tool calls visible in stderr should start with `list_accounts_by_renewal(window_days=90)`, followed by per-candidate drill-downs via `get_account_details` and (optionally) `get_contacts` / `get_activity_log`. The agent should not invent risk drivers — if a signal is absent, it should be omitted, not fabricated.

## Out of Scope

- TypeScript agent ([typescript/agent.ts](repos/marops-coding-interview-main/typescript/agent.ts)) — explicitly excluded for this session.
- Model swap (locked to `gpt-4.1-nano`).
- Schema changes to `data/data.db`.
- Persistent caching, session state, retries.
- Cross-account search beyond the renewal-window slice (no general `search_accounts(filters...)`).
- Updating [knowledge/repos/marops-coding-interview-main.yaml](knowledge/repos/marops-coding-interview-main.yaml) — should follow as a separate housekeeping bead once W2 + W3 + W4 land (so the knowledge file reflects new tools + dropped weaknesses).

## Open Questions

- Should `list_accounts_by_renewal` also pre-compute a quick risk score, or strictly return account metadata and let the LLM synthesize per-candidate? Current plan: strict metadata, LLM does synthesis. Tradeoff: cleaner separation, more tool calls.
- For W3, should the prompt include the example briefing template inline, or rely on natural-language structural cues? Current plan: natural language + section list. Tradeoff: less brittle to prompt drift, but might produce inconsistent section ordering.

Decide these inline during the W3 implementation pass.
