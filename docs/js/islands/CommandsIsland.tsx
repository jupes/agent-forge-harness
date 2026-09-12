import { Fragment, type JSX } from "preact";
import { Card } from "../ds/Card";
import { Table } from "../ds/Table";

const COMMANDS: [string, string][] = [
  ["/go [task]", "Smart router — classify scope and run the right workflow."],
  ["/plan [idea]", "Explore codebase and produce an implementation plan."],
  ["/ship [msg]", "Quality gates, then commit, push, and PR."],
  ["/status", "Git state, ready work, blocked items, and PR health."],
  [
    "/review [branch]",
    "Risk-tiered code review (Blocker / High / Medium / Low).",
  ],
  ["/triage", "Deadline management and capacity planning."],
  ["/ask [question]", "Query domain knowledge files."],
  [
    "/sync-knowledge",
    "Auto-generate knowledge YAML from the codebase (one repo by name, --all for repos.json, or current repo when inside a sub-repo).",
  ],
  [
    "/add-bead <text>",
    "Quick bd create from free text (title and optional description).",
  ],
];

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

const SKILLS: [string, string][] = [
  ["add-repo", "Register a new sub-repo in the harness knowledge base."],
  [
    "add-unit-tests",
    "Add focused Bun unit tests for mission-critical behavior and edge cases.",
  ],
  [
    "authoring-agent-skills",
    "Meta-skill for creating and structuring new Agent Forge skills.",
  ],
  [
    "beads-priority-assignment",
    "Choose Beads issue priority from urgency, impact, and risk.",
  ],
  [
    "caveman",
    "Strip a problem to first principles and implement the smallest robust path.",
  ],
  [
    "design-an-interface",
    "Design API/interface shapes with clear invariants and trade-offs.",
  ],
  [
    "domain-model",
    "Model domain concepts, boundaries, contexts, and durable terminology.",
  ],
  [
    "edit-article",
    "Rewrite and tighten long-form technical writing for clarity and flow.",
  ],
  [
    "github-triage",
    "Triage GitHub issues and comments into actionable, durable work items.",
  ],
  [
    "git-guardrails-claude-code",
    "Apply safe git guardrails for non-interactive agent workflows.",
  ],
  [
    "grill-me",
    "Stress-test a plan or design by probing assumptions and weak spots.",
  ],
  [
    "improve-codebase-architecture",
    "Analyze and deepen module boundaries and architectural coherence.",
  ],
  [
    "initiative-status-report",
    "Generate weekly initiative reports with progress, blockers, risks, and KPIs.",
  ],
  [
    "migrate-to-shoehorn",
    "Plan and execute migrations toward Shoehorn-style architecture constraints.",
  ],
  [
    "obsidian-vault",
    "Capture durable project notes and decisions in an Obsidian-friendly format.",
  ],
  [
    "qa",
    "Run focused quality assurance checks and summarize risk by severity.",
  ],
  [
    "request-refactor-plan",
    "Request and structure a refactor plan before touching risky code.",
  ],
  [
    "scaffold-exercises",
    "Generate scoped learning exercises from code and project context.",
  ],
  [
    "setup-pre-commit",
    "Set up pre-commit hooks with repo-aware package manager detection.",
  ],
  [
    "syncing-repos",
    "Run multi-repo git operations with JSON output for automation.",
  ],
  [
    "tdd",
    "Execute red-green-refactor in vertical slices with behavior-first tests.",
  ],
  [
    "to-issues",
    "Break a plan/PRD into independent vertical-slice Beads issues.",
  ],
  [
    "to-prd",
    "Synthesize context into a PRD and file it as a Beads feature/epic.",
  ],
  [
    "triage-issue",
    "Triage an issue into clear scope, constraints, and next actions.",
  ],
  [
    "ubiquitous-language",
    "Align domain vocabulary across code, docs, and discussion.",
  ],
  [
    "ui-originality-criteria",
    "Grade and steer UI quality by coherence, originality, craft, and usability.",
  ],
  [
    "ui-screenshot",
    "Capture UI screenshots for PRs using Playwright MCP browser tools.",
  ],
  [
    "zoom-out",
    "Expand local changes into system-level context before making decisions.",
  ],
];

SKILLS.sort((a, b) => a[0].localeCompare(b[0]));

export function CommandsIsland(): JSX.Element {
  return (
    <Fragment>
      <Card title="Slash commands" headingLevel={2} kicker=".claude/commands/">
        <p class="af-prose af-muted">
          Slash command prompts live in <code>.claude/commands/</code>, and
          orchestration playbooks live in <code>.claude/workflows/</code>.
        </p>
        <Table
          label="Slash commands"
          rows={COMMANDS.map(([command, description]) => ({
            command,
            description,
          }))}
          rowKey={(row) => row.command}
          columns={[
            {
              key: "command",
              header: "Command",
              class: "af-col-command",
              cell: (row) => <code>{row.command}</code>,
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
          a task matches the skill.
        </p>
        <Table
          label="Skills"
          rows={SKILLS.map(([name, summary]) => ({ name, summary }))}
          rowKey={(row) => row.name}
          columns={[
            {
              key: "name",
              header: "Skill",
              class: "af-col-command",
              cell: (row) => <code>{row.name}</code>,
            },
            { key: "summary", header: "Summary" },
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
          session metadata and sync Beads via <code>bd dolt pull</code> /{" "}
          <code>bd dolt push</code> when you add it to your hook configuration.
        </p>
      </Card>
    </Fragment>
  );
}
