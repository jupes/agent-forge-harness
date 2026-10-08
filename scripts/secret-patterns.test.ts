import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./secret-patterns";

const ANTHROPIC = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";

describe("sk- key patterns", () => {
  test("a slug that merely contains sk- inside a word is left alone", () => {
    for (const text of [
      "task-queue-state-machine-v2",
      "plans/drafts/task-queue-state-machine-v2.md",
      "risk-ant-colony-optimisation-notes-2026",
      "desk-proj-abcdefghijklmnopqrstuvwxyz",
    ]) {
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.redactions).toEqual([]);
    }
  });

  test('a standalone key is redacted at the start of the text and after = " : and whitespace', () => {
    for (const key of [ANTHROPIC, OPENAI]) {
      for (const text of [
        key,
        `TOKEN=${key}`,
        `{"token":"${key}"}`,
        `token:${key}`,
        `the key is ${key} here`,
        `first line\n${key}`,
      ]) {
        const result = redactSecrets(text);
        expect(result.text).not.toContain(key);
        expect(result.text).toContain("[REDACTED:");
      }
    }
  });

  test("the two key kinds keep their own labels", () => {
    expect(redactSecrets(`a ${ANTHROPIC}`).text).toBe(
      "a [REDACTED:anthropic-api-key]",
    );
    expect(redactSecrets(`a ${OPENAI}`).text).toBe(
      "a [REDACTED:openai-api-key]",
    );
  });
});
