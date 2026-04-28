# ADR Format

Use ADRs only for durable decisions that need to outlive the current conversation. In Agent Forge, prefer Beads `design:` comments or `knowledge/` updates for lightweight or issue-scoped rationale; create target-repo ADRs when the repo already uses ADRs or the user explicitly requests them.

## When To Offer An ADR

Offer an ADR only when all three conditions are true:

1. **Hard to reverse** - changing the decision later would be meaningfully expensive.
2. **Surprising without context** - a future reader would wonder why the code or process works this way.
3. **A real trade-off** - multiple viable options existed and one was chosen for specific reasons.

If a decision is easy to reverse, unsurprising, or has no real alternative, skip the ADR. Record it in Beads or knowledge only if it will help future work.

## Target-Repo Location

When writing ADRs in a target repo:

- Store system-wide decisions in `docs/adr/`.
- Store context-specific decisions beside the context when the repo uses context-local docs, such as `src/ordering/docs/adr/`.
- Create the ADR directory lazily when the first ADR is needed.
- Number files sequentially: `0001-slug.md`, `0002-slug.md`, and so on.

Scan the existing ADR directory for the highest number and increment it by one.

## Minimal Template

```md
# {Short title of the decision}

{1-3 sentences: what context led to the decision, what was decided, and why.}
```

That is enough for most ADRs. The value is recording that the decision was made and why, not filling out sections.

## Optional Sections

Add these only when they carry real information:

- **Status** frontmatter: `proposed`, `accepted`, `deprecated`, or `superseded by ADR-NNNN`.
- **Considered Options**: rejected alternatives worth remembering.
- **Consequences**: non-obvious downstream effects.

## Decisions That Qualify

- Architectural shape, such as event sourcing, monorepo boundaries, or projection strategy.
- Integration patterns between contexts, such as domain events instead of synchronous HTTP.
- Technology choices with lock-in, such as database, message bus, auth provider, or deployment target.
- Boundary and ownership decisions, including explicit "no" decisions.
- Deliberate deviations from the obvious path.
- Constraints not visible in code, such as compliance, latency, partner, or operational requirements.
- Rejected alternatives when the rejection is non-obvious and likely to recur.

## Harness Persistence Equivalent

When not writing target-repo ADRs:

- Use a Beads `design:` comment for issue-scoped decisions and trade-offs.
- Use `knowledge/repos/<repo>.yaml` for durable repo-level decisions that future agents should reuse.
- Include the same essentials: context, decision, reason, and any non-obvious rejected alternative.
