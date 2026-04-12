#!/usr/bin/env bun
/**
 * repo.ts — Multi-repo git operations CLI
 *
 * Usage: bun run repo <command> [--repo <name>] [--human] [--dry-run]
 *
 * Commands: init, status, refresh, reset, branch create <name>, branch cleanup, stacked-rebase <branches...>
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

interface RepoConfig {
  name: string;
  url: string;
  defaultBranch: string;
}

interface RepoRegistry {
  repos: RepoConfig[];
}

interface RepoResult {
  name: string;
  ok: boolean;
  action: string;
  path: string;
  branch?: string;
  message?: string;
}

interface CommandResult {
  ok: boolean;
  command: string;
  repos: RepoResult[];
  errors: Array<{ repo: string; message: string }>;
}

const REPOS_FILE = join(process.cwd(), "repos", "repos.json");
const REPOS_DIR = join(process.cwd(), "repos");

function loadRepos(): RepoConfig[] {
  if (!existsSync(REPOS_FILE)) {
    console.error(JSON.stringify({ ok: false, error: `repos.json not found at ${REPOS_FILE}` }));
    process.exit(1);
  }
  const data: RepoRegistry = JSON.parse(readFileSync(REPOS_FILE, "utf8"));
  return data.repos ?? [];
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
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: ((e.stdout ?? "") + (e.stderr ?? "")).trim() };
  }
}

const args = process.argv.slice(2);
const humanMode = args.includes("--human");
const dryRun = args.includes("--dry-run");
const repoFlag = args.indexOf("--repo");
const targetRepo = repoFlag !== -1 ? args[repoFlag + 1] : undefined;

const command = args.filter(a => !a.startsWith("--"))[0] ?? "status";
const subCommand = args.filter(a => !a.startsWith("--"))[1];
const extraArgs = args.filter(a => !a.startsWith("--")).slice(2);

function filterRepos(repos: RepoConfig[]): RepoConfig[] {
  return targetRepo ? repos.filter(r => r.name === targetRepo) : repos;
}

function output(result: CommandResult): void {
  if (humanMode) {
    console.log(`\n=== ${result.command} ===`);
    for (const r of result.repos) {
      const icon = r.ok ? "✓" : "✗";
      console.log(`  ${icon} ${r.name}: ${r.action}${r.message ? ` — ${r.message}` : ""}`);
    }
    if (result.errors.length > 0) {
      console.log("\nErrors:");
      for (const e of result.errors) console.log(`  ${e.repo}: ${e.message}`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const repos = loadRepos();
const targets = filterRepos(repos);
const results: RepoResult[] = [];
const errors: Array<{ repo: string; message: string }> = [];

if (command === "init") {
  for (const repo of targets) {
    const repoPath = join(REPOS_DIR, repo.name);
    if (existsSync(repoPath)) {
      const r = run(`git pull --rebase`, repoPath);
      results.push({ name: repo.name, ok: r.ok, action: "pulled", path: repoPath });
      if (!r.ok) errors.push({ repo: repo.name, message: r.output });
    } else {
      const r = run(`git clone ${repo.url} ${repo.name}`, REPOS_DIR);
      results.push({ name: repo.name, ok: r.ok, action: "cloned", path: repoPath, branch: repo.defaultBranch });
      if (!r.ok) errors.push({ repo: repo.name, message: r.output });
    }
  }
} else if (command === "status") {
  for (const repo of targets) {
    const repoPath = join(REPOS_DIR, repo.name);
    if (!existsSync(repoPath)) {
      results.push({ name: repo.name, ok: false, action: "not-cloned", path: repoPath, message: "Run: bun run repo init" });
      continue;
    }
    const branch = run("git branch --show-current", repoPath).output;
    const aheadBehind = run("git rev-list --left-right --count HEAD...@{u}", repoPath);
    const dirty = run("git status --porcelain", repoPath).output !== "";
    const [ahead, behind] = aheadBehind.ok ? aheadBehind.output.split("\t").map(Number) : [0, 0];
    results.push({ name: repo.name, ok: true, action: "status", path: repoPath, branch, message: `ahead:${ahead} behind:${behind} dirty:${dirty}` });
  }
} else if (command === "refresh") {
  for (const repo of targets) {
    const repoPath = join(REPOS_DIR, repo.name);
    if (!existsSync(repoPath)) { errors.push({ repo: repo.name, message: "not cloned" }); continue; }
    const r = run(`git pull --rebase origin ${repo.defaultBranch}`, repoPath);
    results.push({ name: repo.name, ok: r.ok, action: "refreshed", path: repoPath });
    if (!r.ok) errors.push({ repo: repo.name, message: r.output });
  }
} else if (command === "reset") {
  for (const repo of targets) {
    const repoPath = join(REPOS_DIR, repo.name);
    if (!existsSync(repoPath)) { errors.push({ repo: repo.name, message: "not cloned" }); continue; }
    if (!dryRun) {
      const r1 = run(`git fetch origin`, repoPath);
      const r2 = run(`git reset --hard origin/${repo.defaultBranch}`, repoPath);
      results.push({ name: repo.name, ok: r1.ok && r2.ok, action: "reset", path: repoPath });
      if (!r2.ok) errors.push({ repo: repo.name, message: r2.output });
    } else {
      results.push({ name: repo.name, ok: true, action: "reset (dry-run)", path: repoPath });
    }
  }
} else if (command === "branch" && subCommand === "create" && extraArgs[0]) {
  const branchName = extraArgs[0];
  for (const repo of targets) {
    const repoPath = join(REPOS_DIR, repo.name);
    if (!existsSync(repoPath)) { errors.push({ repo: repo.name, message: "not cloned" }); continue; }
    const r = run(`git checkout -b ${branchName}`, repoPath);
    results.push({ name: repo.name, ok: r.ok, action: `branch created: ${branchName}`, path: repoPath, branch: branchName });
    if (!r.ok) errors.push({ repo: repo.name, message: r.output });
  }
} else if (command === "branch" && subCommand === "cleanup") {
  for (const repo of targets) {
    const repoPath = join(REPOS_DIR, repo.name);
    if (!existsSync(repoPath)) { errors.push({ repo: repo.name, message: "not cloned" }); continue; }
    const merged = run(`git branch --merged main | grep -v "^\*\|main\|master"`, repoPath).output;
    const branches = merged.split("\n").map(b => b.trim()).filter(Boolean);
    if (dryRun) {
      results.push({ name: repo.name, ok: true, action: `would delete: ${branches.join(", ") || "none"}`, path: repoPath });
    } else {
      for (const b of branches) run(`git branch -d ${b}`, repoPath);
      results.push({ name: repo.name, ok: true, action: `deleted ${branches.length} branches`, path: repoPath });
    }
  }
} else {
  console.error(JSON.stringify({ ok: false, error: `Unknown command: ${command}` }));
  process.exit(1);
}

output({ ok: errors.length === 0, command, repos: results, errors });
process.exit(errors.length > 0 ? 1 : 0);
