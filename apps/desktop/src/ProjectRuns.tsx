import { useLayoutEffect, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type {
  ProjectRunDetail,
  ProjectRunGate,
} from "../../../types/project-runs";
import { KeeperMarkdown } from "./KeeperMarkdown";
import { activityHref, emptyActivityFilters } from "./project-activity-model";
import type { ProjectCouncilSourcePrefill } from "./project-council-draft";
import type { ProjectRunsView } from "./project-runs-client";
import {
  emptyRunFilters,
  filterRuns,
  gateCheckRows,
  phaseName,
  type RunFilters,
  runStatus,
  runsHref,
} from "./project-runs-model";
import type { ProjectRunsController } from "./use-project-runs";
import "./project-runs.css";

const time = (value: string | null) =>
  value ? (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  ) : (
    <span title="The run file did not record an update time.">
      Not reported
    </span>
  );
const mode = (value: string) =>
  value === "auto" ? "Unattended (historical)" : "Gated";

/** Loading and error are distinct from a verified empty list, including during background reads. */
export function RunReadStatus({ view }: { view: ProjectRunsView | null }) {
  return (
    <>
      {view?.error && (
        <p role="alert" class="af-runs-error">
          {view.error}
          {view.page &&
            " The last verified run metadata remains visible; it may be out of date."}
        </p>
      )}
      {(!view || view.loading || (!view.page && !view.error)) && (
        <div role="status" aria-live="polite" class="af-runs-loading">
          <span>
            {view?.page ? "Checking project runs…" : "Loading project runs…"}
          </span>
          {!view?.page && (
            <span aria-hidden="true" class="af-runs-skeleton">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
      )}
    </>
  );
}

export function ProjectRuns({
  projectId,
  controller,
  onCouncilArtifactPrefill,
  filters,
  filterError,
  onFilter,
}: {
  projectId: string;
  controller: ProjectRunsController;
  onCouncilArtifactPrefill?: (
    source: ProjectCouncilSourcePrefill,
    workspace: string,
  ) => void;
  filters: RunFilters | null;
  filterError: string;
  onFilter(filters: RunFilters): void;
}) {
  const { view, client } = controller;
  const filterKey = JSON.stringify(filters);
  const [draft, setDraft] = useState(filters ?? emptyRunFilters());
  useLayoutEffect(() => {
    setDraft(filters ?? emptyRunFilters());
  }, [filterKey]);
  const selected = view?.selectedSlug ?? null;
  const rows = filters ? filterRuns(view?.page?.runs ?? [], filters) : [];
  const filtered =
    !!filters && !!(filters.search || filters.health || filters.mode);
  return (
    <section class="af-project-runs" aria-label="Project forge runs">
      <header class="af-runs-heading">
        <div>
          <h2>{selected ? "Run inspection" : "Forge runs"}</h2>
          <p>Recorded phases, reviews and gates from this served checkout.</p>
        </div>
        <div class="af-runs-actions">
          <Button
            aria-disabled={!client || !!view?.loading}
            onClick={() => {
              if (client && !view?.loading) void client.refresh();
            }}
          >
            Refresh runs
          </Button>
          <Button
            disabled
            title="Starting a forge run is not available in this inspection view."
          >
            New forge run
          </Button>
        </div>
      </header>
      <p class="af-runs-note">
        Inspection only. Run launch, checkpoint actions and correlated sessions
        are not available here.
      </p>
      <RunReadStatus view={view} />
      {view?.page?.problems.map((problem, index) => (
        <p class="af-runs-notice" key={`${index}:${problem}`}>
          {problem}
        </p>
      ))}
      {selected ? (
        <>
          <Button
            href={runsHref(projectId, null, filters ?? emptyRunFilters())}
          >
            All runs
          </Button>
          {view?.detailLoading && <p role="status">Verifying selected run…</p>}
          {view?.detailError && (
            <p role="alert" class="af-runs-error">
              {view.detailError}
              {view.detail && " Previously verified detail is retained."}
            </p>
          )}
          {view?.detailStale && (
            <p role="status">
              This detail has not been verified against the latest run read.
              Refresh runs to check it again.
            </p>
          )}
          {view?.detail && (
            <>
              <RunDetail
                projectId={projectId}
                detail={view.detail}
                canOpenArtifacts={
                  !view.loading &&
                  !view.error &&
                  !view.detailLoading &&
                  !view.detailStale &&
                  view.detail.workspace === view.page?.workspace
                }
                onOpenArtifact={(kind) => client?.openArtifact(kind)}
                onCouncilArtifactPrefill={(_kind, source) => {
                  const workspace = view.detail?.workspace;
                  if (
                    workspace &&
                    view.page?.workspace === workspace &&
                    !view.detailStale &&
                    !view.detailLoading &&
                    !view.error
                  )
                    onCouncilArtifactPrefill?.(source, workspace);
                }}
              />
              {view.artifactKind && (
                <section
                  aria-label="Verified run artifact"
                  class="af-run-artifact-view"
                >
                  <h3>{phaseName(view.artifactKind)} artifact</h3>
                  {view.artifactLoading && (
                    <p role="status">Reading the recorded artifact…</p>
                  )}
                  {view.artifactError && (
                    <p role="alert" class="af-runs-error">
                      {view.artifactError}
                      {view.artifact &&
                        " The last verified contents remain visible and may be out of date."}
                    </p>
                  )}
                  {view.artifactStale && view.artifact && (
                    <p role="status">
                      These are the last verified contents; read the artifact
                      again to verify the current file.
                    </p>
                  )}
                  {view.artifact && (
                    <KeeperMarkdown text={view.artifact.content} />
                  )}
                </section>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <form
            class="af-runs-filters"
            onSubmit={(event) => {
              event.preventDefault();
              onFilter(draft);
            }}
          >
            <label>
              Find runs
              <input
                type="search"
                aria-label="Find runs"
                maxLength={200}
                value={draft.search}
                onInput={(event) =>
                  setDraft({ ...draft, search: event.currentTarget.value })
                }
              />
            </label>
            <label>
              Recorded state
              <select
                aria-label="Run state"
                value={draft.health ?? ""}
                onChange={(event) => {
                  const health = event.currentTarget.value;
                  if (
                    health === "" ||
                    health === "running" ||
                    health === "attention" ||
                    health === "shipped"
                  )
                    setDraft({ ...draft, health: health || null });
                }}
              >
                <option value="">All recorded states</option>
                <option value="running">Running</option>
                <option value="attention">Needs attention</option>
                <option value="shipped">Shipped</option>
              </select>
            </label>
            <label>
              Recorded mode
              <select
                aria-label="Run mode"
                value={draft.mode ?? ""}
                onChange={(event) => {
                  const mode = event.currentTarget.value;
                  if (mode === "" || mode === "gated" || mode === "auto")
                    setDraft({ ...draft, mode: mode || null });
                }}
              >
                <option value="">All recorded modes</option>
                <option value="gated">Gated</option>
                <option value="auto">Unattended (historical)</option>
              </select>
            </label>
            <button type="submit" class="af-btn af-btn-secondary">
              Apply run filters
            </button>
            <Button onClick={() => onFilter(emptyRunFilters())}>
              Clear run filters
            </Button>
          </form>
          {filterError && (
            <p role="alert" class="af-runs-error">
              {filterError}
            </p>
          )}
          {!filterError &&
            view?.page &&
            (rows.length ? (
              <div class="af-runs-table-wrap">
                <table aria-label="Recorded forge runs">
                  <thead>
                    <tr>
                      <th scope="col">Run</th>
                      <th scope="col">State</th>
                      <th scope="col">Mode</th>
                      <th scope="col">Route</th>
                      <th scope="col">Started</th>
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((run) => (
                      <tr key={run.slug}>
                        <th scope="row">
                          <a
                            href={runsHref(
                              projectId,
                              run.slug,
                              filters ?? emptyRunFilters(),
                            )}
                          >
                            {run.feature ?? run.slug}
                          </a>
                          <small>
                            <code>{run.slug}</code> · {run.completedCount}/4
                            phases complete
                          </small>
                        </th>
                        <td>
                          {runStatus(run)}
                          {run.gatePassed === false && (
                            <small class="af-run-fail">Gate failed</small>
                          )}
                        </td>
                        <td>{mode(run.mode)}</td>
                        <td>
                          <span title="Run type (Full or Mini) is not reported.">
                            —
                          </span>
                        </td>
                        <td>
                          <span title="Run start time is not reported.">—</span>
                        </td>
                        <td>{time(run.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : !view.loading && !view.error ? (
              <div class="af-runs-empty">
                <h3>
                  {filtered
                    ? "No runs match these filters"
                    : "No forge runs in this served checkout"}
                </h3>
                <p>
                  {filtered
                    ? "Clear or change the search, recorded state or mode filters."
                    : "No scoped run files were reported. Other checkouts and legacy run files are outside this read."}
                </p>
              </div>
            ) : null)}
          {view?.page && (
            <p class="af-runs-note">
              {rows.length} of {view.page.runs.length} recorded runs. Route and
              start time are not reported by these files.
            </p>
          )}
        </>
      )}
      {view?.page && (
        <footer class="af-runs-source">
          <p>
            Coverage: served checkout only. Runs in other checkouts are not
            included.
          </p>
          <p>
            Checkout <code>{view.page.checkout}</code>
          </p>
          <p>Last verified {time(view.page.asOf)}</p>
        </footer>
      )}
    </section>
  );
}

export function RunGateChecks({ gate }: { gate: ProjectRunGate | null }) {
  return (
    <table aria-label="Gate checks" class="af-run-gate-checks">
      <thead>
        <tr>
          <th scope="col">Check</th>
          <th scope="col">Recorded result</th>
          <th scope="col">Detail</th>
        </tr>
      </thead>
      <tbody>
        {gateCheckRows(gate).map((check, index) => (
          <tr key={`${index}:${check.name}`}>
            <th scope="row">{check.name}</th>
            <td class={check.state === "Fail" ? "af-run-fail" : undefined}>
              {check.state}
            </td>
            <td>
              {check.detail ??
                (check.state === "Not run"
                  ? "No matching check was recorded."
                  : "No detail reported.")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunDetail({
  projectId,
  detail,
  canOpenArtifacts = true,
  onOpenArtifact,
  onCouncilArtifactPrefill,
}: {
  projectId: string;
  detail: ProjectRunDetail;
  canOpenArtifacts?: boolean;
  onOpenArtifact?(kind: "research" | "plan" | "ship"): void;
  onCouncilArtifactPrefill?(
    kind: "research" | "plan" | "ship",
    source: ProjectCouncilSourcePrefill,
  ): void;
}) {
  const run = detail.run;
  const latest = detail.gateHistory[0] ?? null;
  return (
    <article class="af-run-detail" aria-label="Selected forge run">
      <header>
        <h3>{run.feature ?? run.slug}</h3>
        <p>
          <code>{run.slug}</code> · {runStatus(run)}
        </p>
        <Button
          href={activityHref(projectId, {
            ...emptyActivityFilters(),
            runId: run.slug,
          })}
        >
          Open run Activity
        </Button>
      </header>
      <dl class="af-run-facts">
        <div>
          <dt>Recorded mode</dt>
          <dd>{mode(run.mode)}</dd>
        </div>
        <div>
          <dt>Epic</dt>
          <dd>{run.epic}</dd>
        </div>
        <div>
          <dt>Route</dt>
          <dd>
            — <small>Full or Mini is not recorded.</small>
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>
            — <small>Start time is not recorded.</small>
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{time(run.updatedAt)}</dd>
        </div>
      </dl>
      <section aria-label="Run phases">
        <h4>Phases</h4>
        <ol class="af-run-phases">
          {run.phases.map((phase) => (
            <li key={phase.id} data-phase={phase.id} data-state={phase.state}>
              <h5>{phaseName(phase.id)}</h5>
              <p>{phaseName(phase.state)}</p>
              {phase.state === "active" && run.gatePassed === false && (
                <p class="af-run-fail">Gate failed</p>
              )}
              {phase.artifact && (
                <p class="af-run-artifact">
                  <code>{phase.artifact}</code>
                  {phase.artifactMissing && (
                    <small>Recorded artifact is missing.</small>
                  )}
                </p>
              )}
              {phase.artifact &&
                (phase.state === "complete" &&
                (phase.id === "research" ||
                  phase.id === "plan" ||
                  phase.id === "ship") ? (
                  <>
                    <Button
                      disabled={!canOpenArtifacts}
                      onClick={() => {
                        if (
                          phase.id === "research" ||
                          phase.id === "plan" ||
                          phase.id === "ship"
                        )
                          onOpenArtifact?.(phase.id);
                      }}
                    >
                      Read {phaseName(phase.id).toLowerCase()} artifact
                    </Button>
                    <small>
                      Artifact contents are unavailable until explicitly opened.
                    </small>
                  </>
                ) : (
                  <small>
                    Artifact contents are available after this phase is
                    complete.
                  </small>
                ))}
              {phase.state === "complete" &&
                !phase.artifactMissing &&
                phase.artifact &&
                (phase.id === "research" ||
                  phase.id === "plan" ||
                  phase.id === "ship") &&
                (() => {
                  const expected =
                    phase.id === "research"
                      ? `plans/research/${run.slug}.md`
                      : phase.id === "plan"
                        ? `plans/drafts/${run.slug}.md`
                        : `reports/${run.slug}-ship.md`;
                  if (phase.artifact !== expected) return null;
                  const kind = phase.id;
                  const sourceType = kind === "plan" ? "plan" : "file";
                  const label = phaseName(kind).toLowerCase();
                  return (
                    <>
                      <Button
                        aria-label={`Review ${label} artifact in Council`}
                        disabled={!canOpenArtifacts}
                        onClick={() =>
                          onCouncilArtifactPrefill?.(kind, {
                            sourceType,
                            source: expected,
                          })
                        }
                      >
                        Review in Council
                      </Button>
                      <small>
                        This opens a draft from the recorded artifact; it does
                        not complete or change a checkpoint.
                      </small>
                    </>
                  );
                })()}
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="Run gate history">
        <h4>Gate history</h4>
        <p class="af-runs-note">
          Up to 30 retained log-date folders · latest matching gate and up to 10
          earlier entries. Gaps or older history may be absent.
        </p>
        <p>
          Only matching run and checkout records are shown. Unlinked gate
          entries cannot establish this run's result.
        </p>
        {!latest && <p>No matching gate was recorded in the retained logs.</p>}
        {latest && (
          <p>
            <strong>
              {latest.link === "legacy" ? "Legacy record" : "Linked gate"}:{" "}
              {latest.passed ? "Pass" : "Fail"}
            </strong>{" "}
            · {time(latest.timestamp)}
            {latest.link === "legacy" && (
              <small>
                Legacy metadata does not confirm a linked gate or evaluator for
                this run.
              </small>
            )}
          </p>
        )}
        <div class="af-runs-table-wrap">
          <RunGateChecks gate={latest} />
        </div>
        {latest?.evaluatorEvidence && (
          <p>
            Evaluator evidence:{" "}
            {latest.evaluatorEvidence === "schema-2"
              ? "recorded schema-2 binding"
              : "legacy; this run's evaluator was not bound"}
            .
          </p>
        )}
        {detail.gateHistory.slice(1).map((gate, index) => (
          <details key={`${index}:${gate.timestamp}`}>
            <summary>
              Earlier gate · {gate.link === "legacy" ? "Legacy" : "Linked"} ·{" "}
              {gate.passed ? "Pass" : "Fail"} · {time(gate.timestamp)}
            </summary>
            <div class="af-runs-table-wrap">
              <RunGateChecks gate={gate} />
            </div>
          </details>
        ))}
      </section>
      <section aria-label="Run review rounds">
        <h4>Review rounds</h4>
        {detail.reviews.length ? (
          <ol class="af-run-reviews">
            {detail.reviews.map((review, index) => (
              <li key={`${index}:${review.phase}:${review.round}`}>
                <h5>
                  {phaseName(review.phase)} · Round {review.round} ·{" "}
                  {review.verdict}
                </h5>
                <p>{time(review.at)}</p>
                <p>
                  Blocker {review.findings.blocker} · High{" "}
                  {review.findings.high} · Medium {review.findings.medium} · Low{" "}
                  {review.findings.low}
                </p>
                <p class="af-run-review-summary">
                  {review.summary ?? "No review summary was recorded."}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p>No review rounds were recorded.</p>
        )}
      </section>
      {detail.problems.map((problem, index) => (
        <p class="af-runs-notice" key={`${index}:${problem}`}>
          {problem}
        </p>
      ))}
      <p class="af-runs-note">Detail last verified {time(detail.asOf)}</p>
    </article>
  );
}
