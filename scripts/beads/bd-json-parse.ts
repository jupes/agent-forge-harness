/**
 * Parse `bd` CLI JSON output (pretty-printed or noisy stdout).
 * Shared by `import-anthropic-harness-plan.ts` and tests.
 */

export interface BdCreateJson {
  id?: string;
}

/** Parse JSON object or array from bd stdout (may be pretty-printed; may have log noise). */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty bd output");

  const tryParse = (chunk: string): unknown => JSON.parse(chunk) as unknown;

  try {
    return tryParse(trimmed);
  } catch {
    /* continue */
  }

  /** First `{` or `[` that starts a JSON value (handles log lines before JSON). */
  const firstJsonStart = (s: string): number => {
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === "{" || c === "[") return j;
    }
    return -1;
  };

  /** Match nested `{}` or `[]` only; ignores braces inside JSON strings. */
  const sliceBalancedJson = (s: string, start: number): string | null => {
    const open = s[start];
    if (open !== "{" && open !== "[") return null;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let esc = false;
    for (let k = start; k < s.length; k++) {
      const c = s[k];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\" && inString) {
        esc = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return s.slice(start, k + 1);
      }
    }
    return null;
  };

  const start = firstJsonStart(trimmed);
  if (start !== -1) {
    const chunk = sliceBalancedJson(trimmed, start);
    if (chunk) {
      try {
        return tryParse(chunk);
      } catch {
        /* continue */
      }
    }
  }

  throw new Error("no parseable JSON in bd output");
}

/** `bd create --json` may emit pretty-printed multi-line JSON. */
export function parseBdCreateJsonOutput(out: string): BdCreateJson | null {
  try {
    const parsed: unknown = parseJsonLoose(out);
    if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
      return parsed as BdCreateJson;
    }
  } catch {
    return null;
  }
  return null;
}
