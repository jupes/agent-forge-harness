import { expect, test } from "bun:test";
import { projectShiftAttemptBudgetAllowed } from "./project-budget-policy";
import { projectFixture } from "./testing";

test("missing or archived project ownership refuses as policy rather than reporting a budget stop", () => {
  expect(() =>
    projectShiftAttemptBudgetAllowed(
      undefined,
      { spentUsd: 0, unpriced: 0 },
      5,
    ),
  ).toThrow("project");
  expect(() =>
    projectShiftAttemptBudgetAllowed(
      projectFixture("/served", { archived: true }),
      { spentUsd: 0, unpriced: 0 },
      5,
    ),
  ).toThrow("archived");
});
test("actual project cap refusals stop admission for daily protection, unpriced attempts and exhausted reviewed limits", () => {
  const project = projectFixture("/served", {
    budgets: { shiftSpendCapUsd: 5, dailyApiKeyCapUsd: null },
  });
  expect(
    projectShiftAttemptBudgetAllowed(project, { spentUsd: 0, unpriced: 1 }, 2),
  ).toBe(false);
  expect(
    projectShiftAttemptBudgetAllowed(project, { spentUsd: 2, unpriced: 0 }, 2),
  ).toBe(false);
  expect(
    projectShiftAttemptBudgetAllowed(
      { ...project, budgets: { shiftSpendCapUsd: 1, dailyApiKeyCapUsd: null } },
      { spentUsd: 1, unpriced: 0 },
      2,
    ),
  ).toBe(false);
  expect(
    projectShiftAttemptBudgetAllowed(
      {
        ...project,
        budgets: { shiftSpendCapUsd: null, dailyApiKeyCapUsd: 10 },
      },
      { spentUsd: 0, unpriced: 0 },
      2,
    ),
  ).toBe(false);
  expect(
    projectShiftAttemptBudgetAllowed(
      project,
      { spentUsd: 1.9, unpriced: 0 },
      2,
    ),
  ).toBe(true);
});
