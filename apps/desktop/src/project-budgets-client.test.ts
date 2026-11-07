import { expect, test } from "bun:test";
import {
  parseProjectBudgetText,
  projectBudgetsSpec,
} from "./project-budgets-client";

test("budget text permits blank and completed sub-dollar values while rejecting incomplete or invalid caps", () => {
  expect(projectBudgetsSpec.parse(undefined)).toEqual({
    shiftSpendCapUsd: null,
    dailyApiKeyCapUsd: null,
  });
  expect(
    parseProjectBudgetText({ shiftSpendCapUsd: "0", dailyApiKeyCapUsd: "" })
      .success,
  ).toBe(false);
  expect(
    parseProjectBudgetText({ shiftSpendCapUsd: "0.", dailyApiKeyCapUsd: "" })
      .success,
  ).toBe(false);
  expect(
    parseProjectBudgetText({
      shiftSpendCapUsd: "0.01",
      dailyApiKeyCapUsd: ".000001",
    }),
  ).toMatchObject({
    success: true,
    data: { shiftSpendCapUsd: 0.01, dailyApiKeyCapUsd: 0.000001 },
  });
  expect(
    parseProjectBudgetText({ shiftSpendCapUsd: "", dailyApiKeyCapUsd: "" }),
  ).toMatchObject({
    success: true,
    data: { shiftSpendCapUsd: null, dailyApiKeyCapUsd: null },
  });
  for (const value of ["-1", "NaN", "0.0000001", "1000001", "1e8"])
    expect(
      parseProjectBudgetText({ shiftSpendCapUsd: value, dailyApiKeyCapUsd: "" })
        .success,
    ).toBe(false);
});
