#!/usr/bin/env bun
/**
 * check-pr-body.ts — Validate a PR body against the canonical Agent Forge template.
 *
 * Confirms every required H2 section is present and non-empty (not left as a
 * placeholder or HTML comment). Used by the ship steps before `gh pr create`.
 *
 * Usage:
 *   bun run .claude/skills/pr-description/scripts/check-pr-body.ts <path-to-body.md>
 *   gh pr view <n> --json body -q .body | bun run .../check-pr-body.ts -   # read stdin
 *
 * Output: JSON { ok, data: { present, missing, empty }, error } per harness convention.
 * Exit code 0 when ok, 1 when sections are missing/empty or input cannot be read.
 */

export {};

/** Required H2 headings, in canonical order. Must match references/pr-template.md exactly. */
const REQUIRED_SECTIONS = [
  "What Changed",
  "Why It's Needed",
  "How It Was Tested",
  "Test Evidence",
  "Risk & Rollback",
  "Linked Issues & AC Trace",
] as const;

interface Result {
  ok: boolean;
  data: { present: string[]; missing: string[]; empty: string[] };
  error: string | null;
}

/**
 * True when a section still has real content after removing template scaffolding.
 *
 * Strips HTML comments and `<placeholder>` hints, then requires at least one
 * alphanumeric character to remain — so a section left as bare list markers or an
 * empty code fence (e.g. `- <summary>`) counts as unfilled. This is a structural
 * guard, not a semantic judge: default boilerplate labels that carry real words
 * (e.g. the "How It Was Tested" gate command) legitimately pass.
 */
function hasContent(body: string): boolean {
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>\n]+>/g, "");
  return /[A-Za-z0-9]/.test(stripped);
}

/** Split a markdown doc into { heading -> section body } keyed by H2 (`## `) headings. */
function sectionsByHeading(markdown: string): Map<string, string> {
  const lines = markdown.split(/\r?\n/);
  const out = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null) out.set(current, buffer.join("\n"));
  };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      current = h2[1] ?? "";
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

function validate(body: string): Result {
  const sections = sectionsByHeading(body);
  const present: string[] = [];
  const missing: string[] = [];
  const empty: string[] = [];

  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) {
      missing.push(name);
      continue;
    }
    present.push(name);
    if (!hasContent(sections.get(name) ?? "")) {
      empty.push(name);
    }
  }

  const ok = missing.length === 0 && empty.length === 0;
  const problems: string[] = [];
  if (missing.length) problems.push(`missing sections: ${missing.join(", ")}`);
  if (empty.length)
    problems.push(`empty/placeholder sections: ${empty.join(", ")}`);

  return {
    ok,
    data: { present, missing, empty },
    error: ok ? null : problems.join("; "),
  };
}

async function readInput(arg: string | undefined): Promise<string> {
  if (!arg || arg === "-") return await Bun.stdin.text();
  return await Bun.file(arg).text();
}

const path = process.argv[2];
try {
  const body = await readInput(path);
  const result = validate(body);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  const result: Result = {
    ok: false,
    data: { present: [], missing: [...REQUIRED_SECTIONS], empty: [] },
    error: `could not read PR body${path ? ` from "${path}"` : ""}: ${(err as Error).message}`,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}
