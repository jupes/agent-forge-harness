import { useEffect, useState } from "preact/hooks";
import type { CouncilServiceJob } from "../../../scripts/council/service";
import { CouncilHistory } from "./CouncilHistory";
import { CouncilMembers } from "./CouncilMembers";
import { CouncilResult } from "./CouncilResult";
import {
  type CouncilDraft,
  CouncilSetup,
  optionalBudget,
  type ProfileChoice,
} from "./CouncilSetup";

const API = "/__agent-forge/council-api";
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

export function CouncilIsland() {
  const initial = new URLSearchParams(window.location.search);
  const [draft, setDraft] = useState<CouncilDraft>({
    sourceType: initial.get("sourceType") === "plan" ? "plan" : "text",
    source: initial.get("source") ?? "",
    profilePath: "",
    budget: "3",
    redactSecrets: false,
  });
  const { sourceType, source, profilePath, budget, redactSecrets } = draft;
  const [profiles, setProfiles] = useState<ProfileChoice[]>([]);
  const [history, setHistory] = useState<CouncilServiceJob[]>([]);
  const [job, setJob] = useState<CouncilServiceJob | null>(null);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const profile = profiles.find((item) => item.path === profilePath);
  const active = job?.status === "running" || job?.status === "cancelling";
  const run = job?.run;
  const runProfile = run?.profile ?? job?.profile;
  const roster = runProfile
    ? [...runProfile.seats, runProfile.chair]
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
        setDraft((value) => ({
          ...value,
          profilePath: choices[0]?.path ?? "",
          budget: String(choices[0]?.maxEstimatedUsd ?? 3),
        }));
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
    if (!job || !["running", "cancelling"].includes(job.status)) return;
    const runId = job.runId;
    const events = new EventSource(
      `${API}/runs/${encodeURIComponent(runId)}/events`,
    );
    const receive = (event: MessageEvent<string>): void => {
      try {
        const snapshot = JSON.parse(event.data) as CouncilServiceJob;
        setJob(snapshot);
        if (!["running", "cancelling"].includes(snapshot.status)) {
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
      const maxUsd = optionalBudget(budget);
      const snapshot = await request<CouncilServiceJob>("/runs", {
        sourceType,
        source,
        profile: profilePath,
        ...(maxUsd === undefined ? {} : { maxUsd }),
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
        <CouncilSetup
          draft={draft}
          profiles={profiles}
          active={active}
          starting={starting}
          onChange={(patch) => {
            setDraft((value) => ({ ...value, ...patch }));
            if (patch.profilePath !== undefined) setJob(null);
          }}
          onStart={start}
          onCancel={cancel}
        />
        <CouncilMembers job={job} roster={roster} />
        {job ? (
          <CouncilResult job={job} />
        ) : (
          <p className="empty">
            The independent reviews, discussion, and report will appear here.
          </p>
        )}
      </div>
      <CouncilHistory
        history={history}
        selectedRunId={job?.runId}
        onOpen={openRun}
      />
    </div>
  );
}
