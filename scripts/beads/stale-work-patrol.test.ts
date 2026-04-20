import { describe, expect, test } from "bun:test";
import type { BeadsIssue } from "../../types/beads";
import {
  findStaleActivelyWorked,
  isActivelyWorkedIssue,
  wholeDaysBetween,
} from "./stale-work-patrol";

const base = (over: Partial<BeadsIssue>): BeadsIssue => ({
  id: "x",
  type: "task",
  title: "t",
  status: "open",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-10T00:00:00Z",
  ...over,
});

describe("isActivelyWorkedIssue", () => {
  test("in_progress counts", () => {
    expect(isActivelyWorkedIssue(base({ status: "in_progress" }))).toBe(true);
  });
  test("open with assignee counts", () => {
    expect(isActivelyWorkedIssue(base({ status: "open", assignee: "a" }))).toBe(true);
  });
  test("open without assignee does not", () => {
    expect(isActivelyWorkedIssue(base({ status: "open" }))).toBe(false);
  });
  test("closed does not", () => {
    expect(isActivelyWorkedIssue(base({ status: "closed" }))).toBe(false);
  });
});

describe("wholeDaysBetween", () => {
  test("computes floor days", () => {
    const now = Date.parse("2026-01-12T12:00:00Z");
    expect(wholeDaysBetween("2026-01-10T00:00:00Z", now)).toBe(2);
  });
});

describe("findStaleActivelyWorked", () => {
  test("returns stale in_progress by threshold", () => {
    const now = Date.parse("2026-01-20T00:00:00Z");
    const issues = [
      base({
        id: "a",
        status: "in_progress",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      base({
        id: "b",
        status: "in_progress",
        updatedAt: "2026-01-18T00:00:00Z",
      }),
    ];
    const stale = findStaleActivelyWorked(issues, 7, now);
    expect(stale.map((s) => s.id)).toEqual(["a"]);
  });
});
