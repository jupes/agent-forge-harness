#!/usr/bin/env bun
/**
 * setup.ts — Interactive setup wizard for Agent Forge Harness
 *
 * Usage:
 *   bun run setup               # Interactive mode
 *   bun run setup --non-interactive  # Use defaults / env vars only
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const NON_INTERACTIVE = process.argv.includes("--non-interactive");

interface RepoEntry {
  name: string;
  url: string;
  defaultBranch: string;
}

interface ReposFile {
  repos: RepoEntry[];
}

async function ask(question: string, defaultValue = ""): Promise<string> {
  if (NON_INTERACTIVE) return defaultValue;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const prompt = defaultValue
      ? `${question} [${defaultValue}]: `
      : `${question}: `;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function main() {
  console.log("\nAgent Forge Harness Setup\n");

  if (NON_INTERACTIVE) {
    console.log("Running in non-interactive mode. Using defaults.");
  }

  // Step 1: Project name
  const projectName = await ask("Project name", "agent-forge-harness");

  // Step 2: GitHub org
  const githubOrg = await ask(
    "GitHub organization",
    process.env["GITHUB_ORG"] ?? "",
  );

  // Step 3: Repos to manage
  const reposPath = join(process.cwd(), "repos", "repos.json");
  let reposData: ReposFile = { repos: [] };

  if (existsSync(reposPath)) {
    reposData = JSON.parse(readFileSync(reposPath, "utf8")) as ReposFile;
  }

  if (!NON_INTERACTIVE && reposData.repos.length === 0) {
    console.log("\nAdd repos to manage (leave URL blank to stop):");
    let i = 1;
    while (true) {
      const url = await ask(`Repo ${i} URL`);
      if (!url) break;
      const namePart =
        url
          .replace(/\.git$/, "")
          .split("/")
          .pop() ?? `repo-${i}`;
      const name = await ask(`  Name for this repo`, namePart);
      const branch = await ask(`  Default branch`, "main");
      reposData.repos.push({ name, url, defaultBranch: branch });
      i++;
    }
    writeFileSync(reposPath, JSON.stringify(reposData, null, 2));
    console.log(
      `\nUpdated repos/repos.json with ${reposData.repos.length} repo(s).`,
    );
  }

  // Step 4: Update beads config if it exists
  const beadsConfigPath = join(process.cwd(), ".beads", "config.yaml");
  if (existsSync(beadsConfigPath)) {
    let config = readFileSync(beadsConfigPath, "utf8");
    config = config.replace(/^  name: .*$/m, `  name: ${projectName}`);
    writeFileSync(beadsConfigPath, config);
    console.log("Updated .beads/config.yaml");
  }

  // Summary
  console.log("\nSetup complete!");
  console.log(`  Project: ${projectName}`);
  console.log(`  Org: ${githubOrg || "(not set)"}`);
  console.log(`  Repos: ${reposData.repos.length}`);
  console.log("\nNext steps:");
  console.log("  1. bun run repo init --human   (clone sub-repos)");
  console.log(
    "  2. bd init && bd dolt pull      (initialize Beads; pull remote issue data when configured)",
  );
  console.log("  3. claude                        (open Claude Code)");
  console.log("  4. /status                       (check workspace)");
}

main().catch((err) => {
  console.error(
    "Setup failed:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
