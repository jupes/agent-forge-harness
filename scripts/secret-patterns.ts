/**
 * The secret shapes the harness refuses to send to a provider or store in the
 * ledger. One list, shared by the council's context packer and the ledger's
 * redaction. Imports nothing, so it is safe in any runtime.
 */

/** A kind of secret one regular expression finds. */
export interface SecretPattern {
  kind: string;
  pattern: RegExp;
  /**
   * True when the match at `offset` in `text` is not a secret after all. A
   * pattern without it treats every match as a secret.
   */
  exempt?: (match: string, offset: number, text: string) => boolean;
}

/** A kind of secret found by reading the text rather than by one pattern. */
export interface SecretFinder {
  kind: string;
  /** Where the secrets are in `text`: `[start, end)` spans, in order, none overlapping. */
  spans: (text: string) => Array<[number, number]>;
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

/** A private key's first or last line. */
const KEY_MARKER =
  /-----(BEGIN|END) (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;

/**
 * Where private keys are in `text`, read in one pass over their marker lines.
 * A pattern that looked from every BEGIN line for an END line read the rest of
 * the text again at each one, which took seconds over a megabyte of BEGIN
 * lines; this reads the text once, however many marker lines it holds.
 *
 * - A key runs from a BEGIN line to the first END line after it.
 * - A BEGIN line with no END line after it is a key cut short: it runs to the
 *   end of the text.
 * - An END line with no BEGIN line before it is the rest of a key that began
 *   somewhere else (an earlier comment, another file): it runs back to where
 *   the key before it ended, or to the start of the text.
 */
function privateKeySpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const markers = new RegExp(KEY_MARKER.source, "g");
  let open: number | null = null;
  let previousEnd = 0;
  for (
    let marker = markers.exec(text);
    marker !== null;
    marker = markers.exec(text)
  ) {
    if (marker[1] === "BEGIN") {
      open ??= marker.index;
      continue;
    }
    const end = marker.index + marker[0].length;
    spans.push([open ?? previousEnd, end]);
    open = null;
    previousEnd = end;
  }
  if (open !== null) spans.push([open, text.length]);
  return spans;
}

/** `://`, then a user and a password, up to the `@` before the host. */
const URL_USERINFO = /:\/\/([^\s/?#:[\]"<>]*:[^\s/?#[\]"<>]+)(?=@)/;

/**
 * The user and password written into a URL, between `scheme://` and the `@`
 * before the host, read as a URL parser reads them: the user stops at the
 * first `:`, and the password runs to the last `@` before the path, query or
 * fragment. The scheme and the host are kept. A URL with a user and no
 * password, an scp-style `git@host:path` remote, and a `:` or `@` after the
 * host are not matched. Nor is a redaction marker (`[` and `]` never belong to
 * a user or a password), so text redacted once has nothing more to find.
 *
 * Found from the literal `://` rather than with a lookbehind for it: a
 * lookbehind is tried at every character, and made scanning ordinary text
 * about six times slower.
 */
function urlCredentialSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const found = new RegExp(URL_USERINFO.source, "g");
  for (let url = found.exec(text); url !== null; url = found.exec(text)) {
    const start = url.index + "://".length;
    spans.push([start, start + (url[1] ?? "").length]);
  }
  return spans;
}

export const SECRET_PATTERNS: readonly (SecretPattern | SecretFinder)[] = [
  {
    kind: "provider-api-key-assignment",
    pattern:
      /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|DASHSCOPE_API_KEY|OPENROUTER_API_KEY)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  },
  { kind: "private-key", spans: privateKeySpans },
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
    // Classic tokens, and fine-grained ones: `github_pat_`, a run of letters
    // and digits, `_`, and another run. Twenty letters and digits straight
    // after `github_pat_` are enough, so a token cut short is still caught
    // and a snake_case name that merely starts with the prefix is not.
    pattern: /gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9]{20,}\w*/g,
  },
  { kind: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: "slack-token", pattern: /xox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}/g },
  { kind: "url-credentials", spans: urlCredentialSpans },
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
    const found =
      "spans" in secret
        ? redactSpans(sanitized, secret)
        : redactMatches(sanitized, secret);
    sanitized = found.text;
    if (found.count > 0)
      redactions.push({ kind: secret.kind, count: found.count });
  }
  return { text: sanitized, redactions };
}

/** A secret `redactSecrets` would replace: its kind, and the `[start, end)` it covers in the text it was given. */
export interface SecretSpan {
  kind: string;
  start: number;
  end: number;
}

/** The `[start, end)` spans one pattern or finder matches in `text`, as `redactSecrets` reads them. */
function spansOf(
  text: string,
  secret: SecretPattern | SecretFinder,
): Array<[number, number]> {
  if ("spans" in secret) return secret.spans(text);
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(secret.pattern)) {
    const start = match.index;
    if (secret.exempt?.(match[0], start, text)) continue;
    spans.push([start, start + match[0].length]);
  }
  return spans;
}

/**
 * Where `redactSecrets` finds secrets in `text`, in `text`'s own positions:
 * one span for each marker it writes, in order, none overlapping. Writing
 * `[REDACTED:<kind>]` over each span gives exactly what `redactSecrets` gives.
 *
 * The patterns are read in the same order and each one reads the text as the
 * ones before it left it, so a later pattern can take in an earlier marker; a
 * span then runs from the start of everything its match covers to the end.
 * Two texts of the same length whose characters correspond one for one (a
 * text and the same text with its invisible characters replaced) give spans
 * that can be laid over each other.
 */
export function secretSpans(text: string): SecretSpan[] {
  let current = text;
  // For each character of `current`, the span of `text` it stands for, and the
  // kind when it belongs to a marker. Made at the first hit: most texts have none.
  let from: number[] | null = null;
  let to: number[] | null = null;
  let kinds: Array<string | null> | null = null;
  for (const secret of SECRET_PATTERNS) {
    const found = spansOf(current, secret);
    if (found.length === 0) continue;
    if (from === null || to === null || kinds === null) {
      from = Array.from({ length: current.length }, (_, at) => at);
      to = Array.from({ length: current.length }, (_, at) => at + 1);
      kinds = new Array<string | null>(current.length).fill(null);
    }
    const nextFrom: number[] = [];
    const nextTo: number[] = [];
    const nextKinds: Array<string | null> = [];
    const pieces: string[] = [];
    let kept = 0;
    const keep = (until: number): void => {
      pieces.push(current.slice(kept, until));
      for (let at = kept; at < until; at++) {
        nextFrom.push(from?.[at] ?? at);
        nextTo.push(to?.[at] ?? at + 1);
        nextKinds.push(kinds?.[at] ?? null);
      }
    };
    for (const [start, end] of found) {
      keep(start);
      const marker = `[REDACTED:${secret.kind}]`;
      const covered = [from[start] ?? start, to[end - 1] ?? end] as const;
      pieces.push(marker);
      for (let at = 0; at < marker.length; at++) {
        nextFrom.push(covered[0]);
        nextTo.push(covered[1]);
        nextKinds.push(secret.kind);
      }
      kept = end;
    }
    keep(current.length);
    current = pieces.join("");
    from = nextFrom;
    to = nextTo;
    kinds = nextKinds;
  }
  if (from === null || to === null || kinds === null) return [];
  const spans: SecretSpan[] = [];
  for (let at = 0; at < current.length; at++) {
    const kind = kinds[at];
    if (kind === null || kind === undefined) continue;
    const start = from[at] ?? 0;
    const end = to[at] ?? 0;
    const last = spans.at(-1);
    // One marker's characters all stand for the same span.
    if (last && last.start === start && last.end === end) continue;
    spans.push({ kind, start, end });
  }
  return spans;
}

function redactMatches(
  text: string,
  secret: SecretPattern,
): { text: string; count: number } {
  let count = 0;
  // None of the patterns has a capture group, so the callback's second and
  // third arguments are the match's offset and the text being scanned.
  const redacted = text.replace(
    secret.pattern,
    (match: string, offset: number, scanned: string) => {
      if (secret.exempt?.(match, offset, scanned)) return match;
      count++;
      return `[REDACTED:${secret.kind}]`;
    },
  );
  return { text: redacted, count };
}

function redactSpans(
  text: string,
  secret: SecretFinder,
): { text: string; count: number } {
  const spans = secret.spans(text);
  if (spans.length === 0) return { text, count: 0 };
  const pieces: string[] = [];
  let kept = 0;
  for (const [start, end] of spans) {
    pieces.push(text.slice(kept, start), `[REDACTED:${secret.kind}]`);
    kept = end;
  }
  pieces.push(text.slice(kept));
  return { text: pieces.join(""), count: spans.length };
}
