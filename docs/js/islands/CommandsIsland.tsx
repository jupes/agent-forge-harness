import { Fragment, type JSX } from "preact";
import { Card } from "../ds/Card";
import { Table } from "../ds/Table";
import { COMMANDS } from "../generated/commands";
import { SKILLS } from "../generated/skills";

const WORKFLOWS: [string, string, string][] = [
  [
    "Fix",
    "≤3 files, clear scope",
    "Explore → Build → Check → Ship (no plan file)",
  ],
  [
    "Feature",
    ">3 files or needs a plan",
    "Plan → Approve → Build → Review → Ship",
  ],
  [
    "Epic",
    "Multiple related tasks",
    "Lead coordinates; parallel workers in git worktrees where dependencies allow",
  ],
];

export function CommandsIsland(): JSX.Element {
  return (
    <Fragment>
      <Card title="Slash commands" headingLevel={2} kicker=".claude/commands/">
        <p class="af-prose af-muted">
          Slash command prompts live in <code>.claude/commands/</code>, and
          orchestration playbooks live in <code>.claude/workflows/</code>. This
          list is each command file's <code>argument-hint</code> and first
          heading, written by <code>bun run dashboard:commands</code>.
        </p>
        <Table
          label="Slash commands"
          rows={[...COMMANDS]}
          rowKey={(row) => row.name}
          columns={[
            {
              key: "name",
              header: "Command",
              class: "af-col-command",
              cell: (row) => <code>{row.name}</code>,
            },
            {
              key: "argumentHint",
              header: "Arguments",
              cell: (row) =>
                row.argumentHint ? <code>{row.argumentHint}</code> : null,
            },
            { key: "description", header: "Description" },
          ]}
        />
      </Card>

      <Card title="Workflow tiers" headingLevel={2}>
        <Table
          label="Workflow tiers"
          rows={WORKFLOWS.map(([name, when, process]) => ({
            name,
            when,
            process,
          }))}
          rowKey={(row) => row.name}
          columns={[
            {
              key: "name",
              header: "Workflow",
              cell: (row) => <strong>{row.name}</strong>,
            },
            { key: "when", header: "When to use" },
            { key: "process", header: "Process" },
          ]}
        />
      </Card>

      <Card title="Skills" headingLevel={2} kicker=".claude/skills/">
        <p class="af-prose af-muted">
          Reusable instructions under{" "}
          <code>{".claude/skills/<name>/SKILL.md"}</code>. Agents load them when
          a task matches the skill. This list is each skill's name and
          description, without its trigger text, written by{" "}
          <code>bun run dashboard:commands</code>.
        </p>
        <Table
          label="Skills"
          rows={[...SKILLS]}
          rowKey={(row) => row.name}
          columns={[
            {
              key: "name",
              header: "Skill",
              class: "af-col-command",
              cell: (row) => <code>{row.name}</code>,
            },
            {
              key: "summary",
              header: "Summary",
              cell: (row) => (
                <Fragment>
                  <span class="af-skill-summary">{row.summary}</span>
                  {row.notLoaded ? (
                    <span class="af-muted af-skill-note">
                      {" "}
                      Not loaded by Claude Code: its file is not named{" "}
                      <code>SKILL.md</code>.
                    </span>
                  ) : null}
                </Fragment>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Agents and hooks" headingLevel={2}>
        <p class="af-prose">
          <strong>Agents</strong> — Role prompts in <code>.claude/agents/</code>{" "}
          shape how Claude Code behaves for a given job. The{" "}
          <strong>Lead</strong> agent decomposes work, aligns workers and
          evaluators, and verifies outcomes without writing production code. The{" "}
          <strong>Worker</strong> implements tasks inside the active workflow
          and repo conventions. The <strong>Planner</strong> turns a short
          prompt into a product-level spec (stories, non-goals, risks). The{" "}
          <strong>Evaluator</strong> judges deliverables against acceptance
          criteria and the shared evaluation rubric, including a pre-task
          alignment mode.
        </p>
        <p class="af-prose">
          <strong>Hooks</strong> — Lifecycle callbacks configured in{" "}
          <code>.claude/settings.json</code> (and implemented as commands or Bun
          scripts under <code>.claude/hooks/</code>). They run automatically at
          events such as session start, after a task completes, or when a
          teammate goes idle. This repo wires <code>bd prime</code> on
          SessionStart and PreCompact, and <code>quality-gate.ts</code> on
          TaskCompleted and TeammateIdle to run quality checks and optional
          evaluator verdict gates. <code>session.ts</code> is available to log
          session metadata when you add it to your hook configuration. The Beads
          tracker is local-only, so nothing is pushed.
        </p>
      </Card>
    </Fragment>
  );
}
