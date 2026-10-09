import { expect, test } from "bun:test";
import { tokenMatches } from "./token";

const TOKEN = "a".repeat(64);

test("tokenMatches accepts the exact token and nothing else", () => {
  expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  expect(tokenMatches(TOKEN, `${"a".repeat(63)}b`)).toBe(false);
  expect(tokenMatches(TOKEN, TOKEN.toUpperCase())).toBe(false);
  expect(tokenMatches(TOKEN, ` ${TOKEN}`)).toBe(false);
  expect(tokenMatches(TOKEN, `${TOKEN}\n`)).toBe(false);
});

test("tokenMatches refuses a token of another length without throwing", () => {
  expect(tokenMatches(TOKEN, "a")).toBe(false);
  expect(tokenMatches(TOKEN, "a".repeat(65))).toBe(false);
  expect(tokenMatches(TOKEN, "a".repeat(100_000))).toBe(false);
});

test("tokenMatches refuses when either side is missing, empty or not a string", () => {
  expect(tokenMatches(null, TOKEN)).toBe(false);
  expect(tokenMatches("", "")).toBe(false);
  expect(tokenMatches("", TOKEN)).toBe(false);
  expect(tokenMatches(TOKEN, "")).toBe(false);
  expect(tokenMatches(TOKEN, undefined)).toBe(false);
  expect(tokenMatches(TOKEN, [TOKEN])).toBe(false);
  expect(tokenMatches(TOKEN, [TOKEN, TOKEN])).toBe(false);
});
