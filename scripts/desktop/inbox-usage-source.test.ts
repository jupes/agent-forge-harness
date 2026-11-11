import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type InboxUsageProjectionInput,
  type InboxUsageRulesDocument,
  inboxUsageRulesDocumentSchema,
  projectInboxUsageSource,
} from "../../apps/desktop/src/inbox-usage-source";
import {
  type ProviderReadinessPage,
  type ProviderUsageReport,
  READINESS_PROVIDERS,
} from "../../types/provider-readiness";
import { providerReadinessPageSchema } from "../providers/protocol";
import {
  buildProviderReadiness,
  normalizeUsageWindow,
} from "../providers/readiness";

const now = Date.parse("2026-11-11T11:00:00Z"),
  stamp = new Date(now).toISOString();
const scope = {
  projectId: "project-00000000-0000-4000-8000-000000000001",
  workspace: "C:/fixture/repo",
};
const ruleId = "aa000000-0000-4000-8000-000000000001";
const report: ProviderUsageReport = {
  id: "claude-native-0",
  label: "private-group · private-window",
  kind: "subscription-window",
  unit: "percent",
  basis: "used",
  value: 80,
  total: 100,
  observedAt: stamp,
  resetAt: new Date(now + 3600000).toISOString(),
  durationMs: null,
  source: "provider-cli",
  reason: "private report reason",
};
const coverage = {
  started: true,
  settled: true,
  complete: true,
  fresh: true,
  error: null,
};
function fixture(): InboxUsageProjectionInput {
  const configuration: InboxUsageRulesDocument = {
    ...scope,
    revision: 7,
    rules: [
      {
        id: ruleId,
        provider: "claude",
        enabled: true,
        selector: {
          kind: "subscription-window",
          unit: report.unit,
          source: "provider-cli",
          label: report.label,
          basis: report.basis,
        },
        comparison: "at-least",
        threshold: 80,
      },
    ],
  };
  const page: ProviderReadinessPage = {
    workspace: scope.workspace,
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
          signIn: { command: null, reason: null, nativeAvailable: false },
          reports: provider === "claude" ? [structuredClone(report)] : [],
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
  };
  return {
    scope: { ...scope },
    sourceGeneration: 3,
    catalogRevision: 4,
    now,
    configuration: {
      raw: configuration,
      lastVerified: null,
      coverage: { ...coverage },
    },
    providers: { raw: page, lastVerified: null, coverage: { ...coverage } },
  };
}
test("the inert explicit rule and real normalized provider report satisfy strict production contracts", () => {
  const input = fixture();
  expect(
    inboxUsageRulesDocumentSchema.parse(input.configuration.raw).rules,
  ).toHaveLength(1);
  expect(
    providerReadinessPageSchema.parse(input.providers.raw).providers[0]
      ?.usage[0]?.reported.value,
  ).toBe(80);
});

test("one exact explicit reported threshold crossing emits a safe unresolved notice", async () => {
  const result = await projectInboxUsageSource(fixture());
  expect(result.facts).toHaveLength(1);
  expect(result.coverage).toEqual(coverage);
  expect(result.configurationRevision).toBe(7);
  expect(result.facts[0]).toMatchObject({
    sourceKind: "usage-threshold",
    status: "pending",
    sourceIdentity: { ruleId, provider: "claude" },
    quantity: {
      value: 80,
      threshold: 80,
      unit: "percent",
      basis: "used",
      comparison: "at-least",
      resetAt: report.resetAt,
    },
    fresh: true,
    complete: true,
    resolved: false,
  });
  expect(result.facts[0]?.stableItemId).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(result.facts[0]?.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toMatch(
    /private-group|private-window|private report|private local|cli.exe|at-least.*command/,
  );
  expect(result.facts[0]?.limitation).toContain(
    "Account identity and continuity",
  );
});

function mutable(input: InboxUsageProjectionInput) {
  const configuration = inboxUsageRulesDocumentSchema.parse(
      input.configuration.raw,
    ),
    page = providerReadinessPageSchema.parse(input.providers.raw);
  input.configuration.raw = configuration;
  input.providers.raw = page;
  const rule = configuration.rules[0],
    provider = page.providers.find((item) => item.provider === "claude"),
    window = provider?.usage[0];
  if (!rule || !provider || !window) throw Error("Fixture incomplete");
  return { configuration, page, rule, provider, window };
}
function retain(input: InboxUsageProjectionInput) {
  input.configuration.lastVerified = inboxUsageRulesDocumentSchema.parse(
    input.configuration.raw,
  );
  input.providers.lastVerified = providerReadinessPageSchema.parse(
    input.providers.raw,
  );
}
function reported(
  input: InboxUsageProjectionInput,
  patch: Partial<ProviderUsageReport>,
) {
  const value = mutable(input);
  Object.assign(
    value.window,
    normalizeUsageWindow({ ...report, ...patch }, input.now),
  );
  return value;
}
test("comparisons use exact reported basis and units including real zero, never derived percentages", async () => {
  const below = fixture();
  reported(below, { value: 79.9 });
  expect((await projectInboxUsageSource(below)).facts).toEqual([]);
  expect((await projectInboxUsageSource(below)).coverage.complete).toBe(true);
  const opposite = fixture();
  mutable(opposite).rule.comparison = "at-most";
  mutable(opposite).rule.threshold = 20;
  expect((await projectInboxUsageSource(opposite)).facts).toEqual([]);
  const remaining = fixture();
  const r = reported(remaining, { basis: "remaining", value: 0 });
  r.rule.selector.basis = "remaining";
  r.rule.comparison = "at-most";
  r.rule.threshold = 0;
  expect(
    (await projectInboxUsageSource(remaining)).facts[0]?.quantity.value,
  ).toBe(0);
  const tokens = fixture();
  reported(tokens, { unit: "tokens", value: 160, total: 200 });
  expect((await projectInboxUsageSource(tokens)).coverage.complete).toBe(false);
  const t = mutable(tokens);
  t.rule.selector.unit = "tokens";
  t.rule.threshold = 100;
  expect((await projectInboxUsageSource(tokens)).facts[0]?.quantity.value).toBe(
    160,
  );
  const disabled = fixture();
  mutable(disabled).rule.enabled = false;
  expect((await projectInboxUsageSource(disabled)).facts).toEqual([]);
  expect((await projectInboxUsageSource(disabled)).coverage.complete).toBe(
    true,
  );
});
test("schema-only API balance variants retain the exact reported measure without claiming a reader", async () => {
  const input = fixture();
  const m = reported(input, {
    kind: "api-balance",
    unit: "usd",
    basis: "remaining",
    value: 2.5,
    total: null,
    resetAt: null,
    source: "provider-api",
  });
  Object.assign(m.rule.selector, {
    kind: "api-balance",
    unit: "usd",
    basis: "remaining",
    source: "provider-api",
  });
  m.rule.comparison = "at-most";
  m.rule.threshold = 5;
  const result = await projectInboxUsageSource(input);
  expect(result.facts[0]?.quantity).toMatchObject({
    value: 2.5,
    unit: "usd",
    basis: "remaining",
    resetAt: null,
  });
  expect(result.facts[0]?.resolved).toBe(false);
});
test("scope, explicit configuration, source consistency, freshness and reset failures remain unavailable", async () => {
  const cases: ((input: InboxUsageProjectionInput) => void)[] = [
    (i) => {
      i.scope.projectId = "project-00000000-0000-4000-8000-000000000002";
    },
    (i) => {
      mutable(i).configuration.workspace = "C:/foreign";
    },
    (i) => {
      mutable(i).page.workspace = "C:/foreign";
    },
    (i) => {
      i.sourceGeneration = -1;
    },
    (i) => {
      i.catalogRevision = Number.MAX_SAFE_INTEGER + 1;
    },
    (i) => {
      i.now = Number.NaN;
    },
    (i) => {
      mutable(i).configuration.revision = -1;
    },
    (i) => {
      const m = mutable(i);
      m.configuration.rules.push(structuredClone(m.rule));
    },
    (i) => {
      mutable(i).rule.id = ruleId.toUpperCase();
    },
    (i) => {
      const m = mutable(i);
      i.configuration.raw = { ...m.configuration, extra: true };
    },
    (i) => {
      i.configuration.raw = null;
    },
    (i) => {
      const m = mutable(i);
      i.configuration.raw = {
        ...m.configuration,
        rules: Array.from({ length: 101 }, (_, index) => ({
          ...m.rule,
          id:
            "aa000000-0000-4000-8000-" +
            (index + 1).toString(16).padStart(12, "0"),
        })),
      };
    },
    (i) => {
      mutable(i).rule.threshold = 101;
    },
    (i) => {
      mutable(i).rule.threshold = Number.POSITIVE_INFINITY;
    },
    (i) => {
      mutable(i).page.problems = ["private problem"];
    },
    (i) => {
      mutable(i).provider.stale = true;
    },
    (i) => {
      mutable(i).window.stale = true;
    },
    (i) => {
      mutable(i).window.reported.value = null;
    },
    (i) => {
      mutable(i).window.reported.value = 101;
    },
    (i) => {
      mutable(i).window.reported.value = -1;
    },
    (i) => {
      mutable(i).window.reported.value = Number.NaN;
    },
    (i) => {
      mutable(i).window.reported.total = 50;
    },
    (i) => {
      mutable(i).window.used = 12;
    },
    (i) => {
      mutable(i).window.percentUsed = 12;
    },
    (i) => {
      mutable(i).window.total = null;
    },
    (i) => {
      mutable(i).window.durationMs = 0;
    },
    (i) => {
      mutable(i).window.resetAt = null;
    },
    (i) => {
      mutable(i).window.resetAt = stamp;
    },
    (i) => {
      mutable(i).window.observedAt = new Date(now - 60001).toISOString();
    },
    (i) => {
      mutable(i).window.observedAt = new Date(now + 1).toISOString();
    },
    (i) => {
      mutable(i).page.asOf = new Date(now - 30001).toISOString();
    },
    (i) => {
      mutable(i).page.asOf = new Date(now + 1).toISOString();
    },
    (i) => {
      mutable(i).window.kind = "local-counted";
    },
    (i) => {
      mutable(i).window.source = "configuration";
    },
    (i) => {
      mutable(i).window.source = "unavailable";
    },
    (i) => {
      mutable(i).window.unit = "requests";
    },
    (i) => {
      mutable(i).window.reported.basis = "remaining";
    },
    (i) => {
      mutable(i).window.label = "another window";
    },
    (i) => {
      const m = mutable(i);
      m.provider.usage.push({ ...m.window, id: "different-positional-id" });
    },
  ];
  for (const change of cases) {
    const input = fixture();
    change(input);
    const result = await projectInboxUsageSource(input);
    expect(result.facts).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.fresh).toBe(false);
    expect(result.diagnostics).toEqual([
      "Configured reported usage could not be verified.",
    ]);
    expect(JSON.stringify(result)).not.toContain("private problem");
  }
});
test("all ten coverage gaps retain only an independently coherent prior pair with no current mixing", async () => {
  for (const source of ["configuration", "providers"] as const)
    for (const flag of [
      "started",
      "settled",
      "complete",
      "fresh",
      "error",
    ] as const) {
      const input = fixture();
      if (flag === "error")
        input[source].coverage.error = "private failed read";
      else input[source].coverage[flag] = false;
      expect((await projectInboxUsageSource(input)).facts).toEqual([]);
      retain(input);
      const prior = await projectInboxUsageSource(input);
      expect(prior.facts).toHaveLength(1);
      expect(prior.coverage.complete).toBe(false);
      expect(prior.facts[0]).toMatchObject({
        fresh: false,
        complete: false,
        resolved: false,
      });
      reported(input, { value: 99 });
      expect(
        (await projectInboxUsageSource(input)).facts[0]?.quantity.value,
      ).toBe(80);
      input.configuration.lastVerified = null;
      expect((await projectInboxUsageSource(input)).facts).toEqual([]);
    }
  const empty = fixture();
  const m = mutable(empty);
  m.configuration.rules = [];
  expect((await projectInboxUsageSource(empty)).coverage.complete).toBe(true);
  expect((await projectInboxUsageSource(empty)).facts).toEqual([]);
});
test("prior reads use the producer anchor tolerance while old cycles remain stale and unresolved", async () => {
  const input = fixture();
  reported(input, { observedAt: new Date(now + 4000).toISOString() });
  input.now = now + 10000;
  retain(input);
  input.providers.raw = null;
  const retained = await projectInboxUsageSource(input);
  expect(retained.facts).toHaveLength(1);
  expect(retained.facts[0]?.fresh).toBe(false);
  input.now = now + 3600001;
  expect((await projectInboxUsageSource(input)).facts[0]?.resolved).toBe(false);
  const priorWindow = input.providers.lastVerified?.providers[0]?.usage[0];
  if (!priorWindow) throw Error("Missing prior");
  priorWindow.observedAt = new Date(now + 5001).toISOString();
  expect((await projectInboxUsageSource(input)).facts).toEqual([]);
  const future = fixture();
  retain(future);
  if (!future.providers.lastVerified) throw Error("Missing prior");
  future.providers.raw = null;
  future.providers.lastVerified.asOf = new Date(now + 1).toISOString();
  expect((await projectInboxUsageSource(future)).facts).toEqual([]);
  const foreign = fixture();
  retain(foreign);
  foreign.providers.raw = null;
  if (!foreign.configuration.lastVerified) throw Error("Missing prior");
  foreign.configuration.lastVerified.workspace = "C:/foreign";
  expect((await projectInboxUsageSource(foreign)).facts).toEqual([]);
});
test("canonical identity ignores positional IDs and observation clocks while rule/window semantics revise it", async () => {
  const base = await projectInboxUsageSource(fixture());
  const original = base.facts[0];
  if (!original) throw Error("Missing fact");
  const same = fixture();
  same.now += 10000;
  const m = reported(same, {
    id: "claude-native-23",
    observedAt: new Date(now + 10000).toISOString(),
    reason: "different private prose",
  });
  m.page.asOf = new Date(same.now).toISOString();
  m.configuration.revision++;
  same.sourceGeneration++;
  same.catalogRevision++;
  m.configuration.rules.push({
    ...structuredClone(m.rule),
    id: "aa000000-0000-4000-8000-000000000002",
    enabled: false,
  });
  const unchanged = (await projectInboxUsageSource(same)).facts[0];
  expect(unchanged?.stableItemId).toBe(original.stableItemId);
  expect(unchanged?.sourceRevision).toBe(original.sourceRevision);
  for (const change of [
    (i: InboxUsageProjectionInput) => {
      reported(i, { value: 81 });
    },
    (i: InboxUsageProjectionInput) => {
      mutable(i).rule.threshold = 79;
    },
    (i: InboxUsageProjectionInput) => {
      reported(i, { resetAt: new Date(now + 7200000).toISOString() });
    },
  ]) {
    const input = fixture();
    change(input);
    const changed = (await projectInboxUsageSource(input)).facts[0];
    expect(changed?.stableItemId).toBe(original.stableItemId);
    expect(changed?.sourceRevision).not.toBe(original.sourceRevision);
  }
  const different = fixture();
  mutable(different).rule.id = "aa000000-0000-4000-8000-000000000002";
  expect(
    (await projectInboxUsageSource(different)).facts[0]?.stableItemId,
  ).not.toBe(original.stableItemId);
});
test("current and prior nested inputs and caller provenance are immutable across hashing awaits", async () => {
  const current = fixture();
  const m = mutable(current);
  const promise = projectInboxUsageSource(current);
  m.rule.threshold = 99;
  m.window.reported.value = 99;
  current.scope.projectId = "changed";
  current.sourceGeneration = 999;
  current.configuration.coverage.error = "private mutation";
  expect((await promise).facts[0]?.quantity).toMatchObject({
    value: 80,
    threshold: 80,
  });
  expect((await promise).scope).toEqual(scope);
  expect((await promise).sourceGeneration).toBe(3);
  const prior = fixture();
  retain(prior);
  prior.providers.coverage.fresh = false;
  const pending = projectInboxUsageSource(prior);
  if (
    !prior.configuration.lastVerified ||
    !prior.providers.lastVerified?.providers[0]?.usage[0]
  )
    throw Error("Missing prior");
  prior.configuration.lastVerified.rules[0]!.threshold = 99;
  prior.providers.lastVerified.providers[0].usage[0].reported.value = 99;
  expect((await pending).facts[0]?.quantity).toMatchObject({
    value: 80,
    threshold: 80,
  });
  expect(Object.isFrozen((await pending).facts[0]?.quantity)).toBe(true);
});

test("identity and revision match fixed full-tuple contract vectors from independent Node SHA256", async () => {
  const result = await projectInboxUsageSource(fixture());
  const identity = [
    "inbox-source-v1",
    "c:/fixture/repo",
    scope.projectId,
    "usage-threshold",
    ["usage", "claude", ruleId],
  ];
  // Fixed lexicographic rule keys are the canonical wire bytes, independent of parser property order.
  const rule = {
    comparison: "at-least",
    enabled: true,
    id: ruleId,
    provider: "claude",
    selector: {
      basis: "used",
      kind: "subscription-window",
      label: report.label,
      source: "provider-cli",
      unit: "percent",
    },
    threshold: 80,
  };
  const revision = [
    "inbox-revision-v1",
    identity,
    [
      rule,
      [
        "subscription-window",
        "percent",
        "provider-cli",
        report.label,
        "used",
        80,
        100,
        report.resetAt,
        null,
      ],
    ],
  ];
  expect(result.facts[0]?.stableItemId).toBe(
    "sha256:" +
      createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  );
  expect(result.facts[0]?.sourceRevision).toBe(
    "sha256:" +
      createHash("sha256").update(JSON.stringify(revision)).digest("hex"),
  );
});

test("normalized reported totals must also match while explicit zero with unknown total remains valid", async () => {
  const bad = fixture();
  const m = mutable(bad);
  m.window.reported.total = 0;
  m.window.used = 80;
  m.window.remaining = null;
  m.window.total = null;
  m.window.percentUsed = null;
  expect(providerReadinessPageSchema.safeParse(bad.providers.raw).success).toBe(
    true,
  );
  expect((await projectInboxUsageSource(bad)).facts).toEqual([]);
  expect((await projectInboxUsageSource(bad)).coverage.complete).toBe(false);
  const zero = fixture();
  const valid = reported(zero, { value: 0, total: null });
  valid.rule.comparison = "at-most";
  valid.rule.threshold = 0;
  expect((await projectInboxUsageSource(zero)).facts[0]?.quantity.value).toBe(
    0,
  );
  expect((await projectInboxUsageSource(zero)).coverage.complete).toBe(true);
});
