---
name: authoring-agent-skills
description: Create or revise Forge skills, including discovery descriptions, workflows, references, and executable helpers.
---

# Authoring Agent Forge skills

Edit `.claude/skills/<name>/SKILL.md` as the source. `.agents/skills/` is a generated
Codex mirror; regenerate it with `bun run codex:sync` after changes.

## Workflow

1. **Define the job.** Identify the requested outcome, inputs, side effects, and
   nearby skills that could be confused with this one. Reuse the user's context;
   ask only for decisions that materially change the workflow.
2. **Write discovery metadata.** Use a kebab-case directory and matching `name`.
   Describe the capability and distinct invocation cases in `description`.
   Preserve existing invocation policy; normal Forge skills remain discoverable.
3. **Write the execution path.** Give the agent the domain-specific decisions,
   commands, and evidence needed to finish. Each stage should yield an observable
   result or explicitly identify what prevents it. Keep shared requirements in
   the entrypoint; link optional detail at the branch that needs it.
4. **Package reusable work.** Read [the authoring guide](references/AUTHORING-GUIDE.md)
   when choosing references, helpers, or verification cases. Bundle dependencies
   needed by the skill; `repos/` contains ignored user clones, not shipped resources.
   Bun helpers use the repository's JSON envelope. Other runtimes are appropriate
   for document rendering when their prerequisites are documented.
5. **Verify behavior and discovery.** Try an ordinary request, an adjacent request
   that should select another skill, and a relevant missing-input or failure case.
   Run changed helpers. Confirm every linked resource exists and every claimed
   completion has evidence. Structural checks alone do not establish skill quality.
6. **Refresh consumers.** Run `bun run codex:sync` and
   `bun run dashboard:commands`; inspect the generated diff. Run the applicable
   repository gates and report their actual results.

For a new folder, the optional scaffold is:

```bash
bun run .claude/skills/authoring-agent-skills/scripts/scaffold.ts <skill-name> "<capability and invocation cases>"
```

Replace every scaffold prompt with working instructions; retain only resources
the workflow uses. The finished skill must be usable from a fresh harness clone.
