import { useEffect, useState } from "preact/hooks";
import type {
  CouncilPreview,
  CouncilServiceJob,
} from "../../../scripts/council/service";
import { type CouncilPreviewState, previewKey } from "../council-preview";
import {
  councilRunEventsUrl,
  followCouncilRun,
  isActive,
} from "../council-run-follow";
import { EmptyState } from "../ds/EmptyState";
import { operatorPost, operatorRead } from "../operator";
import { fetchTransport } from "../use-stream";
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

/** The operator API's preview row: what a run would send, with nothing started. */
const PREVIEW = "/__agent-forge/council/preview";

async function dataOf<T>(response: Response): Promise<T> {
  let envelope: { ok: boolean; data: T; error: string | null };
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch {
    throw new Error("The control plane did not answer.");
  }
  if (!response.ok || !envelope.ok)
    throw new Error(envelope.error || "The council request failed.");
  return envelope.data;
}

async function request<T>(path: string, input?: unknown): Promise<T> {
  // A request with a body starts or cancels a run: an operator action. A read
  // carries the operator token too: a stored run holds what was reviewed.
  return dataOf<T>(
    input === undefined
      ? await operatorRead(`${API}${path}`)
      : await operatorPost(`${API}${path}`, input),
  );
}

/** The source kinds a link may preselect (`?sourceType=…&source=…`). */
const LINKED_KINDS = new Set(["plan", "bead"]);

export function CouncilIsland() {
  const initial = new URLSearchParams(window.location.search);
  const linked = initial.get("sourceType") ?? "";
  const [draft, setDraft] = useState<CouncilDraft>({
    sourceType: LINKED_KINDS.has(linked) ? linked : "text",
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
  const [preview, setPreview] = useState<CouncilPreviewState>({
    status: "idle",
  });
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
    if (!job || !isActive(job)) return;
    const runId = job.runId;
    // Read with fetch, not the browser's event-source class: that class
    // cannot send the operator token a run's stream needs. The stream sends
    // the whole job once and then only what changed; the follower rebuilds it.
    const follower = followCouncilRun({
      runId,
      transport: fetchTransport(councilRunEventsUrl(API, runId), {
        fetch: operatorRead,
      }),
      readRun: () =>
        request<CouncilServiceJob>(`/runs/${encodeURIComponent(runId)}`),
      onJob: setJob,
      onError: setError,
      onFinished: () => {
        void request<CouncilServiceJob[]>("/runs")
          .then(setHistory)
          .catch(() => {});
      },
    });
    return () => follower.close();
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

  /**
   * Ask the control plane what a run on this draft would send. The answer is
   * kept with the draft it was asked for: once the draft changes, the setup
   * shows it no longer and asks for another before the run can be sent.
   */
  async function runPreview(): Promise<void> {
    const key = previewKey(draft);
    setPreview({ status: "loading", key });
    try {
      const answer = await dataOf<CouncilPreview>(
        await operatorPost(PREVIEW, { sourceType, source, redactSecrets }),
      );
      setPreview({ status: "ready", key, preview: answer });
    } catch (reason) {
      setPreview({
        status: "failed",
        key,
        error: reason instanceof Error ? reason.message : String(reason),
      });
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
    return <EmptyState title="Connecting to your local council…" live />;
  if (!available)
    return (
      <EmptyState
        title="Open the local dashboard to run a council"
        hint={
          <>
            This page needs the local council service. Start{" "}
            <code>bun run dashboard</code> in the harness, then open{" "}
            <code>/council.html</code> on its local address. Hosted static pages
            cannot run models or access your files.
          </>
        }
      />
    );

  return (
    <div class="af-workspace">
      <div class="af-workspace-main">
        {error ? (
          <p class="af-notice af-notice-error" role="alert">
            {error}
          </p>
        ) : null}
        <CouncilSetup
          draft={draft}
          profiles={profiles}
          active={active}
          starting={starting}
          preview={preview}
          onChange={(patch) => {
            setDraft((value) => ({ ...value, ...patch }));
            if (patch.profilePath !== undefined) setJob(null);
          }}
          onStart={start}
          onCancel={cancel}
          onPreview={runPreview}
        />
        <CouncilMembers job={job} roster={roster} />
        {job ? (
          <CouncilResult job={job} />
        ) : (
          <EmptyState
            title="No review selected yet"
            hint="The independent reviews, discussion, and report will appear here."
          />
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
