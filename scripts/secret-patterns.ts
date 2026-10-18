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

// Detection-only compatibility folding, one ASCII percent-escape layer, and a
// finite Greek/Cyrillic lookalike table for API_KEY / Authorization / Bearer.
const LOOKALIKES: Record<string, string> = {
  а: "a",
  α: "a",
  р: "p",
  ρ: "p",
  і: "i",
  ι: "i",
  к: "k",
  κ: "k",
  е: "e",
  ε: "e",
  у: "y",
  υ: "y",
  о: "o",
  ο: "o",
  т: "t",
  τ: "t",
  н: "h",
  һ: "h",
  в: "b",
  β: "b",
  г: "r",
  ζ: "z",
  ν: "n",
};
function credentialForm(value: string): {
  text: string;
  from?: number[];
  to?: number[];
} {
  if (!/[%\u0080-\uffff]/.test(value)) return { text: value };
  const pieces: string[] = [],
    from: number[] = [],
    to: number[] = [];
  for (let at = 0; at < value.length; ) {
    const start = at;
    let char = String.fromCodePoint(value.codePointAt(at) ?? 0);
    at += char.length;
    if (char === "%" && /^[0-7][0-9a-f]$/i.test(value.slice(at, at + 2))) {
      char = String.fromCharCode(Number.parseInt(value.slice(at, at + 2), 16));
      at += 2;
    }
    const normalized = char.normalize("NFKC");
    for (const part of normalized) {
      const mapped = LOOKALIKES[part.toLowerCase()] ?? part;
      pieces.push(mapped === "\u2800" || mapped === "\ufff9" ? " " : mapped);
      for (let unit = 0; unit < mapped.length; unit++) {
        from.push(start);
        to.push(at);
      }
    }
  }
  return { text: pieces.join(""), from, to };
}

const TOKEN_STOP = /[\s"'?,;&#{}[\]<>:=]/;
const FRAGMENT_BREAK = /[\t\r\n\u2028\u2029"']/;
function startsRecord(text: string, end: number): boolean {
  while (/["' \t]/.test(text[end] ?? "")) end++;
  return text[end] === ":" || text[end] === "=";
}
/** Space and structural punctuation end a value. Quotes/newlines join token
 * fragments only until a new assignment/record (name followed by : or =).
 * Thus an ambiguous bare word on the next line is conservatively concealed.
 */
function credentialEnd(text: string, start: number): number {
  let at = start;
  while (at < text.length && !TOKEN_STOP.test(text[at] ?? "")) at++;
  while (FRAGMENT_BREAK.test(text[at] ?? "")) {
    let next = at;
    while (FRAGMENT_BREAK.test(text[next] ?? "")) next++;
    let end = next;
    while (end < text.length && !TOKEN_STOP.test(text[end] ?? "")) end++;
    if (end === next || startsRecord(text, end)) break;
    at = end;
  }
  return at;
}

function contextualSpans(
  text: string,
  bearer = false,
): Array<[number, number]> {
  const form = credentialForm(text),
    value = form.text;
  const label = bearer
    ? new RegExp(
        [..."authorization"].join("[\\t\\r\\n]*") +
          `[\\t\\r\\n ]*["']?[\\t\\r\\n ]*:[\\t\\r\\n ]*["']?` +
          [..."bearer"].join("[\\t\\r\\n]*") +
          "[\\t\\r\\n ]+",
        "gi",
      )
    : /a[\t\r\n]*p[\t\r\n]*i[\t\r\n]*_[\t\r\n]*k[\t\r\n]*e[\t\r\n]*y/gi;
  const spans: Array<[number, number]> = [];
  for (let match = label.exec(value); match; match = label.exec(value)) {
    let start = match.index,
      at = label.lastIndex;
    if (!bearer) {
      if (value[at] === '"' || value[at] === "'") at++;
      const beforeSpace = at;
      while (/\s/.test(value[at] ?? "")) at++;
      if (value[at] === ":" || value[at] === "=") {
        at++;
        while (/\s/.test(value[at] ?? "")) at++;
      } else if (at === beforeSpace) continue;
      if (value[at] === '"' || value[at] === "'") at++;
    }
    const end = credentialEnd(value, at);
    if (end === at || startsRecord(value, end)) continue;
    if (!bearer)
      while (start > 0 && /[a-z0-9_]/i.test(value[start - 1] ?? "")) start--;
    spans.push([form.from?.[start] ?? start, form.to?.[end - 1] ?? end]);
    label.lastIndex = end;
  }
  return spans;
}

/** Fragmented vendor tokens use the existing shape and exemption after joining
 * only tab/newline/quote fragments. Plain-space prose is never joined.
 */
function fragmentedTokenSpans(
  text: string,
  pattern: RegExp,
  prefixes: string[],
  exempt?: SecretPattern["exempt"],
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const prefix = new RegExp(
    prefixes
      .map((value) => [...value].join(`[\\t\\r\\n\\u2028\\u2029"']*`))
      .join("|"),
    "g",
  );
  for (let found = prefix.exec(text); found; found = prefix.exec(text)) {
    const end = credentialEnd(text, found.index);
    prefix.lastIndex = Math.max(prefix.lastIndex, end);
    const token = text.slice(found.index, end);
    if (!FRAGMENT_BREAK.test(token)) continue;
    const joined = token.replace(/[\t\r\n\u2028\u2029"']/g, "");
    const match = new RegExp(`^(?:${pattern.source})$`).exec(joined);
    if (match && !exempt?.(joined, found.index, text))
      spans.push([found.index, end]);
  }
  return spans;
}

export const SECRET_PATTERNS: readonly (SecretPattern | SecretFinder)[] = [
  {
    kind: "provider-api-key-assignment",
    spans: contextualSpans,
  },
  {
    kind: "authorization-bearer",
    spans: (text) => contextualSpans(text, true),
  },
  {
    kind: "anthropic-api-key",
    spans: (text) =>
      fragmentedTokenSpans(text, /sk-ant-[A-Za-z0-9_-]{20,}/g, ["sk-ant-"]),
  },
  {
    kind: "openai-api-key",
    spans: (text) =>
      fragmentedTokenSpans(
        text,
        /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
        ["sk-"],
        isSlugNotKey,
      ),
  },
  {
    kind: "github-token",
    spans: (text) =>
      fragmentedTokenSpans(
        text,
        /gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9]{20,}\w*/g,
        ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
      ),
  },
  {
    kind: "aws-access-key",
    spans: (text) => fragmentedTokenSpans(text, /AKIA[0-9A-Z]{16}/g, ["AKIA"]),
  },
  {
    kind: "slack-token",
    spans: (text) =>
      fragmentedTokenSpans(text, /xox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}/g, [
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxr-",
        "xoxs-",
      ]),
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

/** Raw written-form primitive: used by secretSpans contract tests and the multi-form scanner. */
export function redactWrittenForm(text: string): {
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

/** A secret the written-form scanner would replace: its kind, and the `[start, end)` it covers in the text it was given. */
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
 * Where the written-form scanner finds secrets in `text`, in `text`'s own positions:
 * one span for each marker it writes, in order, none overlapping. Writing
 * `[REDACTED:<kind>]` over each span gives exactly what the written-form scanner gives.
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

/**
 * The first and last code point of every run of characters `withoutControls`
 * replaces: the C0 and C1 controls and DEL, and every default-ignorable code
 * point (Unicode's Default_Ignorable_Code_Point), the characters a reader is
 * shown as nothing.
 */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul choseong and jungseong fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian free variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner, joiner; directional marks
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, isolates, format characters
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark (zero-width no-break space)
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff0, 0xfff8], // reserved, default-ignorable
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical symbol format controls
  [0xe0000, 0xe0fff], // tags and the variation selectors supplement
];

/** A character class of these ranges, built from code points so this file holds none of them. */
function classOf(ranges: ReadonlyArray<readonly [number, number]>): string {
  return `[${ranges
    .map(([first, last]) =>
      first === last
        ? `\\u{${first.toString(16)}}`
        : `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`,
    )
    .join("")}]`;
}

const HIDDEN = new RegExp(classOf(HIDDEN_RANGES), "gu");
// Bun's Unicode range regex can skip a BMP invisible after an unpaired high
// surrogate. Isolate code points for malformed UTF-16 before matching them.
const MALFORMED_UTF16 =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * What the form with the invisible characters taken out removes: every
 * character `withoutControls` replaces but the tab and the line feed, and a
 * carriage return only when no line feed follows it. Those keep apart words a
 * reader sees apart; a line tabulation, a form feed or a lone carriage return
 * between two halves of a key is taken out like any other.
 */
const REMOVED_RANGES = HIDDEN_RANGES.flatMap(
  ([first, last]): Array<readonly [number, number]> =>
    first <= 0x0d && last >= 0x09
      ? [
          [first, 0x08],
          [0x0b, 0x0c],
          [0x0e, last],
        ]
      : [[first, last]],
);
const REMOVED_SOURCE = `\\r(?!\\n)|${classOf(REMOVED_RANGES)}`;
const REMOVED = new RegExp(REMOVED_SOURCE, "gu");
const HAS_REMOVED = new RegExp(REMOVED_SOURCE, "u");

/**
 * `value` with its invisible characters taken out, and for each code unit
 * left the index it came from in `value`; null when there are none to take.
 */
function withoutInvisible(
  value: string,
): { text: string; origin: number[] } | null {
  const malformed = MALFORMED_UTF16.test(value);
  if (!malformed && !HAS_REMOVED.test(value)) return null;
  const origin: number[] = [];
  let text = "";
  let kept = 0;
  const keep = (until: number): void => {
    text += value.slice(kept, until);
    for (let at = kept; at < until; at += 1) origin.push(at);
  };
  const matches = malformed ? invisibleMatches(value) : value.matchAll(REMOVED);
  for (const match of matches) {
    keep(match.index);
    kept = match.index + match[0].length;
  }
  keep(value.length);
  return text === value ? null : { text, origin };
}

/** Matches in malformed text, isolated so the engine cannot skip a BMP character. */
function* invisibleMatches(
  value: string,
): Generator<{ 0: string; index: number }> {
  let index = 0;
  for (const char of value) {
    if (!(char === "\r" && value[index + 1] === "\n") && char.match(REMOVED))
      yield { 0: char, index };
    index += char.length;
  }
}

/**
 * `value` with every control character and every invisible formatting
 * character (zero-width, joiners, bidirectional marks, soft hyphen, fillers,
 * variation selectors, tags) replaced by a space for each of its code units,
 * so the result has the same length as `value`. What an operator is shown
 * before sending must not be able to move the cursor, hide text, reorder it or
 * ring the bell.
 */
export function withoutControls(value: string): string {
  if (MALFORMED_UTF16.test(value))
    return Array.from(value, (char) =>
      char.replace(HIDDEN, (hidden) => " ".repeat(hidden.length)),
    ).join("");
  return value.replace(HIDDEN, (char) => " ".repeat(char.length));
}

type Redacted = { text: string; redactions: SecretRedaction[] };

type MergedSpan = SecretSpan & { kinds: Set<string> };

/** `base` with each span replaced by one marker, named by its first find. */
function replaceSpans(base: string, merged: MergedSpan[]): Redacted {
  const counts = new Map<string, number>();
  let text = "";
  let kept = 0;
  for (const span of merged) {
    text += `${base.slice(kept, span.start)}[REDACTED:${span.kind}]`;
    kept = span.end;
    for (const kind of span.kinds)
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  text += base.slice(kept);
  return {
    text,
    redactions: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}

/**
 * Where the scanner finds something in `value` read three ways, as places in
 * `value`, overlapping finds merged, with the shown form:
 *
 * - as written;
 * - as shown (`withoutControls`): a key written directly against a provider
 *   variable name, an invisible character between the name and its sign, is
 *   taken with the name as written, and the sign is then left with nothing
 *   before it; as shown, the name is assigned the value. The shown form has
 *   the same length, code unit for code unit, so a find is a place in both;
 * - with the invisible characters taken out (`withoutInvisible`): a value, a
 *   name or a key split by them is broken as written and broken as shown, and
 *   whole only here. Each find is mapped back to the written text from the
 *   first character it covers to the last, so the invisible characters inside
 *   it go with it.
 *
 * Scanning one form after another is not enough (the first scan's marker
 * takes the name the next one needs), so every form reads `value` itself and
 * the union of what they find is what is replaced.
 */
function secretsInAnyForm(value: string): {
  shown: string;
  written: SecretSpan[];
  merged: MergedSpan[];
  /** True when another form finds something the written form does not cover. */
  othersAddMore: boolean;
} {
  const shown = withoutControls(value);
  if (shown.length !== value.length)
    // By construction never: each code unit replaced is one space.
    throw new Error("the shown form of a text must keep its length");
  const written = secretSpans(value);
  const seen = shown === value ? [] : secretSpans(shown);
  const joined = shown === value ? null : withoutInvisible(value);
  const whole =
    joined === null
      ? []
      : secretSpans(joined.text).map((span) => ({
          kind: span.kind,
          start: joined.origin[span.start] ?? span.start,
          end: (joined.origin[span.end - 1] ?? span.end - 1) + 1,
        }));
  const others = [...seen, ...whole];
  // Each list is ordered and nonoverlapping: sweep written coverage once per
  // additional form rather than rescanning every written span for every hit.
  const othersAddMore = [seen, whole].some((spans) => {
    let at = 0;
    return spans.some((span) => {
      while ((written[at]?.end ?? Infinity) <= span.start) at++;
      const cover = written[at];
      return !cover || cover.start > span.start || cover.end < span.end;
    });
  });
  const found = [...written, ...others].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const merged: MergedSpan[] = [];
  for (const span of found) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      last.kinds.add(span.kind);
    } else merged.push({ ...span, kinds: new Set([span.kind]) });
  }
  return { shown, written, merged, othersAddMore };
}

/**
 * `value` as it is shown — every control and invisible formatting character
 * replaced by a space — with every secret the scanner finds in it as written,
 * as shown or with the invisible characters taken out, replaced. Overlapping
 * finds become one marker, named by the first.
 */
export function redactShown(value: string): Redacted {
  const { shown, merged } = secretsInAnyForm(value);
  if (merged.length === 0) return { text: shown, redactions: [] };
  return replaceSpans(shown, merged);
}

/**
 * `value` as written — its invisible characters kept, because content is sent
 * as written — with every secret the scanner finds in it as written, as shown
 * or with the invisible characters taken out, replaced (see
 * `secretsInAnyForm`). When the other forms find nothing the written one
 * does not, this preserves the raw written-form result and counts.
 */
export function redactWritten(value: string): Redacted {
  const shown = withoutControls(value);
  if (shown === value) return redactWrittenForm(value);
  // Turning tab/LF/CRLF into spaces cannot extend a contextual/token find:
  // those characters join fragments as written, while spaces terminate them.
  // The exception is PEM markers, whose spaces are literal.
  // Keep this inventory check in sync when adding patterns; actual removed
  // characters always take the mapped union path below.
  if (!MALFORMED_UTF16.test(value) && !HAS_REMOVED.test(value)) {
    const writtenKeys = privateKeySpans(value);
    const shownKeys = privateKeySpans(shown);
    if (
      writtenKeys.length === shownKeys.length &&
      writtenKeys.every(
        ([start, end], at) =>
          start === shownKeys[at]?.[0] && end === shownKeys[at]?.[1],
      )
    )
      return redactWrittenForm(value);
  }
  const { written, merged, othersAddMore } = secretsInAnyForm(value);
  if (merged.length === 0) return { text: value, redactions: [] };
  // Preserve counts from the raw written-form scan when it covers every hit.
  if (!othersAddMore && written.length > 0) return redactWrittenForm(value);
  return replaceSpans(value, merged);
}

/** Redact the union of written, displayed and invisibles-removed secret spans. */
export const redactSecrets = redactWritten;
