# Forge skill quality review

Reviewed 2026-11-06 against Matt Pocock's
[writing-for-agents](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents)
and its skill mechanics reference. All 34 existing canonical skills were read and
updated; project-status-report adds a 35th. Ordinary skill discovery is preserved.
The 13 generated slash-command wrappers and role bundle remain generated from their
existing sources, rather than being edited as independent skills.

The review tightened task selection, reference placement, and observable completion.
It also corrected operational defects found during the review. Provider-specific
invocation settings were not transplanted between Claude Code and Codex.

## Per-skill disposition

| Skill | Review result |
| --- | --- |
| add-repo | Discover default branch/checks from repository evidence; verify registration |
| add-unit-tests | Remove arbitrary behavior count and duplicated triggers; define evidence |
| authoring-agent-skills | Replace length-based splitting rule with task-based resource guidance; validate outcomes |
| beads-priority-assignment | Sharpen selection and require read-back of priority |
| caveman | Reduce repetition; preserve precision and explicit user control |
| design-an-interface | Separate discovery from process; define complete alternatives |
| domain-model | Narrow interview trigger; route context and ADR references at use |
| edit-article | Support direct narrow edits; remove arbitrary paragraph limit and redundant approval |
| forge-implement | Distinguish attended/unattended gates; inspect every plan task rather than ready queue |
| forge-plan | Extract template; preserve file-map contract; require a real issue graph for handoff |
| forge-research | Shorten discovery; disclose the research artifact template |
| forge-ship | Include closed work; use body-file; clarify report is local-only; extract template |
| git-guardrails-claude-code | Clarify scope, dependencies, regex limitations, and conflict with required ordinary pushes |
| github-triage | Clarify Beads boundary, tool choice, existing authorization, and read-back |
| grill-me | Shorten discovery and remove duplicated invocation list; retain decision-by-decision interview |
| improve-codebase-architecture | Sharpen assessment scope and evidence-based completion |
| initiative-status-report | Replace ready-only weekly query; define portfolio Markdown scope and evidence rules |
| migrate-to-shoehorn | Move detailed patterns behind an actionable reference; verify installed exports |
| obsidian-vault | Use host-neutral file tools, preserve authorization, cover aliased/heading backlinks |
| pr-description | Use canonical template as sole heading definition; use body-file for writes |
| qa | Distinguish capture from diagnosis; allow explicit reproduction gaps; verify saved issues |
| request-refactor-plan | Research before re-interviewing; reduce redundant priority approval; define completion |
| review-plan | Align SOUND with zero Medium-or-higher findings, matching Forge planning |
| scaffold-exercises | Make naming defaults subordinate to the owning course |
| setup-pre-commit | Respect requested installation and existing configuration; fail hook on failed check |
| syncing-repos | Clarify discovery and require per-repository result verification |
| tdd | Route references by need; choose issue priority rather than hard-code it; require red/green evidence |
| to-issues | Verify graph coverage and cycles; reuse issues and choose priority |
| to-prd | Keep tracker local to harness; separate PRD filing from optional decomposition |
| triage-issue | Distinguish diagnosis from authorized implementation; state confidence and verification |
| ubiquitous-language | Remove broad DDD catchall; require grounded definitions and relationships |
| ui-originality-criteria | Favor audience/brand fit; require rendered evidence across all dimensions |
| ui-screenshot | Discover actual server/base/tooling; inspect captures; distinguish local files from PR uploads |
| zoom-out | Tighten discovery and define a verified caller/dependency map |
| project-status-report (new) | Date-bounded evidence synthesis, leadership narrative, reusable PDF renderer and visual verification |

## Executable verification

The scaffold now quotes YAML-sensitive descriptions, rejects unsafe directory names,
requires a description, creates only needed files, and emits the standard JSON envelope.
Its tests validate these behaviors. The existing file-map tests now read the extracted
plan template directly, preserving their parser checks.

The PDF helper validates reporting dates/timezones, source identifiers, and evidenced
accomplishments/metrics; escapes plain text; uses flowing paragraphs; checks glyph
coverage; and replaces output atomically after successful generation. Tests cover
malformed input preserving an existing output, reference failures, dates, extraction,
and dense pagination.

A separate agent used only synthetic Cedar evidence to produce a two-page report:
reopened recovery stayed unresolved; duplicate closure and a later parent closure
were excluded; accepted implementation was not labeled deployed; an unsupported
shipping claim and unavailable Beads coverage were disclosed. This found a timezone
database dependency gap on Windows, corrected in the documentation and error message.
The ordinary two-page example and a dense three-page stress case were also rendered
and visually inspected.

The checks cover instruction structure, concrete workflow contracts, changed helpers,
and one independent reporting scenario. They do not certify every skill against
every model, live service, or user scenario. Real reports still require evidence review;
the PDF renderer cannot determine whether a source actually supports a claim.

Final checks: 35 skill-validator passes; 142 focused Bun tests; 6 PDF tests;
typecheck and lint passed (lint retains existing warnings). Reference links resolve
and canonical entrypoints match their generated mirrors byte-for-byte. The full
`bun test` run was attempted but aborted with a native Bun 1.3.10 Windows crash in
the unchanged identity-migration scan, reproduced in isolation from the changed
tests. Follow-up: agent-forge-harness-ha1f (diagnose the native identity-scan crash).
