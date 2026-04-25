import { Fragment } from "preact";

function esc(str: unknown): string {
  return String(str != null ? str : "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const COMMANDS: [string, string][] = [
  ["/go [task]", "Smart router — classify scope and run the right workflow."],
  ["/plan [idea]", "Explore codebase and produce an implementation plan."],
  ["/ship [msg]", "Quality gates, then commit, push, and PR."],
  ["/status", "Git state, ready work, blocked items, and PR health."],
  ["/review [branch]", "Risk-tiered code review (Blocker / High / Medium / Low)."],
  ["/triage", "Deadline management and capacity planning."],
  ["/ask [question]", "Query domain knowledge files."],
  [
    "/sync-knowledge",
    "Auto-generate knowledge YAML from the codebase (one repo by name, --all for repos.json, or current repo when inside a sub-repo).",
  ],
  ["/add-bead <text>", "Quick bd create from free text (title and optional description)."],
];

const WORKFLOWS: [string, string, string][] = [
  ["Fix", "≤3 files, clear scope", "Explore → Build → Check → Ship (no plan file)"],
  ["Feature", ">3 files or needs a plan", "Plan → Approve → Build → Review → Ship"],
  ["Epic", "Multiple related tasks", "Lead coordinates; parallel workers in git worktrees where dependencies allow"],
];

const SKILLS: [string, string][] = [
  [
    "add-repo",
    "Registers a new sub-repo in the harness: updates repos.json, clones, and generates knowledge YAML. Use when onboarding a repository so agents can read curated context before exploring code.",
  ],
  [
    "add-unit-tests",
    "Adds focused Bun unit tests for mission-critical paths and meaningful edge cases, not blanket line coverage. Use when logic must not regress, when fixing bugs, or when a PR needs concrete test evidence.",
  ],
  [
    "authoring-agent-skills",
    "Meta-skill for creating new Agent Forge skills: structure, conventions, and optional scaffolds. Use whenever you want to package a repeatable workflow for agents instead of one-off instructions.",
  ],
  [
    "beads-priority-assignment",
    "Picks Beads issue priority (P0–P4 and equivalents) from urgency, impact, and risk. Use on every bd create or triage update so the queue reflects real severity.",
  ],
  [
    "initiative-status-report",
    "Builds structured weekly status reports: initiatives, progress, blockers, risks, and KPIs. Pulls from epics and git activity so stakeholders get a single readable snapshot.",
  ],
  [
    "syncing-repos",
    "Runs multi-repo git operations (init, refresh, branches, stacked rebase) with JSON-shaped output for automation. Targets repos listed in repos/repos.json.",
  ],
  [
    "ui-originality-criteria",
    "Grades and steers visible UI using coherence, originality, craft, and usability. Keeps subjective design review consistent for both builders and evaluators.",
  ],
];

export function CommandsIsland() {
  return (
    <Fragment>
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: "0.9rem",
          margin: "0 0 1rem",
          maxWidth: "52rem",
        }}
      >
        Slash command prompts live in <code>.claude/commands/</code>; orchestration playbooks live in{" "}
        <code>.claude/workflows/</code>.
      </p>
      <h3>Slash commands</h3>
      <table>
        <thead>
          <tr>
            <th>Command</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {COMMANDS.map(([cmd, desc]) => (
            <tr key={cmd}>
              <td>
                <code>{esc(cmd)}</code>
              </td>
              <td>{esc(desc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Workflow tiers</h3>
      <table>
        <thead>
          <tr>
            <th>Workflow</th>
            <th>When to use</th>
            <th>Process</th>
          </tr>
        </thead>
        <tbody>
          {WORKFLOWS.map(([name, when, process]) => (
            <tr key={name}>
              <td>
                <strong>{esc(name)}</strong>
              </td>
              <td>{esc(when)}</td>
              <td>{esc(process)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Skills</h3>
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: "0.9rem",
          margin: "0 0 0.75rem",
          maxWidth: "52rem",
        }}
      >
        Reusable instructions under <code>{".claude/skills/<name>/SKILL.md"}</code>. Agents load them when a task
        matches the skill.
      </p>
      <table>
        <thead>
          <tr>
            <th>Skill</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {SKILLS.map(([name, summary]) => (
            <tr key={name}>
              <td>
                <code>{esc(name)}</code>
              </td>
              <td>{esc(summary)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Agents and hooks</h3>
      <p style={{ margin: "0 0 0.65rem", maxWidth: "52rem" }}>
        <strong>Agents</strong> — Role prompts in <code>.claude/agents/</code> shape how Claude Code behaves for a given
        job. The <strong>Lead</strong> agent decomposes work, aligns workers and evaluators, and verifies outcomes without
        writing production code. The <strong>Worker</strong> implements tasks inside the active workflow and repo
        conventions. The <strong>Planner</strong> turns a short prompt into a product-level spec (stories, non-goals,
        risks). The <strong>Evaluator</strong> judges deliverables against acceptance criteria and the shared evaluation
        rubric, including a pre-task alignment mode.
      </p>
      <p style={{ margin: 0, maxWidth: "52rem" }}>
        <strong>Hooks</strong> — Lifecycle callbacks configured in <code>.claude/settings.json</code> (and implemented
        as commands or Bun scripts under <code>.claude/hooks/</code>). They run automatically at events such as session
        start, after a task completes, or when a teammate goes idle. This repo wires <code>bd prime</code> on SessionStart
        and PreCompact, and <code>quality-gate.ts</code> on TaskCompleted and TeammateIdle to run quality checks and
        optional evaluator verdict gates. <code>session.ts</code> is available to log session metadata and sync Beads via{" "}
        <code>bd dolt pull</code> / <code>bd dolt push</code> when you add it to your hook configuration.
      </p>
    </Fragment>
  );
}
