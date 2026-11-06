# Forge skill authoring decisions

Use this reference while reviewing a skill or choosing its supporting resources.
The review approach incorporates Matt Pocock's
[writing-for-agents](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents)
and its `SKILL-MECHANICS.md`, reviewed on 2026-11-06. See
[attribution](../../../../.claude/skills/ATTRIBUTION.md) for the upstream license.

## Discovery

Put the task in the description, with one signal per distinct case. A reporting
skill should distinguish a portfolio digest from a project PDF. An investigation
skill should distinguish diagnosis from implementing an already understood fix.
Keep detailed command arguments in the body, where they are useful during execution.

Forge's Codex sync preserves ordinary skill discovery and separately marks slash
command wrappers explicit-only. Preserve those policies during editorial changes;
do not copy provider-specific invocation settings into another provider's metadata.

## Structure

Keep each operational requirement in one maintained location. Link to the PR
template rather than restating its headings; consult a CLI's help for optional flags.
Keep essential ordering, safety invariants, and failure handling beside the operation.

A reference link must explain when to read it. Move a long template or an optional
mode out of the main workflow when that makes the next action clearer. File length
alone is not a reason to fragment a short, coherent procedure.

Use positive actions and measurable completion bounds. For example, inspect every
planned Beads ID before declaring implementation complete: an empty ready queue
also occurs when unfinished tasks are blocked. Preserve hard guards where a wrong
action could lose data, publish private material, or corrupt a workflow contract.

## Resources

- `references/`: templates, field semantics, optional procedures. Link at use sites.
- `scripts/`: repeatable execution, such as rendering a report or checking an input.
  Document runtime, arguments, output, failure exit code, and external side effects.
- `assets/`: fonts, examples, or other material actually used in the output.

Prefer existing dependencies. Read manifest/configuration before assuming a package
manager, default branch, server command, or tool. Keep sample data synthetic. Store
real project reports and intermediate evidence under ignored `reports/` or `.tmp/`.

## Acceptance review

Review the actual outcome, not just the document's appearance:

| Case | Evidence to collect |
| --- | --- |
| Typical request | Requested result exists and satisfies the user's scope |
| Neighboring skill | Description distinguishes which workflow owns the request |
| Missing input | Agent asks only for necessary facts or labels its assumptions |
| Tool failure | Failure is visible; success is not claimed from partial output |
| Repeated run | Existing work and user authorization are preserved |
| Packaged helper | Commands run from a clean clone with stated dependencies |

For complex skills, an independent agent may forward-test a realistic request with
synthetic inputs in an isolated temporary directory. Give it the request and raw
sources without prescribing the answer; inspect the result and correct demonstrated
failures. Record limitations of the test, including unavailable services.

Before shipping, inspect generated Codex and dashboard output as well as the source.
