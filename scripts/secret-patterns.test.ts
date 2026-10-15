/**
 * The `sk-` key patterns and the one exemption they carry.
 *
 * `ORIGINAL` is the pair of patterns as they stood before any exemption
 * existed (commit 3e0921d). The rule under test: everything `ORIGINAL` matched
 * is still redacted, except `sk-` inside an ordinary lowercase hyphenated
 * slug — a word of at least two lowercase letters ending in `sk`
 * (`task-`, `risk-`, `desk-`) followed by short lowercase segments.
 *
 * What `ORIGINAL` caught and the rule lets through, stated plainly:
 *   - such slugs (the point of the exemption), and
 *   - a key that is shaped exactly like one: glued to two or more lowercase
 *     letters that start a word, with a body of only lowercase letters and
 *     digits in hyphen-separated segments shorter than 20 characters, none of
 *     them `sk`, and not starting `ant-` or `proj-`. The last test pins an
 *     example. No vendor key shape known to this list looks like that.
 * Nothing else is known: the corpus test compares against `ORIGINAL` directly,
 * and is only as wide as its corpus.
 *
 * After them: fine-grained GitHub tokens, credentials written into a URL, and
 * private keys, including a key with only one of its two marker lines. Every
 * token, password and key those tests use is put together from pieces, so
 * none of them is written out whole in this file.
 */

import { describe, expect, test } from "bun:test";
import { redactSecrets, type SecretSpan, secretSpans } from "./secret-patterns";

const ORIGINAL: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
];

const ANTHROPIC = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";

/** Fake keys in every shape the patterns are meant for. */
const KEYS: readonly string[] = [
  ANTHROPIC,
  "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz_0123-456789",
  OPENAI,
  "sk-proj-AbCd_EfGh-IjKlMnOpQrStUvWxYz0123456789",
  "sk-abcdefghijklmnopqrstuvwxyz123456",
  "sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  "sk-0123456789abcdef0123456789abcdef",
  "sk-svcacct-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef",
];

/** What may sit directly in front of a key: a name, and the literal text. */
const PREFIXES: ReadonlyArray<[string, string]> = [
  ["nothing", ""],
  ["=", "TOKEN="],
  ['"', '{"token":"'],
  [":", "token:"],
  ["a space", "the key is "],
  ["a newline", "first line\n"],
  ["a tab", "key\t"],
  ["a JSON-escaped newline", "my key is:\\n"],
  ["a JSON-escaped tab", "key\\t"],
  ["a JSON-escaped carriage return", "key\\r"],
  ["a doubly escaped newline", "key\\\\n"],
  ["a URL-encoded =", "?key%3D"],
  ["a lower-case URL-encoded =", "?key%3d"],
  ["a URL-encoded /", "path%2F"],
  ["a printf placeholder letter", "%s"],
  ["an ANSI colour code", "\u001b[31m"],
  ["a JSON-escaped ANSI colour code", "\\u001b[0m"],
  ["a digit", "7"],
  ["a year", "2026"],
  ["hex digits", "deadbeef"],
  ["0x hex", "0xdeadbeef"],
  ["hex ending in digits", "c0ffee42"],
  ["a single lowercase letter", "x"],
  ["a single letter after a space", "is n"],
  ["a single uppercase letter", "K"],
  ["uppercase letters", "TOKEN"],
  ["a capitalised word", "Bearer"],
  ["two lowercase letters", "de"],
  ["a lowercase word", "token"],
  ["a word that itself ends in sk", "my-task"],
  ["an underscore", "api_key_"],
  ["a hyphen", "key-"],
  ["a slash", "https://example.com/"],
  ["a bracket", "["],
];

/** What follows `sk-` in a slug: lowercase segments, each too short to be a key body. */
const SLUG_BODY = "queue-state-machine-v2";

/** Ordinary slugs: `sk-` only ever appears inside a word. */
const SLUGS: readonly string[] = [
  "task-queue-state-machine-v2",
  "plans/drafts/task-queue-state-machine-v2.md",
  "risk-assessment-for-the-ledger-rollout",
  "desk-booking-calendar-sync-2026",
  "disk-usage-report-for-agent-forge-d3ede1",
  "a multitask-runner-with-several-workers here",
  "c:/users/someone/trees/task-runner-agent-forge-d3ede1",
  '{"runId":"task-queue-state-machine-v2"}',
  "first\\ntask-queue-state-machine-v2",
];

function originalMatches(text: string): string[] {
  return ORIGINAL.flatMap((pattern) => text.match(pattern) ?? []);
}

describe("sk- key patterns", () => {
  for (const [name, prefix] of PREFIXES) {
    test(`a key directly after ${name} is redacted`, () => {
      for (const key of KEYS) {
        for (const suffix of ["", " trailing", '"}', "\\n"]) {
          const text = `${prefix}${key}${suffix}`;
          const result = redactSecrets(text);
          expect({ text, leaked: result.text.includes(key) }).toEqual({
            text,
            leaked: false,
          });
          expect(result.text).toContain("[REDACTED:");
          expect(result.redactions.length).toBeGreaterThan(0);
        }
      }
    });
  }

  test("sk-ant- and sk-proj- are redacted whatever word they are glued to, even when the rest looks like a slug", () => {
    for (const text of [
      "risk-ant-colony-optimisation-notes-2026",
      "desk-proj-abcdefghijklmnopqrstuvwxyz",
      "task-ant-queue-state-machine-v2-notes",
      "task-proj-queue-state-machine-v2-notes",
    ]) {
      const result = redactSecrets(text);
      expect(result.text).toContain("[REDACTED:");
      for (const match of originalMatches(text))
        expect(result.text).not.toContain(match);
    }
  });

  test("a slug that merely contains sk- inside a lowercase word is left alone", () => {
    for (const text of SLUGS) {
      expect(originalMatches(text).length).toBeGreaterThan(0);
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.redactions).toEqual([]);
    }
  });

  test("everything the original patterns matched in the corpus is still redacted, slugs aside", () => {
    const corpus = [
      ...PREFIXES.flatMap(([, prefix]) =>
        KEYS.map((key) => `${prefix}${key} and more`),
      ),
      ...SLUGS.flatMap((slug) => KEYS.map((key) => `${slug} ${key}`)),
      ...SLUGS.flatMap((slug) => KEYS.map((key) => `${slug}-${key}`)),
      ...KEYS.map((key) => `${key}${key}`),
    ];
    const slugSpans = new Set(SLUGS.flatMap((slug) => originalMatches(slug)));
    let compared = 0;
    for (const text of corpus) {
      const result = redactSecrets(text).text;
      for (const match of originalMatches(text)) {
        if (slugSpans.has(match)) continue;
        expect({ text, survived: result.includes(match) }).toEqual({
          text,
          survived: false,
        });
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(corpus.length / 2);
  });

  test("a slug shape that could hide a key is not exempt: a long segment, an uppercase letter, an underscore, a second sk- segment, an empty segment", () => {
    for (const text of [
      "task-abcdefghijklmnopqrstuvwxyz123456",
      "task-queue-0123456789abcdef0123456789abcdef",
      "task-queue-State-machine-v2-notes",
      "task-queue_state_machine_v2-notes",
      "task-queue-state-sk-123e4567-e89b-12d3-a456",
      "task-queue--state-machine-v2-notes",
      "task-queue-state-machine-v2-notes-",
    ]) {
      const result = redactSecrets(text);
      expect({ text, redacted: result.text }).toEqual({
        text,
        redacted: expect.stringContaining("[REDACTED:openai-api-key]"),
      });
    }
  });

  test("a slug whose word is not two lowercase letters at a word start is still redacted, as it always was", () => {
    for (const text of [
      "ask-me-anything-about-the-ledger",
      "Task-queue-state-machine-v2",
      "v2task-queue-state-machine-v2",
      "\\nsk-queue-state-machine-v2-notes",
    ]) {
      expect({ text, redacted: redactSecrets(text).text }).toEqual({
        text,
        redacted: expect.stringContaining("[REDACTED:openai-api-key]"),
      });
    }
  });

  // Each case is decided by one branch of the word-start check alone: the
  // same two letters after a space are exempt, so dropping the branch for
  // the character in front lets the text through. The texts are put together
  // here because the redacted ones are what the scanner flags.
  test("sk- and a slug body after two lowercase letters are redacted when a digit, an uppercase letter, a backslash or a percent sign comes before the letters, and left alone when a space does", () => {
    const text = (before: string): string => `${before}task-${SLUG_BODY}`;
    for (const before of ["7", "D", "\\", "%"]) {
      expect({ before, redacted: redactSecrets(text(before)).text }).toEqual({
        before,
        redacted: `${before}ta[REDACTED:openai-api-key]`,
      });
    }
    expect(redactSecrets(text(" "))).toEqual({
      text: text(" "),
      redactions: [],
    });
  });

  test("the two key kinds keep their own labels and the count leaves exempt slugs out", () => {
    expect(redactSecrets(`a ${ANTHROPIC}`).text).toBe(
      "a [REDACTED:anthropic-api-key]",
    );
    expect(redactSecrets(`a ${OPENAI}`).text).toBe(
      "a [REDACTED:openai-api-key]",
    );
    expect(
      redactSecrets(`task-queue-state-machine-v2 ${OPENAI} n${OPENAI}`)
        .redactions,
    ).toEqual([{ kind: "openai-api-key", count: 2 }]);
  });

  test("the known gap: a key shaped exactly like a slug, glued to a lowercase word, is not told apart from one", () => {
    const text = "desk-123e4567-e89b-12d3-a456-426614174000";
    expect(originalMatches(text).length).toBe(1);
    expect(redactSecrets(text).text).toBe(text);
  });
});

const MEGABYTE = 1024 * 1024;

/** `line` repeated until the text is at least `bytes` characters long. */
function repeatedTo(line: string, bytes: number): string {
  return line.repeat(Math.ceil(bytes / line.length));
}

/** `redactSecrets` over `text`, and how many milliseconds it took. */
function timed(text: string): {
  ms: number;
  result: ReturnType<typeof redactSecrets>;
} {
  const started = performance.now();
  const result = redactSecrets(text);
  return { ms: performance.now() - started, result };
}

/** Well under a second, with room for a loaded machine. */
const SCAN_BUDGET_MS = 250;

/** Fake GitHub tokens: the classic shape and the fine-grained one. */
const CLASSIC_TOKEN = ["ghp", "_", "Zq9".repeat(12)].join("");
const FINE_GRAINED_TOKENS: readonly string[] = [
  ["github_pat_", "A".repeat(82)].join(""),
  // Laid out like a real one: 22 characters, an underscore, 59 characters.
  ["github_pat_", "Zq9".repeat(7), "Z", "_", "Wx8".repeat(19), "Wx"].join(""),
];

/** Private key marker lines, put together so no whole one is written here. */
const RULE = "-".repeat(5);
const KEY_TYPES: readonly string[] = ["", "RSA ", "EC ", "OPENSSH ", "DSA "];
const beginLine = (type: string): string =>
  `${RULE}BEGIN ${type}PRIVATE KEY${RULE}`;
const endLine = (type: string): string =>
  `${RULE}END ${type}PRIVATE KEY${RULE}`;
const KEY_BODY: readonly string[] = ["Zq9Zq8Zq7".repeat(7), "Wx8".repeat(21)];
const keyBlock = (type: string): string =>
  [beginLine(type), ...KEY_BODY, endLine(type)].join("\n");

/** Whether any line of the fake key body is still in `text`. */
const keepsBody = (text: string): boolean =>
  KEY_BODY.some((line) => text.includes(line));

describe("GitHub tokens", () => {
  test("a fine-grained github_pat_ token is redacted as a github-token, alone and inside text", () => {
    for (const token of FINE_GRAINED_TOKENS) {
      for (const [prefix, suffix] of [
        ["", ""],
        ["GH_TOKEN=", "\n"],
        ['{"token":"', '"}'],
        ["the token is ", " and it expires soon"],
      ]) {
        const text = `${prefix}${token}${suffix}`;
        const result = redactSecrets(text);
        expect({ text, redacted: result.text }).toEqual({
          text,
          redacted: `${prefix}[REDACTED:github-token]${suffix}`,
        });
        expect(result.redactions).toEqual([{ kind: "github-token", count: 1 }]);
      }
    }
  });

  test("a classic ghp_ token is still redacted as a github-token", () => {
    expect(redactSecrets(`token ${CLASSIC_TOKEN}`)).toEqual({
      text: "token [REDACTED:github-token]",
      redactions: [{ kind: "github-token", count: 1 }],
    });
  });

  test("the github_pat_ prefix named in prose, or starting a snake_case name, is left alone", () => {
    for (const text of [
      "fine-grained tokens start with github_pat_ and expire",
      "const github_pat_expiry_warning_days = 7;",
    ]) {
      expect(redactSecrets(text)).toEqual({ text, redactions: [] });
    }
  });
});

describe("credentials in a URL", () => {
  const secret = "Zq9".repeat(6);
  const url = (scheme: string, userinfo: string, rest: string): string =>
    `${scheme}://${userinfo}@${rest}`;
  const withCredentials: ReadonlyArray<[string, string, string]> = [
    ["scheme", ["user", "password"].join(":"), "host"],
    ["https", `user:${secret}`, "example.com/owner/repo.git"],
    ["https", `x-access-token:${secret}`, "github.com/owner/repo.git"],
    ["https", `${secret}:x-oauth-basic`, "github.com/owner/repo"],
    ["postgres", `app:${secret}`, "db.internal:5432/app?sslmode=require"],
    ["redis", `:${secret}`, "cache.internal:6379/0"],
    ["https", `user:p@ss${secret}`, "example.com/"],
    ["https", `user:a:b${secret}`, "example.com/"],
    ["https", `user:%40${secret}`, "example.com/"],
  ];

  test("the user and password of scheme://user:password@host are redacted; the scheme and the host are kept", () => {
    for (const [scheme, userinfo, rest] of withCredentials) {
      const text = url(scheme, userinfo, rest);
      const result = redactSecrets(text);
      expect({ text, redacted: result.text }).toEqual({
        text,
        redacted: `${scheme}://[REDACTED:url-credentials]@${rest}`,
      });
      expect(result.redactions).toEqual([
        { kind: "url-credentials", count: 1 },
      ]);
    }
  });

  test("a URL with credentials is redacted inside a command, a JSON string and Markdown", () => {
    const remote = url("https", `deploy:${secret}`, "example.com/o/r.git");
    for (const [prefix, suffix] of [
      ["git remote set-url origin ", " && git push"],
      ['{"remote":"', '"}'],
      ["[the remote](", ")"],
      ["<", ">"],
    ]) {
      const text = `${prefix}${remote}${suffix}`;
      const result = redactSecrets(text);
      expect({ text, redacted: result.text }).toEqual({
        text,
        redacted: `${prefix}https://[REDACTED:url-credentials]@example.com/o/r.git${suffix}`,
      });
    }
  });

  test("a fine-grained token used as the password of a remote URL does not survive", () => {
    for (const token of FINE_GRAINED_TOKENS) {
      const text = url("https", `x-access-token:${token}`, "github.com/o/r");
      const result = redactSecrets(text);
      expect(result.text).not.toContain(token.slice("github_pat_".length));
      expect(result.redactions.length).toBeGreaterThan(0);
    }
  });

  test("an ordinary URL, an scp-style remote, a URL with a user but no password, and a colon or @ outside the userinfo are left alone", () => {
    for (const text of [
      "https://host/path",
      "https://example.com:8443/a/b?x=1#frag",
      "git@github.com:owner/repo",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "ssh://git@github.com:22/owner/repo.git",
      "https://user@example.com/path",
      "https://token@github.com/owner/repo",
      "https://user:@example.com/path",
      "https://example.com/login?next=a:b@c",
      "https://example.com/people/me:work@home",
      "https://example.com#a:b@c",
      "http://[::1]:8080/path",
      "mailto:someone@example.com",
      "see https://example.com:8443, or write to someone@example.com",
      "the form is scheme://host:port/path",
    ]) {
      expect(redactSecrets(text)).toEqual({ text, redactions: [] });
    }
  });

  test("a redacted URL scanned again finds nothing more", () => {
    for (const [scheme, userinfo, rest] of withCredentials) {
      const once = redactSecrets(url(scheme, userinfo, rest)).text;
      expect(redactSecrets(once)).toEqual({ text: once, redactions: [] });
    }
  });
});

describe("private keys", () => {
  test("a key with its BEGIN and END lines is redacted whole, and the text around it is kept", () => {
    for (const type of KEY_TYPES) {
      expect(redactSecrets(`before\n${keyBlock(type)}\nafter`)).toEqual({
        text: "before\n[REDACTED:private-key]\nafter",
        redactions: [{ kind: "private-key", count: 1 }],
      });
    }
  });

  test("a key with a BEGIN line but no END line is redacted from that line to the end of the text", () => {
    for (const type of KEY_TYPES) {
      for (const cut of [
        [beginLine(type), ...KEY_BODY].join("\n"),
        [beginLine(type), KEY_BODY[0]].join("\n"),
        beginLine(type),
      ]) {
        const text = `before\n${cut}`;
        expect({ text, result: redactSecrets(text) }).toEqual({
          text,
          result: {
            text: "before\n[REDACTED:private-key]",
            redactions: [{ kind: "private-key", count: 1 }],
          },
        });
      }
    }
  });

  test("a key with an END line but no BEGIN line is redacted from the start of the text to that line", () => {
    for (const type of KEY_TYPES) {
      const text = [...KEY_BODY, endLine(type), "after"].join("\n");
      expect({ type, result: redactSecrets(text) }).toEqual({
        type,
        result: {
          text: "[REDACTED:private-key]\nafter",
          redactions: [{ kind: "private-key", count: 1 }],
        },
      });
    }
  });

  test("an END line after a whole key is redacted back to where that key ended", () => {
    const text = [
      keyBlock("RSA "),
      "between",
      KEY_BODY[1],
      endLine("RSA "),
      "after",
    ].join("\n");
    const result = redactSecrets(text);
    expect(keepsBody(result.text)).toBe(false);
    expect(result.text).not.toContain("between");
    expect(result.text.endsWith("\nafter")).toBe(true);
    expect(result.redactions).toEqual([{ kind: "private-key", count: 2 }]);
  });

  test("a provider variable assigned directly before a key block leaves none of the key behind", () => {
    for (const type of KEY_TYPES) {
      for (const assigned of ["OPENAI_API_KEY=", "ANTHROPIC_API_KEY: "]) {
        const result = redactSecrets(`${assigned}${keyBlock(type)}\nafter`);
        expect({ type, assigned, kept: keepsBody(result.text) }).toEqual({
          type,
          assigned,
          kept: false,
        });
        expect(result.text).not.toContain("PRIVATE KEY");
        expect(result.text.endsWith("\nafter")).toBe(true);
      }
    }
  });
});

describe("scanning time", () => {
  const unterminated: ReadonlyArray<[string, string]> = [
    ["RSA BEGIN lines", `${beginLine("RSA ")}\n`],
    [
      "BEGIN lines each followed by a body line",
      `${beginLine("")}\n${KEY_BODY[0]}\n`,
    ],
    [
      "BEGIN lines of every key type",
      KEY_TYPES.map((type) => `${beginLine(type)}\n`).join(""),
    ],
  ];
  for (const [name, line] of unterminated) {
    test(`a megabyte of ${name} with no END line is scanned in well under a second and redacted whole`, () => {
      const { ms, result } = timed(repeatedTo(line, MEGABYTE));
      expect(ms).toBeLessThan(SCAN_BUDGET_MS);
      expect(result).toEqual({
        text: "[REDACTED:private-key]",
        redactions: [{ kind: "private-key", count: 1 }],
      });
    });
  }

  const otherShapes: ReadonlyArray<[string, string]> = [
    ["END lines with no BEGIN line", `${endLine("RSA ")}\n`],
    ["URLs with a user and a colon but no @", "https://user:pass"],
    ["URLs with an empty user and a colon but no @", "a://:"],
    ["URLs with credentials, back to back", "x://u:p@"],
    ["github_pat_ prefixes", "github_pat_"],
  ];
  for (const [name, line] of otherShapes) {
    test(`a megabyte of ${name} is scanned in well under a second`, () => {
      expect(timed(repeatedTo(line, MEGABYTE)).ms).toBeLessThan(SCAN_BUDGET_MS);
    });
  }
});

describe("where the secrets are", () => {
  /** `text` with each span written over by the marker `redactSecrets` writes for its kind. */
  function written(text: string, spans: readonly SecretSpan[]): string {
    let out = "";
    let kept = 0;
    for (const span of spans) {
      out += `${text.slice(kept, span.start)}[REDACTED:${span.kind}]`;
      kept = span.end;
    }
    return out + text.slice(kept);
  }

  /** A small seeded generator, so a failure names a text that can be made again. */
  function seeded(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  const PROVIDER = ["OPENAI", "API", "KEY"].join("_");
  /** Pieces a text is put together from: keys, names, signs, markers, invisible characters. */
  const PIECES: readonly string[] = [
    ...KEYS,
    CLASSIC_TOKEN,
    ...FINE_GRAINED_TOKENS,
    ["AKIA", "ZQ9ZQ8ZQ7ZQ6ZQ5Z"].join(""),
    ["xoxb", "Zq9Zq8Zq7Zq6"].join("-"),
    PROVIDER,
    "=",
    ": ",
    '"',
    " ",
    "\n",
    "​",
    "﻿",
    "-",
    "task-",
    SLUG_BODY,
    "https://",
    "user:Zq9Zq8Zq7@",
    "example.com/",
    beginLine("RSA "),
    endLine("RSA "),
    endLine(""),
    ...KEY_BODY,
    "[REDACTED:openai-api-key]",
    "plain words",
  ];

  test("the spans, written over with their markers, give exactly what redactSecrets gives, in the text's own positions", () => {
    const corpus = [
      ...PREFIXES.flatMap(([, prefix]) =>
        KEYS.map((key) => `${prefix}${key} trailing`),
      ),
      ...SLUGS,
      ...FINE_GRAINED_TOKENS.map((token) => `GH_TOKEN=${token}\n`),
      `token ${CLASSIC_TOKEN}`,
      ...KEY_TYPES.map((type) => `before\n${keyBlock(type)}\nafter`),
      [keyBlock("RSA "), "between", KEY_BODY[1], endLine("RSA "), "after"].join(
        "\n",
      ),
      `${PROVIDER}=${keyBlock("")}\nafter`,
      `https://user:${"Zq9".repeat(6)}@example.com/x`,
    ];
    const random = seeded(7);
    for (let i = 0; i < 3000; i++) {
      const count = 1 + Math.floor(random() * 8);
      corpus.push(
        Array.from(
          { length: count },
          () => PIECES[Math.floor(random() * PIECES.length)],
        ).join(""),
      );
    }
    let found = 0;
    for (const text of corpus) {
      const spans = secretSpans(text);
      found += spans.length;
      for (const [index, span] of spans.entries()) {
        expect(span.start).toBeLessThan(span.end);
        expect(span.start).toBeGreaterThanOrEqual(spans[index - 1]?.end ?? 0);
        expect(span.end).toBeLessThanOrEqual(text.length);
      }
      expect({ text, written: written(text, spans) }).toEqual({
        text,
        written: redactSecrets(text).text,
      });
    }
    // The corpus is not mostly clean text: most of it holds something to find.
    expect(found).toBeGreaterThan(corpus.length);
  });

  test("a text with nothing to find has no spans; a key inside other text is found where it is", () => {
    expect(secretSpans("nothing to see here")).toEqual([]);
    const text = `the key is ${OPENAI} for now`;
    expect(secretSpans(text)).toEqual([
      {
        kind: "openai-api-key",
        start: "the key is ".length,
        end: "the key is ".length + OPENAI.length,
      },
    ]);
  });

  test("a megabyte of keys back to back is located in well under a second", () => {
    const text = repeatedTo(`${OPENAI} `, MEGABYTE);
    const started = performance.now();
    const spans = secretSpans(text);
    expect(performance.now() - started).toBeLessThan(SCAN_BUDGET_MS * 4);
    expect(spans.length).toBe(Math.ceil(MEGABYTE / (OPENAI.length + 1)));
  });
});
