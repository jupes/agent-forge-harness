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
 */

import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./secret-patterns";

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
