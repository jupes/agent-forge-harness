/**
 * Summarize a `promptfoo eval --output results.json` payload into a small,
 * dashboard-friendly shape. Kept tolerant of older / newer promptfoo output
 * shapes — missing fields degrade to "unknown" rather than throwing.
 *
 * See scripts/evals/README.md.
 */

export type EvalSummary = {
  generatedAt: string;
  totalCases: number;
  passCount: number;
  failCount: number;
  /** grader provider id, if reported */
  grader?: string;
  providers: Array<{
    id: string;
    label?: string;
    totalCases: number;
    passCount: number;
    failCount: number;
    avgCost?: number;
    avgLatencyMs?: number;
  }>;
};

type RawResult = {
  description?: unknown;
  success?: unknown;
  pass?: unknown;
  cost?: unknown;
  latencyMs?: unknown;
  provider?: { id?: unknown; label?: unknown } | string;
};

type RawPromptfoo = {
  createdAt?: unknown;
  results?: {
    results?: unknown;
  } | unknown;
  evalConfig?: {
    defaultTest?: {
      options?: {
        provider?: unknown;
      };
    };
  };
  config?: {
    defaultTest?: {
      options?: {
        provider?: unknown;
      };
    };
  };
};

function toMillis(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  return undefined;
}

function toNumber(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  return undefined;
}

function toString(x: unknown): string | undefined {
  if (typeof x === "string" && x.trim() !== "") return x;
  return undefined;
}

function flattenResults(raw: unknown): RawResult[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as RawResult[];
  if (typeof raw === "object" && raw !== null) {
    const nested = (raw as { results?: unknown }).results;
    if (Array.isArray(nested)) return nested as RawResult[];
  }
  return [];
}

export function summarizePromptfooResults(payload: unknown): EvalSummary {
  const root = typeof payload === "object" && payload !== null ? (payload as RawPromptfoo) : {};
  const generatedAt =
    toString(root.createdAt) ?? new Date().toISOString();
  const rawResults = root.results ?? null;
  const results = flattenResults(rawResults);

  const grader =
    toString(root.evalConfig?.defaultTest?.options?.provider) ??
    toString(root.config?.defaultTest?.options?.provider);

  type Agg = {
    id: string;
    label?: string;
    total: number;
    pass: number;
    fail: number;
    costSum: number;
    costN: number;
    latencySum: number;
    latencyN: number;
  };
  const byProvider = new Map<string, Agg>();
  let totalPass = 0;
  let totalFail = 0;

  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const providerId =
      typeof r.provider === "string"
        ? r.provider
        : typeof r.provider === "object" && r.provider !== null
          ? (toString(r.provider.id) ?? "(unknown)")
          : "(unknown)";
    const providerLabel =
      typeof r.provider === "object" && r.provider !== null ? toString(r.provider.label) : undefined;

    let agg = byProvider.get(providerId);
    if (!agg) {
      agg = {
        id: providerId,
        total: 0,
        pass: 0,
        fail: 0,
        costSum: 0,
        costN: 0,
        latencySum: 0,
        latencyN: 0,
      };
      if (providerLabel) agg.label = providerLabel;
      byProvider.set(providerId, agg);
    }

    agg.total += 1;
    const passed =
      typeof r.success === "boolean"
        ? r.success
        : typeof r.pass === "boolean"
          ? r.pass
          : false;
    if (passed) {
      agg.pass += 1;
      totalPass += 1;
    } else {
      agg.fail += 1;
      totalFail += 1;
    }
    const cost = toNumber(r.cost);
    if (cost !== undefined) {
      agg.costSum += cost;
      agg.costN += 1;
    }
    const latency = toMillis(r.latencyMs);
    if (latency !== undefined) {
      agg.latencySum += latency;
      agg.latencyN += 1;
    }
  }

  const providers: EvalSummary["providers"] = Array.from(byProvider.values())
    .sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id))
    .map((a) => {
      const row: EvalSummary["providers"][number] = {
        id: a.id,
        totalCases: a.total,
        passCount: a.pass,
        failCount: a.fail,
      };
      if (a.label) row.label = a.label;
      if (a.costN > 0) row.avgCost = a.costSum / a.costN;
      if (a.latencyN > 0) row.avgLatencyMs = a.latencySum / a.latencyN;
      return row;
    });

  const summary: EvalSummary = {
    generatedAt,
    totalCases: results.length,
    passCount: totalPass,
    failCount: totalFail,
    providers,
  };
  if (grader) summary.grader = grader;
  return summary;
}
