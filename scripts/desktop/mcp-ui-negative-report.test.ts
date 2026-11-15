import { expect, test } from "bun:test";
import { qualifyIntegrationUiNegativeReport } from "./mcp-ui-negative-report";

const cases = [
  [
    "browser integration controls stay unavailable without native authority",
    "toBeDisabled Review Claude Code registration",
  ],
  [
    "integration review and Cancel are inert; keyboard confirmation sends one approval and publication",
    "toBeVisible Confirm Claude Code registration",
  ],
  [
    "lost integration response survives reload and only original recovery can resolve it",
    "toBeVisible Forge configuration confirmed",
  ],
  [
    "integration review labels and keyboard targets fit desktop minimum in Light and dark",
    "toBe 2px 0px",
  ],
] as const;
function report() {
  return {
    errors: [],
    suites: [
      {
        specs: cases.map(([title, message]) => ({
          title,
          tests: [
            {
              expectedStatus: "passed",
              results: [
                { status: "failed", error: { message: String(message) } },
              ],
            },
          ],
        })),
      },
    ],
  };
}
test("only all four intended browser assertion failures qualify the negative control", () => {
  expect(qualifyIntegrationUiNegativeReport(report(), 1)).toEqual(
    cases.map((x) => x[0]),
  );
});
test("passes, unrelated failures, retries, setup errors and incomplete cases never qualify", () => {
  expect(() => qualifyIntegrationUiNegativeReport(report(), 0)).toThrow();
  const passed = report();
  passed.suites[0]!.specs[0]!.tests[0]!.results[0]!.status = "passed";
  expect(() => qualifyIntegrationUiNegativeReport(passed, 1)).toThrow();
  const unrelated = report();
  unrelated.suites[0]!.specs[0]!.tests[0]!.results[0]!.error.message =
    "setup failed";
  expect(() => qualifyIntegrationUiNegativeReport(unrelated, 1)).toThrow();
  const retry = report();
  retry.suites[0]!.specs[0]!.tests[0]!.results.push({
    ...retry.suites[0]!.specs[0]!.tests[0]!.results[0]!,
  });
  expect(() => qualifyIntegrationUiNegativeReport(retry, 1)).toThrow();
  const missing = report();
  missing.suites[0]!.specs.pop();
  expect(() => qualifyIntegrationUiNegativeReport(missing, 1)).toThrow();
  const duplicate = report();
  duplicate.suites[0]!.specs.push({ ...duplicate.suites[0]!.specs[0]! });
  expect(() => qualifyIntegrationUiNegativeReport(duplicate, 1)).toThrow();
  expect(() =>
    qualifyIntegrationUiNegativeReport(
      { ...report(), errors: [{ message: "global setup" }] },
      1,
    ),
  ).toThrow();
  const timeout = report();
  timeout.suites[0]!.specs[0]!.tests[0]!.results[0]!.status = "timedOut";
  expect(() => qualifyIntegrationUiNegativeReport(timeout, 1)).toThrow();
});

test("colored assertion output retains the exact intended failure markers", () => {
  const colored = report();
  for (const spec of colored.suites[0]!.specs) {
    const error = spec.tests[0]!.results[0]!.error;
    error.message =
      String.fromCharCode(27) +
      "[31m" +
      error.message +
      String.fromCharCode(27) +
      "[0m";
  }
  expect(qualifyIntegrationUiNegativeReport(colored, 1)).toHaveLength(4);
});
