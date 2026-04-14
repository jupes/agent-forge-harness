#!/usr/bin/env bun
/**
 * quality-gate.ts
 *
 * Triggered on TaskCompleted and TeammateIdle events.
 * Runs 6 checks; exits with code 2 to block completion if any fail.
 * Outputs structured JSON for agent consumption.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { Glob } from "bun";
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
  const patterns = ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"];
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
  checks.push({ name: "lint", passed: true, skipped: true, skipReason: "no lint script in package.json" });
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
  checks.push({ name: "tests", passed: true, skipped: true, skipReason: "no test files found" });
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
  // Check 5: AC verification
  if (taskId) {
    const bdResult = run(`bd show ${taskId}`);
    if (bdResult.ok && bdResult.output.includes("ac:")) {
      // AC list was found — mark as needing human/agent verification
      checks.push({ name: "ac-verify", passed: true, output: "AC found — verify before closing task" });
    } else {
      checks.push({ name: "ac-verify", passed: true, skipped: true, skipReason: "no AC found or Beads not configured" });
    }
  } else {
    checks.push({ name: "ac-verify", passed: true, skipped: true, skipReason: "no CLAUDE_TASK_ID set" });
  }

  // Check 6: Test evidence (recent commits should include test files)
  {
    const r = run("git log --oneline --name-only -5");
    const hasRecentTests = r.ok && (r.output.includes(".test.") || r.output.includes(".spec."));
    checks.push({
      name: "test-evidence",
      passed: hasRecentTests,
      ...(hasRecentTests
        ? {}
        : { output: "No test files in recent commits — ensure tests were committed" }),
    });
    if (!hasRecentTests) blockingFailures.push("test-evidence");
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
  console.error(`\nQuality gate FAILED. Blocking failures: ${blockingFailures.join(", ")}`);
  process.exit(2);
}

process.exit(0);
