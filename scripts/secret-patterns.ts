/**
 * The secret shapes the harness refuses to send to a provider or store in the
 * ledger. One list, shared by the council's context packer and the ledger's
 * redaction. Imports nothing, so it is safe in any runtime.
 */

export interface SecretPattern {
  kind: string;
  pattern: RegExp;
  /**
   * True when the match at `offset` in `text` is not a secret after all. A
   * pattern without it treats every match as a secret.
   */
  exempt?: (match: string, offset: number, text: string) => boolean;
}

/** A key body is at least this long, so a slug segment this long may be one. */
const KEY_BODY_MIN = 20;

/** Lowercase letters and digits in hyphen-separated segments, each too short to be a key body. */
const SLUG_BODY = new RegExp(
  `^[a-z0-9]{1,${KEY_BODY_MIN - 1}}(?:-[a-z0-9]{1,${KEY_BODY_MIN - 1}})*$`,
);

function isLowercaseLetter(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isUppercaseLetter(code: number): boolean {
  return code >= 65 && code <= 90;
}

/**
 * `sk-` in the middle of an ordinary slug such as `task-queue-state-machine-v2`
 * is not a key. The exemption is deliberately narrow — both halves must hold:
 *
 * - what follows `sk-` is slug-shaped: lowercase letters and digits only, in
 *   hyphen-separated segments shorter than a key body, none of them `sk`
 *   (which would start a key of its own), and not `ant-` or `proj-` (the
 *   vendor prefixes are never exempt);
 * - `sk` ends a lowercase word: at least two lowercase letters come directly
 *   before it, and that run starts the text or follows something that is not
 *   a letter or digit. A letter straight after `\` or `%` belongs to an escape
 *   (`\n`, `\t`, `%s`) and does not count; a run glued to a digit or an
 *   uppercase letter (hex, `%3D`, an ANSI `…31m`) is not a word.
 *
 * A key after any delimiter, escape, digit, or single letter is therefore
 * still caught, as is any key with a long, mixed-case or underscored body.
 */
function isSlugNotKey(match: string, offset: number, text: string): boolean {
  const body = match.slice("sk-".length);
  if (body.startsWith("ant-") || body.startsWith("proj-")) return false;
  if (!SLUG_BODY.test(body)) return false;
  if (body.split("-").includes("sk")) return false;

  let start = offset;
  while (start > 0 && isLowercaseLetter(text.charCodeAt(start - 1))) start--;
  let letters = offset - start;
  if (start > 0) {
    const before = text.charCodeAt(start - 1);
    if (isDigit(before) || isUppercaseLetter(before)) return false;
    const symbol = text[start - 1];
    if (symbol === "\\" || symbol === "%") letters -= 1;
  }
  return letters >= 2;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "provider-api-key-assignment",
    pattern:
      /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|DASHSCOPE_API_KEY|OPENROUTER_API_KEY)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  },
  {
    kind: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    kind: "anthropic-api-key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    kind: "openai-api-key",
    pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    exempt: isSlugNotKey,
  },
  {
    kind: "github-token",
    pattern: /gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}/g,
  },
  { kind: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: "slack-token", pattern: /xox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}/g },
];

export interface SecretRedaction {
  kind: string;
  count: number;
}

/** Replace every secret-shaped span with `[REDACTED:<kind>]` and say what was found. */
export function redactSecrets(text: string): {
  text: string;
  redactions: SecretRedaction[];
} {
  let sanitized = text;
  const redactions: SecretRedaction[] = [];
  for (const secret of SECRET_PATTERNS) {
    let count = 0;
    // None of the patterns has a capture group, so the callback's second and
    // third arguments are the match's offset and the text being scanned.
    sanitized = sanitized.replace(
      secret.pattern,
      (match: string, offset: number, scanned: string) => {
        if (secret.exempt?.(match, offset, scanned)) return match;
        count++;
        return `[REDACTED:${secret.kind}]`;
      },
    );
    if (count > 0) redactions.push({ kind: secret.kind, count });
  }
  return { text: sanitized, redactions };
}
