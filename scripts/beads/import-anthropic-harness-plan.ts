#!/usr/bin/env bun
/**
 * Creates Beads issues for the Anthropic "long-running harness" integration plan.
 *
 * Prerequisites: working `bd` with a Dolt-backed database (embedded Dolt needs CGO;
 * on Windows without CGO, install `dolt` and run `bd init --non-interactive --shared-server` or `--server`).
 *
 * Usage: bun run scripts/beads/import-anthropic-harness-plan.ts
 *
 * Emits the standard JSON envelope: { ok, data, error }.
 */

import { execFileSync } from "child_process";

type Envelope =
  | { ok: true; data: { epicId: string; reviewId: string; phaseIds: string[] }; error: null }
  | { ok: false; data: null; error: string };

interface BdCreateJson {
  id?: string;
}

function runBdJson(args: string[]): { ok: true; json: BdCreateJson } | { ok: false; error: string } {
  try {
    const out = execFileSync("bd", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).trim();
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("{") && l.endsWith("}"));
    if (!line) {
      return { ok: false, error: `bd returned no JSON object. Raw output:\n${out.slice(0, 2000)}` };
    }
    const json = JSON.parse(line) as BdCreateJson;
    return { ok: true, json };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    const combined = `${err.stderr ?? ""}${err.stdout ?? ""}`.trim() || (err.message ?? String(e));
    return { ok: false, error: combined };
  }
}

function createIssue(params: {
  title: string;
  type: "epic" | "task" | "feature";
  parent?: string;
  acceptance?: string;
  description?: string;
  labels?: string[];
}): { ok: true; id: string } | { ok: false; error: string } {
  const args = ["create", params.title, "--type", params.type, "--json"];
  if (params.parent) {
    args.push("--parent", params.parent);
  }
  if (params.acceptance) {
    args.push("--acceptance", params.acceptance);
  }
  if (params.description) {
    args.push("--description", params.description);
  }
  if (params.labels?.length) {
    args.push("--labels", params.labels.join(","));
  }
  const res = runBdJson(args);
  if (!res.ok) return res;
  const id = res.json.id;
  if (!id || typeof id !== "string") {
    return { ok: false, error: "bd create JSON missing string id field" };
  }
  return { ok: true, id };
}

function depAdd(blocked: string, dependsOn: string): { ok: true } | { ok: false; error: string } {
  try {
    execFileSync("bd", ["dep", "add", blocked, dependsOn], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { ok: true };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const msg = `${err.stderr ?? ""}${err.stdout ?? ""}`.trim() || (err.message ?? String(e));
    return { ok: false, error: msg };
  }
}

function main(): Envelope {
  const epic = createIssue({
    title: "Epic: Integrate Anthropic long-running harness learnings",
    type: "epic",
    description:
      "Apply patterns from Anthropic engineering post on harness design for long-running apps (generator/evaluator separation, planner, session handoff, rubric, conditional ceremony). Reference: https://www.anthropic.com/engineering/harness-design-long-running-apps",
    labels: ["harness", "anthropic-long-running"],
  });
  if (!epic.ok) {
    return {
      ok: false,
      data: null,
      error: `Failed to create epic (is Beads initialized?). ${epic.error}`,
    };
  }

  const review = createIssue({
    title: "Review Anthropic harness integration plan and adjust scope",
    type: "task",
    parent: epic.id,
    acceptance:
      "Plan reviewed against repo reality; phases confirmed or edited; execution order agreed; comment worklog on epic with summary.",
    description:
      "Read prior assistant plan (context: anthropic harness-design-long-running-apps). Decide skip/keep per phase, note risks, then close this task before implementation phases.",
    labels: ["harness", "planning"],
  });
  if (!review.ok) {
    return { ok: false, data: null, error: `Failed to create review task: ${review.error}` };
  }

  const phases: { title: string; acceptance: string }[] = [
    {
      title: "Phase 0: Document harness lessons in knowledge/_shared.yaml",
      acceptance:
        "knowledge/_shared.yaml includes anthropic_long_running_harness section with link, reset vs compaction guidance, evaluator cost heuristic.",
    },
    {
      title: "Phase 1: Add session handoff protocol and session hook reminder",
      acceptance:
        ".claude/protocols/session-handoff.md exists; CLAUDE.md session protocol references it; session.ts prints reminder when .tmp/work/session-handoff.md exists.",
    },
    {
      title: "Phase 2: Add planner agent and wire /plan command",
      acceptance:
        ".claude/agents/planner.md exists; .claude/commands/plan.md instructs reading planner persona for vague prompts.",
    },
    {
      title: "Phase 3: Add evaluation rubric and wire lead/evaluator",
      acceptance:
        ".claude/protocols/evaluation-rubric.md exists; lead.md Step 5 references rubric; evaluator.md requires skeptical UI/product checks when applicable.",
    },
    {
      title: "Phase 4 (optional): Document E2E / Playwright path for UI-heavy tasks",
      acceptance:
        "Rubric or knowledge notes when to add browser verification; no mandatory Playwright for all PRs.",
    },
    {
      title: "Phase 5: Conditional ceremony table in lead + refine vs pivot in feature workflow",
      acceptance:
        "lead.md includes when to skip/lighten alignment or evaluator; feature.md documents refine vs pivot after FAILED verdict.",
    },
  ];

  const phaseIds: string[] = [];
  for (const p of phases) {
    const t = createIssue({
      title: p.title,
      type: "task",
      parent: epic.id,
      acceptance: p.acceptance,
      labels: ["harness", "anthropic-long-running"],
    });
    if (!t.ok) {
      return { ok: false, data: null, error: `Failed to create phase task "${p.title}": ${t.error}` };
    }
    phaseIds.push(t.id);
  }

  for (const pid of phaseIds) {
    const d = depAdd(pid, review.id);
    if (!d.ok) {
      return { ok: false, data: null, error: `Failed to link phase ${pid} -> review: ${d.error}` };
    }
  }

  const [p0, p1, p2, p3, p4, p5] = phaseIds;
  if (!p0 || !p1 || !p2 || !p3 || !p4 || !p5) {
    return { ok: false, data: null, error: "Internal error: expected six phase issues" };
  }

  const chain: [string, string][] = [
    [p1, p0],
    [p2, p1],
    [p3, p2],
    [p4, p3],
    [p5, p3],
  ];
  for (const [blocked, dependsOn] of chain) {
    const d = depAdd(blocked, dependsOn);
    if (!d.ok) {
      return {
        ok: false,
        data: null,
        error: `Failed dependency ${dependsOn} -> ${blocked}: ${d.error}`,
      };
    }
  }

  return {
    ok: true,
    data: { epicId: epic.id, reviewId: review.id, phaseIds },
    error: null,
  };
}

const result = main();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
