import { describe, expect, test } from "bun:test";
import { ulid } from "./ulid";

describe("ulid", () => {
  test("ulids minted in one millisecond sort in mint order", () => {
    const frozen = Date.UTC(2026, 9, 7, 12, 0, 0);
    const ids = Array.from({ length: 1000 }, () => ulid(frozen));
    expect(new Set(ids).size).toBe(1000);
    for (let i = 1; i < ids.length; i++) {
      expect((ids[i] ?? "") > (ids[i - 1] ?? "")).toBe(true);
    }
  });

  test("a ulid is 26 Crockford characters", () => {
    for (let i = 0; i < 100; i++) {
      expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  test("a later millisecond sorts after an earlier one", () => {
    const base = Date.now() + 1000;
    const earlier = ulid(base);
    const later = ulid(base + 1);
    expect(later > earlier).toBe(true);
    expect(later.slice(0, 10)).not.toBe(earlier.slice(0, 10));
  });
});
