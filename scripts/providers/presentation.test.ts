import { expect, test } from "bun:test";
import {
  providerReportStale,
  providerUsageLabel,
} from "../../apps/desktop/src/providers-model";
import { normalizeUsageWindow } from "./readiness";
import { providerReadinessFixture } from "./testing";

test("usage summaries retain a partial API balance and real zero without inventing percentage or allowance from local tokens", () => {
  const provider = providerReadinessFixture(
    "/fixture",
    "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  ).providers[0];
  if (!provider) throw Error("Missing fixture provider");
  const report = normalizeUsageWindow(
    {
      id: "balance",
      label: "API credit balance",
      kind: "api-balance",
      unit: "usd",
      basis: "remaining",
      value: 20,
      total: null,
      observedAt: new Date().toISOString(),
      resetAt: null,
      durationMs: null,
      source: "provider-api",
      reason: null,
    },
    Date.now(),
  );
  expect(providerUsageLabel({ ...provider, usage: [report] })).toBe(
    "API credit balance: $20.00 remaining",
  );
  expect(
    providerUsageLabel({
      ...provider,
      usage: [
        { ...report, remaining: 0, reported: { ...report.reported, value: 0 } },
      ],
    }),
  ).toBe("API credit balance: $0.00 remaining");
  expect(
    providerUsageLabel({
      ...provider,
      usage: [{ ...report, kind: "local-counted", unit: "tokens", used: 1000 }],
    }),
  ).toBe("Usage — not reported");
  expect(providerUsageLabel(undefined)).toBe("Usage — not reported");
});

test("cached reports become visibly stale by age even without a failed refresh", () => {
  const data = providerReadinessFixture(
    "/fixture",
    "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  );
  expect(providerReportStale(data, Date.parse(data.asOf) + 31000)).toBe(true);
  expect(providerReportStale(data, Date.parse(data.asOf) + 5000)).toBe(false);
  expect(providerReportStale(data, Date.parse(data.asOf) - 6000)).toBe(true);
  expect(providerReportStale(null, Date.now())).toBe(false);
});
