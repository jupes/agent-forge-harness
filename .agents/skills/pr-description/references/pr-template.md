<!--
  Agent Forge — Canonical PR description template.
  Single source of truth: .claude/skills/pr-description/references/pr-template.md
  Keep section headings (## ...) EXACT — the validator (scripts/check-pr-body.ts) matches them.
  Fill every section. Replace each <placeholder>. Remove the HTML comments before posting.
-->

## What Changed
<!-- The change in plain language: what now behaves differently. Bullet the concrete edits. -->
- <one-line summary of the capability/fix delivered>
-

## Why It's Needed
<!-- The motivation: the problem, user need, or bug this addresses. Link the driving issue. -->
<2–4 sentences. What was wrong or missing, and the impact of leaving it unaddressed.>

## How It Was Tested
<!-- The testing approach: which gates ran, what was checked manually, on what platform. -->
- Quality gates: `bun run typecheck && bun run lint && bun test`
- Automated: <test files / suites that cover this change>
- Manual: <exact steps a reviewer can repeat, or "n/a">

## Test Evidence
<!-- PROOF, not a claim. Paste real command output / counts / before-after. No green-washing. -->
```
<paste the actual passing test output, type-check result, or screenshot link>
```

## Risk & Rollback
<!-- Blast radius and the undo path. If genuinely none, say "Low risk — <one reason>". -->
- Risk level: <Low | Medium | High> — <why>
- Rollback: <how to revert safely, e.g. "revert this PR; no migrations/data changes">

## Linked Issues & AC Trace
<!-- Beads traceability. Map each acceptance criterion to the evidence that satisfies it. -->
Closes: <beads-id(s)>

| Acceptance Criterion | Verified By |
|----------------------|-------------|
| <criterion> | <test / evidence above> |
