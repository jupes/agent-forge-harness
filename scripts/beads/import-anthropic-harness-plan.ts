#!/usr/bin/env bun
/**
 * Creates Beads issues for the Anthropic "long-running harness" integration plan.
 *
 * **Idempotent:** safe to run multiple times. Reuses an existing epic (same title),
 * review task, and phase tasks under that epic when present; only creates missing
 * issues and missing `blocks` dependencies.
 *
 * Prerequisites: working `bd` with a Dolt-backed database (embedded Dolt needs CGO;
 * on Windows without CGO, install `dolt` and run `bd init --non-interactive --shared-server` or `--server`).
 *
 * Usage: bun run scripts/beads/import-anthropic-harness-plan.ts
 *
 * Emits the standard JSON envelope: { ok, data, error }.
 */

import { execFileSync } from "child_process";
import { parseBdCreateJsonOutput, parseJsonLoose, type BdCreateJson } from "./bd-json-parse";

const EPIC_TITLE = "Epic: Integrate Anthropic long-running harness learnings";
const EPIC_TITLE_QUERY = "Anthropic long-running harness learnings";
const REVIEW_TITLE = "Review Anthropic harness integration plan and adjust scope";

type Envelope =
  | {
      ok: true;
      data: {
        epicId: string;
        reviewId: string;
        phaseIds: string[];
        created: { epic: boolean; review: boolean; phases: boolean[] };
      };
      error: null;
    }
  | { ok: false; data: null; error: string };

interface BdListIssue {
  id: string;
  title: string;
  issue_type?: string;
  status?: string;
}

interface BdDepRow {
  id: string;
  dependency_type?: string;
}

function execBd(args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const stdout = execFileSync("bd", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).trim();
    return { ok: true, stdout };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const combined = `${err.stderr ?? ""}${err.stdout ?? ""}`.trim() || (err.message ?? String(e));
    return { ok: false, error: combined };
  }
}

function runBdJson(args: string[]): { ok: true; json: BdCreateJson } | { ok: false; error: string } {
  const run = execBd(args);
  if (!run.ok) return run;
  const json = parseBdCreateJsonOutput(run.stdout);
  if (!json) {
    return {
      ok: false,
      error: `bd returned no parseable issue JSON. Raw output:\n${run.stdout.slice(0, 2000)}`,
    };
  }
  return { ok: true, json };
}

function listIssues(extraArgs: string[]): { ok: true; issues: BdListIssue[] } | { ok: false; error: string } {
  const args = ["list", "--json", "--flat", "--limit", "200", ...extraArgs];
  const run = execBd(args);
  if (!run.ok) return run;
  try {
    const parsed: unknown = parseJsonLoose(run.stdout);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "bd list --json did not return an array" };
    }
    const issues = parsed as BdListIssue[];
    return { ok: true, issues };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function findEpicId(): { ok: true; id: string | null } | { ok: false; error: string } {
  const listed = listIssues([
    "--type",
    "epic",
    "--title-contains",
    EPIC_TITLE_QUERY,
    "--status",
    "open",
  ]);
  if (!listed.ok) return { ok: false, error: listed.error };
  const exact = listed.issues.find((i) => i.title === EPIC_TITLE && (i.issue_type === "epic" || !i.issue_type));
  return { ok: true, id: exact?.id ?? null };
}

function findChildByParentAndTitle(
  parentId: string,
  exactTitle: string,
): { ok: true; id: string | null } | { ok: false; error: string } {
  const listed = listIssues(["--parent", parentId]);
  if (!listed.ok) return { ok: false, error: listed.error };
  const matches = listed.issues.filter((i) => i.title === exactTitle);
  if (matches.length === 0) return { ok: true, id: null };
  const first = matches[0];
  if (!first) return { ok: true, id: null };
  const open = matches.find((m) => m.status === "open" || m.status === "in_progress" || m.status === "blocked");
  return { ok: true, id: (open ?? first).id };
}

function listDownstreamDeps(issueId: string): { ok: true; deps: BdDepRow[] } | { ok: false; error: string } {
  const run = execBd(["dep", "list", issueId, "--json"]);
  if (!run.ok) return run;
  try {
    const parsed: unknown = parseJsonLoose(run.stdout);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "bd dep list --json did not return an array" };
    }
    return { ok: true, deps: parsed as BdDepRow[] };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function hasBlocksDep(blocked: string, dependsOn: string): boolean {
  const listed = listDownstreamDeps(blocked);
  if (!listed.ok) return false;
  return listed.deps.some((d) => d.id === dependsOn && (d.dependency_type === "blocks" || !d.dependency_type));
}

function depEnsure(blocked: string, dependsOn: string): { ok: true } | { ok: false; error: string } {
  if (hasBlocksDep(blocked, dependsOn)) {
    return { ok: true };
  }
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

function main(): Envelope {
  const created = { epic: false, review: false, phases: [] as boolean[] };

  const epicLookup = findEpicId();
  if (!epicLookup.ok) {
    return { ok: false, data: null, error: `Cannot list issues (needed for idempotency): ${epicLookup.error}` };
  }
  let epicId = epicLookup.id;
  if (!epicId) {
    const epic = createIssue({
      title: EPIC_TITLE,
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
    epicId = epic.id;
    created.epic = true;
  }

  const reviewLookup = findChildByParentAndTitle(epicId, REVIEW_TITLE);
  if (!reviewLookup.ok) {
    return { ok: false, data: null, error: `Cannot list children of epic: ${reviewLookup.error}` };
  }
  let reviewId = reviewLookup.id;
  if (!reviewId) {
    const review = createIssue({
      title: REVIEW_TITLE,
      type: "task",
      parent: epicId,
      acceptance:
        "Plan reviewed against repo reality; phases confirmed or edited; execution order agreed; comment worklog on epic with summary.",
      description:
        "Read prior assistant plan (context: anthropic harness-design-long-running-apps). Decide skip/keep per phase, note risks, then close this task before implementation phases.",
      labels: ["harness", "planning"],
    });
    if (!review.ok) {
      return { ok: false, data: null, error: `Failed to create review task: ${review.error}` };
    }
    reviewId = review.id;
    created.review = true;
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
    const phaseLookup = findChildByParentAndTitle(epicId, p.title);
    if (!phaseLookup.ok) {
      return { ok: false, data: null, error: `Cannot list phase candidates: ${phaseLookup.error}` };
    }
    let pid = phaseLookup.id;
    let phaseCreated = false;
    if (!pid) {
      const t = createIssue({
        title: p.title,
        type: "task",
        parent: epicId,
        acceptance: p.acceptance,
        labels: ["harness", "anthropic-long-running"],
      });
      if (!t.ok) {
        return { ok: false, data: null, error: `Failed to create phase task "${p.title}": ${t.error}` };
      }
      pid = t.id;
      phaseCreated = true;
    }
    phaseIds.push(pid);
    created.phases.push(phaseCreated);
  }

  const [p0, p1, p2, p3, p4, p5] = phaseIds;
  if (!p0 || !p1 || !p2 || !p3 || !p4 || !p5) {
    return { ok: false, data: null, error: "Internal error: expected six phase issues" };
  }

  for (const pid of phaseIds) {
    const d = depEnsure(pid, reviewId);
    if (!d.ok) {
      return { ok: false, data: null, error: `Failed to ensure phase ${pid} depends on review: ${d.error}` };
    }
  }

  const chain: [string, string][] = [
    [p1, p0],
    [p2, p1],
    [p3, p2],
    [p4, p3],
    [p5, p3],
  ];
  for (const [blocked, dependsOn] of chain) {
    const d = depEnsure(blocked, dependsOn);
    if (!d.ok) {
      return {
        ok: false,
        data: null,
        error: `Failed to ensure dependency ${dependsOn} -> ${blocked}: ${d.error}`,
      };
    }
  }

  return {
    ok: true,
    data: { epicId, reviewId, phaseIds, created },
    error: null,
  };
}

const result = main();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
