import { useEffect, useState } from "preact/hooks";
import type { CouncilServiceJob } from "../../../scripts/council/service";
import type {
  CouncilProfile,
  CouncilSeat,
} from "../../../scripts/council/types";

const API = "/__agent-forge/council-api";
type ProfileChoice = Pick<
  CouncilProfile,
  "id" | "title" | "seats" | "chair" | "depth"
> & {
  path: string;
  readiness: {
    provider: string;
    configured: boolean;
    missing: string[];
    error?: string;
  }[];
};

async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(
    `${API}${path}`,
    input === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  const envelope = (await response.json()) as {
    ok: boolean;
    data: T;
    error: string | null;
  };
  if (!response.ok || !envelope.ok)
    throw new Error(envelope.error || "The council request failed.");
  return envelope.data;
}

function money(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "Not reported";
}

function seatPhase(job: CouncilServiceJob | null, seat: CouncilSeat): string {
  const event = job?.events
    .filter((item) => item.payload.seatId === seat.id)
    .at(-1);
  if (!event) return job?.status === "running" ? "Waiting" : "Ready";
  const stage = String(event.payload.stage ?? "review");
  if (event.type === "seat.failed") return `${stage} · failed`;
  if (event.type === "seat.completed") return `${stage} · complete`;
  return `${stage} · reviewing`;
}

function download(name: string, value: string, type: string): void {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function CouncilIsland() {
  const initial = new URLSearchParams(window.location.search);
  const [sourceType, setSourceType] = useState(
    initial.get("sourceType") === "plan" ? "plan" : "text",
  );
  const [source, setSource] = useState(initial.get("source") ?? "");
  const [profiles, setProfiles] = useState<ProfileChoice[]>([]);
  const [profilePath, setProfilePath] = useState("");
  const [budget, setBudget] = useState("3");
  const [redactSecrets, setRedactSecrets] = useState(false);
  const [history, setHistory] = useState<CouncilServiceJob[]>([]);
  const [job, setJob] = useState<CouncilServiceJob | null>(null);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const profile = profiles.find((item) => item.path === profilePath);
  const active = job?.status === "running";
  const ready = profile?.readiness.every((entry) => entry.configured) ?? false;
  const run = job?.run;
  const roster = run
    ? [...run.profile.seats, run.profile.chair]
    : profile
      ? [...profile.seats, profile.chair]
      : [];

  useEffect(() => {
    let current = true;
    void Promise.all([
      request<ProfileChoice[]>("/profiles"),
      request<CouncilServiceJob[]>("/runs"),
    ])
      .then(([choices, runs]) => {
        if (!current) return;
        setProfiles(choices);
        setProfilePath(choices[0]?.path ?? "");
        setHistory(runs);
        setAvailable(true);
        const runId = initial.get("run");
        if (runId)
          void request<CouncilServiceJob>(`/runs/${encodeURIComponent(runId)}`)
            .then(setJob)
            .catch((reason) => setError(String(reason)));
      })
      .catch(() => {
        if (current) setAvailable(false);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const runId = job.runId;
    const events = new EventSource(
      `${API}/runs/${encodeURIComponent(runId)}/events`,
    );
    const receive = (event: MessageEvent<string>): void => {
      try {
        const snapshot = JSON.parse(event.data) as CouncilServiceJob;
        setJob(snapshot);
        if (snapshot.status !== "running") {
          events.close();
          void request<CouncilServiceJob[]>("/runs")
            .then(setHistory)
            .catch(() => {});
        }
      } catch {
        setError(
          "A progress update could not be read. Reopen the run from history.",
        );
      }
    };
    events.addEventListener("snapshot", receive as EventListener);
    events.onerror = () => {
      void request<CouncilServiceJob>(`/runs/${encodeURIComponent(runId)}`)
        .then(setJob)
        .catch(() =>
          setError(
            "Connection lost. The council may still be running; refresh to reconnect.",
          ),
        );
    };
    return () => events.close();
  }, [job?.runId, job?.status]);

  async function start(): Promise<void> {
    setError("");
    setStarting(true);
    try {
      const snapshot = await request<CouncilServiceJob>("/runs", {
        sourceType,
        source,
        profile: profilePath,
        maxUsd: Number(budget),
        redactSecrets,
      });
      setJob(snapshot);
      setHistory((items) => [snapshot, ...items]);
      const url = new URL(window.location.href);
      url.search = new URLSearchParams({ run: snapshot.runId }).toString();
      window.history.replaceState(null, "", url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarting(false);
    }
  }

  async function openRun(runId: string): Promise<void> {
    try {
      setJob(
        await request<CouncilServiceJob>(`/runs/${encodeURIComponent(runId)}`),
      );
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function cancel(): Promise<void> {
    if (!job) return;
    try {
      await request(`/runs/${encodeURIComponent(job.runId)}/cancel`, {});
    } catch (reason) {
      setError(String(reason));
    }
  }

  if (available === null)
    return (
      <p className="notice" role="status">
        Connecting to your local council…
      </p>
    );
  if (!available)
    return (
      <div className="notice">
        <h2>Open the local dashboard to run a council</h2>
        <p>
          This page needs the local council service. Start{" "}
          <code>bun run dashboard</code> in the harness, then open{" "}
          <code>/council.html</code> on its local address. Hosted static pages
          cannot run models or access your files.
        </p>
      </div>
    );

  return (
    <div className="workspace">
      <div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <section className="panel" aria-label="New review">
          <h2>What should the council review?</h2>
          <div className="form-grid">
            <label>
              Source
              <select
                value={sourceType}
                onChange={(event) => setSourceType(event.currentTarget.value)}
                disabled={active}
              >
                <option value="text">Paste a document</option>
                <option value="pr">GitHub pull request</option>
                <option value="plan">Local Markdown plan</option>
                <option value="file">Local research or text file</option>
              </select>
            </label>
            <label>
              Council profile
              <select
                value={profilePath}
                onChange={(event) => setProfilePath(event.currentTarget.value)}
                disabled={active}
              >
                {profiles.map((choice) => (
                  <option key={choice.path} value={choice.path}>
                    {choice.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              {sourceType === "text"
                ? "Document or question"
                : sourceType === "pr"
                  ? "PR number or GitHub URL"
                  : "File path within this workspace"}
              <textarea
                value={source}
                onInput={(event) => setSource(event.currentTarget.value)}
                placeholder={
                  sourceType === "text"
                    ? "Paste the work, its goals, and the evidence the reviewers should consider…"
                    : sourceType === "pr"
                      ? "https://github.com/owner/repo/pull/123"
                      : "plans/drafts/my-plan.md"
                }
                disabled={active}
              />
            </label>
            <label>
              Run budget (USD)
              <input
                type="number"
                min="0"
                step="0.1"
                value={budget}
                onInput={(event) => setBudget(event.currentTarget.value)}
                disabled={active}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={redactSecrets}
                onChange={(event) =>
                  setRedactSecrets(event.currentTarget.checked)
                }
                disabled={active}
              />{" "}
              Redact detected secrets; otherwise reject
            </label>
          </div>
          <div className="readiness">
            {profile?.readiness.map((entry) => (
              <span
                key={entry.provider}
                className={`pill${entry.configured ? "" : " warning"}`}
              >
                {entry.provider}:{" "}
                {entry.configured
                  ? "configured"
                  : (entry.error ?? `needs ${entry.missing.join(", ")}`)}
              </span>
            ))}
          </div>
          <p className="provider-note">
            {profile?.seats.every((seat) => seat.provider === "fake")
              ? "Demo profile: simulated feedback, no API keys or model charges."
              : "Your selected providers receive the supplied review material. Configure keys in the server environment; never paste them here."}
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() => void start()}
              disabled={
                active ||
                starting ||
                !ready ||
                !source.trim() ||
                budget.trim() === "" ||
                !Number.isFinite(Number(budget)) ||
                Number(budget) < 0
              }
            >
              {starting ? "Starting…" : "Convene council"}
            </button>
            {active && (
              <button
                type="button"
                className="secondary"
                onClick={() => void cancel()}
              >
                Stop review
              </button>
            )}
            <span className="muted">
              {profile?.depth ?? "balanced"} discussion
            </span>
          </div>
        </section>
        <section aria-label="Council members">
          <div className="seat-grid">
            {roster.map((seat) => (
              <article className="seat" key={seat.id}>
                <h3>{seat.id}</h3>
                <p className="model">
                  {seat.provider} / {seat.model}
                </p>
                <p className="model">{seat.role}</p>
                <p className="phase">{seatPhase(job, seat)}</p>
              </article>
            ))}
          </div>
        </section>
        {job ? (
          <section className="panel" aria-live="polite">
            <div className="run-meta">
              <span
                className={`pill${job.status === "failed" ? " warning" : ""}`}
              >
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
                The council is deliberating. Each round waits for its
                participants before sharing results.
              </p>
            )}
            {job.error && <p className="notice error">{job.error}</p>}
            {run && (
              <>
                <h2>
                  {run.chair?.verdict.replaceAll("_", " ") ??
                    "Review incomplete"}
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
                    <summary>
                      Provider failures and reduced participation
                    </summary>
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
                        {record.round ? ` ${record.round}` : ""} ·{" "}
                        {record.seatId} · {record.model}
                      </h3>
                      <p className="muted">
                        {(record.latencyMs / 1000).toFixed(1)} seconds ·{" "}
                        {record.usage
                          ? `${record.usage.inputTokens} input / ${record.usage.outputTokens} output tokens`
                          : "Usage not reported"}
                      </p>
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
        ) : (
          <p className="empty">
            The independent reviews, discussion, and report will appear here.
          </p>
        )}
      </div>
      <aside className="panel history">
        <h2>Review history</h2>
        {history.length === 0 && (
          <p className="muted">
            Your completed and active runs will be saved here.
          </p>
        )}
        {history.map((item) => (
          <button
            type="button"
            key={item.runId}
            className={job?.runId === item.runId ? "selected" : ""}
            onClick={() => void openRun(item.runId)}
          >
            {item.run?.context.source.displayName ?? item.runId}
            <small>
              {item.status} · {new Date(item.startedAt).toLocaleString()}
            </small>
          </button>
        ))}
      </aside>
    </div>
  );
}
