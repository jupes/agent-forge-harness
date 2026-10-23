import { expect, test } from "bun:test";
import { eventSchema } from "../conversations/protocol";
import {
  claudeAccountReportSchema,
  claudeAccountReports,
  latestClaudeAccountReports,
} from "./claude-account";

const options = { version: "2.1.296", observedAt: "2026-10-23T07:30:00.000Z" };
test("actual Claude auth source and allowance reports retain literal provenance without guessing auth state or reset units", () => {
  const auth = claudeAccountReports({
    ...options,
    value: {
      type: "system",
      subtype: "init",
      apiKeySource: "none",
      apiKey: "never retain",
      uuid: "init",
    },
  });
  expect(auth).toMatchObject([
    {
      kind: "coding-account",
      source: "claude.system.init",
      report: { apiKeySource: "none" },
    },
  ]);
  expect(JSON.stringify(auth)).not.toContain("never retain");
  const rate = claudeAccountReports({
    ...options,
    value: {
      type: "rate_limit_event",
      uuid: "rate",
      rate_limit_info: {
        status: "rejected",
        utilization: 1,
        resetsAt: 123,
        errorCode: "credits_required",
        canUserPurchaseCredits: false,
      },
    },
  });
  expect(rate).toMatchObject([
    {
      source: "claude.rate_limit_event",
      observedAt: options.observedAt,
      report: {
        status: "rejected",
        utilization: 1,
        resetsAt: 123,
        resetUnit: "unreported",
        errorCode: "credits_required",
        canUserPurchaseCredits: false,
      },
    },
  ]);
  expect(eventSchema.safeParse(rate[0]).success).toBe(false);
  const status = claudeAccountReports({
    ...options,
    value: {
      type: "auth_status",
      uuid: "auth",
      isAuthenticating: false,
      error: "private login URL",
      output: ["private code"],
    },
  });
  expect(status).toMatchObject([
    {
      source: "claude.auth_status",
      report: { isAuthenticating: false, hasError: true, outputOmitted: true },
    },
  ]);
  expect(JSON.stringify(status)).not.toContain("private");
});
test("reported account windows keep unknown versus empty, exact ISO resets, scope and credits distinct from local cost estimates", () => {
  const value = {
    type: "assistant",
    uuid: "usage",
    usage_report: {
      session: { total_cost_usd: 12 },
      rate_limits: {
        limits: [
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 73,
            resets_at: "2026-10-30T08:00:00Z",
            scope: { model: { display_name: "Actual reported model" } },
            severity: "warning",
            is_active: true,
          },
        ],
        extra_usage: {
          is_enabled: true,
          monthly_limit: null,
          used_credits: 42,
          utilization: 12,
          currency: "USD",
        },
      },
    },
  };
  const reports = claudeAccountReports({ ...options, value });
  expect(reports).toMatchObject([
    {
      source: "claude.usage_report",
      report: { rate_limits: value.usage_report.rate_limits },
    },
  ]);
  expect(JSON.stringify(reports)).not.toContain("total_cost_usd");
  const absent = claudeAccountReports({
    ...options,
    value: { ...value, usage_report: { rate_limits: null } },
  });
  const empty = claudeAccountReports({
    ...options,
    value: { ...value, usage_report: { rate_limits: { limits: [] } } },
  });
  expect(JSON.stringify(absent)).not.toBe(JSON.stringify(empty));
  expect(
    claudeAccountReports({
      ...options,
      value: { type: "result", result: "quota exhausted resets tomorrow" },
    }),
  ).toEqual([]);
  expect(() =>
    claudeAccountReports({
      ...options,
      value: {
        ...value,
        usage_report: {
          rate_limits: {
            limits: [
              {
                ...value.usage_report.rate_limits.limits[0],
                resets_at: "tomorrow",
              },
            ],
          },
        },
      },
    }),
  ).toThrow("protocol");
  expect(
    claudeAccountReportSchema.safeParse({
      ...reports[0],
      transcript: "not metadata",
    }).success,
  ).toBe(false);
});
test("latest factual report projection returns only typed metadata and never private transcript or auth-flow output", () => {
  const first = claudeAccountReports({
    ...options,
    value: {
      type: "rate_limit_event",
      uuid: "a",
      rate_limit_info: { status: "allowed" },
    },
  });
  const second = claudeAccountReports({
    ...options,
    value: {
      type: "rate_limit_event",
      uuid: "b",
      rate_limit_info: { status: "allowed_warning" },
    },
  });
  const projected = latestClaudeAccountReports([
    { event: first[0] },
    { event: { kind: "text", text: "private transcript" } },
    { event: second[0] },
  ]);
  expect(projected.rateLimit?.report).toMatchObject({
    status: "allowed_warning",
  });
  expect(JSON.stringify(projected)).not.toContain("private");
  expect(projected.authSource).toBe(null);
  expect(projected.usage).toBe(null);
  expect(() =>
    latestClaudeAccountReports([
      { event: first[0] },
      { event: { ...second[0], observedAt: "invalid" } },
    ]),
  ).toThrow("protocol");
});
