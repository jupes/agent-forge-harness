---
name: initiative-status-report
description: Summarize multiple initiatives as a Markdown portfolio digest. Use for weekly team or cross-project updates; use project-status-report for a shareable management PDF.
---

# Initiative status digest

Produce a concise Markdown overview of the requested initiatives. Default to the
last seven completed calendar days in the user's timezone; state the exact dates.
Honor a supplied time range and project selection.

1. Identify the portfolio from user context and registered projects. Read all scoped
   epics and their children, including blocked and closed work. Use
   `bd list --all --limit 0 --json`, then filter by actual project/parent membership.
   `bd ready` is a scheduling queue and is insufficient for reporting.
2. Apply [reporting evidence rules](../project-status-report/references/evidence.md)
   while separating period accomplishments from current status. Include user notes
   and provided documents; identify source gaps and conflicting accounts.
3. Write an executive summary, a compact row per initiative (health, meaningful
   progress, blocker, next milestone), and decisions needed. Include metrics only
   when their definitions, denominators, and comparison periods are supported.
4. Return Markdown in chat, or save to the requested destination. Keep reports in
   ignored `reports/` by default when a file is requested.

Complete when every scoped initiative is represented, claims are traceable, and the
reader can distinguish delivered outcomes, plans, and missing evidence.
