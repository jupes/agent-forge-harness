import { expect, test } from "bun:test";
import {
  buildProviderReadiness,
  normalizeUsageWindow,
  parseClaudeAuthentication,
  parseCodexAuthentication,
} from "./readiness";

const now = Date.parse("2026-10-23T06:40:00Z");
const window = {
  id: "weekly",
  label: "Weekly allowance",
  kind: "subscription-window",
  unit: "percent",
  basis: "used",
  value: 60,
  total: 100,
  observedAt: "2026-10-23T06:39:45Z",
  resetAt: null,
  durationMs: 7 * 24 * 60 * 60 * 1000,
  source: "provider-cli",
  reason: null,
} as const;

test("reported remaining normalizes once to the same used measure; missing reset stays unknown", () => {
  const used = normalizeUsageWindow(window, now);
  const remaining = normalizeUsageWindow(
    { ...window, basis: "remaining", value: 40 },
    now,
  );
  expect(used.used).toBe(60);
  expect(remaining.used).toBe(60);
  expect(remaining.remaining).toBe(40);
  expect(remaining.percentUsed).toBe(60);
  expect(remaining.reported.basis).toBe("remaining");
  expect(remaining.resetAt).toBeNull();
  expect(remaining.stale).toBe(false);
});

test("unknown, partial, stale and locally counted usage cannot become zero or allowance headroom", () => {
  const unknown = normalizeUsageWindow(
    { ...window, value: null, reason: "Reporting unavailable" },
    now,
  );
  expect(unknown.used).toBeNull();
  expect(unknown.remaining).toBeNull();
  expect(unknown.percentUsed).toBeNull();
  expect(unknown.reason).toBe("Reporting unavailable");
  const balance = normalizeUsageWindow(
    {
      ...window,
      kind: "api-balance",
      unit: "usd",
      basis: "remaining",
      value: 20,
      total: null,
    },
    now,
  );
  expect(balance.remaining).toBe(20);
  expect(balance.used).toBeNull();
  expect(balance.percentUsed).toBeNull();
  const counted = normalizeUsageWindow(
    {
      ...window,
      kind: "local-counted",
      unit: "tokens",
      source: "local-ledger",
      value: 60,
    },
    now,
  );
  expect(counted.used).toBe(60);
  expect(counted.percentUsed).toBeNull();
  expect(
    normalizeUsageWindow({ ...window, observedAt: "2026-10-22T00:00:00Z" }, now)
      .stale,
  ).toBe(true);
  expect(
    normalizeUsageWindow({ ...window, value: Number.NaN }, now).used,
  ).toBeNull();
  expect(normalizeUsageWindow({ ...window, value: -1 }, now).used).toBeNull();
});

const observation = {
  provider: "claude",
  name: "Claude",
  installation: {
    found: true,
    versionOk: true,
    version: "2.1.293",
    path: "/fixture/claude",
    checkedAt: window.observedAt,
    compatibility: "supported",
    reason: null,
  },
  authentication: {
    mode: "unknown",
    source: "unavailable",
    observedAt: null,
    reason: "Authentication has not been reported.",
  },
  adapter: { supported: true, reason: null },
  signIn: { command: "claude auth login", reason: null },
  reports: [],
  smiths: [],
} as const;

test("version success never becomes sign-in or allowance proof; seven states retain independent facts", () => {
  const unknown = buildProviderReadiness(observation, now);
  expect(unknown.state).toBe("reporting-unavailable");
  expect(unknown.authentication.mode).toBe("unknown");
  expect(unknown.usage).toEqual([]);
  const signedOut = {
    ...observation.authentication,
    mode: "signed-out",
    source: "provider-cli",
    observedAt: window.observedAt,
  } as const;
  expect(
    buildProviderReadiness({ ...observation, authentication: signedOut }, now)
      .state,
  ).toBe("signed-out");
  for (const mode of ["subscription", "api-key"] as const) {
    const authenticated = { ...signedOut, mode };
    expect(
      buildProviderReadiness(
        { ...observation, authentication: authenticated },
        now,
      ).state,
    ).toBe(mode);
    expect(
      buildProviderReadiness(
        {
          ...observation,
          authentication: authenticated,
          reports: [{ ...window, value: 100 }],
        },
        now,
      ).state,
    ).toBe("exhausted");
  }
  expect(
    buildProviderReadiness(
      {
        ...observation,
        installation: {
          ...observation.installation,
          found: false,
          versionOk: false,
        },
      },
      now,
    ).state,
  ).toBe("not-installed");
  expect(
    buildProviderReadiness(
      {
        ...observation,
        installation: { ...observation.installation, compatibility: "too-old" },
      },
      now,
    ).state,
  ).toBe("degraded");
  expect(
    buildProviderReadiness(
      {
        ...observation,
        adapter: { supported: false, reason: "Adapter pending" },
      },
      now,
    ).state,
  ).toBe("degraded");
});

test("old allowance, API balance and local counts do not imply current subscription exhaustion", () => {
  const auth = {
    ...observation.authentication,
    mode: "subscription",
    source: "provider-cli",
    observedAt: window.observedAt,
  } as const;
  const stale = buildProviderReadiness(
    {
      ...observation,
      authentication: auth,
      reports: [{ ...window, value: 100, observedAt: "2026-10-22T00:00:00Z" }],
    },
    now,
  );
  expect(stale.state).toBe("subscription");
  expect(stale.usage[0]?.stale).toBe(true);
  const local = buildProviderReadiness(
    {
      ...observation,
      authentication: auth,
      reports: [{ ...window, kind: "local-counted", value: 100 }],
    },
    now,
  );
  expect(local.state).toBe("subscription");
  expect(local.usage[0]?.percentUsed).toBeNull();
  const oldAuth = buildProviderReadiness(
    {
      ...observation,
      authentication: { ...auth, observedAt: "2026-10-22T00:00:00Z" },
    },
    now,
  );
  expect(oldAuth.stale).toBe(true);
  const expired = buildProviderReadiness(
    {
      ...observation,
      authentication: auth,
      reports: [{ ...window, value: 100, resetAt: "2026-10-23T06:39:50Z" }],
    },
    now,
  );
  expect(expired.state).toBe("subscription");
  expect(expired.usage[0]?.stale).toBe(true);
});

test("status parsers discard account/key fields and refuse to treat an error exit as signed out", () => {
  const at = window.observedAt;
  expect(
    parseClaudeAuthentication(
      '{"authMethod":"claude.ai","loggedIn":true,"email":"private@example.test","token":"never-forward"}',
      0,
      at,
    ).mode,
  ).toBe("subscription");
  expect(
    parseClaudeAuthentication(
      '{"authMethod":"api_key","loggedIn":true,"apiKey":"never-forward"}',
      0,
      at,
    ).mode,
  ).toBe("api-key");
  expect(
    parseClaudeAuthentication('{"authMethod":"none","loggedIn":false}', 1, at)
      .mode,
  ).toBe("signed-out");
  expect(parseClaudeAuthentication('{"authMethod":"none"}', 2, at).mode).toBe(
    "unknown",
  );
  expect(
    parseClaudeAuthentication(
      '{"authMethod":"claude.ai","loggedIn":false}',
      1,
      at,
    ).mode,
  ).toBe("unknown");
  expect(
    parseClaudeAuthentication(
      '{"authMethod":"claude.ai","loggedIn":false}',
      0,
      at,
    ).mode,
  ).toBe("unknown");
  expect(
    parseClaudeAuthentication("expired or unsupported command", 1, at).mode,
  ).toBe("unknown");
  expect(
    parseClaudeAuthentication('{"authMethod":"future-mode"}', 0, at).mode,
  ).toBe("unknown");
  expect(
    JSON.stringify(
      parseClaudeAuthentication(
        '{"authMethod":"api_key","loggedIn":true,"apiKey":"never-forward","email":"private@example.test"}',
        0,
        at,
      ),
    ),
  ).not.toContain("never-forward");
  expect(parseCodexAuthentication(0, at).mode).toBe("signed-in");
  expect(parseCodexAuthentication(1, at).mode).toBe("unknown");
  expect(
    parseClaudeAuthentication('{"authMethod":"claude.ai"}', 0, at).mode,
  ).toBe("unknown");
  expect(
    parseClaudeAuthentication(
      '{"authMethod":"api_key","loggedIn":"false"}',
      0,
      at,
    ).mode,
  ).toBe("unknown");
  expect(
    parseClaudeAuthentication('{"authMethod":"none","loggedIn":true}', 1, at)
      .mode,
  ).toBe("unknown");
});
