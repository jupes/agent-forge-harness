#!/usr/bin/env bun

/**
 * quality-gate.ts
 *
 * Triggered on TaskCompleted and TeammateIdle events.
 * Runs core checks plus optional strict evaluator verdict (see AGENT_FORGE_EVAL_VERDICT).
 * Exits with code 2 to block completion if any fail.
 * Outputs structured JSON for agent consumption.
 */

import { Glob } from "bun";
import { execSync } from "child_process";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  type CloseGateIssueType,
  evaluateCloseTestingAttestation,
} from "../../scripts/close-testing-attestation";
import {
  parseEvalVerdictJson,
  verdictBlocksShip,
} from "../../scripts/eval-verdict";
import { getQualityGateLogPath } from "./utils/constants";

interface CheckResult {
  name: string;
  passed: boolean;
  output?: string;
  skipped?: boolean;
  skipReason?: string;
}

interface GateResult {
  event: string;
  timestamp: string;
  passed: boolean;
  checks: CheckResult[];
  blockingFailures: string[];
}

type BdIssueJson = { issue_type?: string; type?: string } | null;

function run(cmd: string, cwd?: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { ok: true, output: output.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function hasScript(name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    return Boolean(pkg?.scripts?.[name]);
  } catch {
    return false;
  }
}

function hasTestFiles(): boolean {
  const cwd = process.cwd();
  const patterns = [
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
  ];
  for (const pattern of patterns) {
    const glob = new Glob(pattern);
    for (const file of glob.scanSync({ cwd, onlyFiles: true })) {
      const norm = file.replaceAll("\\", "/");
      if (norm.includes("node_modules/")) continue;
      if (norm.startsWith("repos/") || norm.startsWith("trees/")) continue;
      return true;
    }
  }
  return false;
}

function issueTypeFromBdShowJson(output: string): CloseGateIssueType {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return "unknown";
  }
  const rows = Array.isArray(parsed) ? parsed : [];
  const first = (rows[0] ?? null) as BdIssueJson;
  const raw = String(first?.issue_type ?? first?.type ?? "")
    .toLowerCase()
    .trim();
  if (
    raw === "epic" ||
    raw === "feature" ||
    raw === "task" ||
    raw === "bug" ||
    raw === "chore"
  )
    return raw;
  return "unknown";
}

function commentBodiesFromBdCommentsJson(output: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const text = (row as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) out.push(text);
  }
  return out;
}

const event = process.env["CLAUDE_HOOK_EVENT"] ?? "TaskCompleted";
const taskId = process.env["CLAUDE_TASK_ID"] ?? "";

const checks: CheckResult[] = [];
const blockingFailures: string[] = [];

// Check 1: TypeScript typecheck
{
  const r = run("bun run typecheck");
  checks.push({
    name: "typecheck",
    passed: r.ok,
    ...(r.ok ? {} : { output: r.output.slice(0, 800) }),
  });
  if (!r.ok) blockingFailures.push("typecheck");
}

// Check 2: Lint (skip if no lint script)
if (hasScript("lint")) {
  const r = run("bun run lint");
  checks.push({
    name: "lint",
    passed: r.ok,
    ...(r.ok ? {} : { output: r.output.slice(0, 800) }),
  });
  if (!r.ok) blockingFailures.push("lint");
} else {
  checks.push({
    name: "lint",
    passed: true,
    skipped: true,
    skipReason: "no lint script in package.json",
  });
}

// Check 3: Tests (skip if no test files)
if (hasTestFiles()) {
  const r = run(hasScript("test") ? "bun run test" : "bun test scripts");
  checks.push({
    name: "tests",
    passed: r.ok,
    ...(r.ok ? {} : { output: r.output.slice(0, 1200) }),
  });
  if (!r.ok) blockingFailures.push("tests");
} else {
  checks.push({
    name: "tests",
    passed: true,
    skipped: true,
    skipReason: "no test files found",
  });
}

// Check 4: Clean working tree
{
  const r = run("git status --porcelain");
  const clean = r.ok && r.output.trim() === "";
  checks.push({
    name: "clean-tree",
    passed: clean,
    ...(clean ? {} : { output: r.output.slice(0, 400) }),
  });
  if (!clean) blockingFailures.push("clean-tree");
}

// TaskCompleted-only checks
if (event === "TaskCompleted") {
  let taskIssueType: CloseGateIssueType = "unknown";

  // Check 5: AC verification
  if (taskId) {
    const bdJsonResult = run(`bd show ${taskId} --json`);
    if (bdJsonResult.ok) {
      taskIssueType = issueTypeFromBdShowJson(bdJsonResult.output);
    }
    const bdResult = run(`bd show ${taskId}`);
    if (bdResult.ok && bdResult.output.includes("ac:")) {
      // AC list was found — mark as needing human/agent verification
      checks.push({
        name: "ac-verify",
        passed: true,
        output: "AC found — verify before closing task",
      });
    } else {
      checks.push({
        name: "ac-verify",
        passed: true,
        skipped: true,
        skipReason: "no AC found or Beads not configured",
      });
    }
  } else {
    checks.push({
      name: "ac-verify",
      passed: true,
      skipped: true,
      skipReason: "no CLAUDE_TASK_ID set",
    });
  }

  // Check 6: Feature/Epic close testing attestation
  if (!taskId) {
    checks.push({
      name: "close-testing-attestation",
      passed: true,
      skipped: true,
      skipReason: "no CLAUDE_TASK_ID set",
    });
  } else {
    const commentsResult = run(`bd comments ${taskId} --json`);
    const attestation = evaluateCloseTestingAttestation(
      taskIssueType,
      commentsResult.ok
        ? commentBodiesFromBdCommentsJson(commentsResult.output)
        : [],
    );
    if (!attestation.required) {
      checks.push({
        name: "close-testing-attestation",
        passed: true,
        skipped: true,
        skipReason: `issue type ${taskIssueType} does not require attestation`,
      });
    } else {
      checks.push({
        name: "close-testing-attestation",
        passed: attestation.passed,
        ...(attestation.passed
          ? {}
          : { output: attestation.guidance ?? "testing attestation required" }),
      });
      if (!attestation.passed)
        blockingFailures.push("close-testing-attestation");
    }
  }

  // Check 7: Test evidence (recent commits should include test files)
  {
    const r = run("git log --oneline --name-only -5");
    const hasRecentTests =
      r.ok && (r.output.includes(".test.") || r.output.includes(".spec."));
    checks.push({
      name: "test-evidence",
      passed: hasRecentTests,
      ...(hasRecentTests
        ? {}
        : {
            output:
              "No test files in recent commits — ensure tests were committed",
          }),
    });
    if (!hasRecentTests) blockingFailures.push("test-evidence");
  }

  // Check 8 (optional): strict evaluator verdict JSON
  {
    const mode = (process.env["AGENT_FORGE_EVAL_VERDICT"] ?? "")
      .trim()
      .toLowerCase();
    if (mode === "strict") {
      if (!taskId) {
        checks.push({
          name: "eval-verdict",
          passed: false,
          output: "AGENT_FORGE_EVAL_VERDICT=strict requires CLAUDE_TASK_ID",
        });
        blockingFailures.push("eval-verdict");
      } else {
        const verdictPath = join(
          process.cwd(),
          ".tmp",
          "work",
          `${taskId}-verdict.json`,
        );
        if (!existsSync(verdictPath)) {
          checks.push({
            name: "eval-verdict",
            passed: false,
            output: `Missing verdict file: ${verdictPath}`,
          });
          blockingFailures.push("eval-verdict");
        } else {
          let text: string;
          try {
            text = readFileSync(verdictPath, "utf8");
          } catch {
            checks.push({
              name: "eval-verdict",
              passed: false,
              output: `Could not read verdict file: ${verdictPath}`,
            });
            blockingFailures.push("eval-verdict");
            text = "";
          }
          if (text.trim() === "" && blockingFailures.includes("eval-verdict")) {
            // read already failed
          } else if (text.trim() === "") {
            checks.push({
              name: "eval-verdict",
              passed: false,
              output: `Empty verdict file: ${verdictPath}`,
            });
            blockingFailures.push("eval-verdict");
          } else {
            const pr = parseEvalVerdictJson(text);
            if (!pr.ok) {
              checks.push({
                name: "eval-verdict",
                passed: false,
                output: pr.error,
              });
              blockingFailures.push("eval-verdict");
            } else if (pr.value.taskId !== taskId) {
              checks.push({
                name: "eval-verdict",
                passed: false,
                output: `verdict taskId "${pr.value.taskId}" !== CLAUDE_TASK_ID "${taskId}"`,
              });
              blockingFailures.push("eval-verdict");
            } else if (verdictBlocksShip(pr.value)) {
              checks.push({
                name: "eval-verdict",
                passed: false,
                output: `verdict FAIL with blocker/high — ${JSON.stringify(pr.value.findings)}`,
              });
              blockingFailures.push("eval-verdict");
            } else {
              checks.push({
                name: "eval-verdict",
                passed: true,
                output: `${pr.value.verdict} B=${pr.value.findings.blocker} H=${pr.value.findings.high}`,
              });
            }
          }
        }
      }
    } else {
      checks.push({
        name: "eval-verdict",
        passed: true,
        skipped: true,
        skipReason:
          mode === ""
            ? "set AGENT_FORGE_EVAL_VERDICT=strict to require .tmp/work/<TASK-ID>-verdict.json"
            : `AGENT_FORGE_EVAL_VERDICT="${mode}" is not strict`,
      });
    }
  }
}

const result: GateResult = {
  event,
  timestamp: new Date().toISOString(),
  passed: blockingFailures.length === 0,
  checks,
  blockingFailures,
};

// Log to file
try {
  appendFileSync(getQualityGateLogPath(), JSON.stringify(result) + "\n");
} catch {
  // Log failure is non-fatal
}

// Output JSON for agent consumption
console.log(JSON.stringify(result, null, 2));

if (!result.passed) {
  console.error(
    `\nQuality gate FAILED. Blocking failures: ${blockingFailures.join(", ")}`,
  );
  process.exit(2);
}

process.exit(0);
