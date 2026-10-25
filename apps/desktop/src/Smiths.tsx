import { useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { APPRENTICE_VERIFICATION } from "../../../scripts/smith-verification";
import type { ScoreboardRow } from "../../../types/hearth";
import { PROVIDER_USAGE_COUNTS } from "../../../types/hearth";
import {
  SmithCreateFormView,
  SmithCreateReceiptsView,
} from "./SmithCreateForm";
import { SmithVerificationTask } from "./SmithVerificationTask";
import { SCOREBOARD_RANGES } from "./smiths-client";
import { metric, scoreboardKey } from "./smiths-model";
import type { useSmithCreate } from "./use-smith-create";
import type { SmithsController } from "./use-smiths";
import "./smiths.css";

const sourceLabel = (source: string | null) =>
  source === "builtin"
    ? "Built-in"
    : source
      ? "Config file"
      : "Source not separately recorded";
function Source({ source }: { source: string | null }) {
  return (
    <small
      class="af-smith-source"
      title={source ?? "This field's source was not separately reported."}
    >
      {sourceLabel(source)}
    </small>
  );
}
function NumberValue({
  value,
  kind = "count",
  reason = "No value was recorded in this range.",
}: {
  value: number | null | undefined;
  kind?: "count" | "usd" | "percent";
  reason?: string;
}) {
  return (
    <span title={value === null || value === undefined ? reason : undefined}>
      {metric(value, kind)}
    </span>
  );
}
function RecordedMetrics({ row }: { row: ScoreboardRow }) {
  const values: [
    string,
    number | null | undefined,
    "count" | "usd" | "percent",
  ][] = [
    ["Forge runs", row.runs, "count"],
    ["Sessions started", row.sessions.started, "count"],
    ["Sessions ended", row.sessions.ended, "count"],
    ["Sessions completed", row.sessions.completed, "count"],
    ["Sessions failed", row.sessions.failed, "count"],
    ["Sessions timed out", row.sessions.timedOut, "count"],
    ["Sessions stopped", row.sessions.stopped, "count"],
    ["Other recorded endings", row.sessions.other, "count"],
    ["Gates run", row.gates.ran, "count"],
    ["Gates passed", row.gates.passed, "count"],
    ["Gates failed", row.gates.failed, "count"],
    ["Gate pass rate", row.gates.passRate, "percent"],
    ["Evaluator passes", row.verdicts.pass, "count"],
    ["Evaluator failures", row.verdicts.fail, "count"],
    ["Unreadable evaluator verdicts", row.verdicts.unreadable, "count"],
    ["Review rounds", row.reviews.rounds, "count"],
    ["Review passes", row.reviews.pass, "count"],
    ["Review failures", row.reviews.fail, "count"],
    ["Unreadable reviews", row.reviews.unreadable, "count"],
    ...Object.entries(row.reviews.findings).map(
      ([key, count]) =>
        [`Review findings · ${key}`, count, "count"] satisfies [
          string,
          number,
          "count",
        ],
    ),
    ["Council runs started", row.council.started, "count"],
    ["Council runs finished", row.council.finished, "count"],
    ["Council passes", row.council.pass, "count"],
    ["Council failures", row.council.fail, "count"],
    ["Unreadable councils", row.council.unreadable, "count"],
    ["Cancelled councils", row.council.cancelled, "count"],
    ["Reported council cost", row.council.costUsd, "usd"],
    ["Council runs reporting cost", row.council.runsWithCost, "count"],
    ["Council runs reporting findings", row.council.runsWithFindings, "count"],
    ...(["blocker", "high", "medium", "low"] as const).map(
      (key) =>
        [
          `Council findings · ${key}`,
          row.council.findings?.[key],
          "count",
        ] satisfies [string, number | undefined, "count"],
    ),
    ["Sessions reporting usage", row.usage.sessions, "count"],
    ["Reported session cost", row.usage.costUsd, "usd"],
    ["Sessions reporting cost", row.usage.sessionsWithCost, "count"],
    ...PROVIDER_USAGE_COUNTS.map(
      (key) =>
        [key, row.usage.tokens[key], "count"] satisfies [
          string,
          number | undefined,
          "count",
        ],
    ),
  ];
  return (
    <dl class="af-smith-metrics">
      {values.map(([label, value, kind]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            <NumberValue value={value} kind={kind} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Smiths({
  controller,
  creates,
  workspace,
}: {
  controller: SmithsController;
  creates: ReturnType<typeof useSmithCreate>;
  workspace: string | null;
}) {
  const [search, setSearch] = useState("");
  const [enabled, setEnabled] = useState("all");
  const [boardPage, setBoardPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const createOpener = useRef<HTMLElement>(null);
  const { client, view } = controller;
  const config = view?.configuration,
    board = view?.scoreboard;
  const query = search.trim().toLowerCase();
  const matches = (...values: string[]) =>
    values.join(" ").toLowerCase().includes(query);
  const smiths =
    config?.data?.smiths.filter(
      (row) =>
        matches(
          row.name,
          row.provider,
          row.model,
          row.effort,
          row.rank ?? "",
          ...row.tags,
        ) &&
        (enabled === "all" || row.enabled === (enabled === "enabled")),
    ) ?? [];
  const scoreboard =
    board?.data?.rows.filter((row) =>
      matches(
        row.executor?.smith ?? "No smith recorded",
        row.executor?.provider ?? "Provider not recorded",
        row.executor?.model ?? "Model not recorded",
      ),
    ) ?? [];
  const lastPage = Math.max(0, Math.ceil(scoreboard.length / 50) - 1),
    page = Math.min(boardPage, lastPage);
  const boardStale = Boolean(
    board?.data &&
      (board.error || board.loading || view?.range !== view?.scoreboardRange),
  );
  return (
    <div class="af-smiths">
      <div class="af-smith-heading">
        <div>
          <h2>Workspace inspection</h2>
          <p>
            Saved choices and recorded work from this hearth. These values do
            not change when you switch projects.
          </p>
          <p class="af-smith-path">
            {workspace ??
              "Workspace path unavailable; reads are from the current hearth."}
          </p>
        </div>
        <div class="af-smith-actions">
          <Button
            onClick={() => {
              createOpener.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null;
              setCreateOpen(true);
            }}
          >
            New smith
          </Button>
          <Button
            disabled
            title="Configuration editing is unavailable in this inspection view."
          >
            Edit configuration
          </Button>
        </div>
      </div>
      <p class="af-smith-note">
        Creating a Smith uses a complete candidate review and explicit save.
        Editing existing configuration remains unavailable here; inspection and
        review never start a provider.
      </p>
      <Dialog
        open={createOpen}
        title="Create a Smith"
        onClose={() => setCreateOpen(false)}
        returnFocusRef={createOpener}
        class="af-smith-create-dialog"
        actions={
          <Button onClick={() => setCreateOpen(false)}>Close review</Button>
        }
      >
        <SmithCreateFormView
          state={creates.state}
          canWrite={creates.canWrite}
          canStart={creates.client.canStart()}
          onDraft={(target, smith) => creates.client.setDraft(target, smith)}
          onPreview={() => void creates.client.preview()}
          onCreate={() => void creates.client.create()}
        />
      </Dialog>
      <div class="af-smith-filters">
        <label>
          Filter smiths and scoreboard
          <input
            value={search}
            onInput={(event) => {
              setSearch(event.currentTarget.value);
              setBoardPage(0);
            }}
            type="search"
          />
        </label>
        <label>
          Configured smith status
          <select
            value={enabled}
            onChange={(event) => setEnabled(event.currentTarget.value)}
          >
            <option value="all">All configured smiths</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        {(search || enabled !== "all") && (
          <Button
            onClick={() => {
              setSearch("");
              setEnabled("all");
              setBoardPage(0);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <SmithCreateReceiptsView
        entries={creates.state.entries}
        canWrite={creates.canWrite}
        onCheck={(requestId) => void creates.client.check(requestId)}
      />
      <section
        aria-label="Saved smith configuration"
        class="af-smith-panel"
        aria-busy={config?.loading ?? true}
      >
        <div class="af-smith-heading">
          <h2>Saved smiths</h2>
          <Button
            aria-disabled={config?.loading ?? true}
            onClick={() => {
              if (!config?.loading) void client?.refreshConfiguration();
            }}
          >
            Refresh configuration
          </Button>
        </div>
        {config?.error && (
          <p role="alert">
            Configuration could not be verified. {config.error}{" "}
            {config.data
              ? "Last-verified values remain visible."
              : "No saved values are available."}
          </p>
        )}
        {!config?.data ? (
          <EmptyState
            title={
              config?.error
                ? "Saved smiths unavailable"
                : "Reading saved smiths…"
            }
            hint={
              config?.error
                ? "Fix the configuration error, then retry. Existing values have not been changed."
                : "Reading named smiths and their field sources."
            }
          >
            <Button
              aria-disabled={config?.loading ?? true}
              onClick={() => {
                if (!config?.loading) void client?.refreshConfiguration();
              }}
            >
              Retry configuration
            </Button>
          </EmptyState>
        ) : (
          <>
            <p class="af-smith-note">
              {config.error || config.loading
                ? "Last-verified configuration"
                : "Read from configuration"}{" "}
              ·{" "}
              <time dateTime={config.checkedAt ?? undefined}>
                {config.checkedAt
                  ? new Date(config.checkedAt).toLocaleString()
                  : "Read time unavailable"}
              </time>
            </p>
            <p>
              <strong>Saved default:</strong>{" "}
              <code>{config.data.defaultSmith}</code>{" "}
              <Source source={config.data.defaultSource} />. A bead, explicit
              choice or weighted bench can select a different smith; no
              selection is resolved here.
            </p>
            {config.data.smiths.length === 0 ? (
              <EmptyState
                title="No configured smiths were reported"
                hint="Refresh configuration to check the current saved choices."
              />
            ) : smiths.length === 0 ? (
              <EmptyState
                title="No smiths match these filters"
                hint="Clear the name or status filter to see saved smiths."
              />
            ) : (
              <div class="af-smith-table-wrap">
                <table aria-label="Configured smiths">
                  <thead>
                    <tr>
                      <th>Name and sources</th>
                      <th>Provider</th>
                      <th>Saved model</th>
                      <th>Effort</th>
                      <th>Rank and tags</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {smiths.map((row) => (
                      <tr key={row.name}>
                        <th scope="row">
                          <code>{row.name}</code>
                          <details>
                            <summary>Sources · {row.name}</summary>
                            <dl>
                              {row.fields.map((field) => (
                                <div key={field.key}>
                                  <dt>{field.key}</dt>
                                  <dd>
                                    {Array.isArray(field.value)
                                      ? field.value.join(", ") || "No tags"
                                      : String(field.value)}
                                    <br />
                                    <code>
                                      {field.source ??
                                        "Source not separately recorded"}
                                    </code>
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        </th>
                        <td>
                          {row.provider}
                          <Source
                            source={
                              row.fields.find(
                                (field) => field.key === "provider",
                              )?.source ?? null
                            }
                          />
                        </td>
                        <td>
                          <code>{row.model}</code>
                          <Source
                            source={
                              row.fields.find((field) => field.key === "model")
                                ?.source ?? null
                            }
                          />
                        </td>
                        <td>
                          {row.effort}
                          <Source
                            source={
                              row.fields.find((field) => field.key === "effort")
                                ?.source ?? null
                            }
                          />
                        </td>
                        <td>
                          {row.rank ?? "—"}
                          <small>{row.tags.join(", ") || "No tags"}</small>
                          <Source
                            source={
                              row.fields.find((field) => field.key === "tags")
                                ?.source ?? null
                            }
                          />
                        </td>
                        <td>
                          {row.enabled ? "Enabled" : "Disabled"}
                          <Source
                            source={
                              row.fields.find(
                                (field) => field.key === "enabled",
                              )?.source ?? null
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <details class="af-smith-files">
              <summary>Configuration files read</summary>
              {config.data.files.length ? (
                <ul>
                  {config.data.files.map((file) => (
                    <li key={file}>
                      <code>{file}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No config files were reported; these are built-in values.</p>
              )}
              <p>
                No target file is selected because this view cannot save
                changes. Environment overrides are excluded from these saved
                reads.
              </p>
            </details>
            <h3>Weighted benches</h3>
            <div class="af-smith-benches">
              {config.data.benches.map((bench) => (
                <article key={bench.name} aria-label={`${bench.name} bench`}>
                  <h4>{bench.name}</h4>
                  <Source source={bench.source} />
                  <div class="af-smith-weight-bar" aria-hidden="true">
                    {bench.entries.map((entry, index) => (
                      <span
                        key={`${entry.smith}:${index}`}
                        style={{ flexGrow: entry.percent }}
                      />
                    ))}
                  </div>
                  <ul>
                    {bench.entries.map((entry, index) => (
                      <li key={`${entry.smith}:${index}`}>
                        <code>{entry.smith}</code>
                        <span>
                          {entry.percent.toFixed(1)}% · weight {entry.weight}
                          {entry.enabled ? "" : " · Disabled"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <details>
                    <summary>Bench source</summary>
                    <code>
                      {bench.source ?? "Source not separately recorded"}
                    </code>
                  </details>
                </article>
              ))}
            </div>
            <aside class="af-smith-note">
              Apprentice effort support remains unverified. Verification task:{" "}
              <code>{APPRENTICE_VERIFICATION}</code>.{" "}
              <SmithVerificationTask
                key={workspace ?? "unavailable"}
                workspace={workspace}
              />{" "}
              These values do not certify live model support.
            </aside>
          </>
        )}
      </section>
      <section
        aria-label="Recorded workspace scoreboard"
        class="af-smith-panel"
        aria-busy={board?.loading ?? true}
        data-last-known={boardStale}
      >
        <div class="af-smith-heading">
          <div>
            <h2>Recorded scoreboard</h2>
            <p class="af-smith-note">
              Recorded event totals for this workspace. Configured models and
              recorded models are separate facts.
            </p>
          </div>
          <Button
            aria-disabled={board?.loading ?? true}
            onClick={() => {
              if (!board?.loading) void client?.refreshScoreboard();
            }}
          >
            Refresh scoreboard
          </Button>
        </div>
        <label class="af-smith-range">
          Recorded range
          <select
            value={view?.range ?? "7d"}
            onChange={(event) => {
              const range = SCOREBOARD_RANGES.find(
                (row) => row.id === event.currentTarget.value,
              );
              if (range) {
                setBoardPage(0);
                void client?.setRange(range.id);
              }
            }}
          >
            {SCOREBOARD_RANGES.map((range) => (
              <option value={range.id} key={range.id}>
                {range.label}
              </option>
            ))}
          </select>
        </label>
        {board?.error && (
          <p role="alert">
            Scoreboard could not be verified. {board.error}{" "}
            {board.data
              ? "Last-verified results remain visible."
              : "No recorded results are available."}
          </p>
        )}
        {!board?.data ? (
          <EmptyState
            title={
              board?.error ? "Scoreboard unavailable" : "Reading recorded work…"
            }
            hint="The configuration read is independent. Retry to check recorded totals."
          >
            <Button
              aria-disabled={board?.loading ?? true}
              onClick={() => {
                if (!board?.loading) void client?.refreshScoreboard();
              }}
            >
              Retry scoreboard
            </Button>
          </EmptyState>
        ) : (
          <>
            <p class="af-smith-note" role="status">
              {boardStale ? "Last-verified scoreboard" : "Recorded scoreboard"}{" "}
              ·{" "}
              {
                SCOREBOARD_RANGES.find(
                  (range) => range.id === view?.scoreboardRange,
                )?.label
              }{" "}
              · {board.data.events.toLocaleString()} recorded events ·{" "}
              <time dateTime={board.checkedAt ?? undefined}>
                {board.checkedAt
                  ? new Date(board.checkedAt).toLocaleString()
                  : "Read time unavailable"}
              </time>
            </p>
            <p class="af-smith-note">
              — means not reported in this range. Zero means a recorded zero.
              Costs include only reporting sessions or councils; no account
              allowance is inferred. Compacted ledger events are not included.
            </p>
            {board.data.rows.length === 0 ? (
              <EmptyState
                title="No recorded work in this range"
                hint="Choose another range or refresh after work has been recorded."
              />
            ) : scoreboard.length === 0 ? (
              <EmptyState
                title="No recorded rows match this filter"
                hint="Clear the name filter to see recorded rows."
              />
            ) : (
              <>
                <div class="af-smith-table-wrap">
                  <table aria-label="Recorded scoreboard rows">
                    <thead>
                      <tr>
                        <th>Recorded smith / provider / model</th>
                        <th>Started</th>
                        <th>Completed</th>
                        <th>Failed</th>
                        <th>Timed out</th>
                        <th>Gate pass rate</th>
                        <th>Reported session cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scoreboard
                        .slice(page * 50, page * 50 + 50)
                        .map((row) => (
                          <tr key={scoreboardKey(row)}>
                            <th scope="row">
                              <strong>
                                {row.executor?.smith ?? "No smith recorded"}
                              </strong>
                              <small>
                                {row.executor?.provider ??
                                  "Provider not recorded"}
                              </small>
                              <code>
                                {row.executor?.model ?? "Model not recorded"}
                              </code>
                              <details>
                                <summary>
                                  All metrics ·{" "}
                                  {row.executor?.smith ?? "No smith recorded"} ·{" "}
                                  {row.executor?.model ?? "unknown model"}
                                </summary>
                                <RecordedMetrics row={row} />
                              </details>
                            </th>
                            <td>{metric(row.sessions.started)}</td>
                            <td>{metric(row.sessions.completed)}</td>
                            <td>{metric(row.sessions.failed)}</td>
                            <td>{metric(row.sessions.timedOut)}</td>
                            <td>
                              <NumberValue
                                value={row.gates.passRate}
                                kind="percent"
                                reason="No gate was recorded in this range."
                              />
                            </td>
                            <td>
                              <NumberValue
                                value={row.usage.costUsd}
                                kind="usd"
                                reason="No session reported a cost in this range."
                              />
                              <small>
                                {row.usage.sessionsWithCost} sessions reported
                                cost
                              </small>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <div class="af-smith-pagination">
                  <Button
                    disabled={page === 0}
                    onClick={() => setBoardPage(page - 1)}
                  >
                    Previous rows
                  </Button>
                  <span>
                    {page * 50 + 1}–
                    {Math.min(scoreboard.length, page * 50 + 50)} of{" "}
                    {scoreboard.length} recorded rows
                  </span>
                  <Button
                    disabled={page >= lastPage}
                    onClick={() => setBoardPage(page + 1)}
                  >
                    Next rows
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
