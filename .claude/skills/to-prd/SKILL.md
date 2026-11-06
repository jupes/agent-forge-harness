---
name: to-prd
description: Synthesize a feature brief or PRD from existing context and file it in Beads. Use when the user requests a product requirements document.
---

# to-prd

Turn the current conversation and codebase context into a practical PRD without running a long interview.

## Process

### 1) Gather context from existing signals

Use what already exists in:

- Current conversation
- Existing issues (`bd show <id>`)
- Recent code context in this repo/sub-repo
- Existing knowledge files in `knowledge/`

Ask clarifying questions only when a blocker prevents writing a useful PRD.

### 2) Define deep modules and test surface

Identify major modules likely to be added/changed. Prefer deep modules (simple interface, hidden complexity).

Record:

- Candidate module responsibilities
- Public interfaces (high-level, no file path lock-in)
- Behavior areas that most need tests

### 3) Write the PRD

Use this template:

<prd-template>
## Problem Statement

Describe the user-facing problem in plain language.

## Solution

Describe the intended user-facing outcome and core approach.

## User Stories

Provide a numbered, comprehensive set of stories:

1. As a <actor>, I want <capability>, so that <benefit>.

## Implementation Decisions

Capture important decisions:

- Modules to build/modify
- Interface and contract decisions
- Architecture and data-shape decisions
- Operational constraints and rollout notes

Do not hard-code exact file paths unless required.

## Testing Decisions

Capture testing strategy:

- Behavioral boundaries to test
- Which modules/surfaces require tests
- Relevant prior-art test patterns in repo

## Out of Scope

Explicitly list exclusions for this increment.

## Further Notes

Any assumptions, risks, migration notes, or open questions.
</prd-template>

### 4) File it in Beads

Create or update the issue in the harness tracker. Prefix sub-repo titles with `[<repo-name>]`; keep `--repo .`:

Choose priority with [beads-priority-assignment](../beads-priority-assignment/SKILL.md) before creating work. Reuse an existing issue when it already owns the outcome.

```bash
bd create --type feature --title "<PRD title>" --description "<full PRD markdown>" --priority <priority> --repo .
```

If scope is multi-feature or strategic, use `--type epic` instead.

### 5) Link follow-up work

When decomposition is also requested, use the to-issues skill to create child beads under the PRD issue:

```bash
bd create --type task --parent <prd-id> --title "<slice>" --description "<vertical slice>" --priority <priority> --repo .
```

Add a `worklog:` comment summarizing key decisions.

## Completion

The PRD distinguishes requirements from assumptions, includes measurable success criteria, and is read back from its Beads record.
