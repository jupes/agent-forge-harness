#!/usr/bin/env bun
// scaffold.ts — Create new skill directory
// Usage: bun run scaffold.ts <name> "<description>"
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { defaultSkillMarkdown } from "./scaffold-lib";

const name = process.argv[2];
const desc = process.argv[3] ?? "TODO: description";
if (!name) {
  console.error(
    JSON.stringify({ ok: false, error: "Usage: scaffold.ts <name> [desc]" }),
  );
  process.exit(1);
}
const dir = join(process.cwd(), ".claude", "skills", name);
if (existsSync(dir)) {
  console.error(JSON.stringify({ ok: false, error: `Already exists: ${dir}` }));
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
mkdirSync(join(dir, "scripts"), { recursive: true });
mkdirSync(join(dir, "references"), { recursive: true });

const md = defaultSkillMarkdown(name, desc);

writeFileSync(join(dir, "SKILL.md"), md);
console.log(JSON.stringify({ ok: true, skill: name, path: dir }));
