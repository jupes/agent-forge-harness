import type { BeadsIssue } from "../../types/beads";

/** HTML for the insights panel; `filterHtml` is injected into its toolbar. */
export function renderInsightsHtml(filterHtml: string): string;

/** Mount the KPI cards and charts into `root`. Chart.js loads on demand. */
export function wireInsights(
  root: HTMLElement,
  data: { issues: BeadsIssue[] } | null,
): Promise<void>;
