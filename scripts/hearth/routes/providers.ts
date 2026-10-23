import type { LedgerEvent } from "../../../types/hearth";
import {
  type ProviderReadinessPage,
  type ProviderUsageReport,
  READINESS_PROVIDERS,
} from "../../../types/provider-readiness";
import { loadConfig } from "../../config/load";
import { queryEventPage } from "../../ledger/query";
import {
  aggregateReportedSessionUsage,
  buildProjectOverview,
} from "../../projects/overview";
import type { ProviderInspector } from "../../providers/inspect";
import type { ProviderLoginService } from "../../providers/login";
import { readOwnedClaudeUsage } from "../../providers/owned-usage";
import { providerReadinessPageSchema } from "../../providers/protocol";
import { buildProviderReadiness } from "../../providers/readiness";
import type { ActionRoute, ReadRoute } from "../api";
import {
  fail,
  hearthLedger,
  noParameters,
  type ReadDeps,
} from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

/** One coalesced source for every desktop usage consumer. No provider task is run. */
export function createProviderReadinessRoutes(
  deps: ReadDeps & { projectHome: string; providerLogin: ProviderLoginService },
  inspector: ProviderInspector,
  load: () => Promise<ProjectSnapshot>,
  readUsage: typeof readOwnedClaudeUsage = readOwnedClaudeUsage,
) {
  let revision = 0;
  type Marker = ReturnType<ProviderLoginService["latestAttempt"]> | undefined;
  const marker = (): Marker => {
    try {
      return deps.providerLogin.latestAttempt("claude");
    } catch {
      return undefined;
    }
  };
  const key = (value: Marker) =>
    `${revision}:${value ? value.requestId : value === null ? "none" : "unavailable"}`;
  let pending: { key: string; promise: Promise<ProviderReadinessPage> } | null =
    null;
  let cached: ProviderReadinessPage | null = null;
  let cachedKey: string | null = null;
  const read = async (generation: Marker): Promise<ProviderReadinessPage> => {
    const asOf = new Date().toISOString(),
      through = Date.parse(asOf),
      since = new Date(through - 7 * 86_400_000).toISOString();
    const loaded = loadConfig({
      harnessRoot: deps.root,
      env: {},
      ...(deps.configHome ? { home: deps.configHome } : {}),
    });
    const problems: string[] = [];
    let events: LedgerEvent[] | null = null,
      more = false;
    try {
      const page = queryEventPage(
        {
          workspace: deps.workspace,
          since,
          kinds: ["session.ended"],
          limit: 10000,
        },
        hearthLedger(deps.ledgerPath),
      );
      events = page.events;
      more = page.more;
    } catch {
      problems.push(
        "Local session usage could not be read. Unknown values remain unavailable.",
      );
    }
    const totals = aggregateReportedSessionUsage(
      events ?? [],
      Date.parse(since),
      through,
    );
    const reports = (provider: string): ProviderUsageReport[] => {
      const total = totals.find((row) => row.provider === provider);
      if (!total) return [];
      return Object.entries(total.usage).flatMap(([key, value]) =>
        typeof value !== "number"
          ? []
          : [
              {
                id: `local-${key}`,
                label: `Counted locally · ${key}`,
                kind: "local-counted" as const,
                unit:
                  key === "costUsd" ? ("usd" as const) : ("tokens" as const),
                basis: "used" as const,
                value,
                total: null,
                observedAt: asOf,
                resetAt: null,
                durationMs: 7 * 86_400_000,
                source: "local-ledger" as const,
                reason:
                  "Provider-reported session-end totals recorded by this hearth. Live, unreported and unpriced work may be absent; this is not an account allowance.",
              },
            ],
      );
    };
    let projects: ProviderReadinessPage["localUsage"]["projects"] = null;
    try {
      const snapshot = await load();
      if (events !== null)
        projects = snapshot.catalog.projects.map((project) => {
          const overview = buildProjectOverview(
            project,
            { ...snapshot.source, asOf },
            { events, more, reservations: null, shifts: null },
          );
          if (overview.usage.data === null)
            throw Error("Incomplete project membership");
          return {
            projectId: project.id,
            name: project.name,
            providers: overview.usage.data.map((row) => ({
              provider: row.provider,
              sessions: row.sessions,
              inputTokens: row.usage.inputTokens ?? null,
              outputTokens: row.usage.outputTokens ?? null,
              costUsd: row.usage.costUsd ?? null,
            })),
          };
        });
    } catch {
      problems.push("Project usage attribution is unavailable for this read.");
    }
    if (more)
      problems.push(
        "Local counts include only the newest 10,000 matching events.",
      );
    const providers = await Promise.all(
      READINESS_PROVIDERS.map(async (provider) => {
        const inspection = await inspector.inspect(
          provider,
          loaded.config.execution.envPass,
        );
        let native: ProviderUsageReport[] = [],
          usageReason: string | null = null;
        if (provider === "claude") {
          try {
            if (generation === undefined)
              throw Error("Sign-in generation unavailable");
            const found = await readUsage({
              home: deps.projectHome,
              workspace: deps.workspace,
              version: inspection.installation.version,
              after: generation?.startedAt ?? null,
            });
            native = found.reports;
            usageReason = found.reason;
          } catch {
            usageReason =
              "Private native account reports could not be verified. Earlier allowance is withheld; local counts are separate.";
          }
        }
        const result = buildProviderReadiness(
          {
            ...inspection,
            reports: [...native, ...reports(provider)],
            smiths: Object.values(loaded.config.smiths)
              .filter((smith) => smith.provider === provider)
              .map(({ name, model, enabled }) => ({ name, model, enabled })),
          },
          through,
        );
        return usageReason ? { ...result, usageReason } : result;
      }),
    );
    const result: ProviderReadinessPage = {
      workspace: deps.workspace,
      asOf,
      providers,
      problems,
      localUsage: {
        since,
        through: asOf,
        source:
          "Counted locally from provider-reported session ends · last 7 days",
        reason:
          "Partial history only. Costs are reported amounts, not inferred prices. Project membership uses the current ancestry and label scope; overlapping projects can share the same session and must not be added together.",
        projects,
      },
    };
    const checked = providerReadinessPageSchema.safeParse(result);
    if (!checked.success || Buffer.byteLength(JSON.stringify(result)) > 1048576)
      throw Error("Provider report exceeds verified read limits.");
    return checked.data;
  };
  const route: ReadRoute = {
    kind: "read",
    method: "GET",
    path: "/providers/readiness",
    operatorOnly: true,
    validate: noParameters,
    async read() {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const generation = marker(),
            currentKey = key(generation);
          if (
            cached &&
            cachedKey === currentKey &&
            Date.now() - Date.parse(cached.asOf) < 15000
          )
            return { status: 200, data: cached };
          if (!pending || pending.key !== currentKey)
            pending = { key: currentKey, promise: read(generation) };
          const owned = pending;
          let result: ProviderReadinessPage;
          try {
            result = await owned.promise;
          } finally {
            if (pending === owned) pending = null;
          }
          if (key(marker()) !== owned.key) continue;
          cached = result;
          cachedKey = owned.key;
          return { status: 200, data: cached };
        }
        throw Error("Sign-in state changed while reporting");
      } catch {
        return {
          status: 503,
          error:
            "Provider readiness could not be verified. Refresh before relying on this report.",
        };
      }
    },
  };
  const doctor: ActionRoute<string> = {
    kind: "action",
    method: "POST",
    path: "/providers/:provider/doctor",
    action: "provider.doctor",
    validate(request) {
      const query = noParameters(request);
      if (!query.ok) return query;
      const provider = request.params["provider"];
      if (!READINESS_PROVIDERS.some((known) => known === provider))
        return fail("Expected a known provider.");
      if (
        !request.body ||
        typeof request.body !== "object" ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length
      )
        return fail(
          "Doctor takes an empty object. No task, command, account or credential input is accepted.",
        );
      return { ok: true, value: provider ?? "" };
    },
    subject: (provider) => ({ target: provider }),
    async effect() {
      revision++;
      cached = null;
      return route.read(undefined);
    },
  };
  return { read: route, doctor };
}
