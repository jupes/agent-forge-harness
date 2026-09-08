import type { CouncilServiceJob } from "../../../scripts/council/service";
import { CouncilDiscussion } from "./CouncilDiscussion";

function money(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "Not reported";
}

function download(name: string, value: string, type: string): void {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function CouncilResult({ job }: { job: CouncilServiceJob }) {
  const run = job.run;
  const active = job.status === "running" || job.status === "cancelling";
  return (
    <section className="panel" aria-live="polite">
      <div className="run-meta">
        <span className={`pill${job.status === "failed" ? " warning" : ""}`}>
          {job.status}
        </span>
        <span>{job.runId}</span>
        {run && (
          <span>
            Accounted cost: {money(run.accountedCostUsd)}
            {run.costIsEstimate ? " (estimate)" : ""}
          </span>
        )}
      </div>
      {active && (
        <p className="round-label">
          The council is deliberating. Each round waits for its participants
          before sharing results.
        </p>
      )}
      {job.error && <p className="notice error">{job.error}</p>}
      {job.persistenceError && (
        <p className="notice error">
          The review completed, but its normal artifacts could not be saved:{" "}
          {job.persistenceError}
        </p>
      )}
      <CouncilDiscussion
        key={job.runId}
        rounds={job.discussion ?? run?.discussion ?? []}
      />
      {run && (
        <>
          <h2>
            {run.chair?.verdict.replaceAll("_", " ") ?? "Review incomplete"}
          </h2>
          <p>{run.chair?.summary ?? run.error}</p>
          {(run.limitations?.length ?? 0) > 0 && (
            <div className="notice">
              <h3>Review limitations</h3>
              <ul>
                {run.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {(run.chair?.recommendations.length ?? 0) > 0 && (
            <ul className="recommendations">
              {run.chair?.recommendations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <div>
            {run.aggregatedFindings.map((finding) => (
              <article className="finding" key={finding.key}>
                <h3>{finding.title}</h3>
                <div className="finding-meta">
                  <span className="pill warning">{finding.severity}</span>
                  <span>
                    {finding.resolution ??
                      (finding.contested ? "contested" : "reviewed")}
                  </span>
                  <span>
                    {finding.support} support · {finding.oppose} oppose ·{" "}
                    {finding.uncertain} uncertain
                  </span>
                  <span>
                    Confidence: {Math.round(finding.confidence * 100)}%
                  </span>
                </div>
                <p>{finding.claim}</p>
                <p className="muted">{finding.consequence}</p>
                <p className="muted">
                  Evidence: {finding.evidenceIds.join(", ")}
                </p>
                {finding.rationales?.length > 0 && (
                  <details>
                    <summary>Why reviewers agreed or objected</summary>
                    {finding.rationales.map((rationale, index) => (
                      <p key={`${rationale.reviewerLabel}-${index}`}>
                        <strong>
                          {rationale.reviewerLabel} · {rationale.stance}:
                        </strong>{" "}
                        {rationale.reason}
                      </p>
                    ))}
                  </details>
                )}
              </article>
            ))}
          </div>
          {run.failures.length > 0 && (
            <details open>
              <summary>Provider failures and reduced participation</summary>
              {run.failures.map((failure, index) => (
                <p key={`${failure.seatId}-${index}`}>
                  {failure.seatId} / {failure.stage}: {failure.error}
                </p>
              ))}
            </details>
          )}
          <details>
            <summary>Supplied evidence</summary>
            {run.context.evidence?.map((item) => (
              <div key={item.id}>
                <h3>
                  {item.id}: {item.title}
                </h3>
                <pre>
                  {item.content
                    .split("\n")
                    .map((line, index) => `${index + 1}: ${line}`)
                    .join("\n")}
                </pre>
              </div>
            ))}
          </details>
          <details>
            <summary>Full review transcript</summary>
            {run.records.map((record, index) => (
              <div key={`${record.seatId}-${index}`}>
                <h3>
                  {record.stage}
                  {record.round ? ` ${record.round}` : ""} · {record.seatId} ·{" "}
                  {record.model}
                </h3>
                <p className="muted">
                  {(record.latencyMs / 1000).toFixed(1)} seconds ·{" "}
                  {record.usage
                    ? `${record.usage.inputTokens} input / ${record.usage.outputTokens} output tokens`
                    : "Usage not reported"}
                </p>
                {record.routing && (
                  <p className="muted">
                    Served by: {record.routing.provider ?? "not reported"} ·{" "}
                    {record.routing.model ?? record.model}
                    {record.routing.byok ? " · BYOK" : ""}
                  </p>
                )}
                <pre>
                  {JSON.stringify(record.output ?? record.error, null, 2)}
                </pre>
              </div>
            ))}
          </details>
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                download(
                  `${job.runId}.json`,
                  JSON.stringify(run, null, 2),
                  "application/json",
                )
              }
            >
              Download review
            </button>
            <span className="muted">
              Actual billed cost: {money(run.actualCostUsd)}
            </span>
          </div>
        </>
      )}
      <details>
        <summary>Round activity ({job.events.length})</summary>
        <pre>
          {job.events
            .map(
              (event) =>
                `${event.seq + 1}. ${event.type} ${JSON.stringify(event.payload)}`,
            )
            .join("\n") || "Preparing source and profile…"}
        </pre>
      </details>
    </section>
  );
}
