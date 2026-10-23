import { expect, test } from "bun:test";
import { claudeAccountReports } from "../sessions/claude-account";
import { projectClaudeUsage } from "./owned-usage";

const observedAt = "2026-10-23T08:00:00Z",
  version = "2.1.293";
function report(percent: number, extra: Record<string, unknown> = {}) {
  return claudeAccountReports({
    version,
    observedAt,
    value: {
      type: "assistant",
      usage_report: {
        rate_limits: {
          limits: [
            {
              kind: "weekly",
              group: "Plan",
              percent,
              resets_at: "2026-10-24T08:00:00Z",
              is_active: true,
              ...extra,
            },
          ],
        },
      },
    },
  });
}
test("owned native usage reports retain exact percent, reset and provenance; ambiguous numeric rate-limit fields are never percentages", () => {
  const projected = projectClaudeUsage(report(75), { version, after: null });
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({
    kind: "subscription-window",
    unit: "percent",
    basis: "used",
    value: 75,
    total: 100,
    resetAt: "2026-10-24T08:00:00Z",
    durationMs: null,
    observedAt,
    source: "provider-cli",
  });
  expect(projected[0]?.reason).toContain("private session");
  expect(
    projectClaudeUsage(
      claudeAccountReports({
        version,
        observedAt,
        value: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            utilization: 0.75,
            resetsAt: 123,
          },
        },
      }),
      { version, after: null },
    ),
  ).toEqual([]);
});
test("new sign-in, version change, inactive and explicit missing newer reports cannot reuse older account allowance", () => {
  const original = report(75);
  expect(
    projectClaudeUsage(original, { version: "2.1.296", after: null }),
  ).toEqual([]);
  expect(
    projectClaudeUsage(original, { version, after: "2026-10-23T08:00:01Z" }),
  ).toEqual([]);
  expect(
    projectClaudeUsage(report(100, { is_active: false }), {
      version,
      after: null,
    }),
  ).toEqual([]);
  expect(
    projectClaudeUsage(report(100, { is_active: null }), {
      version,
      after: null,
    }),
  ).toEqual([]);
  const missing = claudeAccountReports({
    version,
    observedAt: "2026-10-23T08:00:01Z",
    value: { type: "assistant", usage_report: { rate_limits: null } },
  });
  expect(
    projectClaudeUsage([...original, ...missing], { version, after: null }),
  ).toEqual([]);
});
