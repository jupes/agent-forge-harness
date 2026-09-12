import type { ConsoleMessage, Page } from "@playwright/test";

/** Every destination the shell navigates to, with the heading it must show. */
export const ROUTES = [
  { url: "/index.html#/dashboard", heading: "Dashboard" },
  { url: "/index.html#/issues", heading: "All issues" },
  { url: "/index.html#/epics", heading: "Epics" },
  { url: "/index.html#/forge-run", heading: "Forge run" },
  { url: "/index.html#/commands", heading: "Commands" },
  { url: "/index.html#/skill-builder", heading: "Skill builder" },
  { url: "/index.html#/bead-builder", heading: "Bead builder" },
  { url: "/index.html#/insights", heading: "Insights" },
  { url: "/index.html#/repos", heading: "Repos & knowledge" },
  { url: "/plan-review.html", heading: "Plan review" },
  { url: "/council.html", heading: "Council review" },
] as const;

export const NAV_DESTINATION_COUNT = ROUTES.length;

/**
 * Console/page errors the app raises deliberately.
 *
 * Plan review probes whether a plan has a committed baseline by requesting it;
 * a draft-only plan answers 404 and the island renders "no committed baseline".
 * The browser logs the failed request regardless, so it is allowed here — but
 * only this one, and only as a resource-load message.
 */
const EXPECTED = [
  /Failed to load resource.*40[34]/i,
  /plans-api\/raw\?bucket=committed/i,
];

export function isExpectedError(text: string): boolean {
  return EXPECTED.some((pattern) => pattern.test(text));
}

/** Collect real errors from a page, ignoring the deliberate ones above. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    if (isExpectedError(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error: Error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}
