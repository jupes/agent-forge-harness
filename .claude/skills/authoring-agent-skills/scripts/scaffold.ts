#!/usr/bin/env bun
// scaffold.ts — Create new skill directory
// Usage: bun run scaffold.ts <name> "<description>"
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { defaultSkillMarkdown } from "./scaffold-lib";

const name = process.argv[2];
const desc = process.argv[3];
try {
  if (!name || !desc)
    throw new Error("Usage: scaffold.ts <name> <description>");
  const md = defaultSkillMarkdown(name, desc);
  const dir = join(process.cwd(), ".claude", "skills", name);
  if (existsSync(dir)) throw new Error(`Already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md);
  console.log(
    JSON.stringify({ ok: true, data: { skill: name, path: dir }, error: null }),
  );
} catch (error) {
  console.log(JSON.stringify({ ok: false, data: null, error: String(error) }));
  process.exitCode = 1;
}
