import { expect, test } from "bun:test";
import { providerReadinessPageSchema } from "../../../scripts/providers/protocol";
import {
  buildProviderReadiness,
  normalizeUsageWindow,
} from "../../../scripts/providers/readiness";
import {
  type ProviderReadinessPage,
  type ProviderUsageReport,
  READINESS_PROVIDERS,
} from "../../../types/provider-readiness";
import {
  discoverUsageThresholdReports,
  type UsageThresholdReportsInput,
} from "./usage-threshold-report-discovery";

const now = Date.parse("2026-11-11T12:00:00.000Z");
const stamp = new Date(now).toISOString();
const workspace = "/workspace";
const report: ProviderUsageReport = {
  id: "native-positional-0",
  label: "five-hour window",
  kind: "subscription-window",
  unit: "percent",
  basis: "used",
  value: 80,
  total: 100,
  observedAt: stamp,
  resetAt: new Date(now + 3600000).toISOString(),
  durationMs: null,
  source: "provider-cli",
  reason: "private provider reason",
};
function page(
  reports: readonly ProviderUsageReport[] = [report],
): ProviderReadinessPage {
  return providerReadinessPageSchema.parse({
    workspace,
    asOf: stamp,
    problems: [],
    providers: READINESS_PROVIDERS.map((provider) =>
      buildProviderReadiness(
        {
          provider,
          name: provider,
          installation: {
            found: true,
            versionOk: true,
            version: "1.0.0",
            path: "C:/private/cli.exe",
            checkedAt: stamp,
            compatibility: "supported",
            reason: null,
          },
          authentication: {
            mode: "signed-in",
            source: "provider-cli",
            observedAt: stamp,
            reason: null,
          },
          adapter: { supported: true, reason: null },
          signIn: {
            command: "private command",
            reason: "private signin",
            nativeAvailable: false,
          },
          reports: provider === "claude" ? reports : [],
          smiths: [],
        },
        now,
      ),
    ),
    localUsage: {
      since: stamp,
      through: stamp,
      source: "local-ledger",
      reason: "private local totals",
      projects: [],
    },
  });
}
function input(data: unknown = page()): UsageThresholdReportsInput {
  return { data, loading: false, failed: false, stale: false, now };
}
test("controls use complete five-provider schemas and actual normalized reported measures", () => {
  const actual = page();
  expect(actual.providers).toHaveLength(5);
  expect(actual.providers[0]?.usage[0]?.reported.value).toBe(80);
  expect(actual.providers[0]?.usage[0]?.remaining).toBe(20);
  expect(
    normalizeUsageWindow({ ...report, value: 0 }, now).reported.value,
  ).toBe(0);
});
test("a fresh exact reported field produces one immutable semantic selection", () => {
  const actual = page();
  const result = discoverUsageThresholdReports(workspace, input(actual));
  expect(result.choices).toHaveLength(1);
  expect(result.status).toBe("ready");
  expect(result.choices[0]).toMatchObject({
    provider: "claude",
    value: 80,
    total: 100,
    observedAt: stamp,
    resetAt: report.resetAt,
    selector: {
      kind: "subscription-window",
      unit: "percent",
      source: "provider-cli",
      label: report.label,
      basis: "used",
    },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /private|cli.exe|native-positional/,
  );
});

test("zero, remaining and API balance use reported quantities without converting derived measures", () => {
  for (const patch of [
    { value: 0 },
    { value: 80, basis: "remaining" as const },
    {
      value: 12.5,
      basis: "remaining" as const,
      unit: "usd" as const,
      kind: "api-balance" as const,
      source: "provider-api" as const,
      total: null,
      resetAt: null,
    },
  ]) {
    const raw = { ...report, ...patch },
      choice = discoverUsageThresholdReports(workspace, input(page([raw])))
        .choices[0];
    expect(choice?.value).toBe(raw.value);
    expect(choice?.selector.basis).toBe(raw.basis);
    expect(choice?.selector.unit).toBe(raw.unit);
    expect(choice?.total).toBe(raw.total);
  }
  const unknown = discoverUsageThresholdReports(
    workspace,
    input(page([{ ...report, value: null }])),
  );
  expect(unknown.choices).toHaveLength(0);
  expect(unknown.status).toBe("partial");
  expect(unknown.message).toContain("Missing usage is not zero");
});
test("captured page scope, completeness, clock and read states fail closed with fixed diagnostics", () => {
  for (const flags of [
    { loading: true },
    { failed: true },
    { stale: true },
    { now: NaN },
    { now: now - 1 },
    { now: now + 30001 },
  ]) {
    expect(
      discoverUsageThresholdReports(workspace, { ...input(), ...flags })
        .choices,
    ).toHaveLength(0);
  }
  expect(discoverUsageThresholdReports("/other", input()).status).toBe(
    "unavailable",
  );
  const wrong = page();
  wrong.providers.pop();
  expect(discoverUsageThresholdReports(workspace, input(wrong)).status).toBe(
    "unavailable",
  );
  const problems = page();
  problems.problems = ["private diagnostic"];
  const rejected = discoverUsageThresholdReports(workspace, input(problems));
  expect(rejected.status).toBe("unavailable");
  expect(JSON.stringify(rejected)).not.toContain("private");
  const windows = page();
  windows.workspace = "C:\\Workspace\\";
  expect(
    discoverUsageThresholdReports("c:/workspace", input(windows)).choices,
  ).toHaveLength(1);
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("private getter body");
      },
    },
  );
  const hidden = discoverUsageThresholdReports(workspace, input(hostile));
  expect(hidden.status).toBe("unavailable");
  expect(JSON.stringify(hidden)).not.toContain("private");
});
test("duplicate semantic windows are counted before stale and unknown filtering", () => {
  for (const unusable of ["stale", "unknown"]) {
    const actual = page(),
      provider = actual.providers[0]!;
    const duplicate = normalizeUsageWindow(
      {
        ...report,
        id: "different-positional-id",
        ...(unusable === "unknown" ? { value: null } : {}),
      },
      now,
    );
    if (unusable === "stale") duplicate.stale = true;
    provider.usage.push(duplicate);
    expect(
      providerReadinessPageSchema.parse(actual).providers[0]?.usage,
    ).toHaveLength(2);
    const result = discoverUsageThresholdReports(workspace, input(actual));
    expect(result.choices).toHaveLength(0);
    expect(result.status).toBe("partial");
  }
  const first = page([report, { ...report, label: "second window" }]);
  const second = structuredClone(first);
  second.providers[0]?.usage.reverse();
  expect(discoverUsageThresholdReports(workspace, input(first))).toEqual(
    discoverUsageThresholdReports(workspace, input(second)),
  );
  expect(
    discoverUsageThresholdReports(workspace, input(first)).choices,
  ).toHaveLength(2);
});
test("stale providers, future or aged observations and missing or expired resets cannot become choices", () => {
  for (const kind of ["subscription-window", "api-balance"] as const) {
    const actual = page([
      { ...report, kind, resetAt: new Date(now - 1).toISOString() },
    ]);
    actual.providers[0]!.usage[0]!.stale = false;
    expect(
      discoverUsageThresholdReports(workspace, input(actual)).choices,
    ).toHaveLength(0);
  }
  for (const patch of [
    { resetAt: null },
    { observedAt: new Date(now + 1).toISOString() },
    { observedAt: new Date(now - 60001).toISOString() },
  ]) {
    const actual = page([{ ...report, ...patch }]);
    actual.providers[0]!.usage[0]!.stale = false;
    expect(
      discoverUsageThresholdReports(workspace, input(actual)).choices,
    ).toHaveLength(0);
  }
  const staleProvider = page();
  staleProvider.providers[0]!.stale = true;
  expect(
    discoverUsageThresholdReports(workspace, input(staleProvider)).choices,
  ).toHaveLength(0);
});
test("every normalized measure including reported total must agree with the actual source", () => {
  for (const field of [
    "used",
    "remaining",
    "total",
    "percentUsed",
    "durationMs",
  ] as const) {
    const actual = page();
    actual.providers[0]!.usage[0]![field] = field === "durationMs" ? 0 : 1;
    expect(
      discoverUsageThresholdReports(workspace, input(actual)).choices,
    ).toHaveLength(0);
  }
  for (const total of [0, 99]) {
    const actual = page();
    actual.providers[0]!.usage[0]!.reported.total = total;
    expect(
      discoverUsageThresholdReports(workspace, input(actual)).choices,
    ).toHaveLength(0);
  }
  const excessive = page();
  excessive.providers[0]!.usage[0]!.reported.value = 101;
  expect(
    discoverUsageThresholdReports(workspace, input(excessive)).choices,
  ).toHaveLength(0);
  expect(
    discoverUsageThresholdReports(
      workspace,
      input(page([{ ...report, total: null, value: 101 }])),
    ).choices,
  ).toHaveLength(0);
});
test("local counts and unsupported sources do not become allowance fields; partial valid fields remain descriptive", () => {
  for (const source of [
    "local-ledger",
    "configuration",
    "unavailable",
  ] as const)
    expect(
      discoverUsageThresholdReports(
        workspace,
        input(page([{ ...report, source }])),
      ).choices,
    ).toHaveLength(0);
  const locals = discoverUsageThresholdReports(
    workspace,
    input(
      page([
        {
          ...report,
          kind: "local-counted",
          source: "local-ledger",
          resetAt: null,
        },
      ]),
    ),
  );
  expect(locals.status).toBe("empty");
  expect(locals.choices).toHaveLength(0);
  expect(locals.message).toContain("not assumed to be zero");
  const partial = discoverUsageThresholdReports(
    workspace,
    input(
      page([
        report,
        { ...report, label: "unknown second window", value: null },
      ]),
    ),
  );
  expect(partial.status).toBe("partial");
  expect(partial.choices).toHaveLength(1);
});
test("all 160 actual windows are preserved and excess input is rejected without truncation", () => {
  const actual = page([]);
  for (const provider of actual.providers)
    provider.usage = Array.from({ length: 32 }, (_, i) =>
      normalizeUsageWindow(
        { ...report, id: "position-" + i, label: "window-" + i },
        now,
      ),
    );
  const complete = discoverUsageThresholdReports(workspace, input(actual));
  expect(complete.choices).toHaveLength(160);
  expect(new Set(complete.choices.map((row) => row.key)).size).toBe(160);
  actual.providers[0]!.usage.push(
    normalizeUsageWindow({ ...report, label: "window-extra" }, now),
  );
  const excess = discoverUsageThresholdReports(workspace, input(actual));
  expect(excess.status).toBe("unavailable");
  expect(excess.choices).toHaveLength(0);
});
test("capture is deeply frozen and private fields cannot follow caller mutation", () => {
  const actual = page(),
    discovered = discoverUsageThresholdReports(workspace, input(actual));
  actual.providers[0]!.usage[0]!.label = "later private label";
  actual.providers[0]!.usage[0]!.reported.value = 1;
  expect(discovered.choices[0]?.selector.label).toBe(report.label);
  expect(discovered.choices[0]?.value).toBe(80);
  expect(Object.isFrozen(discovered)).toBe(true);
  expect(Object.isFrozen(discovered.choices)).toBe(true);
  expect(Object.isFrozen(discovered.choices[0])).toBe(true);
  expect(Object.isFrozen(discovered.choices[0]?.selector)).toBe(true);
  expect(JSON.stringify(discovered)).not.toMatch(
    /private|cli.exe|native-positional|local-ledger/,
  );
});
