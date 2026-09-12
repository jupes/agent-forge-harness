import type { BeadsIssue } from "../../types/beads";

export interface InsightsSummary {
  total: number;
  last7: number;
  avg: number;
  best: { day: string; count: number };
}

export interface InsightsData {
  stats: InsightsSummary;
  series: unknown[];
  types: string[];
  counts: unknown;
}

/** Bucket closed issues into daily counts and summary numbers. Pure. */
export function computeInsights(issues: BeadsIssue[]): InsightsData;

/**
 * Draw both charts into the given canvases, loading Chart.js on demand.
 * Resolves to an error message when a chart could not be drawn, else null.
 */
export function mountInsightCharts(
  canvases: {
    daily: HTMLCanvasElement | null;
    calendar: HTMLCanvasElement | null;
  },
  data: InsightsData,
): Promise<string | null>;

/** Destroy any charts this module created. */
export function destroyInsightCharts(): void;
