# Plan: agent-forge-harness-0om — Expose contacts and activity_log tables (Python)
Generated: 2026-05-21
Repo: repos/marops-coding-interview-main (Python only — TypeScript out of scope)
Parent epic: [agent-forge-harness-a9b](agent-forge-harness-a9b.md)

## Summary
The Python CRM agent never fetches `contacts` (406 rows) or `activity_log` (998 rows), so it can't answer "who are the players" or "what happened recently". Add two focused tools — `get_contacts(account_id)` and `get_activity_log(account_id, limit=20)` — to [python/agent.py](repos/marops-coding-interview-main/python/agent.py). Leave `get_account_details` alone so over-fetch (W1) doesn't get worse. These tools unblock the Q1 briefing (contacts + recent activity) and feed Q2's risk-driver synthesis (departing contacts via `contacts.leaving_date`).

## Existing Code to Reuse
- [python/agent.py:37-40](repos/marops-coding-interview-main/python/agent.py#L37-L40) — `get_db()` SQLite connection factory; reuse as-is
- [python/agent.py:46-76](repos/marops-coding-interview-main/python/agent.py#L46-L76) — `get_account_details` pattern (account lookup → fetchall → dict mapping → return) to mirror
- [python/agent.py:79-101](repos/marops-coding-interview-main/python/agent.py#L79-L101) — `TOOLS` list + `TOOL_FUNCTIONS` dict; extend both

## Design Decisions
- **Two focused tools, not bundle expansion.** Keeps over-fetch (W1) from getting worse; the LLM can call only what it needs.
- **`activity_log` returns most-recent-first, default limit 20.** Activity has ~998 rows total. The model can request more by passing `limit`.
- **`contacts` unbounded.** Per-account size is small (typically <10). No limit needed.
- **No schema changes, no joins.** Both new tools are single-table `SELECT * WHERE account_id = ?`. Matches the existing low-ceremony style.

## Implementation Steps

1. **Add `get_contacts`** in [python/agent.py](repos/marops-coding-interview-main/python/agent.py)
   - `def get_contacts(account_id: str) -> dict`
   - Verify account exists (same `{"error": ...}` shape as `get_account_details`)
   - `SELECT * FROM contacts WHERE account_id = ?`
   - Return `{"contacts": [dict(c) for c in rows]}`

2. **Add `get_activity_log`** in [python/agent.py](repos/marops-coding-interview-main/python/agent.py)
   - `def get_activity_log(account_id: str, limit: int = 20) -> dict`
   - Verify account exists
   - `SELECT * FROM activity_log WHERE account_id = ? ORDER BY date DESC LIMIT ?`
   - Return `{"activity_log": [...], "limit": limit}`

3. **Register both tools** in `TOOLS` and `TOOL_FUNCTIONS` ([python/agent.py:79-101](repos/marops-coding-interview-main/python/agent.py#L79-L101))
   - JSON schema entries with clear `description` fields so the LLM picks the right tool
   - `limit` parameter on `get_activity_log` typed as integer, not required
   - Description hint: `get_contacts` → "use to identify stakeholders, champions, and departing contacts (check leaving_date)"; `get_activity_log` → "use for recent interactions / communication history"

4. **Manual verification** — run targeted questions and inspect stderr to confirm tool selection.

## Files to Modify
| File | Change |
|------|--------|
| [repos/marops-coding-interview-main/python/agent.py](repos/marops-coding-interview-main/python/agent.py) | Add 2 tool functions, 2 tool schemas, 2 `TOOL_FUNCTIONS` entries |

## Test Strategy
Manual via CLI — no test framework in repo. Confirm tool selection by reading the stderr `[tool: ...]` debug lines.

| # | Question | Expected behavior |
|---|----------|-------------------|
| 1 | `Who are the key contacts at ACC-042?` | LLM calls `get_contacts("ACC-042")`, answers with names + titles |
| 2 | `What recent activity happened on ACC-001?` | LLM calls `get_activity_log("ACC-001")`, summarizes recent events |
| 3 | `Show me the last 5 activities on ACC-001` | LLM calls `get_activity_log("ACC-001", limit=5)` — confirms `limit` plumbing |
| 4 | `What are the open tickets for ACC-042?` (regression) | Still uses `get_account_details`; no behavior change |

## Validation Commands
```bash
cd repos/marops-coding-interview-main/python
python agent.py "Who are the key contacts at ACC-042?"
python agent.py "What recent activity happened on ACC-001?"
```

## Estimated Scope
- Files: 0 new, 1 modified
- Complexity: Low
- Estimated time: 15–20 minutes

## Unblocks
- [agent-forge-harness-7p4](agent-forge-harness-7p4.md) — system prompt revamp needs the new tool names to reference
