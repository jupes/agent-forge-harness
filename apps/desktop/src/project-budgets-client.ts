import {
  NO_PROJECT_BUDGETS,
  type ProjectBudgets,
  projectBudgetsSchema,
} from "../../../scripts/projects/project-budgets-protocol";
import type { ProjectValueSpec } from "./project-value-settings-client";
export const projectBudgetsSpec: ProjectValueSpec<ProjectBudgets> = {
  key: "budgets",
  label: "Project budgets",
  parse: (value) =>
    projectBudgetsSchema.parse(
      value === undefined ? NO_PROJECT_BUDGETS : value,
    ),
};
export function parseProjectBudgetText(text: {
  shiftSpendCapUsd: string;
  dailyApiKeyCapUsd: string;
}) {
  const amount = (value: string) =>
    value.trim() === ""
      ? null
      : /^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(value.trim()) &&
          value.length <= 32
        ? Number(value)
        : Number.NaN;
  return projectBudgetsSchema.safeParse({
    shiftSpendCapUsd: amount(text.shiftSpendCapUsd),
    dailyApiKeyCapUsd: amount(text.dailyApiKeyCapUsd),
  });
}
