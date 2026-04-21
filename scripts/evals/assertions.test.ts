import { describe, expect, test } from "bun:test";
import {
  checkVerdictMatchesFixture,
  checkVerdictMatchesSchema,
  parseFixtureExpectation,
} from "./assertions";

const pass = JSON.stringify({
  schemaVersion: 1,
  taskId: "eval-fixture-pass",
  verdict: "PASS",
  findings: { blocker: 0, high: 0, medium: 0, low: 0 },
});

const failBlocker = JSON.stringify({
  schemaVersion: 1,
  taskId: "eval-fixture-fail-blocker",
  verdict: "FAIL",
  findings: { blocker: 2, high: 0, medium: 1, low: 0 },
});

const failMediumOnly = JSON.stringify({
  schemaVersion: 1,
  taskId: "eval-fixture-fail-medium-only",
  verdict: "FAIL",
  findings: { blocker: 0, high: 0, medium: 3, low: 1 },
});

describe("parseFixtureExpectation", () => {
  test("accepts exact + min forms", () => {
    const e = parseFixtureExpectation('{"verdict":"FAIL","blocker":0,"high":0,"medium_min":1}');
    expect(e?.verdict).toBe("FAIL");
    expect(e?.blocker).toBe(0);
    expect(e?.medium_min).toBe(1);
  });
  test("rejects bad verdict", () => {
    expect(parseFixtureExpectation('{"verdict":"???"}')).toBeNull();
  });
  test("rejects non-integer field", () => {
    expect(parseFixtureExpectation('{"verdict":"PASS","blocker":1.5}')).toBeNull();
  });
});

describe("checkVerdictMatchesSchema", () => {
  test("passes valid verdict", () => {
    expect(checkVerdictMatchesSchema(pass).pass).toBe(true);
  });
  test("fails malformed", () => {
    const r = checkVerdictMatchesSchema("{ not json");
    expect(r.pass).toBe(false);
  });
});

describe("checkVerdictMatchesFixture", () => {
  test("PASS matches expected", () => {
    const r = checkVerdictMatchesFixture(pass, {
      vars: {
        task_id: "eval-fixture-pass",
        fixture_expected: '{"verdict":"PASS","blocker":0,"high":0}',
      },
    });
    expect(r.pass).toBe(true);
  });

  test("rejects taskId mismatch", () => {
    const r = checkVerdictMatchesFixture(pass, {
      vars: {
        task_id: "different-id",
        fixture_expected: '{"verdict":"PASS","blocker":0,"high":0}',
      },
    });
    expect(r.pass).toBe(false);
  });

  test("FAIL with blocker_min is satisfied when blocker>=1", () => {
    const r = checkVerdictMatchesFixture(failBlocker, {
      vars: {
        task_id: "eval-fixture-fail-blocker",
        fixture_expected: '{"verdict":"FAIL","blocker_min":1}',
      },
    });
    expect(r.pass).toBe(true);
  });

  test("FAIL medium-only fixture rejects blocker>0", () => {
    const wrong = JSON.stringify({
      schemaVersion: 1,
      taskId: "eval-fixture-fail-medium-only",
      verdict: "FAIL",
      findings: { blocker: 1, high: 0, medium: 3, low: 0 },
    });
    const r = checkVerdictMatchesFixture(wrong, {
      vars: {
        task_id: "eval-fixture-fail-medium-only",
        fixture_expected: '{"verdict":"FAIL","blocker":0,"high":0,"medium_min":1}',
      },
    });
    expect(r.pass).toBe(false);
  });

  test("FAIL medium-only fixture matches exact zeros + medium>=1", () => {
    const r = checkVerdictMatchesFixture(failMediumOnly, {
      vars: {
        task_id: "eval-fixture-fail-medium-only",
        fixture_expected: '{"verdict":"FAIL","blocker":0,"high":0,"medium_min":1}',
      },
    });
    expect(r.pass).toBe(true);
  });
});
