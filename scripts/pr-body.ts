/** Pure canonical PR-body validator; source entry wrappers own all input/output and process exit. */
export const REQUIRED_PR_SECTIONS = [
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

function hasContent(body: string): boolean {
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>\n]+>/g, "");
  return /[A-Za-z0-9]/.test(stripped);
}

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

export function validatePrBody(body: string): Result {
  const sections = sectionsByHeading(body);
  const present: string[] = [];
  const missing: string[] = [];
  const empty: string[] = [];

  for (const name of REQUIRED_PR_SECTIONS) {
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
