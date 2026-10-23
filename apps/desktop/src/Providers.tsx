import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { Tag } from "../../../docs/js/ds/Tag";
import type {
  ProviderReadiness,
  ProviderReadinessPage,
  ProviderUsageWindow,
  ReadinessProvider,
} from "../../../types/provider-readiness";
import { ProviderMonogram } from "./DesktopFrame";
import { desktopHref } from "./navigation";
import "./providers.css";
import type { ProviderLoginClient } from "./provider-login-client";
import { providerUsageLabel, readinessLabel } from "./providers-model";

function value(
  value: number | null,
  unit: ProviderUsageWindow["unit"],
): string {
  return value === null
    ? "—"
    : unit === "usd"
      ? `$${value.toFixed(2)}`
      : `${value.toLocaleString()}${unit === "percent" ? "%" : ` ${unit}`}`;
}
export function ProviderUsageStrip({
  data,
  stale = false,
}: {
  data?: ProviderReadinessPage | null;
  stale?: boolean;
}): JSX.Element {
  return (
    <section
      class="af-provider-strip"
      aria-label="Provider usage"
      data-last-known={stale}
    >
      {(
        data?.providers ??
        ["Claude", "Codex", "Gemini", "Grok", "OpenRouter"].map((name) => ({
          name,
          provider: name.toLowerCase(),
          usage: [],
        }))
      ).map((provider) => (
        <a
          key={provider.provider}
          href={desktopHref({
            destination: "providers",
            projectId: null,
            selection: null,
          })}
        >
          <strong>{provider.name}</strong>
          <span>
            {providerUsageLabel(
              data?.providers.find((row) => row.provider === provider.provider),
            )}
          </span>
          {stale && <small>Last-known report</small>}
        </a>
      ))}
    </section>
  );
}
export function ProjectProviderUsage({
  data,
  projectId,
  stale = false,
}: {
  data?: ProviderReadinessPage | null;
  projectId: string;
  stale?: boolean;
}): JSX.Element {
  const project = data?.localUsage.projects?.find(
    (row) => row.projectId === projectId,
  );
  return (
    <section
      class="af-overview-panel af-provider-project"
      aria-label="Reported project usage"
    >
      <h2>Reported project usage</h2>
      <p>
        {data?.localUsage.source ?? "Local usage has not been read."}
        {stale ? " · Last-known report" : ""}
      </p>
      {project?.providers.length ? (
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Input tokens</th>
              <th>Output tokens</th>
              <th>Reported USD</th>
            </tr>
          </thead>
          <tbody>
            {project.providers.map((row) => (
              <tr key={row.provider}>
                <th>{row.provider}</th>
                <td>{row.inputTokens?.toLocaleString() ?? "—"}</td>
                <td>{row.outputTokens?.toLocaleString() ?? "—"}</td>
                <td>{row.costUsd?.toFixed(2) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          {project
            ? "Usage — no project session totals were reported in this read."
            : "Project usage attribution unavailable."}
        </p>
      )}
      <p class="af-overview-muted">
        {data?.localUsage.reason ?? "Unknown counts stay unavailable."}
      </p>
      <Button
        href={desktopHref({
          destination: "providers",
          projectId,
          selection: null,
        })}
      >
        Providers &amp; usage
      </Button>
    </section>
  );
}
export function Providers({
  data,
  error,
  loading,
  reload,
  doctor,
  checking,
  writesAllowed,
  stale,
  logins,
}: {
  data: ProviderReadinessPage | null;
  error: string | null;
  loading: boolean;
  reload(): void;
  doctor(provider: ReadinessProvider): Promise<void>;
  checking: boolean;
  writesAllowed: boolean;
  stale: boolean;
  logins: ProviderLoginClient | null;
}): JSX.Element {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  if (!data)
    return (
      <EmptyState
        title={error ? "Providers could not be read" : "Checking providers…"}
        hint={
          error ??
          "Reading CLI, sign-in, adapter and usage evidence separately."
        }
      >
        <Button onClick={reload} disabled={loading}>
          Retry provider check
        </Button>
      </EmptyState>
    );
  const rows = data.providers.filter(
    (provider) =>
      provider.name.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === "all" || provider.state === filter),
  );
  return (
    <div class="af-providers" data-last-known={stale}>
      <div class="af-provider-heading">
        <div>
          <h2>CLI and account reports</h2>
          <p>
            Each CLI reports in its own terms. Unknown allowance stays
            unavailable.
          </p>
        </div>
        <Button onClick={reload} aria-disabled={loading}>
          Refresh providers
        </Button>
      </div>
      <p class="af-provider-muted">
        {stale ? "Last-known report" : "Read from the hearth"} ·{" "}
        <time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString()}</time>
      </p>
      {error && (
        <p role="alert">
          The provider check could not finish. {error} Showing the last-known
          report; retry when the hearth answers.
        </p>
      )}
      {data.problems.map((problem) => (
        <p role="status" key={problem}>
          {problem}
        </p>
      ))}
      <section class="af-provider-room" aria-label="Where you have room">
        <h2>Where you have room</h2>
        <p>
          {data.providers.some((provider) =>
            provider.usage.some((report) => report.kind !== "local-counted"),
          )
            ? "Reported allowances keep their own windows and units. Missing providers remain unavailable."
            : "Account allowance is not reported by the available CLI status checks. Local session totals do not measure subscription room."}
        </p>
        <ProviderUsageStrip data={data} stale={stale} />
      </section>
      {!data.providers.some((provider) => provider.installation.found) && (
        <p role="status">
          No provider CLI was found. Install a supported CLI and use its own
          sign-in flow, then refresh.
        </p>
      )}
      <div class="af-provider-filters">
        <label>
          Find providers
          <input
            type="search"
            value={search}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        <label>
          State
          <select
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          >
            <option value="all">All states</option>
            {(
              [
                "not-installed",
                "signed-out",
                "subscription",
                "api-key",
                "exhausted",
                "reporting-unavailable",
                "degraded",
              ] as const
            ).map((state) => (
              <option key={state} value={state}>
                {readinessLabel(state)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!rows.length && (
        <EmptyState
          title="No providers match these filters"
          hint="Clear the filters to inspect all five providers."
        >
          <Button
            onClick={() => {
              setSearch("");
              setFilter("all");
            }}
          >
            Clear filters
          </Button>
        </EmptyState>
      )}
      <div class="af-provider-cards">
        {rows.map((provider) => (
          <article
            class="af-provider-card"
            key={provider.provider}
            aria-label={provider.name}
          >
            <header>
              <ProviderMonogram provider={provider.provider} />
              <h2>{provider.name}</h2>
              <Tag tone="outline">{readinessLabel(provider.state)}</Tag>
            </header>
            <dl>
              <dt>CLI</dt>
              <dd>
                {provider.installation.found
                  ? `${provider.installation.version ?? "Version not reported"} · ${provider.installation.versionOk ? "version answered" : "version check failed"}`
                  : "Not found"}
              </dd>
              <dt>Path</dt>
              <dd>
                <code>{provider.installation.path ?? "—"}</code>
              </dd>
              <dt>Sign-in</dt>
              <dd>
                {provider.authentication.mode === "unknown"
                  ? "Not reported"
                  : provider.authentication.mode === "signed-in"
                    ? "Saved credentials reported"
                    : provider.authentication.mode === "signed-out"
                      ? "Signed out"
                      : provider.authentication.mode === "api-key"
                        ? "API key"
                        : "Subscription"}
              </dd>
              <dt>Adapter</dt>
              <dd>
                {provider.adapter.supported ? "Registered" : "Unavailable"}
              </dd>
              <dt>Last doctor check</dt>
              <dd>
                <time dateTime={provider.installation.checkedAt}>
                  {new Date(provider.installation.checkedAt).toLocaleString()}
                </time>{" "}
                · version only
              </dd>
            </dl>
            {[
              provider.installation.reason,
              provider.authentication.reason,
              provider.adapter.reason,
            ]
              .filter(Boolean)
              .map((reason) => (
                <p class="af-provider-muted" key={reason}>
                  {reason}
                </p>
              ))}
            {(provider.stale || stale) && (
              <p role="status">
                Last-known observation; recheck before relying on it.
              </p>
            )}
            <h3>Usage</h3>
            <p>{provider.usageReason}</p>
            {provider.usage.map((report) => (
              <div class="af-provider-measure" key={report.id}>
                <strong>{report.label}</strong>
                <span>
                  {value(report.used, report.unit)} used
                  {report.remaining === null
                    ? ""
                    : ` · ${value(report.remaining, report.unit)} remaining`}
                  {report.stale ? " · Stale" : ""}
                </span>
                {report.percentUsed !== null &&
                  report.kind !== "local-counted" && (
                    <progress
                      max={100}
                      value={report.percentUsed}
                      aria-label={`${provider.name} ${report.label} percent used`}
                    />
                  )}
                <small>
                  {report.source} ·{" "}
                  {report.observedAt
                    ? new Date(report.observedAt).toLocaleString()
                    : "Time unknown"}{" "}
                  ·{" "}
                  {report.resetAt
                    ? `Resets ${new Date(report.resetAt).toLocaleString()}`
                    : "Reset not reported"}
                </small>
                {report.reason && <p>{report.reason}</p>}
              </div>
            ))}
            {!provider.usage.length && (
              <p>
                Usage — no account allowance or local session totals reported.
              </p>
            )}
            <h3>Models and smiths</h3>
            {provider.smiths.length ? (
              <ul>
                {provider.smiths.map((smith) => (
                  <li key={smith.name}>
                    {smith.name} · {smith.model}
                    {smith.enabled ? "" : " · Disabled"}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No configured smiths.</p>
            )}
            <div class="af-provider-controls">
              <Button
                onClick={() => {
                  if (!checking && writesAllowed)
                    void doctor(provider.provider);
                }}
                disabled={checking || !writesAllowed}
              >
                Run doctor · {provider.name}
              </Button>
              <ProviderSignIn
                provider={provider}
                client={logins}
                writesAllowed={writesAllowed}
              />
            </div>
            <p class="af-provider-muted">
              {provider.signIn.command ? (
                <>
                  Vendor sign-in command: <code>{provider.signIn.command}</code>
                  . Sign-in and rechecking are separate steps.
                </>
              ) : (
                provider.signIn.reason
              )}
            </p>
          </article>
        ))}
      </div>
      <section class="af-provider-room" aria-label="Usage by project">
        <h2>Counted locally by project</h2>
        {data.localUsage.projects?.map((project) => (
          <ProjectProviderUsage
            key={project.projectId}
            projectId={project.projectId}
            data={data}
            stale={stale}
          />
        )) ?? <p>Project usage attribution unavailable.</p>}
      </section>
    </div>
  );
}

function ProviderSignIn({
  provider,
  client,
  writesAllowed,
}: {
  provider: ProviderReadiness;
  client: ProviderLoginClient | null;
  writesAllowed: boolean;
}) {
  const supported =
    provider.provider === "claude" || provider.provider === "codex";
  const view = supported
    ? client?.get(provider.provider === "claude" ? "claude" : "codex")
    : null;
  const id = provider.provider === "claude" ? "claude" : "codex";
  return (
    <div
      class="af-provider-login"
      role="group"
      aria-label={`${provider.name} sign-in controls`}
    >
      <Button
        disabled={
          !supported ||
          !provider.signIn.nativeAvailable ||
          !writesAllowed ||
          !view?.ready ||
          view.busy ||
          !!view.identity
        }
        onClick={() => {
          if (supported) void client?.start(id);
        }}
        title={
          provider.signIn.reason ??
          "Open the vendor's own sign-in terminal. Run doctor separately afterward."
        }
      >
        Sign in… · {provider.name}
      </Button>
      {view?.identity && (
        <>
          <Button
            disabled={view.busy}
            onClick={() => {
              void client?.check(id);
            }}
          >
            Check original sign-in
          </Button>
          <Button
            disabled={!writesAllowed || view.busy}
            onClick={() => {
              void client?.retry(id);
            }}
          >
            Retry original sign-in
          </Button>
          <Button
            disabled={!writesAllowed || view.busy}
            onClick={() => {
              void client?.stop(id);
            }}
          >
            Close sign-in terminal
          </Button>
        </>
      )}
      {view?.notice && <p role="status">{view.notice}</p>}
      {provider.signIn.nativeAvailable && !view?.ready && (
        <p role="status">
          Reading original sign-in attempts before another terminal can open.
        </p>
      )}
      {provider.signIn.reason && <p>{provider.signIn.reason}</p>}
    </div>
  );
}
