---
name: project-status-report
description: Create a polished project-status PDF for a manager or director from Beads, user notes, and attached documents. Use for fortnightly updates or a user-specified reporting period.
---

# Project status report

Deliver a shareable PDF that answers: where the project stands, what changed,
why it matters, and what leadership needs to decide. Translate engineering
activity into supported outcomes without inflating delivery or business impact.

## 1. Set the reporting contract

Resolve the project, audience, period, timezone, and supplied material from context.
Ask only if project selection or a material date ambiguity remains unresolved.
Default to the last 14 **completed calendar days**, ending yesterday in the user's
timezone. Print inclusive start/end dates and the timezone. If the user includes
today, label it a partial day and show the extraction cutoff.

Use a manager/director audience and a restrained editorial design unless the user
provides branding. Keep the main report to about two pages when content allows;
add pages for meaningful evidence rather than shrinking text.

## 2. Gather and reconcile evidence

Read [evidence rules](references/evidence.md) before querying Beads or synthesizing
documents. Inspect all project members and dependencies, not only ready work.
Collect period events, the status at period end, and current risks separately.
Read relevant user notes and attachments, including tables and page context.

Write a local evidence ledger under `reports/<slug>/`: claim, date, source locator,
confidence, and whether it is an outcome, current status, or plan. Preserve raw
exports in that ignored directory when useful. Reading the tracker is sufficient;
report generation does not require changing issues or publishing project data.

This step is complete when every proposed headline and metric has support, conflicting
accounts are resolved or marked, and unavailable sources are explicitly listed.
If the tracker is unavailable, a report from supplied material is valid with that
coverage limitation; absence of data is not evidence of no progress.

## 3. Synthesize for leadership

Lead with overall health and a short rationale, followed by:
- **Accomplishments:** the material change and its supported value, grouped by outcome.
- **Risks and blockers:** consequence, mitigation, owner and date when known.
- **Next period:** planned outcomes with owners/targets where supported.
- **Decisions needed:** the choice, why now, and the effect of delay.
- **Evidence and coverage:** compact source notes and important limitations.

Use On track / At risk / Off track / Unknown as textual status labels. Explain the
assessment against commitments; use Unknown when milestones or status evidence are
insufficient. Distinguish shipped, verified, implemented, and merely closed issues.
Metrics are optional, never substitutes for outcomes. Include a prior-period trend
only when comparable evidence exists. Treat absent owners and dates as unassigned
or unconfirmed.

## 4. Render

Read [the PDF contract and layout guide](references/pdf-layout.md). Create report
JSON using [the synthetic example](assets/example-report.json) as a structural guide;
replace its content completely. The reusable renderer takes two paths:

```bash
python .claude/skills/project-status-report/scripts/render_report.py <report.json> <report.pdf>
```

It requires Python 3.10+ and ReportLab; the guide covers runtime discovery, fonts,
rendering, and alternatives. It emits `{ok,data,error}` and a nonzero exit on failure.
Keep real outputs and evidence under ignored `reports/`, or the user's destination.
The helper creates a local PDF only; it does not upload or send it.

## 5. Verify and deliver

Extract the PDF text and compare dates, numbers, qualifications, and source notes
with the evidence ledger. Render **every page** to PNG and inspect at readable size.
Correct clipping, awkward splits, missing glyphs, weak contrast, and excessive
density; regenerate and inspect the changed output. Use text labels alongside color.

Deliver the PDF link, its exact reporting range, and any material coverage limitation.
Keep editable JSON beside it for revision. Report a rendering or verification blocker
honestly; an HTML/Markdown draft alone is not a completed PDF request.
