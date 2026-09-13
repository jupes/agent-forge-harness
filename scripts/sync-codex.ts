#!/usr/bin/env bun
/**
 * sync-codex.ts — Mirror the Claude Code `.claude/` config into OpenAI Codex format.
 *
 * Codex discovers skills under `.agents/skills/` (repo-scoped) and reads AGENTS.md /
 * CLAUDE.md as instruction docs. This script mirrors what CAN be translated and
 * documents what cannot. It NEVER writes to `.claude/` — both trees are kept.
 *
 * Produces (all generated, safe to delete/regenerate):
 *   .agents/skills/<name>/        one folder per Claude skill (content unchanged)
 *   .agents/skills/<cmd>/         one folder per unique slash command (as a skill)
 *   .agents/skills/forge-roles/   the lead/worker/planner/evaluator personas, bundled
 *   .agents/CODEX-NOTES.md        what ported, what didn't, and how Codex finds it
 *   .codex/config.toml            the one portable setting + hook-parity notes
 *
 * Usage: bun run scripts/sync-codex.ts        (or: bun run codex:sync)
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, join, resolve } from "path";

const ROOT = process.cwd();
const CLAUDE_DIR = join(ROOT, ".claude");
const AGENTS_SKILLS = join(ROOT, ".agents", "skills");
const CODEX_DIR = join(ROOT, ".codex");

/** Slash commands that merely wrap an existing skill of the same name — skip to
 * avoid duplicate-name entries in Codex's skill selector. */
const COMMANDS_DUPLICATING_SKILLS = new Set([
  "add-repo",
  "forge-implement",
  "forge-plan",
  "forge-research",
  "forge-ship",
  "review-plan",
]);

/** High-quality trigger descriptions for the unique commands we convert to skills. */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "add-bead":
    "Capture free-text work as a tracked Beads issue. Use when the user runs /add-bead or wants to quickly file a Beads issue.",
  ask: "Answer questions about the codebase from knowledge files. Use when the user runs /ask or asks a domain/knowledge question about the repos.",
  forgemaster:
    "Route a task by complexity and run the gated Forge pipeline (research → plan → implement → ship). Use when the user runs /forgemaster or wants the full guided feature pipeline.",
  "forgemaster-mini":
    "Trimmed Forge pipeline (scope → build → wrap) for small, clear-scope work. Use when the user runs /forgemaster-mini or has a small, well-scoped task.",
  go: "Classify a task and route it to the right workflow (fix / feature / epic). Use when the user runs /go or wants the adaptive workflow router.",
  plan: "Explore the codebase and produce an implementation plan. Use when the user runs /plan or wants a plan before building.",
  review:
    "Risk-tiered code review (Blocker / High / Medium / Low). Use when the user runs /review or wants the current branch or diff reviewed.",
  ship: "Run quality gates, commit, push, and open a PR with the canonical template. Use when the user runs /ship or wants to ship the current changes.",
  status:
    "Report git state, ready work, blocked items, and PR health. Use when the user runs /status or wants a workspace snapshot.",
  "sync-knowledge":
    "Auto-generate knowledge YAML from the codebase. Use when the user runs /sync-knowledge or wants knowledge files refreshed.",
  triage:
    "Deadline management and capacity planning across epics and PRs. Use when the user runs /triage or wants deadline/capacity triage.",
};

interface SyncResult {
  skillsCopied: string[];
  commandsConverted: string[];
  commandsSkipped: string[];
  rolesBundled: string[];
  extras: string[];
}

/** Guarded recursive delete: refuses any path outside the repo's generated dirs. */
function safeClean(path: string): void {
  const abs = resolve(path);
  const allowed = [resolve(AGENTS_SKILLS), resolve(CODEX_DIR)];
  if (!allowed.some((a) => abs === a)) {
    throw new Error(`refusing to clean unexpected path: ${abs}`);
  }
  if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
}

function firstHeading(md: string): string {
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.*)$/);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

/** Mirror every `.claude/skills/<name>/` into `.agents/skills/<name>/`, verbatim. */
function mirrorSkills(): string[] {
  const srcRoot = join(CLAUDE_DIR, "skills");
  const copied: string[] = [];
  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const src = join(srcRoot, name);
    const dest = join(AGENTS_SKILLS, name);
    cpSync(src, dest, { recursive: true });

    // Codex requires SKILL.md. One skill ships as `<name>.md` — add an alias.
    if (!existsSync(join(dest, "SKILL.md"))) {
      const alt = join(dest, `${name}.md`);
      if (existsSync(alt)) {
        cpSync(alt, join(dest, "SKILL.md"));
      }
    }
    copied.push(name);
  }
  return copied;
}

/** Turn a slash command file into a Codex skill (frontmatter + verbatim body). */
function convertCommands(): { converted: string[]; skipped: string[] } {
  const srcRoot = join(CLAUDE_DIR, "commands");
  const converted: string[] = [];
  const skipped: string[] = [];

  for (const file of readdirSync(srcRoot)) {
    if (!file.endsWith(".md")) continue;
    const name = basename(file, ".md");
    if (COMMANDS_DUPLICATING_SKILLS.has(name)) {
      skipped.push(name);
      continue;
    }

    const body = readFileSync(join(srcRoot, file), "utf8");
    const description =
      COMMAND_DESCRIPTIONS[name] ??
      `${firstHeading(body) || name}. Use when the user runs /${name}.`;

    const dest = join(AGENTS_SKILLS, name);
    mkdirSync(dest, { recursive: true });

    // SKILL.md — frontmatter, then the command body UNCHANGED.
    const skill = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trimStart()}`;
    writeFileSync(join(dest, "SKILL.md"), skill);

    // Explicit-only: a slash command shouldn't fire implicitly. Invoke as $name.
    mkdirSync(join(dest, "agents"), { recursive: true });
    const openaiYaml = `# Optional Codex skill metadata. Generated from Claude Code slash command /${name}.
# This mirrors an explicit command, so it does NOT fire implicitly — invoke it with: $${name}
policy:
  allow_implicit_invocation: false
`;
    writeFileSync(join(dest, "agents", "openai.yaml"), openaiYaml);
    converted.push(name);
  }
  return { converted, skipped };
}

/** Bundle the four orchestration personas into one reference skill. */
function bundleRoles(): string[] {
  const srcRoot = join(CLAUDE_DIR, "agents");
  if (!existsSync(srcRoot)) return [];
  const dest = join(AGENTS_SKILLS, "forge-roles");
  const refs = join(dest, "references");
  mkdirSync(refs, { recursive: true });

  const roles: string[] = [];
  for (const file of readdirSync(srcRoot)) {
    if (!file.endsWith(".md")) continue;
    cpSync(join(srcRoot, file), join(refs, file));
    roles.push(basename(file, ".md"));
  }
  roles.sort();

  const links = roles.map((r) => `- [${r}](references/${r}.md)`).join("\n");
  const skill = `---
name: forge-roles
description: Reference definitions for the Agent Forge orchestration roles (lead, worker, planner, evaluator). Use when coordinating multi-agent Forge work or when you need one role's responsibilities and constraints.
---

# Forge Roles

The Agent Forge harness splits multi-agent work into distinct roles. These persona
definitions come verbatim from the Claude Code harness (\`.claude/agents/\`) and are
bundled here so Codex can read them as reference.

${links}

Read the relevant role file before acting in that capacity. The Lead never writes
production code; Workers implement in scope; the Planner expands specs; the Evaluator
judges output at a model tier >= the tier that produced it.
`;
  writeFileSync(join(dest, "SKILL.md"), skill);
  return roles;
}

function writeCodexConfig(): void {
  mkdirSync(CODEX_DIR, { recursive: true });
  const toml = `# Codex configuration for agent-forge-harness.
# Generated by scripts/sync-codex.ts. Regenerate with: bun run codex:sync
#
# Claude Code lifecycle hooks (.claude/settings.json) have NO direct Codex
# equivalent. They are documented in .agents/CODEX-NOTES.md so nothing is lost
# silently. The one genuinely portable setting is below.

# Let Codex also treat CLAUDE.md files as instruction docs, in addition to AGENTS.md.
project_doc_fallback_filenames = ["CLAUDE.md"]
`;
  writeFileSync(join(CODEX_DIR, "config.toml"), toml);
}

function writeNotes(result: SyncResult): void {
  mkdirSync(join(ROOT, ".agents"), { recursive: true });
  const notes = `# Codex mirror — what ported and what didn't

Generated by \`scripts/sync-codex.ts\`. The Claude Code config in \`.claude/\` is the
source of truth; this file and everything under \`.agents/skills/\` + \`.codex/\` are a
regenerated mirror. Run \`bun run codex:sync\` after changing \`.claude/\`.

## How Codex finds this
- **Skills**: Codex scans \`.agents/skills/\` from the working dir up to the repo root.
- **Instructions**: Codex reads \`AGENTS.md\` (already present) and — via \`.codex/config.toml\`
  \`project_doc_fallback_filenames\` — also \`CLAUDE.md\`.
- **Invocation**: Codex uses \`$skill-name\` (implicit or explicit), not \`/name\`.
  Example: the forgemaster pipeline is \`$forgemaster\` in Codex.

## Ported cleanly
- **Skills** (${result.skillsCopied.length}): copied verbatim into \`.agents/skills/\`.
- **Slash commands as skills** (${result.commandsConverted.length}): ${result.commandsConverted.map((c) => `\`$${c}\``).join(", ")}.
  Body is unchanged; each is marked explicit-only via \`agents/openai.yaml\`.
- **Roles**: lead/worker/planner/evaluator bundled as the \`forge-roles\` skill.

## Skipped (would duplicate an existing skill)
${result.commandsSkipped.map((c) => `- \`/${c}\` — already a skill of the same name.`).join("\n")}

## NOT portable — Claude Code hooks have no Codex equivalent
These live in \`.claude/settings.json\` and only run under Claude Code. Under Codex you
must run their intent manually (or wire a Codex-side equivalent if one exists):
- **SessionStart**: \`bd dolt start\`, \`bd prime\`, AGENTS.md validate, \`session.ts\`.
- **PreToolUse (Bash)**: \`block-dangerous-git.sh\` — blocks destructive git. No Codex
  pre-tool hook, so this guardrail is NOT enforced under Codex.
- **Stop**: \`forge-phase-gate.ts --stop-hook\` — this is what auto-enforces the
  forgemaster phase gating. Under Codex the phases still run and self-gate via the
  \`forge:phase-gate\` scripts, but the automatic "don't stop until ship" enforcement
  is gone (convention-driven instead of hook-enforced).
- **TaskCompleted / TeammateIdle**: \`quality-gate.ts\` — run \`bun run quality-gate\`
  manually before shipping.
- **PreCompact**: \`bd prime\` — re-run \`bd prime\` after a context reset.

## Permissions
\`.claude/settings.json\` allow/deny lists are Claude-Code-specific. Codex has its own
approval + sandbox model (\`/permissions\`, config.toml). The deny list (no \`rm -rf\`,
no \`git push --force\`, etc.) is NOT auto-applied under Codex — configure Codex's
sandbox/approvals to match if you need equivalent guardrails.
`;
  writeFileSync(join(ROOT, ".agents", "CODEX-NOTES.md"), notes);
}

function main(): void {
  if (!existsSync(CLAUDE_DIR)) {
    console.log(
      JSON.stringify(
        { ok: false, data: null, error: `.claude not found at ${CLAUDE_DIR}` },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  // Clean only the generated trees (guarded), then rebuild.
  safeClean(AGENTS_SKILLS);
  safeClean(CODEX_DIR);
  mkdirSync(AGENTS_SKILLS, { recursive: true });

  const skillsCopied = mirrorSkills();
  const { converted, skipped } = convertCommands();
  const rolesBundled = bundleRoles();
  writeCodexConfig();

  const result: SyncResult = {
    skillsCopied,
    commandsConverted: converted,
    commandsSkipped: skipped,
    rolesBundled,
    extras: ["forge-roles", ".codex/config.toml", ".agents/CODEX-NOTES.md"],
  };
  writeNotes(result);

  console.log(
    JSON.stringify(
      {
        ok: true,
        data: {
          skills: skillsCopied.length,
          commandsConverted: converted.length,
          commandsSkipped: skipped.length,
          roles: rolesBundled,
          wrote: [
            `.agents/skills/ (${skillsCopied.length + converted.length + 1} skills)`,
            ".agents/CODEX-NOTES.md",
            ".codex/config.toml",
          ],
        },
        error: null,
      },
      null,
      2,
    ),
  );
}

main();
